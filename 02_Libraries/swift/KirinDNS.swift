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

    print("KirinDNS Swift self-test: PASSED")
}
