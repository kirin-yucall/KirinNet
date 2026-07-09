/**
 * KirinDNS Resolution Protocol (ADRP) — Kotlin Client
 *
 * Resolves service port mappings from DNS TXT records.
 * Pure Kotlin/JVM — uses java.naming (JNDI DNS).
 *
 * Usage:
 *   val ports = KirinDns.resolve("alice.kirinnet.org")
 *   println("HTTP: ${ports.http}")
 */

package kirinnet

import java.util.*
import javax.naming.directory.InitialDirContext

/** Recognized ADRP keys. */
private val RECOGNIZED = setOf("http", "https", "ws", "wss")

/** Resolved service ports. */
data class KirinPorts(
    val http: Int = 80,
    val https: Int = 443,
    val ws: Int = 80,
    val wss: Int = 443
) {
    companion object {
        val FALLBACK = KirinPorts()
    }
}

object KirinDns {

    /**
     * Resolve KirinDNS ports for a domain.
     * Returns fallback ports if no valid ADRP TXT record exists.
     */
    fun resolve(domain: String): KirinPorts {
        val ports = KirinPorts.FALLBACK

        try {
            val env = Hashtable<String, String>().apply {
                put("java.naming.factory.initial", "com.sun.jndi.dns.DnsContextFactory")
                put("java.naming.provider.url", "dns://")
            }
            val ctx = InitialDirContext(env)
            val attrs = ctx.getAttributes(domain, arrayOf("TXT"))
            val txtAttr = attrs.get("TXT") ?: return ports

            for (i in 0 until txtAttr.size()) {
                val txt = txtAttr.get(i).toString()
                val parsed = parseTxt(txt)
                if (parsed != null) return parsed
            }
        } catch (_: Exception) {
            // NXDOMAIN, no TXT → fallback
        }

        return ports
    }

    /**
     * Parse a TXT record string as ADRP JSON.
     * Returns null if not a valid ADRP record.
     */
    fun parseTxt(txt: String?): KirinPorts? {
        if (txt.isNullOrBlank()) return null
        val trimmed = txt.trim()
        if (!trimmed.startsWith("{")) return null

        var http = 0
        var https = 0
        var ws = 0
        var wss = 0
        var found = 0

        // Minimal JSON parser for ADRP's constrained format
        for (key in RECOGNIZED) {
            val search = "\"$key\":"
            var idx = trimmed.indexOf(search)
            if (idx < 0) continue

            idx += search.length
            // Skip whitespace
            while (idx < trimmed.length && (trimmed[idx] == ' ' || trimmed[idx] == '\t')) idx++

            // Parse integer
            val end = (idx until trimmed.length).firstOrNull { !trimmed[it].isDigit() }
                ?: trimmed.length
            if (end == idx) continue

            val numStr = trimmed.substring(idx, end)
            val num = numStr.toIntOrNull() ?: continue
            if (num < 1 || num > 65535) return null

            when (key) {
                "http"  -> http = num
                "https" -> https = num
                "ws"    -> ws = num
                "wss"   -> wss = num
            }
            found++
        }

        if (found == 0) return null

        return KirinPorts(
            http  = if (http  > 0) http  else 80,
            https = if (https > 0) https else 443,
            ws    = if (ws    > 0) ws    else 80,
            wss   = if (wss   > 0) wss   else 443
        )
    }
}

// ---- self-test (run: kotlin KirinDns.kt -include-runtime -d test.jar) ----
fun main() {
    // Parse tests
    val p = KirinDns.parseTxt("""{"http":8080,"https":8443}""")
    check(p != null) { "valid parse" }
    check(p!!.http == 8080) { "http" }
    check(p.https == 8443) { "https" }
    check(p.ws == 80) { "ws fallback" }
    check(p.wss == 443) { "wss fallback" }

    check(KirinDns.parseTxt("{}") == null) { "empty" }
    check(KirinDns.parseTxt("""{"http":0}""") == null) { "port zero" }
    check(KirinDns.parseTxt("not json") == null) { "not json" }

    // Resolution test
    val ports = KirinDns.resolve("nonexistent.invalid")
    check(ports.http == 80) { "fallback http" }
    check(ports.https == 443) { "fallback https" }

    println("KirinDns Kotlin self-test: PASSED")
}
