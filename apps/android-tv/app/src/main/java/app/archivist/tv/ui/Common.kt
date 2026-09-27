package app.archivist.tv.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.focusable
import androidx.compose.foundation.gestures.BringIntoViewSpec
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Border
import androidx.tv.material3.Button
import androidx.tv.material3.ButtonDefaults
import androidx.tv.material3.CardDefaults
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Text
import app.archivist.tv.api.Rating
import coil3.ImageLoader
import coil3.compose.AsyncImage
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import androidx.tv.material3.Card as TvCard

/** The image loader for the connected server: its client carries the device token. */
val LocalImageLoader = staticCompositionLocalOf<ImageLoader> { error("No image loader") }

/** How the rows are held: the focused row at the top of its region. */
@OptIn(ExperimentalFoundationApi::class)
fun pinToTop(leadingPx: Float) = object : BringIntoViewSpec {
    override fun calculateScrollDistance(offset: Float, size: Float, containerSize: Float): Float = offset - leadingPx
}

/** How a row slides: only as far as keeps the focused tile clear of the edges. */
@OptIn(ExperimentalFoundationApi::class)
fun keepInView(marginPx: Float) = object : BringIntoViewSpec {
    override fun calculateScrollDistance(offset: Float, size: Float, containerSize: Float): Float {
        val start = offset - marginPx
        val end = offset + size - (containerSize - marginPx)
        return when {
            start < 0 -> start
            end > 0 -> end
            else -> 0f
        }
    }
}

/**
 * Remembers which tile had focus, so coming back to a screen puts the cursor
 * back where it was rather than at the first tile.
 */
class FocusMemory {
    var key: String? = null
    var pending by mutableStateOf(false)
    fun restoreOnReturn() { if (key != null) pending = true }
}

/**
 * `target` names the tile that takes focus back when the remembered one is
 * gone — a film marked watched leaves Continue Watching, and focus has to land
 * somewhere on the same row rather than fall to the menu.
 */
@Composable
fun Modifier.focusMemory(memory: FocusMemory, key: String, target: String? = null): Modifier {
    val requester = remember { FocusRequester() }
    if (memory.pending && (target ?: memory.key) == key) {
        LaunchedEffect(Unit) {
            withFrameNanos { }
            runCatching { requester.requestFocus() }
            memory.pending = false
        }
    }
    return focusRequester(requester).onFocusChanged { if (it.isFocused) memory.key = key }
}

/** The value it last held for `ms` — the backdrop follows the cursor once it rests. */
@Composable
fun <T> settled(value: T, ms: Long = 250): T {
    var current by remember { mutableStateOf(value) }
    LaunchedEffect(value) { delay(ms); current = value }
    return current
}

@Composable
fun Artwork(url: String?, modifier: Modifier = Modifier, contentScale: ContentScale = ContentScale.Crop, alignment: Alignment = Alignment.Center) {
    if (url == null) return
    AsyncImage(model = url, contentDescription = null, imageLoader = LocalImageLoader.current, contentScale = contentScale, alignment = alignment, modifier = modifier)
}

/** The full-screen backdrop, faded into the canvas left and bottom so text over it reads. */
@Composable
fun Backdrop(url: String?) {
    Box(Modifier.fillMaxSize().background(Palette.canvas)) {
        Artwork(url, Modifier.fillMaxSize(), alignment = Alignment.TopEnd)
        Box(Modifier.fillMaxSize().background(Brush.horizontalGradient(0f to Palette.canvas, .35f to Palette.canvas.copy(alpha = .85f), .7f to Palette.canvas.copy(alpha = .2f), 1f to Color.Transparent)))
        Box(Modifier.fillMaxSize().background(Brush.verticalGradient(0f to Color.Transparent, .45f to Palette.canvas.copy(alpha = .35f), .75f to Palette.canvas.copy(alpha = .92f), 1f to Palette.canvas)))
    }
}

