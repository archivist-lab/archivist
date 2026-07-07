import { Component, type ReactNode, type ErrorInfo } from 'react'

interface Props {
  children: ReactNode
  /** Optional label shown in the error UI to identify which subtree failed. */
  label?: string
}

interface State {
  error: Error | null
  info: ErrorInfo | null
}

/**
 * Catches render-time exceptions in the child tree and displays a useful
 * fallback UI with the error message + component stack. Without this, a
 * single thrown ReferenceError/TypeError unmounts the whole tree and the
 * user sees a black screen with no clue what went wrong.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ info })
    // Keep a copy in the console so devs can investigate even after dismiss.
    console.error('[ErrorBoundary]', this.props.label ?? '', error, info)
  }

  reset = () => this.setState({ error: null, info: null })

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="p-12 max-w-3xl mx-auto">
        <div className="rounded-2xl border border-red-500/30 bg-red-500/5 p-8 space-y-4">
          <div className="flex items-baseline justify-between">
            <h2 className="text-[14px] font-bold text-red-400 uppercase tracking-widest">Something broke</h2>
            {this.props.label && <span className="text-[10px] font-mono text-white/30 uppercase tracking-widest">{this.props.label}</span>}
          </div>
          <p className="text-[12px] font-mono text-red-300 break-all">{this.state.error.message}</p>
          {this.state.info?.componentStack && (
            <details className="text-[10px] font-mono text-white/40">
              <summary className="cursor-pointer text-white/60 mb-2">Component stack</summary>
              <pre className="whitespace-pre-wrap break-all">{this.state.info.componentStack}</pre>
            </details>
          )}
          {this.state.error.stack && (
            <details className="text-[10px] font-mono text-white/40">
              <summary className="cursor-pointer text-white/60 mb-2">JS stack</summary>
              <pre className="whitespace-pre-wrap break-all">{this.state.error.stack}</pre>
            </details>
          )}
          <div className="flex gap-3 pt-2">
            <button onClick={this.reset}
              className="px-6 py-2 rounded-xl bg-white/5 hover:bg-white/10 text-white text-[10px] font-bold uppercase tracking-widest border border-white/10">
              Try again
            </button>
          </div>
        </div>
      </div>
    )
  }
}
