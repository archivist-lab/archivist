import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react'
import { request, setTabContext, getTabGeneration } from './api.js'

export type MediaType = 'films' | 'series' | 'music' | 'games' | 'books' | 'comics'

export interface Tab {
  id: number
  name: string
  media_type: MediaType
  db_path: string
  created_at: string
}

interface TabContextType {
  tabs: Tab[]
  activeTabId: number | null
  activeTab: Tab | null
  tabGeneration: number
  /** Set the active tab (updates API header immediately). */
  setActiveTabId: (id: number | null) => void
  /** Get the remembered tab for a specific media type. */
  getActiveTabForMedia: (mediaType: MediaType) => Tab | null
  /** Set the active tab for a media type and switch the API context to it. */
  setActiveTabForMedia: (mediaType: MediaType, tabId: number) => void
  refreshTabs: () => Promise<void>
  /** Media types the user has enabled (others are hidden). */
  enabledMediaTypes: MediaType[]
  /** null while loading; true/false once the onboarding state is known. */
  onboardingCompleted: boolean | null
  completeOnboarding: () => Promise<void>
  saveEnabledMediaTypes: (types: MediaType[]) => Promise<void>
  /** Re-show the setup wizard (client-side only; preview without a reset). */
  relaunchOnboarding: () => void
  createTab: (data: { name: string, mediaType: string, dbPath: string }) => Promise<Tab>
  updateTab: (id: number, data: { name: string }) => Promise<Tab>
  deleteTab: (id: number, deleteFiles?: boolean) => Promise<void>
  clearTab: (id: number, deleteFiles?: boolean) => Promise<{ cleared: number }>
}

const TabContext = createContext<TabContextType | undefined>(undefined)

const STORAGE_KEY = 'archivist_active_tabs'

/** URL slug for a library name, e.g. "Kids Films" → "kids-films". */
export function librarySlug(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'library'
}

/** Load per-media-type tab selections from localStorage. */
function loadMediaTabs(): Record<string, number> {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    return saved ? JSON.parse(saved) : {}
  } catch { return {} }
}

function saveMediaTabs(map: Record<string, number>) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
}

function sanitizeMediaTabs(tabs: Tab[], mediaTabs: Record<string, number>): Record<string, number> {
  const next: Record<string, number> = {}

  for (const [mediaType, tabId] of Object.entries(mediaTabs)) {
    const match = tabs.find(t => t.id === tabId && t.media_type === mediaType)
    if (match) {
      next[mediaType] = tabId
    }
  }

  return next
}

