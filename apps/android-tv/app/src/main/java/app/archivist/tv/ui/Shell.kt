package app.archivist.tv.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.focusable
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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyGridState
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.ui.platform.LocalContext
import app.archivist.tv.TrackChoices
import app.archivist.tv.api.BoxSetTheme
import app.archivist.tv.api.TypeRows
import app.archivist.tv.api.ArcadeRom
import app.archivist.tv.api.ArcadeLibrary
import app.archivist.tv.api.ArcadeSystem
import app.archivist.tv.api.ShelfGame
import app.archivist.tv.api.ApiException
import app.archivist.tv.api.ArchivistApi
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onKeyEvent
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Text
import app.archivist.tv.Connection
import app.archivist.tv.api.Card
import app.archivist.tv.api.Destination
import app.archivist.tv.api.Hub
import app.archivist.tv.api.Library
import app.archivist.tv.api.Rating
import app.archivist.tv.api.Title
import app.archivist.tv.player.QueueItem
import kotlinx.coroutines.delay

enum class Tab(val label: String, val accent: Color) {
    HOME("Home", Color.White), FILMS("Films", Palette.film), SERIES("Series", Palette.series), GAMES("Games", Palette.games), SEARCH("Search", Palette.pink), SETTINGS("Settings", Color.White)
}

/** What the shell hands every screen: the server, and the ways out of a screen. */
class Actions(
    val connection: Connection,
    val open: (Destination) -> Unit,
    val play: (List<QueueItem>, Int) -> Unit,
    /** Long press on a tile: its quick menu. */
    val menu: (Card) -> Unit,
)

/** State that outlives a visit to a screen, so Back returns to the same place. */
class ShellState {
    var hub by mutableStateOf<Hub?>(null)
    val homeList = LazyListState()
    val homeFocus = FocusMemory()
    /** The server's libraries, by type — films and series can each be split across several. */
    var libraries by mutableStateOf<List<Library>>(emptyList())
    /** Which library of each type is open; unset means the first. */
    val chosenLibrary = mutableStateMapOf<Boolean, Int>()
    /** Each library keeps its own rows, wall, scroll and focus, so switching back returns to the same place. */
    val typeRows = mutableStateMapOf<String, TypeRows>()
    val titles = mutableStateMapOf<String, List<Title>>()
    private val grids = mutableMapOf<String, LazyGridState>()
    private val lists = mutableMapOf<String, LazyListState>()
    private val memories = mutableMapOf<String, FocusMemory>()
    fun grid(key: String) = grids.getOrPut(key) { LazyGridState() }
    fun list(key: String) = lists.getOrPut(key) { LazyListState() }
    fun memory(key: String) = memories.getOrPut(key) { FocusMemory() }

    /**
     * A type's libraries in menu order: the one named for the type itself —
     * "Films", "Series" — first, as the default, then the rest A-Z.
     */
    fun librariesOf(films: Boolean): List<Library> {
        val typeName = if (films) "films" else "series"
        return libraries.filter { it.mediaType == typeName }
            .sortedWith(compareBy<Library>({ !it.name.trim().equals(typeName, ignoreCase = true) }, { it.name.lowercase() }))
    }
    /** The open library of a type, or null for a type the server does not split. */
    fun libraryFor(films: Boolean): Library? {
        val own = librariesOf(films)
        if (own.size < 2) return null
        return own.firstOrNull { it.id == chosenLibrary[films] } ?: own.first()
    }
    fun libraryKey(films: Boolean, libraryId: Int? = libraryFor(films)?.id) = "${if (films) "films" else "series"}:${libraryId ?: "all"}"
    var searchQuery by mutableStateOf("")
    val navFocus = FocusMemory()
    /** The arcade's systems, and the Games library's titles keyed for matching ROMs to their covers. */
    var arcade by mutableStateOf<Pair<ArcadeLibrary, Map<String, ShelfGame>>?>(null)
}

private val NAV_HEIGHT = 64.dp

