// KirinDNS.swift — KirinDNS Resolution Protocol (ADRP) Swift Client
//
// Resolves service port mappings from DNS TXT records.
// No external dependencies — uses Foundation only.
//
// Usage:
//   let ports = try await KirinDNS.resolve("alice.kirinnet.org")
//   print("HTTP: \(ports.http)")
//
// Platform: macOS 12+ / iOS 15+ / Linux (with SwiftNIO or dig fallback)

import Foundation

/// Recognized ADRP keys.
private let recognizedKeys: Set<String> = ["http", "https", "ws", "wss"]

/// Standard IANA fallback ports.
public struct KirinPorts: Equatable, Codable {
    public let http: UInt16
    public let https: UInt16
    public let ws: UInt16
    public let wss: UInt16

    public static let fallback = KirinPorts(http: 80, https: 443, ws: 80, wss: 443)
}

/// KirinDNS ADRP resolver.
public enum KirinDNS {

    /// Resolve KirinDNS ports for a domain.
    /// Returns fallback ports if no valid ADRP record exists.
    public static func resolve(_ domain: String) async throws -> KirinPorts {
        let txtRecords = try await queryTXT(domain)
        for txt in txtRecords {
            if let ports = parseTXT(txt) {
                return ports
            }
        }
        return .fallback
    }

    /// Parse a TXT record string as ADRP JSON.
    /// Returns nil if not a valid ADRP record.
    public static func parseTXT(_ txt: String) -> KirinPorts? {
        let trimmed = txt.trimmingCharacters(in: .whitespaces)
        guard trimmed.hasPrefix("{") else { return nil }

        guard let data = trimmed.data(using: .utf8) else { return nil }
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }

        var http: UInt16 = 0
        var https: UInt16 = 0
        var ws: UInt16 = 0
        var wss: UInt16 = 0
        var found = false

        for key in recognizedKeys {
            guard let raw = json[key] else { continue }
            let val: UInt16
            if let n = raw as? UInt16 {
                val = n
            } else if let n = raw as? Int, n >= 1, n <= 65535 {
                val = UInt16(n)
            } else if let n = raw as? Double, n >= 1, n <= 65535, n == floor(n) {
                val = UInt16(n)
            } else {
                return nil
            }
            guard val >= 1 else { return nil }

            switch key {
            case "http":  http = val
            case "https": https = val
            case "ws":    ws = val
            case "wss":   wss = val
            default: break
            }
            found = true
        }

        guard found else { return nil }

        return KirinPorts(
            http:  http  > 0 ? http  : 80,
            https: https > 0 ? https : 443,
            ws:    ws    > 0 ? ws    : 80,
            wss:   wss   > 0 ? wss   : 443
        )
    }

    // ---- internal DNS TXT query -----------------------------------------

    private static func queryTXT(_ domain: String) async throws -> [String] {
        // Primary: use 'dig' via Process (portable across macOS/Linux)
        // In production, replace with NWConnection raw DNS or dnssd C API.
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["dig", "+short", "TXT", domain]

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice

        try process.run()
        process.waitUntilExit()

        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        guard let output = String(data: data, encoding: .utf8) else { return [] }

        // Parse dig output: lines are quoted TXT values
        var results: [String] = []
        for line in output.components(separatedBy: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard !trimmed.isEmpty else { continue }
            // Strip surrounding quotes
            var txt = trimmed
            if txt.hasPrefix("\"") && txt.hasSuffix("\"") {
                txt = String(txt.dropFirst().dropLast())
            }
            // Handle escaped quotes
            txt = txt.replacingOccurrences(of: "\\\"", with: "\"")
            results.append(txt)
        }
        return results
    }

    // ---- self-test -------------------------------------------------------
    public static func selfTest() {
        // Parse tests
        let p = parseTXT(#"{"http":8080,"https":8443}"#)
        assert(p != nil, "valid parse")
        assert(p!.http == 8080, "http")
        assert(p!.https == 8443, "https")
        assert(p!.ws == 80, "ws fallback")
        assert(p!.wss == 443, "wss fallback")

        assert(parseTXT("{}") == nil, "empty")
        assert(parseTXT(#"{"http":0}"#) == nil, "port zero")
        assert(parseTXT("not json") == nil, "not json")

        print("KirinDNS Swift self-test: PASSED")
    }
}
