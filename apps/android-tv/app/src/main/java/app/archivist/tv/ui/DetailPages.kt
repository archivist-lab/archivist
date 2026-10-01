package app.archivist.tv.ui

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.focusable
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.gestures.LocalBringIntoViewSpec
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
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
import androidx.compose.runtime.key
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
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.focusRestorer
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.unit.sp
import androidx.compose.ui.platform.LocalContext
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
import app.archivist.tv.SeriesPrefs
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

/**
 * One season in the series page's season row: the top bar's tab, at 80% of its
 * size, underlined while it is the season shown. Focusing it shows it.
 */
@Composable
private fun SeasonTab(label: String, selected: Boolean, modifier: Modifier = Modifier, canFocus: Boolean = true, onFocus: () -> Unit) {
    var focused by remember { mutableStateOf(false) }
    Column(if (canFocus) modifier.onFocusChanged { focused = it.isFocused; if (it.isFocused) onFocus() }.focusable() else modifier) {
        Text(label.uppercase(), style = MaterialTheme.typography.headlineSmall.copy(fontSize = 22.4.sp, letterSpacing = 2.sp),
            color = if (selected || focused) Palette.series else Palette.dim)
        Box(Modifier.padding(top = 4.dp).height(2.4.dp).width(if (selected) 29.dp else 0.dp).background(Palette.series, RoundedCornerShape(2.dp)))
    }
}

/**
 * One season as artwork, when Settings asks for it: its poster as a tile, the
 * highlight and focus of any other, over its name as the season tab at half
 * size — underlined while it is the season shown. Focusing it shows it.
 */
@Composable
private fun SeasonPoster(label: String, posterUrl: String?, selected: Boolean, modifier: Modifier, canFocus: Boolean, onFocus: () -> Unit) {
    Column(Modifier.width(86.dp)) {
        if (canFocus) {
            Tile(imageUrl = posterUrl, fallback = label, landscape = false, accent = Palette.series, modifier = modifier, onFocus = onFocus) {}
        } else {
            Box(Modifier.fillMaxWidth().aspectRatio(2f / 3f).clip(RoundedCornerShape(6.dp)).background(Palette.panel)) {
                Artwork(posterUrl, Modifier.fillMaxSize())
            }
        }
        Text(label.uppercase(), style = MaterialTheme.typography.headlineSmall.copy(fontSize = 11.2.sp, letterSpacing = 1.sp),
            color = if (selected) Palette.series else Palette.dim, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 6.dp))
        Box(Modifier.padding(top = 2.dp).height(1.5.dp).width(if (selected) 15.dp else 0.dp).background(Palette.series, RoundedCornerShape(1.dp)))
    }
}

