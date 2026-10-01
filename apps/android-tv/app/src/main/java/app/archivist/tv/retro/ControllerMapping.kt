package app.archivist.tv.retro

import android.content.Context
import android.view.InputDevice
import android.view.KeyEvent
import org.json.JSONObject

/**
 * A libretro joypad's buttons. Each is sent to the core as the Android key
 * LibretroDroid reads it as, so a physical button is mapped to one of these.
 * The D-pad and the sticks are directions, not buttons, and are not mapped.
 */
enum class RetroButton(val keyCode: Int, val retroName: String) {
    A(KeyEvent.KEYCODE_BUTTON_A, "RetroPad A"),
    B(KeyEvent.KEYCODE_BUTTON_B, "RetroPad B"),
    X(KeyEvent.KEYCODE_BUTTON_X, "RetroPad X"),
    Y(KeyEvent.KEYCODE_BUTTON_Y, "RetroPad Y"),
    L1(KeyEvent.KEYCODE_BUTTON_L1, "RetroPad L"),
    R1(KeyEvent.KEYCODE_BUTTON_R1, "RetroPad R"),
    L2(KeyEvent.KEYCODE_BUTTON_L2, "RetroPad L2"),
    R2(KeyEvent.KEYCODE_BUTTON_R2, "RetroPad R2"),
    L3(KeyEvent.KEYCODE_BUTTON_THUMBL, "RetroPad L3"),
    R3(KeyEvent.KEYCODE_BUTTON_THUMBR, "RetroPad R3"),
    START(KeyEvent.KEYCODE_BUTTON_START, "RetroPad Start"),
    SELECT(KeyEvent.KEYCODE_BUTTON_SELECT, "RetroPad Select"),
}

/** A system's pad as its own buttons are named, each on the RetroPad button its core reads it from. */
data class SystemPad(val systemId: String, val label: String, val buttons: List<Pair<RetroButton, String>>)

/**
 * The buttons of each system the TV plays, by the names on its own pad: a
 * PlayStation's Cross is RetroPad B to its core, a Mega Drive's C is RetroPad
 * A. These follow each bundled core's default layout.
 */
object SystemPads {
    private val playStation = listOf(
        RetroButton.B to "Cross ×", RetroButton.A to "Circle ○", RetroButton.Y to "Square □", RetroButton.X to "Triangle △",
        RetroButton.L1 to "L1", RetroButton.R1 to "R1", RetroButton.L2 to "L2", RetroButton.R2 to "R2",
        RetroButton.L3 to "L3", RetroButton.R3 to "R3", RetroButton.START to "Start", RetroButton.SELECT to "Select",
    )

    val ALL = listOf(
        SystemPad("nes", "NES", listOf(RetroButton.A to "A", RetroButton.B to "B", RetroButton.START to "Start", RetroButton.SELECT to "Select")),
        SystemPad("snes", "SNES", listOf(
            RetroButton.A to "A", RetroButton.B to "B", RetroButton.X to "X", RetroButton.Y to "Y",
            RetroButton.L1 to "L", RetroButton.R1 to "R", RetroButton.START to "Start", RetroButton.SELECT to "Select",
        )),
        SystemPad("gameboy", "Game Boy", listOf(RetroButton.A to "A", RetroButton.B to "B", RetroButton.START to "Start", RetroButton.SELECT to "Select")),
        SystemPad("mastersystem", "Master System", listOf(RetroButton.B to "Button 1", RetroButton.A to "Button 2", RetroButton.START to "Pause")),
        SystemPad("genesis", "Mega Drive / Genesis", listOf(
            RetroButton.Y to "A", RetroButton.B to "B", RetroButton.A to "C",
            RetroButton.L1 to "X", RetroButton.X to "Y", RetroButton.R1 to "Z",
            RetroButton.START to "Start", RetroButton.SELECT to "Mode",
        )),
        SystemPad("n64", "Nintendo 64", listOf(
            RetroButton.B to "A", RetroButton.Y to "B", RetroButton.L2 to "Z",
            RetroButton.L1 to "L", RetroButton.R1 to "R", RetroButton.START to "Start",
        )),
        SystemPad("psx", "PlayStation", playStation),
        SystemPad("saturn", "Saturn", listOf(
            RetroButton.B to "A", RetroButton.A to "B", RetroButton.R1 to "C",
            RetroButton.Y to "X", RetroButton.X to "Y", RetroButton.L1 to "Z",
            RetroButton.L2 to "L", RetroButton.R2 to "R", RetroButton.START to "Start",
        )),
        SystemPad("psp", "PSP", listOf(
            RetroButton.B to "Cross ×", RetroButton.A to "Circle ○", RetroButton.Y to "Square □", RetroButton.X to "Triangle △",
            RetroButton.L1 to "L", RetroButton.R1 to "R", RetroButton.START to "Start", RetroButton.SELECT to "Select",
        )),
    )

