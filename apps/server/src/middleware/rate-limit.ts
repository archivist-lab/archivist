import type { Request, Response, NextFunction } from 'express'

interface Bucket {
  count: number
  resetAt: number
}

const buckets = new Map<string, Bucket>()

const cleanupTimer = setInterval(() => {
  const now = Date.now()
  for (const [key, bucket] of buckets) {
    if (now > bucket.resetAt) buckets.delete(key)
  }
}, 5 * 60 * 1_000)
cleanupTimer.unref?.()

export function rateLimit(maxRequests: number, windowMs: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = (req.ip ?? req.socket.remoteAddress ?? 'unknown') + req.path
    const now = Date.now()
    const bucket = buckets.get(key)

    if (!bucket || now > bucket.resetAt) {
      buckets.set(key, { count: 1, resetAt: now + windowMs })
      next()
      return
    }

    if (bucket.count >= maxRequests) {
      res.status(429).json({ error: 'Too many requests, please slow down' })
      return
    }

    bucket.count++
    next()
  }
}
