import { describe, expect, it } from 'vitest'
import { StrictMode } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { PlayerBootstrap, PlayerPreferencesV1 } from '@archivist/contracts'
import { PlayerShell } from '../src/components/Shell.js'
import type { ArchivistSdk } from '../src/lib/sdk.js'
import { playerStore } from '../src/lib/store.js'

const preferences: PlayerPreferencesV1 = {
  schemaVersion: 1, preset: 'categories', navigation: { edgeRail: 'visible', showClock: true },
  home: { widgetMode: 'stacked', showSpotlight: true, widgets: [{ id: 'recent-films', title: 'Films', source: 'recent-films', view: 'poster', limit: 12, enabled: true }] },
  libraries: { films: { view: 'poster', sort: 'title', hideUnavailable: false }, series: { view: 'poster', sort: 'title', hideUnavailable: false } },
  playback: { normalizeVolume: true, targetLufs: -16, preferredAudioLanguage: null, preferredSubtitleLanguage: null, subtitles: 'forced' },
  accessibility: { reducedMotion: 'system', highContrast: false, textScale: 1 }, migration: { legacyLocalStorageImported: true },
}
const bootstrap = {
  server: { status: 'ok', serverName: 'Archivist', version: '2', capabilities: {} },
  featureFlags: { uiV2Enabled: true, telemetryEnabled: false }, configuration: { defaultPreset: 'categories', maxWidgetItems: 36 },
  preferences: { profileId: 'default', revision: 1, updatedAt: '2026-01-01', preferences }, libraries: [], progress: [],
  initialHub: { id: 'home', title: 'Home', categories: [], spotlight: null, widgets: [] },
} satisfies PlayerBootstrap

describe('living-room shell', () => {
  it('keeps the protected navigation order and establishes initial remote focus', async () => {
    const sdk = { asset: (path: string | null) => path ?? '' } as ArchivistSdk
    playerStore.dispatch({ type: 'BOOTSTRAP_SUCCEEDED', bootstrap })
    render(<StrictMode><MemoryRouter><PlayerShell sdk={sdk} bootstrap={bootstrap} /></MemoryRouter></StrictMode>)
    const navigation = screen.getByRole('navigation', { name: 'Player' })
    expect(Array.from(navigation.querySelectorAll('a')).map(item => item.getAttribute('aria-label'))).toEqual(['Home', 'Films', 'Series', 'TV', 'Search', 'Settings'])
    await new Promise(resolve => requestAnimationFrame(resolve))
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Home')
    expect(screen.getByText('Your library is quiet.')).toBeTruthy()
  })

  it('guards a dirty Settings draft with Cancel and Discard before navigation', async () => {
    const sdk = { asset: (path: string | null) => path ?? '' } as ArchivistSdk
    playerStore.dispatch({ type: 'BOOTSTRAP_SUCCEEDED', bootstrap })
    render(<MemoryRouter initialEntries={['/settings']}><PlayerShell sdk={sdk} bootstrap={bootstrap} /></MemoryRouter>)
    fireEvent.click(screen.getByRole('button', { name: 'classic' }))
    fireEvent.click(screen.getByRole('link', { name: 'Home' }))
    expect(screen.getByRole('dialog', { name: 'Save changes before leaving?' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog', { name: 'Save changes before leaving?' })).toBeNull()
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeTruthy()

    fireEvent.click(screen.getByRole('link', { name: 'Home' }))
    fireEvent.click(screen.getByRole('dialog', { name: 'Save changes before leaving?' }).querySelectorAll('button')[1])
    expect(await screen.findByText('Your library is quiet.')).toBeTruthy()
  })
})
