/**
 * KirinDNS Resolution Protocol (ADRP) v2.0 — Kotlin Client
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
 * The v1 TXT-JSON port model (KirinPorts / parseTxt) is retained for backward
 * compatibility; new code MUST use resolveService / parseDidDnsIdentity.
 *
 * Pure Kotlin/JVM — uses javax.naming (JNDI DNS), no extra dependencies.
 *
 * Compile + run self-test:
 *   kotlinc KirinDns.kt -include-runtime -d KirinDns.jar
 *   kotlin KirinDns.jar
 */

package kirinnet

import java.security.MessageDigest
import java.util.Base64
import java.util.Hashtable
import javax.naming.directory.InitialDirContext

// ---------------------------------------------------------------------------
// Constants (spec §2.2, §3.3.1 Step 4, §3.2.1 / did-dns-protocol §2)
// ---------------------------------------------------------------------------

private val SRV_SERVICES = linkedMapOf(
    "http" to "_kirinnet-http._tcp",
    "https" to "_kirinnet-https._tcp",
    "ws" to "_kirinnet-ws._tcp",
)

const val DEFAULT_HTTP = 80
const val DEFAULT_HTTPS = 443
const val DEFAULT_WS = 80
const val DEFAULT_WSS = 443

private const val DID_DNS_PREFIX = "did:dns:"
private const val DID_DNS_DECL_PREFIX = "did:dns:v="
private const val DID_DNS_PK_PREFIX = "did:dns:pk;"
private const val DID_DNS_BLACK_PREFIX = "did:dns:black;"
private const val KTY_ED25519 = "ed25519"
private const val FRESHNESS_WINDOW_SECONDS = 5L * 60
private const val FINGERPRINT_BYTES = 12

// ---------------------------------------------------------------------------
// v2 result types
// ---------------------------------------------------------------------------

/** A resolved SRV service target. */
data class SrvResult(val target: String, val port: Int)

private data class SrvRecord(
    val target: String, val port: Int, val priority: Int, val weight: Int
)

/**
 * A parsed did:dns identity (declaration + public key, optional blacklist).
 * The caller applies trust policy via [isValid] (fail-closed).
 */
class DidDnsIdentity(
    var version: Int = 1,
    var fingerprint: String = "",
    var nickname: String? = null,        // Base64URL(UTF-8)
    var gender: String? = null,          // M/F/O/X
    var issuedAt: Long? = null,
    var expiresAt: Long? = null,
    var keyType: String = KTY_ED25519,
    var publicKeyB64Url: String = "",
    var blacklist: MutableList<String> = mutableListOf(),
    var rawDeclaration: String = "",
    var rawPublicKey: String = "",
) {
    val publicKeyBytes: ByteArray
        get() = base64UrlDecode(publicKeyB64Url)

    /** Recompute fp = Base64URL(SHA-256(pk)[0:12]). */
    fun computeFingerprint(): String {
        val md = MessageDigest.getInstance("SHA-256")
        val digest = md.digest(publicKeyBytes)
        val truncated = digest.copyOfRange(0, FINGERPRINT_BYTES)
        return base64UrlEncode(truncated)
    }

    fun fingerprintChainOk(): Boolean =
        fingerprint.isNotEmpty() && fingerprint == computeFingerprint()

    fun isRevoked(): Boolean = blacklist.contains(fingerprint)

    fun isExpired(now: Long? = null): Boolean {
        val exp = expiresAt ?: return false
        val t = now ?: System.currentTimeMillis() / 1000L
        return t >= exp
    }

    fun isStale(now: Long? = null): Boolean {
        val iat = issuedAt ?: return false
        val t = now ?: System.currentTimeMillis() / 1000L
        return Math.abs(t - iat) > FRESHNESS_WINDOW_SECONDS
    }

    fun isValid(now: Long? = null): Boolean =
        version == 1
            && keyType == KTY_ED25519
            && fingerprintChainOk()
            && !isRevoked()
            && !isExpired(now)

    fun nicknameDecoded(): String? {
        val n = nickname ?: return null
        return try { String(base64UrlDecode(n), Charsets.UTF_8) } catch (_: Exception) { null }
    }

    override fun toString(): String =
        "DidDnsIdentity(fp=$fingerprint, kty=$keyType, chainOk=${fingerprintChainOk()})"
}

