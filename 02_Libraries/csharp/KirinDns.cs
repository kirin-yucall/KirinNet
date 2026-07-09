// KirinDns.cs — KirinDNS Resolution Protocol (ADRP) C# Client
//
// Resolves service port mappings from DNS TXT records.
// Pure .NET — no external NuGet dependencies.
//
// Usage:
//   var ports = await KirinDns.ResolveAsync("alice.kirinnet.org");
//   Console.WriteLine($"HTTP: {ports.Http}");
//
// Requires: .NET 6+ (for System.Net.Sockets and System.Text.Json)

using System;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace KirinNet;

/// <summary>Resolved service ports for a KirinDNS domain.</summary>
public record KirinPorts(int Http, int Https, int Ws, int Wss)
{
    public static KirinPorts Fallback => new(80, 443, 80, 443);
}

/// <summary>KirinDNS ADRP resolver.</summary>
public static class KirinDns
{
    private static readonly HashSet<string> RecognizedKeys = new()
        { "http", "https", "ws", "wss" };

    public const int DefaultHttp  = 80;
    public const int DefaultHttps = 443;
    public const int DefaultWs    = 80;
    public const int DefaultWss   = 443;

    /// <summary>
    /// Resolve KirinDNS ports for a domain. Uses the system DNS resolver.
    /// Returns fallback ports if no valid ADRP record is found.
    /// </summary>
    public static async Task<KirinPorts> ResolveAsync(string domain)
    {
        // .NET doesn't expose TXT queries directly. We send a raw DNS
        // query over UDP to the system resolver.
        var dnsServer = GetSystemDnsServer();
        return await ResolveWithServerAsync(domain, dnsServer);
    }

    /// <summary>Resolve using a specific DNS server.</summary>
    public static async Task<KirinPorts> ResolveWithServerAsync(string domain, string dnsServer)
    {
        try
        {
            var txtRecords = await QueryTxtAsync(domain, dnsServer);
            foreach (var txt in txtRecords)
            {
                var ports = ParseTxt(txt);
                if (ports != null) return ports;
            }
        }
        catch
        {
            // DNS failure → fallback
        }
        return KirinPorts.Fallback;
    }

    /// <summary>Parse a TXT record string as ADRP JSON.</summary>
    public static KirinPorts? ParseTxt(string txt)
    {
        if (string.IsNullOrWhiteSpace(txt)) return null;
        txt = txt.Trim();
        if (!txt.StartsWith("{")) return null;

        try
        {
            using var doc = JsonDocument.Parse(txt);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return null;

            int http = 0, https = 0, ws = 0, wss = 0;
            int found = 0;

            foreach (var prop in root.EnumerateObject())
            {
                if (!RecognizedKeys.Contains(prop.Name)) continue;
                if (prop.Value.ValueKind != JsonValueKind.Number) return null;

                int val;
                if (!prop.Value.TryGetInt32(out val)) return null;
                if (val < 1 || val > 65535) return null;

                switch (prop.Name)
                {
                    case "http":  http = val;  break;
                    case "https": https = val; break;
                    case "ws":    ws = val;    break;
                    case "wss":   wss = val;   break;
                }
                found++;
            }

            if (found == 0) return null;

            return new KirinPorts(
                http  > 0 ? http  : DefaultHttp,
                https > 0 ? https : DefaultHttps,
                ws    > 0 ? ws    : DefaultWs,
                wss   > 0 ? wss   : DefaultWss
            );
        }
        catch (JsonException)
        {
            return null;
        }
    }

    // ---- internal DNS TXT query -------------------------------------------

    private static string GetSystemDnsServer()
    {
        // On Linux, reads /etc/resolv.conf
        try
        {
            foreach (var line in System.IO.File.ReadAllLines("/etc/resolv.conf"))
            {
                var trimmed = line.Trim();
                if (trimmed.StartsWith("nameserver "))
                {
                    var ip = trimmed.Substring("nameserver ".Length).Trim();
                    if (IPAddress.TryParse(ip, out _)) return ip;
                }
            }
        }
        catch { }
        return "8.8.8.8"; // fallback
    }

