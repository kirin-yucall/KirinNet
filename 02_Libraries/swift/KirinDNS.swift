// KirinDNS.swift — KirinDNS Resolution Protocol (ADRP) v2.0 Swift Client
//
// Implements ADRP as defined in 01_Standard/spec_v1.md.
//
// Architecture:
//   SRV records for service port discovery (_kirinnet-http._tcp, etc.)
//   TXT records for identity metadata (id=;key=;nick=;ipfs=)
//
// No external dependencies — uses Foundation and `dig` via Process.
//
// Usage:
//   let srv = try await KirinDNS.resolveService("alice.kirinnet.org", "ws")
//   print(srv)  // SrvResult(target: "alice.kirinnet.org", port: 8082)
//   let id = try await KirinDNS.resolveIdentity("alice.kirinnet.org")
//   print(id)   // ["id": "550e8400-...", "key": "04abc..."]
//
// Platform: macOS 12+ / iOS 15+ / Linux

import Foundation

// ---------------------------------------------------------------------------
// Constants (spec Section 2.2)
// ---------------------------------------------------------------------------

/// SRV service names.
private let srvServices: [String: String] = [
    "http":  "_kirinnet-http._tcp",
    "https": "_kirinnet-https._tcp",
    "ws":    "_kirinnet-ws._tcp",
]

/// Fallback ports.
public let fallbackPorts: [String: Int] = [
    "http":  80,
    "https": 443,
    "ws":    80,
    "wss":   443,
]

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// Resolved SRV service target.
public struct SrvResult: Equatable, Codable {
    public let target: String
    public let port: Int

    public init(target: String, port: Int) {
        self.target = target
        self.port = port
    }
}

/// KirinDNS identity from TXT record.
public typealias KirinIdentity = [String: Any]

// ---------------------------------------------------------------------------
// DNS query helpers (using dig)
// ---------------------------------------------------------------------------

/// Run `dig +short <rtype> <name>` and return output lines.
private func digQuery(rtype: String, name: String) async throws -> [String] {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    process.arguments = ["dig", "+short", rtype, name]

    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = FileHandle.nullDevice

    try process.run()
    process.waitUntilExit()

    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    guard let output = String(data: data, encoding: .utf8) else { return [] }

    return output
        .components(separatedBy: "\n")
        .map { $0.trimmingCharacters(in: .whitespaces) }
        .filter { !$0.isEmpty }
}

// ---------------------------------------------------------------------------
// Service Resolution (SRV)
// ---------------------------------------------------------------------------

/// Resolve a single service port via SRV.
///
/// Returns [SrvResult] or nil if no SRV record found.
public func resolveService(_ domain: String, _ service: String) async throws -> SrvResult? {
    guard let srvName = srvServices[service] else {
        throw KirinError("Unknown service: \(service). Recognized: http, https, ws")
    }

    let fullName = "\(srvName).\(domain)"
    let lines = try await digQuery(rtype: "SRV", name: fullName)
    guard !lines.isEmpty else { return nil }

    // Parse SRV records: "priority weight port target"
    var records: [(priority: Int, weight: Int, port: Int, target: String)] = []
    for line in lines {
        let parts = line.components(separatedBy: .whitespaces).filter { !$0.isEmpty }
        guard parts.count >= 4,
              let pri = Int(parts[0]),
              let weight = Int(parts[1]),
              let port = Int(parts[2]) else { continue }
        let target = parts[3].hasSuffix(".") ? String(parts[3].dropLast()) : parts[3]
        records.append((pri, weight, port, target))
    }

    guard !records.isEmpty else { return nil }

    // RFC 2782: sort by priority asc, then weight desc
    records.sort { a, b in
        if a.priority != b.priority { return a.priority < b.priority }
        return a.weight > b.weight
    }

    let best = records[0]
    return SrvResult(target: best.target, port: best.port)
}

/// Resolve all SRV services for a domain.
public func resolveAllServices(_ domain: String) async throws -> [String: SrvResult?] {
    var results: [String: SrvResult?] = [:]
    for svc in srvServices.keys {
        results[svc] = try await resolveService(domain, svc)
    }
    return results
}

