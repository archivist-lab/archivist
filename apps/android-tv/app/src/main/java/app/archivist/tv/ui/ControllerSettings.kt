package app.archivist.tv.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Button
import androidx.tv.material3.ButtonDefaults
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Text
import app.archivist.tv.retro.ControllerMapping
import app.archivist.tv.retro.ControllerNavigation
import app.archivist.tv.retro.RetroButton
import app.archivist.tv.retro.SystemPad
import app.archivist.tv.retro.SystemPads
import app.archivist.tv.retro.connectedControllers
import kotlinx.coroutines.delay

/**
 * Settings' game controller section: the controllers connected now, and a
 * mapping to open for each system the TV plays.
 */
@Composable
fun ControllersSection(onOpen: (SystemPad) -> Unit) {
    val context = LocalContext.current
    var controllers by remember { mutableStateOf(connectedControllers()) }
    // Controllers come and go while the page is open; a Bluetooth pad can take a moment to pair.
    LaunchedEffect(Unit) { while (true) { delay(2_000); controllers = connectedControllers() } }
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text("GAME CONTROLLERS", style = MaterialTheme.typography.labelLarge, color = Palette.games)
        Text(
            if (controllers.isEmpty()) "No controller connected. Pair one in the TV’s Bluetooth settings, or plug one in; the remote plays too."
            else "Connected: ${controllers.joinToString(" · ")}. The first controller to press a button in a game is player 1.",
            style = MaterialTheme.typography.bodyLarge, color = Palette.muted, modifier = Modifier.width(760.dp),
        )
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            for (pad in SystemPads.ALL) {
                val customised = ControllerMapping.isCustomised(context, pad.systemId)
                ActionButton(if (customised) "${pad.label} ✎" else pad.label, Palette.games) { onOpen(pad) }
            }
        }
        Text("In a game: the guide button, or Select and Start together, opens the menu.",
            style = MaterialTheme.typography.labelLarge, color = Palette.dim)
    }
}

/**
 * One system's buttons, each with the controller button that plays it.
 * Choosing a row waits for a controller button, which then plays that button;
 * one already in use swaps places with it.
 */
@Composable
fun ControllerMappingScreen(pad: SystemPad, onClose: () -> Unit) {
    val context = LocalContext.current
    var mapping by remember(pad) { mutableStateOf(ControllerMapping.load(context, pad.systemId)) }
    var capturing by remember { mutableStateOf<Pair<RetroButton, String>?>(null) }
    var releaseOf by remember { mutableStateOf<Int?>(null) }
    val first = remember { FocusRequester() }

    // While waiting, a controller's A and B are buttons to record, not OK and Back.
    DisposableEffect(capturing) {
        ControllerNavigation.capturing = capturing != null
        onDispose { ControllerNavigation.capturing = false }
    }
    LaunchedEffect(pad) { runCatching { first.requestFocus() } }
    BackHandler(enabled = capturing == null) { onClose() }

    Box(
        Modifier.fillMaxSize().background(Palette.canvas).onPreviewKeyEvent { event ->
            val native = event.nativeKeyEvent
            val waiting = capturing
            when {
                // The release of the button just recorded, so it does not also press the row.
                releaseOf != null && native.keyCode == releaseOf -> {
                    if (event.type == KeyEventType.KeyUp) releaseOf = null
                    true
                }
                waiting == null -> false
                // The remote's Back gives up without changing anything.
                native.keyCode == android.view.KeyEvent.KEYCODE_BACK && !app.archivist.tv.retro.isController(native) -> {
                    if (event.type == KeyEventType.KeyUp) capturing = null
                    true
                }
                event.type == KeyEventType.KeyDown && ControllerMapping.mappable(native) -> {
                    mapping = ControllerMapping.assign(context, pad.systemId, waiting.first, native.keyCode)
                    releaseOf = native.keyCode
                    capturing = null
                    true
                }
                // Anything else — the remote's arrows, a D-pad — waits on.
                else -> true
            }
        },
    ) {
        Column(Modifier.padding(start = 48.dp, top = 40.dp, end = 48.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Text("${pad.label} controls".uppercase(), style = MaterialTheme.typography.displayMedium, color = Palette.text)
            Text("Choose a button, then press the controller button you want for it. A button already in use swaps places.",
                style = MaterialTheme.typography.bodyLarge, color = Palette.muted, modifier = Modifier.width(760.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                ActionButton("Done", Palette.games, primary = true) { onClose() }
                ActionButton("Reset to defaults", Palette.pink) {
                    ControllerMapping.reset(context, pad.systemId)
                    mapping = ControllerMapping.load(context, pad.systemId)
                }
            }
            LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp), contentPadding = PaddingValues(bottom = 80.dp)) {
                itemsIndexed(pad.buttons) { index, (button, name) ->
                    val key = mapping.getValue(button)
                    val changed = key != button.keyCode
                    Button(
                        onClick = { capturing = button to name },
                        modifier = Modifier.width(720.dp).then(if (index == 0) Modifier.focusRequester(first) else Modifier),
                        shape = ButtonDefaults.shape(RoundedCornerShape(10.dp)),
                        colors = ButtonDefaults.colors(
                            containerColor = Palette.faint, contentColor = Palette.text,
                            focusedContainerColor = Palette.games, focusedContentColor = Palette.canvas,
                        ),
                        scale = ButtonDefaults.scale(focusedScale = 1.02f),
                    ) {
                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text(name, style = MaterialTheme.typography.titleMedium)
                                Text(button.retroName, style = MaterialTheme.typography.labelMedium, color = Palette.dim)
                            }
                            Text(
                                ControllerMapping.keyName(key) + if (changed) "  ✎" else "",
                                style = MaterialTheme.typography.titleMedium,
                                color = if (changed) Palette.games else Color.Unspecified,
                            )
                        }
                    }
                }
            }
        }
        val waiting = capturing
        if (waiting != null) {
            Box(Modifier.fillMaxSize().background(Palette.canvas.copy(alpha = .88f)), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text("Press the controller button for", style = MaterialTheme.typography.titleMedium, color = Palette.muted)
                    Text(waiting.second.uppercase(), style = MaterialTheme.typography.displayMedium, color = Palette.games)
                    Text("The remote’s Back cancels", style = MaterialTheme.typography.labelLarge, color = Palette.dim)
                }
            }
        }
    }
}
