import { useState, useMemo } from 'react'
import { NavLink, useLocation, Link, useNavigate } from 'react-router-dom'
import Icon from '../icon.svg'
import { useTabs, librarySlug, Tab, type MediaType } from '../lib/tab-context.js'
import { useAuth } from './AuthGate.js'

interface NavItem {
  to: string
  icon: string
  label: string
  accent: string
  mediaType?: MediaType
  /** Show only when at least one of these media types has a library. */
  requiresAny?: MediaType[]
}

const NAV: NavItem[] = [
  { to: '/',       icon: '🏠', label: 'Home',         accent: 'cyan'    },
  { to: '/films',  icon: '🎬', label: 'Films',        accent: 'cyan',   mediaType: 'films'   },
  { to: '/series', icon: '📺', label: 'Series',       accent: 'violet', mediaType: 'series'  },
  { to: '/music',  icon: '🎵', label: 'Music',        accent: 'pink',   mediaType: 'music'   },
  { to: '/books',  icon: '📚', label: 'Books',        accent: 'yellow', mediaType: 'books'   },
  { to: '/comics', icon: '🦸', label: 'Comics',       accent: 'orange', mediaType: 'comics'  },
  { to: '/games',  icon: '🎮', label: 'Games',        accent: 'green',  mediaType: 'games'   },
  { to: '/channels', icon: '📡', label: 'Channels',   accent: 'cyan',   requiresAny: ['films', 'series'] },
  { to: '/acquisitions', icon: '⏬', label: 'Acquisitions', accent: 'cyan' },
  { to: '/settings',     icon: '⚙️', label: 'Settings',     accent: 'white'  },
]

const ACTIVE: Record<string, string> = {
  cyan:   'bg-cyan/10 text-cyan border border-cyan/60 shadow-[0_0_15px_rgba(0,212,255,0.1)]',
  violet: 'bg-violet/10 text-violet border border-violet/60 shadow-[0_0_15px_rgba(155,89,182,0.1)]',
  pink:   'bg-pink/10 text-pink border border-pink/60 shadow-[0_0_15px_rgba(255,45,120,0.1)]',
  yellow: 'bg-yellow-400/10 text-yellow-400 border border-yellow-400/60 shadow-[0_0_15px_rgba(250,204,21,0.1)]',
  orange: 'bg-orange-400/10 text-orange-400 border border-orange-400/60 shadow-[0_0_15px_rgba(251,146,60,0.1)]',
  green:  'bg-emerald-400/10 text-emerald-400 border border-emerald-400/60 shadow-[0_0_15px_rgba(52,211,153,0.1)]',
  white:  'bg-white/10 text-white border border-white/40 shadow-[0_0_15px_rgba(255,255,255,0.05)]',
}

