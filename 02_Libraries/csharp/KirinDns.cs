// KirinDns.cs — KirinDNS Resolution Protocol (ADRP) v2.0 C# Client
//
// Implements ADRP v2.0 per 01_Standard/spec_v1.md and the did:dns three-record
// identity model in 01_Standard/did-dns-protocol.md §2 (C-1 baseline, 2026-08-08).
//
// Architecture:
//   SRV records (_kirinnet-http/https/ws._tcp) for service port discovery.
//   TXT records for identity metadata in did:dns three-record form:
//     did:dns:v=1;fp=<fp>;n=<nick>;g=<gender>;iat=<ts>;exp=<ts>   (declaration)
//     did:dns:pk;kty=ed25519;pk=<pubkey-base64url>                 (public key)
//     did:dns:black;fp=<fp1>,<fp2>,...                             (blacklist, optional)
//   The tamper-evident fingerprint chain binds declaration to public key:
//     fp == Base64URL(SHA-256(pk_bytes)[0:12])
//
// The v1 TXT-JSON port model (KirinPorts) is retained for backward compatibility
// but marked [Obsolete]; new code MUST use ResolveService / ResolveIdentityDidDns.
//
// Pure .NET — no external NuGet dependencies. Requires: .NET 6+.
//
// Build:   dotnet build   (or: csc KirinDns.cs)
// Test:    dotnet test    (or: dotnet run --project KirinDns.csproj)
// Self-test entry point also runnable: dotnet script KirinDns.cs

using System;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace KirinNet;

// ---------------------------------------------------------------------------
// v1 legacy type (deprecated, kept for back-compat)
// ---------------------------------------------------------------------------

/// <summary>Resolved service ports (v1 TXT-JSON model). Deprecated; use SRV + did:dns.</summary>
[Obsolete("v1 TXT-JSON model. Use ResolveService (SRV) + ResolveIdentityDidDns (did:dns).")]
public record KirinPorts(int Http, int Https, int Ws, int Wss)
{
    public static KirinPorts Fallback => new(80, 443, 80, 443);
}

// ---------------------------------------------------------------------------
// v2 result types
// ---------------------------------------------------------------------------

/// <summary>A resolved SRV service target.</summary>
public sealed record KirinSrvResult(string Target, int Port);

/// <summary>
/// A parsed did:dns identity (declaration + public key, optional blacklist).
/// Returned only when both declaration and pk records are present; the caller
/// applies trust policy via <see cref="IsValid"/> (fail-closed default).
/// </summary>
public sealed class DidDnsIdentity
{
    public int Version { get; set; } = 1;
    public string Fingerprint { get; set; } = "";
    public string? Nickname { get; set; }      // Base64URL(UTF-8)
    public string? Gender { get; set; }        // M/F/O/X
    public long? IssuedAt { get; set; }
    public long? ExpiresAt { get; set; }
    public string KeyType { get; set; } = "ed25519";
    public string PublicKeyB64Url { get; set; } = "";
    public List<string> Blacklist { get; set; } = new();
    public string RawDeclaration { get; set; } = "";
    public string RawPublicKey { get; set; } = "";

    public byte[] PublicKeyBytes =>
        Base64UrlDecode(PublicKeyB64Url);

    /// <summary>Recompute fp = Base64URL(SHA-256(pk)[0:12]).</summary>
    public string ComputeFingerprint()
    {
        using var sha = SHA256.Create();
        var digest = sha.ComputeHash(PublicKeyBytes);
        return Base64UrlEncode(digest, 0, 12);
    }

    public bool FingerprintChainOk() =>
        !string.IsNullOrEmpty(Fingerprint) && Fingerprint == ComputeFingerprint();

    public bool IsRevoked() => Blacklist.Contains(Fingerprint);

    public bool IsExpired(long? now = null)
    {
        if (ExpiresAt == null) return false;
        return (now ?? DateTimeOffset.UtcNow.ToUnixTimeSeconds()) >= ExpiresAt.Value;
    }

    public bool IsStale(long? now = null)
    {
        if (IssuedAt == null) return false;
        return Math.Abs((now ?? DateTimeOffset.UtcNow.ToUnixTimeSeconds()) - IssuedAt.Value) > 5 * 60;
    }

    public bool IsValid(long? now = null) =>
        Version == 1
        && KeyType == "ed25519"
        && FingerprintChainOk()
        && !IsRevoked()
        && !IsExpired(now);

    public string? NicknameDecoded()
    {
        if (string.IsNullOrEmpty(Nickname)) return null;
        try { return Encoding.UTF8.GetString(Base64UrlDecode(Nickname)); }
        catch { return null; }
    }
}

