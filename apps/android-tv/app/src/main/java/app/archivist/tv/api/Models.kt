package app.archivist.tv.api

import org.json.JSONObject

/** What a stream is: the API spells it three ways across its routes. */
enum class MediaKind(val streamType: String, val progressType: String) {
    FILM("films", "film"),
    EPISODE("episodes", "episode"),
}

data class Progress(val positionSeconds: Double, val durationSeconds: Double, val completed: Boolean) {
    val fraction: Float get() = if (durationSeconds > 0) (positionSeconds / durationSeconds).toFloat().coerceIn(0f, 1f) else 0f
    /** Worth offering to resume: begun, and not all but finished. */
    val resumable: Boolean get() = !completed && positionSeconds > 30 && fraction < .95f

    companion object {
        fun parse(json: JSONObject?): Progress? = json?.let {
            Progress(it.optDouble("positionSeconds", 0.0), it.optDouble("durationSeconds", 0.0), it.optBoolean("completed"))
        }
    }
}

/**
 * A tile on a home row: a film, a series, an episode, a collection — whatever
 * the server put there, already carrying its artwork, progress and route.
 */
data class Card(
    val key: String,
    val mediaType: String,
    val id: Int?,
    val route: String,
    val title: String,
    val subtitle: String?,
    val plot: String?,
    val year: Int?,
    val posterUrl: String?,
    val landscapeUrl: String?,
    val backdropUrl: String?,
    val logoUrl: String?,
    val progress: Progress?,
    val available: Boolean,
) {
    /** Films, series and episodes carry the long-press menu; a box set tile does not. */
    val hasMenu: Boolean get() = id != null && mediaType in setOf("film", "series", "episode")

    /** The series an episode card belongs to, read off its route. */
    val seriesId: Int? get() = Regex("^/series/(\\d+)").find(route)?.groupValues?.get(1)?.toInt()

    /** Where selecting it goes. */
    val destination: Destination?
        get() {
            Regex("^/film/(\\d+)").find(route)?.let { return Destination.Film(it.groupValues[1].toInt()) }
            Regex("^/series/(\\d+)").find(route)?.let { return Destination.Series(it.groupValues[1].toInt()) }
            val id = id ?: return null
            return when (mediaType) {
                "film" -> Destination.Film(id)
                "series" -> Destination.Series(id)
                else -> null
            }
        }

    companion object {
        fun parse(json: JSONObject) = Card(
            key = json.optString("key"),
            mediaType = json.optString("mediaType"),
            id = json.opt("id")?.toString()?.toIntOrNull(),
            route = json.optString("route"),
            title = json.optString("title"),
            subtitle = json.optStringOrNull("subtitle"),
            plot = json.optStringOrNull("plot"),
            year = json.optIntOrNull("year"),
            posterUrl = json.optStringOrNull("posterUrl"),
            landscapeUrl = json.optStringOrNull("landscapeUrl"),
            backdropUrl = json.optStringOrNull("backdropUrl"),
            logoUrl = json.optStringOrNull("logoUrl"),
            progress = Progress.parse(json.optJSONObject("progress")),
            available = json.optBoolean("available", true),
        )

        fun from(title: Title) = Card(
            key = "${title.type}:${title.id}", mediaType = title.type, id = title.id,
            route = if (title.type == "film") "/film/${title.id}" else "/series/${title.id}",
            title = title.title, subtitle = title.year?.toString(), plot = title.overview, year = title.year,
            posterUrl = title.posterUrl, landscapeUrl = title.backdropUrl, backdropUrl = title.backdropUrl, logoUrl = title.logoUrl,
            progress = title.progress, available = true,
        )
    }
}

sealed interface Destination {
    data class Film(val id: Int) : Destination
    data class Series(val id: Int) : Destination
    /** Everything in one library, A-Z, as a wall of tiles; null library for a type with one. */
    data class Wall(val films: Boolean, val libraryId: Int?, val title: String) : Destination
    /** One box set theme — a director, a decade — and its sets, a row each. */
    data class Theme(val theme: BoxSetTheme) : Destination
}