/** Title treatment, facts and overview for whatever is focused. */
@Composable
fun Hero(title: String, logoUrl: String?, facts: List<String>, plot: String?, accent: Color, modifier: Modifier = Modifier, plotLines: Int = 3) {
    Column(modifier.widthIn(max = 600.dp)) {
        // The logo at 70% of its first size, so it leads the spotlight without
        // crowding the overview beneath it.
        Box(Modifier.height(80.dp), contentAlignment = Alignment.CenterStart) {
            if (logoUrl != null) {
                Artwork(logoUrl, Modifier.height(73.dp).widthIn(max = 322.dp), contentScale = ContentScale.Fit, alignment = Alignment.CenterStart)
            } else {
                Text(title.uppercase(), style = MaterialTheme.typography.displayMedium, color = accent, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
        }
        if (facts.isNotEmpty()) {
            Text(facts.joinToString("  •  "), style = MaterialTheme.typography.labelLarge, color = Palette.muted, modifier = Modifier.padding(top = 10.dp), maxLines = 1)
        }
        if (!plot.isNullOrBlank()) {
            Text(plot, style = MaterialTheme.typography.bodyLarge, color = Palette.muted, maxLines = plotLines, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 10.dp))
        }
    }
}

/** How tall a box-art tile is, whatever its shape: a little under a poster, so a wide row still fits. */
val COVER_HEIGHT = 118.dp

/** A poster or landscape tile, with progress and a watched mark. */
@Composable
fun Tile(
    imageUrl: String?,
    fallback: String,
    landscape: Boolean,
    accent: Color,
    modifier: Modifier = Modifier,
    progress: Float? = null,
    watched: Boolean = false,
    label: String? = null,
    // Sized so a poster row fits whole beneath the spotlight.
    /** Width over height of a game's box art, for a tile shaped to it; otherwise a poster or a landscape still. */
    coverAspect: Float? = null,
    width: Dp = when {
        coverAspect != null -> COVER_HEIGHT * coverAspect
        landscape -> 153.dp
        else -> 86.dp
    },
    onFocus: () -> Unit = {},
    /** Long press: the tile's quick menu — watched, information, tracks. */
    onLongClick: (() -> Unit)? = null,
    onClick: () -> Unit,
) {
    Column(Modifier.width(width)) {
        TvCard(
            onClick = onClick,
            onLongClick = onLongClick,
            modifier = modifier.fillMaxWidth().aspectRatio(coverAspect ?: if (landscape) 16f / 9f else 2f / 3f).onFocusChanged { if (it.isFocused) onFocus() },
            shape = CardDefaults.shape(RoundedCornerShape(6.dp)),
            colors = CardDefaults.colors(containerColor = Palette.panel),
            scale = CardDefaults.scale(focusedScale = 1.08f),
            border = CardDefaults.border(focusedBorder = Border(BorderStroke(2.5.dp, accent), shape = RoundedCornerShape(6.dp))),
        ) {
            Box(Modifier.fillMaxSize()) {
                if (imageUrl != null) {
                    // Box art varies within a system — a European box beside an American one — so it is shown whole.
                    Artwork(imageUrl, Modifier.fillMaxSize(), contentScale = if (coverAspect != null) ContentScale.Fit else ContentScale.Crop)
                } else {
                    Text(fallback, style = MaterialTheme.typography.bodyMedium, color = accent, maxLines = 3, modifier = Modifier.align(Alignment.Center).padding(6.dp))
                }
                if (progress != null && progress > 0f && !watched) {
                    Box(Modifier.align(Alignment.BottomStart).fillMaxWidth().height(4.dp).background(Color(0x33FFFFFF))) {
                        Box(Modifier.fillMaxHeight().fillMaxWidth(progress).background(accent))
                    }
                }
                if (watched) WatchedMark(Modifier.align(Alignment.TopEnd).padding(6.dp))
            }
        }
        if (label != null) {
            Text(label, style = MaterialTheme.typography.bodyMedium, color = Palette.muted, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 8.dp))
        }
    }
}

@Composable
fun WatchedMark(modifier: Modifier = Modifier) {
    Box(modifier.size(22.dp).clip(CircleShape).background(Palette.canvas.copy(alpha = .85f)).border(1.5.dp, Palette.watched, CircleShape), contentAlignment = Alignment.Center) {
        Text("✓", color = Palette.watched, style = MaterialTheme.typography.labelMedium)
    }
}

/** A heading over a row of tiles. */
@Composable
fun RowHeading(text: String, note: String? = null, modifier: Modifier = Modifier) {
    Row(modifier.padding(bottom = 4.dp), verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(text.uppercase(), style = MaterialTheme.typography.headlineSmall, color = Palette.text)
        if (note != null) Text(note, style = MaterialTheme.typography.labelMedium, color = Palette.dim)
    }
}

