/*
 * KirinDns.java — KirinDNS Resolution Protocol (ADRP) Java Client
 *
 * Resolves service port mappings from DNS TXT records.
 * Pure Java — no external dependencies beyond the JDK.
 *
 * Usage:
 *   KirinDns.Ports ports = KirinDns.resolve("alice.kirinnet.org");
 *   System.out.println("HTTP: " + ports.http);
 *
 * Compile:  javac KirinDns.java
 */

import javax.naming.NamingException;
import javax.naming.directory.Attribute;
import javax.naming.directory.Attributes;
import javax.naming.directory.InitialDirContext;
import java.util.Hashtable;

public class KirinDns {

    /** Standard IANA fallback ports. */
    public static final int DEFAULT_HTTP  = 80;
    public static final int DEFAULT_HTTPS = 443;
    public static final int DEFAULT_WS    = 80;
    public static final int DEFAULT_WSS   = 443;

    /** Recognized ADRP keys. */
    private static final java.util.Set<String> RECOGNIZED =
        java.util.Set.of("http", "https", "ws", "wss");

    /**
     * Resolved service ports for a KirinDNS domain.
     * All four fields always have a value.
     */
    public static class Ports {
        public final int http, https, ws, wss;

        Ports(int http, int https, int ws, int wss) {
            this.http  = http;
            this.https = https;
            this.ws    = ws;
            this.wss   = wss;
        }

        /** Fallback ports. */
        public static Ports fallback() {
            return new Ports(DEFAULT_HTTP, DEFAULT_HTTPS, DEFAULT_WS, DEFAULT_WSS);
        }

        @Override
        public String toString() {
            return String.format("{http:%d, https:%d, ws:%d, wss:%d}", http, https, ws, wss);
        }
    }

    /**
     * Resolve KirinDNS ports for a domain.
     * Returns fallback ports if no valid ADRP TXT record exists.
     */
    public static Ports resolve(String domain) {
        Ports ports = Ports.fallback();

        try {
            Hashtable<String, String> env = new Hashtable<>();
            env.put("java.naming.factory.initial", "com.sun.jndi.dns.DnsContextFactory");
            env.put("java.naming.provider.url", "dns://");
            InitialDirContext ctx = new InitialDirContext(env);

            Attributes attrs = ctx.getAttributes(domain, new String[]{"TXT"});
            Attribute txtAttr = attrs.get("TXT");

            if (txtAttr == null) return ports;

            for (int i = 0; i < txtAttr.size(); i++) {
                Object val = txtAttr.get(i);
                String txt = val != null ? val.toString() : "";
                Ports parsed = parseTxt(txt);
                if (parsed != null) return parsed;
            }
        } catch (NamingException e) {
            // NXDOMAIN, no TXT, etc. → fallback
        }

        return ports;
    }

    /**
     * Parse a TXT record string as an ADRP JSON record.
     * Returns null if not a valid ADRP record.
     */
    private static Ports parseTxt(String txt) {
        if (txt == null || txt.isEmpty()) return null;
        txt = txt.trim();
        if (!txt.startsWith("{")) return null;

        int http = 0, https = 0, ws = 0, wss = 0;
        int found = 0;

        // Minimal JSON parser — ADRP format is very constrained
        for (String key : RECOGNIZED) {
            String search = "\"" + key + "\":";
            int idx = txt.indexOf(search);
            if (idx < 0) continue;

            idx += search.length();
            // Skip whitespace
            while (idx < txt.length() && (txt.charAt(idx) == ' ' || txt.charAt(idx) == '\t'))
                idx++;
            // Parse integer
            int end = idx;
            while (end < txt.length() && Character.isDigit(txt.charAt(end)))
                end++;
            if (end == idx) continue;

            int val;
            try {
                val = Integer.parseInt(txt.substring(idx, end));
            } catch (NumberFormatException e) {
                continue;
            }
            if (val < 1 || val > 65535) return null;

            switch (key) {
                case "http":  http = val;  break;
                case "https": https = val; break;
                case "ws":    ws = val;    break;
                case "wss":   wss = val;   break;
            }
            found++;
        }

        if (found == 0) return null;

        // Fill missing with fallbacks
        if (http == 0)  http  = DEFAULT_HTTP;
        if (https == 0) https = DEFAULT_HTTPS;
        if (ws == 0)    ws    = DEFAULT_WS;
        if (wss == 0)   wss   = DEFAULT_WSS;

        return new Ports(http, https, ws, wss);
    }

    // ---- self-test ------------------------------------------------------
    public static void main(String[] args) {
        // Fallback for nonexistent domain
        Ports p = resolve("nonexistent.invalid");
        assert p.http  == 80  : "fallback http";
        assert p.https == 443 : "fallback https";
        assert p.ws    == 80  : "fallback ws";
        assert p.wss   == 443 : "fallback wss";

        // Parse
        Ports parsed = parseTxt("{\"http\":8080,\"https\":8443}");
        assert parsed != null : "valid parse";
        assert parsed.http  == 8080 : "http parsed";
        assert parsed.https == 8443 : "https parsed";
        assert parsed.ws    == 80   : "ws fallback inside parse";
        assert parsed.wss   == 443  : "wss fallback inside parse";

        // Invalid
        assert parseTxt("{}") == null : "empty object";
        assert parseTxt("{\"http\":0}") == null : "port zero";
        assert parseTxt("not json") == null : "not json";

        System.out.println("KirinDns Java self-test: PASSED");
    }
}
