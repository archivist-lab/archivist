package app.archivist.tv.ui

import android.os.Build
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Text
import app.archivist.tv.Connection
import app.archivist.tv.Discovery
import app.archivist.tv.Server
import app.archivist.tv.ServerProbe
import app.archivist.tv.ServerStore
import app.archivist.tv.Session
import app.archivist.tv.api.ArchivistApi
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.UUID

private sealed interface Step {
    data object Servers : Step
    data object Add : Step
    data class SignIn(val server: Server, val url: String, val via: String) : Step
}

/**
 * Choosing a server and signing in to it. Each saved server remembers its
 * device token, so this is seen once per server, not once per launch.
 */
@Composable
fun SetupScreen(store: ServerStore, session: Session, message: String?, onConnected: (Connection) -> Unit) {
    var step by remember { mutableStateOf<Step>(if (store.all().isEmpty()) Step.Add else Step.Servers) }
    var status by remember { mutableStateOf(message) }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    fun connect(server: Server) {
        busy = true
        status = "Connecting to ${server.name}…"
        scope.launch {
            val reached = session.reach(server)
            if (reached == null) { busy = false; status = "Can’t reach ${server.name}. Is it switched on and on this network?"; return@launch }
            val (url, via) = reached
            val token = session.token(server.id)
            val api = ArchivistApi(url, token)
            val ok = token != null && runCatching { api.authStatus().authenticated }.getOrDefault(false)
            busy = false
            status = null
            store.markUsed(server.id)
            if (ok) onConnected(Connection(server, url, via, api)) else step = Step.SignIn(server, url, via)
        }
    }

    Box(Modifier.fillMaxSize().background(Palette.canvas)) {
        Column(Modifier.padding(start = 64.dp, top = 48.dp, end = 64.dp).width(560.dp)) {
            Text("ARCHIVIST", style = MaterialTheme.typography.displayMedium, color = Palette.film)
            Text(
                when (step) {
                    Step.Servers -> "Choose a server"
                    Step.Add -> "Add a server"
                    is Step.SignIn -> "Sign in to ${(step as Step.SignIn).server.name}"
                }.uppercase(),
                style = MaterialTheme.typography.headlineSmall, color = Palette.text, modifier = Modifier.padding(top = 8.dp, bottom = 24.dp),
            )
            status?.let { Text(it, style = MaterialTheme.typography.bodyLarge, color = if (busy) Palette.muted else Palette.pink, modifier = Modifier.padding(bottom = 16.dp)) }
            when (val current = step) {
                Step.Servers -> ServerList(store, busy, onPick = ::connect, onAdd = { step = Step.Add; status = null }, onForget = { store.remove(it.id); session.clearToken(it.id); if (store.all().isEmpty()) step = Step.Add })
                Step.Add -> AddServer(store, onCancel = if (store.all().isEmpty()) null else ({ step = Step.Servers; status = null }), onSaved = ::connect)
                is Step.SignIn -> SignIn(current, onCancel = { step = Step.Servers }) { username, password ->
                    busy = true
                    status = "Signing in…"
                    scope.launch {
                        val name = "${Build.MANUFACTURER} ${Build.MODEL}".trim().ifBlank { "Android TV" }
                        runCatching { ArchivistApi(current.url, null).registerDevice(username, password, name) }
                            .onSuccess { token ->
                                session.saveToken(current.server.id, token)
                                busy = false; status = null
                                onConnected(Connection(current.server, current.url, current.via, ArchivistApi(current.url, token)))
                            }
                            .onFailure { busy = false; status = it.message ?: "Sign in failed" }
                    }
                }
            }
        }
    }
}

@Composable
private fun ServerList(store: ServerStore, busy: Boolean, onPick: (Server) -> Unit, onAdd: () -> Unit, onForget: (Server) -> Unit) {
    val servers = remember { mutableStateListOf<Server>().apply { addAll(store.all().sortedByDescending { it.lastUsedAt }) } }
    val first = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { first.requestFocus() } }
    LazyColumn(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        items(servers, key = { it.id }) { server ->
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                ActionButton(
                    "${server.name}   ${server.homeUrl.ifBlank { server.awayUrl }}", Palette.film, primary = true, enabled = !busy,
                    modifier = if (server == servers.first()) Modifier.focusRequester(first) else Modifier,
                ) { onPick(server) }
                ActionButton("Forget", Palette.pink, enabled = !busy) { servers.remove(server); onForget(server) }
            }
        }
        item { ActionButton("Add another server", Palette.film, enabled = !busy, modifier = Modifier.padding(top = 12.dp)) { onAdd() } }
    }
}

