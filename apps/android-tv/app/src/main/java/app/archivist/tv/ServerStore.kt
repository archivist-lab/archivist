package app.archivist.tv

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/**
 * One Archivist server, reachable at up to two addresses: a home address used
 * on the local network and an away address (a reverse proxy, Tailscale, a
 * VPN) used from anywhere else. Connecting tries home first.
 */
data class Server(
    val id: String,
    val name: String,
    val homeUrl: String,
    val awayUrl: String,
    val lastUsedAt: Long,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("id", id)
        .put("name", name)
        .put("homeUrl", homeUrl)
        .put("awayUrl", awayUrl)
        .put("lastUsedAt", lastUsedAt)

    companion object {
        fun fromJson(json: JSONObject) = Server(
            id = json.optString("id").ifBlank { UUID.randomUUID().toString() },
            name = json.optString("name").trim().ifBlank { "Archivist" },
            homeUrl = cleanUrl(json.optString("homeUrl")),
            awayUrl = cleanUrl(json.optString("awayUrl")),
            lastUsedAt = json.optLong("lastUsedAt", 0L),
        )

        /** The page normalises what was typed; this only guards the shape. */
        fun cleanUrl(raw: String): String {
            val url = raw.trim().trimEnd('/')
            return if (url.startsWith("http://") || url.startsWith("https://")) url else ""
        }
    }
}

class ServerStore(context: Context) {
    private val prefs = context.getSharedPreferences("servers", Context.MODE_PRIVATE)

    @Synchronized
    fun all(): List<Server> {
        val raw = prefs.getString(KEY_SERVERS, null) ?: return emptyList()
        return try {
            val array = JSONArray(raw)
            (0 until array.length()).map { Server.fromJson(array.getJSONObject(it)) }
        } catch (_: Exception) {
            emptyList()
        }
    }

    fun find(id: String): Server? = all().firstOrNull { it.id == id }

    val lastServerId: String? get() = prefs.getString(KEY_LAST, null)

    @Synchronized
    fun save(server: Server): Server {
        val servers = all().toMutableList()
        val index = servers.indexOfFirst { it.id == server.id }
        if (index >= 0) servers[index] = server.copy(lastUsedAt = servers[index].lastUsedAt) else servers.add(server)
        write(servers)
        return find(server.id) ?: server
    }

    @Synchronized
    fun remove(id: String) {
        write(all().filterNot { it.id == id })
        if (lastServerId == id) prefs.edit().remove(KEY_LAST).apply()
    }

    @Synchronized
    fun markUsed(id: String) {
        write(all().map { if (it.id == id) it.copy(lastUsedAt = System.currentTimeMillis()) else it })
        prefs.edit().putString(KEY_LAST, id).apply()
    }

    private fun write(servers: List<Server>) {
        val array = JSONArray()
        servers.forEach { array.put(it.toJson()) }
        prefs.edit().putString(KEY_SERVERS, array.toString()).apply()
    }

    private companion object {
        const val KEY_SERVERS = "servers"
        const val KEY_LAST = "lastServerId"
    }
}