data class BoxSet(val id: String, val label: String, val overview: String?, val imageUrl: String?, val cards: List<Card>)
data class BoxSetTheme(val id: String, val label: String, val overview: String?, val imageUrl: String?, val sets: List<BoxSet>)

/** A type's rows as the web Player shows them, with its box sets after. */
data class TypeRows(val label: String, val rows: List<Row>, val boxSetsLabel: String, val themes: List<BoxSetTheme>) {
    companion object {
        fun parse(json: JSONObject): TypeRows {
            val boxSets = json.optJSONObject("boxSets")
            return TypeRows(
                label = json.optString("label"),
                rows = json.optJSONArray("rows").objects().map { row ->
                    Row(row.optString("id"), row.optString("label"), row.optString("view") == "landscape", row.optJSONArray("items").objects().map(Card::parse))
                }.filter { it.cards.isNotEmpty() },
                boxSetsLabel = boxSets?.optString("rowLabel")?.ifBlank { null } ?: "Box Sets",
                themes = boxSets?.optJSONArray("themes").objects().map { theme ->
                    BoxSetTheme(
                        id = theme.optString("id"), label = theme.optString("label"),
                        overview = theme.optStringOrNull("overview"), imageUrl = theme.optStringOrNull("imageUrl"),
                        sets = theme.optJSONArray("sets").objects().map { set ->
                            BoxSet(set.optString("id"), set.optString("label"), set.optStringOrNull("overview"), set.optStringOrNull("imageUrl"), set.optJSONArray("items").objects().map(Card::parse))
                        }.filter { it.cards.isNotEmpty() },
                    )
                }.filter { it.sets.isNotEmpty() },
            )
        }
    }
}

/**
 * A row of tiles. [coverAspect], when set, is the width-to-height of the row's
 * box art — a SNES box is wide, a PlayStation case square — and the row's
 * tiles take that shape, fitted rather than cropped, instead of a poster's.
 */
data class Row(val id: String, val title: String, val landscape: Boolean, val cards: List<Card>, val coverAspect: Float? = null)

data class Hub(val title: String, val spotlight: Card?, val rows: List<Row>) {
    companion object {
        fun parse(json: JSONObject) = Hub(
            title = json.optString("title", "Home"),
            spotlight = json.optJSONObject("spotlight")?.let(Card::parse),
            rows = json.optJSONArray("widgets").objects().map { widget ->
                Row(
                    id = widget.optString("id"),
                    title = widget.optString("title"),
                    landscape = widget.optString("view") == "landscape",
                    cards = widget.optJSONArray("items").objects().map(Card::parse),
                )
            }.filter { it.cards.isNotEmpty() },
        )
    }
}

/** A film or series in a list: the summary the browse and search endpoints return. */
data class Title(
    val id: Int,
    val type: String,
    val title: String,
    val sortTitle: String,
    val year: Int?,
    val overview: String?,
    val posterUrl: String?,
    val backdropUrl: String?,
    val logoUrl: String?,
    val runtimeSeconds: Int?,
    val rating: Double?,
    val certification: String?,
    val genres: List<String>,
    val resolution: String?,
    val available: Boolean,
    val progress: Progress?,
) {
    companion object {
        fun parse(json: JSONObject) = Title(
            id = json.optInt("id"),
            type = json.optString("type", "film"),
            title = json.optString("title"),
            sortTitle = json.optString("sortTitle").ifBlank { json.optString("title") },
            year = json.optIntOrNull("year"),
            overview = json.optStringOrNull("overview"),
            posterUrl = json.optStringOrNull("posterUrl"),
            backdropUrl = json.optStringOrNull("backdropUrl"),
            logoUrl = json.optStringOrNull("logoUrl"),
            runtimeSeconds = json.optIntOrNull("runtimeSeconds"),
            rating = json.optDoubleOrNull("rating"),
            certification = json.optStringOrNull("certification"),
            genres = json.optJSONArray("genres").strings(),
            resolution = json.optJSONObject("quality")?.optStringOrNull("resolution"),
            // Films say hasFile; series count what is on disk.
            available = if (json.optString("type") == "series") json.optInt("availableEpisodeCount", 1) > 0 else json.optBoolean("hasFile", true),
            progress = Progress.parse(json.optJSONObject("progress")),
        )
    }
}

