import { useEffect, useRef } from 'react'

// ── Request cancellation ──────────────────────────────────────────────────────
// Two problems these solve:
//
//  1. **Stale responses.** Switch library tabs and the first request may land
//     after the second, overwriting correct data with the previous tab's. Rather
//     than detecting stale responses after the fact, we cancel them at the source
//     so they never arrive.
//  2. **Wasted work.** Navigating away used to leave requests running to
//     completion — server work and JSON parsing for a result nobody reads.
//
// React already calls effect cleanup on unmount and whenever dependencies change,
// which is exactly when cancellation should happen.

/**
 * Each call to the returned function cancels the previous in-flight request and
 * hands back a fresh signal, so overlapping loads can never race — whether they
 * come from a tab switch, a refresh button, or the repeated ticks of
 * `useLiveRefresh`. Any outstanding request is cancelled on unmount.
 *
 *   const nextSignal = useAbortController()
 *   const refresh = () => filmsApi.list({ signal: nextSignal() })
 *     .then(setFilms)
 *     .catch(err => { if (!isAbortError(err)) console.error(err) })
 *
 * The `catch` guard is required: aborting rejects the promise, and without it
 * navigating away would surface a spurious error.
 */
export function useAbortController(): () => AbortSignal {
  const ref = useRef<AbortController | null>(null)

  useEffect(() => () => ref.current?.abort(), [])

  return () => {
    ref.current?.abort()
    const controller = new AbortController()
    ref.current = controller
    return controller.signal
  }
}
