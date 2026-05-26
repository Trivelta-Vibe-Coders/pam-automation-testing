import { Response } from 'express';
import { ActivityEvent, ActivityLevel } from './types';

// ── In-memory ring buffer (last 500 events) ───────────────────────────────────
const MAX_EVENTS = 500;
const events: ActivityEvent[] = [];

// ── SSE subscriber set ────────────────────────────────────────────────────────
const subscribers = new Set<Response>();

let counter = 0;

function makeId(): string {
  return `${Date.now()}-${(++counter).toString().padStart(4, '0')}`;
}

// ── Public API ────────────────────────────────────────────────────────────────

export function log(
  level: ActivityLevel,
  message: string,
  details?: Record<string, unknown>,
): ActivityEvent {
  const event: ActivityEvent = {
    id:        makeId(),
    timestamp: new Date().toISOString(),
    level,
    message,
    details,
  };

  // console mirror
  const prefix = {
    info:    '[ INFO ]',
    success: '[  OK  ]',
    warning: '[ WARN ]',
    error:   '[ERROR ]',
  }[level];
  console.log(`${prefix} ${event.timestamp} ${message}`, details ? JSON.stringify(details) : '');

  // ring buffer
  events.push(event);
  if (events.length > MAX_EVENTS) events.shift();

  // broadcast to SSE subscribers
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of subscribers) {
    try { res.write(data); } catch { subscribers.delete(res); }
  }

  return event;
}

export const info    = (msg: string, d?: Record<string, unknown>) => log('info',    msg, d);
export const success = (msg: string, d?: Record<string, unknown>) => log('success', msg, d);
export const warn    = (msg: string, d?: Record<string, unknown>) => log('warning', msg, d);
export const error   = (msg: string, d?: Record<string, unknown>) => log('error',   msg, d);

export function getHistory(): ActivityEvent[] {
  return [...events];
}

// ── SSE helpers ───────────────────────────────────────────────────────────────

export function addSubscriber(res: Response): void {
  subscribers.add(res);
}

export function removeSubscriber(res: Response): void {
  subscribers.delete(res);
}
