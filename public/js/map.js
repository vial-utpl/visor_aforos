// Mapa de estaciones (Leaflet): cada tramo A→B coloreado por vehículos motorizados por hora, como Telraam.
import { siteOverview, liveState, ago, fmt, esc } from './data.js'

// Escala de vehículos/hora (ambos sentidos) y sus colores
const SCALE = [
  [0, '#f9d849'],
  [100, '#f39c4a'],
  [200, '#e0597a'],
  [400, '#a43c9b'],
  [600, '#5b2a86'],
  [800, '#2b1055'],
  [1000, '#111111'],
]
const OFF = '#9aa0a6'
const REFRESH_MS = 60_000

let map, layer, timer, fitted = false

function colorFor(vph) {
  let c = SCALE[0][1]
  for (const [v, col] of SCALE) if (vph >= v) c = col
  return c
}

function legend() {
  const rows = SCALE.map(([v, c]) => `<div class="row"><span class="swatch" style="background:${c}"></span>${v}${v === 1000 ? '+' : ''} veh/h</div>`)
  rows.push(`<div class="row"><span class="swatch" style="background:${OFF}"></span>sin conexión</div>`)
  document.getElementById('map-legend').innerHTML = `<b>Última hora</b>${rows.join('')}`
}

const endIcon = (t) => L.divIcon({ className: 'end-label', html: t, iconSize: [22, 22] })

function stateText(s) {
  const st = liveState(s.live_status, s.live_updated_at)
  if (st === 'ok') return ['ok', `En vivo · ${s.live_fps?.toFixed(1) ?? '–'} fps`]
  if (st === 'warn') return ['warn', s.live_status === 'reconnecting' ? 'Reconectando la cámara' : 'Detenido']
  return ['off', `Sin conexión · ${ago(s.live_updated_at)}`]
}

async function refresh() {
  const sites = await siteOverview()
  layer.clearLayers()
  const bounds = []
  const list = document.getElementById('site-list')
  list.innerHTML = ''
  for (const s of sites) {
    const [dot, text] = stateText(s)
    const coords = (s.segment?.coordinates ?? []).map(([lon, lat]) => [lat, lon])
    if (coords.length >= 2) {
      const color = dot === 'off' ? OFF : colorFor(s.vehicles_last_hour)
      const line = L.polyline(coords, { color, weight: 8, opacity: 0.9, dashArray: dot === 'off' ? '6 8' : null }).addTo(layer)
      L.marker(coords[0], { icon: endIcon('A'), interactive: false }).addTo(layer)
      L.marker(coords[coords.length - 1], { icon: endIcon('B'), interactive: false }).addTo(layer)
      line.bindPopup(
        `<b>${esc(s.name)}</b><br>${fmt(s.vehicles_last_hour)} veh. en la última hora<br>` +
          `A → B: ${fmt(s.ab_last_hour)} · B → A: ${fmt(s.ba_last_hour)}<br>` +
          `<span class="dot ${dot}"></span> ${text}<br><a href="#/estacion/${s.id}">Ver estación →</a>`,
      )
      bounds.push(...coords)
    }
    const li = document.createElement('li')
    li.innerHTML = `<a href="#/estacion/${s.id}"><div class="name">${esc(s.name)}</div>
      <div class="meta"><span class="dot ${dot}"></span>${text}</div>
      <div class="meta">${fmt(s.vehicles_last_hour)} veh. última hora</div></a>`
    list.append(li)
  }
  if (!fitted && bounds.length) {
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 17 })
    fitted = true
  }
  if (!sites.length) list.innerHTML = '<li class="muted">Aún no hay estaciones.</li>'
  document.getElementById('map-updated').textContent = `Actualizado ${new Date().toLocaleTimeString('es-EC')}`
}

export async function showMap() {
  if (!map) {
    map = L.map('map', { zoomControl: true }).setView([-3.99, -79.2], 14)
    // Teselas estándar de OpenStreetMap (sin clave; uso moderado según su política de teselas).
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map)
    layer = L.layerGroup().addTo(map)
    legend()
  }
  setTimeout(() => map.invalidateSize(), 0)
  await refresh()
  clearInterval(timer)
  timer = setInterval(() => refresh().catch(() => {}), REFRESH_MS)
}

export function leaveMap() {
  clearInterval(timer)
}
