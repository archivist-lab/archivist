import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { App } from '../src/App.js'
import { Shell, type Bridge, type ServerRecord, type ShellState } from '../src/native.js'

afterEach(cleanup)

const home: ServerRecord = { id: 's1', name: 'Living room', homeUrl: 'http://192.168.1.10:2424', awayUrl: 'https://archivist.example.com', lastUsedAt: 1 }

function fakeBridge(state: Partial<ShellState> = {}) {
  let servers = state.servers ?? []
  const bridge: Bridge = {
    getState: vi.fn(() => JSON.stringify({ lastServerId: null, autoConnect: false, error: null, appVersion: '0.1.0', device: 'Test TV', fireTv: false, ...state, servers })),
    saveServer: vi.fn((json: string) => {
      const saved = { ...JSON.parse(json), id: 'new' } as ServerRecord
      servers = [...servers, saved]
      return JSON.stringify(saved)
    }),
    removeServer: vi.fn(),
    probe: vi.fn(),
    discover: vi.fn(),
    stopDiscovery: vi.fn(),
    connect: vi.fn(),
    cancelConnect: vi.fn(),
    exitApp: vi.fn(),
  }
  return bridge
}

const receive = (message: object) => act(() => { window.__archivistNative!.receive(message as never) })

describe('server picker', () => {
  it('opens on Add server and scans the network on first run', () => {
    const bridge = fakeBridge()
    render(<App shell={new Shell(bridge)} />)
    expect(screen.getByText('Add server')).toBeTruthy()
    expect(bridge.discover).toHaveBeenCalledTimes(1)
  })

  it('fills the home address from a discovered server and connects on save', () => {
    const bridge = fakeBridge()
    render(<App shell={new Shell(bridge)} />)
    const requestId = vi.mocked(bridge.discover).mock.calls[0][0]
    receive({ type: 'discovered', requestId, server: { host: '192.168.1.10', url: 'http://192.168.1.10:2424', latencyMs: 4 } })
    fireEvent.click(screen.getByText('192.168.1.10'))
    expect((screen.getByPlaceholderText('192.168.1.10') as HTMLInputElement).value).toBe('http://192.168.1.10:2424')
    fireEvent.click(screen.getByText('Save & connect'))
    expect(JSON.parse(vi.mocked(bridge.saveServer).mock.calls[0][0])).toMatchObject({ name: 'Archivist 192.168.1.10', homeUrl: 'http://192.168.1.10:2424', awayUrl: '' })
    expect(bridge.connect).toHaveBeenCalledWith(expect.any(String), 'new')
  })

  it('reconnects to the last server on launch and reports every address it tried', () => {
    const bridge = fakeBridge({ servers: [home], lastServerId: 's1', autoConnect: true })
    render(<App shell={new Shell(bridge)} />)
    expect(screen.getByText('Connecting to')).toBeTruthy()
    const requestId = vi.mocked(bridge.connect).mock.calls[0][0]
    receive({ type: 'connectFailed', requestId, attempts: [
      { via: 'home', url: home.homeUrl, error: 'Timed out' },
      { via: 'away', url: home.awayUrl, error: 'Certificate not trusted' },
    ] })
    expect(screen.getByText('Could not reach')).toBeTruthy()
    expect(screen.getByText('Certificate not trusted')).toBeTruthy()
    fireEvent.click(screen.getByText('Retry'))
    expect(bridge.connect).toHaveBeenCalledTimes(2)
  })

  it('shows a lost connection without retrying on its own', () => {
    const bridge = fakeBridge({ servers: [home], lastServerId: 's1', error: { serverId: 's1', message: 'Lost Living room: net::ERR_ADDRESS_UNREACHABLE' } })
    render(<App shell={new Shell(bridge)} />)
    expect(screen.getByText('Lost Living room: net::ERR_ADDRESS_UNREACHABLE')).toBeTruthy()
    expect(bridge.connect).not.toHaveBeenCalled()
  })

  it('lists saved servers with their reachability, and Back leaves the app', () => {
    const bridge = fakeBridge({ servers: [home], lastServerId: 's1' })
    render(<App shell={new Shell(bridge)} />)
    const [homeProbe] = vi.mocked(bridge.probe).mock.calls.find(([, url]) => url === home.homeUrl)!
    const [awayProbe] = vi.mocked(bridge.probe).mock.calls.find(([, url]) => url === home.awayUrl)!
    receive({ type: 'probe', requestId: homeProbe, result: { ok: false, latencyMs: 0, error: 'Timed out' } })
    receive({ type: 'probe', requestId: awayProbe, result: { ok: true, latencyMs: 83, error: null } })
    return vi.waitFor(() => {
      expect(screen.getByText('Away · 83 ms')).toBeTruthy()
      fireEvent.keyDown(window, { key: 'Escape' })
      expect(bridge.exitApp).toHaveBeenCalled()
    })
  })
})