data class Person(val id: String?, val name: String, val role: String?, val imageUrl: String?) {
    companion object {
        fun parse(json: JSONObject) = Person(
            id = json.opt("id")?.toString()?.takeIf { it != "null" },
            name = json.optString("name"),
            role = json.optStringOrNull("character") ?: json.optStringOrNull("role") ?: json.optStringOrNull("job"),
            imageUrl = json.optStringOrNull("profileUrl") ?: json.optStringOrNull("profilePath") ?: json.optStringOrNull("profile_path"),
        )
    }
}

data class FilmDetail(
    val title: Title,
    val streamUrl: String?,
    val studio: String?,
    val releaseDate: String?,
    val cast: List<Person>,
    val editionId: Int?,
    val videoCodec: String?,
    val audioCodec: String?,
) {
    companion object {
        fun parse(json: JSONObject) = FilmDetail(
            title = Title.parse(json),
            streamUrl = json.optJSONObject("playback")?.optStringOrNull("streamUrl"),
            studio = json.optStringOrNull("studio"),
            releaseDate = json.optStringOrNull("releaseDate"),
            cast = json.optJSONArray("cast").objects().map(Person::parse),
            editionId = json.optJSONArray("editions").objects().firstOrNull { it.optBoolean("isDefault") }?.optIntOrNull("id"),
            videoCodec = json.optJSONObject("file")?.optStringOrNull("videoCodec"),
            audioCodec = json.optJSONObject("file")?.optStringOrNull("audioCodec"),
        )
    }
}

data class Episode(
    val id: Int,
    val seasonNumber: Int,
    val episodeNumber: Int,
    val title: String,
    val overview: String?,
    val airDate: String?,
    val runtimeSeconds: Int?,
    val stillUrl: String?,
    val streamUrl: String?,
    val resolution: String?,
    val progress: Progress?,
) {
    val code: String get() = "S%02dE%02d".format(seasonNumber, episodeNumber)

    companion object {
        fun parse(json: JSONObject) = Episode(
            id = json.optInt("id"),
            seasonNumber = json.optInt("seasonNumber"),
            episodeNumber = json.optInt("episodeNumber"),
            title = json.optStringOrNull("title") ?: "Episode ${json.optInt("episodeNumber")}",
            overview = json.optStringOrNull("overview"),
            airDate = json.optStringOrNull("airDate"),
            runtimeSeconds = json.optIntOrNull("runtimeSeconds"),
            stillUrl = json.optStringOrNull("stillUrl"),
            streamUrl = json.optJSONObject("playback")?.optStringOrNull("streamUrl"),
            resolution = json.optJSONObject("quality")?.optStringOrNull("resolution"),
            progress = Progress.parse(json.optJSONObject("progress")),
        )
    }
}

data class Season(val id: Int, val number: Int, val title: String, val posterUrl: String?, val episodes: List<Episode>)

data class SeriesDetail(
    val title: Title,
    val network: String?,
    val seasons: List<Season>,
    val next: Episode?,
    val cast: List<Person>,
) {
    /** Every episode with a file, in order: what Play works through. */
    val playable: List<Episode> get() = seasons.flatMap { it.episodes }.filter { it.streamUrl != null }

    companion object {
        fun parse(json: JSONObject) = SeriesDetail(
            title = Title.parse(json),
            network = json.optStringOrNull("network"),
            seasons = json.optJSONArray("seasons").objects().map { season ->
                Season(
                    id = season.optInt("id"),
                    number = season.optInt("seasonNumber"),
                    title = season.optStringOrNull("title") ?: "Season ${season.optInt("seasonNumber")}",
                    posterUrl = season.optStringOrNull("posterUrl"),
                    episodes = season.optJSONArray("episodes").objects().map(Episode::parse),
                )
            }.filter { it.episodes.isNotEmpty() },
            next = json.optJSONObject("nextAvailable")?.let(Episode::parse),
            cast = json.optJSONArray("cast").objects().map(Person::parse),
        )
    }
}

