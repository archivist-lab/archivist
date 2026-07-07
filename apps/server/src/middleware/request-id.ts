import { randomUUID } from 'node:crypto'
import type { Request, Response, NextFunction } from 'express'

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction) {
  const incoming = req.header('x-request-id')
  req.requestId = incoming && incoming.length <= 128 ? incoming : randomUUID()
  res.setHeader('x-request-id', req.requestId)
  next()
}
