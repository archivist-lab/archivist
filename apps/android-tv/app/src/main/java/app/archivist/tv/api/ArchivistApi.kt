package app.archivist.tv.api

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

/** A request the server refused, with its own message when it gave one. */
class ApiException(val status: Int, message: String) : IOException(message)

/**
 * The Archivist Player API, as the native app uses it.
 *
 * Authenticated with a device token (`Authorization: Bearer`), the credential
 * the server issues to a signed-in device and keeps for a year — the same one
 * the Kodi add-on uses. The token is added only to requests for this server,
 * so artwork from TMDB and flags from a CDN never carry it.
 *
 * [http] is shared with artwork (Coil) and video (ExoPlayer), so the one
 * client authenticates everything the app loads from the server.
 */
class ArchivistApi(baseUrl: String, private val token: String?) {
    val baseUrl: String = baseUrl.trimEnd('/')
    private val base = this.baseUrl.toHttpUrlOrNull()

    val http: OkHttpClient = SHARED.newBuilder()
        .addInterceptor { chain ->
            val request = chain.request()
            val ours = base != null && request.url.host == base.host && request.url.port == base.port
            chain.proceed(if (ours && token != null) request.newBuilder().header("Authorization", "Bearer $token").build() else request)
        }
        .build()

    /** An absolute URL for a path the server returned (artwork, a stream), or null. */
    fun resolve(path: String?): String? {
        if (path.isNullOrBlank()) return null
        if (path.startsWith("http://") || path.startsWith("https://")) return path
        return baseUrl + (if (path.startsWith("/")) path else "/$path")
    }

    // ── Plumbing ─────────────────────────────────────────────────────────────

    private suspend fun call(method: String, path: String, body: JSONObject? = null, headers: Map<String, String> = emptyMap()): Pair<String, okhttp3.Headers> = withContext(Dispatchers.IO) {
        val builder = Request.Builder().url(resolve(path)!!).header("Accept", "application/json")
        headers.forEach { (name, value) -> builder.header(name, value) }
        val payload = body?.toString()?.toRequestBody(JSON)
        builder.method(method, payload ?: if (method == "GET" || method == "DELETE") null else "{}".toRequestBody(JSON))
        http.newCall(builder.build()).execute().use { response ->
            val text = response.body?.string().orEmpty()
            if (!response.isSuccessful) {
                val message = runCatching { JSONObject(text) }.getOrNull()?.let { it.optString("error").ifBlank { it.optString("message") } }
                throw ApiException(response.code, message?.ifBlank { null } ?: "The server answered HTTP ${response.code}")
            }
            text to response.headers
        }
    }

    private suspend fun get(path: String): JSONObject = JSONObject(call("GET", path).first.ifBlank { "{}" })
    private suspend fun send(method: String, path: String, body: JSONObject? = null): JSONObject? =
        call(method, path, body).first.takeIf { it.isNotBlank() }?.let { runCatching { JSONObject(it) }.getOrNull() }

    private fun q(value: String) = URLEncoder.encode(value, "UTF-8")

    // ── Sign-in ──────────────────────────────────────────────────────────────

    data class AuthStatus(val authenticated: Boolean, val bootstrapRequired: Boolean, val setupRequired: Boolean, val username: String?)

    suspend fun authStatus(): AuthStatus {
        val json = get("/api/v1/auth/status")
        return AuthStatus(json.optBoolean("authenticated"), json.optBoolean("bootstrapRequired"), json.optBoolean("setupRequired"), json.optStringOrNull("username"))
    }

    /**
     * Signs in and registers this television as a device, returning its token.
     * The browser session the login creates is used for that one request and
     * then dropped; from here on the app is the device, not a browser.
     */
    suspend fun registerDevice(username: String, password: String, deviceName: String): String {
        val (loginText, loginHeaders) = call("POST", "/api/v1/auth/login", JSONObject().put("username", username).put("password", password))
        if (JSONObject(loginText.ifBlank { "{}" }).optBoolean("setupRequired")) {
            throw ApiException(409, "Finish setting up the administrator account in Archivist first")
        }
        val cookie = loginHeaders.values("Set-Cookie").joinToString("; ") { it.substringBefore(';') }
        if (cookie.isBlank()) throw ApiException(500, "The server did not start a session")
        val (text, _) = call("POST", "/api/v1/auth/devices", JSONObject().put("name", deviceName), mapOf("Cookie" to cookie))
        val token = JSONObject(text).optString("token")
        runCatching { call("POST", "/api/v1/auth/logout", null, mapOf("Cookie" to cookie)) }
        if (token.isBlank()) throw ApiException(500, "The server did not issue a device token")
        return token
    }

    // ── Browsing ─────────────────────────────────────────────────────────────