@Composable
fun Shell(connection: Connection, refresh: Int, onPlay: (List<QueueItem>, Int) -> Unit, onGame: (ArcadeSystem, ArcadeRom) -> Unit, onSwitchServer: () -> Unit, onSignOut: () -> Unit, onWebPlayer: () -> Unit) {
    val state = remember(connection) { ShellState() }
    var tab by remember { mutableStateOf(Tab.HOME) }
    val stack = remember { mutableStateListOf<Destination>() }
    var menuFor by remember { mutableStateOf<Card?>(null) }
    // Bumped when the quick menu changes something, so screens reload it.
    var changes by remember { mutableIntStateOf(0) }
    // Bumped when the quick menu closes, so the screen puts focus back on the tile it came from.
    var reclaim by remember { mutableIntStateOf(0) }
    /*
     * When the remote last moved. Arriving on a menu item opens its tab — but
     * only when the viewer moved there. Focus that merely falls to the menu, as
     * it does when the tile holding it disappears in a reload, must not switch
     * the screen out from under them.
     */
    val lastMove = remember { longArrayOf(0L) }
    // Down from Films or Series lands on the first library, whichever sits beneath.
    val firstLibrary = remember { FocusRequester() }
    // Up from a library returns to its own type in the menu, not whatever sits above it.
    val navRequesters = remember { Tab.entries.associateWith { FocusRequester() } }
    // Up from the top row of tiles returns to the library showing.
    val openLibrary = remember { FocusRequester() }
    val context = LocalContext.current
    val choices = remember { TrackChoices(context) }
    val actions = remember(connection) { Actions(connection, open = { stack.add(it) }, play = onPlay, menu = { menuFor = it }) }
    val reload = refresh + changes

    fun memoryFor(current: Tab) = when (current) {
        Tab.FILMS -> state.memory("rows:" + state.libraryKey(true))
        Tab.SERIES -> state.memory("rows:" + state.libraryKey(false))
        else -> state.homeFocus
    }
    /** The wall of a type's open library: everything in it, A-Z. */
    fun openWall(films: Boolean) {
        val library = state.libraryFor(films)
        stack.add(Destination.Wall(films, library?.id, library?.name ?: if (films) "Films" else "Series"))
    }
    LaunchedEffect(connection) {
        runCatching { connection.api.bootstrap().libraries }.onSuccess { state.libraries = it }
    }

    BackHandler(enabled = stack.isNotEmpty()) {
        val left = stack.removeAt(stack.lastIndex)
        if (left is Destination.Wall) state.memory(state.libraryKey(left.films, left.libraryId)).restoreOnReturn()
        if (stack.isEmpty()) memoryFor(tab).restoreOnReturn()
        else (stack.last() as? Destination.Wall)?.let { state.memory(state.libraryKey(it.films, it.libraryId)).restoreOnReturn() }
    }
    BackHandler(enabled = stack.isEmpty() && tab != Tab.HOME) { tab = Tab.HOME }

    menuFor?.let { card ->
        ItemMenu(card, connection.api, choices, accent = accentFor(card), onDismiss = { menuFor = null; reclaim++ }, onChanged = { changes++ })
    }

    val top = stack.lastOrNull()
    if (top != null) {
        when (top) {
            is Destination.Film -> FilmPage(actions, top.id, reload)
            is Destination.Series -> SeriesPage(actions, top.id, reload)
            is Destination.Wall -> WallPage(actions, top, state, reload, reclaim)
            is Destination.Theme -> ThemePage(actions, top.theme, state, reclaim)
        }
        return
    }

    Box(Modifier.fillMaxSize().background(Palette.canvas).onPreviewKeyEvent {
        if (it.type == KeyEventType.KeyDown && it.key in DIRECTIONS) lastMove[0] = android.os.SystemClock.uptimeMillis()
        false
    }) {
        // Where Up goes from a type screen's top row: the library showing, or
        // the type in the menu when it has only one library.
        val typeUp = if ((tab == Tab.FILMS || tab == Tab.SERIES) && state.librariesOf(tab == Tab.FILMS).size > 1) openLibrary else navRequesters.getValue(tab)
        when (tab) {
            Tab.HOME -> HomeScreen(actions, state, reload, reclaim)
            Tab.FILMS -> TypeScreen(actions, films = true, state, reload, reclaim, typeUp)
            Tab.SERIES -> TypeScreen(actions, films = false, state, reload, reclaim, typeUp)
            Tab.GAMES -> GamesScreen(actions, state, reload, navRequesters.getValue(Tab.GAMES), onGame)
            Tab.SEARCH -> SearchScreen(actions, state)
            Tab.SETTINGS -> SettingsScreen(connection, onSwitchServer, onSignOut, onWebPlayer)
        }
        // The menu, over the top of every screen. Arriving on an item goes
        // there, as the web Player's menu does; OK on Films or Series opens
        // the wall of the library showing.
        Row(
            Modifier.fillMaxWidth().height(NAV_HEIGHT).background(androidx.compose.ui.graphics.Brush.verticalGradient(listOf(Palette.canvas.copy(alpha = .9f), Color.Transparent))).padding(start = 48.dp, top = 18.dp),
            horizontalArrangement = Arrangement.spacedBy(30.dp),
        ) {
            Tab.entries.forEach { entry ->
                val libraryRowBelow = (entry == Tab.FILMS || entry == Tab.SERIES) && entry == tab && state.librariesOf(entry == Tab.FILMS).size > 1
                NavItem(entry, selected = entry == tab, memory = state.navFocus, requester = navRequesters.getValue(entry), down = if (libraryRowBelow) firstLibrary else null,
                    onClick = if (entry == Tab.FILMS || entry == Tab.SERIES) ({ openWall(entry == Tab.FILMS) }) else null) {
                    if (tab != entry && android.os.SystemClock.uptimeMillis() - lastMove[0] < 800) tab = entry
                }
            }
        }
        // The libraries of the open type, under the menu, as the web Player
        // draws them: arriving on one narrows the rows to it, OK opens its wall.
        if (tab == Tab.FILMS || tab == Tab.SERIES) {
            val films = tab == Tab.FILMS
            val own = state.librariesOf(films)
            if (own.size > 1) {
                val open = state.libraryFor(films)
                Row(Modifier.padding(start = 48.dp, top = NAV_HEIGHT).height(LIBRARY_ROW_HEIGHT), horizontalArrangement = Arrangement.spacedBy(24.dp)) {
                    own.forEachIndexed { index, library ->
                        val up = navRequesters.getValue(tab)
                        LibraryItem(library.name, selected = library.id == open?.id, accent = tab.accent,
                            modifier = Modifier
                                .then(if (index == 0) Modifier.focusRequester(firstLibrary) else Modifier)
                                .then(if (library.id == open?.id) Modifier.focusRequester(openLibrary) else Modifier)
                                .focusProperties { this.up = up },
                            onClick = { state.chosenLibrary[films] = library.id; openWall(films) }) { state.chosenLibrary[films] = library.id }
                    }
                }
            }
        }
    }
}

