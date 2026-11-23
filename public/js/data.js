// Acceso a Supabase: sesión, estaciones, series y estado en vivo.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.119.2/+esm'
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, OFFLINE_AFTER_MS } from './config.js'

export const db = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY)

export const CLASSES = [
  { key: 'car', label: 'Autos', color: '#3d9ac0', motor: true },
  { key: 'motorcycle', label: 'Motos', color: '#1e8a5a', motor: true },
  { key: 'truck', label: 'Camiones', color: '#0b4f8a', motor: true },
  { key: 'bus', label: 'Buses', color: '#7b3fa0', motor: true },
  { key: 'bicycle', label: 'Bicicletas', color: '#6cc08b', motor: false },
  { key: 'person', label: 'Peatones', color: '#f08a5d', motor: false },
]

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

export async function speeds(siteId, from, to) {
  const { data, error } = await db.rpc('get_site_speeds', { p_site: siteId, p_from: from.toISOString(), p_to: to.toISOString() })
  if (error) throw error
  return data
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

/** Texto seguro para insertar en HTML. */
export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
