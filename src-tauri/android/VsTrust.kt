package com.vibesquad.desktop

// Host-scoped CA pin for the paired PC (PLAN_ANDROID_MESHNET.md A2). Copied into the generated Android project by
// server/build-android.mjs; the hooks that call it (RustWebViewClient.onReceivedSslError, RustWebView init) are passed
// to wry as class-extension / class-init env (see androidTrustKotlinEnv there).
//
// Why this and not a blanket SSL bypass or a user CA: the desktop serves HTTPS with its own VS CA, which is only known
// at pairing. The QR carries the CA's SHA-256. At pairing we fetch /ca.crt (any TLS: the body is authenticated by the
// fingerprint, not the channel), require sha256(DER) to match, and store that CA for exactly that host:port. A TLS
// error is then accepted only when it comes from a pinned host AND the leaf is within validity, not a CA, issued by
// the pinned CA (signature checked), and names that host in its SAN. Any other host or certificate stays an error.

import android.content.Context
import android.net.Uri
import android.net.http.SslCertificate
import android.net.http.SslError
import android.os.Build
import android.util.Base64
import android.webkit.CookieManager
import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.net.InetAddress
import java.net.URL
import java.security.KeyStore
import java.security.MessageDigest
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

object VsTrust {
    private const val PREFS = "vs_trust"
    private const val BRIDGE = "VsTrust"
    // The app's own origin only: a page served by the paired PC (https://<host>) can never reach the bridge.
    private val APP_ORIGINS = setOf("http://tauri.localhost", "https://tauri.localhost")
    private const val MAX_CA_BYTES = 64 * 1024
    private const val MAX_STATUS_BYTES = 64 * 1024
    private const val FLUSH_EVERY_MS = 3000L

    /** `host:port` (host without IPv6 brackets, lowercase) or null. */
    fun key(authority: String): String? {
        val t = authority.trim().lowercase()
        val m = Regex("^(\\[[0-9a-f:]+]|[a-z0-9][a-z0-9.-]*)(?::(\\d{1,5}))?$").matchEntire(t) ?: return null
        val port = m.groupValues[2].ifEmpty { "4180" }.toInt()
        if (port !in 1..65535) return null
        return "${m.groupValues[1].removePrefix("[").removeSuffix("]")}:$port"
    }

    /** URL authority for a normalized key: IPv6 literals get their brackets back. */
    private fun urlAuthority(key: String): String {
        val i = key.lastIndexOf(':')
        val host = key.substring(0, i)
        return (if (host.contains(':')) "[$host]" else host) + key.substring(i)
    }

    private fun prefs(c: Context) = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun parseCert(bytes: ByteArray): X509Certificate =
        CertificateFactory.getInstance("X.509").generateCertificate(ByteArrayInputStream(bytes)) as X509Certificate

    private fun sha256Hex(b: ByteArray) = MessageDigest.getInstance("SHA-256").digest(b).joinToString("") { "%02x".format(it) }

    private fun loadCa(c: Context, key: String): X509Certificate? =
        prefs(c).getString("ca:$key", null)?.let { runCatching { parseCert(Base64.decode(it, Base64.NO_WRAP)) }.getOrNull() }

    // ---- pairing: fetch + verify + pin ----