    fun of(systemId: String): SystemPad? = ALL.firstOrNull { it.systemId == systemId }
}

/**
 * Which controller button plays which RetroPad button, per system, as set in
 * Settings. Only what was changed is stored; every other button plays the
 * RetroPad button of its own name.
 */
object ControllerMapping {
    private const val PREFS = "controller-mapping"

    /** The controller key for each RetroPad button on a system. */
    fun load(context: Context, systemId: String): Map<RetroButton, Int> {
        val stored = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(systemId, null)
        val overrides = runCatching { JSONObject(stored ?: "{}") }.getOrDefault(JSONObject())
        return RetroButton.entries.associateWith { button -> overrides.optInt(button.name, button.keyCode) }
    }

    /**
     * Put `physicalKey` on `button`. A key already on another of the
     * system's buttons moves to where `button`'s key was, so no button is
     * left without one and no key plays two.
     */
    fun assign(context: Context, systemId: String, button: RetroButton, physicalKey: Int): Map<RetroButton, Int> {
        val current = load(context, systemId).toMutableMap()
        val previous = current.getValue(button)
        current.entries.firstOrNull { it.key != button && it.value == physicalKey }?.let { it.setValue(previous) }
        current[button] = physicalKey
        save(context, systemId, current)
        return current
    }

    fun reset(context: Context, systemId: String) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(systemId).apply()
    }

    /** Whether a system has any button moved from its default. */
    fun isCustomised(context: Context, systemId: String) =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).contains(systemId)

    private fun save(context: Context, systemId: String, map: Map<RetroButton, Int>) {
        val changed = JSONObject()
        for ((button, key) in map) if (key != button.keyCode) changed.put(button.name, key)
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().apply {
            if (changed.length() == 0) remove(systemId) else putString(systemId, changed.toString())
        }.apply()
    }

    /** Controller key → the key sent to the core, for a game on this system. */
    fun resolver(context: Context, systemId: String): Map<Int, Int> =
        load(context, systemId).entries.associate { (button, physical) -> physical to button.keyCode }

    /** A controller key's name as printed on pads: A, L1, L3, Start. */
    fun keyName(keyCode: Int): String = when (keyCode) {
        KeyEvent.KEYCODE_BUTTON_THUMBL -> "L3"
        KeyEvent.KEYCODE_BUTTON_THUMBR -> "R3"
        KeyEvent.KEYCODE_BUTTON_START -> "Start"
        KeyEvent.KEYCODE_BUTTON_SELECT -> "Select"
        KeyEvent.KEYCODE_BUTTON_MODE -> "Guide"
        else -> KeyEvent.keyCodeToString(keyCode).removePrefix("KEYCODE_").removePrefix("BUTTON_").replace('_', ' ')
    }

    /** A key a controller mapping may take: any controller button but its D-pad and Back. */
    fun mappable(event: KeyEvent): Boolean {
        if (!isController(event)) return false
        return when (event.keyCode) {
            KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_DOWN, KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_DPAD_RIGHT,
            KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_BACK, KeyEvent.KEYCODE_HOME -> false
            else -> true
        }
    }
}

/** Whether an input came from a game controller rather than the TV's remote. */
fun isController(event: android.view.InputEvent): Boolean =
    (event.source and InputDevice.SOURCE_GAMEPAD) == InputDevice.SOURCE_GAMEPAD ||
        (event.source and InputDevice.SOURCE_JOYSTICK) == InputDevice.SOURCE_JOYSTICK

/** The game controllers connected now, by name. */
fun connectedControllers(): List<String> = InputDevice.getDeviceIds().toList()
    .mapNotNull { InputDevice.getDevice(it) }
    .filter { device ->
        !device.isVirtual && ((device.sources and InputDevice.SOURCE_GAMEPAD) == InputDevice.SOURCE_GAMEPAD ||
            (device.sources and InputDevice.SOURCE_JOYSTICK) == InputDevice.SOURCE_JOYSTICK)
    }
    .map { it.name }
    .distinct()

/**
 * A controller's A and B, as the remote's OK and Back, for moving round the
 * app. Android usually does this for keys an app leaves alone, but not on
 * every TV, and not for a key the app has already seen. While a mapping is
 * being set, the keys are left as they are, so the button pressed is the one
 * recorded.
 */
object ControllerNavigation {
    @Volatile var capturing = false

    fun asRemote(event: KeyEvent): KeyEvent? {
        if (capturing || !isController(event)) return null
        val code = when (event.keyCode) {
            KeyEvent.KEYCODE_BUTTON_A -> KeyEvent.KEYCODE_DPAD_CENTER
            KeyEvent.KEYCODE_BUTTON_B -> KeyEvent.KEYCODE_BACK
            else -> return null
        }
        return KeyEvent(event.downTime, event.eventTime, event.action, code, event.repeatCount, event.metaState,
            event.deviceId, event.scanCode, event.flags, event.source)
    }
}
