package app.archivist.tv

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.app.UiModeManager
import android.content.res.Configuration
import android.util.Log
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.ConsoleMessage
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.Toast
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import java.net.URL

/** The server the Player was opened from, and which of its addresses answered. */
data class ActiveServer(val server: Server, val url: String, val via: String) {
    val origin: String = originOf(url) ?: url
}

/** What the server picker should do when it next loads. */
data class LaunchIntent(val autoConnect: Boolean, val error: LaunchError?)
data class LaunchError(val serverId: String, val message: String)

/**
 * One full-screen WebView, like Jellyfin's Android TV app: first the bundled
 * server picker, then the chosen server's own Player at `/player/`. Because
 * the Player comes from the server, the app always shows exactly the styling
 * and features that server ships.
 *
 * The native side does only what a page cannot: remember servers, probe and
 * discover them, turn the remote's Back and media buttons into keys the page
 * understands, show video full screen, and keep the screen awake.
 */
class WebPlayerActivity : Activity() {
    private lateinit var root: FrameLayout
    private lateinit var webView: WebView
    private lateinit var store: ServerStore
    private lateinit var bridge: ShellBridge

    private val assetLoader by lazy {
        WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()
    }

    @Volatile private var pageOrigin: String? = null
    @Volatile var activeServer: ActiveServer? = null
        private set
    @Volatile private var launch = LaunchIntent(autoConnect = true, error = null)

    private var customView: View? = null
    private var customViewCallback: WebChromeClient.CustomViewCallback? = null
    private var clearHistoryOnLoad = false
    private var lastRootBackAt = 0L
    private var tvViewportAtStart = false

    val isFireTv: Boolean by lazy { packageManager.hasSystemFeature("amazon.hardware.fire_tv") }

    /** A television rather than a phone or tablet the app happens to be installed on. */
    val isTelevision: Boolean by lazy {
        isFireTv || packageManager.hasSystemFeature("android.software.leanback") ||
            (getSystemService(UI_MODE_SERVICE) as UiModeManager).currentModeType == Configuration.UI_MODE_TYPE_TELEVISION
    }

    @SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        store = ServerStore(this)
        bridge = ShellBridge(this, store)

        webView = WebView(this).apply {
            setBackgroundColor(CANVAS)
            isFocusable = true
            isFocusableInTouchMode = true
            layoutParams = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        }
        root = FrameLayout(this).apply {
            setBackgroundColor(CANVAS)
            addView(webView)
        }
        setContentView(root)
        hideSystemBars()

        with(webView.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            loadWithOverviewMode = true
            useWideViewPort = true
            builtInZoomControls = false
            displayZoomControls = false
            setSupportZoom(false)
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
            userAgentString = "$userAgentString ArchivistAndroidTV/${BuildConfig.VERSION_NAME}"
        }
        CookieManager.getInstance().setAcceptCookie(true)

        webView.addJavascriptInterface(bridge, "ArchivistAndroid")
        // Before the page's own scripts, where the WebView supports it; older
        // ones get the same script from onPageFinished, one relayout later.
        if (isTelevision && WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(webView, TV_VIEWPORT, setOf("*"))
            tvViewportAtStart = true
        }
        webView.webViewClient = ShellClient()
        webView.webChromeClient = ShellChrome()
        webView.requestFocus()

