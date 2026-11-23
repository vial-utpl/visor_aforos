// Edge Function `ingest`: the only way in for the counting devices (FreeCount Traffic on a Jetson, or the emulator).
//
// POST /functions/v1/ingest
//   header  x-device-token: <the device's token>   (no Supabase key: verify_jwt = false, see config.toml)
//   body    {
//     "app_version": "0.2.1",
//     "live": { "status": "running", "fps": 14.7, "period_start": "2026-11-23T08:15:00-05:00", "minutes_measured": 7,
//               "counts": { "ab": { "car": 3, ... }, "ba": { ... } }, "pending": 0, "clock_synced": true } | null,
//     "periods": [ { "period_start": "2026-11-23T08:00:00-05:00", "direction": "ab", "minutes_measured": 15,
//                    "car": 12, "truck": 1, "bus": 0, "motorcycle": 3, "bicycle": 0, "person": 2,
//                    "speed_bins": [0, 1, 3, 5, 2, 1, 0, 0, 0, 0, 0, 0] }, ... ]
//   }
//   reply   { "ok": true, "device": "<name>", "accepted": 2, "rejected": [ { "index": 3, "reason": "..." } ] }
//
// Sending a period again replaces it (upsert on device + period + direction): a device that was offline uploads its
// queue when it is back, and a retry after a timeout never counts twice.

import { createClient } from 'npm:@supabase/supabase-js@2.119.2'

const MAX_BODY_BYTES = 1_000_000
const MAX_PERIODS = 2000
const PERIOD_MS = 15 * 60 * 1000
const CLASSES = ['car', 'truck', 'bus', 'motorcycle', 'bicycle', 'person'] as const
const STATUSES = new Set(['running', 'reconnecting', 'stopped', 'error'])

const url = Deno.env.get('SUPABASE_URL')!
const secretKeys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}') as Record<string, string>
const secret = secretKeys['default'] ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const db = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } })

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

const isCount = (v: unknown) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 32767

type PeriodRow = Record<string, unknown>

/** A valid row for counts_15min, or the reason it is not. */
function checkPeriod(p: Record<string, unknown>, deviceId: string, siteId: string): PeriodRow | string {
  const t = Date.parse(String(p.period_start ?? ''))
  if (Number.isNaN(t)) return 'period_start is not a date'
  if (t % PERIOD_MS !== 0) return 'period_start is not on a 15-minute boundary'
  if (t > Date.now() + PERIOD_MS) return 'period_start is in the future'
  if (p.direction !== 'ab' && p.direction !== 'ba') return 'direction must be "ab" or "ba"'
  const m = p.minutes_measured
  if (!Number.isInteger(m) || (m as number) < 0 || (m as number) > 15) return 'minutes_measured must be 0..15'
  const row: PeriodRow = {
    device_id: deviceId,
    site_id: siteId,
    period_start: new Date(t).toISOString(),
    direction: p.direction,
    minutes_measured: m,
    received_at: new Date().toISOString(),
  }
  for (const c of CLASSES) {
    const v = p[c] ?? 0
    if (!isCount(v)) return `${c} must be a whole number 0..32767`
    row[c] = v
  }
  if (p.speed_bins == null) {
    row.speed_bins = null
  } else if (Array.isArray(p.speed_bins) && p.speed_bins.length === 12 && p.speed_bins.every(isCount)) {
    row.speed_bins = p.speed_bins
  } else {
    return 'speed_bins must be 12 whole numbers'
  }
  return row
}

function checkLive(l: Record<string, unknown>): Record<string, unknown> | string {
  if (!STATUSES.has(String(l.status))) return 'live.status must be running, reconnecting, stopped or error'
  const out: Record<string, unknown> = { status: l.status, updated_at: new Date().toISOString() }
  out.fps = typeof l.fps === 'number' && Number.isFinite(l.fps) ? l.fps : null
  out.pending = Number.isInteger(l.pending) && (l.pending as number) >= 0 ? l.pending : 0
  out.clock_synced = typeof l.clock_synced === 'boolean' ? l.clock_synced : null
  out.minutes_measured = Number.isInteger(l.minutes_measured) ? l.minutes_measured : null
  if (l.period_start != null) {
    const t = Date.parse(String(l.period_start))
    if (Number.isNaN(t)) return 'live.period_start is not a date'
    out.period_start = new Date(t).toISOString()
  } else {
    out.period_start = null
  }
  const counts: Record<string, Record<string, number>> = {}
  const raw = (l.counts ?? {}) as Record<string, Record<string, unknown>>
  for (const d of ['ab', 'ba']) {
    counts[d] = {}
    for (const c of CLASSES) {
      const v = raw?.[d]?.[c] ?? 0
      if (!isCount(v)) return `live.counts.${d}.${c} must be a whole number`
      counts[d][c] = v as number
    }
  }
  out.counts = counts
  return out
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json(405, { ok: false, error: 'use POST' })
  const token = req.headers.get('x-device-token') ?? ''
  if (token.length < 32) return json(401, { ok: false, error: 'missing or short x-device-token' })
  if (Number(req.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return json(413, { ok: false, error: 'body too large' })

  const { data: device, error: devErr } = await db
    .from('devices')
    .select('id, site_id, name, active')
    .eq('token_hash', await sha256Hex(token))
    .maybeSingle()
  if (devErr) return json(500, { ok: false, error: 'device lookup failed' })
  if (!device || !device.active) return json(401, { ok: false, error: 'unknown or disabled device' })

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return json(400, { ok: false, error: 'body is not JSON' })
  }

  const periods = Array.isArray(body.periods) ? body.periods : []
  if (periods.length > MAX_PERIODS) return json(413, { ok: false, error: `at most ${MAX_PERIODS} periods per request` })
  const rows: PeriodRow[] = []
  const rejected: { index: number; reason: string }[] = []
  periods.forEach((p, index) => {
    const r = typeof p === 'object' && p ? checkPeriod(p as Record<string, unknown>, device.id, device.site_id) : 'not an object'
    if (typeof r === 'string') rejected.push({ index, reason: r })
    else rows.push(r)
  })

  if (rows.length > 0) {
    const { error } = await db.from('counts_15min').upsert(rows, { onConflict: 'device_id,period_start,direction' })
    if (error) return json(500, { ok: false, error: 'saving the periods failed', detail: error.message })
  }

  if (body.live && typeof body.live === 'object') {
    const live = checkLive(body.live as Record<string, unknown>)
    if (typeof live === 'string') {
      rejected.push({ index: -1, reason: live })
    } else {
      const { error } = await db.from('device_live').upsert({ device_id: device.id, site_id: device.site_id, ...live })
      if (error) return json(500, { ok: false, error: 'saving the live status failed', detail: error.message })
    }
  }

  const appVersion = typeof body.app_version === 'string' ? body.app_version.slice(0, 40) : null
  await db.from('devices').update({ last_seen: new Date().toISOString(), ...(appVersion ? { app_version: appVersion } : {}) }).eq('id', device.id)

  return json(200, { ok: true, device: device.name, accepted: rows.length, rejected })
})