// ---------------------------------------------------------------------------
// v2: SRV service resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a single service port via SRV.
 * @throws IllegalArgumentException on unknown service.
 */
fun resolveService(domain: String, service: String): SrvResult? {
    val srvPrefix = SRV_SERVICES[service]
        ?: throw IllegalArgumentException("Unknown service: $service. Recognized: http, https, ws")

    return try {
        val ctx = newInitialDirContext()
        val attrs = ctx.getAttributes("$srvPrefix.$domain", arrayOf("SRV"))
        val srvAttr = attrs.get("SRV") ?: return null

        val records = (0 until srvAttr.size()).mapNotNull {
            parseSrvRecord(srvAttr.get(it)?.toString())
        }
        if (records.isEmpty()) return null

        // RFC 2782: lowest priority, then highest weight
        val best = records.sortedWith(
            compareBy<SrvRecord> { it.priority }.thenByDescending { it.weight }
        ).first()
        val target = best.target.trimEnd('.')
        SrvResult(target, best.port)
    } catch (_: Exception) {
        null // NXDOMAIN / no SRV → null (fail-closed)
    }
}

private fun parseSrvRecord(s: String?): SrvRecord? {
    if (s == null) return null
    // JNDI SRV format: "priority weight port target"
    val parts = s.trim().split(Regex("\\s+"))
    if (parts.size < 4) return null
    return try {
        SrvRecord(parts[3], parts[2].toInt(), parts[0].toInt(), parts[1].toInt())
    } catch (_: NumberFormatException) {
        null
    }
}

// ---------------------------------------------------------------------------
// v2: did:dns identity resolution
// ---------------------------------------------------------------------------

/** Resolve and assemble a did:dns identity (fail-closed: null if absent). */
fun resolveIdentityDidDns(domain: String): DidDnsIdentity? {
    return try {
        val ctx = newInitialDirContext()
        val attrs = ctx.getAttributes(domain, arrayOf("TXT"))
        val txtAttr = attrs.get("TXT") ?: return null
        val records = (0 until txtAttr.size()).mapNotNull { i ->
            txtAttr.get(i)?.toString()?.let(::quoteStrip)
        }
        parseDidDnsIdentity(records)
    } catch (_: Exception) {
        null
    }
}

/**
 * Classify TXT records by did:dns: sub-type and assemble an identity.
 * Pure function (no network) — usable for tests.
 */
fun parseDidDnsIdentity(txtRecords: List<String>?): DidDnsIdentity? {
    if (txtRecords == null) return null
    var declRaw: String? = null
    var pkRaw: String? = null
    var blackRaw: String? = null

    for (raw in txtRecords) {
        val s = raw.trim()
        when {
            s.startsWith(DID_DNS_DECL_PREFIX) -> { if (declRaw == null) declRaw = s }
            s.startsWith(DID_DNS_PK_PREFIX) -> { if (pkRaw == null) pkRaw = s }
            s.startsWith(DID_DNS_BLACK_PREFIX) -> { if (blackRaw == null) blackRaw = s }
        }
    }
    if (declRaw == null || pkRaw == null) return null

    val decl = parseKv(declRaw.substring(DID_DNS_PREFIX.length))
    val pk = parseKv(pkRaw.substring(DID_DNS_PREFIX.length))

    val id = DidDnsIdentity(
        version = decl["v"]?.toIntOrNull() ?: 1,
        fingerprint = decl["fp"] ?: "",
        nickname = decl["n"]?.takeIf { it.isNotEmpty() },
        gender = decl["g"]?.takeIf { it.isNotEmpty() },
        issuedAt = decl["iat"]?.toLongOrNull(),
        expiresAt = decl["exp"]?.toLongOrNull(),
        keyType = pk["kty"] ?: KTY_ED25519,
        publicKeyB64Url = pk["pk"] ?: "",
        rawDeclaration = declRaw,
        rawPublicKey = pkRaw,
    )
    if (blackRaw != null) {
        val fpField = parseKv(blackRaw.substring(DID_DNS_PREFIX.length))["fp"] ?: ""
        id.blacklist = fpField.split(",").filter { it.isNotEmpty() }.toMutableList()
    }
    return id
}