// ---------------------------------------------------------------------------
// Identity Resolution (TXT)
// ---------------------------------------------------------------------------

/// Parse a semicolon-separated key=value TXT string into an identity dict.
///
/// Format: id=<uuid>;key=<hex>;nick=<name>;ipfs=<bool>
/// (spec Section 3.2)
///
/// Returns nil if not a valid identity record.
public func parseIdentityTxt(_ txt: String) -> KirinIdentity? {
    let trimmed = txt.trimmingCharacters(in: .whitespaces)
    guard !trimmed.isEmpty, trimmed.hasPrefix("id=") else { return nil }

    var result: KirinIdentity = [:]
    for pair in trimmed.components(separatedBy: ";") {
        let parts = pair.components(separatedBy: "=")
        guard parts.count >= 2 else { continue }
        let key = parts[0].trimmingCharacters(in: .whitespaces)
        let val = parts.dropFirst().joined(separator: "=").trimmingCharacters(in: .whitespaces)
        result[key] = val
    }

    // Both id and key are required
    guard result["id"] != nil, result["key"] != nil else { return nil }

    // Parse ipfs boolean
    if let ipfsStr = result["ipfs"] as? String {
        result["ipfs"] = (ipfsStr == "true")
    }

    return result
}

/// Resolve identity metadata from TXT record.
public func resolveIdentity(_ domain: String) async throws -> KirinIdentity? {
    let lines = try await digQuery(rtype: "TXT", name: domain)
    for line in lines {
        // Strip surrounding quotes from dig output
        var txt = line
        if txt.hasPrefix("\"") && txt.hasSuffix("\"") {
            txt = String(txt.dropFirst().dropLast())
        }
        txt = txt.replacingOccurrences(of: "\\\"", with: "\"")
        if let identity = parseIdentityTxt(txt) {
            return identity
        }
    }
    return nil
}

// ---------------------------------------------------------------------------
// did:dns three-record identity model (spec §3.2.1 / did-dns-protocol §2)
// ---------------------------------------------------------------------------
//
// Tamper-evident fingerprint chain: fp == Base64URL(SHA-256(pk)[0:12]).
// SHA-256 is implemented inline (FIPS 180-4) to avoid platform-specific
// crypto imports (CryptoKit is Apple-only; this keeps Linux CI portable).

private let didDnsPrefix       = "did:dns:"
private let didDnsDeclPrefix   = "did:dns:v="
private let didDnsPkPrefix     = "did:dns:pk;"
private let didDnsBlackPrefix  = "did:dns:black;"
private let didDnsKtyEd25519   = "ed25519"
private let didDnsFingerprintBytes = 12  // -> 16 base64url chars

/// Verified did:dns identity (declaration + public key, optional blacklist).
public struct DidDnsIdentity: Equatable {
    public var version: Int = 1
    public var fingerprint: String = ""
    public var nickname: String = ""        // Base64URL(UTF-8)
    public var gender: String = ""          // M/F/O/X
    public var issuedAt: Int64 = 0
    public var expiresAt: Int64 = 0
    public var keyType: String = didDnsKtyEd25519
    public var publicKeyB64Url: String = ""
    public var blacklist: [String] = []
    public init() {}
}

