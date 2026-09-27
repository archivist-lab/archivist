package app.archivist.tv

import android.content.Context
import app.archivist.tv.api.ArchivistApi
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** A server the app is connected to: which address answered, and the client for it. */
data class Connection(val server: Server, val url: String, val via: String, val api: ArchivistApi)

/**
 * Device tokens, one per saved server. A token is what the server issued when
 * this television signed in; it lasts a year and is revoked from the server's
 * device list, so it is kept apart from the server list itself.
 */
class Session(context: Context) {
    private val prefs = context.getSharedPreferences("session", Context.MODE_PRIVATE)

    fun token(serverId: String): String? = prefs.getString("token:$serverId", null)
    fun saveToken(serverId: String, token: String) = prefs.edit().putString("token:$serverId", token).apply()
    fun clearToken(serverId: String) = prefs.edit().remove("token:$serverId").apply()

    /**
     * The address of [server] that answers from here: home first, as it is
     * on the local network and faster, then away. Null when neither does.
     */
    suspend fun reach(server: Server): Pair<String, String>? = withContext(Dispatchers.IO) {
        if (server.homeUrl.isNotBlank() && ServerProbe.probe(server.homeUrl, 2_500).ok) return@withContext server.homeUrl to "home"
        if (server.awayUrl.isNotBlank() && ServerProbe.probe(server.awayUrl, 6_000).ok) return@withContext server.awayUrl to "away"
        null
    }
}