private val DIRECTIONS = setOf(Key.DirectionLeft, Key.DirectionRight, Key.DirectionUp, Key.DirectionDown)

private fun accentFor(card: Card) = when (card.mediaType) { "film" -> Palette.film; "series", "episode" -> Palette.series; else -> Color.White }

private val LIBRARY_ROW_HEIGHT = 34.dp

/** Focusable text that reacts to OK: the menu's and the library row's items. */
private fun Modifier.onOk(onClick: (() -> Unit)?): Modifier = if (onClick == null) this else onKeyEvent {
    val ok = it.key == Key.DirectionCenter || it.key == Key.Enter || it.key == Key.NumPadEnter
    if (ok && it.type == KeyEventType.KeyUp) onClick()
    ok
}

@Composable
private fun LibraryItem(name: String, selected: Boolean, accent: Color, modifier: Modifier = Modifier, onClick: () -> Unit, onFocus: () -> Unit) {
    var focused by remember { mutableStateOf(false) }
    Column(modifier.onFocusChanged { focused = it.isFocused; if (it.isFocused) onFocus() }.onOk(onClick).focusable()) {
        Text(name.uppercase(), style = MaterialTheme.typography.headlineSmall.copy(fontSize = 19.sp, letterSpacing = 2.sp),
            color = if (selected || focused) accent else Palette.dim)
        Box(Modifier.padding(top = 3.dp).height(2.dp).width(if (focused) 28.dp else 0.dp).background(accent, RoundedCornerShape(2.dp)))
    }
}

@Composable
private fun NavItem(tab: Tab, selected: Boolean, memory: FocusMemory, requester: FocusRequester, down: FocusRequester? = null, onClick: (() -> Unit)? = null, onFocus: () -> Unit) {
    var focused by remember { mutableStateOf(false) }
    Column(
        Modifier
            .focusRequester(requester)
            .focusProperties { if (down != null) this.down = down }
            .focusMemory(memory, tab.name)
            .onFocusChanged { focused = it.isFocused; if (it.isFocused) onFocus() }
            .onOk(onClick)
            .focusable(),
    ) {
        Text(tab.label.uppercase(), style = MaterialTheme.typography.headlineSmall.copy(fontSize = 28.sp, letterSpacing = 2.5.sp),
            color = if (selected || focused) tab.accent else Palette.dim)
        Box(Modifier.padding(top = 5.dp).height(3.dp).width(if (focused) 36.dp else 0.dp).background(tab.accent, RoundedCornerShape(2.dp)))
    }
}