/// Pure-Swift SHA-256 (FIPS 180-4) over raw bytes. Returns 32-byte digest.
private func sha256(_ data: [UInt8]) -> [UInt8] {
    let k: [UInt32] = [
        0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,
        0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,
        0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,
        0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
        0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,
        0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,
        0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,
        0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
        0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,
        0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,
        0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2 ]
    func rotr(_ x: UInt32, _ n: UInt32) -> UInt32 { (x >> n) | (x << (32 - n)) }
    var h: [UInt32] = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,
                       0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]
    var msg = data
    let bitLen = UInt64(data.count) * 8
    msg.append(0x80)
    while msg.count % 64 != 56 { msg.append(0) }
    for i in (0..<8).reversed() { msg.append(UInt8((bitLen >> UInt64(i*8)) & 0xff)) }
    for off in stride(from: 0, to: msg.count, by: 64) {
        var m = [UInt32](repeating: 0, count: 64)
        for i in 0..<16 {
            m[i] = (UInt32(msg[off+i*4])<<24)|(UInt32(msg[off+i*4+1])<<16)|
                   (UInt32(msg[off+i*4+2])<<8)|UInt32(msg[off+i*4+3])
        }
        for i in 16..<64 {
            let s0 = rotr(m[i-15],7) ^ rotr(m[i-15],18) ^ (m[i-15] >> 3)
            let s1 = rotr(m[i-2],17) ^ rotr(m[i-2],19) ^ (m[i-2] >> 10)
            m[i] = m[i-16] &+ s0 &+ m[i-7] &+ s1
        }
        var a=h[0],b=h[1],c=h[2],d=h[3],e=h[4],f=h[5],g=h[6],hh=h[7]
        for i in 0..<64 {
            let s1 = rotr(e,6) ^ rotr(e,11) ^ rotr(e,25)
            let ch = (e & f) ^ (~e & g)
            let t1 = hh &+ s1 &+ ch &+ k[i] &+ m[i]
            let s0 = rotr(a,2) ^ rotr(a,13) ^ rotr(a,22)
            let maj = (a & b) ^ (a & c) ^ (b & c)
            let t2 = s0 &+ maj
            hh=g; g=f; f=e; e=d &+ t1; d=c; c=b; b=a; a=t1 &+ t2
        }
        for i in 0..<8 { h[i] = h[i] &+ [a,b,c,d,e,f,g,hh][i] }
    }
    var out = [UInt8](); out.reserveCapacity(32)
    for i in 0..<8 {
        out.append(UInt8((h[i] >> 24) & 0xff)); out.append(UInt8((h[i] >> 16) & 0xff))
        out.append(UInt8((h[i] >> 8) & 0xff));  out.append(UInt8(h[i] & 0xff))
    }
    return out
}

private let b64urlAlphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")

/// Base64URL encode (RFC 4648 §5, no padding).
private func base64urlEncode(_ bytes: [UInt8]) -> String {
    var out = ""; var val=0, valb=-6
    for b in bytes {
        val = (val << 8) | Int(b); valb += 8
        while valb >= 0 { out.append(b64urlAlphabet[(val >> valb) & 0x3f]); valb -= 6 }
    }
    if valb > -6 { out.append(b64urlAlphabet[((val << 8) >> (valb + 8)) & 0x3f]) }
    return out
}

/// Base64URL decode (no padding). Returns nil on invalid char.
private func base64urlDecode(_ s: String) -> [UInt8]? {
    var rev = [Int](repeating: -1, count: 256)
    for i in 0..<64 { rev[Int(b64urlAlphabet[i].asciiValue!)] = i }
    var out = [UInt8](); var val=0, valb=-8
    for ch in s.utf8 {
        if ch == 0x3d { continue } // '='
        let d = rev[Int(ch)]
        if d < 0 { return nil }
        val = (val << 6) | d; valb += 6
        if valb >= 0 { out.append(UInt8((val >> valb) & 0xff)); valb -= 8 }
    }
    return out
}

private func parseDidDnsKv(_ segment: String) -> [String: String] {
    var out: [String: String] = [:]
    for pair in segment.split(separator: ";") {
        if let eq = pair.firstIndex(of: "=") {
            let k = pair[..<eq].trimmingCharacters(in: .whitespaces)
            let v = pair[pair.index(after: eq)...].trimmingCharacters(in: .whitespaces)
            out[k] = String(v)
        }
    }
    return out
}

