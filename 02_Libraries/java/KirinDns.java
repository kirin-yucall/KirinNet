/*
 * KirinDns.java — KirinDNS Resolution Protocol (ADRP) v2.0 Java Client
 *
 * Implements ADRP v2.0 per 01_Standard/spec_v1.md and the did:dns three-record
 * identity model in 01_Standard/did-dns-protocol.md §2 (C-1 baseline, 2026-08-08).
 *
 * Architecture:
 *   SRV records (_kirinnet-http/https/ws._tcp) for service port discovery.
 *   TXT records for identity metadata in did:dns three-record form:
 *     did:dns:v=1;fp=<fp>;n=<nick>;g=<gender>;iat=<ts>;exp=<ts>   (declaration)
 *     did:dns:pk;kty=ed25519;pk=<pubkey-base64url>                 (public key)
 *     did:dns:black;fp=<fp1>,<fp2>,...                             (blacklist, optional)
 *   The tamper-evident fingerprint chain binds declaration to public key:
 *     fp == Base64URL(SHA-256(pk_bytes)[0:12])
 *
 * The v1 TXT-JSON port model (Ports / parseTxt) is retained for backward
 * compatibility; new code MUST use resolveService / parseDidDnsIdentity.
 *
 * Pure Java — no external dependencies beyond the JDK (JNDI DNS provider).
 *
 * Compile:  javac KirinDns.java
 * Run:      java -ea KirinDns        (-ea enables assertions in the self-test)
 */

