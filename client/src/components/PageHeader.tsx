import { ReactNode } from 'react'

interface Tab {
  id: string
  label: string
}

interface PageHeaderProps {
  title: string
  subtitle?: string
  accentClass: string
  tabs: Tab[]
  activeTab: string
  onTabChange: (id: string) => void
  children?: ReactNode
}

export function PageHeader({ title, subtitle, accentClass, tabs, activeTab, onTabChange, children }: PageHeaderProps) {
  return (
    <div className="mb-8 animate-fade-in">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className={`font-display text-5xl tracking-widest ${accentClass}`}>{title}</h1>
          {subtitle && <p className="text-white/30 text-sm mt-1 font-mono">{subtitle}</p>}
        </div>
        {children}
      </div>

      <div className="flex gap-8 border-b border-white/5">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => onTabChange(tab.id)}
            className={`pb-3 text-sm font-medium tracking-wide transition-all border-b-2 -mb-[2px]
              ${activeTab === tab.id 
                ? 'text-white border-[#00D4FF]' 
                : 'text-white/30 border-transparent hover:text-white/60'}`}
          >
            {tab.label}
          </button>
        ))}
      </div>
    </div>
  )
}
