// Mapa de estaciones (Leaflet): cada tramo A→B coloreado por vehículos motorizados en la última hora. Con el mapa
// alejado, cada estación es un punto. Al elegir una: ventana con la última hora (por clase y V85) y panel a la derecha
// con los últimos 7 días; al elegir otra, la anterior queda como pestaña vertical a la izquierda del panel.
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
// Por debajo de este zoom las estaciones se dibujan como puntos (a zoom 15 un tramo de 150 m mide ~30 px y las
// marcas A y B lo tapan).
const POINT_ZOOM = 16
const MAX_STACK = 5 // paneles abiertos a la vez (el más antiguo se cierra)
const WEEK_CACHE_MS = 5 * 60_000

let map, segLayer, pointLayer, timer
let fitted = false
let sites = []
const shapes = new Map() // id → { line, point, center }
const stack = [] // ids de los paneles abiertos, del más antiguo al más nuevo
let active = null // id del panel abierto al frente
const weeks = new Map() // id → { at, rows }: últimos 7 días, para no volver a pedirlos al cambiar de pestaña
const hours = new Map() // id → { at, d }: última hora, para la burbuja al pasar el cursor
const HOUR_CACHE_MS = 60_000
let pop = null // la burbuja abierta (de la estación bajo el cursor o de la elegida)
let pinned = null // { id, latlng }: estación elegida con clic, su burbuja queda abierta
let hideTimer

const $ = (id) => document.getElementById(id)
const siteById = (id) => sites.find((x) => x.id === id)

