package app.archivist.tv

import java.net.Inet4Address
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.Socket
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Finds Archivist servers on the local network.
 *
 * Archivist does not advertise itself, so this sweeps the /24 of every local
 * IPv4 interface on the default port: a cheap TCP connect first, and the full
 * [ServerProbe] only for hosts that accept. A home network sweeps in a few
 * seconds.
 */
class Discovery(private val port: Int = DEFAULT_PORT) {
    private val cancelled = AtomicBoolean(false)
    private var pool: ExecutorService? = null

    fun start(onFound: (host: String, url: String, latencyMs: Long) -> Unit, onDone: () -> Unit) {
        val hosts = candidateHosts()
        val executor = Executors.newFixedThreadPool(48)
        pool = executor
        for (host in hosts) {
            executor.execute {
                if (cancelled.get()) return@execute
                if (!portOpen(host)) return@execute
                val url = "http://$host:$port"
                val result = ServerProbe.probe(url, 2_000)
                if (result.ok && !cancelled.get()) onFound(host, url, result.latencyMs)
            }
        }
        executor.shutdown()
        Thread {
            executor.awaitTermination(30, TimeUnit.SECONDS)
            if (!cancelled.get()) onDone()
        }.start()
    }

    fun cancel() {
        cancelled.set(true)
        pool?.shutdownNow()
    }

    private fun portOpen(host: String): Boolean = try {
        Socket().use { it.connect(InetSocketAddress(host, port), 400); true }
    } catch (_: Exception) {
        false
    }

    private fun candidateHosts(): List<String> {
        val hosts = linkedSetOf<String>()
        val interfaces = try { NetworkInterface.getNetworkInterfaces()?.toList().orEmpty() } catch (_: Exception) { emptyList() }
        for (network in interfaces) {
            if (!network.isUp || network.isLoopback) continue
            for (address in network.interfaceAddresses) {
                val ip = address.address as? Inet4Address ?: continue
                if (!ip.isSiteLocalAddress) continue
                val octets = ip.address.map { it.toInt() and 0xff }
                val prefix = "${octets[0]}.${octets[1]}.${octets[2]}."
                (1..254).forEach { hosts.add(prefix + it) }
            }
        }
        return hosts.toList()
    }

    companion object {
        const val DEFAULT_PORT = 2424
    }
}