/// <summary>KirinDNS ADRP v2.0 resolver.</summary>
public static class KirinDns
{
    // SRV service name prefixes (spec §2.2)
    private static readonly Dictionary<string, string> SrvServices = new()
    {
        ["http"]  = "_kirinnet-http._tcp",
        ["https"] = "_kirinnet-https._tcp",
        ["ws"]    = "_kirinnet-ws._tcp",
    };

    // Fallback ports (spec §3.3.1 Step 4)
    public const int DefaultHttp  = 80;
    public const int DefaultHttps = 443;
    public const int DefaultWs    = 80;
    public const int DefaultWss   = 443;

    private const string DidDnsPrefix = "did:dns:";
    private const string DidDnsDeclPrefix  = "did:dns:v=";
    private const string DidDnsPkPrefix     = "did:dns:pk;";
    private const string DidDnsBlackPrefix  = "did:dns:black;";
    private const string KtyEd25519 = "ed25519";
    private const int FingerprintLen = 12;

    // -----------------------------------------------------------------------
    // v2: SRV service resolution
    // -----------------------------------------------------------------------

    /// <summary>Resolve a single service port via SRV.</summary>
    /// <returns>null if no SRV record found (caller falls back to standard port).</returns>
    public static async Task<KirinSrvResult?> ResolveServiceAsync(string domain, string service)
    {
        if (!SrvServices.TryGetValue(service, out var srvPrefix))
            throw new ArgumentException(
                $"Unknown service: {service}. Recognized: http, https, ws");

        var dnsServer = GetSystemDnsServer();
        var query = BuildDnsQuery($"{srvPrefix}.{domain}", qtype: 33); // SRV
        var resp = await UdpQueryAsync(query, dnsServer);

        var records = ParseSrvAnswers(resp);
        if (records.Count == 0) return null;

        // RFC 2782: lowest priority, then highest weight
        var best = records
            .OrderBy(r => r.Priority)
            .ThenByDescending(r => r.Weight)
            .First();
        return new KirinSrvResult(best.Target.TrimEnd('.'), best.Port);
    }

    /// <summary>Resolve all SRV services for a domain.</summary>
    public static async Task<Dictionary<string, KirinSrvResult?>> ResolveAllServicesAsync(string domain)
    {
        var result = new Dictionary<string, KirinSrvResult?>();
        foreach (var svc in SrvServices.Keys)
            result[svc] = await ResolveServiceAsync(domain, svc);
        return result;
    }

    // -----------------------------------------------------------------------
    // v2: did:dns identity resolution
    // -----------------------------------------------------------------------

    /// <summary>
    /// Resolve and assemble a did:dns identity for <paramref name="domain"/>.
    /// Returns null on NXDOMAIN / no TXT / no did:dns records (fail-closed).
    /// Call <see cref="DidDnsIdentity.IsValid"/> to apply trust policy.
    /// </summary>
    public static async Task<DidDnsIdentity?> ResolveIdentityDidDnsAsync(string domain)
    {
        var dnsServer = GetSystemDnsServer();
        var query = BuildDnsQuery(domain, qtype: 16); // TXT
        var resp = await UdpQueryAsync(query, dnsServer);
        var txtRecords = ExtractTxtAnswers(resp);
        return ParseDidDnsIdentity(txtRecords);
    }

