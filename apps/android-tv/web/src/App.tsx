import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { hostLabel, normalizeAddress, DEFAULT_PORT } from './address.js'
import { createShell, type ConnectAttempt, type Discovered, type ProbeResult, type ServerRecord, type Shell, type ShellState } from './native.js'
import { focusFirst, installSpatialNavigation } from './spatial.js'

type Screen =
  | { kind: 'servers' }
  | { kind: 'edit'; server: ServerRecord | null }
  | { kind: 'connecting'; server: ServerRecord; error?: string }

export function App({ shell }: { shell?: Shell }) {
  const native = useMemo(() => shell ?? createShell(), [shell])
  const [boot] = useState<ShellState>(() => native.state())
  const [servers, setServers] = useState<ServerRecord[]>(boot.servers)
  const [screen, setScreen] = useState<Screen>(() => initialScreen(boot))
  const back = useRef<() => void>(() => {})

  useEffect(() => installSpatialNavigation(), [])
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' && event.key !== 'BrowserBack') return
      event.preventDefault()
      back.current()
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  }, [])

  const reload = () => {
    const next = native.state().servers
    setServers(next)
    return next
  }
  const toList = () => setScreen(reload().length ? { kind: 'servers' } : { kind: 'edit', server: null })

  back.current = screen.kind === 'servers' ? () => native.exit()
    : screen.kind === 'edit' ? (servers.length ? () => setScreen({ kind: 'servers' }) : () => native.exit())
    : toList

  return <div className="tv-page">
    <header className="tv-topline">
      <span>Archivist · {boot.fireTv ? 'Fire TV' : 'Android TV'}</span>
      <span>{boot.device} · v{boot.appVersion}</span>
    </header>
    {screen.kind === 'servers' && <ServersScreen
      key="servers"
      shell={native}
      servers={servers}
      lastServerId={boot.lastServerId}
      onConnect={server => setScreen({ kind: 'connecting', server })}
      onEdit={server => setScreen({ kind: 'edit', server })}
      onAdd={() => setScreen({ kind: 'edit', server: null })}
    />}
    {screen.kind === 'edit' && <EditScreen
      key={screen.server?.id ?? 'new'}
      shell={native}
      server={screen.server}
      canCancel={servers.length > 0}
      onSaved={server => { reload(); setScreen({ kind: 'connecting', server }) }}
      onCancel={() => setScreen({ kind: 'servers' })}
      onRemoved={() => { native.remove(screen.server!.id); toList() }}
    />}
    {screen.kind === 'connecting' && <ConnectingScreen
      key={`${screen.server.id}:${screen.error ?? ''}`}
      shell={native}
      server={screen.server}
      initialError={screen.error}
      onCancel={toList}
      onEdit={() => setScreen({ kind: 'edit', server: screen.server })}
    />}
    <footer className="tv-hints" aria-hidden="true">
      <span><kbd>OK</kbd> Select</span>
      <span><kbd>Back</kbd> {screen.kind === 'servers' ? 'Exit' : 'Return'}</span>
    </footer>
  </div>
}

function initialScreen(state: ShellState): Screen {
  const byId = (id: string | null) => state.servers.find(server => server.id === id)
  const failed = state.error && byId(state.error.serverId)
  if (failed) return { kind: 'connecting', server: failed, error: state.error!.message }
  const last = state.autoConnect && byId(state.lastServerId)
  if (last) return { kind: 'connecting', server: last }
  return state.servers.length ? { kind: 'servers' } : { kind: 'edit', server: null }
}