public extension DidDnsIdentity {
    /// Recompute fp = Base64URL(SHA-256(pk)[0:12]). Empty on malformed pk.
    func computeFingerprint() -> String {
        guard let pk = base64urlDecode(publicKeyB64Url), !pk.isEmpty else { return "" }
        let digest = sha256(pk)
        return base64urlEncode(Array(digest.prefix(didDnsFingerprintBytes)))
    }
    /// True iff declared fp matches recomputed fp over the pk bytes.
    func fingerprintChainOk() -> Bool { !fingerprint.isEmpty && fingerprint == computeFingerprint() }
    func isRevoked() -> Bool { blacklist.contains(fingerprint) }
    func isExpired(_ now: Int64) -> Bool { expiresAt != 0 && now >= expiresAt }
    /// Composite policy: v1 + ed25519 + chain + not revoked + not expired.
    func isValid(_ now: Int64) -> Bool {
        version == 1 && keyType == didDnsKtyEd25519 && fingerprintChainOk()
            && !isRevoked() && !isExpired(now)
    }
    /// Decode the Base64URL(UTF-8) nickname, or nil if absent/invalid.
    func nicknameDecoded() -> String? {
        guard !nickname.isEmpty, let bytes = base64urlDecode(nickname) else { return nil }
        return String(bytes: bytes, encoding: .utf8)
    }
}

/// Classify TXT records by did:dns: sub-type; assemble an identity.
/// Returns nil if no did:dns records / declaration+pk missing.
public func parseDidDnsIdentity(_ txtRecords: [String]) -> DidDnsIdentity? {
    var declRaw: String?, pkRaw: String?, blackRaw: String?
    for raw in txtRecords {
        let s = raw.trimmingCharacters(in: .whitespaces)
        if declRaw == nil && s.hasPrefix(didDnsDeclPrefix) { declRaw = s }
        else if pkRaw == nil && s.hasPrefix(didDnsPkPrefix) { pkRaw = s }
        else if blackRaw == nil && s.hasPrefix(didDnsBlackPrefix) { blackRaw = s }
    }
    guard let declRaw = declRaw, let pkRaw = pkRaw else { return nil }

    let decl = parseDidDnsKv(String(declRaw.dropFirst(didDnsPrefix.count)))
    let pk = parseDidDnsKv(String(pkRaw.dropFirst(didDnsPrefix.count)))

    var id = DidDnsIdentity()
    id.version = Int(decl["v"] ?? "1") ?? 1
    id.fingerprint = decl["fp"] ?? ""
    id.nickname = decl["n"] ?? ""
    id.gender = decl["g"] ?? ""
    id.issuedAt = Int64(decl["iat"] ?? "0") ?? 0
    id.expiresAt = Int64(decl["exp"] ?? "0") ?? 0
    id.keyType = pk["kty"] ?? didDnsKtyEd25519
    id.publicKeyB64Url = pk["pk"] ?? ""

    if let black = blackRaw {
        let bkv = parseDidDnsKv(String(black.dropFirst(didDnsPrefix.count)))
        if let fp = bkv["fp"] {
            id.blacklist = fp.split(separator: ",").map { String($0) }.filter { !$0.isEmpty }
        }
    }
    return id
}

// ---------------------------------------------------------------------------
// Legacy Compatibility Wrapper
// ---------------------------------------------------------------------------

/// Full resolution: SRV + TXT + identity (legacy wrapper).
///
/// New code should use resolveService() and resolveIdentity() directly.
public func resolveKirinDns(_ domain: String) async throws -> [String: Any] {
    let ws = try await resolveService(domain, "ws")
    return [
        "domain": domain,
        "ws": ws ?? SrvResult(target: domain, port: fallbackPorts["ws"]!),
        "http": try await resolveService(domain, "http") as Any,
        "https": try await resolveService(domain, "https") as Any,
        "identity": try await resolveIdentity(domain) as Any,
    ]
}

// ---------------------------------------------------------------------------
// KirinDNS namespace and error type
// ---------------------------------------------------------------------------

public enum KirinDNS {
    public struct KirinError: Error, CustomStringConvertible {
        public let message: String
        public init(_ message: String) { self.message = message }
        public var description: String { "KirinDNS error: \(message)" }
    }
}

