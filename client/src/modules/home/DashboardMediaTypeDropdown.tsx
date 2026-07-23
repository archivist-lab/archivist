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
      // The app applies `html { zoom }` (see index.css). getBoundingClientRect()
      // and window.inner* report post-zoom *visual* pixels, but this menu is
      // portaled into <body> — inside the zoomed <html> — so the left/top/width
      // we set on it are interpreted in the *zoomed* coordinate space and get
      // scaled again. That double-scaling is what makes the menu drift off the
      // trigger (worse the further from the origin). Compute the geometry in
      // visual pixels, then divide by the effective zoom to cancel it out, so
      // the menu lands exactly on the control like the calendar dropdown does.
      const zoom = readEffectiveZoom(trigger)

      // Keep the menu's left edge anchored to the trigger and mirror its width
      // exactly (like the calendar dropdown) so it stays visually "in line"
      // instead of detaching. Shrink rather than shift if room is tight.
      const leftV = Math.max(viewportPadding, rect.left)
      const availableWidthV = window.innerWidth - leftV - viewportPadding
      const widthV = Math.min(rect.width, availableWidthV)

      const menu = menuRef.current
      // scrollHeight is a layout metric that does NOT include zoom, so scale it
      // up to visual pixels before comparing against the visual-space room.
      const naturalHeightV = Math.min((menu?.scrollHeight ?? 480) * zoom, 480)
      const roomBelow = Math.max(0, window.innerHeight - rect.bottom - menuGap - viewportPadding)
      const roomAbove = Math.max(0, rect.top - menuGap - viewportPadding)
      const placeAbove = naturalHeightV > roomBelow && roomAbove > roomBelow
      const maxHeightV = Math.max(0, Math.min(480, placeAbove ? roomAbove : roomBelow))
      const renderedHeightV = Math.min(naturalHeightV, maxHeightV)
      const topV = placeAbove
        ? rect.top - menuGap - renderedHeightV
        : rect.bottom + menuGap

      setMenuPosition({
        left: leftV / zoom,
        top: topV / zoom,
        width: widthV / zoom,
        maxHeight: maxHeightV / zoom,
      })
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
    <div ref={rootRef} className="relative w-full min-w-[176px] max-w-[256px]">
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

// Effective cumulative CSS zoom applied to an element. Prefers the exact
// `currentCSSZoom` API and falls back to reading the computed `zoom` (numeric
// or percentage) so positioning math can cancel out `html { zoom }`.
function readEffectiveZoom(el: Element): number {
  const current = (el as unknown as { currentCSSZoom?: number }).currentCSSZoom
  if (typeof current === 'number' && current > 0) return current
  const raw = getComputedStyle(document.documentElement).getPropertyValue('zoom').trim()
  if (!raw || raw === 'normal') return 1
  const value = parseFloat(raw)
  if (!Number.isFinite(value) || value <= 0) return 1
  return raw.endsWith('%') ? value / 100 : value
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