        // Opened from the native app onto a server it is already connected to:
        // straight to that server's Player, skipping the web server picker.
        val serverId = intent.getStringExtra(EXTRA_SERVER_ID)
        val url = intent.getStringExtra(EXTRA_URL)
        val server = serverId?.let { store.find(it) }
        if (server != null && url != null) openServer(ActiveServer(server, url, intent.getStringExtra(EXTRA_VIA) ?: "home"))
        else showSetup(autoConnect = true)
    }

    // ── Navigation between the picker and a server ───────────────────────────

    fun showSetup(autoConnect: Boolean = false, error: LaunchError? = null) {
        activeServer = null
        launch = LaunchIntent(autoConnect, error)
        keepScreenOn(false)
        clearHistoryOnLoad = true
        webView.loadUrl(SETUP_URL)
    }

    /** Read once by the picker as it loads; later loads start from the list. */
    fun consumeLaunch(): LaunchIntent {
        val current = launch
        launch = LaunchIntent(autoConnect = false, error = null)
        return current
    }

    fun openServer(active: ActiveServer) = runOnUiThread {
        activeServer = active
        clearHistoryOnLoad = true
        webView.loadUrl("${active.url}/player/")
    }

    fun isSetupPage(): Boolean = pageOrigin == SETUP_ORIGIN
    fun isServerPage(): Boolean = activeServer?.let { it.origin == pageOrigin } ?: false

    /** Sends a bridge answer to the picker, and only the picker. */
    fun deliver(message: JSONObject) = runOnUiThread {
        if (isSetupPage()) webView.evaluateJavascript("window.__archivistNative&&window.__archivistNative.receive($message)", null)
    }

    fun keepScreenOn(on: Boolean) {
        if (on) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }

    // ── Remote control ───────────────────────────────────────────────────────

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (event.keyCode == KeyEvent.KEYCODE_BACK) {
            if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) handleBack()
            return true
        }
        val domKey = MEDIA_KEYS[event.keyCode]
        if (domKey != null) {
            if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) sendDomKey(domKey)
            return true
        }
        return super.dispatchKeyEvent(event)
    }

    /**
     * Back becomes Escape, which both pages already treat as "go back". A
     * Player that says it handles its own root (it shows a leave dialog) is
     * left to it; an older Player that does not gets press-twice-to-leave.
     */
    private fun handleBack() {
        if (customView != null) {
            hideCustomView()
            return
        }
        webView.evaluateJavascript(BACK_SCRIPT) { result ->
            if (result == "\"handled\"") return@evaluateJavascript
            val now = System.currentTimeMillis()
            if (now - lastRootBackAt < 2_000) finishAndRemoveTask()
            else {
                lastRootBackAt = now
                Toast.makeText(this, R.string.press_back_again, Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun sendDomKey(key: String) {
        webView.evaluateJavascript(
            "(function(){var t=document.activeElement||document.body||document;" +
                "['keydown','keyup'].forEach(function(n){t.dispatchEvent(new KeyboardEvent(n,{key:'$key',bubbles:true,cancelable:true}))})})()",
            null,
        )
    }

    // ── Lifecycle ────────────────────────────────────────────────────────────

    override fun onResume() {
        super.onResume()
        webView.onResume()
        hideSystemBars()
    }

    override fun onPause() {
        // Leaving the app (Home, a screensaver, another input) pauses video
        // rather than letting it play on unseen.
        webView.evaluateJavascript("document.querySelectorAll('video').forEach(function(v){v.pause()})", null)
        webView.onPause()
        CookieManager.getInstance().flush()
        super.onPause()
    }

    override fun onDestroy() {
        bridge.shutdown()
        root.removeAllViews()
        webView.destroy()
        super.onDestroy()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideSystemBars()
    }

    @Suppress("DEPRECATION")
    private fun hideSystemBars() {
        window.decorView.systemUiVisibility = (View.SYSTEM_UI_FLAG_FULLSCREEN
            or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
            or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
            or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
            or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
            or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION)
    }

    private fun hideCustomView() {
        customViewCallback?.onCustomViewHidden()
        customView?.let { root.removeView(it) }
        customView = null
        customViewCallback = null
        webView.visibility = View.VISIBLE
        webView.requestFocus()
    }

    // ── WebView clients ──────────────────────────────────────────────────────

    private inner class ShellClient : WebViewClient() {
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
            assetLoader.shouldInterceptRequest(request.url)

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            if (!request.isForMainFrame) return false
            val origin = originOf(request.url.toString())
            if (origin == SETUP_ORIGIN || origin == activeServer?.origin) return false
            // Anything else (a link out to IMDb, say) is not Archivist: hand it
            // to whatever the device has, and never load it here beside the bridge.
            try {
                startActivity(Intent(Intent.ACTION_VIEW, request.url))
            } catch (_: ActivityNotFoundException) {
                Toast.makeText(this@WebPlayerActivity, request.url.host ?: request.url.toString(), Toast.LENGTH_SHORT).show()
            }
            return true
        }

        override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
            pageOrigin = originOf(url)
        }

        override fun onPageFinished(view: WebView, url: String) {
            if (clearHistoryOnLoad) {
                clearHistoryOnLoad = false
                view.clearHistory()
            }
            if (isServerPage()) {
                if (isTelevision && !tvViewportAtStart) view.evaluateJavascript(TV_VIEWPORT, null)
                view.evaluateJavascript(PLAYER_SHIM, null)
            }
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (!request.isForMainFrame) return
            val active = activeServer ?: return
            if (originOf(request.url.toString()) != active.origin) return
            showSetup(error = LaunchError(active.server.id, "Lost ${active.server.name}: ${error.description}"))
        }

        override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
            if (!request.isForMainFrame || response.statusCode < 400) return
            val active = activeServer ?: return
            if (originOf(request.url.toString()) != active.origin) return
            val hint = if (response.statusCode == 404) " — does this server include the Player?" else ""
            showSetup(error = LaunchError(active.server.id, "${active.server.name} answered HTTP ${response.statusCode}$hint"))
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            // The page's renderer died (usually memory on a small stick).
            // Start over cleanly rather than crash with it.
            Log.w(TAG, "WebView renderer gone, crashed=${if (Build.VERSION.SDK_INT >= 26) detail.didCrash() else "?"}")
            root.removeAllViews()
            webView.destroy()
            recreate()
            return true
        }
    }

    private inner class ShellChrome : WebChromeClient() {
        override fun onShowCustomView(view: View, callback: CustomViewCallback) {
            if (customView != null) {
                callback.onCustomViewHidden()
                return
            }
            customView = view
            customViewCallback = callback
            view.setBackgroundColor(Color.BLACK)
            root.addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            webView.visibility = View.GONE
            hideSystemBars()
        }

        override fun onHideCustomView() = hideCustomView()

        /** Without this, WebView paints a grey "play" poster over every video before it starts. */
        override fun getDefaultVideoPoster(): Bitmap = Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888)

        override fun onPermissionRequest(request: PermissionRequest) = request.deny()

        override fun onConsoleMessage(message: ConsoleMessage): Boolean {
            if (BuildConfig.DEBUG) Log.d(TAG, "${message.sourceId()}:${message.lineNumber()} ${message.message()}")
            return true
        }
    }

    companion object {
        const val EXTRA_SERVER_ID = "serverId"
        const val EXTRA_URL = "url"
        const val EXTRA_VIA = "via"
        private const val TAG = "ArchivistTV"
        private const val CANVAS = 0xFF0A0A0F.toInt()
        const val SETUP_ORIGIN = "https://appassets.androidplatform.net"
        const val SETUP_URL = "$SETUP_ORIGIN/assets/setup/index.html"

        private val MEDIA_KEYS = mapOf(
            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE to "MediaPlayPause",
            KeyEvent.KEYCODE_MEDIA_PLAY to "MediaPlay",
            KeyEvent.KEYCODE_MEDIA_PAUSE to "MediaPause",
            KeyEvent.KEYCODE_MEDIA_FAST_FORWARD to "MediaFastForward",
            KeyEvent.KEYCODE_MEDIA_REWIND to "MediaRewind",
            KeyEvent.KEYCODE_MEDIA_STOP to "MediaStop",
            KeyEvent.KEYCODE_MEDIA_NEXT to "MediaTrackNext",
            KeyEvent.KEYCODE_MEDIA_PREVIOUS to "MediaTrackPrevious",
        )

        /**
         * Decides "root" before sending Escape, so the press that closes a
         * dialog is not also read as a request to leave.
         */
        private val BACK_SCRIPT = """
            (function(){
              var atRoot = window.__archivistHandlesRootBack ? false
                : /\/player\/?$/.test(location.pathname) && !document.querySelector('[role="dialog"][aria-modal="true"], video');
              var t = document.activeElement || document.body || document;
              ['keydown','keyup'].forEach(function(n){
                t.dispatchEvent(new KeyboardEvent(n,{key:'Escape',code:'Escape',keyCode:27,which:27,bubbles:true,cancelable:true}));
              });
              return atRoot ? 'root' : 'handled';
            })()
        """.trimIndent()

        /**
         * Lays the Player out 1920 CSS pixels wide, as a desktop browser at
         * 1080p would, and lets the WebView scale that to the screen.
         *
         * A TV's WebView otherwise reports its density-independent size —
         * 960x540 on a 1080p Fire TV, less on some — and the Player reads a
         * viewport that narrow as a phone or tablet: it leaves its fixed
         * 1920x1080 stage for the flowing layout and draws every tile at full
         * design size, about twice its share of the screen, which is also far
         * more artwork to paint on a small stick. At 1920 it takes the same
         * television layout, and the same 85% presentation zoom, as the desktop.
         *
         * The Player's own viewport tag is rewritten as it is parsed (or
         * created if it has none). Only the connected server's pages; the
         * picker sizes itself from the screen width either way.
         */
        private val TV_VIEWPORT = """
            (function(){
              if (location.hostname === 'appassets.androidplatform.net') return;
              var content = 'width=1920, user-scalable=no';
              var fix = function(){
                var meta = document.querySelector('meta[name="viewport"]');
                if (meta && meta.getAttribute('content') !== content) meta.setAttribute('content', content);
                return !!meta;
              };
              var ensure = function(){
                if (fix() || !document.head) return;
                var meta = document.createElement('meta');
                meta.name = 'viewport'; meta.content = content;
                document.head.appendChild(meta);
              };
              if (document.readyState !== 'loading') { ensure(); return; }
              var watch = new MutationObserver(fix);
              watch.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['content'] });
              document.addEventListener('DOMContentLoaded', function(){ watch.disconnect(); ensure(); });
            })()
        """.trimIndent()

        /** Keeps the screen awake while a video plays — the TV's screensaver otherwise starts mid-film. */
        private val PLAYER_SHIM = """
            (function(){
              if (window.__archivistShell) return;
              window.__archivistShell = true;
              var bridge = window.ArchivistAndroid;
              if (!bridge) return;
              var sync = function(){
                var playing = Array.prototype.some.call(document.querySelectorAll('video'), function(v){ return !v.paused && !v.ended; });
                bridge.setKeepAwake(playing);
              };
              ['playing','pause','ended','emptied'].forEach(function(n){ document.addEventListener(n, sync, true); });
            })()
        """.trimIndent()
    }
}

/** `scheme://host[:port]`, with default ports dropped so comparisons are exact. */
fun originOf(url: String): String? = try {
    val parsed = URL(url)
    val port = if (parsed.port == -1 || parsed.port == parsed.defaultPort) "" else ":${parsed.port}"
    "${parsed.protocol}://${parsed.host.lowercase()}$port"
} catch (_: Exception) {
    null
}