@OptIn(ExperimentalFoundationApi::class, ExperimentalComposeUiApi::class)
@Composable
fun SeriesPage(actions: Actions, id: Int, refresh: Int) {
    val api = actions.connection.api
    var series by remember(id) { mutableStateOf<SeriesDetail?>(null) }
    var rating by remember(id) { mutableStateOf<Rating?>(null) }
    var error by remember(id) { mutableStateOf<String?>(null) }
    var seasonNumber by remember(id) { mutableStateOf<Int?>(null) }
    var focusedEpisode by remember(id) { mutableStateOf<Episode?>(null) }
    // The season whose tab has focus: its overview, when it has one, is read above.
    var focusedSeason by remember(id) { mutableStateOf<app.archivist.tv.api.Season?>(null) }
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
    // Read as the page opens, so a change in Settings shows on the next series opened.
    val context = LocalContext.current
    val seasonArtwork = remember { SeriesPrefs(context).showSeasonArtwork }
    Box(Modifier.fillMaxSize()) {
        Backdrop(api.resolve(title.backdropUrl ?: title.posterUrl))
        Column(Modifier.fillMaxSize().padding(top = 36.dp)) {
            // The header stays put — logo, overview, rating — and only the rows
            // beneath it scroll (up next, seasons, episodes, cast), each brought
            // to the top as it is entered.
            Column(Modifier.padding(start = 48.dp, end = 48.dp)) {
                Text(listOfNotNull("SERIES", detail.network?.uppercase()).joinToString("  ·  "), style = MaterialTheme.typography.labelLarge, color = Palette.series)
                // The overview follows focus: an episode reads its own, a season
                // its own when it has one, and otherwise the series'.
                val shownSeason = focusedSeason?.takeIf { shownEpisode == null && it.overview != null }
                Hero(
                    title.title, api.resolve(title.logoUrl),
                    when {
                        shownEpisode != null -> listOfNotNull(shownEpisode.code, shownEpisode.airDate, formatRuntime(shownEpisode.runtimeSeconds), shownEpisode.resolution)
                        shownSeason != null -> listOf(shownSeason.title, "${shownSeason.episodes.size} ${if (shownSeason.episodes.size == 1) "episode" else "episodes"}")
                        else -> titleFacts(title)
                    },
                    when {
                        shownEpisode != null -> "${shownEpisode.title} — ${shownEpisode.overview ?: "No overview for this episode."}"
                        shownSeason != null -> shownSeason.overview
                        else -> title.overview
                    },
                    Palette.series, plotLines = 3, lockPlotHeight = true,
                )
                Spacer(Modifier.height(12.dp))
                RatingControl(rating, Rating.catalogue(title.rating), Palette.series) { value ->
                    val updated = if (value == null) api.clearRating("series", id) else api.setRating("series", id, value)
                    rating = updated; updated
                }
            }
            CompositionLocalProvider(LocalBringIntoViewSpec provides pinToTop(with(density) { 6.dp.toPx() })) {
                LazyColumn(Modifier.fillMaxWidth().weight(1f), contentPadding = PaddingValues(top = 14.dp, bottom = 120.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    // Up next is the first row, an episode like the ones below it:
                    // it scrolls away as the seasons are entered, and back on Up.
                    item(key = "next") {
                        Column(Modifier.bringWholeIntoView()) {
                            if (next?.streamUrl != null) {
                                val resume = next.progress?.resumable == true
                                // Headed as the season bar's tabs are: same face, size and spacing.
                                Text("Up next".uppercase(),
                                    style = MaterialTheme.typography.headlineSmall.copy(fontSize = 22.4.sp, letterSpacing = 2.sp),
                                    color = Palette.series, modifier = Modifier.padding(start = 48.dp, top = 4.dp, bottom = 6.dp))
                                Row(Modifier.padding(horizontal = 48.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(20.dp), verticalAlignment = Alignment.CenterVertically) {
                                    Tile(
                                        imageUrl = api.resolve(next.stillUrl ?: title.backdropUrl), fallback = next.code, landscape = true, accent = Palette.series,
                                        modifier = Modifier.focusRequester(primary),
                                        progress = next.progress?.fraction, watched = next.progress?.completed == true,
                                        label = "${next.episodeNumber}. ${next.title}",
                                        onFocus = { focusedEpisode = next; focusedSeason = null },
                                        logoUrl = api.resolve(title.logoUrl),
                                    ) { playFrom(next) }
                                    if (resume) ActionButton("Start over", Palette.series) { playFrom(next, fromStart = true) }
                                }
                            } else {
                                Box(Modifier.padding(horizontal = 48.dp, vertical = 6.dp)) {
                                    ActionButton("No episode ready to play", Palette.series, enabled = false, modifier = Modifier.focusRequester(primary)) {}
                                }
                            }
                        }
                    }
                    // Always shown, one season or many; a lone season is only a label,
                    // passed over on the way down to its episodes.
                    if (detail.seasons.isNotEmpty()) item(key = "seasons") {
                        // Seasons read as the top bar's tabs do, and landing on
                        // one shows its episodes — no press needed. Coming back
                        // up from the episodes returns to the season they are
                        // from, not the nearest one, which would switch it.
                        val selectedIndex = detail.seasons.indexOfFirst { it.number == season?.number }.coerceAtLeast(0)
                        val seasonsState = rememberLazyListState(initialFirstVisibleItemIndex = selectedIndex)
                        val selectedSeason = remember { FocusRequester() }
                        CompositionLocalProvider(LocalBringIntoViewSpec provides keepInView(with(density) { 24.dp.toPx() })) {
                            LazyRow(
                                Modifier.focusRestorer(selectedSeason),
                                state = seasonsState,
                                horizontalArrangement = Arrangement.spacedBy(if (seasonArtwork) 16.dp else 36.dp),
                                contentPadding = PaddingValues(horizontal = 48.dp, vertical = 6.dp),
                            ) {
                                items(detail.seasons, key = { it.id }) { item ->
                                    val selected = item.number == season?.number
                                    val canFocus = detail.seasons.size > 1
                                    val requester = if (selected && canFocus) Modifier.focusRequester(selectedSeason) else Modifier
                                    val choose = { seasonNumber = item.number; focusedEpisode = null; focusedSeason = item }
                                    if (seasonArtwork) SeasonPoster(item.title, api.resolve(item.posterUrl ?: title.posterUrl), selected, requester, canFocus, choose)
                                    else SeasonTab(item.title, selected, requester, canFocus = canFocus, onFocus = choose)
                                }
                            }
                        }
                    }
                    if (season != null) item(key = "episodes") {
                        Column {
                            // The season row above already names the season; this only counts it,
                            // in the seasons' own face at 80% of their size.
                            Text("${season.episodes.size} ${if (season.episodes.size == 1) "episode" else "episodes"}".uppercase(),
                                style = MaterialTheme.typography.headlineSmall.copy(fontSize = 17.9.sp, letterSpacing = 1.6.sp),
                                color = Palette.dim, modifier = Modifier.padding(start = 48.dp, top = 4.dp, bottom = 6.dp))
                            // Keyed by season, so a season just switched to opens at its first episode.
                            // The season holding the next episode opens scrolled to it, and
                            // coming down into the row lands on it.
                            CompositionLocalProvider(LocalBringIntoViewSpec provides keepInView(with(density) { 48.dp.toPx() })) { key(season.number) {
                                val nextIndex = season.episodes.indexOfFirst { it.id == next?.id }
                                val episodesState = rememberLazyListState(initialFirstVisibleItemIndex = nextIndex.coerceAtLeast(0))
                                val nextInList = remember { FocusRequester() }
                                LazyRow(
                                    if (nextIndex >= 0) Modifier.focusRestorer(nextInList) else Modifier.focusRestorer(),
                                    state = episodesState,
                                    contentPadding = PaddingValues(horizontal = 48.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(12.dp),
                                ) {
                                    itemsIndexed(season.episodes, key = { _, item -> item.id }) { index, episode ->
                                        Tile(
                                            imageUrl = api.resolve(episode.stillUrl ?: title.backdropUrl), fallback = episode.code, landscape = true, accent = Palette.series,
                                            modifier = if (index == nextIndex) Modifier.focusRequester(nextInList) else Modifier,
                                            progress = episode.progress?.fraction, watched = episode.progress?.completed == true,
                                            label = "${episode.episodeNumber}. ${episode.title}" + if (episode.streamUrl == null) " · not available" else "",
                                            onFocus = { focusedEpisode = episode; focusedSeason = null },
                                            logoUrl = api.resolve(title.logoUrl),
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
                            } }
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