export function Sidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const location = useLocation()
  const navigate = useNavigate()
  const { tabs, getActiveTabForMedia, setActiveTabForMedia, enabledMediaTypes } = useTabs()
  const { username, logout } = useAuth()
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  const tabsByMediaType = useMemo(() => {
    const groups: Record<string, Tab[]> = {}
    tabs.forEach(tab => {
      if (!groups[tab.media_type]) groups[tab.media_type] = []
      groups[tab.media_type].push(tab)
    })
    // Sort: "Main" first, then alphabetical by name
    for (const key of Object.keys(groups)) {
      groups[key].sort((a, b) => {
        const aMain = a.name.toLowerCase().includes('main') ? 0 : 1
        const bMain = b.name.toLowerCase().includes('main') ? 0 : 1
        if (aMain !== bMain) return aMain - bMain
        return a.name.localeCompare(b.name)
      })
    }
    return groups
  }, [tabs])

  const toggleExpanded = (label: string, current: boolean) => {
    setExpanded(prev => ({ ...prev, [label]: !current }))
  }

  return (
    <aside className={`fixed left-0 top-0 h-full bg-noir-900 border-r border-white/5 flex flex-col z-50 transition-all duration-500 ease-in-out ${collapsed ? 'w-16' : 'w-14 lg:w-52'}`}>
      {/* Logo */}
      <div className="py-4 px-2 border-b border-white/5 flex-shrink-0 cursor-pointer hover:bg-white/5 transition-colors flex items-center overflow-hidden"
        onClick={onToggle}>
        <img src={Icon} alt="Archivist Logo" className="w-12 h-12 flex-shrink-0" />
        <span className={`ml-3 font-display text-2xl tracking-widest text-gradient-full transition-all duration-500 whitespace-nowrap ${collapsed ? 'opacity-0 translate-x-4 pointer-events-none' : 'opacity-100 translate-x-0'}`}>
          ARCHIVIST
        </span>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-2 py-6 space-y-1 overflow-y-auto overflow-x-hidden custom-scrollbar">
        {NAV.filter(item => {
          if (item.requiresAny) return item.requiresAny.some(t => enabledMediaTypes.includes(t))
          return !item.mediaType || enabledMediaTypes.includes(item.mediaType)
        }).map((item) => {
          const { to, icon, label, accent, mediaType } = item
          const isActive = to === '/' ? location.pathname === '/' : location.pathname.startsWith(to)

          const groupTabs = mediaType ? tabsByMediaType[mediaType] || [] : []
          const hasMultiple = groupTabs.length > 1
          // Auto-expand the section you're currently in so its libraries are
          // visible without hunting for the chevron; a manual toggle overrides.
          const isExpanded = expanded[label] !== undefined ? expanded[label] : isActive

          // The remembered tab for this media type
          const selectedTab = mediaType ? getActiveTabForMedia(mediaType) : null

          return (
            <div key={label} className="flex flex-col">
              <div className="relative flex items-center group">
                <NavLink
                  to={to}
                  onClick={() => {
                    // When clicking a nav item, switch to its remembered tab
                    if (selectedTab) {
                      setActiveTabForMedia(mediaType!, selectedTab.id)
                    }
                  }}
                  className={`flex-1 flex items-center h-11 rounded-lg transition-all duration-300 text-sm overflow-hidden border border-transparent
                    ${isActive ? ACTIVE[accent] : 'text-white/30 hover:text-white/65 hover:bg-white/5'}`}
                >
                  <span className="w-12 flex-shrink-0 flex items-center justify-center text-lg">{icon}</span>
                  <span className={`ml-1 font-medium tracking-wide transition-all duration-500 whitespace-nowrap ${collapsed ? 'opacity-0 translate-x-4 pointer-events-none' : 'opacity-100 translate-x-0'}`}>
                    {label}
                  </span>
                  {hasMultiple && (
                    <span className={`ml-2 px-1.5 py-0.5 rounded-full text-[9px] font-bold leading-none bg-white/10 text-white/60 transition-all duration-500 ${collapsed ? 'opacity-0 pointer-events-none' : 'opacity-100'}`}
                      title={`${groupTabs.length} libraries`}>
                      {groupTabs.length}
                    </span>
                  )}
                </NavLink>

                {hasMultiple && !collapsed && (
                  <button
                    onClick={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      toggleExpanded(label, isExpanded)
                    }}
                    className={`absolute right-1 w-8 h-8 flex items-center justify-center transition-all duration-300 ${isExpanded ? 'rotate-180' : ''} text-white/45 hover:text-white`}
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>
                )}
              </div>

              {hasMultiple && isExpanded && !collapsed && (
                <div className="mt-1 ml-6 pl-4 border-l border-white/5 space-y-1">
                  {groupTabs.map(tab => {
                    const isSelected = selectedTab?.id === tab.id
                    return (
                      <button
                        key={tab.id}
                        onClick={() => {
                          setActiveTabForMedia(mediaType!, tab.id)
                          // Films library pages have slug URLs (/films/<slug>);
                          // other types still use the flat section path for now.
                          navigate(mediaType === 'films' ? `${to}/${librarySlug(tab.name)}` : to)
                        }}
                        className={`w-full flex items-center h-9 px-3 rounded-lg text-xs font-medium transition-all duration-200
                          ${isSelected
                            ? 'bg-white/10 text-white border border-white/10 shadow-sm'
                            : 'text-white/40 hover:text-white/70 hover:bg-white/5'}`}
                      >
                        <span className="truncate">
                          {tab.name.replace(/Films|Series|Music|Books|Comics|Games/i, '').trim() || tab.name}
                        </span>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}

        {!collapsed && (
          <div className="pt-4 mt-4 border-t border-white/5">
            <Link to="/settings" className="flex items-center px-3 py-2 text-[10px] font-bold text-[#00D4FF]/40 hover:text-[#00D4FF] transition-colors uppercase tracking-widest">
              + Manage Libraries
            </Link>
          </div>
        )}
      </nav>

      <div className="flex-shrink-0 border-t border-white/5 p-2">
        {!collapsed && username && (
          <div className="truncate px-3 pb-2 text-[10px] font-medium uppercase text-white/35" title={username}>
            {username}
          </div>
        )}
        <button
          type="button"
          title="Sign out"
          onClick={() => void logout()}
          className="w-full h-9 rounded text-xs font-medium text-white/45 hover:text-white hover:bg-white/5 transition-colors"
        >
          {collapsed ? 'Out' : 'Sign out'}
        </button>
      </div>
    </aside>
  )
}