// ── Home ─────────────────────────────────────────────────────────────────────

@Composable
private fun HomeScreen(actions: Actions, state: ShellState, refresh: Int, reclaim: Int) {
    val api = actions.connection.api
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(refresh) {
        runCatching { api.hub("home") }.onSuccess { state.hub = it; error = null }.onFailure { if (state.hub == null) error = it.message ?: "Could not load Home" }
    }
    val hub = state.hub
    if (hub == null) { Box(Modifier.fillMaxSize()) { Notice(error ?: "Opening the archive…") }; return }
    RowsBrowser(api, hub.rows, hub.spotlight, state.homeList, state.homeFocus, NAV_HEIGHT + 12.dp, Color.White,
        onOpen = { card -> card.destination?.let(actions.open) }, onMenu = actions.menu, reclaim = reclaim)
}

// ── Films and Series ─────────────────────────────────────────────────────────

/**
 * A type's own screen: its rows as the web Player shows them — Recently
 * Added, Recently Released, Next Up and whatever else the server is set to —
 * with the box sets last. The library row above narrows them; OK on it opens
 * the whole library as a wall.
 */
@Composable
private fun TypeScreen(actions: Actions, films: Boolean, state: ShellState, refresh: Int, reclaim: Int, up: FocusRequester) {
    val api = actions.connection.api
    val library = state.libraryFor(films)
    val key = state.libraryKey(films)
    var error by remember(key) { mutableStateOf<String?>(null) }
    LaunchedEffect(key, refresh) {
        runCatching { api.typeRows(films, library?.id) }
            // A server from before type rows existed answers 404: build the
            // screen from what it does have rather than show nothing at all.
            .recoverCatching { failure -> if ((failure as? ApiException)?.status == 404) fallbackRows(api, films, library?.id) else throw failure }
            .onSuccess { state.typeRows[key] = it; error = null }
            .onFailure { if (state.typeRows[key] == null) error = it.message ?: "Could not load the rows" }
    }
    val topInset = NAV_HEIGHT + 12.dp + if (library != null) LIBRARY_ROW_HEIGHT else 0.dp
    val loaded = state.typeRows[key]
    if (loaded == null) { Box(Modifier.fillMaxSize()) { Notice(error ?: "Opening the library…") }; return }
    // Box sets: one row of theme tiles, each opening its sets.
    val themes = loaded.themes.associateBy { "theme:${it.id}" }
    val rows = if (themes.isEmpty()) loaded.rows else loaded.rows + app.archivist.tv.api.Row(
        id = "box-sets", title = loaded.boxSetsLabel, landscape = true,
        cards = loaded.themes.map { theme ->
            Card(key = "theme:${theme.id}", mediaType = "theme", id = null, route = "", title = theme.label,
                subtitle = "${theme.sets.size} set${if (theme.sets.size == 1) "" else "s"}", plot = theme.overview, year = null,
                posterUrl = theme.imageUrl, landscapeUrl = theme.imageUrl, backdropUrl = theme.imageUrl, logoUrl = null, progress = null, available = true)
        },
    )
    RowsBrowser(api, rows, null, state.list("rows:$key"), state.memory("rows:$key"), topInset, if (films) Palette.film else Palette.series,
        onOpen = { card -> themes[card.key]?.let { actions.open(Destination.Theme(it)) } ?: card.destination?.let(actions.open) },
        onMenu = actions.menu, reclaim = reclaim, up = up)
}

/**
 * A type's rows from an older server: Home's rows narrowed to this type —
 * Continue Watching, Recently Added, New Episodes — and the library A-Z.
 */
private suspend fun fallbackRows(api: ArchivistApi, films: Boolean, library: Int?): TypeRows {
    val wanted = if (films) setOf("film") else setOf("series", "episode")
    val home = runCatching { api.hub("home") }.getOrNull()?.rows.orEmpty()
        .map { row -> row.copy(id = "home-${row.id}", cards = row.cards.filter { it.mediaType in wanted }) }
        .filter { it.cards.isNotEmpty() }
    val all = (if (films) api.films(library) else api.series(library)).filter { it.available }.sortedBy { it.sortTitle.lowercase() }
    val everything = app.archivist.tv.api.Row(if (films) "all-films" else "all-series", if (films) "All films" else "All series", false, all.map(Card::from))
    return TypeRows(if (films) "Films" else "Series", home + listOf(everything).filter { it.cards.isNotEmpty() }, "Box Sets", emptyList())
}

