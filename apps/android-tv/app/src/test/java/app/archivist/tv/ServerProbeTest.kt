package app.archivist.tv

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.ServerSocket

class ServerProbeTest {
    private val sockets = mutableListOf<ServerSocket>()

    @After fun stop() = sockets.forEach { it.close() }

    /** Answers every request with one canned HTTP response. */
    private fun serve(status: Int, body: String = "", location: String? = null): String {
        val socket = ServerSocket(0)
        sockets += socket
        Thread {
            while (!socket.isClosed) {
                val client = try { socket.accept() } catch (_: Exception) { break }
                client.use {
                    val reader = it.getInputStream().bufferedReader()
                    while (reader.readLine()?.isNotEmpty() == true) Unit
                    val bytes = body.toByteArray()
                    val head = buildString {
                        append("HTTP/1.1 $status X\r\n")
                        location?.let { value -> append("Location: $value\r\n") }
                        append("Content-Type: application/json\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n")
                    }
                    it.getOutputStream().apply { write(head.toByteArray()); write(bytes); flush() }
                }
            }
        }.apply { isDaemon = true }.start()
        return "http://127.0.0.1:${socket.localPort}"
    }

    @Test fun `recognises Archivist by its auth status shape`() {
        val url = serve(200, """{"required":true,"authenticated":false,"bootstrapRequired":false,"setupRequired":false,"username":null}""")
        assertTrue(ServerProbe.probe(url, 2_000).ok)
    }

    @Test fun `rejects another web server on the same port`() {
        val result = ServerProbe.probe(serve(200, """{"status":"ok"}"""), 2_000)
        assertFalse(result.ok)
        assertEquals("Something answered, but it is not Archivist", result.error)
        assertEquals("Something answered, but it is not Archivist", ServerProbe.probe(serve(200, "<html>"), 2_000).error)
    }

    @Test fun `names the address a redirect points to`() {
        val result = ServerProbe.probe(serve(301, location = "https://archivist.example.com/api/v1/auth/status"), 2_000)
        assertFalse(result.ok)
        assertEquals("Redirects to https://archivist.example.com — use that address", result.error)
    }

    @Test fun `explains a wrong port`() {
        assertEquals("Answered with HTTP 404 — is this the Archivist port?", ServerProbe.probe(serve(404), 2_000).error)
    }

    @Test fun `reports a closed port as refused`() {
        val port = ServerSocket(0).use { it.localPort }
        assertEquals("Connection refused", ServerProbe.probe("http://127.0.0.1:$port", 2_000).error)
    }

    @Test fun `origins drop default ports and path`() {
        assertEquals("http://192.168.1.10:2424", originOf("http://192.168.1.10:2424/player/films"))
        assertEquals("https://archivist.example.com", originOf("https://Archivist.example.com:443/player/"))
        assertEquals("https://appassets.androidplatform.net", originOf(WebPlayerActivity.SETUP_URL))
        assertEquals(null, originOf("not a url"))
    }
}