export function TabProvider({ children }: { children: ReactNode }) {
  const ALL_MEDIA: MediaType[] = ['films', 'series', 'music', 'books', 'comics', 'games']
  const [tabs, setTabs] = useState<Tab[]>([])
  const [enabledMediaTypes, setEnabledMediaTypes] = useState<MediaType[]>(ALL_MEDIA)
  const [onboardingCompleted, setOnboardingCompleted] = useState<boolean | null>(null)
  const [mediaTabs, setMediaTabs] = useState<Record<string, number>>(loadMediaTabs)
  const [activeTabId, setInternalActiveTabId] = useState<number | null>(() => {
    const saved = localStorage.getItem('archivist_active_tab')
    return saved ? parseInt(saved, 10) : null
  })

  const refreshTabs = async () => {
    try {
      const data = await request<Tab[]>('/tabs')
      setTabs(data)

      const sanitizedMediaTabs = sanitizeMediaTabs(data, mediaTabs)
      if (JSON.stringify(sanitizedMediaTabs) !== JSON.stringify(mediaTabs)) {
        setMediaTabs(sanitizedMediaTabs)
        saveMediaTabs(sanitizedMediaTabs)
      }

      const activeTabStillExists = activeTabId ? data.some(t => t.id === activeTabId) : false
      if (activeTabId && !activeTabStillExists) {
        setActiveTabId(data[0]?.id ?? null)
      } else if (data.length > 0 && !activeTabId) {
        setActiveTabId(data[0].id)
      }
    } catch (err) {
      console.error('Failed to fetch tabs:', err)
    }
  }

  const setActiveTabId = (id: number | null) => {
    setInternalActiveTabId(id)
    if (id) {
      localStorage.setItem('archivist_active_tab', id.toString())
      setTabContext(id.toString())
      // Also update the per-media-type map
      const tab = tabs.find(t => t.id === id)
      if (tab) {
        setMediaTabs(prev => {
          const next = { ...prev, [tab.media_type]: id }
          saveMediaTabs(next)
          return next
        })
      }
    } else {
      localStorage.removeItem('archivist_active_tab')
      setTabContext(null)
    }
  }

  const getActiveTabForMedia = (mediaType: MediaType): Tab | null => {
    const savedId = mediaTabs[mediaType]
    if (savedId) {
      const tab = tabs.find(t => t.id === savedId && t.media_type === mediaType)
      if (tab) return tab
    }
    // Fallback to first tab of that type
    return tabs.find(t => t.media_type === mediaType) || null
  }

  const setActiveTabForMedia = (mediaType: MediaType, tabId: number) => {
    setMediaTabs(prev => {
      const next = { ...prev, [mediaType]: tabId }
      saveMediaTabs(next)
      return next
    })
    // Also set as the global active tab
    setActiveTabId(tabId)
  }

  const createTab = async (data: { name: string, mediaType: string, dbPath: string }) => {
    const newTab = await request<Tab>('/tabs', {
      method: 'POST',
      body: JSON.stringify(data)
    })
    await refreshTabs()
    return newTab
  }

  const updateTab = async (id: number, data: { name: string }) => {
    const updated = await request<Tab>(`/tabs/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data)
    })
    await refreshTabs()
    return updated
  }

  const deleteTab = async (id: number, deleteFiles?: boolean) => {
    await request(`/tabs/${id}${deleteFiles ? '?deleteFiles=true' : ''}`, { method: 'DELETE' })
    if (activeTabId === id) {
      setActiveTabId(tabs.find(t => t.id !== id)?.id || null)
    }
    await refreshTabs()
  }

  const clearTab = async (id: number, deleteFiles?: boolean) => {
    const res = await request<{ cleared: number }>(`/tabs/${id}/clear${deleteFiles ? '?deleteFiles=true' : ''}`, { method: 'POST' })
    await refreshTabs()
    return res
  }

  const refreshOnboarding = async () => {
    try {
      const data = await request<{ completed: boolean; enabledMediaTypes: MediaType[] }>('/settings/onboarding')
      setEnabledMediaTypes(Array.isArray(data.enabledMediaTypes) && data.enabledMediaTypes.length ? data.enabledMediaTypes : ALL_MEDIA)
      setOnboardingCompleted(!!data.completed)
    } catch (err) {
      // If we can't determine state, don't block the app behind the wizard.
      console.error('Failed to fetch onboarding state:', err)
      setOnboardingCompleted(true)
    }
  }

  const completeOnboarding = async () => {
    try { await request('/settings/onboarding/complete', { method: 'POST' }) } catch (err) { console.error(err) }
    setOnboardingCompleted(true)
  }

  const saveEnabledMediaTypes = async (types: MediaType[]) => {
    const next = types.length ? types : ALL_MEDIA
    setEnabledMediaTypes(next)
    try {
      await request('/settings/enabled-media-types', { method: 'PUT', body: JSON.stringify({ types: next }) })
    } catch (err) { console.error('Failed to save enabled media types:', err) }
  }

  useEffect(() => {
    refreshTabs()
    refreshOnboarding()
  }, [])

  // Sync API context on mount if we have a saved ID
  useEffect(() => {
    if (activeTabId) {
      setTabContext(activeTabId.toString())
    }
  }, [activeTabId])

  const activeTab = tabs.find(t => t.id === activeTabId) || null

  return (
    <TabContext.Provider value={{
      tabs, activeTabId, activeTab, tabGeneration: getTabGeneration(),
      setActiveTabId, getActiveTabForMedia, setActiveTabForMedia,
      refreshTabs, createTab, updateTab, deleteTab, clearTab,
      enabledMediaTypes, onboardingCompleted, completeOnboarding, saveEnabledMediaTypes,
      relaunchOnboarding: () => setOnboardingCompleted(false)
    }}>
      {children}
    </TabContext.Provider>
  )
}

export function useTabs() {
  const context = useContext(TabContext)
  if (context === undefined) {
    throw new Error('useTabs must be used within a TabProvider')
  }
  return context
}
