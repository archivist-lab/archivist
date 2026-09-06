import { useEffect, useRef, useState, type ReactNode } from 'react'

/** Window-scrolled poster grid; only nearby rows are mounted. */
export function VirtualGrid<T>({ items, render, onVisible }: { items: T[]; render: (item: T, index: number) => ReactNode; onVisible?: (items: T[]) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [window, setWindow] = useState({ columns: 2, start: 0, end: 5, height: 450 })
  useEffect(() => {
    let frame = 0
    const measure = () => {
      const element = ref.current
      if (!element) return
      const rect = element.getBoundingClientRect()
      const width = rect.width
      const columns = Math.max(2, Math.min(6, Math.floor(width / 185)))
      const height = (width - (columns - 1) * 16) / columns * 1.5 + 160
      const start = Math.max(0, Math.floor(-rect.top / height) - 2)
      const end = Math.max(start + 1, Math.ceil((globalThis.innerHeight - rect.top) / height) + 2)
      setWindow(current => current.columns === columns && current.start === start && current.end === end && current.height === height ? current : { columns, start, end, height })
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; measure() }) }
    const observer = new ResizeObserver(schedule)
    if (ref.current) observer.observe(ref.current)
    globalThis.addEventListener('scroll', schedule, { passive: true }); globalThis.addEventListener('resize', schedule)
    measure()
    return () => { observer.disconnect(); cancelAnimationFrame(frame); globalThis.removeEventListener('scroll', schedule); globalThis.removeEventListener('resize', schedule) }
  }, [])
  const { columns, end, height } = window
  const start = Math.min(window.start, Math.max(0, Math.ceil(items.length / columns) - 1))
  const first = Math.min(items.length, start * columns)
  const last = Math.min(items.length, end * columns)
  const callback = useRef(onVisible); callback.current = onVisible
  useEffect(() => { callback.current?.(items.slice(first, last)) }, [items, first, last])
  return <div ref={ref} style={{ height: Math.ceil(items.length / columns) * height, position: 'relative' }}>
    <div style={{ position: 'absolute', top: start * height, left: 0, right: 0, display: 'grid', gridTemplateColumns: `repeat(${columns}, minmax(0,1fr))`, gridAutoRows: height, columnGap: 16 }}>
      {items.slice(first, last).map((item, index) => render(item, first + index))}
    </div>
  </div>
}
