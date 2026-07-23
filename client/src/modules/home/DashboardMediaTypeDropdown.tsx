import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export interface DashboardMediaTypeOption {
  value: string
  label: string
  icon: string
  color: string
}

export function DashboardMediaTypeDropdown({
  options,
  selected,
  onChange,
  multiple,
  allowAll = false,
  allLabel = 'All Media Types',
  menuLabel = 'Select Media Type',
}: {
  options: DashboardMediaTypeOption[]
  selected: Set<string>
  onChange: (next: Set<string>) => void
  multiple: boolean
  allowAll?: boolean
  allLabel?: string
  menuLabel?: string
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [menuPosition, setMenuPosition] = useState({ left: 8, top: 8, width: 260, maxHeight: 480 })
  const allSelected = allowAll && selected.has('all')
  const selectedOptions = useMemo(
    () => options.filter(option => selected.has(option.value)),
    [options, selected],
  )

  useEffect(() => {
    if (!open) return
    const pointerDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false)
    }
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', pointerDown)
    document.addEventListener('keydown', keyDown)
    return () => {
      document.removeEventListener('mousedown', pointerDown)
      document.removeEventListener('keydown', keyDown)
    }
  }, [open])

  useLayoutEffect(() => {
    if (!open) return
    const placeMenu = () => {
      const trigger = triggerRef.current
      if (!trigger) return
      const rect = trigger.getBoundingClientRect()
      const viewportPadding = 8
      const menuGap = 8
      // Keep the menu's left edge anchored to the trigger. If there is less
      // horizontal room than the preferred menu width, shrink it instead of
      // shifting it sideways and visually detaching it from the control.
      const left = Math.max(viewportPadding, rect.left)
      const availableWidth = window.innerWidth - left - viewportPadding
      const width = Math.min(Math.max(rect.width, 260), availableWidth)

      const menu = menuRef.current
      const naturalHeight = Math.min(menu?.scrollHeight ?? 480, 480)
      const roomBelow = Math.max(0, window.innerHeight - rect.bottom - menuGap - viewportPadding)
      const roomAbove = Math.max(0, rect.top - menuGap - viewportPadding)
      const placeAbove = naturalHeight > roomBelow && roomAbove > roomBelow
      const maxHeight = Math.max(0, Math.min(480, placeAbove ? roomAbove : roomBelow))
      const renderedHeight = Math.min(naturalHeight, maxHeight)
      const top = placeAbove
        ? rect.top - menuGap - renderedHeight
        : rect.bottom + menuGap

      setMenuPosition({ left, top, width, maxHeight })
    }
    placeMenu()
    const frame = requestAnimationFrame(placeMenu)
    window.addEventListener('resize', placeMenu)
    window.addEventListener('scroll', placeMenu, true)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', placeMenu)
      window.removeEventListener('scroll', placeMenu, true)
    }
  }, [open, options.length])

  const selectOption = (value: string) => {
    if (!multiple) {
      onChange(new Set([value]))
      setOpen(false)
      return
    }
    const next = new Set(selected)
    next.delete('all')
    if (next.has(value)) next.delete(value)
    else next.add(value)
    onChange(next)
  }

  const summary = allSelected
    ? allLabel
    : selectedOptions.length === 0
      ? 'No Media Types'
      : selectedOptions.length === 1
        ? selectedOptions[0].label
        : `${selectedOptions.length} Media Types`
  const leadingOption = allSelected ? null : selectedOptions[0]

  return (
    <div ref={rootRef} className="relative w-full min-w-[220px] max-w-[320px]">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(value => !value)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex w-full items-center gap-3 rounded-xl border border-white/10 bg-noir-950/50 px-5 py-3 text-left text-sm text-white/70 shadow-2xl outline-none transition-all hover:border-white/20 hover:bg-noir-950/65 focus:border-white/20 focus:bg-noir-950/65"
      >
        {leadingOption && <span aria-hidden="true" className="text-sm">{leadingOption.icon}</span>}
        <span className="min-w-0 flex-1 truncate">{summary}</span>
        {multiple && !allSelected && selectedOptions.length > 0 && (
          <span className="rounded-md border border-[#00D4FF]/20 bg-[#00D4FF]/10 px-2 py-0.5 font-mono text-[9px] font-bold text-[#00D4FF]">{selectedOptions.length}</span>
        )}
        <span aria-hidden="true" className={`text-[9px] text-white/20 transition-transform ${open ? 'rotate-180 text-white/40' : ''}`}>▼</span>
      </button>

      {open && typeof document !== 'undefined' && createPortal(
        <div
          ref={menuRef}
          role="listbox"
          aria-multiselectable={multiple || undefined}
          className="fixed z-[200] overflow-y-auto rounded-2xl border border-white/10 bg-noir-900/95 shadow-2xl backdrop-blur-xl custom-scrollbar"
          style={{ left: menuPosition.left, top: menuPosition.top, width: menuPosition.width, maxHeight: menuPosition.maxHeight }}
        >
          <div className="border-b border-white/5 px-4 py-3">
            <p className="font-mono text-[9px] font-bold uppercase tracking-[0.2em] text-white/25">{menuLabel}</p>
          </div>
          <div className="p-2">
            {allowAll && (
              <button
                type="button"
                role="option"
                aria-selected={allSelected}
                onClick={() => { onChange(new Set(['all'])); if (!multiple) setOpen(false) }}
                className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-[10px] font-bold uppercase tracking-widest transition-all hover:bg-white/5 ${allSelected ? 'bg-white/5 text-white' : 'text-white/50'}`}
              >
                <SelectionMark checked={allSelected} color="#00D4FF" />
                <span>{allLabel}</span>
              </button>
            )}
            {allowAll && <div className="my-1 h-px bg-white/5" />}
            {options.map(option => {
              const checked = selected.has(option.value)
              return (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={checked}
                  onClick={() => selectOption(option.value)}
                  className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-[10px] font-bold uppercase tracking-widest transition-all hover:bg-white/5 ${checked ? 'bg-white/5' : 'text-white/50'}`}
                  style={checked ? { color: option.color } : undefined}
                >
                  <SelectionMark checked={checked} color={option.color} />
                  <span aria-hidden="true" className="text-sm">{option.icon}</span>
                  <span className="truncate">{option.label}</span>
                </button>
              )
            })}
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}

function SelectionMark({ checked, color }: { checked: boolean; color: string }) {
  return (
    <span
      aria-hidden="true"
      className={`grid h-4 w-4 shrink-0 place-items-center rounded-md border bg-noir-950/50 text-[9px] shadow-inner ${checked ? '' : 'border-white/15 text-transparent'}`}
      style={checked ? { borderColor: `${color}80`, backgroundColor: `${color}20`, color } : undefined}
    >
      {checked ? '✓' : ''}
    </span>
  )
}
