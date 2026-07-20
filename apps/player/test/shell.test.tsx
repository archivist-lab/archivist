import { describe, expect, it, vi } from 'vitest'
import { StrictMode } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { PlayerBootstrap, PlayerPreferencesV1 } from '@archivist/contracts'
import { PlayerShell } from '../src/components/Shell.js'
import type { ArchivistSdk } from '../src/lib/sdk.js'
import { playerStore } from '../src/lib/store.js'

const preferences: PlayerPreferencesV1 = {
  schemaVersion: 3, preset: 'categories', navigation: { edgeRail: 'visible', showClock: true },
  home: { hubs: [
    { id: 'home', name: 'Home', icon: '⌂', enabled: true, layout: 'standard', showSpotlight: true, spotlightWidgetId: null, widgets: [{ id: 'recent-films', title: 'Films', source: 'recent-films', view: 'poster', sort: 'source', sortOrder: 'desc', limit: 12, autoscrollSeconds: 0, savedFilterId: null, downloadMediaTypes: [], enabled: true }] },
    { id: 'family', name: 'Family', icon: '★', enabled: true, layout: 'wall', showSpotlight: false, spotlightWidgetId: null, widgets: [{ id: 'films', title: 'Family Films', source: 'films-az', view: 'poster', sort: 'title', sortOrder: 'asc', limit: 18, autoscrollSeconds: 0, savedFilterId: null, downloadMediaTypes: [], enabled: true }] },
  ] },
  libraries: { films: { view: 'poster', sort: 'title', sortOrder: 'asc', hideUnavailable: false }, series: { view: 'poster', sort: 'title', sortOrder: 'asc', hideUnavailable: false } },
  browsing: { defaultViews: { films: 'poster', series: 'poster', seasons: 'poster', episodes: 'landscape', collections: 'poster', people: 'poster' }, savedFilters: [] },
  playback: { normalizeVolume: true, targetLufs: -16, preferredAudioLanguage: null, preferredSubtitleLanguage: null, subtitles: 'forced' },
  accessibility: { reducedMotion: 'system', highContrast: false, textScale: 1 }, migration: { legacyLocalStorageImported: true },
}
const bootstrap = {
  server: { status: 'ok', serverName: 'Archivist', version: '2', capabilities: {} },
  featureFlags: { uiV2Enabled: true, telemetryEnabled: false }, configuration: { defaultPreset: 'categories', maxWidgetItems: 36 },
  preferences: { profileId: 'default', revision: 1, updatedAt: '2026-01-01', preferences }, libraries: [], progress: [],
  initialHub: { id: 'home', title: 'Home', icon: '⌂', layout: 'standard', showSpotlight: true, categories: [], spotlight: null, widgets: [{ id: 'recent-films', title: 'Films', source: 'recent-films', view: 'poster', sort: 'source', sortOrder: 'desc', autoscrollSeconds: 0, items: [], nextCursor: null, total: 0, showMoreRoute: '/films' }] },
} satisfies PlayerBootstrap

describe('living-room shell', () => {
  it('keeps the protected navigation order and establishes initial remote focus', async () => {
    const sdk = { asset: (path: string | null) => path ?? '' } as ArchivistSdk
    playerStore.dispatch({ type: 'BOOTSTRAP_SUCCEEDED', bootstrap })
    render(<StrictMode><MemoryRouter><PlayerShell sdk={sdk} bootstrap={bootstrap} /></MemoryRouter></StrictMode>)
    const navigation = screen.getByRole('navigation', { name: 'Player' })
    expect(Array.from(navigation.querySelectorAll('a')).map(item => item.getAttribute('aria-label'))).toEqual(['Home', 'Family', 'Films', 'Series', 'TV', 'Search', 'Settings'])
    await new Promise(resolve => requestAnimationFrame(resolve))
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Home')
    expect(screen.getByText('Nothing here yet')).toBeTruthy()
    expect(viewRoot().dataset.edgeRail).toBeUndefined()
    expect(navigation.closest('aside')?.dataset.expanded).toBe('true')
    expect(viewRoot().querySelector('.motion-backdrop')).toBeNull()
    const toggle = screen.getByRole('button', { name: 'Collapse navigation' })
    expect(toggle.querySelector('img')).toBeTruthy()
    fireEvent.click(toggle)
    expect(navigation.closest('aside')?.dataset.expanded).toBe('false')
    expect(viewRoot().dataset.sidebarCollapsed).toBe('true')
  })

  it('guards a dirty Settings draft with Cancel and Discard before navigation', async () => {
    const sdk = { asset: (path: string | null) => path ?? '' } as ArchivistSdk
    playerStore.dispatch({ type: 'BOOTSTRAP_SUCCEEDED', bootstrap })
    render(<MemoryRouter initialEntries={['/settings']}><PlayerShell sdk={sdk} bootstrap={bootstrap} /></MemoryRouter>)
    fireEvent.click(screen.getByRole('button', { name: 'Normalize loudness: On' }))
    fireEvent.click(screen.getByRole('link', { name: 'Home' }))
    expect(screen.getByRole('dialog', { name: 'Save changes before leaving?' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog', { name: 'Save changes before leaving?' })).toBeNull()
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeTruthy()

    fireEvent.click(screen.getByRole('link', { name: 'Home' }))
    fireEvent.click(screen.getByRole('dialog', { name: 'Save changes before leaving?' }).querySelectorAll('button')[1])
    expect(await screen.findByText('Nothing here yet')).toBeTruthy()
  })

  it('applies retained accessibility changes without exposing appearance customization', async () => {
    const updatePreferences = vi.fn(async (input: Parameters<ArchivistSdk['updatePreferences']>[0]) => ({
      profileId: input.profileId,
      revision: input.expectedRevision + 1,
      updatedAt: '2026-01-02',
      preferences: input.preferences,
    }))
    const sdk = { asset: (path: string | null) => path ?? '', updatePreferences } as unknown as ArchivistSdk
    playerStore.dispatch({ type: 'BOOTSTRAP_SUCCEEDED', bootstrap })
    const view = render(<MemoryRouter initialEntries={['/settings']}><PlayerShell sdk={sdk} bootstrap={bootstrap} /></MemoryRouter>)

    expect(screen.queryByRole('button', { name: 'Appearance' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Home' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Accessibility' }))
    fireEvent.click(screen.getByRole('button', { name: '115%' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await screen.findByText('Settings saved')
    await waitFor(() => expect(view.container.querySelector<HTMLElement>('.player-v2')?.dataset.textScale).toBe('1.15'))
    expect(view.container.querySelector<HTMLElement>('.player-v2')?.dataset.accent).toBeUndefined()
    expect(view.container.querySelector<HTMLElement>('.player-v2')?.getAttribute('style')).toBeNull()
    expect(updatePreferences).toHaveBeenCalledWith(expect.objectContaining({
      preferences: expect.objectContaining({ accessibility: expect.objectContaining({ textScale: 1.15 }) }),
    }))
  })
})

function viewRoot() {
  const root = document.querySelector<HTMLElement>('.player-v2')
  if (!root) throw new Error('Player root was not rendered')
  return root
}
