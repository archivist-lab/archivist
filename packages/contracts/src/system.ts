import { z } from 'zod'

export const JobStatus = z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled'])
export type JobStatus = z.infer<typeof JobStatus>

export const EventSeverity = z.enum(['debug', 'info', 'warn', 'error'])
export type EventSeverity = z.infer<typeof EventSeverity>

export const SystemJob = z.object({
  id: z.number().int(),
  type: z.string(),
  status: JobStatus,
  subjectType: z.string().nullable(),
  subjectId: z.string().nullable(),
  attempts: z.number().int(),
  maxAttempts: z.number().int(),
  payload: z.string(),
  lastError: z.string().nullable(),
  availableAt: z.string(),
  lockedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
})
export type SystemJob = z.infer<typeof SystemJob>

export const SystemEvent = z.object({
  id: z.number().int(),
  ts: z.string(),
  category: z.string(),
  action: z.string(),
  severity: EventSeverity,
  subjectType: z.string().nullable(),
  subjectId: z.string().nullable(),
  message: z.string(),
  data: z.string(),
})
export type SystemEvent = z.infer<typeof SystemEvent>

export const HealthResponse = z.object({
  status: z.literal('ok'),
  version: z.string(),
})
export type HealthResponse = z.infer<typeof HealthResponse>