/** `languageCode` is the file's own tag (eng, en-US); `language` is how the server names it. */
data class AudioTrack(val index: Int, val codec: String, val language: String?, val title: String?, val channels: Int?, val isDefault: Boolean, val languageCode: String? = null)
data class SubtitleTrack(val index: Int, val codec: String, val language: String?, val title: String?, val forced: Boolean, val isDefault: Boolean, val textBased: Boolean, val languageCode: String? = null)
data class Segment(val start: Double, val end: Double, val confidence: Double)

data class Tracks(
    val durationSeconds: Double?,
    val videoCodec: String?,
    val audio: List<AudioTrack>,
    val subtitles: List<SubtitleTrack>,
    val intro: Segment?,
    val credits: Segment?,
) {
    companion object {
        private fun segment(json: JSONObject?): Segment? = json?.let {
            val start = it.optDouble("start"); val end = it.optDouble("end")
            if (start.isNaN() || end.isNaN() || end <= start + 1) null else Segment(start, end, it.optDouble("confidence", 0.0))
        }

        fun parse(json: JSONObject) = Tracks(
            durationSeconds = json.optDoubleOrNull("durationSec"),
            videoCodec = json.optJSONObject("video")?.optStringOrNull("codec"),
            audio = json.optJSONArray("audio").objects().map {
                AudioTrack(it.optInt("index"), it.optString("codec"), it.optStringOrNull("language"), it.optStringOrNull("title"), it.optIntOrNull("channels"), it.optBoolean("default"), it.optStringOrNull("languageCode"))
            },
            subtitles = json.optJSONArray("subtitles").objects().map {
                SubtitleTrack(it.optInt("index"), it.optString("codec"), it.optStringOrNull("language"), it.optStringOrNull("title"), it.optBoolean("forced"), it.optBoolean("default"), it.optBoolean("textBased"), it.optStringOrNull("languageCode"))
            },
            intro = segment(json.optJSONObject("segments")?.optJSONObject("intro")),
            credits = segment(json.optJSONObject("segments")?.optJSONObject("credits")),
        )
    }
}

/** A rating on the 0-5 scale, and whose it is. */
data class Rating(val value: Double?, val source: String) {
    val own: Boolean get() = source == "own"

    companion object {
        fun parse(json: JSONObject) = Rating(json.optDoubleOrNull("value"), json.optString("source", "none"))
        /** The catalogue's 0-10 score on the 0-5 scale, or null for no score. */
        fun catalogue(score: Double?): Double? = score?.takeIf { it > 0 && it <= 10 }?.let { Math.round(it * 50) / 100.0 }
    }
}

data class PlaybackPrefs(val audioLanguage: String?, val subtitleLanguage: String?, val subtitles: String)

/** A library of one type — a server can split films across several, as the web Player's menu shows. */
data class Library(val id: Int, val name: String, val mediaType: String)

data class Bootstrap(val serverName: String?, val prefs: PlaybackPrefs, val libraries: List<Library> = emptyList()) {
    companion object {
        fun parse(json: JSONObject): Bootstrap {
            val playback = json.optJSONObject("preferences")?.optJSONObject("preferences")?.optJSONObject("playback")
            return Bootstrap(
                libraries = json.optJSONArray("libraries").objects().map { Library(it.optInt("id"), it.optString("name"), it.optString("mediaType")) },
                serverName = json.optJSONObject("server")?.optStringOrNull("name"),
                prefs = PlaybackPrefs(
                    audioLanguage = playback?.optStringOrNull("preferredAudioLanguage"),
                    subtitleLanguage = playback?.optStringOrNull("preferredSubtitleLanguage"),
                    subtitles = playback?.optString("subtitles", "off") ?: "off",
                ),
            )
        }
    }
}