/**
 * The retro games: a row for each of the arcade's systems, of the ROMs in its
 * folder on the server, with cover art and an overview borrowed from the Games
 * library where a title matches. OK starts one on the native emulator.
 */
@Composable
private fun GamesScreen(actions: Actions, state: ShellState, refresh: Int, up: FocusRequester, onGame: (ArcadeSystem, ArcadeRom) -> Unit) {
    val api = actions.connection.api
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(refresh) {
        val covers = runCatching { api.gameShelf() }.getOrDefault(emptyList()).associateBy { ShelfGame.matchKey(it.title) }
        // While the server is looking up new ROMs, the shelf is read again every
        // so often, so their box art arrives without leaving the tab.
        while (true) {
            runCatching { api.arcadeLibrary() }
                .onSuccess { state.arcade = it to covers; error = null }
                .onFailure { if (state.arcade == null) error = it.message ?: "Could not load the games" }
            if (state.arcade?.first?.scraping != true) break
            kotlinx.coroutines.delay(15_000)
        }
    }
    val loaded = state.arcade
    if (loaded == null) { Box(Modifier.fillMaxSize()) { Notice(error ?: "Opening the arcade…") }; return }
    val (library, covers) = loaded
    val systems = library.systems
    val launch = remember(systems) { mutableMapOf<String, Pair<ArcadeSystem, ArcadeRom>>() }
    val rows = remember(systems, covers) {
        systems.filter { it.roms.isNotEmpty() }.map { system ->
            app.archivist.tv.api.Row(system.id, system.label + if (!system.biosReady) " · BIOS needed" else "", false, coverAspect = coverAspectOf(system.id), cards = system.roms.map { rom ->
                // What the server knows of the ROM first — its gamelist.xml entry or
                // what was scraped for it — then a Games library title of that name.
                val game = covers[ShelfGame.matchKey(rom.name)]
                val key = "rom:${system.id}:${rom.file}"
                launch[key] = system to rom
                val backdrop = rom.backdropUrl ?: game?.backdropUrl
                Card(key = key, mediaType = "rom", id = null, route = "",
                    title = rom.title ?: rom.name.replace(Regex("\\s*[\\[(][^\\])]*[\\])]"), "").trim().ifBlank { rom.name },
                    subtitle = system.label, plot = rom.overview ?: game?.overview, year = rom.year ?: game?.year,
                    posterUrl = rom.coverUrl ?: game?.posterUrl, landscapeUrl = backdrop, backdropUrl = backdrop, logoUrl = rom.logoUrl, progress = null, available = true)
            })
        }
    }
    if (rows.isEmpty()) {
        // An unreadable folder is not an empty one: say which, and why.
        val unreadable = systems.firstOrNull { it.scanError != null }
        Box(Modifier.fillMaxSize()) {
            Notice(if (unreadable != null) "${unreadable.scanError}. Fix the folder’s owner on the server and try again."
                else "No games yet — put ROMs in media/roms/<system> on the server")
        }
        return
    }
    Box(Modifier.fillMaxSize()) {
        RowsBrowser(api, rows, null, state.list("games"), state.memory("games"), NAV_HEIGHT + 12.dp, Palette.games,
            onOpen = { card -> launch[card.key]?.let { (system, rom) -> onGame(system, rom) } }, onMenu = {}, up = up)
        if (library.scraping) {
            Text("Finding box art · ${library.scraped} of ${library.toScrape}", style = MaterialTheme.typography.labelLarge, color = Palette.dim,
                modifier = Modifier.align(Alignment.BottomEnd).padding(end = 48.dp, bottom = 18.dp))
        }
    }
}

/**
 * The shape of a system's box art, width over height: a SNES or N64 box is
 * wide, a PlayStation case and a Game Boy box are square, and the rest are
 * the tall boxes a poster tile already fits.
 */
internal fun coverAspectOf(system: String): Float = when (system) {
    "snes", "n64" -> 1.4f
    "psx", "gameboy" -> 1f
    "nes", "genesis", "mastersystem", "saturn" -> 0.72f
    else -> 2f / 3f
}