    suspend fun bootstrap(): Bootstrap = Bootstrap.parse(get("/api/v1/player/ui/bootstrap?profile=$PROFILE"))
    suspend fun hub(id: String = "home"): Hub = Hub.parse(get("/api/v1/player/hubs/${q(id)}?profile=$PROFILE"))
    /** Every film, or those of one library when the server splits them. */
    suspend fun films(library: Int? = null): List<Title> =
        get("/api/v1/player/films?profile=$PROFILE" + (library?.let { "&library=$it" } ?: "")).optJSONArray("films").objects().map(Title::parse)
    suspend fun series(library: Int? = null): List<Title> =
        get("/api/v1/player/series?profile=$PROFILE" + (library?.let { "&library=$it" } ?: "")).optJSONArray("series").objects().map(Title::parse)
    suspend fun typeRows(films: Boolean, library: Int?): TypeRows =
        TypeRows.parse(get("/api/v1/player/type-rows/${if (films) "films" else "series"}?profile=$PROFILE" + (library?.let { "&library=$it" } ?: "")))
    suspend fun film(id: Int): FilmDetail = FilmDetail.parse(get("/api/v1/player/films/$id?profile=$PROFILE"))
    suspend fun seriesDetail(id: Int): SeriesDetail = SeriesDetail.parse(get("/api/v1/player/series/$id?profile=$PROFILE"))
    suspend fun search(query: String): List<Title> =
        get("/api/v1/player/search?q=${q(query)}&limit=40").optJSONArray("results").objects().map(Title::parse)

    // ── Retro games ──────────────────────────────────────────────────────────

    /** The arcade's systems and the ROMs in each folder on the server. */
    suspend fun arcadeLibrary(): ArcadeLibrary = ArcadeLibrary.parse(get("/api/v1/player/arcade/library"))

    /** The Games library, for cover art and overviews to put beside the ROMs. */
    suspend fun gameShelf(): List<ShelfGame> = get("/api/v1/player/games").optJSONArray("games").objects().map(ShelfGame::parse)

    // ── Playback ─────────────────────────────────────────────────────────────

    suspend fun tracks(kind: MediaKind, id: Int): Tracks = Tracks.parse(get("/api/v1/player/stream/${kind.streamType}/$id/tracks"))

    /** The server's compatibility stream as HLS. `copyVideo` names codecs this device decodes, which are copied, not re-encoded. */
    fun hlsUrl(kind: MediaKind, id: Int, audioIndex: Int?, copyVideo: List<String>): String {
        val query = buildList {
            if (audioIndex != null) add("audio=$audioIndex")
            if (copyVideo.isNotEmpty()) add("vcopy=${q(copyVideo.joinToString(","))}")
        }.joinToString("&")
        return "$baseUrl/api/v1/player/stream/${kind.streamType}/$id/hls.m3u8" + if (query.isEmpty()) "" else "?$query"
    }

    fun subtitleUrl(kind: MediaKind, id: Int, index: Int) = "$baseUrl/api/v1/player/stream/${kind.streamType}/$id/subtitle/$index.vtt"

    suspend fun saveProgress(kind: MediaKind, id: Int, positionSeconds: Double, durationSeconds: Double, completed: Boolean, editionId: Int? = null) {
        val body = JSONObject().put("type", kind.progressType).put("id", id).put("positionSeconds", positionSeconds)
            .put("durationSeconds", durationSeconds).put("completed", completed).put("profileId", PROFILE)
        if (editionId != null) body.put("editionId", editionId)
        send("POST", "/api/v1/player/progress", body)
    }

    suspend fun clearProgress(kind: MediaKind, id: Int) { send("DELETE", "/api/v1/player/progress/${kind.progressType}/$id?profile=$PROFILE") }

    // ── Ratings ──────────────────────────────────────────────────────────────

    suspend fun rating(type: String, id: Int): Rating = Rating.parse(get("/api/v1/player/ratings/$type/$id?profile=$PROFILE"))
    suspend fun setRating(type: String, id: Int, value: Double): Rating =
        Rating.parse(send("PUT", "/api/v1/player/ratings/$type/$id", JSONObject().put("value", value).put("profileId", PROFILE)) ?: JSONObject())
    suspend fun clearRating(type: String, id: Int): Rating =
        Rating.parse(send("DELETE", "/api/v1/player/ratings/$type/$id?profile=$PROFILE") ?: JSONObject())

    companion object {
        /** The web Player's own default profile, so both see the same progress. */
        const val PROFILE = "default"
        private val JSON = "application/json; charset=utf-8".toMediaType()
        private val SHARED = OkHttpClient.Builder()
            .connectTimeout(8, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .build()
    }
}

// ── JSON helpers ─────────────────────────────────────────────────────────────

fun JSONArray?.objects(): List<JSONObject> = if (this == null) emptyList() else (0 until length()).mapNotNull { optJSONObject(it) }
fun JSONArray?.strings(): List<String> = if (this == null) emptyList() else (0 until length()).mapNotNull { optString(it).takeIf(String::isNotBlank) }
fun JSONObject.optStringOrNull(name: String): String? = if (isNull(name)) null else optString(name).takeIf { it.isNotBlank() }
fun JSONObject.optIntOrNull(name: String): Int? = if (isNull(name) || !has(name)) null else optInt(name)
fun JSONObject.optDoubleOrNull(name: String): Double? = if (isNull(name) || !has(name)) null else optDouble(name).takeIf { !it.isNaN() }