public typealias KirinError = KirinDNS.KirinError

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

public func kirinDnsSelfTest() async {
    // SRV nonexistent domain
    let ws = try? await resolveService("nonexistent.invalid", "ws")
    assert(ws == nil, "no SRV for nonexistent domain")

    // TXT identity nonexistent domain
    let id = try? await resolveIdentity("nonexistent.invalid")
    assert(id == nil, "no TXT identity for nonexistent domain")

    // Identity parser
    let parsed = parseIdentityTxt(
        "id=550e8400-e29b-41d4-a716-446655440000;key=04abc;nick=Alice;ipfs=false"
    )
    assert(parsed != nil, "identity parsed")
    assert(parsed!["id"] as? String == "550e8400-e29b-41d4-a716-446655440000")
    assert(parsed!["key"] as? String == "04abc")
    assert(parsed!["nick"] as? String == "Alice")
    assert(parsed!["ipfs"] as? Bool == false)

    let minimal = parseIdentityTxt("id=test-id;key=0x00")
    assert(minimal != nil, "minimal")
    assert(minimal!["id"] as? String == "test-id")
    assert(minimal!["key"] as? String == "0x00")
    assert(minimal!["nick"] == nil)

    // Invalid TXT
    assert(parseIdentityTxt("v=spf1 include:_spf.example.com") == nil)
    assert(parseIdentityTxt("") == nil)
    assert(parseIdentityTxt("not an identity") == nil)

    // Legacy wrapper
    let full = try? await resolveKirinDns("nonexistent.invalid")
    if let full = full {
        let wsLegacy = full["ws"] as? SrvResult
        assert(wsLegacy?.port == 80, "legacy ws fallback")
    }

    // ---- did:dns three-record identity model (C-1 baseline) ----
    do {
        // Deterministic 32-byte key = bytes 0..31 (matches the golden vector).
        var pkBytes = [UInt8](); for i in 0..<32 { pkBytes.append(UInt8(i)) }
        let pkB64 = base64urlEncode(pkBytes)
        let dg = sha256(pkBytes)
        let fpCalc = base64urlEncode(Array(dg.prefix(didDnsFingerprintBytes)))
        let now = Int64(1700000000)

        let recs = [
            "v=spf1 include:_spf.kirinnet.org -all",
            "did:dns:v=1;fp=\(fpCalc);n=QWxpY2U;g=F;iat=\(now);exp=\(now + 3600)",
            "did:dns:pk;kty=ed25519;pk=\(pkB64)",
            "did:dns:black;fp=RevokedAaaa,RevokedBbbb",
        ]
        guard let id = parseDidDnsIdentity(recs) else { fatalError("did:dns identity") }
        assert(id.version == 1)
        assert(id.fingerprint == fpCalc)
        assert(id.keyType == "ed25519")
        assert(id.fingerprintChainOk())
        assert(id.isValid(now))
        assert(id.nicknameDecoded() == "Alice")
        assert(!id.isRevoked())

        // Tampered pk -> chain breaks
        let wrong = [UInt8](repeating: 0xff, count: 32)
        let wrongB64 = base64urlEncode(wrong)
        var tampered = recs; tampered[2] = "did:dns:pk;kty=ed25519;pk=\(wrongB64)"
        let broken = parseDidDnsIdentity(tampered)!
        assert(!broken.fingerprintChainOk())

        // Missing pk -> nil
        assert(parseDidDnsIdentity([recs[1]]) == nil)
        // No did:dns -> nil (legacy id= ignored)
        assert(parseDidDnsIdentity(["v=spf1 -all", "id=foo;key=bar"]) == nil)
        // Wrong kty -> invalid
        let rsaId = parseDidDnsIdentity([recs[1], "did:dns:pk;kty=rsa;pk=\(pkB64)"])!
        assert(rsaId.keyType == "rsa" && !rsaId.isValid(now))
    }

    print("KirinDNS Swift self-test: PASSED (incl. did:dns fingerprint chain)")
}