    /// <summary>
    /// Classify TXT records by did:dns: sub-type and assemble an identity.
    /// Pure function (no network) — usable for tests.
    /// </summary>
    public static DidDnsIdentity? ParseDidDnsIdentity(IEnumerable<string> txtRecords)
    {
        if (txtRecords == null) return null;
        string? declRaw = null, pkRaw = null, blackRaw = null;

        foreach (var raw in txtRecords)
        {
            if (raw == null) continue;
            var s = raw.Trim();
            if (s.StartsWith(DidDnsDeclPrefix, StringComparison.Ordinal))
            {
                if (declRaw == null) declRaw = s;
            }
            else if (s.StartsWith(DidDnsPkPrefix, StringComparison.Ordinal))
            {
                if (pkRaw == null) pkRaw = s;
            }
            else if (s.StartsWith(DidDnsBlackPrefix, StringComparison.Ordinal))
            {
                if (blackRaw == null) blackRaw = s;
            }
        }

        if (declRaw == null || pkRaw == null) return null;

        var decl = ParseKv(declRaw.Substring(DidDnsPrefix.Length));
        var pk   = ParseKv(pkRaw.Substring(DidDnsPrefix.Length));

        var identity = new DidDnsIdentity
        {
            Version      = int.TryParse(decl.GetValueOrDefault("v", "1"), out var v) ? v : 1,
            Fingerprint  = decl.GetValueOrDefault("fp", ""),
            Nickname     = decl.GetValueOrDefault("n") is { Length: > 0 } n ? n : null,
            Gender       = decl.GetValueOrDefault("g") is { Length: > 0 } g ? g : null,
            IssuedAt     = decl.GetValueOrDefault("iat") is { } iat && long.TryParse(iat, out var iatv) ? iatv : null,
            ExpiresAt    = decl.GetValueOrDefault("exp") is { } exp && long.TryParse(exp, out var expv) ? expv : null,
            KeyType      = pk.GetValueOrDefault("kty", KtyEd25519),
            PublicKeyB64Url = pk.GetValueOrDefault("pk", ""),
            RawDeclaration = declRaw,
            RawPublicKey   = pkRaw,
        };

        if (blackRaw != null)
        {
            var fpField = ParseKv(blackRaw.Substring(DidDnsPrefix.Length)).GetValueOrDefault("fp", "");
            identity.Blacklist = fpField.Split(',', StringSplitOptions.RemoveEmptyEntries).ToList();
        }

        return identity;
    }

    // -----------------------------------------------------------------------
    // v1 legacy (deprecated)
    // -----------------------------------------------------------------------

    [Obsolete("v1 TXT-JSON model. Use ResolveServiceAsync + ResolveIdentityDidDnsAsync.")]
    public static async Task<KirinPorts> ResolveAsync(string domain) =>
        await ResolveWithServerAsync(domain, GetSystemDnsServer());

    [Obsolete("v1 TXT-JSON model.")]
    public static async Task<KirinPorts> ResolveWithServerAsync(string domain, string dnsServer)
    {
        try
        {
            var query = BuildDnsQuery(domain, qtype: 16);
            var resp = await UdpQueryAsync(query, dnsServer);
            foreach (var txt in ExtractTxtAnswers(resp))
            {
                var ports = ParseTxtV1(txt);
                if (ports != null) return ports;
            }
        }
        catch { /* DNS failure → fallback */ }
        return KirinPorts.Fallback;
    }

    [Obsolete("v1 TXT-JSON model.")]
    public static KirinPorts? ParseTxtV1(string txt)
    {
        if (string.IsNullOrWhiteSpace(txt)) return null;
        txt = txt.Trim();
        if (!txt.StartsWith("{")) return null;

        try
        {
            using var doc = JsonDocument.Parse(txt);
            if (doc.RootElement.ValueKind != JsonValueKind.Object) return null;

            int http = 0, https = 0, ws = 0, wss = 0, found = 0;
            foreach (var prop in doc.RootElement.EnumerateObject())
            {
                if (prop.Value.ValueKind != JsonValueKind.Number || !prop.Value.TryGetInt32(out var val)) continue;
                if (val < 1 || val > 65535) return null;
                switch (prop.Name)
                {
                    case "http":  http  = val; found++; break;
                    case "https": https = val; found++; break;
                    case "ws":    ws    = val; found++; break;
                    case "wss":   wss   = val; found++; break;
                }
            }
            if (found == 0) return null;
            return new KirinPorts(
                http  > 0 ? http  : DefaultHttp,
                https > 0 ? https : DefaultHttps,
                ws    > 0 ? ws    : DefaultWs,
                wss   > 0 ? wss   : DefaultWss);
        }
        catch (JsonException) { return null; }
    }

    // -----------------------------------------------------------------------
    // Base64URL helpers (no-padding)
    // -----------------------------------------------------------------------

    public static string Base64UrlEncode(byte[] bytes, int offset, int count)
    {
        var b64 = Convert.ToBase64String(bytes, offset, count);
        return b64.TrimEnd('=').Replace('+', '-').Replace('/', '_');
    }

    public static byte[] Base64UrlDecode(string s)
    {
        var padded = s.Replace('-', '+').Replace('_', '/');
        padded = padded.PadRight((padded.Length + 3) & ~3, '=');
        return Convert.FromBase64String(padded);
    }

    // -----------------------------------------------------------------------
    // KV parser (k=v;k=v)
    // -----------------------------------------------------------------------

    private static Dictionary<string, string> ParseKv(string text)
    {
        var d = new Dictionary<string, string>();
        foreach (var pair in text.Split(';'))
        {
            var eq = pair.IndexOf('=');
            if (eq < 0) continue;
            var k = pair.Substring(0, eq).Trim();
            var v = pair.Substring(eq + 1).Trim();
            d[k] = v;
        }
        return d;
    }

