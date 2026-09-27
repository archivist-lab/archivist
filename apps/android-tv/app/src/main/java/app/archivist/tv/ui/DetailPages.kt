package app.archivist.tv.ui

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.LocalBringIntoViewSpec
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Text
import app.archivist.tv.api.Episode
import app.archivist.tv.api.FilmDetail
import app.archivist.tv.api.MediaKind
import app.archivist.tv.api.Person
import app.archivist.tv.api.Rating
import app.archivist.tv.api.SeriesDetail
import app.archivist.tv.player.QueueItem
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch

/** Focus onto the page's first control once it is laid out — a page that opens with nothing focused strands a remote. */
@Composable
private fun FocusOnOpen(requester: FocusRequester, key: Any?) {
    LaunchedEffect(key) {
        if (key == null) return@LaunchedEffect
        withFrameNanos { }
        runCatching { requester.requestFocus() }
    }
}

// ── Film ─────────────────────────────────────────────────────────────────────

@Composable
fun FilmPage(actions: Actions, id: Int, refresh: Int) {
    val api = actions.connection.api
    var film by remember(id) { mutableStateOf<FilmDetail?>(null) }
    var rating by remember(id) { mutableStateOf<Rating?>(null) }
    var error by remember(id) { mutableStateOf<String?>(null) }
    var reload by remember { mutableIntStateOf(0) }
    val scope = rememberCoroutineScope()
    LaunchedEffect(id, refresh, reload) {
        runCatching {
            coroutineScope {
                val detail = async { api.film(id) }
                val personal = async { runCatching { api.rating("film", id) }.getOrNull() }
                film = detail.await(); rating = personal.await()
            }
        }.onFailure { if (film == null) error = it.message ?: "Could not open this film" }
    }
    val detail = film
    if (detail == null) { Box(Modifier.fillMaxSize().background(Palette.canvas)) { Notice(error ?: "Opening film…") }; return }
    val title = detail.title
    val progress = title.progress
    val resumable = progress?.resumable == true
    val primary = remember { FocusRequester() }
    FocusOnOpen(primary, detail.title.id)

    fun play(fromStart: Boolean) {
        val stream = detail.streamUrl ?: return
        actions.play(listOf(QueueItem(MediaKind.FILM, title.id, title.title, null, stream, if (fromStart || !resumable) 0.0 else progress!!.positionSeconds, detail.editionId, "film:${title.id}")), 0)
    }

    Box(Modifier.fillMaxSize()) {
        Backdrop(api.resolve(title.backdropUrl ?: title.posterUrl))
        // Fixed, not scrolled: a page that scrolled to reach its buttons slid
        // the logo off the top of the screen.
        Column(Modifier.fillMaxSize().padding(start = 48.dp, top = 36.dp, end = 48.dp)) {
            Text("FILM", style = MaterialTheme.typography.labelLarge, color = Palette.film)
            Hero(title.title, api.resolve(title.logoUrl), titleFacts(title) + listOfNotNull(detail.studio), title.overview, Palette.film, plotLines = 4)
            Spacer(Modifier.height(18.dp))
            RatingControl(rating, Rating.catalogue(title.rating), Palette.film) { value ->
                val next = if (value == null) api.clearRating("film", id) else api.setRating("film", id, value)
                rating = next; next
            }
            Spacer(Modifier.height(18.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                if (detail.streamUrl == null) {
                    ActionButton("Not in your library yet", Palette.film, enabled = false, modifier = Modifier.focusRequester(primary)) {}
                } else if (resumable) {
                    ActionButton("Resume ${clock(progress!!.positionSeconds)}", Palette.film, primary = true, modifier = Modifier.focusRequester(primary)) { play(false) }
                    ActionButton("Start over", Palette.film) { play(true) }
                } else {
                    ActionButton("Play", Palette.film, primary = true, modifier = Modifier.focusRequester(primary)) { play(true) }
                }
                ActionButton(if (progress?.completed == true) "Mark unwatched" else "Mark watched", Palette.film) {
                    scope.launch {
                        runCatching {
                            if (progress?.completed == true) api.clearProgress(MediaKind.FILM, id)
                            else { val total = (title.runtimeSeconds ?: 1).toDouble(); api.saveProgress(MediaKind.FILM, id, total, total, true, detail.editionId) }
                        }
                        reload++
                    }
                }
            }
            if (detail.cast.isNotEmpty()) {
                Spacer(Modifier.height(22.dp))
                RowHeading("Cast")
                CastRow(detail.cast)
            }
        }
    }
}

@Composable
private fun CastRow(cast: List<Person>) {
    LazyRow(horizontalArrangement = Arrangement.spacedBy(18.dp), contentPadding = PaddingValues(vertical = 4.dp)) {
        items(cast.take(20)) { person ->
            Column(Modifier.width(96.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Box(Modifier.size(72.dp).clip(CircleShape).background(Palette.panel), contentAlignment = Alignment.Center) {
                    if (person.imageUrl != null) Artwork(person.imageUrl, Modifier.fillMaxSize()) else Text(person.name.take(1), color = Palette.dim)
                }
                Text(person.name, style = MaterialTheme.typography.bodyMedium, color = Palette.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 6.dp))
                person.role?.let { Text(it, style = MaterialTheme.typography.labelMedium, color = Palette.dim, maxLines = 1, overflow = TextOverflow.Ellipsis) }
            }
        }
    }
}

fun clock(seconds: Double): String {
    val total = seconds.toInt()
    val h = total / 3600; val m = total % 3600 / 60; val s = total % 60
    return if (h > 0) "%d:%02d:%02d".format(h, m, s) else "%d:%02d".format(m, s)
}

// ── Series ───────────────────────────────────────────────────────────────────

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun SeriesPage(actions: Actions, id: Int, refresh: Int) {
    val api = actions.connection.api
    var series by remember(id) { mutableStateOf<SeriesDetail?>(null) }
    var rating by remember(id) { mutableStateOf<Rating?>(null) }
    var error by remember(id) { mutableStateOf<String?>(null) }
    var seasonNumber by remember(id) { mutableStateOf<Int?>(null) }
    var focusedEpisode by remember(id) { mutableStateOf<Episode?>(null) }
    LaunchedEffect(id, refresh) {
        runCatching {
            coroutineScope {
                val detail = async { api.seriesDetail(id) }
                val personal = async { runCatching { api.rating("series", id) }.getOrNull() }
                val loaded = detail.await()
                series = loaded; rating = personal.await()
                if (seasonNumber == null) seasonNumber = loaded.next?.seasonNumber ?: loaded.seasons.firstOrNull()?.number
            }
        }.onFailure { if (series == null) error = it.message ?: "Could not open this series" }
    }
    val detail = series
    if (detail == null) { Box(Modifier.fillMaxSize().background(Palette.canvas)) { Notice(error ?: "Opening series…") }; return }
    val title = detail.title
    val season = detail.seasons.firstOrNull { it.number == seasonNumber } ?: detail.seasons.firstOrNull()
    val next = detail.next
    val primary = remember { FocusRequester() }
    FocusOnOpen(primary, detail.title.id)
    val density = LocalDensity.current

    /** Plays from [episode] on through every later episode with a file. */
    fun playFrom(episode: Episode, fromStart: Boolean = false) {
        val queue = detail.playable
        val start = queue.indexOfFirst { it.id == episode.id }.takeIf { it >= 0 } ?: return
        actions.play(queue.map { item ->
            val resume = if (item.id == episode.id && !fromStart && item.progress?.resumable == true) item.progress.positionSeconds else 0.0
            QueueItem(MediaKind.EPISODE, item.id, "${item.code} · ${item.title}", title.title, item.streamUrl!!, resume, null, "series:${title.id}")
        }, start)
    }

    val shownEpisode = focusedEpisode
    Box(Modifier.fillMaxSize()) {
        Backdrop(api.resolve(title.backdropUrl ?: title.posterUrl))
        Column(Modifier.fillMaxSize().padding(top = 36.dp)) {
            // The header stays put — logo, overview, rating, Play — and only the
            // rows beneath it scroll, each brought to the top as it is entered.
            Column(Modifier.padding(start = 48.dp, end = 48.dp)) {
                Text(listOfNotNull("SERIES", detail.network?.uppercase()).joinToString("  ·  "), style = MaterialTheme.typography.labelLarge, color = Palette.series)
                // The overview follows the focused episode, so choosing one reads it.
                Hero(
                    title.title, api.resolve(title.logoUrl),
                    if (shownEpisode != null) listOfNotNull(shownEpisode.code, shownEpisode.airDate, formatRuntime(shownEpisode.runtimeSeconds), shownEpisode.resolution)
                    else titleFacts(title),
                    if (shownEpisode != null) "${shownEpisode.title} — ${shownEpisode.overview ?: "No overview for this episode."}" else title.overview,
                    Palette.series, plotLines = 3,
                )
                Spacer(Modifier.height(12.dp))
                RatingControl(rating, Rating.catalogue(title.rating), Palette.series) { value ->
                    val updated = if (value == null) api.clearRating("series", id) else api.setRating("series", id, value)
                    rating = updated; updated
                }
                Spacer(Modifier.height(12.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                    if (next?.streamUrl != null) {
                        val resume = next.progress?.resumable == true
                        ActionButton("${if (resume) "Resume" else "Play"} ${next.code}", Palette.series, primary = true, modifier = Modifier.focusRequester(primary)) { playFrom(next) }
                        if (resume) ActionButton("Start over", Palette.series) { playFrom(next, fromStart = true) }
                    } else {
                        ActionButton("No episode ready to play", Palette.series, enabled = false, modifier = Modifier.focusRequester(primary)) {}
                    }
                }
            }
            CompositionLocalProvider(LocalBringIntoViewSpec provides pinToTop(with(density) { 6.dp.toPx() })) {
                LazyColumn(Modifier.fillMaxWidth().weight(1f), contentPadding = PaddingValues(top = 14.dp, bottom = 120.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    if (detail.seasons.size > 1) item(key = "seasons") {
                        CompositionLocalProvider(LocalBringIntoViewSpec provides keepInView(with(density) { 24.dp.toPx() })) {
                            LazyRow(horizontalArrangement = Arrangement.spacedBy(12.dp), contentPadding = PaddingValues(horizontal = 48.dp, vertical = 6.dp)) {
                                items(detail.seasons, key = { it.id }) { item ->
                                    ActionButton(item.title, Palette.series, primary = item.number == season?.number) { seasonNumber = item.number; focusedEpisode = null }
                                }
                            }
                        }
                    }
                    if (season != null) item(key = "episodes") {
                        Column {
                            RowHeading(season.title, "${season.episodes.size} episodes", Modifier.padding(start = 48.dp))
                            CompositionLocalProvider(LocalBringIntoViewSpec provides keepInView(with(density) { 48.dp.toPx() })) {
                                LazyRow(contentPadding = PaddingValues(horizontal = 48.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                                    itemsIndexed(season.episodes, key = { _, item -> item.id }) { _, episode ->
                                        Tile(
                                            imageUrl = api.resolve(episode.stillUrl ?: title.backdropUrl), fallback = episode.code, landscape = true, accent = Palette.series,
                                            progress = episode.progress?.fraction, watched = episode.progress?.completed == true,
                                            label = "${episode.episodeNumber}. ${episode.title}" + if (episode.streamUrl == null) " · not available" else "",
                                            onFocus = { focusedEpisode = episode },
                                            onLongClick = {
                                                actions.menu(app.archivist.tv.api.Card(
                                                    key = "episode:${episode.id}", mediaType = "episode", id = episode.id, route = "/series/${title.id}",
                                                    title = title.title, subtitle = "${episode.code} · ${episode.title}", plot = episode.overview, year = null,
                                                    posterUrl = title.posterUrl, landscapeUrl = episode.stillUrl, backdropUrl = title.backdropUrl, logoUrl = title.logoUrl,
                                                    progress = episode.progress, available = episode.streamUrl != null,
                                                ))
                                            },
                                        ) { if (episode.streamUrl != null) playFrom(episode) }
                                    }
                                }
                            }
                        }
                    }
                    if (detail.cast.isNotEmpty()) item(key = "cast") {
                        Column(Modifier.padding(start = 48.dp)) { RowHeading("Cast"); CastRow(detail.cast) }
                    }
                }
            }
        }
    }
}