function useAutofocus<T extends HTMLElement>(deps: unknown[] = []) {
  const ref = useRef<T>(null)
  useEffect(() => {
    const frame = requestAnimationFrame(() => { if (ref.current) focusFirst(ref.current) })
    return () => cancelAnimationFrame(frame)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return ref
}

function Wordmark({ compact = false }: { compact?: boolean }) {
  return <div className={compact ? 'tv-wordmark tv-wordmark-compact' : 'tv-wordmark'}>
    <h1>Archivist</h1>
    <h2>Player</h2>
  </div>
}

// ── Server list ──────────────────────────────────────────────────────────────

type Reach = { state: 'checking' } | { state: 'home' | 'away'; ms: number } | { state: 'offline' }

function ServersScreen({ shell, servers, lastServerId, onConnect, onEdit, onAdd }: {
  shell: Shell
  servers: ServerRecord[]
  lastServerId: string | null
  onConnect: (server: ServerRecord) => void
  onEdit: (server: ServerRecord) => void
  onAdd: () => void
}) {
  const ref = useAutofocus<HTMLElement>()
  const [reach, setReach] = useState<Record<string, Reach>>({})

  useEffect(() => {
    let live = true
    for (const server of servers) {
      setReach(current => ({ ...current, [server.id]: { state: 'checking' } }))
      const probe = (url: string) => url ? shell.probe(url) : Promise.resolve<ProbeResult>({ ok: false, latencyMs: 0, error: null })
      void Promise.all([probe(server.homeUrl), probe(server.awayUrl)]).then(([home, away]) => {
        if (!live) return
        const next: Reach = home.ok ? { state: 'home', ms: home.latencyMs } : away.ok ? { state: 'away', ms: away.latencyMs } : { state: 'offline' }
        setReach(current => ({ ...current, [server.id]: next }))
      })
    }
    return () => { live = false }
  }, [servers, shell])

  return <main ref={ref} className="tv-screen tv-servers">
    <section className="tv-intro">
      <Wordmark />
      <p className="tv-lede">Choose the Archivist server to open.</p>
    </section>
    <section className="tv-server-row" aria-label="Servers">
      {servers.map(server => {
        const status = reach[server.id] ?? { state: 'checking' }
        return <div key={server.id} className="tv-server-column">
          <button className="tv-server-card" data-autofocus={server.id === lastServerId ? '' : undefined} onClick={() => onConnect(server)}>
            <StatusPill reach={status} />
            <span className="tv-server-name">{server.name}</span>
            <span className="tv-server-address">{server.homeUrl || server.awayUrl}</span>
            {server.homeUrl && server.awayUrl && <span className="tv-server-away">Away · {server.awayUrl}</span>}
            {server.id === lastServerId && <span className="tv-chip">Last used</span>}
          </button>
          <button className="tv-button tv-button-quiet tv-server-edit" onClick={() => onEdit(server)}>Edit</button>
        </div>
      })}
      <div className="tv-server-column">
        <button className="tv-server-card tv-server-add" onClick={onAdd}>
          <span className="tv-server-plus" aria-hidden="true">+</span>
          <span className="tv-server-name">Add server</span>
          <span className="tv-server-address">Find one on your network or type its address</span>
        </button>
      </div>
    </section>
  </main>
}

function StatusPill({ reach }: { reach: Reach }) {
  const label = reach.state === 'checking' ? 'Checking'
    : reach.state === 'offline' ? 'Offline'
    : `${reach.state === 'home' ? 'Home' : 'Away'} · ${reach.ms} ms`
  return <span className={`tv-status tv-status-${reach.state}`}><i aria-hidden="true" />{label}</span>
}

// ── Add / edit ───────────────────────────────────────────────────────────────

type TestState = 'idle' | 'testing' | ProbeResult

function EditScreen({ shell, server, canCancel, onSaved, onCancel, onRemoved }: {
  shell: Shell
  server: ServerRecord | null
  canCancel: boolean
  onSaved: (server: ServerRecord) => void
  onCancel: () => void
  onRemoved: () => void
}) {
  const ref = useAutofocus<HTMLElement>()
  const [name, setName] = useState(server?.name ?? '')
  const [home, setHome] = useState(server?.homeUrl ?? '')
  const [away, setAway] = useState(server?.awayUrl ?? '')
  const [tests, setTests] = useState<{ home: TestState; away: TestState }>({ home: 'idle', away: 'idle' })
  const [found, setFound] = useState<Discovered[]>([])
  const [scanning, setScanning] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const saveRef = useRef<HTMLButtonElement>(null)
  const stopScan = useRef<(() => void) | null>(null)

  const homeUrl = normalizeAddress(home)
  const awayUrl = normalizeAddress(away)
  const invalid = (homeUrl && 'error' in homeUrl) || (awayUrl && 'error' in awayUrl)
  const valid = !invalid && (!!homeUrl || !!awayUrl)
  const urlOf = (value: typeof homeUrl) => value && 'url' in value ? value.url : ''

  const scan = () => {
    stopScan.current?.()
    setScanning(true)
    stopScan.current = shell.discover(
      entry => setFound(current => current.some(item => item.url === entry.url) ? current : [...current, entry].sort((a, b) => a.latencyMs - b.latencyMs)),
      () => { setScanning(false); stopScan.current = null },
    )
  }
  useEffect(() => {
    if (!server) scan()
    return () => stopScan.current?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const test = () => {
    const run = (key: 'home' | 'away', url: string) => {
      if (!url) { setTests(current => ({ ...current, [key]: 'idle' })); return }
      setTests(current => ({ ...current, [key]: 'testing' }))
      void shell.probe(url).then(result => setTests(current => ({ ...current, [key]: result })))
    }
    run('home', urlOf(homeUrl))
    run('away', urlOf(awayUrl))
  }

  const save = () => {
    if (!valid) return
    const homeValue = urlOf(homeUrl)
    const awayValue = urlOf(awayUrl)
    const saved = shell.save({ id: server?.id, name: name.trim() || hostLabel(homeValue || awayValue), homeUrl: homeValue, awayUrl: awayValue })
    onSaved(saved)
  }

  const choose = (entry: Discovered) => {
    setHome(entry.url)
    if (!name.trim()) setName(`Archivist ${entry.host}`)
    setTests(current => ({ ...current, home: { ok: true, latencyMs: entry.latencyMs, error: null } }))
    requestAnimationFrame(() => saveRef.current?.focus())
  }

  return <main ref={ref} className="tv-screen tv-edit">
    <section className="tv-card tv-form">
      <span className="tv-card-topline">{server ? 'Edit server' : 'Add server'}</span>
      <h1 className="tv-card-title">{name.trim() || (server ? server.name : 'New server')}</h1>
      <Field label="Name" hint="What this server is called on this TV.">
        <input value={name} onChange={event => setName(event.target.value)} placeholder="Living room" autoCapitalize="words" spellCheck={false} enterKeyHint="next" />
      </Field>
      <Field label="Home address" hint={`Used on your home network. An IP or host name is enough — port ${DEFAULT_PORT} is assumed.`} value={homeUrl} test={tests.home}>
        <input data-autofocus={server ? undefined : ''} value={home} onChange={event => { setHome(event.target.value); setTests(current => ({ ...current, home: 'idle' })) }} placeholder="192.168.1.10" inputMode="url" autoCapitalize="off" autoCorrect="off" spellCheck={false} enterKeyHint="next" />
      </Field>
      <Field label="Away address" optional hint="Used from anywhere else when home does not answer — a reverse proxy, Tailscale or VPN address." value={awayUrl} test={tests.away}>
        <input value={away} onChange={event => { setAway(event.target.value); setTests(current => ({ ...current, away: 'idle' })) }} placeholder="archivist.example.com" inputMode="url" autoCapitalize="off" autoCorrect="off" spellCheck={false} enterKeyHint="done" />
      </Field>
      <div className="tv-actions">
        <button ref={saveRef} className="tv-button tv-button-primary" disabled={!valid} onClick={save} data-autofocus={server ? '' : undefined}>Save &amp; connect</button>
        <button className="tv-button" disabled={!valid} onClick={test}>Test</button>
        {canCancel && <button className="tv-button tv-button-quiet" onClick={onCancel}>Cancel</button>}
        {server && (confirmRemove
          ? <button className="tv-button tv-button-danger" onClick={onRemoved} onBlur={() => setConfirmRemove(false)}>Press again to remove</button>
          : <button className="tv-button tv-button-quiet tv-button-danger-quiet" onClick={() => setConfirmRemove(true)}>Remove</button>)}
      </div>
    </section>
    <section className="tv-card tv-discovery" aria-label="Found on your network">
      <div className="tv-discovery-head">
        <span className="tv-section-label">Found on your network</span>
        {scanning && <span className="tv-scanning"><i aria-hidden="true" />Scanning</span>}
      </div>
      {found.length > 0
        ? <div className="tv-found-list">{found.map(entry => <button key={entry.url} className="tv-found" onClick={() => choose(entry)}>
            <span className="tv-found-host">{entry.host}</span>
            <span className="tv-found-meta">Port {new URL(entry.url).port || DEFAULT_PORT} · {entry.latencyMs} ms</span>
          </button>)}</div>
        : <p className="tv-muted">{scanning ? 'Looking for Archivist on this network…' : `Nothing answered on port ${DEFAULT_PORT}. Type the address instead, or scan again once the server is running.`}</p>}
      <button className="tv-button tv-button-quiet tv-discovery-rescan" disabled={scanning} onClick={scan}>{scanning ? 'Scanning…' : found.length ? 'Scan again' : 'Scan network'}</button>
    </section>
  </main>
}

function Field({ label, hint, optional = false, value, test, children }: {
  label: string
  hint: string
  optional?: boolean
  value?: ReturnType<typeof normalizeAddress>
  test?: TestState
  children: ReactNode
}) {
  return <label className="tv-field">
    <span className="tv-field-label">{label}{optional && <em>Optional</em>}</span>
    {children}
    <span className="tv-field-foot">
      {value && 'error' in value ? <span className="tv-field-error">{value.error}</span>
        : value && 'url' in value ? <span className="tv-field-url">{value.url}</span>
        : <span className="tv-field-hint">{hint}</span>}
      {test && test !== 'idle' && <TestBadge test={test} />}
    </span>
  </label>
}

function TestBadge({ test }: { test: Exclude<TestState, 'idle'> }) {
  if (test === 'testing') return <span className="tv-status tv-status-checking"><i aria-hidden="true" />Testing</span>
  return test.ok
    ? <span className="tv-status tv-status-home"><i aria-hidden="true" />Archivist · {test.latencyMs} ms</span>
    : <span className="tv-status tv-status-offline"><i aria-hidden="true" />{test.error ?? 'Unreachable'}</span>
}

// ── Connecting ───────────────────────────────────────────────────────────────

type Phase =
  | { kind: 'trying'; via: 'home' | 'away' | null; url: string }
  | { kind: 'failed'; attempts: ConnectAttempt[]; message?: string }

function ConnectingScreen({ shell, server, initialError, onCancel, onEdit }: {
  shell: Shell
  server: ServerRecord
  initialError?: string
  onCancel: () => void
  onEdit: () => void
}) {
  const [attempt, setAttempt] = useState(0)
  const [phase, setPhase] = useState<Phase>(initialError ? { kind: 'failed', attempts: [], message: initialError } : { kind: 'trying', via: null, url: '' })
  const ref = useAutofocus<HTMLElement>([phase.kind])

  useEffect(() => {
    if (initialError && attempt === 0) return
    setPhase({ kind: 'trying', via: null, url: '' })
    return shell.connect(server.id,
      (via, url) => setPhase({ kind: 'trying', via, url }),
      attempts => setPhase({ kind: 'failed', attempts }))
  }, [attempt, initialError, server.id, shell])

  return <main ref={ref} className="tv-screen tv-connecting">
    <Wordmark compact />
    {phase.kind === 'trying' ? <>
      <span className="tv-section-label">Connecting to</span>
      <h1 className="tv-connect-name">{server.name}</h1>
      <div className="tv-scanbar" aria-hidden="true"><i /></div>
      <p className="tv-connect-detail">{phase.via ? <>Trying the {phase.via} address <span className="tv-mono">{phase.url}</span></> : 'Starting…'}</p>
      <div className="tv-actions tv-actions-center"><button className="tv-button tv-button-quiet" onClick={onCancel} data-autofocus>Cancel</button></div>
    </> : <>
      <span className="tv-section-label tv-section-label-danger">Could not reach</span>
      <h1 className="tv-connect-name">{server.name}</h1>
      {phase.message && <p className="tv-connect-detail">{phase.message}</p>}
      {phase.attempts.length > 0 && <ul className="tv-attempts">{phase.attempts.map(item => <li key={item.via}>
        <span className="tv-attempt-via">{item.via}</span>
        <span className="tv-mono">{item.url}</span>
        <span className="tv-attempt-error">{item.error ?? 'Unreachable'}</span>
      </li>)}</ul>}
      <div className="tv-actions tv-actions-center">
        <button className="tv-button tv-button-primary" onClick={() => setAttempt(value => value + 1)} data-autofocus>Retry</button>
        <button className="tv-button" onClick={onEdit}>Edit server</button>
        <button className="tv-button tv-button-quiet" onClick={onCancel}>All servers</button>
      </div>
    </>}
  </main>
}