    // -----------------------------------------------------------------------
    // Raw DNS wire helpers
    // -----------------------------------------------------------------------

    private static string GetSystemDnsServer()
    {
        try
        {
            foreach (var line in System.IO.File.ReadAllLines("/etc/resolv.conf"))
            {
                var t = line.Trim();
                if (t.StartsWith("nameserver "))
                {
                    var ip = t.Substring("nameserver ".Length).Trim();
                    if (IPAddress.TryParse(ip, out _)) return ip;
                }
            }
        }
        catch { }
        return "8.8.8.8";
    }

    private static async Task<byte[]> UdpQueryAsync(byte[] query, string dnsServer)
    {
        using var udp = new UdpClient();
        udp.Client.SendTimeout = 3000;
        udp.Client.ReceiveTimeout = 3000;
        await udp.SendAsync(query, query.Length, dnsServer, 53);
        var remote = new IPEndPoint(IPAddress.Any, 0);
        return udp.Receive(ref remote);
    }

    private static byte[] BuildDnsQuery(string name, int qtype)
    {
        var msg = new List<byte>();
        // Header: ID, RD=1, QDCOUNT=1
        msg.AddRange(new byte[] { 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00 });
        foreach (var label in name.Split('.'))
        {
            msg.Add((byte)label.Length);
            msg.AddRange(Encoding.ASCII.GetBytes(label));
        }
        msg.Add(0x00);
        msg.AddRange(new byte[] { (byte)(qtype >> 8), (byte)(qtype & 0xff) }); // QTYPE
        msg.AddRange(new byte[] { 0x00, 1 });                                  // QCLASS=IN
        return msg.ToArray();
    }

    private static List<string> ExtractTxtAnswers(byte[] response)
    {
        var results = new List<string>();
        if (response.Length < 12) return results;
        int ancount = (response[6] << 8) | response[7];
        int pos = SkipQuestion(response, 12);
        for (int i = 0; i < ancount && pos + 10 <= response.Length; i++)
        {
            pos = SkipName(response, pos, out _);
            if (pos + 10 > response.Length) break;
            int rtype = (response[pos] << 8) | response[pos + 1];
            pos += 8; // TYPE + CLASS
            int ttl = (response[pos] << 24) | (response[pos + 1] << 16) | (response[pos + 2] << 8) | response[pos + 3]; ttl = ttl;
            pos += 4; // TTL
            int rdlen = (response[pos] << 8) | response[pos + 1];
            pos += 2;
            if (pos + rdlen > response.Length) break;
            if (rtype == 16 && rdlen > 1) // TXT
            {
                int txtlen = response[pos];
                if (txtlen > 0 && pos + 1 + txtlen <= response.Length)
                    results.Add(Encoding.UTF8.GetString(response, pos + 1, txtlen));
            }
            pos += rdlen;
        }
        return results;
    }

    private static List<SrvRecord> ParseSrvAnswers(byte[] response)
    {
        var list = new List<SrvRecord>();
        if (response.Length < 12) return list;
        int ancount = (response[6] << 8) | response[7];
        int pos = SkipQuestion(response, 12);
        for (int i = 0; i < ancount && pos + 10 <= response.Length; i++)
        {
            pos = SkipName(response, pos, out _);
            if (pos + 10 > response.Length) break;
            int rtype = (response[pos] << 8) | response[pos + 1];
            pos += 8; // TYPE(2) + CLASS(2) + TTL(4)
            int rdlen = (response[pos] << 8) | response[pos + 1];
            pos += 2;
            if (pos + rdlen > response.Length) break;
            if (rtype == 33 && rdlen >= 7) // SRV: priority(2) weight(2) port(2) target(...)
            {
                int priority = (response[pos] << 8) | response[pos + 1];
                int weight   = (response[pos + 2] << 8) | response[pos + 3];
                int port     = (response[pos + 4] << 8) | response[pos + 5];
                int tPos = pos + 6;
                var target = ReadName(response, ref tPos);
                list.Add(new SrvRecord(target, port, priority, weight));
            }
            pos += rdlen;
        }
        return list;
    }

    private static int SkipQuestion(byte[] r, int pos)
    {
        pos = SkipName(r, pos, out _);
        return pos + 4; // QTYPE + QCLASS
    }

    private static int SkipName(byte[] r, int pos, out bool compressed)
    {
        compressed = false;
        while (pos < r.Length)
        {
            int len = r[pos];
            if (len == 0) { pos++; break; }
            if ((len & 0xC0) == 0xC0) { pos += 2; compressed = true; break; }
            pos += len + 1;
        }
        return pos;
    }