/** Márgenes para encuadrar: el panel de estaciones (izquierda o abajo) y los paneles de la derecha. */
function pads(drawer) {
  const mobile = innerWidth < 700
  if (mobile) return { paddingTopLeft: [24, 90], paddingBottomRight: [24, Math.round(innerHeight * 0.4)] }
  const right = drawer ? Math.max(420, ($('drawer').hidden ? 0 : $('drawer').offsetWidth) + 20) : 40
  return { paddingTopLeft: [340, 50], paddingBottomRight: [right, 50] }
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

/** Punto a mitad del recorrido del tramo (no el centro de su recuadro, que en una curva cae fuera de la vía). */
function midpoint(coords) {
  const k = Math.cos((coords[0][0] * Math.PI) / 180)
  const len = []
  let total = 0
  for (let i = 1; i < coords.length; i++) {
    const d = Math.hypot(coords[i][0] - coords[i - 1][0], (coords[i][1] - coords[i - 1][1]) * k)
    len.push(d)
    total += d
  }
  let half = total / 2
  for (let i = 1; i < coords.length; i++) {
    if (half <= len[i - 1] || i === coords.length - 1) {
      const f = len[i - 1] ? Math.min(1, half / len[i - 1]) : 0
      return [coords[i - 1][0] + (coords[i][0] - coords[i - 1][0]) * f, coords[i - 1][1] + (coords[i][1] - coords[i - 1][1]) * f]
    }
    half -= len[i - 1]
  }
  return coords[0]
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

function hourOf(id) {
  const c = hours.get(id)
  if (c && Date.now() - c.at < HOUR_CACHE_MS) return Promise.resolve(c.d)
  return lastHour(id).then((d) => (hours.set(id, { at: Date.now(), d }), d))
}

/** Abre la burbuja "última hora" de una estación. Al pasar el cursor no mueve el mapa; al hacer clic sí, si no cabe. */
function showPopup(id, latlng, pan) {
  const s = siteById(id)
  if (!s) return
  clearTimeout(hideTimer)
  const panOpts = !pan
    ? { autoPan: false }
    : innerWidth < 700
      ? { autoPanPadding: [12, 70] }
      : { autoPanPaddingTopLeft: [340, 20], autoPanPaddingBottomRight: [($('drawer').offsetWidth || 400) + 20, 20] }
  const p = L.popup({ offset: [0, -6], ...panOpts }).setLatLng(latlng).setContent(popupHtml(s, hours.get(id)?.d ?? null)).openOn(map)
  p.siteId = id
  pop = p
  const el = p.getElement()
  el.addEventListener('mouseenter', () => clearTimeout(hideTimer))
  el.addEventListener('mouseleave', scheduleHide)
  el.querySelector('.leaflet-popup-close-button')?.addEventListener('click', () => {
    if (pinned?.id === id) pinned = null
  })
  hourOf(id).then((d) => pop === p && p.isOpen() && p.setContent(popupHtml(s, d))).catch(() => {})
}

/** Cursor sobre un tramo o punto: su burbuja (si no es la que ya está abierta). */
function hover(id) {
  clearTimeout(hideTimer)
  if (pop?.isOpen() && pop.siteId === id) return
  const sh = shapes.get(id)
  if (sh) showPopup(id, sh.center, false)
}

/** Al salir el cursor, la burbuja se cierra en un momento (o vuelve la de la estación elegida). */
function scheduleHide() {
  clearTimeout(hideTimer)
  hideTimer = setTimeout(() => {
    if (pinned && siteById(pinned.id)) {
      if (!(pop?.isOpen() && pop.siteId === pinned.id)) showPopup(pinned.id, pinned.latlng, false)
    } else {
      map.closePopup()
    }
  }, 300)
}

// ---------------------------------------------------------------------------------------------------------------
// Paneles de la derecha: el activo completo y los demás como pestañas verticales

function renderDrawer() {
  const open = stack.filter((id) => id !== active && siteById(id))
  $('drawer-tabs').innerHTML = open
    .map((id) => {
      const name = esc(siteById(id).name)
      return `<div class="dtab">
        <button class="icon-btn dtab-x" data-close="${id}" aria-label="Cerrar ${name}" title="Cerrar">${icon('close', 16)}</button>
        <button class="dtab-name" data-open="${id}" title="${name}"><span>${name}</span></button></div>`
    })
    .join('')
  const s = siteById(active)
  $('drawer').hidden = !s
  if (s) fillPanel(s).catch(() => {})
}

async function fillPanel(s) {
  const st = stateOf(s)
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
  let week = weeks.get(s.id)
  if (!week || Date.now() - week.at > WEEK_CACHE_MS) {
    week = { at: Date.now(), rows: await series(s.id, from, to, 1440) }
    weeks.set(s.id, week)
  }
  if (active !== s.id) return
  const days = Array.from({ length: 7 }, (_, i) => new Date(from.getTime() + i * DAY))
  const byDay = new Map()
  for (const r of week.rows) {
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

/** Cierra un panel; si era el del frente, pasa al frente el último abierto. */
function closeSite(id) {
  const i = stack.indexOf(id)
  if (i >= 0) stack.splice(i, 1)
  if (active === id) {
    active = stack.at(-1) ?? null
    pinned = null
    map?.closePopup()
  }
  highlight()
  renderDrawer()
}

function highlight() {
  const open = new Set(stack)
  for (const [id, sh] of shapes) {
    sh.line.setStyle({ weight: id === active ? 10 : open.has(id) ? 9 : 7 })
    sh.point.setStyle({ radius: id === active ? 11 : open.has(id) ? 9 : 7, weight: id === active ? 3 : 2 })
  }
  document.querySelectorAll('.site-list a').forEach((a) => a.classList.toggle('sel', a.dataset.id === active))
}

function select(id, latlng) {
  const s = siteById(id)
  if (!s) return
  if (!stack.includes(id)) {
    stack.push(id)
    if (stack.length > MAX_STACK) stack.shift()
  }
  active = id
  highlight()
  renderDrawer()
  const sh = shapes.get(id)
  if (sh) {
    pinned = { id, latlng: latlng ?? sh.center }
    showPopup(id, pinned.latlng, true)
  }
}

/** Tramos con el mapa cerca; puntos con el mapa lejos. */
function applyZoom() {
  if (map.getZoom() < POINT_ZOOM) {
    map.removeLayer(segLayer)
    pointLayer.addTo(map)
  } else {
    map.removeLayer(pointLayer)
    segLayer.addTo(map)
  }
}

// ---------------------------------------------------------------------------------------------------------------

async function refresh() {
  sites = await siteOverview()
  segLayer.clearLayers()
  pointLayer.clearLayers()
  shapes.clear()
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
      L.polyline(coords, { color: '#fff', weight: 13, opacity: 0.95, lineCap: 'round', interactive: false }).addTo(segLayer)
      const line = L.polyline(coords, {
        color, weight: 7, opacity: 1, lineCap: 'round', dashArray: off ? '2 10' : null, bubblingMouseEvents: false,
      }).addTo(segLayer)
      line.on('click', (e) => select(s.id, e.latlng))
      line.on('mouseover', () => (line.setStyle({ weight: 10 }), hover(s.id)))
      line.on('mouseout', () => (highlight(), scheduleHide()))
      L.marker(coords[0], { icon: endIcon('A'), interactive: false }).addTo(segLayer)
      L.marker(coords[coords.length - 1], { icon: endIcon('B'), interactive: false }).addTo(segLayer)

      const center = midpoint(coords)
      const point = L.circleMarker(center, {
        radius: 7, color: '#fff', weight: 2, fillColor: color, fillOpacity: 1, bubblingMouseEvents: false,
      }).addTo(pointLayer)
      point.on('click', () => select(s.id))
      point.on('mouseover', () => (point.setStyle({ radius: 11 }), hover(s.id)))
      point.on('mouseout', () => (highlight(), scheduleHide()))
      shapes.set(s.id, { line, point, center })
      bounds.push(...coords)
    }
    const li = document.createElement('li')
    li.innerHTML = `<a href="#/mapa" data-id="${s.id}"><span class="bar" style="background:${color}"></span>
      <span class="name">${esc(s.name)}</span>
      <span class="vph">${fmt(s.vehicles_last_hour)}<small>veh/h</small></span>
      <span class="meta"><span class="dot ${st.dot}"></span>${st.text}</span></a>`
    li.firstElementChild.addEventListener('click', (e) => {
      e.preventDefault()
      const sh = shapes.get(s.id)
      if (!sh) return select(s.id)
      map.flyToBounds(sh.line.getBounds(), { ...pads(true), maxZoom: 17, duration: 0.6 })
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
  // una estación borrada deja de estar en los paneles
  for (const id of [...stack]) if (!siteById(id)) closeSite(id)
  highlight()
  applyZoom()
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
    segLayer = L.layerGroup()
    pointLayer = L.layerGroup()
    legend()
    $('drawer-close').innerHTML = icon('close', 22)
    $('drawer-close').addEventListener('click', () => active && closeSite(active))
    $('drawer-tabs').addEventListener('click', (e) => {
      const x = e.target.closest('[data-close]')
      if (x) return closeSite(x.dataset.close)
      const o = e.target.closest('[data-open]')
      if (o) select(o.dataset.open)
    })
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !active || $('view-map').hidden || e.target.closest?.('input, textarea')) return
      closeSite(active)
    })
    map.on('click', () => {
      pinned = null
      map.closePopup()
    })
    map.on('zoomend', applyZoom)
  }
  setTimeout(() => map.invalidateSize(), 0)
  await refresh()
  clearInterval(timer)
  timer = setInterval(() => refresh().catch(() => {}), REFRESH_MS)
}

export function leaveMap() {
  clearInterval(timer)
}