import javax.naming.NamingException;
import javax.naming.directory.Attribute;
import javax.naming.directory.Attributes;
import javax.naming.directory.InitialDirContext;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Hashtable;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public class KirinDns {

    // ---- SRV service names (spec §2.2) ----------------------------------
    private static final Map<String, String> SRV_SERVICES = new LinkedHashMap<>();
    static {
        SRV_SERVICES.put("http",  "_kirinnet-http._tcp");
        SRV_SERVICES.put("https", "_kirinnet-https._tcp");
        SRV_SERVICES.put("ws",    "_kirinnet-ws._tcp");
    }

    // ---- Fallback ports (spec §3.3.1 Step 4) ----------------------------
    public static final int DEFAULT_HTTP  = 80;
    public static final int DEFAULT_HTTPS = 443;
    public static final int DEFAULT_WS    = 80;
    public static final int DEFAULT_WSS   = 443;

    // ---- did:dns constants (spec §3.2.1 / did-dns-protocol §2) ----------
    private static final String DID_DNS_PREFIX     = "did:dns:";
    private static final String DID_DNS_DECL_PREFIX = "did:dns:v=";
    private static final String DID_DNS_PK_PREFIX   = "did:dns:pk;";
    private static final String DID_DNS_BLACK_PREFIX = "did:dns:black;";
    private static final String KTY_ED25519 = "ed25519";
    private static final int FRESHNESS_WINDOW_SECONDS = 5 * 60;
    private static final int FINGERPRINT_BYTES = 12;

    // =====================================================================
    // v2 result types
    // =====================================================================

    /** A resolved SRV service target. */
    public static final class SrvResult {
        public final String target;
        public final int port;
        public SrvResult(String target, int port) { this.target = target; this.port = port; }
        @Override public String toString() { return target + ":" + port; }
    }

    /** A single SRV record (priority/weight used for selection). */
    private static final class SrvRecord {
        final String target; final int port, priority, weight;
        SrvRecord(String t, int p, int pr, int w) { target = t; port = p; priority = pr; weight = w; }
    }

    /**
     * A parsed did:dns identity (declaration + public key, optional blacklist).
     * The caller applies trust policy via {@link #isValid()} (fail-closed).
     */
    public static final class DidDnsIdentity {
        public int version = 1;
        public String fingerprint = "";
        public String nickname;          // Base64URL(UTF-8), may be null
        public String gender;            // M/F/O/X, may be null
        public Long issuedAt;             // Unix seconds, may be null
        public Long expiresAt;            // Unix seconds, may be null
        public String keyType = KTY_ED25519;
        public String publicKeyB64Url = "";
        public List<String> blacklist = new ArrayList<>();
        public String rawDeclaration = "";
        public String rawPublicKey = "";

        public byte[] publicKeyBytes() {
            return base64UrlDecode(publicKeyB64Url);
        }

        /** Recompute fp = Base64URL(SHA-256(pk)[0:12]). */
        public String computeFingerprint() {
            try {
                MessageDigest md = MessageDigest.getInstance("SHA-256");
                byte[] digest = md.digest(publicKeyBytes());
                byte[] truncated = new byte[FINGERPRINT_BYTES];
                System.arraycopy(digest, 0, truncated, 0, FINGERPRINT_BYTES);
                return base64UrlEncode(truncated);
            } catch (Exception e) {
                throw new RuntimeException(e); // SHA-256 is mandatory in every JDK
            }
        }

        public boolean fingerprintChainOk() {
            return fingerprint != null && !fingerprint.isEmpty()
                && fingerprint.equals(computeFingerprint());
        }

        public boolean isRevoked() { return blacklist.contains(fingerprint); }

        public boolean isExpired(Long now) {
            if (expiresAt == null) return false;
            long t = now != null ? now : System.currentTimeMillis() / 1000L;
            return t >= expiresAt;
        }

        public boolean isStale(Long now) {
            if (issuedAt == null) return false;
            long t = now != null ? now : System.currentTimeMillis() / 1000L;
            return Math.abs(t - issuedAt) > FRESHNESS_WINDOW_SECONDS;
        }

        public boolean isValid(Long now) {
            return version == 1
                && KTY_ED25519.equals(keyType)
                && fingerprintChainOk()
                && !isRevoked()
                && !isExpired(now);
        }

        public String nicknameDecoded() {
            if (nickname == null || nickname.isEmpty()) return null;
            try {
                return new String(base64UrlDecode(nickname), StandardCharsets.UTF_8);
            } catch (Exception e) {
                return null;
            }
        }

        @Override public String toString() {
            return "DidDnsIdentity{fp=" + fingerprint + ", kty=" + keyType
                + ", chainOk=" + fingerprintChainOk() + "}";
        }
    }

    // =====================================================================
    // v2: SRV service resolution
    // =====================================================================

    /**
     * Resolve a single service port via SRV.
     * Returns null if no SRV record found (caller falls back to standard port).
     * @throws IllegalArgumentException on unknown service.
     */
    public static SrvResult resolveService(String domain, String service) {
        String srvPrefix = SRV_SERVICES.get(service);
        if (srvPrefix == null) {
            throw new IllegalArgumentException(
                "Unknown service: " + service + ". Recognized: http, https, ws");
        }
        try {
            InitialDirContext ctx = newInitialDirContext();
            Attributes attrs = ctx.getAttributes(
                srvPrefix + "." + domain, new String[]{"SRV"});
            Attribute srvAttr = attrs.get("SRV");
            if (srvAttr == null) return null;

            List<SrvRecord> records = new ArrayList<>();
            for (int i = 0; i < srvAttr.size(); i++) {
                SrvRecord r = parseSrvRecord(srvAttr.get(i).toString());
                if (r != null) records.add(r);
            }
            if (records.isEmpty()) return null;

            // RFC 2782: lowest priority, then highest weight
            records.sort((a, b) -> {
                int c = Integer.compare(a.priority, b.priority);
                return c != 0 ? c : Integer.compare(b.weight, a.weight);
            });
            SrvRecord best = records.get(0);
            String target = best.target.endsWith(".")
                ? best.target.substring(0, best.target.length() - 1) : best.target;
            return new SrvResult(target, best.port);
        } catch (NamingException e) {
            return null; // NXDOMAIN / no SRV → null (fail-closed)
        }
    }

    private static SrvRecord parseSrvRecord(String s) {
        if (s == null) return null;
        // JNDI SRV format: "priority weight port target"
        String[] parts = s.trim().split("\\s+");
        if (parts.length < 4) return null;
        try {
            return new SrvRecord(parts[3],
                Integer.parseInt(parts[2]),
                Integer.parseInt(parts[0]),
                Integer.parseInt(parts[1]));
        } catch (NumberFormatException e) {
            return null;
        }
    }

    // =====================================================================
    // v2: did:dns identity resolution
    // =====================================================================

    /**
     * Resolve and assemble a did:dns identity for {@code domain}.
     * Returns null on NXDOMAIN / no TXT / no did:dns records (fail-closed).
     */
    public static DidDnsIdentity resolveIdentityDidDns(String domain) {
        try {
            InitialDirContext ctx = newInitialDirContext();
            Attributes attrs = ctx.getAttributes(domain, new String[]{"TXT"});
            Attribute txtAttr = attrs.get("TXT");
            if (txtAttr == null) return null;
            List<String> records = new ArrayList<>();
            for (int i = 0; i < txtAttr.size(); i++) {
                Object v = txtAttr.get(i);
                if (v != null) records.add(quoteStrip(v.toString()));
            }
            return parseDidDnsIdentity(records);
        } catch (NamingException e) {
            return null;
        }
    }

    /**
     * Classify TXT records by did:dns: sub-type and assemble an identity.
     * Pure function (no network) — usable for tests.
     */
    public static DidDnsIdentity parseDidDnsIdentity(List<String> txtRecords) {
        if (txtRecords == null) return null;
        String declRaw = null, pkRaw = null, blackRaw = null;

        for (String raw : txtRecords) {
            if (raw == null) continue;
            String s = raw.trim();
            if (s.startsWith(DID_DNS_DECL_PREFIX)) {
                if (declRaw == null) declRaw = s;
            } else if (s.startsWith(DID_DNS_PK_PREFIX)) {
                if (pkRaw == null) pkRaw = s;
            } else if (s.startsWith(DID_DNS_BLACK_PREFIX)) {
                if (blackRaw == null) blackRaw = s;
            }
        }
        if (declRaw == null || pkRaw == null) return null;

        Map<String, String> decl = parseKv(declRaw.substring(DID_DNS_PREFIX.length()));
        Map<String, String> pk = parseKv(pkRaw.substring(DID_DNS_PREFIX.length()));

        DidDnsIdentity id = new DidDnsIdentity();
        id.version = parseIntOrDefault(decl.get("v"), 1);
        id.fingerprint = decl.getOrDefault("fp", "");
        id.nickname = decl.get("n");
        if (id.nickname != null && id.nickname.isEmpty()) id.nickname = null;
        id.gender = decl.get("g");
        if (id.gender != null && id.gender.isEmpty()) id.gender = null;
        id.issuedAt = parseLongOrNull(decl.get("iat"));
        id.expiresAt = parseLongOrNull(decl.get("exp"));
        id.keyType = pk.getOrDefault("kty", KTY_ED25519);
        id.publicKeyB64Url = pk.getOrDefault("pk", "");
        id.rawDeclaration = declRaw;
        id.rawPublicKey = pkRaw;

        if (blackRaw != null) {
            Map<String, String> black = parseKv(blackRaw.substring(DID_DNS_PREFIX.length()));
            String fpField = black.getOrDefault("fp", "");
            for (String f : fpField.split(",")) {
                if (!f.isEmpty()) id.blacklist.add(f);
            }
        }
        return id;
    }

    // =====================================================================
    // v1 legacy (deprecated)
    // =====================================================================

    /** Standard IANA fallback ports. */
    public static final int V1_DEFAULT_HTTP  = 80;
    public static final int V1_DEFAULT_HTTPS = 443;
    public static final int V1_DEFAULT_WS    = 80;
    public static final int V1_DEFAULT_WSS   = 443;

    /** @deprecated v1 TXT-JSON model. Use resolveService + resolveIdentityDidDns. */
    @Deprecated
    public static final class Ports {
        public final int http, https, ws, wss;
        public Ports(int http, int https, int ws, int wss) {
            this.http = http; this.https = https; this.ws = ws; this.wss = wss;
        }
        public static Ports fallback() {
            return new Ports(V1_DEFAULT_HTTP, V1_DEFAULT_HTTPS, V1_DEFAULT_WS, V1_DEFAULT_WSS);
        }
        @Override public String toString() {
            return String.format("{http:%d, https:%d, ws:%d, wss:%d}", http, https, ws, wss);
        }
    }

    /** @deprecated v1 TXT-JSON model. */
    @Deprecated
    public static Ports resolve(String domain) {
        Ports ports = Ports.fallback();
        try {
            InitialDirContext ctx = newInitialDirContext();
            Attributes attrs = ctx.getAttributes(domain, new String[]{"TXT"});
            Attribute txtAttr = attrs.get("TXT");
            if (txtAttr == null) return ports;
            for (int i = 0; i < txtAttr.size(); i++) {
                Object v = txtAttr.get(i);
                Ports parsed = parseTxt(v != null ? v.toString() : "");
                if (parsed != null) return parsed;
            }
        } catch (NamingException e) {
            // NXDOMAIN / no TXT → fallback
        }
        return ports;
    }

    /** @deprecated v1 TXT-JSON model. */
    @Deprecated
    public static Ports parseTxt(String txt) {
        if (txt == null || txt.isEmpty()) return null;
        txt = txt.trim();
        if (!txt.startsWith("{")) return null;
        // Minimal JSON scan for {http|https|ws|wss:int,...}
        int http = 0, https = 0, ws = 0, wss = 0, found = 0;
        for (String key : new String[]{"http", "https", "ws", "wss"}) {
            String search = "\"" + key + "\":";
            int idx = txt.indexOf(search);
            if (idx < 0) continue;
            idx += search.length();
            while (idx < txt.length() && (txt.charAt(idx) == ' ' || txt.charAt(idx) == '\t')) idx++;
            int end = idx;
            while (end < txt.length() && Character.isDigit(txt.charAt(end))) end++;
            if (end == idx) continue;
            int val;
            try { val = Integer.parseInt(txt.substring(idx, end)); }
            catch (NumberFormatException e) { continue; }
            if (val < 1 || val > 65535) return null;
            switch (key) {
                case "http":  http = val; break;
                case "https": https = val; break;
                case "ws":    ws = val; break;
                case "wss":   wss = val; break;
            }
            found++;
        }
        if (found == 0) return null;
        return new Ports(
            http > 0 ? http : V1_DEFAULT_HTTP,
            https > 0 ? https : V1_DEFAULT_HTTPS,
            ws > 0 ? ws : V1_DEFAULT_WS,
            wss > 0 ? wss : V1_DEFAULT_WSS);
    }

    // =====================================================================
    // Helpers
    // =====================================================================

    private static InitialDirContext newInitialDirContext() throws NamingException {
        Hashtable<String, String> env = new Hashtable<>();
        env.put("java.naming.factory.initial", "com.sun.jndi.dns.DnsContextFactory");
        env.put("java.naming.provider.url", "dns://");
        return new InitialDirContext(env);
    }

    private static Map<String, String> parseKv(String text) {
        Map<String, String> d = new LinkedHashMap<>();
        for (String pair : text.split(";")) {
            int eq = pair.indexOf('=');
            if (eq < 0) continue;
            String k = pair.substring(0, eq).trim();
            String v = pair.substring(eq + 1).trim();
            d.put(k, v);
        }
        return d;
    }

    private static int parseIntOrDefault(String s, int def) {
        if (s == null) return def;
        try { return Integer.parseInt(s); } catch (NumberFormatException e) { return def; }
    }

    private static Long parseLongOrNull(String s) {
        if (s == null) return null;
        try { return Long.parseLong(s); } catch (NumberFormatException e) { return null; }
    }

    /** JNDI sometimes wraps TXT values in double quotes; strip them. */
    private static String quoteStrip(String s) {
        if (s == null) return null;
        s = s.trim();
        if (s.length() >= 2 && s.startsWith("\"") && s.endsWith("\"")) {
            return s.substring(1, s.length() - 1);
        }
        return s;
    }

    // ---- Base64URL helpers (no padding, RFC 4648 §5) --------------------

    private static String base64UrlEncode(byte[] bytes) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    private static byte[] base64UrlDecode(String s) {
        // Tolerate missing padding; getUrlDecoder requires it, so pad manually.
        String padded = s;
        int pad = (4 - padded.length() % 4) % 4;
        if (pad > 0) padded = padded + "====".substring(0, pad);
        return Base64.getUrlDecoder().decode(padded);
    }

    // =====================================================================
    // Self-test (run: java -ea KirinDns)
    // =====================================================================
    public static void main(String[] args) {
        // Deterministic 32-byte key + its fingerprint (matches the JS/Python golden vector).
        byte[] pkBytes = new byte[32];
        for (int i = 0; i < 32; i++) pkBytes[i] = (byte) i;
        String pkB64 = base64UrlEncode(pkBytes);
        MessageDigest sha = null;
        try { sha = MessageDigest.getInstance("SHA-256"); }
        catch (Exception e) { throw new RuntimeException(e); }
        byte[] digest = sha.digest(pkBytes);
        byte[] fpBytes = new byte[FINGERPRINT_BYTES];
        System.arraycopy(digest, 0, fpBytes, 0, FINGERPRINT_BYTES);
        String fp = base64UrlEncode(fpBytes);
        long now = 1_700_000_000L;

        java.util.List<String> recs = java.util.Arrays.asList(
            "v=spf1 include:_spf.kirinnet.org -all",
            "did:dns:v=1;fp=" + fp + ";n=QWxpY2U;g=F;iat=" + now + ";exp=" + (now + 3600),
            "did:dns:pk;kty=ed25519;pk=" + pkB64,
            "did:dns:black;fp=RevokedAaaa,RevokedBbbb"
        );

        DidDnsIdentity id = parseDidDnsIdentity(recs);
        assert id != null : "did:dns identity must parse";
        assert id.version == 1 : "version";
        assert id.fingerprint.equals(fp) : "fp";
        assert id.keyType.equals("ed25519") : "kty";
        assert id.fingerprintChainOk() : "fingerprint chain";
        assert id.isValid(now) : "fresh ed25519 valid";
        assert "Alice".equals(id.nicknameDecoded()) : "nickname decode";
        assert "F".equals(id.gender) : "gender";
        assert id.blacklist.size() == 2 : "blacklist size";
        assert !id.isRevoked() : "not revoked";

        // Tampered pk -> chain breaks
        byte[] wrongPk = new byte[32];
        java.util.Arrays.fill(wrongPk, (byte) 0xff);
        java.util.List<String> tampered = new java.util.ArrayList<>(recs);
        tampered.set(2, "did:dns:pk;kty=ed25519;pk=" + base64UrlEncode(wrongPk));
        DidDnsIdentity broken = parseDidDnsIdentity(tampered);
        assert broken != null && !broken.fingerprintChainOk() : "tampered pk breaks chain";

        // Missing pk -> null
        assert parseDidDnsIdentity(java.util.Arrays.asList(recs.get(1))) == null : "missing pk -> null";
        // No did:dns -> null
        assert parseDidDnsIdentity(java.util.Arrays.asList("v=spf1 -all", "id=foo;key=bar")) == null : "no did:dns -> null";
        // RSA kty -> invalid
        DidDnsIdentity rsa = parseDidDnsIdentity(java.util.Arrays.asList(
            recs.get(1), "did:dns:pk;kty=rsa;pk=" + pkB64));
        assert rsa.keyType.equals("rsa") && !rsa.isValid(now) : "rsa kty rejected";

        // v1 legacy parser still works
        Ports p = parseTxt("{\"http\":8080,\"https\":8443}");
        assert p != null && p.http == 8080 && p.https == 8443 : "v1 parse";
        assert parseTxt("{}") == null : "v1 empty";
        assert parseTxt("not json") == null : "v1 not json";

        // SRV resolution over network (best-effort; nonexistent -> null, no throw)
        assert resolveService("nonexistent.invalid", "ws") == null : "nonexistent SRV null";
        // Unknown service throws
        boolean threw = false;
        try { resolveService("example.com", "wss"); }
        catch (IllegalArgumentException e) { threw = true; }
        assert threw : "unknown service should throw";

        System.out.println("KirinDns Java self-test: PASSED (incl. did:dns fingerprint chain)");
    }
}
