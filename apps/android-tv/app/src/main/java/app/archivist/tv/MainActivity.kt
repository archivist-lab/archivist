package app.archivist.tv

import android.content.Intent
import android.os.Bundle
import android.view.View
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import app.archivist.tv.api.ArchivistApi
import app.archivist.tv.api.PlaybackPrefs
import app.archivist.tv.api.ArcadeRom
import app.archivist.tv.api.ArcadeSystem
import app.archivist.tv.retro.GameActivity
import app.archivist.tv.player.PlaybackActivity
import app.archivist.tv.player.QueueItem
import app.archivist.tv.ui.ArchivistTheme
import app.archivist.tv.ui.LocalImageLoader
import app.archivist.tv.ui.Notice
import app.archivist.tv.ui.Palette
import app.archivist.tv.ui.SetupScreen
import app.archivist.tv.ui.Shell
import coil3.ImageLoader
import coil3.network.okhttp.OkHttpNetworkFetcherFactory
import coil3.request.crossfade

/**
 * The native app: server picker, browsing, item pages and playback, drawn
 * with Compose for TV and played with ExoPlayer. The web Player is still one
 * press away in Settings, for the parts of the library not yet native.
 */
class MainActivity : ComponentActivity() {
    private val store by lazy { ServerStore(this) }
    private val session by lazy { Session(this) }
    /** Bumped each time the app comes back to the front — after playback, say — so screens refresh progress. */
    private var resumed by mutableIntStateOf(0)
    private var connection: Connection? = null
    private var prefs: PlaybackPrefs? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { ArchivistTheme { App() } }
    }

    override fun onResume() {
        super.onResume()
        hideSystemBars()
        resumed++
    }

    @Composable
    private fun App() {
        var active by remember { mutableStateOf<Connection?>(null) }
        var booting by remember { mutableStateOf(true) }
        var message by remember { mutableStateOf<String?>(null) }
        val context = LocalContext.current

        // Straight back into the last server, when this TV is already signed in to it.
        LaunchedEffect(Unit) {
            val last = store.lastServerId?.let(store::find)
            val token = last?.let { session.token(it.id) }
            if (last != null && token != null) {
                val reached = session.reach(last)
                if (reached != null) {
                    val api = ArchivistApi(reached.first, token)
                    if (runCatching { api.authStatus().authenticated }.getOrDefault(false)) {
                        active = Connection(last, reached.first, reached.second, api)
                    } else message = "Sign in to ${last.name} again"
                } else message = "Can’t reach ${last.name}"
            }
            booting = false
        }
        LaunchedEffect(active) {
            connection = active
            prefs = active?.let { runCatching { it.api.bootstrap().prefs }.getOrNull() }
        }

        val current = active
        when {
            booting -> Box(Modifier.fillMaxSize().background(Palette.canvas)) { Notice("Opening the archive…") }
            current == null -> SetupScreen(store, session, message) { active = it; message = null }
            else -> {
                val loader = remember(current) {
                    ImageLoader.Builder(context)
                        .components { add(OkHttpNetworkFetcherFactory(callFactory = { current.api.http })) }
                        .crossfade(true)
                        .build()
                }
                CompositionLocalProvider(LocalImageLoader provides loader) {
                    Shell(
                        connection = current,
                        refresh = resumed,
                        onPlay = ::play,
                        onGame = ::playGame,
                        onSwitchServer = { active = null },
                        onSignOut = { session.clearToken(current.server.id); message = "Signed out of ${current.server.name}"; active = null },
                        onWebPlayer = { openWebPlayer(current) },
                    )
                }
            }
        }
    }

    private fun play(queue: List<QueueItem>, index: Int) {
        val current = connection ?: return
        startActivity(Intent(this, PlaybackActivity::class.java)
            .putExtra(PlaybackActivity.EXTRA_URL, current.url)
            .putExtra(PlaybackActivity.EXTRA_TOKEN, session.token(current.server.id))
            .putExtra(PlaybackActivity.EXTRA_QUEUE, QueueItem.encode(queue))
            .putExtra(PlaybackActivity.EXTRA_INDEX, index)
            .putExtra(PlaybackActivity.EXTRA_AUDIO_LANGUAGE, prefs?.audioLanguage)
            .putExtra(PlaybackActivity.EXTRA_SUBTITLE_LANGUAGE, prefs?.subtitleLanguage)
            .putExtra(PlaybackActivity.EXTRA_SUBTITLE_MODE, prefs?.subtitles))
    }

    private fun playGame(system: ArcadeSystem, rom: ArcadeRom) {
        val current = connection ?: return
        if (!system.biosReady) {
            android.widget.Toast.makeText(this, "${system.label} needs a BIOS: put it in media/roms/${system.id}/bios on the server", android.widget.Toast.LENGTH_LONG).show()
            return
        }
        startActivity(Intent(this, GameActivity::class.java)
            .putExtra(GameActivity.EXTRA_URL, current.url)
            .putExtra(GameActivity.EXTRA_TOKEN, session.token(current.server.id))
            .putExtra(GameActivity.EXTRA_SYSTEM, system.id)
            .putExtra(GameActivity.EXTRA_CORE, system.core)
            .putExtra(GameActivity.EXTRA_TITLE, rom.name)
            .putExtra(GameActivity.EXTRA_ROM_FILE, rom.file)
            .putExtra(GameActivity.EXTRA_ROM_URL, rom.url)
            .putExtra(GameActivity.EXTRA_BIOS_URL, system.biosUrl))
    }

    private fun openWebPlayer(current: Connection) {
        startActivity(Intent(this, WebPlayerActivity::class.java)
            .putExtra(WebPlayerActivity.EXTRA_SERVER_ID, current.server.id)
            .putExtra(WebPlayerActivity.EXTRA_URL, current.url)
            .putExtra(WebPlayerActivity.EXTRA_VIA, current.via))
    }

    @Suppress("DEPRECATION")
    private fun hideSystemBars() {
        window.decorView.systemUiVisibility = (View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
            or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
            or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION)
    }
}
