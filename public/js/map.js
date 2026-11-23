// Mapa de estaciones (Leaflet): cada tramo A→B coloreado por vehículos motorizados en la última hora.
// Al elegir un tramo: ventana con la última hora (por clase y V85) y panel lateral con los últimos 7 días.
import { CLASSES, siteOverview, lastHour, series, liveState, ago, fmt, esc, dateTime } from './data.js'
import { icon } from './icons.js'
import { stackedBars } from './charts.js'

// Escala de vehículos/hora (ambos sentidos)
const SCALE = [
  [0, '#f7d046'],
  [100, '#f29a3f'],
  [200, '#e0587a'],
  [400, '#a43c9b'],
  [600, '#5b2a86'],
  [800, '#2b1055'],
]
const OFF = '#9ca3af'
const REFRESH_MS = 60_000
const DAY = 86_400_000

let map, layer, timer
let fitted = false
let sites = []
let selected = null
const lines = new Map()

const $ = (id) => document.getElementById(id)

/** Márgenes para encuadrar: el panel de estaciones (izquierda o abajo) y el panel lateral (derecha). */
function pads(drawer) {
  const mobile = innerWidth < 700
  if (mobile) return { paddingTopLeft: [24, 90], paddingBottomRight: [24, Math.round(innerHeight * 0.4)] }
  return { paddingTopLeft: [340, 50], paddingBottomRight: [drawer ? 420 : 40, 50] }
}

function colorFor(vph) {
  let c = SCALE[0][1]
  for (const [v, col] of SCALE) if (vph >= v) c = col
  return c
}

function legend() {
  $('map-legend').innerHTML = `<b>Vehículos en la última hora</b>
    <div class="ramp">${SCALE.map(([, c]) => `<span style="background:${c}"></span>`).join('')}</div>
    <div class="ramp-labels">${SCALE.map(([v]) => `<span>${v}${v === 800 ? '+' : ''}</span>`).join('')}</div>
    <div class="legend-off"><i></i>sin conexión</div>`
}

const endIcon = (t) => L.divIcon({ className: 'end-label', html: t, iconSize: [22, 22] })

function stateOf(s) {
  const st = liveState(s.live_status, s.live_updated_at)
  if (st === 'ok') return { dot: 'ok', text: 'Contando ahora' }
  if (st === 'warn') return { dot: 'warn', text: s.live_status === 'reconnecting' ? 'Reconectando la cámara' : 'Conteo detenido' }
  return { dot: 'off', text: `Sin conexión · ${ago(s.live_updated_at)}` }
}

// ---------------------------------------------------------------------------------------------------------------
// Ventana "última hora"

function popupHtml(s, d) {
  const st = stateOf(s)
  const head = `<div class="pop"><h3>${esc(s.name)}</h3><p class="sub">Mediciones de la última hora · ambos sentidos</p>`
  if (!d) return `${head}<div class="pop-loading">Cargando…</div></div>`
  const c = Object.fromEntries(CLASSES.map((k) => [k.key, k]))
  const item = (ic, color, n, title, unit = '') =>
    `<div class="pop-item" title="${title}" style="color:${color}">${icon(ic, 30)}<span class="n" style="color:var(--text)">${n}${unit ? `<small>${unit}</small>` : ''}</span></div>`
  const grid = [
    item('person', c.person.color, fmt(d.sums.person), 'Peatones'),
    item('bicycle', c.bicycle.color, fmt(d.sums.bicycle), 'Bicicletas'),
    item('car', c.car.color, fmt(d.sums.car), 'Autos'),
    item('motorcycle', c.motorcycle.color, fmt(d.sums.motorcycle), 'Motos'),
    item('truck', c.truck.color, fmt(d.sums.truck + d.sums.bus), 'Vehículos pesados (camiones y buses)'),
    item('gauge', '#4b5563', d.v85 == null ? '–' : Math.round(d.v85), 'V85: velocidad bajo la que circula el 85 % de los vehículos', 'km/h'),
  ].join('')
  return `${head}<div class="pop-grid">${grid}</div>
    <div class="pop-foot"><span><span class="dot ${st.dot}"></span> ${d.last ? `Hasta ${dateTime(d.last)}` : 'Sin periodos en la última hora'}</span>
    <a href="#/estacion/${s.id}">Ver datos →</a></div></div>`
}

// ---------------------------------------------------------------------------------------------------------------
// Panel lateral

async function openDrawer(s) {
  const st = stateOf(s)
  $('drawer').hidden = false
  $('drawer-body').innerHTML = `<h2>${esc(s.name)}</h2>
    <p class="kicker">${esc(s.label_a)} ⇄ ${esc(s.label_b)}${s.speed_limit_kmh ? ` · ${s.speed_limit_kmh} km/h` : ''}</p>
    <div class="state"><span class="dot ${st.dot}"></span>${st.text}</div>
    <div class="mini-kpis">
      <div><b>${fmt(s.vehicles_last_hour)}</b><span>veh. última hora</span></div>
      <div><b>${fmt(s.ab_last_hour)}</b><span>${esc(s.label_a)} → ${esc(s.label_b)}</span></div>
      <div><b>${fmt(s.ba_last_hour)}</b><span>${esc(s.label_b)} → ${esc(s.label_a)}</span></div>
    </div>
    <h3>Últimos 7 días</h3>
    <div class="legend-row small">${CLASSES.map((c) => `<span><i class="sw" style="background:${c.color}"></i>${c.label}</span>`).join('')}</div>
    <div id="drawer-chart" class="svgwrap"></div>
    <a class="btn-more" href="#/estacion/${s.id}">${icon('chart', 18)}Más datos</a>`
  const to = new Date(new Date().setHours(0, 0, 0, 0) + DAY)
  const from = new Date(to.getTime() - 7 * DAY)
  const rows = await series(s.id, from, to, 1440)
  if (selected !== s.id) return
  const days = Array.from({ length: 7 }, (_, i) => new Date(from.getTime() + i * DAY))
  const byDay = new Map()
  for (const r of rows) {
    const k = new Date(r.bucket_start).toDateString()
    const e = byDay.get(k) ?? {}
    for (const c of CLASSES) e[c.key] = (e[c.key] ?? 0) + Number(r[c.key])
    byDay.set(k, e)
  }
  stackedBars($('drawer-chart'), {
    height: 300,
    labels: days.map((d) => d.toLocaleDateString('es-EC', { weekday: 'short', day: 'numeric' })),
    stacks: CLASSES.map((c) => ({ label: c.label, color: c.color, values: days.map((d) => byDay.get(d.toDateString())?.[c.key] ?? 0) })),
  })
}

