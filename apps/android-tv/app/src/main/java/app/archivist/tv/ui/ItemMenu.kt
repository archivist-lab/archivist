package app.archivist.tv.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Text
import app.archivist.tv.TrackChoice
import app.archivist.tv.TrackChoices
import app.archivist.tv.api.ArchivistApi
import app.archivist.tv.api.Card
import app.archivist.tv.api.MediaKind
import app.archivist.tv.api.SeriesDetail
import app.archivist.tv.api.Tracks
import kotlinx.coroutines.launch

private enum class Page { MAIN, INFO, AUDIO, SUBTITLES }

/** The key a tile's track choices are kept under: the film, or the whole series for a show or one of its episodes. */
fun choiceKeyFor(card: Card): String? = when (card.mediaType) {
    "film" -> card.id?.let { "film:$it" }
    "series" -> card.id?.let { "series:$it" }
    "episode" -> card.seriesId?.let { "series:$it" } ?: card.id?.let { "episode:$it" }
    else -> null
}

/**
 * A tile's quick menu, on a long press of OK: mark watched or unwatched, read
 * about it, or choose its audio and subtitles without opening it. Track
 * choices are kept by language for the film or the series and applied when it
 * plays; Back steps out of a sub-page, then out of the menu.
 */
@Composable
fun ItemMenu(card: Card, api: ArchivistApi, choices: TrackChoices, accent: androidx.compose.ui.graphics.Color, onDismiss: () -> Unit, onChanged: () -> Unit) {
    val scope = rememberCoroutineScope()
    var page by remember { mutableStateOf(Page.MAIN) }
    var tracks by remember { mutableStateOf<Tracks?>(null) }
    var series by remember { mutableStateOf<SeriesDetail?>(null) }
    var loading by remember { mutableStateOf(true) }
    var busy by remember { mutableStateOf(false) }
    val key = choiceKeyFor(card)
    var choice by remember { mutableStateOf(key?.let(choices::get) ?: TrackChoice(null, TrackChoice.Subtitles.Default)) }
    val id = card.id ?: return

    LaunchedEffect(card.key) {
        when (card.mediaType) {
            "film" -> tracks = runCatching { api.tracks(MediaKind.FILM, id) }.getOrNull()
            "episode" -> tracks = runCatching { api.tracks(MediaKind.EPISODE, id) }.getOrNull()
            "series" -> {
                series = runCatching { api.seriesDetail(id) }.getOrNull()
                // A series' tracks are read off the episode it would play next.
                val episode = series?.next ?: series?.playable?.firstOrNull()
                if (episode != null) tracks = runCatching { api.tracks(MediaKind.EPISODE, episode.id) }.getOrNull()
            }
        }
        loading = false
    }

    val watched = when (card.mediaType) {
        "series" -> series?.seasons?.flatMap { it.episodes }?.let { all -> all.isNotEmpty() && all.all { it.progress?.completed == true } } ?: false
        else -> card.progress?.completed == true
    }

    fun toggleWatched() {
        busy = true
        scope.launch {
            runCatching {
                when (card.mediaType) {
                    "series" -> {
                        val detail = series ?: api.seriesDetail(id)
                        for (episode in detail.seasons.flatMap { it.episodes }) {
                            if (watched) api.clearProgress(MediaKind.EPISODE, episode.id)
                            else { val total = (episode.runtimeSeconds ?: 1).toDouble(); api.saveProgress(MediaKind.EPISODE, episode.id, total, total, true) }
                        }
                    }
                    else -> {
                        val kind = if (card.mediaType == "film") MediaKind.FILM else MediaKind.EPISODE
                        if (watched) api.clearProgress(kind, id)
                        else { val total = tracks?.durationSeconds ?: 1.0; api.saveProgress(kind, id, total, total, true) }
                    }
                }
            }
            busy = false
            onChanged()
            onDismiss()
        }
    }

    /*
     * The menu opens while OK is still held from the long press. Its repeats
     * and its release must not press the first option, so OK does nothing here
     * until it goes down afresh.
     */
    var armed by remember { mutableStateOf(false) }
    Dialog(onDismissRequest = { if (page != Page.MAIN) page = Page.MAIN else onDismiss() }) {
        val first = remember(page) { FocusRequester() }
        LaunchedEffect(page, loading) { withFrameNanos { }; runCatching { first.requestFocus() } }
        Column(
            Modifier
                .onPreviewKeyEvent { event ->
                    val ok = event.key == Key.DirectionCenter || event.key == Key.Enter || event.key == Key.NumPadEnter
                    if (!ok || armed) return@onPreviewKeyEvent false
                    if (event.type == KeyEventType.KeyDown && event.nativeKeyEvent.repeatCount == 0) { armed = true; false } else true
                }
                .width(440.dp).heightIn(max = 480.dp).background(Palette.panelRaised, RoundedCornerShape(14.dp)).padding(24.dp).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text(card.title.uppercase(), style = MaterialTheme.typography.headlineSmall, color = accent, maxLines = 2, overflow = TextOverflow.Ellipsis)
            card.subtitle?.let { Text(it, style = MaterialTheme.typography.labelMedium, color = Palette.dim) }
            val wide = Modifier.fillMaxWidth()
            when (page) {
                Page.MAIN -> {
                    ActionButton(
                        when {
                            card.mediaType == "series" && series == null && loading -> "Checking watched state…"
                            watched -> "Mark as unwatched"
                            else -> "Mark as watched"
                        },
                        accent, primary = true, enabled = !busy && !(card.mediaType == "series" && series == null && loading),
                        modifier = wide.focusRequester(first),
                    ) { toggleWatched() }
                    ActionButton("Information", accent, modifier = wide) { page = Page.INFO }
                    ActionButton("Audio tracks", accent, enabled = key != null, modifier = wide) { page = Page.AUDIO }
                    ActionButton("Subtitles", accent, enabled = key != null, modifier = wide) { page = Page.SUBTITLES }
                }
                Page.INFO -> {
                    val facts = listOfNotNull(card.year?.toString(), tracks?.durationSeconds?.let { formatRuntime(it.toInt()) }, tracks?.videoCodec?.uppercase(),
                        tracks?.audio?.size?.takeIf { it > 0 }?.let { "$it audio" }, tracks?.subtitles?.size?.takeIf { it > 0 }?.let { "$it subtitles" })
                    if (facts.isNotEmpty()) Text(facts.joinToString("  •  "), style = MaterialTheme.typography.labelLarge, color = Palette.muted)
                    Text(card.plot ?: series?.title?.overview ?: "No overview.", style = MaterialTheme.typography.bodyLarge, color = Palette.muted)
                    ActionButton("Back", accent, modifier = wide.focusRequester(first)) { page = Page.MAIN }
                }
                Page.AUDIO -> {
                    if (loading) Text("Reading tracks…", color = Palette.dim)
                    Option("Default", "the profile’s own choice", choice.audioLanguage == null, accent, wide.focusRequester(first)) {
                        choices.setAudio(key!!, null); choice = choice.copy(audioLanguage = null)
                    }
                    languagesOf(tracks?.audio.orEmpty().map { (it.languageCode ?: it.language) to listOfNotNull(it.language, it.codec.uppercase(), it.channels?.let { c -> channelLabel(c) }, it.title).joinToString(" · ") }).forEach { (code, label) ->
                        Option(label, null, choice.audioLanguage == code, accent, wide) { choices.setAudio(key!!, code); choice = choice.copy(audioLanguage = code) }
                    }
                    ActionButton("Done", accent, modifier = wide) { page = Page.MAIN }
                }
                Page.SUBTITLES -> {
                    if (loading) Text("Reading tracks…", color = Palette.dim)
                    Option("Default", "forced subtitles only, as the profile is set", choice.subtitles == TrackChoice.Subtitles.Default, accent, wide.focusRequester(first)) {
                        choices.setSubtitles(key!!, TrackChoice.Subtitles.Default); choice = choice.copy(subtitles = TrackChoice.Subtitles.Default)
                    }
                    Option("Off", null, choice.subtitles == TrackChoice.Subtitles.Off, accent, wide) {
                        choices.setSubtitles(key!!, TrackChoice.Subtitles.Off); choice = choice.copy(subtitles = TrackChoice.Subtitles.Off)
                    }
                    languagesOf(tracks?.subtitles.orEmpty().map { (it.languageCode ?: it.language) to listOfNotNull(it.language, it.title, if (it.forced) "forced" else null).joinToString(" · ") }).forEach { (code, label) ->
                        val chosen = TrackChoice.Subtitles.Language(code)
                        Option(label, null, choice.subtitles == chosen, accent, wide) { choices.setSubtitles(key!!, chosen); choice = choice.copy(subtitles = chosen) }
                    }
                    ActionButton("Done", accent, modifier = wide) { page = Page.MAIN }
                }
            }
        }
    }
}

/** One choice per language: a film with two English tracks is one English choice. */
private fun languagesOf(entries: List<Pair<String?, String>>): List<Pair<String, String>> =
    entries.filter { it.first != null }.groupBy { it.first!!.lowercase() }.map { (code, group) -> code to group.first().second }

private fun channelLabel(channels: Int) = when (channels) { 1 -> "mono"; 2 -> "stereo"; 6 -> "5.1"; 8 -> "7.1"; else -> "${channels}ch" }

@Composable
private fun Option(label: String, note: String?, selected: Boolean, accent: androidx.compose.ui.graphics.Color, modifier: Modifier, onSelect: () -> Unit) {
    ActionButton((if (selected) "✓  " else "    ") + label + (note?.let { "  ($it)" } ?: ""), accent, primary = selected, modifier = modifier) { onSelect() }
}
