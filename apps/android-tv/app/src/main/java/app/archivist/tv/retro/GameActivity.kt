package app.archivist.tv.retro

import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.util.TypedValue
import android.view.Gravity
import android.view.InputDevice
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.core.content.res.ResourcesCompat
import androidx.lifecycle.lifecycleScope
import app.archivist.tv.R
import app.archivist.tv.api.ArchivistApi
import com.swordfish.libretrodroid.GLRetroView
import com.swordfish.libretrodroid.GLRetroViewData
import com.swordfish.libretrodroid.ShaderConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.Request
import java.io.File

/**
 * A retro game, played natively: the system's libretro core (bundled in the
 * APK) runs through LibretroDroid on the television's own CPU and GPU, where
 * the web Player runs the same cores compiled to WebAssembly.
 *
 * The ROM is fetched from the server's arcade folder into the app's cache, with
 * the tracks a `.cue` names and the system's BIOS where it needs one. Battery
 * saves are kept per game and restored on the next start; Back opens a menu
 * with a quick save state, a load, a reset and quit.
 *
 * Controls: a gamepad works as it is. On the remote, the D-pad is the D-pad,
 * OK is A, Rewind is B, Fast forward is Y, Play/Pause is Start and Menu is
 * Select.
 */
class GameActivity : ComponentActivity() {
    private lateinit var api: ArchivistApi
    private lateinit var root: FrameLayout
    private lateinit var status: TextView
    private lateinit var menu: LinearLayout
    private var retro: GLRetroView? = null
    private lateinit var systemId: String
    private lateinit var romName: String
    private val ports = mutableMapOf<Int, Int>()

    private val saves by lazy { File(filesDir, "retro/saves/$systemId").apply { mkdirs() } }
    private val states by lazy { File(filesDir, "retro/states/$systemId").apply { mkdirs() } }
    private val system by lazy { File(filesDir, "retro/system/$systemId").apply { mkdirs() } }
    private val sramFile get() = File(saves, "$romName.srm")
    private val stateFile get() = File(states, "$romName.state")

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        api = ArchivistApi(intent.getStringExtra(EXTRA_URL)!!, intent.getStringExtra(EXTRA_TOKEN))
        systemId = intent.getStringExtra(EXTRA_SYSTEM)!!
        val romFile = intent.getStringExtra(EXTRA_ROM_FILE)!!
        val romUrl = intent.getStringExtra(EXTRA_ROM_URL)!!
        romName = romFile.substringBeforeLast('.')
        val core = Cores.libraryFor(intent.getStringExtra(EXTRA_CORE) ?: "")