function closeDrawer() {
  $('drawer').hidden = true
  selected = null
  map?.closePopup()
  highlight()
}

function highlight() {
  for (const [id, l] of lines) l.line.setStyle({ weight: id === selected ? 10 : 7 })
  document.querySelectorAll('.site-list a').forEach((a) => a.classList.toggle('sel', a.dataset.id === selected))
}

async function select(id, latlng) {
  const s = sites.find((x) => x.id === id)
  const l = lines.get(id)
  if (!s) return
  selected = id
  highlight()
  if (l) {
    const at = latlng ?? l.line.getCenter()
    const pop = L.popup({ offset: [0, -6], ...(innerWidth < 700 ? { autoPanPadding: [12, 70] } : { autoPanPaddingTopLeft: [340, 20], autoPanPaddingBottomRight: [420, 20] }) })
      .setLatLng(at).setContent(popupHtml(s, null)).openOn(map)
    lastHour(id).then((d) => selected === id && pop.isOpen() && pop.setContent(popupHtml(s, d))).catch(() => {})
  }
  openDrawer(s).catch(() => {})
}

// ---------------------------------------------------------------------------------------------------------------

async function refresh() {
  sites = await siteOverview()
  layer.clearLayers()
  lines.clear()
  const bounds = []
  let live = 0
  const list = $('site-list')
  list.innerHTML = ''
  for (const s of sites) {
    const st = stateOf(s)
    if (st.dot === 'ok') live++
    const off = st.dot === 'off'
    const color = off ? OFF : colorFor(s.vehicles_last_hour)
    const coords = (s.segment?.coordinates ?? []).map(([lon, lat]) => [lat, lon])
    if (coords.length >= 2) {
      const casing = L.polyline(coords, { color: '#fff', weight: 13, opacity: 0.95, lineCap: 'round', interactive: false }).addTo(layer)
      const line = L.polyline(coords, {
        color, weight: s.id === selected ? 10 : 7, opacity: 1, lineCap: 'round', dashArray: off ? '2 10' : null,
        bubblingMouseEvents: false,
      }).addTo(layer)
      line.on('click', (e) => select(s.id, e.latlng))
      line.on('mouseover', () => line.setStyle({ weight: 10 }))
      line.on('mouseout', () => s.id !== selected && line.setStyle({ weight: 7 }))
      line.bindTooltip(`${esc(s.name)} · ${fmt(s.vehicles_last_hour)} veh/h`, { sticky: true, direction: 'top', offset: [0, -8] })
      L.marker(coords[0], { icon: endIcon('A'), interactive: false }).addTo(layer)
      L.marker(coords[coords.length - 1], { icon: endIcon('B'), interactive: false }).addTo(layer)
      lines.set(s.id, { line, casing })
      bounds.push(...coords)
    }
    const li = document.createElement('li')
    li.innerHTML = `<a href="#/" data-id="${s.id}"><span class="bar" style="background:${color}"></span>
      <span class="name">${esc(s.name)}</span>
      <span class="vph">${fmt(s.vehicles_last_hour)}<small>veh/h</small></span>
      <span class="meta"><span class="dot ${st.dot}"></span>${st.text}</span></a>`
    li.firstElementChild.addEventListener('click', (e) => {
      e.preventDefault()
      const l = lines.get(s.id)
      if (l) map.flyToBounds(l.line.getBounds(), { ...pads(true), maxZoom: 17, duration: 0.6 })
      setTimeout(() => select(s.id), 650)
    })
    list.append(li)
  }
  if (!fitted && bounds.length) {
    map.fitBounds(bounds, { ...pads(false), maxZoom: 17 })
    fitted = true
  }
  if (!sites.length) list.innerHTML = '<li class="muted small" style="padding:.8rem">Aún no hay estaciones.</li>'
  $('map-updated').textContent = `act. ${new Date().toLocaleTimeString('es-EC', { hour: '2-digit', minute: '2-digit' })}`
  $('map-counter').innerHTML = `<span class="n${live ? '' : ' none'}">${live}</span><span class="k">de ${sites.length} equipos<br>contando ahora</span>`
  highlight()
}

export async function showMap() {
  if (!map) {
    map = L.map('map', { zoomControl: true }).setView([-3.99, -79.2], 14)
    // Teselas estándar de OpenStreetMap en gris (sin clave; uso moderado según su política de teselas).
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      className: 'tiles-gray',
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map)
    layer = L.layerGroup().addTo(map)
    legend()
    $('drawer-close').innerHTML = icon('close', 22)
    $('drawer-close').addEventListener('click', closeDrawer)
    map.on('click', closeDrawer)
  }
  setTimeout(() => map.invalidateSize(), 0)
  await refresh()
  clearInterval(timer)
  timer = setInterval(() => refresh().catch(() => {}), REFRESH_MS)
}

export function leaveMap() {
  clearInterval(timer)
}