    private fun fetchCa(key: String): ByteArray {
        val acceptAny = object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) {}
            override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {}
            override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
        }
        val ctx = SSLContext.getInstance("TLS").apply { init(null, arrayOf(acceptAny), null) }
        val conn = URL("https://${urlAuthority(key)}/ca.crt").openConnection() as HttpsURLConnection
        // Deliberately unauthenticated channel, used for this one GET only: the body is checked against the QR fingerprint.
        conn.sslSocketFactory = ctx.socketFactory
        conn.hostnameVerifier = HostnameVerifier { _, _ -> true }
        conn.connectTimeout = 6000
        conn.readTimeout = 8000
        conn.instanceFollowRedirects = false
        try {
            if (conn.responseCode != 200) throw IllegalStateException("PC answered ${conn.responseCode} for its CA")
            val buf = java.io.ByteArrayOutputStream()
            conn.inputStream.use { ins ->
                val chunk = ByteArray(4096)
                while (true) {
                    val n = ins.read(chunk)
                    if (n < 0) break
                    buf.write(chunk, 0, n)
                    if (buf.size() > MAX_CA_BYTES) throw IllegalStateException("CA too large")
                }
            }
            return buf.toByteArray()
        } finally {
            conn.disconnect()
        }
    }

    /** Pins the host's CA when its SHA-256 starts with [fpHex] (16-64 hex). Returns the full fingerprint. */
    fun pin(c: Context, authority: String, fpHex: String): String {
        val key = key(authority) ?: throw IllegalArgumentException("not a valid server address")
        val want = fpHex.lowercase().replace(Regex("[:\\s-]"), "")
        if (!Regex("^[0-9a-f]{16,64}$").matches(want)) throw IllegalArgumentException("invalid CA fingerprint")
        val ca = parseCert(fetchCa(key))
        val got = sha256Hex(ca.encoded)
        if (!got.startsWith(want)) throw SecurityException("CA fingerprint mismatch: this is not the PC the QR / fingerprint came from")
        if (ca.basicConstraints < 0) throw SecurityException("CA fingerprint matched but the certificate is not a CA")
        ca.checkValidity()
        ca.verify(ca.publicKey)
        prefs(c).edit().putString("ca:$key", Base64.encodeToString(ca.encoded, Base64.NO_WRAP)).apply()
        return got
    }

    fun forget(c: Context, authority: String) {
        val key = key(authority) ?: return
        prefs(c).edit().remove("ca:$key").apply()
    }

    /**
     * TLS reachability to a pinned host, validated against its pinned CA (default hostname verification), and whether the PC
     * still recognizes this phone: /api/auth/status is asked with the WebView's vs_device cookie and answers `paired`.
     * Throws "unpaired" on `paired:false`; a PC that doesn't report `paired` (older build) counts as reachable only.
     */
    fun probe(c: Context, authority: String) {
        val key = key(authority) ?: throw IllegalArgumentException("not a valid server address")
        val ca = loadCa(c, key) ?: throw SecurityException("this PC is not pinned: pair again")
        val ks = KeyStore.getInstance(KeyStore.getDefaultType()).apply { load(null, null); setCertificateEntry("vs-ca", ca) }
        val tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply { init(ks) }
        val ctx = SSLContext.getInstance("TLS").apply { init(null, tmf.trustManagers, null) }
        val base = "https://${urlAuthority(key)}"
        val conn = URL("$base/api/auth/status").openConnection() as HttpsURLConnection
        conn.sslSocketFactory = ctx.socketFactory
        conn.connectTimeout = 5000
        conn.readTimeout = 5000
        conn.instanceFollowRedirects = false
        CookieManager.getInstance().getCookie("$base/")?.let { conn.setRequestProperty("Cookie", it) }
        try {
            if (conn.responseCode != 200) return // handshake + any HTTP answer = reachable and trusted
            val text = conn.inputStream.use { String(it.readBytes().take(MAX_STATUS_BYTES).toByteArray(), Charsets.UTF_8) }
            val paired = runCatching { JSONObject(text).opt("paired") }.getOrNull()
            if (paired == false) throw SecurityException("unpaired: this PC no longer recognizes this phone")
        } finally {
            conn.disconnect()
        }
    }

    // ---- WebView: accept a certificate error only for a pinned host whose leaf chains to the pinned CA ----

    private fun leafOf(cert: SslCertificate): X509Certificate? {
        if (Build.VERSION.SDK_INT >= 29) cert.x509Certificate?.let { return it }
        val der = SslCertificate.saveState(cert).getByteArray("x509-certificate") ?: return null
        return runCatching { parseCert(der) }.getOrNull()
    }

    private fun isIpLiteral(h: String) = Regex("^[0-9.]+$").matches(h) || h.contains(':')

    private fun hostMatches(leaf: X509Certificate, host: String): Boolean {
        val sans = leaf.subjectAlternativeNames ?: return false
        val ip = isIpLiteral(host)
        for (e in sans) {
            val type = e[0] as Int
            val v = e[1] as? String ?: continue
            if (ip && type == 7) {
                if (runCatching { InetAddress.getByName(v) == InetAddress.getByName(host) }.getOrDefault(false)) return true
            } else if (!ip && type == 2) {
                val s = v.lowercase()
                if (s == host) return true
                if (s.startsWith("*.") && host.contains('.') && host.substringAfter('.') == s.substring(2)) return true
            }
        }
        return false
    }

    /** True only for a pinned host whose certificate really chains to the pinned CA. Never for anything else. */
    fun allow(c: Context, error: SslError): Boolean = try {
        val uri = Uri.parse(error.url)
        val host = (uri.host ?: "").lowercase().removePrefix("[").removeSuffix("]")
        val key = key("${if (host.contains(':')) "[$host]" else host}:${if (uri.port > 0) uri.port else 443}")
        val ca = key?.let { loadCa(c, it) }
        val leaf = leafOf(error.certificate)
        if (uri.scheme != "https" || key == null || ca == null || leaf == null) {
            false
        } else {
            leaf.checkValidity()
            leaf.basicConstraints < 0 &&
                leaf.issuerX500Principal == ca.subjectX500Principal &&
                !leaf.encoded.contentEquals(ca.encoded) &&
                runCatching { leaf.verify(ca.publicKey); true }.getOrDefault(false) &&
                hostMatches(leaf, host)
        }
    } catch (_: Exception) {
        false
    }

    // ---- cookies ----

    /** Accept cookies and write them to disk now (WebView otherwise flushes lazily), so vs_device survives the pair redirect. */
    fun persistCookies() {
        val cm = CookieManager.getInstance()
        cm.setAcceptCookie(true)
        cm.flush()
    }

    // ---- JS bridge (app origin only) ----

    fun install(webView: WebView) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return // fail closed: no pairing possible
        val app = webView.context.applicationContext
        // vs_device (HttpOnly, Secure, Strict) is set on the /pair response; make sure the WebView keeps it across restarts.
        persistCookies()
        // The PC sets vs_device while a page of its own is loading (no bridge there, and the generated WebViewClient can't be
        // hooked), so write cookies to disk on a short timer for as long as the WebView lives.
        val tick = object : Runnable {
            override fun run() {
                if (!webView.isAttachedToWindow) return
                CookieManager.getInstance().flush()
                webView.postDelayed(this, FLUSH_EVERY_MS)
            }
        }
        webView.addOnAttachStateChangeListener(object : android.view.View.OnAttachStateChangeListener {
            override fun onViewAttachedToWindow(v: android.view.View) { v.removeCallbacks(tick); v.postDelayed(tick, FLUSH_EVERY_MS) }
            override fun onViewDetachedFromWindow(v: android.view.View) { v.removeCallbacks(tick) }
        })
        WebViewCompat.addWebMessageListener(webView, BRIDGE, APP_ORIGINS) { _, message: WebMessageCompat, _, isMainFrame, reply ->
            val data = message.data
            if (isMainFrame && data != null) handle(app, data, reply)
        }
    }

    private fun handle(app: Context, raw: String, reply: JavaScriptReplyProxy) {
        val req = runCatching { JSONObject(raw) }.getOrNull() ?: return
        val id = req.optInt("id", -1)
        Thread {
            val out = JSONObject().put("id", id)
            try {
                val host = req.optString("host")
                when (req.optString("op")) {
                    "pin" -> out.put("fp", pin(app, host, req.optString("fp")))
                    "probe" -> probe(app, host)
                    "forget" -> forget(app, host)
                    "flush" -> persistCookies() // the app calls this on the #paired return trip, after the PC set vs_device
                    else -> throw IllegalArgumentException("unknown op")
                }
                out.put("ok", true)
            } catch (e: Exception) {
                out.put("ok", false).put("error", e.message ?: e.javaClass.simpleName)
            }
            reply.postMessage(out.toString())
        }.start()
    }
}
