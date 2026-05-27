import fs   from 'fs';
import path from 'path';
import { Response } from 'express';
import { ActivityEvent, ActivityLevel } from './types';
import * as ticketStore from './services/ticket-store';

// ── In-memory ring buffer (last 500 events) ───────────────────────────────────
const MAX_EVENTS = 500;
const events: ActivityEvent[] = [];

// ── File persistence ──────────────────────────────────────────────────────────
const DATA_DIR    = process.env['DATA_DIR'] ?? '/app/data';
const EVENTS_PATH = path.join(DATA_DIR, 'events.json');

function loadFromDisk(): void {
  try {
    if (!fs.existsSync(EVENTS_PATH)) return;
    const raw: ActivityEvent[] = JSON.parse(fs.readFileSync(EVENTS_PATH, 'utf-8'));
    // Keep only the most recent MAX_EVENTS entries
    const slice = raw.slice(-MAX_EVENTS);
    events.push(...slice);
    console.log(`[logger] Restored ${events.length} event(s) from ${EVENTS_PATH}`);
  } catch (err) {
    console.warn('[logger] Could not restore events:', err);
  }
}

function saveToDisk(): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(EVENTS_PATH, JSON.stringify(events, null, 2));
  } catch (err) {
    console.warn('[logger] Could not persist events:', err);
  }
}

// Restore previous session's events at startup
loadFromDisk();

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

  // persist activity log to volume
  saveToDisk();

  // persist to per-ticket store (independent of ring buffer limit)
  const pamKey = ticketStore.extractPamKey(message, details);
  if (pamKey) ticketStore.addEvent(pamKey, event);

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