        status = TextView(this).apply {
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 18f)
            typeface = ResourcesCompat.getFont(this@GameActivity, R.font.dm_sans_medium)
            gravity = Gravity.CENTER
        }
        menu = buildMenu()
        root = FrameLayout(this).apply {
            setBackgroundColor(Color.BLACK)
            addView(status, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            addView(menu, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER))
        }
        setContentView(root)

        if (core == null) { fail("This system has no native core in the app yet."); return }
        status.text = "Loading ${intent.getStringExtra(EXTRA_TITLE) ?: romName}…"
        lifecycleScope.launch {
            val game = runCatching { fetchGame(romFile, romUrl, intent.getStringExtra(EXTRA_BIOS_URL)) }
            game.onSuccess { start(core, it) }.onFailure { fail("Could not load the game: ${it.message}") }
        }
    }

    // ── Loading ──────────────────────────────────────────────────────────────

    /**
     * The ROM on local storage, downloaded once and kept in the cache. A `.cue`
     * is only an index of a disc's tracks, so the tracks it names come with it;
     * the BIOS goes where the core looks for one, under its own name.
     */
    private suspend fun fetchGame(romFile: String, romUrl: String, biosUrl: String?): File = withContext(Dispatchers.IO) {
        val dir = File(cacheDir, "roms/$systemId").apply { mkdirs() }
        val rom = File(dir, romFile)
        download(romUrl, rom)
        if (romFile.endsWith(".cue", ignoreCase = true)) {
            val base = romUrl.substringBeforeLast('/')
            Regex("FILE\\s+\"([^\"]+)\"", RegexOption.IGNORE_CASE).findAll(rom.readText()).map { it.groupValues[1] }.forEach { track ->
                download("$base/${android.net.Uri.encode(track)}", File(dir, track))
            }
        }
        if (biosUrl != null) {
            val name = android.net.Uri.decode(biosUrl.substringAfterLast('/'))
            val bios = File(system, name)
            download(biosUrl, bios)
            // BIOS sets usually come zipped (psx.zip holds scph5501.bin and its
            // siblings), and a core looks for the files themselves, by name.
            if (name.endsWith(".zip", ignoreCase = true)) unzipInto(bios, system)
        }
        pruneCache(keep = dir)
        rom
    }

    private fun download(path: String, target: File) {
        if (target.exists() && target.length() > 0) return
        val request = Request.Builder().url(api.resolve(path)!!).build()
        api.http.newCall(request).execute().use { response ->
            if (!response.isSuccessful) throw IllegalStateException("the server answered HTTP ${response.code}")
            val body = response.body ?: throw IllegalStateException("empty response")
            val total = body.contentLength()
            val partial = File(target.path + ".part")
            partial.outputStream().use { out ->
                body.byteStream().use { input ->
                    val buffer = ByteArray(256 * 1024)
                    var done = 0L
                    var shown = -1
                    while (true) {
                        val read = input.read(buffer)
                        if (read < 0) break
                        out.write(buffer, 0, read)
                        done += read
                        if (total > 0) {
                            val percent = (done * 100 / total).toInt()
                            if (percent != shown) { shown = percent; runOnUiThread { status.text = "Downloading ${target.name}  $percent%" } }
                        }
                    }
                }
            }
            if (!partial.renameTo(target)) throw IllegalStateException("could not store ${target.name}")
        }
    }

    /** Each file in the zip, flattened into `dir` — once; an existing file is left as it is. */
    private fun unzipInto(zip: File, dir: File) {
        java.util.zip.ZipInputStream(zip.inputStream().buffered()).use { input ->
            while (true) {
                val entry = input.nextEntry ?: break
                val name = entry.name.substringAfterLast('/')
                if (entry.isDirectory || name.isBlank() || name.startsWith(".")) continue
                val target = File(dir, name)
                if (target.exists() && target.length() == entry.size) continue
                target.outputStream().use { input.copyTo(it) }
            }
        }
    }

    /** ROMs are kept for the next play, up to 4 GB; the least recently played go first. */
    private fun pruneCache(keep: File) {
        val all = File(cacheDir, "roms").walkTopDown().filter { it.isFile }.sortedByDescending { it.lastModified() }.toList()
        var used = 0L
        for (file in all) {
            used += file.length()
            if (used > CACHE_LIMIT && file.parentFile != keep) file.delete()
        }
    }

    private fun start(core: String, rom: File) {
        rom.setLastModified(System.currentTimeMillis())
        val corePath = File(applicationInfo.nativeLibraryDir, core).takeIf { it.exists() }?.absolutePath ?: core
        val data = GLRetroViewData(this).apply {
            coreFilePath = corePath
            gameFilePath = rom.absolutePath
            systemDirectory = system.absolutePath
            savesDirectory = saves.absolutePath
            saveRAMState = sramFile.takeIf { it.exists() }?.readBytes()
            shader = ShaderConfig.Default
            rumbleEventsEnabled = false
            preferLowLatencyAudio = true
        }
        val view = GLRetroView(this, data)
        retro = view
        lifecycle.addObserver(view)
        root.addView(view, 0, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        status.visibility = View.GONE
        view.isFocusable = true
        view.requestFocus()
        lifecycleScope.launch {
            view.getGLRetroErrors().collect { code -> fail(errorText(code)) }
        }
    }

    private fun errorText(code: Int) = when (code) {
        GLRetroView.ERROR_LOAD_LIBRARY -> "The emulator core could not start on this TV."
        GLRetroView.ERROR_LOAD_GAME -> "The core could not open this game. It may need a BIOS, or a different dump of the game."
        GLRetroView.ERROR_GL_NOT_COMPATIBLE -> "This TV’s graphics are not supported by this core."
        else -> "The game stopped unexpectedly."
    }

    private fun fail(message: String) {
        retro?.let { root.removeView(it) }
        retro = null
        status.visibility = View.VISIBLE
        status.text = "$message\n\nPress Back to leave."
    }

    // ── Saves ────────────────────────────────────────────────────────────────

    private fun writeSram() {
        val bytes = runCatching { retro?.serializeSRAM() }.getOrNull() ?: return
        if (bytes.isNotEmpty()) runCatching { sramFile.writeBytes(bytes) }
    }

    override fun onPause() {
        writeSram()
        super.onPause()
    }

    // ── The menu Back opens ──────────────────────────────────────────────────

    private fun buildMenu(): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        visibility = View.GONE
        val pad = dp(24)
        setPadding(pad, pad, pad, pad)
        background = GradientDrawable().apply { cornerRadius = dp(16).toFloat(); setColor(0xF01A1C26.toInt()) }
        addView(TextView(context).apply {
            text = "PAUSED"
            setTextColor(0xFF2ECC71.toInt())
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 26f)
            typeface = ResourcesCompat.getFont(context, R.font.bebas_neue_regular)
            setPadding(0, 0, 0, dp(12))
        })
        fun item(label: String, action: () -> Unit) = addView(Button(context).apply {
            text = label
            isAllCaps = true
            typeface = ResourcesCompat.getFont(context, R.font.jetbrains_mono_semibold)
            setOnClickListener { action() }
        }, LinearLayout.LayoutParams(dp(300), ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(6) })
        item("Resume") { hideMenu() }
        item("Save state") {
            runCatching { retro?.serializeState()?.let { stateFile.writeBytes(it) } }
                .onSuccess { toast("State saved") }.onFailure { toast("Could not save state") }
            hideMenu()
        }
        item("Load state") {
            val ok = stateFile.exists() && runCatching { retro?.unserializeState(stateFile.readBytes()) == true }.getOrDefault(false)
            toast(if (ok) "State loaded" else "No saved state yet")
            hideMenu()
        }
        item("Reset") { retro?.reset(); hideMenu() }
        item("Quit") { writeSram(); finish() }
    }

    private fun showMenu() {
        if (retro == null) { finish(); return }
        retro?.onPause()
        menu.visibility = View.VISIBLE
        menu.getChildAt(1)?.requestFocus()
    }

    private fun hideMenu() {
        menu.visibility = View.GONE
        retro?.onResume()
        retro?.requestFocus()
    }

    private fun toast(text: String) = android.widget.Toast.makeText(this, text, android.widget.Toast.LENGTH_SHORT).show()

    // ── Input ────────────────────────────────────────────────────────────────

    /** Which player a controller is: the first one seen is player 1, then 2, 3, 4. */
    private fun portFor(event: android.view.InputEvent): Int {
        val gamepad = (event.source and InputDevice.SOURCE_GAMEPAD) == InputDevice.SOURCE_GAMEPAD ||
            (event.source and InputDevice.SOURCE_JOYSTICK) == InputDevice.SOURCE_JOYSTICK
        if (!gamepad) return 0
        return ports.getOrPut(event.deviceId) { ports.size.coerceAtMost(3) }
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        val view = retro
        if (menu.visibility == View.VISIBLE || view == null) {
            if (event.keyCode == KeyEvent.KEYCODE_BACK && event.action == KeyEvent.ACTION_UP) { if (view == null) finish() else hideMenu() }
            return if (event.keyCode == KeyEvent.KEYCODE_BACK) true else super.dispatchKeyEvent(event)
        }
        // Back, or a gamepad's guide button, pauses into the menu.
        if (event.keyCode == KeyEvent.KEYCODE_BACK || event.keyCode == KeyEvent.KEYCODE_BUTTON_MODE) {
            if (event.action == KeyEvent.ACTION_UP) showMenu()
            return true
        }
        val mapped = REMOTE_KEYS[event.keyCode] ?: event.keyCode
        if (mapped in RETRO_KEYS && event.repeatCount == 0) {
            view.sendKeyEvent(event.action, mapped, portFor(event))
            return true
        }
        return mapped in RETRO_KEYS || super.dispatchKeyEvent(event)
    }

    /** Analogue sticks and a gamepad's hat D-pad. */
    override fun dispatchGenericMotionEvent(event: MotionEvent): Boolean {
        val view = retro ?: return super.dispatchGenericMotionEvent(event)
        if (menu.visibility == View.VISIBLE) return super.dispatchGenericMotionEvent(event)
        if ((event.source and InputDevice.SOURCE_JOYSTICK) != InputDevice.SOURCE_JOYSTICK) return super.dispatchGenericMotionEvent(event)
        val port = portFor(event)
        view.sendMotionEvent(GLRetroView.MOTION_SOURCE_DPAD, event.getAxisValue(MotionEvent.AXIS_HAT_X), event.getAxisValue(MotionEvent.AXIS_HAT_Y), port)
        view.sendMotionEvent(GLRetroView.MOTION_SOURCE_ANALOG_LEFT, event.getAxisValue(MotionEvent.AXIS_X), event.getAxisValue(MotionEvent.AXIS_Y), port)
        view.sendMotionEvent(GLRetroView.MOTION_SOURCE_ANALOG_RIGHT, event.getAxisValue(MotionEvent.AXIS_Z), event.getAxisValue(MotionEvent.AXIS_RZ), port)
        return true
    }

    private fun dp(value: Int) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value.toFloat(), resources.displayMetrics).toInt()

    companion object {
        const val EXTRA_URL = "url"
        const val EXTRA_TOKEN = "token"
        const val EXTRA_SYSTEM = "system"
        const val EXTRA_CORE = "core"
        const val EXTRA_TITLE = "title"
        const val EXTRA_ROM_FILE = "romFile"
        const val EXTRA_ROM_URL = "romUrl"
        const val EXTRA_BIOS_URL = "biosUrl"
        private const val CACHE_LIMIT = 4L * 1024 * 1024 * 1024

        /** The remote as a controller, for playing without a gamepad. */
        private val REMOTE_KEYS = mapOf(
            KeyEvent.KEYCODE_DPAD_CENTER to KeyEvent.KEYCODE_BUTTON_A,
            KeyEvent.KEYCODE_ENTER to KeyEvent.KEYCODE_BUTTON_A,
            KeyEvent.KEYCODE_MEDIA_REWIND to KeyEvent.KEYCODE_BUTTON_B,
            KeyEvent.KEYCODE_MEDIA_FAST_FORWARD to KeyEvent.KEYCODE_BUTTON_Y,
            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE to KeyEvent.KEYCODE_BUTTON_START,
            KeyEvent.KEYCODE_MENU to KeyEvent.KEYCODE_BUTTON_SELECT,
        )

        /** The keys a libretro joypad has. */
        private val RETRO_KEYS = setOf(
            KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_DOWN, KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_DPAD_RIGHT,
            KeyEvent.KEYCODE_BUTTON_A, KeyEvent.KEYCODE_BUTTON_B, KeyEvent.KEYCODE_BUTTON_X, KeyEvent.KEYCODE_BUTTON_Y,
            KeyEvent.KEYCODE_BUTTON_START, KeyEvent.KEYCODE_BUTTON_SELECT,
            KeyEvent.KEYCODE_BUTTON_L1, KeyEvent.KEYCODE_BUTTON_R1, KeyEvent.KEYCODE_BUTTON_L2, KeyEvent.KEYCODE_BUTTON_R2,
            KeyEvent.KEYCODE_BUTTON_THUMBL, KeyEvent.KEYCODE_BUTTON_THUMBR,
        )
    }
}