    private static async Task<List<string>> QueryTxtAsync(string domain, string dnsServer)
    {
        // Build raw DNS query: header + question for TXT type
        var query = BuildDnsQuery(domain);
        var results = new List<string>();

        using var udp = new UdpClient();
        udp.Client.SendTimeout = 3000;
        udp.Client.ReceiveTimeout = 3000;

        await udp.SendAsync(query, query.Length, dnsServer, 53);

        var remote = new IPEndPoint(IPAddress.Any, 0);
        var response = udp.Receive(ref remote);

        // Parse TXT answers from response
        ExtractTxtAnswers(response, results);
        return results;
    }

    private static byte[] BuildDnsQuery(string domain)
    {
        var msg = new List<byte>();
        // Header: ID(2) + Flags(2) + QDCOUNT(2) + ANCOUNT(2) + NSCOUNT(2) + ARCOUNT(2)
        byte[] header = { 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00 };
        msg.AddRange(header);

        // Question: domain labels + QTYPE + QCLASS
        foreach (var label in domain.Split('.'))
        {
            msg.Add((byte)label.Length);
            msg.AddRange(Encoding.ASCII.GetBytes(label));
        }
        msg.Add(0x00);              // null terminator
        msg.AddRange(new byte[] { 0x00, 16 }); // QTYPE=TXT(16)
        msg.AddRange(new byte[] { 0x00, 1 });  // QCLASS=IN(1)

        return msg.ToArray();
    }

    private static void ExtractTxtAnswers(byte[] response, List<string> results)
    {
        if (response.Length < 12) return;
        int ancount = (response[6] << 8) | response[7];
        if (ancount == 0) return;

        int pos = 12;
        // Skip question section
        while (pos < response.Length && response[pos] != 0)
            pos += response[pos] + 1;
        pos++; // skip null terminator
        pos += 4; // skip QTYPE + QCLASS

        for (int i = 0; i < ancount && pos < response.Length; i++)
        {
            // Skip NAME (may be compressed)
            if ((response[pos] & 0xC0) == 0xC0) pos += 2;
            else { while (pos < response.Length && response[pos] != 0) pos += response[pos] + 1; pos++; }

            if (pos + 10 > response.Length) break;
            int rtype = (response[pos] << 8) | response[pos + 1];
            pos += 2; // TYPE
            pos += 2; // CLASS
            pos += 4; // TTL
            int rdlen = (response[pos] << 8) | response[pos + 1];
            pos += 2;
            if (pos + rdlen > response.Length) break;

            if (rtype == 16 && rdlen > 1) // TXT
            {
                int txtlen = response[pos];
                pos++;
                if (txtlen > 0 && pos + txtlen <= response.Length)
                {
                    results.Add(Encoding.UTF8.GetString(response, pos, txtlen));
                }
                pos += rdlen - 1;
            }
            else
            {
                pos += rdlen;
            }
        }
    }

    // ---- self-test --------------------------------------------------------
    public static async Task Main(string[] args)
    {
        // Parse tests
        var p = ParseTxt("{\"http\":8080,\"https\":8443}");
        System.Diagnostics.Debug.Assert(p != null);
        System.Diagnostics.Debug.Assert(p.Http == 8080);
        System.Diagnostics.Debug.Assert(p.Https == 8443);
        System.Diagnostics.Debug.Assert(p.Ws == 80);   // fallback
        System.Diagnostics.Debug.Assert(p.Wss == 443);  // fallback

        System.Diagnostics.Debug.Assert(ParseTxt("{}") == null);
        System.Diagnostics.Debug.Assert(ParseTxt("{\"http\":0}") == null);
        System.Diagnostics.Debug.Assert(ParseTxt("not json") == null);

        // Resolution test (will use fallback for nonexistent domain)
        var ports = await ResolveAsync("nonexistent.invalid");
        System.Diagnostics.Debug.Assert(ports.Http == 80);

        Console.WriteLine("KirinDns C# self-test: PASSED");
    }
}