/** A box set theme: each of its sets as a row. */
@Composable
private fun ThemePage(actions: Actions, theme: BoxSetTheme, state: ShellState, reclaim: Int) {
    val rows = remember(theme) { theme.sets.map { set -> app.archivist.tv.api.Row(set.id, set.label, false, set.cards) } }
    Box(Modifier.fillMaxSize()) {
        RowsBrowser(actions.connection.api, rows, null, state.list("theme:${theme.id}"), state.memory("theme:${theme.id}"), 28.dp, Color.White,
            onOpen = { card -> card.destination?.let(actions.open) }, onMenu = actions.menu, reclaim = reclaim)
        Text(theme.label.uppercase(), style = MaterialTheme.typography.labelLarge, color = Palette.dim, modifier = Modifier.padding(start = 48.dp, top = 14.dp))
    }
}

/** A whole library, A-Z, as a wall of posters. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun WallPage(actions: Actions, wall: Destination.Wall, state: ShellState, refresh: Int, reclaim: Int) {
    val api = actions.connection.api
    val films = wall.films
    val accent = if (films) Palette.film else Palette.series
    val key = state.libraryKey(films, wall.libraryId)
    var error by remember(key) { mutableStateOf<String?>(null) }
    LaunchedEffect(key, refresh) {
        runCatching { if (films) api.films(wall.libraryId) else api.series(wall.libraryId) }
            .onSuccess { list -> state.titles[key] = list.filter { it.available }.sortedBy { it.sortTitle.lowercase() }; error = null }
            .onFailure { if (state.titles[key] == null) error = it.message ?: "Could not load the library" }
    }
    val items = state.titles[key]
    // Back on the tile the quick menu came from; a wall keeps every title, so it is still there.
    LaunchedEffect(reclaim) { if (reclaim > 0) state.memory(key).restoreOnReturn() }
    if (items == null) { Box(Modifier.fillMaxSize().background(Palette.canvas)) { Notice(error ?: "Opening the library…") }; return }
    var focused by remember(key) { mutableStateOf<Title?>(null) }
    val shown = focused ?: items.firstOrNull()
    val backdrop = settled(api.resolve(shown?.backdropUrl))
    val density = LocalDensity.current
    Box(Modifier.fillMaxSize()) {
        Backdrop(backdrop)
        Column(Modifier.fillMaxSize()) {
            Text("${wall.title.uppercase()}  ·  A–Z  ·  ${items.size}", style = MaterialTheme.typography.labelLarge, color = accent, modifier = Modifier.padding(start = 48.dp, top = 22.dp))
            Box(Modifier.height(230.dp).padding(start = 48.dp, top = 8.dp)) {
                if (shown != null) Hero(shown.title, api.resolve(shown.logoUrl), titleFacts(shown), shown.overview, accent, plotLines = 3)
            }
            if (items.isEmpty()) { Box(Modifier.fillMaxSize()) { Notice("Nothing here yet") }; return@Column }
            CompositionLocalProvider(LocalBringIntoViewSpec provides pinToTop(with(density) { 12.dp.toPx() })) {
                LazyVerticalGrid(
                    columns = GridCells.Adaptive(86.dp),
                    state = state.grid(key),
                    modifier = Modifier.fillMaxWidth().weight(1f),
                    contentPadding = PaddingValues(start = 48.dp, end = 48.dp, top = 12.dp, bottom = 80.dp),
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                    verticalArrangement = Arrangement.spacedBy(14.dp),
                ) {
                    items(items, key = { it.id }) { title ->
                        Tile(
                            imageUrl = api.resolve(title.posterUrl), fallback = title.title, landscape = false, accent = accent,
                            modifier = Modifier.focusMemory(state.memory(key), "${title.id}"),
                            progress = title.progress?.fraction, watched = title.progress?.completed == true,
                            onFocus = { focused = title },
                            onLongClick = { actions.menu(Card.from(title)) },
                        ) { actions.open(if (films) Destination.Film(title.id) else Destination.Series(title.id)) }
                    }
                }
            }
        }
    }
}

fun titleFacts(title: Title): List<String> = listOfNotNull(
    title.year?.toString(), formatRuntime(title.runtimeSeconds), title.certification, title.resolution,
    Rating.catalogue(title.rating)?.let { "★ %.1f".format(it) },
) + title.genres.take(2)

// ── Search ───────────────────────────────────────────────────────────────────

@Composable
private fun SearchScreen(actions: Actions, state: ShellState) {
    val api = actions.connection.api
    var results by remember { mutableStateOf<List<Title>>(emptyList()) }
    var searching by remember { mutableStateOf(false) }
    var fieldFocused by remember { mutableStateOf(false) }
    LaunchedEffect(state.searchQuery) {
        val query = state.searchQuery.trim()
        if (query.length < 2) { results = emptyList(); return@LaunchedEffect }
        delay(350)
        searching = true
        results = runCatching { api.search(query) }.getOrDefault(emptyList()).filter { it.type == "film" || it.type == "series" }
        searching = false
    }
    Column(Modifier.fillMaxSize().padding(start = 48.dp, end = 48.dp, top = NAV_HEIGHT + 20.dp)) {
        BasicTextField(
            value = state.searchQuery,
            onValueChange = { state.searchQuery = it },
            singleLine = true,
            textStyle = TextStyle(color = Palette.text, fontSize = 22.sp, fontFamily = Sans),
            cursorBrush = SolidColor(Palette.pink),
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
            decorationBox = { inner ->
                Box {
                    if (state.searchQuery.isEmpty()) Text("Search films and series", color = Palette.dim, fontSize = 22.sp, fontFamily = Sans)
                    inner()
                }
            },
            modifier = Modifier
                .fillMaxWidth()
                .onFocusChanged { fieldFocused = it.isFocused }
                .background(Palette.panel, RoundedCornerShape(10.dp))
                .border(2.dp, if (fieldFocused) Palette.pink else Palette.faint, RoundedCornerShape(10.dp))
                .padding(horizontal = 20.dp, vertical = 14.dp),
        )
        Text(
            when {
                searching -> "Searching…"
                state.searchQuery.trim().length >= 2 && results.isEmpty() -> "No matches"
                results.isNotEmpty() -> "${results.size} results"
                else -> "Press OK to type"
            },
            style = MaterialTheme.typography.labelMedium, color = Palette.dim, modifier = Modifier.padding(vertical = 14.dp),
        )
        LazyVerticalGrid(
            columns = GridCells.Adaptive(86.dp),
            contentPadding = PaddingValues(bottom = 60.dp),
            horizontalArrangement = Arrangement.spacedBy(16.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp),
        ) {
            items(results, key = { "${it.type}:${it.id}" }) { title ->
                val accent = if (title.type == "film") Palette.film else Palette.series
                Tile(imageUrl = api.resolve(title.posterUrl), fallback = title.title, landscape = false, accent = accent,
                    label = listOfNotNull(title.title, title.year?.toString()).joinToString(" · "),
                    onLongClick = { actions.menu(Card.from(title)) }) {
                    actions.open(if (title.type == "film") Destination.Film(title.id) else Destination.Series(title.id))
                }
            }
        }
    }
}

// ── Settings ─────────────────────────────────────────────────────────────────

@Composable
private fun SettingsScreen(connection: Connection, onSwitchServer: () -> Unit, onSignOut: () -> Unit, onWebPlayer: () -> Unit) {
    Column(Modifier.fillMaxSize().padding(start = 48.dp, top = NAV_HEIGHT + 28.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Text(connection.server.name, style = MaterialTheme.typography.displayMedium, color = Palette.text)
        Text("${connection.url}  ·  ${if (connection.via == "home") "home network" else "away address"}", style = MaterialTheme.typography.labelLarge, color = Palette.dim)
        Spacer(Modifier.height(8.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(14.dp), verticalAlignment = Alignment.CenterVertically) {
            ActionButton("Music, books & games (web Player)", Palette.film, primary = true) { onWebPlayer() }
            ActionButton("Switch server", Palette.film) { onSwitchServer() }
            ActionButton("Sign out of this TV", Palette.pink) { onSignOut() }
        }
        Text("Films and series are native in this app. Music, books, games and the Player’s own settings open in the web Player.",
            style = MaterialTheme.typography.bodyLarge, color = Palette.muted, modifier = Modifier.width(620.dp))
    }
}

/** Swallows OK so a key that opened something is not also read by what it opened. */
fun Modifier.consumeOk(): Modifier = onKeyEvent { it.type == KeyEventType.KeyUp && (it.key == Key.DirectionCenter || it.key == Key.Enter) }