// ---------------------------------------------------------------------------
// v1 legacy (deprecated)
// ---------------------------------------------------------------------------

/** @deprecated v1 TXT-JSON model. */
@Deprecated("v1 TXT-JSON model. Use resolveService + resolveIdentityDidDns.")
data class KirinPorts(
    val http: Int = 80,
    val https: Int = 443,
    val ws: Int = 80,
    val wss: Int = 443,
) {
    companion object { val FALLBACK = KirinPorts() }
}

/** @deprecated v1 TXT-JSON model. */
@Deprecated("v1 TXT-JSON model.")
object KirinDns {
    fun resolve(domain: String): KirinPorts {
        var ports = KirinPorts.FALLBACK
        return try {
            val ctx = newInitialDirContext()
            val attrs = ctx.getAttributes(domain, arrayOf("TXT"))
            val txtAttr = attrs.get("TXT") ?: return ports
            for (i in 0 until txtAttr.size()) {
                val parsed = parseTxt(txtAttr.get(i)?.toString())
                if (parsed != null) { ports = parsed; break }
            }
            ports
        } catch (_: Exception) {
            ports
        }
    }
}

/** @deprecated v1 TXT-JSON model. */
@Deprecated("v1 TXT-JSON model.")
fun parseTxt(txt: String?): KirinPorts? {
    if (txt.isNullOrBlank()) return null
    val trimmed = txt.trim()
    if (!trimmed.startsWith("{")) return null
    var http = 0; var https = 0; var ws = 0; var wss = 0; var found = 0
    for (key in listOf("http", "https", "ws", "wss")) {
        val search = "\"$key\":"
        var idx = trimmed.indexOf(search)
        if (idx < 0) continue
        idx += search.length
        while (idx < trimmed.length && (trimmed[idx] == ' ' || trimmed[idx] == '\t')) idx++
        var end = idx
        while (end < trimmed.length && trimmed[end].isDigit()) end++
        if (end == idx) continue
        val num = trimmed.substring(idx, end).toIntOrNull() ?: continue
        if (num < 1 || num > 65535) return null
        when (key) {
            "http" -> http = num
            "https" -> https = num
            "ws" -> ws = num
            "wss" -> wss = num
        }
        found++
    }
    if (found == 0) return null
    return KirinPorts(
        http = if (http > 0) http else DEFAULT_HTTP,
        https = if (https > 0) https else DEFAULT_HTTPS,
        ws = if (ws > 0) ws else DEFAULT_WS,
        wss = if (wss > 0) wss else DEFAULT_WSS,
    )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

private fun newInitialDirContext(): InitialDirContext {
    val env = Hashtable<String, String>().apply {
        put("java.naming.factory.initial", "com.sun.jndi.dns.DnsContextFactory")
        put("java.naming.provider.url", "dns://")
    }
    return InitialDirContext(env)
}

private fun parseKv(text: String): Map<String, String> {
    val d = linkedMapOf<String, String>()
    for (pair in text.split(";")) {
        val eq = pair.indexOf('=')
        if (eq < 0) continue
        d[pair.substring(0, eq).trim()] = pair.substring(eq + 1).trim()
    }
    return d
}

/** JNDI sometimes wraps TXT values in double quotes; strip them. */
private fun quoteStrip(s: String): String {
    val t = s.trim()
    return if (t.length >= 2 && t.startsWith("\"") && t.endsWith("\"")) t.substring(1, t.length - 1) else t
}

// ---- Base64URL helpers (no padding, RFC 4648 §5) ----

private fun base64UrlEncode(bytes: ByteArray): String =
    Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

private fun base64UrlDecode(s: String): ByteArray {
    val pad = (4 - s.length % 4) % 4
    val padded = if (pad > 0) s + "====".substring(0, pad) else s
    return Base64.getUrlDecoder().decode(padded)
}

// ---------------------------------------------------------------------------
// Self-test (run: kotlin -cp KirinDns.jar kirinnet.MainKt  or  kotlin KirinDns.jar)
// ---------------------------------------------------------------------------
fun main() {
    // Deterministic 32-byte key + its fingerprint (matches JS/Python golden vector).
    val pkBytes = ByteArray(32) { it.toByte() }
    val pkB64 = base64UrlEncode(pkBytes)
    val sha = MessageDigest.getInstance("SHA-256")
    val fp = base64UrlEncode(sha.digest(pkBytes).copyOfRange(0, FINGERPRINT_BYTES))
    val now = 1_700_000_000L

    val recs = listOf(
        "v=spf1 include:_spf.kirinnet.org -all",
        "did:dns:v=1;fp=$fp;n=QWxpY2U;g=F;iat=$now;exp=${now + 3600}",
        "did:dns:pk;kty=ed25519;pk=$pkB64",
        "did:dns:black;fp=RevokedAaaa,RevokedBbbb",
    )

    val id = parseDidDnsIdentity(recs)
    check(id != null) { "did:dns identity must parse" }
    check(id!!.version == 1) { "version" }
    check(id.fingerprint == fp) { "fp" }
    check(id.keyType == "ed25519") { "kty" }
    check(id.fingerprintChainOk()) { "fingerprint chain" }
    check(id.isValid(now)) { "fresh ed25519 valid" }
    check(id.nicknameDecoded() == "Alice") { "nickname decode" }
    check(id.gender == "F") { "gender" }
    check(id.blacklist.size == 2) { "blacklist size" }
    check(!id.isRevoked()) { "not revoked" }

    // Tampered pk -> chain breaks
    val wrongPk = ByteArray(32) { 0xff.toByte() }
    val tampered = recs.toMutableList().apply { this[2] = "did:dns:pk;kty=ed25519;pk=${base64UrlEncode(wrongPk)}" }
    val broken = parseDidDnsIdentity(tampered)
    check(broken != null && !broken!!.fingerprintChainOk()) { "tampered pk breaks chain" }

    // Missing pk -> null
    check(parseDidDnsIdentity(listOf(recs[1])) == null) { "missing pk -> null" }
    // No did:dns -> null
    check(parseDidDnsIdentity(listOf("v=spf1 -all", "id=foo;key=bar")) == null) { "no did:dns -> null" }
    // RSA kty -> invalid
    val rsa = parseDidDnsIdentity(listOf(recs[1], "did:dns:pk;kty=rsa;pk=$pkB64"))
    check(rsa!!.keyType == "rsa" && !rsa.isValid(now)) { "rsa kty rejected" }

    // v1 legacy parser still works
    val p = parseTxt("""{"http":8080,"https":8443}""")
    check(p != null && p!!.http == 8080 && p.https == 8443) { "v1 parse" }
    check(parseTxt("{}") == null) { "v1 empty" }
    check(parseTxt("not json") == null) { "v1 not json" }

    // SRV resolution over network (best-effort; nonexistent -> null, no throw)
    check(resolveService("nonexistent.invalid", "ws") == null) { "nonexistent SRV null" }
    // Unknown service throws
    var threw = false
    try { resolveService("example.com", "wss") } catch (_: IllegalArgumentException) { threw = true }
    check(threw) { "unknown service should throw" }

    println("KirinDns Kotlin self-test: PASSED (incl. did:dns fingerprint chain)")
}