@Composable
fun ActionButton(label: String, accent: Color, modifier: Modifier = Modifier, primary: Boolean = false, enabled: Boolean = true, onClick: () -> Unit) {
    Button(
        onClick = onClick,
        enabled = enabled,
        modifier = modifier,
        colors = ButtonDefaults.colors(
            containerColor = if (primary) accent.copy(alpha = .9f) else Palette.faint,
            contentColor = if (primary) Palette.canvas else Palette.text,
            focusedContainerColor = if (primary) Color.White else accent,
            focusedContentColor = Palette.canvas,
        ),
        scale = ButtonDefaults.scale(focusedScale = 1.06f),
    ) { Text(label, style = MaterialTheme.typography.labelLarge) }
}

/**
 * The viewer's rating, as a television rates.
 *
 * Passing over it changes nothing: it is one focus stop, and every arrow moves
 * on from it. OK starts rating — Left and Right move half a point, OK keeps
 * it, Back puts back what was there. Up and Down keep it and move on.
 */
@Composable
fun RatingControl(rating: Rating?, catalogue: Double?, accent: Color, modifier: Modifier = Modifier, onCommit: suspend (Double?) -> Rating?) {
    val saved = rating?.value ?: 0.0
    var value by remember(saved) { mutableStateOf(saved) }
    var before by remember { mutableStateOf(saved) }
    var adjusting by remember { mutableStateOf(false) }
    var focused by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    fun commit() {
        adjusting = false
        if (value == before) return
        val chosen = value
        scope.launch { runCatching { onCommit(if (chosen <= 0) null else chosen) }.onFailure { value = before } }
    }
    val standIn = value <= 0 && catalogue != null
    val shown = if (standIn) catalogue!! else value
    val color = if (standIn) Palette.catalogue else accent
    Row(
        modifier
            .onFocusChanged { focused = it.isFocused; if (!it.isFocused && adjusting) commit() }
            .onPreviewKeyEvent { event ->
                val down = event.type == KeyEventType.KeyDown
                val ok = event.key == Key.DirectionCenter || event.key == Key.Enter || event.key == Key.NumPadEnter
                if (!adjusting) {
                    if (ok && down) { before = value; adjusting = true }
                    return@onPreviewKeyEvent ok
                }
                when (event.key) {
                    Key.DirectionLeft -> { if (down) value = (Math.ceil(value * 2 - 1) / 2).coerceAtLeast(0.0); true }
                    Key.DirectionRight -> { if (down) value = (Math.floor(value * 2 + 1) / 2).coerceAtMost(5.0); true }
                    Key.Back, Key.Escape -> { if (down) { value = before; adjusting = false }; true }
                    Key.DirectionUp, Key.DirectionDown -> { if (down) commit(); false }
                    else -> if (ok) { if (down) commit(); true } else false
                }
            }
            .focusable()
            .clip(RoundedCornerShape(8.dp))
            .border(if (adjusting) 2.dp else 1.5.dp, if (adjusting) accent else if (focused) Color.White else Color.Transparent, RoundedCornerShape(8.dp))
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        repeat(5) { index ->
            val fill = (shown - index).coerceIn(0.0, 1.0).toFloat()
            Box(Modifier.width(30.dp).height(12.dp).clip(RoundedCornerShape(2.dp)).background(Palette.faint)) {
                if (fill > 0f) Box(Modifier.fillMaxHeight().fillMaxWidth(fill).background(color))
            }
        }
        Spacer(Modifier.width(8.dp))
        Text(if (shown > 0) "%.1f / 5".format(shown) else "Unrated", style = MaterialTheme.typography.labelLarge, color = if (standIn) Palette.dim else Palette.text)
        if (focused) {
            Text(if (adjusting) "◀ ▶ to rate · OK to keep" else "OK to rate", style = MaterialTheme.typography.labelMedium, color = Palette.dim, modifier = Modifier.padding(start = 8.dp))
        }
    }
}

/** "1 hr 47 mins" — spelled out, because this is read from a sofa. */
fun formatRuntime(seconds: Int?): String? {
    if (seconds == null || seconds <= 0) return null
    val minutes = Math.round(seconds / 60.0).toInt()
    val hours = minutes / 60
    val rest = minutes % 60
    return when {
        hours == 0 -> "$rest min"
        rest == 0 -> "$hours hr"
        else -> "$hours hr $rest min"
    }
}

/** A centered message for an empty or failed screen. */
@Composable
fun BoxScope.Notice(text: String) {
    Text(text, style = MaterialTheme.typography.titleMedium, color = Palette.dim, modifier = Modifier.align(Alignment.Center))
}
