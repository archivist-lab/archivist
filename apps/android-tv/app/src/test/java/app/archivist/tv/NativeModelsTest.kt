package app.archivist.tv

import app.archivist.tv.api.Bootstrap
import app.archivist.tv.api.Card
import app.archivist.tv.api.ShelfGame
import app.archivist.tv.api.ArcadeLibrary
import app.archivist.tv.retro.Cores
import app.archivist.tv.api.Destination
import app.archivist.tv.api.Hub
import app.archivist.tv.api.MediaKind
import app.archivist.tv.api.Rating
import app.archivist.tv.api.SeriesDetail
import app.archivist.tv.api.Tracks
import app.archivist.tv.api.TypeRows
import app.archivist.tv.ui.choiceKeyFor
import app.archivist.tv.ui.ShellState
import app.archivist.tv.ui.coverAspectOf
import app.archivist.tv.api.Library
import app.archivist.tv.player.QueueItem
import app.archivist.tv.ui.normalise
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeModelsTest {
    @Test fun `a hub keeps its rows in order and drops the empty ones`() {
        val hub = Hub.parse(JSONObject("""
            {"title":"Home","spotlight":null,"widgets":[
              {"id":"continue","title":"Continue Watching","view":"landscape","items":[
                {"key":"episode:4","mediaType":"episode","id":4,"route":"/series/2","title":"Pilot","subtitle":"S01E01","progress":{"positionSeconds":600,"durationSeconds":1800,"completed":false,"percent":33}}]},
              {"id":"empty","title":"Nothing","view":"poster","items":[]},
              {"id":"recent-films","title":"Recently Added Films","view":"poster","items":[
                {"key":"film:9","mediaType":"film","id":9,"route":"/film/9","title":"Alien","posterUrl":"/media/a.jpg"}]}]}
        """))
        assertEquals(listOf("continue", "recent-films"), hub.rows.map { it.id })
        assertTrue(hub.rows[0].landscape)
        assertEquals(Destination.Series(2), hub.rows[0].cards[0].destination)
        assertEquals(Destination.Film(9), hub.rows[1].cards[0].destination)
        assertEquals(1f / 3f, hub.rows[0].cards[0].progress!!.fraction, 0.001f)
    }

    @Test fun `a card with no route falls back to its type and id`() {
        val card = Card.parse(JSONObject("""{"key":"series:3","mediaType":"series","id":"3","route":"","title":"Dark"}"""))
        assertEquals(Destination.Series(3), card.destination)
        assertNull(Card.parse(JSONObject("""{"key":"x","mediaType":"album","id":1,"route":"/album/1","title":"x"}""")).destination)
    }

    @Test fun `the queue survives the trip to the player`() {
        val queue = listOf(
            QueueItem(MediaKind.EPISODE, 11, "S01E01 · Pilot", "Dark", "/api/v1/player/stream/episodes/11", 42.5, null),
            QueueItem(MediaKind.FILM, 7, "Alien", null, "/api/v1/player/stream/films/7", 0.0, 3),
        )
        assertEquals(queue, QueueItem.decode(QueueItem.encode(queue)))
    }

    @Test fun `series play through every episode with a file, in order`() {
        val series = SeriesDetail.parse(JSONObject("""
            {"id":2,"type":"series","title":"Dark","availableEpisodeCount":2,"seasons":[
              {"id":20,"seasonNumber":2,"title":"Season 2","episodes":[{"id":21,"seasonNumber":2,"episodeNumber":1,"playback":{"streamUrl":"/s/21"}}]},
              {"id":10,"seasonNumber":1,"title":"Season 1","episodes":[
                {"id":11,"seasonNumber":1,"episodeNumber":1,"playback":{"streamUrl":"/s/11"}},
                {"id":12,"seasonNumber":1,"episodeNumber":2,"playback":null}]},
              {"id":30,"seasonNumber":3,"title":"Season 3","episodes":[]}],
             "nextAvailable":{"id":11,"seasonNumber":1,"episodeNumber":1,"playback":{"streamUrl":"/s/11"}}}
        """))
        assertEquals(2, series.seasons.size)
        assertEquals(listOf(21, 11), series.playable.map { it.id })
        assertEquals("S01E01", series.next!!.code)
    }

    @Test fun `tracks read the skip markers and ignore a marker too short to skip`() {
        val tracks = Tracks.parse(JSONObject("""
            {"durationSec":2700,"video":{"codec":"hevc"},"audio":[{"index":1,"codec":"eac3","language":"eng","default":true}],
             "subtitles":[{"index":-1,"codec":"subrip","language":"eng","textBased":true}],
             "segments":{"intro":{"start":60,"end":150,"confidence":0.95},"credits":{"start":2600,"end":2600.5}}}
        """))
        assertEquals(150.0, tracks.intro!!.end, 0.0)
        assertNull(tracks.credits)
        assertEquals("hevc", tracks.videoCodec)
        assertTrue(tracks.subtitles.single().index < 0)
    }

    @Test fun `the catalogue score is halved onto the rating scale`() {
        assertEquals(3.65, Rating.catalogue(7.3)!!, 0.001)
        assertNull(Rating.catalogue(0.0))
        assertNull(Rating.catalogue(812.0))
    }

    @Test fun `an address typed on a remote becomes an origin`() {
        assertEquals("http://192.168.1.10:2424", normalise("192.168.1.10"))
        assertEquals("http://192.168.1.10:8080", normalise("192.168.1.10:8080/"))
        assertEquals("https://archive.example.org", normalise("https://archive.example.org/player/"))
        assertNull(normalise("   "))
    }

    @Test fun `the libraries arrive with the bootstrap, by type`() {
        val boot = Bootstrap.parse(JSONObject("""
            {"server":{"name":"Home"},"libraries":[
              {"id":1,"name":"Films","mediaType":"films"},{"id":7,"name":"Kids Films","mediaType":"films"},
              {"id":2,"name":"Series","mediaType":"series"},{"id":9,"name":"Animated","mediaType":"series"}],
             "preferences":{"preferences":{"playback":{"subtitles":"forced"}}}}
        """))
        assertEquals(listOf("Films", "Kids Films"), boot.libraries.filter { it.mediaType == "films" }.map { it.name })
        assertEquals(9, boot.libraries.last().id)
        assertEquals("forced", boot.prefs.subtitles)
    }

    @Test fun `a type's rows arrive with its box sets, and empty ones are dropped`() {
        val rows = TypeRows.parse(JSONObject("""
            {"type":"films","label":"Films","rows":[
               {"id":"films-recently-added","label":"Recently Added","view":"poster","items":[{"key":"film:1","mediaType":"film","id":1,"route":"/film/1","title":"A"}]},
               {"id":"films-empty","label":"Nothing","view":"poster","items":[]}],
             "boxSets":{"rowLabel":"Box Sets","themes":[
               {"id":"directors","label":"Directors","overview":null,"imageUrl":null,"sets":[
                 {"id":"nolan","label":"Christopher Nolan","overview":null,"imageUrl":"/n.jpg","items":[{"key":"film:2","mediaType":"film","id":2,"route":"/film/2","title":"B"}]}]}]}}
        """))
        assertEquals(listOf("films-recently-added"), rows.rows.map { it.id })
        assertEquals("Christopher Nolan", rows.themes.single().sets.single().label)
    }

    @Test fun `track choices are kept per film, and per series for its episodes`() {
        val episode = Card.parse(JSONObject("""{"key":"episode:4","mediaType":"episode","id":4,"route":"/series/2","title":"Dark"}"""))
        val film = Card.parse(JSONObject("""{"key":"film:7","mediaType":"film","id":7,"route":"/film/7","title":"Alien"}"""))
        assertEquals("series:2", choiceKeyFor(episode))
        assertEquals("film:7", choiceKeyFor(film))
        val queued = listOf(QueueItem(MediaKind.EPISODE, 4, "S01E01", "Dark", "/s/4", 0.0, null, "series:2"))
        assertEquals("series:2", QueueItem.decode(QueueItem.encode(queued)).single().choiceKey)
    }

    @Test fun `a type's own library leads, the rest follow A-Z, and the first is the default`() {
        val state = ShellState()
        state.libraries = listOf(
            Library(9, "Animated", "series"), Library(8, "Kids", "series"), Library(2, "Series", "series"),
            Library(7, "Kids Films", "films"), Library(1, "Films", "films"), Library(12, "Anime Films", "films"),
        )
        assertEquals(listOf("Series", "Animated", "Kids"), state.librariesOf(false).map { it.name })
        assertEquals(listOf("Films", "Anime Films", "Kids Films"), state.librariesOf(true).map { it.name })
        assertEquals(1, state.libraryFor(true)?.id)
    }

    @Test fun `a ROM's file name meets its library title without region tags`() {
        assertEquals(ShelfGame.matchKey("Super Mario World"), ShelfGame.matchKey("Super Mario World (USA) (Rev 1)"))
        assertEquals(ShelfGame.matchKey("Legend of Zelda, The - A Link to the Past"), ShelfGame.matchKey("Legend of Zelda, The - A Link to the Past [!]"))
        assertEquals("sonic and knuckles", ShelfGame.matchKey("Sonic & Knuckles (World)"))
    }

    @Test fun `every arcade system has a bundled core`() {
        for (core in listOf("nes", "snes", "gb", "segaMS", "segaMD", "n64", "psx", "segaSaturn")) {
            assertTrue(core, Cores.libraryFor(core)!!.let { it.startsWith("lib") && it.endsWith("_libretro_android.so") })
        }
        assertNull(Cores.libraryFor("arcade"))
    }

    @Test fun `a ROM arrives with what the server found for it, and the scrape's progress`() {
        val library = ArcadeLibrary.parse(JSONObject("""
            {"systems":[{"id":"snes","label":"SNES","core":"snes","bios":false,"biosReady":true,
               "platform":{"name":"Super Nintendo (SNES)","logoUrl":"/media/games/_platforms/snes/logo.png"},"roms":[
               {"name":"Super Mario World (USA)","file":"Super Mario World (USA).sfc","url":"/media/consoles/snes/roms/x.sfc","size":524288,
                "title":"Super Mario World","year":1990,"coverUrl":"/media/consoles/snes/media/covers/x.png"},
               {"name":"Unknown (USA)","file":"Unknown (USA).sfc","url":"/media/consoles/snes/roms/u.sfc","size":1}]}],
             "scrape":{"running":true,"done":40,"total":207}}
        """))
        val (smw, unknown) = library.systems.single().roms
        assertEquals("Super Mario World", smw.title)
        assertEquals(1990, smw.year)
        assertEquals("/media/consoles/snes/media/covers/x.png", smw.coverUrl)
        assertNull(unknown.title)
        assertTrue(library.scraping)
        assertEquals(40, library.scraped)
        assertEquals("/media/games/_platforms/snes/logo.png", library.systems.single().platformLogoUrl)
        assertNull(library.systems.single().platformBackdropUrl)
        assertTrue("a system says nothing of being playable when it is", library.systems.single().playable)
    }

    @Test fun `each system's tiles take the shape of its box art`() {
        assertTrue(coverAspectOf("snes") > 1f && coverAspectOf("n64") > 1f)
        assertEquals(1f, coverAspectOf("psx"), 0f)
        assertEquals(1f, coverAspectOf("gameboy"), 0f)
        assertTrue(coverAspectOf("genesis") < 1f)
        assertEquals(1f, coverAspectOf("dreamcast"), 0f)
    }

    @Test fun `every system the TV plays has its pad, and PSP has its core`() {
        assertEquals("libppsspp_libretro_android.so", Cores.libraryFor("psp"))
        for (id in listOf("nes", "snes", "gameboy", "mastersystem", "genesis", "n64", "psx", "saturn", "psp")) {
            val pad = app.archivist.tv.retro.SystemPads.of(id)!!
            // No RetroPad button named twice: each of the pad's buttons is its own.
            assertEquals(id, pad.buttons.size, pad.buttons.map { it.first }.toSet().size)
        }
        assertEquals("Cross ×", app.archivist.tv.retro.SystemPads.of("psx")!!.buttons.first { it.first == app.archivist.tv.retro.RetroButton.B }.second)
        assertEquals("L3", app.archivist.tv.retro.ControllerMapping.keyName(android.view.KeyEvent.KEYCODE_BUTTON_THUMBL))
    }
}
