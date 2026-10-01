package app.archivist.tv

import android.content.Context

/**
 * How series pages look on this TV. Kept on the device, like track choices
 * and controller mappings: a choice about this screen, not about the account.
 */
class SeriesPrefs(context: Context) {
    private val prefs = context.getSharedPreferences("series-display", Context.MODE_PRIVATE)

    /** Season posters in the season bar, each over its name at half the tab size. */
    var showSeasonArtwork: Boolean
        get() = prefs.getBoolean("seasonArtwork", false)
        set(value) = prefs.edit().putBoolean("seasonArtwork", value).apply()
}
