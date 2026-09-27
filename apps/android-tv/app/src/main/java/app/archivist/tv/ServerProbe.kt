package app.archivist.tv

import org.json.JSONObject
import java.io.IOException
import java.net.ConnectException
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URL
import java.net.UnknownHostException
import javax.net.ssl.SSLException

data class ProbeResult(
    val ok: Boolean,
    val latencyMs: Long,
    /** Short, human reason when [ok] is false. */
    val error: String? = null,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("ok", ok)
        .put("latencyMs", latencyMs)
        .put("error", error ?: JSONObject.NULL)
}

/**
 * Is there an Archivist at this address? `/api/v1/auth/status` answers
 * without a session and its shape (`authenticated`, `bootstrapRequired`) is
 * specific enough that an unrelated web server on the same port does not pass.
 */
object ServerProbe {
    fun probe(baseUrl: String, timeoutMs: Int): ProbeResult {
        val started = System.currentTimeMillis()
        fun elapsed() = System.currentTimeMillis() - started
        var connection: HttpURLConnection? = null
        return try {
            connection = (URL("$baseUrl/api/v1/auth/status").openConnection() as HttpURLConnection).apply {
                connectTimeout = timeoutMs
                readTimeout = timeoutMs
                // Not followed: the Player is opened at this exact origin, so an
                // address that redirects (http → https, say) is the wrong one to save.
                instanceFollowRedirects = false
                setRequestProperty("Accept", "application/json")
                setRequestProperty("Cache-Control", "no-store")
            }
            val code = connection.responseCode
            if (code in 300..399) {
                val location = connection.getHeaderField("Location")?.let { originOf(URL(URL(baseUrl), it).toString()) }
                return ProbeResult(false, elapsed(), if (location != null) "Redirects to $location — use that address" else "Answered with a redirect")
            }
            if (code != 200) return ProbeResult(false, elapsed(), "Answered with HTTP $code — is this the Archivist port?")
            val body = connection.inputStream.bufferedReader().use { it.readText() }
            val json = JSONObject(body)
            if (!json.has("authenticated") || !json.has("bootstrapRequired")) {
                ProbeResult(false, elapsed(), "Something answered, but it is not Archivist")
            } else {
                ProbeResult(true, elapsed())
            }
        } catch (_: SocketTimeoutException) {
            ProbeResult(false, elapsed(), "Timed out")
        } catch (_: UnknownHostException) {
            ProbeResult(false, elapsed(), "Unknown host")
        } catch (_: ConnectException) {
            ProbeResult(false, elapsed(), "Connection refused")
        } catch (_: SSLException) {
            ProbeResult(false, elapsed(), "Certificate not trusted")
        } catch (_: org.json.JSONException) {
            ProbeResult(false, elapsed(), "Something answered, but it is not Archivist")
        } catch (e: IOException) {
            ProbeResult(false, elapsed(), e.message ?: "Network error")
        } catch (e: IllegalArgumentException) {
            ProbeResult(false, elapsed(), "Not a valid address")
        } finally {
            connection?.disconnect()
        }
    }
}
