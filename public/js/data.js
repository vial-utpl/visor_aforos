// Acceso a Supabase: sesión, estaciones, series, velocidades y estado en vivo.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.119.2/+esm'
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, OFFLINE_AFTER_MS } from './config.js'

export const db = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY)

// Orden de apilado (de abajo hacia arriba) y colores de cada clase en todo el visor.
export const CLASSES = [
  { key: 'person', label: 'Peatones', color: '#e8774a', motor: false, icon: 'person' },
  { key: 'bicycle', label: 'Bicicletas', color: '#22976b', motor: false, icon: 'bicycle' },
  { key: 'motorcycle', label: 'Motos', color: '#7a5fc4', motor: true, icon: 'motorcycle' },
  { key: 'car', label: 'Autos', color: '#3497c4', motor: true, icon: 'car' },
  { key: 'bus', label: 'Buses', color: '#d29a17', motor: true, icon: 'bus' },
  { key: 'truck', label: 'Camiones', color: '#0e5687', motor: true, icon: 'truck' },
]
// Orden de lectura en tarjetas, tablas y listas (de lo más frecuente a lo menos).
export const DISPLAY = ['car', 'motorcycle', 'bus', 'truck', 'bicycle', 'person'].map((k) => CLASSES.find((c) => c.key === k))
export const MOTOR =CLASSES.filter((c) => c.motor).map((c) => c.key)
export const motorOf = (row) => (row ? MOTOR.reduce((s, k) => s + Number(row[k] ?? 0), 0) : null)

/** Estaciones para el mapa: tramo GeoJSON, vehículos de la última hora y estado del equipo. */
export async function siteOverview() {
  const { data, error } = await db.from('site_overview').select('*').order('name')
  if (error) throw error
  return data
}

export async function site(id) {
  const { data, error } = await db.from('site_overview').select('*').eq('id', id).maybeSingle()
  if (error) throw error
  return data
}

/** Todas las filas de una RPC, en páginas de 1000 (límite de la API). */
async function rpcAll(fn, args) {
  const out = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.rpc(fn, args).range(from, from + 999)
    if (error) throw error
    out.push(...data)
    if (data.length < 1000) return out
  }
}

/** Serie agrupada en intervalos de `bucket` minutos: filas por intervalo y sentido. */
export function series(siteId, from, to, bucket) {
  return rpcAll('get_site_series', { p_site: siteId, p_from: from.toISOString(), p_to: to.toISOString(), p_bucket_minutes: bucket })
}

/** Vehículos motorizados por rango de 10 km/h (12 valores). */
export async function speeds(siteId, from, to) {
  const { data, error } = await db.rpc('get_site_speeds', { p_site: siteId, p_from: from.toISOString(), p_to: to.toISOString() })
  if (error) throw error
  return data.map((r) => Number(r.vehicles))
}

/** Vehículos motorizados por hora del día y rango de 10 km/h: matriz [24][12]. */
export async function speedsByHour(siteId, from, to) {
  const rows = await rpcAll('get_site_speeds_by_hour', { p_site: siteId, p_from: from.toISOString(), p_to: to.toISOString() })
  const m = Array.from({ length: 24 }, () => Array(12).fill(0))
  for (const r of rows) m[r.hour][r.bin] = Number(r.vehicles)
  return m
}

/** V85 (km/h) de un histograma de 12 rangos de 10 km/h, interpolando dentro del rango; null si no hay datos. */
export function v85(counts, minVehicles = 1) {
  const total = counts.reduce((a, b) => a + b, 0)
  if (total < minVehicles) return null
  let acc = 0
  for (let i = 0; i < 12; i++) {
    if (acc + counts[i] >= 0.85 * total) return i * 10 + (10 * (0.85 * total - acc)) / Math.max(1, counts[i])
    acc += counts[i]
  }
  return 110
}

/** Totales por clase de los periodos cerrados de la última hora, V85 y hora del último periodo. */
export async function lastHour(siteId) {
  const to = new Date()
  const from = new Date(to.getTime() - 3_600_000)
  const [rows, sp] = await Promise.all([series(siteId, from, to, 15), speeds(siteId, from, to)])
  const sums = Object.fromEntries(CLASSES.map((c) => [c.key, 0]))
  let last = null
  for (const r of rows) {
    for (const c of CLASSES) sums[c.key] += Number(r[c.key])
    if (!last || r.bucket_start > last) last = r.bucket_start
  }
  return { sums, v85: v85(sp, 5), last: last ? new Date(Date.parse(last) + 15 * 60_000) : null, periods: rows.length }
}

export async function liveRow(siteId) {
  const { data, error } = await db.from('device_live').select('*').eq('site_id', siteId).order('updated_at', { ascending: false }).limit(1)
  if (error) throw error
  return data[0] ?? null
}

/** Cambios del estado en vivo de una estación (Realtime). Devuelve la función para cancelar. */
export function onLive(siteId, cb) {
  const ch = db
    .channel(`live-${siteId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'device_live', filter: `site_id=eq.${siteId}` }, (p) => cb(p.new))
    .subscribe()
  return () => db.removeChannel(ch)
}

/** 'ok' | 'warn' (reconectando) | 'off' (sin datos recientes) */
export function liveState(status, updatedAt) {
  if (!updatedAt || Date.now() - Date.parse(updatedAt) > OFFLINE_AFTER_MS) return 'off'
  if (status === 'running') return 'ok'
  return 'warn'
}

export function ago(iso) {
  if (!iso) return 'nunca'
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000)
  if (s < 60) return `hace ${s} s`
  if (s < 3600) return `hace ${Math.round(s / 60)} min`
  if (s < 86400) return `hace ${Math.round(s / 3600)} h`
  return new Date(iso).toLocaleString('es-EC')
}

export const fmt = (n) => Number(n ?? 0).toLocaleString('es-EC')
export const pct = (n, total) => (total ? `${((100 * n) / total).toLocaleString('es-EC', { maximumFractionDigits: 1 })} %` : '–')
export const dateTime = (d) =>
  d.toLocaleString('es-EC', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })

/** Texto seguro para insertar en HTML. */
export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
