package app.archivist.tv

import android.os.Build
import android.webkit.JavascriptInterface
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors

/**
 * `window.ArchivistAndroid` — what the pages can ask of the app.
 *
 * Two kinds of page use it: the bundled server picker, which manages servers,
 * and the connected server's Player, which can only ask to switch server,
 * leave the app, or keep the screen awake. Every call checks which of the two
 * is on screen, so nothing else a WebView might end up showing can reach it.
 *
 * Calls arrive on the WebView's binder thread. Anything slow goes to
 * [worker]; answers go back to the page through [WebPlayerActivity.deliver].
 */
class ShellBridge(private val activity: WebPlayerActivity, private val store: ServerStore) {
    private val worker = Executors.newCachedThreadPool()
    @Volatile private var discovery: Discovery? = null
    @Volatile private var connectAttempt: String? = null

    // ── Server picker ────────────────────────────────────────────────────────

    @JavascriptInterface
    fun getState(): String {
        if (!activity.isSetupPage()) return "{}"
        val servers = JSONArray()
        store.all().sortedByDescending { it.lastUsedAt }.forEach { servers.put(it.toJson()) }
        val launch = activity.consumeLaunch()
        return JSONObject()
            .put("servers", servers)
            .put("lastServerId", store.lastServerId ?: JSONObject.NULL)
            .put("autoConnect", launch.autoConnect)
            .put("error", launch.error?.let { JSONObject().put("serverId", it.serverId).put("message", it.message) } ?: JSONObject.NULL)
            .put("appVersion", BuildConfig.VERSION_NAME)
            .put("device", Build.MODEL ?: "Android TV")
            .put("fireTv", activity.isFireTv)
            .toString()
    }

    @JavascriptInterface
    fun saveServer(json: String): String {
        if (!activity.isSetupPage()) return "{}"
        // A new server arrives without an id; fromJson assigns one.
        return store.save(Server.fromJson(JSONObject(json))).toJson().toString()
    }

    @JavascriptInterface
    fun removeServer(id: String) {
        if (activity.isSetupPage()) store.remove(id)
    }

    @JavascriptInterface
    fun probe(requestId: String, url: String) {
        if (!activity.isSetupPage()) return
        val clean = Server.cleanUrl(url)
        worker.execute {
            val result = if (clean.isEmpty()) ProbeResult(false, 0, "Not a valid address") else ServerProbe.probe(clean, 5_000)
            activity.deliver(JSONObject().put("type", "probe").put("requestId", requestId).put("result", result.toJson()))
        }
    }

    @JavascriptInterface
    fun discover(requestId: String) {
        if (!activity.isSetupPage()) return
        discovery?.cancel()
        val sweep = Discovery()
        discovery = sweep
        sweep.start(
            onFound = { host, url, latency ->
                activity.deliver(JSONObject().put("type", "discovered").put("requestId", requestId)
                    .put("server", JSONObject().put("host", host).put("url", url).put("latencyMs", latency)))
            },
            onDone = { activity.deliver(JSONObject().put("type", "discoveryDone").put("requestId", requestId)) },
        )
    }

    @JavascriptInterface
    fun stopDiscovery() {
        discovery?.cancel()
        discovery = null
    }

    /**
     * Tries the server's home address, then its away address, and opens the
     * Player on the first that answers. Progress and failure are reported to
     * the page; success replaces the page.
     */
    @JavascriptInterface
    fun connect(requestId: String, serverId: String) {
        if (!activity.isSetupPage()) return
        connectAttempt = requestId
        val server = store.find(serverId)
        if (server == null) {
            activity.deliver(JSONObject().put("type", "connectFailed").put("requestId", requestId).put("attempts", JSONArray()))
            return
        }
        worker.execute {
            val attempts = JSONArray()
            val candidates = listOf("home" to server.homeUrl, "away" to server.awayUrl).filter { it.second.isNotEmpty() }
            for ((via, url) in candidates) {
                if (connectAttempt != requestId) return@execute
                activity.deliver(JSONObject().put("type", "connectProgress").put("requestId", requestId).put("via", via).put("url", url))
                // The home address either answers quickly or is not there; the
                // away one may be a slow mobile hop, so it gets longer.
                val result = ServerProbe.probe(url, if (via == "home") 2_500 else 8_000)
                if (connectAttempt != requestId) return@execute
                if (result.ok) {
                    store.markUsed(server.id)
                    activity.openServer(ActiveServer(server, url, via))
                    return@execute
                }
                attempts.put(JSONObject().put("via", via).put("url", url).put("error", result.error))
            }
            if (connectAttempt == requestId) {
                activity.deliver(JSONObject().put("type", "connectFailed").put("requestId", requestId).put("attempts", attempts))
            }
        }
    }

    @JavascriptInterface
    fun cancelConnect() {
        connectAttempt = null
    }

    // ── Either page ──────────────────────────────────────────────────────────

    @JavascriptInterface
    fun exitApp() {
        if (activity.isSetupPage() || activity.isServerPage()) activity.runOnUiThread { activity.finishAndRemoveTask() }
    }

    // ── The connected Player ─────────────────────────────────────────────────

    @JavascriptInterface
    fun switchServer() {
        if (activity.isServerPage()) activity.runOnUiThread { activity.showSetup() }
    }

    @JavascriptInterface
    fun serverInfo(): String {
        val active = activity.activeServer ?: return "null"
        if (!activity.isServerPage()) return "null"
        return JSONObject()
            .put("name", active.server.name)
            .put("url", active.url)
            .put("via", active.via)
            .put("appVersion", BuildConfig.VERSION_NAME)
            .toString()
    }

    @JavascriptInterface
    fun isTelevision(): Boolean = activity.isServerPage() && activity.isTelevision

    @JavascriptInterface
    fun setKeepAwake(on: Boolean) {
        if (activity.isServerPage()) activity.runOnUiThread { activity.keepScreenOn(on) }
    }

    fun shutdown() {
        discovery?.cancel()
        worker.shutdownNow()
    }
}
