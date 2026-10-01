package app.archivist.tv.ui

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.gestures.LocalBringIntoViewSpec
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusProperties
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import app.archivist.tv.api.ArchivistApi
import app.archivist.tv.api.Card
import app.archivist.tv.api.Row

/**
 * A spotlight over rows of tiles: Home, a type's own screen, a box set.
 *
 * The spotlight stays put and describes whatever is focused; only the rows
 * scroll, each one brought to the top of its region as it is entered.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun RowsBrowser(
    api: ArchivistApi,
    rows: List<Row>,
    spotlight: Card?,
    list: LazyListState,
    memory: FocusMemory,
    topInset: Dp,
    accent: Color,
    onOpen: (Card) -> Unit,
    onMenu: (Card) -> Unit,
    /** Bumped by the shell when the quick menu closes, to take focus back to the tile it came from. */
    reclaim: Int = 0,
    /** Where Up leads from the top row — the library or type above — rather than wherever lies straight up. */
    up: FocusRequester? = null,
) {
    var focused by remember(rows) { mutableStateOf<Card?>(null) }
    val tileKey = { row: Row, card: Card -> "${row.id}|${card.key}" }
    // After the menu: focus back on its tile at once, and again once the rows
    // reload — by then the tile may have left its row, and the row's first
    // tile takes it instead of focus falling out to the main menu.
    var awaitingReload by remember { mutableStateOf(false) }
    LaunchedEffect(reclaim) { if (reclaim > 0) { memory.restoreOnReturn(); awaitingReload = true } }
    LaunchedEffect(rows) { if (awaitingReload) { awaitingReload = false; memory.restoreOnReturn() } }
    val target = if (!memory.pending) null else memory.key?.let { wanted ->
        val keys = rows.flatMap { row -> row.cards.map { tileKey(row, it) } }
        if (wanted in keys) wanted
        else rows.firstOrNull { it.id == wanted.substringBefore('|') }?.let { row -> row.cards.firstOrNull()?.let { tileKey(row, it) } } ?: keys.firstOrNull()
    }
    val shown = focused ?: spotlight ?: rows.firstOrNull()?.cards?.firstOrNull()
    val backdrop = settled(api.resolve(shown?.backdropUrl ?: shown?.landscapeUrl))
    val density = LocalDensity.current
    Box(Modifier.fillMaxSize()) {
        Backdrop(backdrop)
        Column(Modifier.fillMaxSize()) {
            Spacer(Modifier.height(topInset))
            Box(Modifier.height(240.dp).padding(start = 48.dp)) {
                if (shown != null) Hero(shown.title, api.resolve(shown.logoUrl), listOfNotNull(shown.subtitle, shown.year?.toString()).distinct(), shown.plot, accent, plotLines = 4)
            }
            if (rows.isEmpty()) { Box(Modifier.fillMaxSize()) { Notice("Nothing here yet") }; return@Column }
            CompositionLocalProvider(LocalBringIntoViewSpec provides pinToTop(with(density) { 44.dp.toPx() })) {
                LazyColumn(state = list, modifier = Modifier.fillMaxWidth().weight(1f), contentPadding = PaddingValues(top = 4.dp, bottom = 120.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    itemsIndexed(rows, key = { _, it -> it.id }) { rowIndex, row ->
                        Column {
                            RowHeading(row.title, "${row.cards.size}", Modifier.padding(start = 48.dp), logoUrl = api.resolve(row.logoUrl))
                            CompositionLocalProvider(LocalBringIntoViewSpec provides keepInView(with(density) { 48.dp.toPx() })) {
                                LazyRow(contentPadding = PaddingValues(horizontal = 48.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                                    items(row.cards, key = { row.id + it.key }) { card ->
                                        Tile(
                                            imageUrl = api.resolve(if (row.landscape) card.landscapeUrl ?: card.backdropUrl else card.posterUrl ?: card.landscapeUrl),
                                            fallback = card.title, landscape = row.landscape, accent = accent, coverAspect = row.coverAspect,
                                            modifier = Modifier
                                                .focusMemory(memory, tileKey(row, card), target)
                                                .then(if (rowIndex == 0 && up != null) Modifier.focusProperties { this.up = up } else Modifier),
                                            progress = card.progress?.fraction, watched = card.progress?.completed == true,
                                            label = if (row.landscape) listOfNotNull(card.title, card.subtitle).joinToString(" · ") else null,
                                            onFocus = { focused = card },
                                            onLongClick = if (card.hasMenu) ({ onMenu(card) }) else null,
                                            logoUrl = if (card.mediaType == "episode" && row.landscape) api.resolve(card.logoUrl) else null,
                                        ) { onOpen(card) }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
