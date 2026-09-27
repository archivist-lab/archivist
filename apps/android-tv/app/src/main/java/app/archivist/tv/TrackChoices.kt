package app.archivist.tv

import android.content.Context

/**
 * Audio and subtitle choices made from a tile's menu, kept per film or per
 * series, and applied when it plays. A language rather than a track number:
 * every episode of a series is its own file, and the same language is what
 * carries from one to the next.
 */
data class TrackChoice(val audioLanguage: String?, val subtitles: Subtitles) {
    sealed interface Subtitles {
        /** The profile's own rule — forced subtitles only, usually. */
        data object Default : Subtitles
        data object Off : Subtitles
        data class Language(val code: String) : Subtitles
    }
}

class TrackChoices(context: Context) {
    private val prefs = context.getSharedPreferences("track-choices", Context.MODE_PRIVATE)

    fun get(key: String): TrackChoice {
        val audio = prefs.getString("$key:audio", null)
        val subs = when (val raw = prefs.getString("$key:subs", null)) {
            null, "" -> TrackChoice.Subtitles.Default
            "off" -> TrackChoice.Subtitles.Off
            else -> TrackChoice.Subtitles.Language(raw)
        }
        return TrackChoice(audio, subs)
    }

    fun setAudio(key: String, language: String?) = prefs.edit().apply { if (language == null) remove("$key:audio") else putString("$key:audio", language) }.apply()

    fun setSubtitles(key: String, subtitles: TrackChoice.Subtitles) = prefs.edit().apply {
        when (subtitles) {
            TrackChoice.Subtitles.Default -> remove("$key:subs")
            TrackChoice.Subtitles.Off -> putString("$key:subs", "off")
            is TrackChoice.Subtitles.Language -> putString("$key:subs", subtitles.code)
        }
    }.apply()
}
