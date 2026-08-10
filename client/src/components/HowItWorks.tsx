import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'

/**
 * Shared "How it works" surface, modelled on the recommendations engine tab:
 * a plain-language walk through the pipeline, the levers that change it, the
 * vocabulary the UI uses, and the safety rules worth knowing about.
 *
 * Content is data, so every feature reads the same way.
 */

export interface HowItWorksStep { title: string; body: string }
export interface HowItWorksLever {
  label: string
  /** What the control does, in plain language. */
  what: string
  /** What actually happens when it changes — concrete numbers where possible. */
  effect: string
  /** Where the control lives, e.g. "Settings → Leaving Soon → Retention Policy". */
  where?: string
  /** Optional in-app route to that control. */
  to?: string
}
export interface HowItWorksTerm { term: string; body: string }
export interface HowItWorksCard { title: string; body: string }

export interface HowItWorksContent {
  title: string
  lede: string
  accent?: string
  steps: HowItWorksStep[]
  levers?: { title?: string; note?: string; items: HowItWorksLever[] }
  cards?: { title: string; note?: string; items: HowItWorksCard[] }
  glossary?: HowItWorksTerm[]
  safety?: { title?: string; items: string[] }
}

const DEFAULT_ACCENT = '#00D4FF'

export function HowItWorks({ content, children }: { content: HowItWorksContent; children?: ReactNode }) {
  const accent = content.accent ?? DEFAULT_ACCENT
  return (
    <div className="animate-fade-in space-y-8">
      <header className="max-w-3xl">
        <h2 className="font-display text-3xl uppercase tracking-widest text-white">{content.title}</h2>
        <p className="mt-2 text-sm leading-relaxed text-white/40">{content.lede}</p>
      </header>

      {children}

      <Section title="Step by step">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {content.steps.map((step, index) => (
            <div key={step.title} className="rounded-xl border border-white/5 bg-white/[0.02] p-4">
              <span className="font-mono text-[10px]" style={{ color: `${accent}b3` }}>STEP {index + 1}</span>
              <h4 className="mt-1 text-sm font-bold uppercase tracking-widest text-white/70">{step.title}</h4>
              <p className="mt-2 text-xs leading-relaxed text-white/40">{step.body}</p>
            </div>
          ))}
        </div>
      </Section>

      {content.levers && (
        <Section title={content.levers.title ?? 'The levers you can pull'} note={content.levers.note}>
          <div className="space-y-4">
            {content.levers.items.map(lever => (
              <div key={lever.label} className="rounded-xl border border-white/5 bg-white/[0.02] p-4">
                <span className="block text-[11px] font-bold uppercase tracking-widest text-white/60">{lever.label}</span>
                <p className="mt-1 text-xs leading-relaxed text-white/40">{lever.what}</p>
                <p className="mt-1.5 text-[11px] leading-relaxed" style={{ color: `${accent}99` }}>{lever.effect}</p>
                {lever.where && (
                  <p className="mt-2 font-mono text-[9px] uppercase tracking-widest text-white/25">
                    {lever.to
                      ? <Link to={lever.to} className="transition-colors hover:text-white/60">{lever.where} →</Link>
                      : lever.where}
                  </p>
                )}
              </div>
            ))}
          </div>
        </Section>
      )}

      {content.cards && (
        <Section title={content.cards.title} note={content.cards.note}>
          <div className="grid gap-3 md:grid-cols-2">
            {content.cards.items.map(card => (
              <div key={card.title} className="rounded-xl border border-white/5 bg-white/[0.02] p-4">
                <h4 className="text-sm text-white/75">{card.title}</h4>
                <p className="mt-1 text-xs leading-relaxed text-white/40">{card.body}</p>
              </div>
            ))}
          </div>
        </Section>
      )}

      {content.glossary && content.glossary.length > 0 && (
        <Section title="Glossary">
          <dl className="grid gap-4 md:grid-cols-2">
            {content.glossary.map(entry => (
              <div key={entry.term}>
                <dt className="text-[11px] font-bold uppercase tracking-widest text-white/55">{entry.term}</dt>
                <dd className="mt-1 text-xs leading-relaxed text-white/40">{entry.body}</dd>
              </div>
            ))}
          </dl>
        </Section>
      )}

      {content.safety && content.safety.items.length > 0 && (
        <Section title={content.safety.title ?? 'Good to know'}>
          <ul className="space-y-2">
            {content.safety.items.map(item => (
              <li key={item} className="flex gap-3 text-xs leading-relaxed text-white/40">
                <span aria-hidden="true" style={{ color: `${accent}80` }}>—</span>
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  )
}

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-white/5 bg-noir-900/70 p-5">
      <h3 className="text-xs font-bold uppercase tracking-widest text-white/60">{title}</h3>
      {note && <p className="mt-1 text-[11px] text-white/30">{note}</p>}
      <div className="mt-4">{children}</div>
    </section>
  )
}

/** Live status tiles, passed as children so each feature can supply real numbers. */
export function HowItWorksStats({ tiles }: { tiles: Array<{ label: string; value: string; hint?: string }> }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {tiles.map(tile => (
        <div key={tile.label} className="rounded-2xl border border-white/5 bg-noir-900/70 p-5">
          <p className="font-mono text-[9px] uppercase tracking-widest text-white/25">{tile.label}</p>
          <p className="mt-2 text-lg text-white/80">{tile.value}</p>
          {tile.hint && <p className="mt-1 text-[10px] text-white/25">{tile.hint}</p>}
        </div>
      ))}
    </div>
  )
}