@Composable
private fun AddServer(store: ServerStore, onCancel: (() -> Unit)?, onSaved: (Server) -> Unit) {
    var name by remember { mutableStateOf("") }
    var address by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var probing by remember { mutableStateOf(false) }
    val found = remember { mutableStateListOf<String>() }
    var searching by remember { mutableStateOf(true) }
    val scope = rememberCoroutineScope()
    val discovery = remember { Discovery() }
    DisposableEffect(Unit) {
        discovery.start(
            onFound = { _, url, _ -> scope.launch { if (url !in found) found.add(url) } },
            onDone = { scope.launch { searching = false } },
        )
        onDispose { discovery.cancel() }
    }

    fun save(url: String) {
        val clean = normalise(url) ?: run { error = "Enter an address like 192.168.1.10:2424"; return }
        probing = true
        error = null
        scope.launch {
            val result = withContext(Dispatchers.IO) { ServerProbe.probe(clean, 4_000) }
            probing = false
            if (!result.ok) { error = result.error ?: "No Archivist server there"; return@launch }
            val server = store.save(Server(UUID.randomUUID().toString(), name.trim().ifBlank { "Archivist" }, clean, "", 0L))
            onSaved(server)
        }
    }

    Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Text(if (searching) "Looking for servers on this network…" else if (found.isEmpty()) "No servers found on this network. Enter an address instead." else "Found on this network",
            style = MaterialTheme.typography.labelLarge, color = Palette.dim)
        found.forEach { url -> ActionButton(url, Palette.film, primary = true, enabled = !probing) { save(url) } }
        Field("Name (optional)", name, onChange = { name = it })
        Field("Address, e.g. 192.168.1.10:2424", address, keyboard = KeyboardType.Uri, onChange = { address = it }, onDone = { save(address) })
        error?.let { Text(it, color = Palette.pink, style = MaterialTheme.typography.bodyLarge) }
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            ActionButton(if (probing) "Checking…" else "Connect", Palette.film, primary = true, enabled = !probing && address.isNotBlank()) { save(address) }
            if (onCancel != null) ActionButton("Back", Palette.film) { onCancel() }
        }
    }
}

@Composable
private fun SignIn(step: Step.SignIn, onCancel: () -> Unit, onSubmit: (String, String) -> Unit) {
    var username by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    val first = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { first.requestFocus() } }
    Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Text("Signed in once, this TV stays signed in. It appears under devices on the server, where it can be removed.", style = MaterialTheme.typography.bodyLarge, color = Palette.muted)
        Field("Username", username, modifier = Modifier.focusRequester(first), onChange = { username = it })
        Field("Password", password, secret = true, onChange = { password = it }, onDone = { if (username.isNotBlank()) onSubmit(username, password) })
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            ActionButton("Sign in", Palette.film, primary = true, enabled = username.isNotBlank() && password.isNotBlank()) { onSubmit(username, password) }
            ActionButton("Back", Palette.film) { onCancel() }
        }
    }
}

@Composable
private fun Field(
    label: String,
    value: String,
    modifier: Modifier = Modifier,
    secret: Boolean = false,
    keyboard: KeyboardType = KeyboardType.Text,
    onChange: (String) -> Unit,
    onDone: (() -> Unit)? = null,
) {
    var focused by remember { mutableStateOf(false) }
    Column {
        Text(label, style = MaterialTheme.typography.labelMedium, color = Palette.dim, modifier = Modifier.padding(bottom = 6.dp))
        BasicTextField(
            value = value,
            onValueChange = onChange,
            singleLine = true,
            textStyle = TextStyle(color = Palette.text, fontSize = 18.sp, fontFamily = Body),
            cursorBrush = SolidColor(Palette.film),
            visualTransformation = if (secret) PasswordVisualTransformation() else VisualTransformation.None,
            keyboardOptions = KeyboardOptions(keyboardType = if (secret) KeyboardType.Password else keyboard, imeAction = if (onDone != null) ImeAction.Done else ImeAction.Next),
            keyboardActions = KeyboardActions(onDone = { onDone?.invoke() }),
            modifier = modifier
                .fillMaxWidth()
                .onFocusChanged { focused = it.isFocused }
                .background(Palette.panel, RoundedCornerShape(8.dp))
                .border(2.dp, if (focused) Palette.film else Palette.faint, RoundedCornerShape(8.dp))
                .padding(horizontal = 16.dp, vertical = 12.dp),
        )
    }
}

/** "192.168.1.10:2424" or a full URL, as an origin; null when it is not an address. */
fun normalise(raw: String): String? {
    val text = raw.trim().trimEnd('/')
    if (text.isBlank()) return null
    val withScheme = if (text.startsWith("http://") || text.startsWith("https://")) text else "http://$text"
    val host = withScheme.substringAfter("://").substringBefore('/')
    if (host.isBlank()) return null
    val withPort = if (!withScheme.startsWith("https://") && !host.contains(':')) "http://$host:${Discovery.DEFAULT_PORT}" else "${withScheme.substringBefore("://")}://$host"
    return Server.cleanUrl(withPort).ifBlank { null }
}