    private static string ReadName(byte[] r, ref int pos)
    {
        var sb = new StringBuilder();
        int safety = 0;
        while (pos < r.Length && safety++ < 128)
        {
            int len = r[pos];
            if (len == 0) { pos++; break; }
            if ((len & 0xC0) == 0xC0) { pos += 2; break; }
            pos++;
            if (sb.Length > 0) sb.Append('.');
            sb.Append(Encoding.ASCII.GetString(r, pos, len));
            pos += len;
        }
        return sb.ToString();
    }

    private sealed record SrvRecord(string Target, int Port, int Priority, int Weight);

    // -----------------------------------------------------------------------
    // Self-test
    // -----------------------------------------------------------------------
    public static async Task Main(string[] args)
    {
        // Deterministic 32-byte key + its fingerprint (matches the JS/Python golden vector).
        var pkBytes = Enumerable.Range(0, 32).Select(i => (byte)i).ToArray();
        var pkB64 = Base64UrlEncode(pkBytes, 0, pkBytes.Length);
        using var sha = SHA256.Create();
        var fp = Base64UrlEncode(sha.ComputeHash(pkBytes), 0, 12);
        long now = 1_700_000_000;

        var recs = new[]
        {
            "v=spf1 include:_spf.kirinnet.org -all",
            $"did:dns:v=1;fp={fp};n=QWxpY2U;g=F;iat={now};exp={now + 3600}",
            $"did:dns:pk;kty=ed25519;pk={pkB64}",
            "did:dns:black;fp=RevokedAaaa,RevokedBbbb",
        };

        var id = ParseDidDnsIdentity(recs);
        System.Diagnostics.Debug.Assert(id != null);
        System.Diagnostics.Debug.Assert(id!.Version == 1);
        System.Diagnostics.Debug.Assert(id.Fingerprint == fp);
        System.Diagnostics.Debug.Assert(id.KeyType == "ed25519");
        System.Diagnostics.Debug.Assert(id.FingerprintChainOk());
        System.Diagnostics.Debug.Assert(id.IsValid(now));
        System.Diagnostics.Debug.Assert(id.NicknameDecoded() == "Alice");
        System.Diagnostics.Debug.Assert(id.Gender == "F");
        System.Diagnostics.Debug.Assert(id.Blacklist.Count == 2);
        System.Diagnostics.Debug.Assert(!id.IsRevoked());

        // Tampered pk -> chain breaks
        var tampered = (string[])recs.Clone();
        tampered[2] = $"did:dns:pk;kty=ed25519;pk={Base64UrlEncode(Enumerable.Repeat((byte)255, 32).ToArray(), 0, 32)}";
        var broken = ParseDidDnsIdentity(tampered);
        System.Diagnostics.Debug.Assert(broken != null && !broken!.FingerprintChainOk());

        // Missing pk -> null
        System.Diagnostics.Debug.Assert(ParseDidDnsIdentity(new[] { recs[1] }) == null);
        // No did:dns -> null
        System.Diagnostics.Debug.Assert(ParseDidDnsIdentity(new[] { "v=spf1 -all", "id=foo;key=bar" }) == null);
        // RSA kty -> invalid
        var rsa = ParseDidDnsIdentity(new[] { recs[1], $"did:dns:pk;kty=rsa;pk={pkB64}" });
        System.Diagnostics.Debug.Assert(rsa!.KeyType == "rsa" && !rsa.IsValid(now));

        // v1 legacy parser still works
        var p = ParseTxtV1("{\"http\":8080,\"https\":8443}");
        System.Diagnostics.Debug.Assert(p != null && p!.Http == 8080 && p.Https == 8443);
        System.Diagnostics.Debug.Assert(ParseTxtV1("{}") == null);
        System.Diagnostics.Debug.Assert(ParseTxtV1("not json") == null);

        // SRV resolution over network (best-effort; nonexistent -> null, no throw)
        var srvNone = await ResolveServiceAsync("nonexistent.invalid", "ws");
        System.Diagnostics.Debug.Assert(srvNone == null, "nonexistent SRV should be null");
        // Unknown service throws
        bool threw = false;
        try { await ResolveServiceAsync("example.com", "wss"); }
        catch (ArgumentException) { threw = true; }
        System.Diagnostics.Debug.Assert(threw, "unknown service should throw");

        Console.WriteLine("KirinDns C# self-test: PASSED (incl. did:dns fingerprint chain)");
    }
}
