package app.archivist.tv.api

import org.json.JSONObject

/**
 * A ROM in a system's folder on the server (`media/roms/<system>/`), with what
 * the server knows of it: its gamelist.xml entry, or what its scraper found.
 */
data class ArcadeRom(
    val name: String,
    val file: String,
    val url: String,
    val size: Long,
    val title: String? = null,
    val overview: String? = null,
    val year: Int? = null,
    val coverUrl: String? = null,
    val backdropUrl: String? = null,
    val logoUrl: String? = null,
) {
    companion object {
        fun parse(json: JSONObject) = ArcadeRom(
            name = json.optString("name"),
            file = json.optString("file"),
            url = json.optString("url"),
            size = json.optLong("size"),
            title = json.optStringOrNull("title"),
            overview = json.optStringOrNull("overview"),
            year = json.optIntOrNull("year"),
            coverUrl = json.optStringOrNull("coverUrl"),
            backdropUrl = json.optStringOrNull("backdropUrl"),
            logoUrl = json.optStringOrNull("logoUrl"),
        )
    }
}

/** The arcade shelf, and how far the server's look-up of new ROMs has got. */
data class ArcadeLibrary(val systems: List<ArcadeSystem>, val scraping: Boolean, val scraped: Int, val toScrape: Int) {
    companion object {
        fun parse(json: JSONObject): ArcadeLibrary {
            val scrape = json.optJSONObject("scrape")
            return ArcadeLibrary(
                systems = json.optJSONArray("systems").objects().map(ArcadeSystem::parse),
                scraping = scrape?.optBoolean("running") ?: false,
                scraped = scrape?.optInt("done") ?: 0,
                toScrape = scrape?.optInt("total") ?: 0,
            )
        }
    }
}

/**
 * One of the arcade's systems. `core` is the web Player's EmulatorJS name for
 * it; the native app maps that to a bundled libretro core (see retro/Cores).
 */
data class ArcadeSystem(
    val id: String,
    val label: String,
    val core: String,
    val needsBios: Boolean,
    val biosUrl: String?,
    val biosReady: Boolean,
    val roms: List<ArcadeRom>,
    /** Why the server could not read this system's folder, when it could not. */
    val scanError: String? = null,
) {
    companion object {
        fun parse(json: JSONObject) = ArcadeSystem(
            id = json.optString("id"),
            label = json.optString("label"),
            core = json.optString("core"),
            needsBios = json.optBoolean("bios"),
            biosUrl = json.optStringOrNull("biosUrl"),
            biosReady = json.optBoolean("biosReady", true),
            roms = json.optJSONArray("roms").objects().map(ArcadeRom::parse),
            scanError = json.optStringOrNull("scanError"),
        )
    }
}

/** A title in the Games library: artwork and an overview a ROM can borrow. */
data class ShelfGame(val title: String, val posterUrl: String?, val backdropUrl: String?, val overview: String?, val year: Int?) {
    companion object {
        fun parse(json: JSONObject) = ShelfGame(
            json.optString("title"), json.optStringOrNull("posterUrl"), json.optStringOrNull("backdropUrl"),
            json.optStringOrNull("overview"), json.optIntOrNull("year"),
        )

        /**
         * How a ROM's file name and a library title are compared: region tags,
         * revisions and punctuation dropped — `Super Mario World (USA) (Rev 1)`
         * is `super mario world`.
         */
        fun matchKey(name: String): String = name
            .replace(Regex("\\s*[\\[(][^\\])]*[\\])]"), " ")
            .lowercase()
            .replace("&", " and ")
            .replace(Regex("[^a-z0-9]+"), " ")
            .replace(Regex("^the "), "")
            .trim()
    }
}
