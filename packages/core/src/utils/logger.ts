type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }
const SECRET_KEYS = /api[_-]?key|password|passwd|secret|token|authorization|cookie|session/i

function minLevel(): LogLevel {
  const env = process.env.LOG_LEVEL?.toLowerCase()
  if (env && env in LEVELS) return env as LogLevel
  return 'info'
}

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[MaxDepth]'
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack }
  if (Array.isArray(value)) return value.map(v => redact(v, depth + 1))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEYS.test(key) ? '[REDACTED]' : redact(val, depth + 1)
    }
    return out
  }
  if (typeof value === 'string') {
    return value
      .replace(/(bearer\s+)[a-z0-9._~+/-]+=*/ig, '$1[REDACTED]')
      .replace(/(apikey|api_key|token|password|secret)=([^&\s]+)/ig, '$1=[REDACTED]')
  }
  return value
}

function emit(level: LogLevel, context: string, message: string, ...args: unknown[]): void {
  if (LEVELS[level] < LEVELS[minLevel()]) return
  const ts = new Date().toISOString()
  const safeArgs = args.map(arg => redact(arg))
  if (process.env.LOG_FORMAT === 'json') {
    const record = { ts, level, context, message: redact(message), args: safeArgs }
    const line = JSON.stringify(record)
    if (level === 'error') console.error(line)
    else if (level === 'warn') console.warn(line)
    else console.log(line)
    return
  }
  const line = `[${ts}] [${level.toUpperCase().padEnd(5)}] [${context}] ${redact(message)}`
  if (level === 'error') console.error(line, ...safeArgs)
  else if (level === 'warn') console.warn(line, ...safeArgs)
  else console.log(line, ...safeArgs)
}

export function createLogger(context: string) {
  return {
    debug: (msg: string, ...args: unknown[]) => emit('debug', context, msg, ...args),
    info:  (msg: string, ...args: unknown[]) => emit('info',  context, msg, ...args),
    warn:  (msg: string, ...args: unknown[]) => emit('warn',  context, msg, ...args),
    error: (msg: string, ...args: unknown[]) => emit('error', context, msg, ...args),
  }
}

export type Logger = ReturnType<typeof createLogger>
