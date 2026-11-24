// Página de una estación: cabecera, minimapa, estado en vivo, totales, resumen diario, serie temporal (Dygraphs,
// áreas apiladas), perfil horario, sentidos, velocidades (histograma y V85 por hora) y reparto modal.
import {
  CLASSES, DISPLAY, MOTOR, motorOf, site as loadSite, series, speeds, speedsByHour, v85, liveRow, onLive, liveState, ago, fmt, pct, esc,
} from './data.js'
import { icon } from './icons.js'
import { stackedBars, bars, donut } from './charts.js'

const $ = (id) => document.getElementById(id)
const DAY = 86_400_000
const BIN_LABELS = Array.from({ length: 12 }, (_, i) => (i === 11 ? '110+' : `${i * 10}–${i * 10 + 10}`))

const st = {
  id: null,
  site: null,
  from: null,
  to: null,
  dir: 'both',
  bucket: 60,
  daytype: 'wd',
  visible: CLASSES.map(() => true),
  rows: [], // serie con el intervalo elegido
  hourly: [], // filas de 1 hora (perfil y sentidos)
  daily: [], // filas de 1 día
  live: null,
  unsubscribe: null,
  ticker: null,
  graphs: {},
  minimap: null,
  loading: 0,
}

// ---------------------------------------------------------------------------------------------------------------
// Fechas

const midnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate())
const isoDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const parseDate = (s) => {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}

function setRange(days) {
  st.to = new Date(midnight(new Date()).getTime() + DAY)
  st.from = new Date(st.to.getTime() - days * DAY)
  $('from').value = isoDate(st.from)
  $('to').value = isoDate(new Date(st.to.getTime() - DAY))
}

const dirs = () => (st.dir === 'both' ? ['ab', 'ba'] : [st.dir])
const keep = (r) => st.dir === 'both' || r.direction === st.dir

// ---------------------------------------------------------------------------------------------------------------
// Cabecera, minimapa y estado en vivo

function renderHead() {
  const s = st.site
  $('site-name').textContent = s.name
  $('site-desc').textContent = [s.description, `${s.label_a} ⇄ ${s.label_b}`].filter(Boolean).join(' · ')
  const chips = [`${icon('arrows', 16)} A = ${esc(s.label_a)} · B = ${esc(s.label_b)}`]
  if (s.speed_limit_kmh) chips.push(`${icon('gauge', 16)} Límite ${s.speed_limit_kmh} km/h`)
  chips.push(`${icon('clock', 16)} Hora local (${esc(s.timezone)})`)
  $('site-chips').innerHTML = chips.map((c) => `<span class="chip">${c}</span>`).join('')
  $('dir-ab').textContent = `${s.label_a} → ${s.label_b}`
  $('dir-ba').textContent = `${s.label_b} → ${s.label_a}`
}

function renderMinimap() {
  const coords = (st.site.segment?.coordinates ?? []).map(([lon, lat]) => [lat, lon])
  if (!st.minimap) {
    st.minimap = L.map('minimap', { zoomControl: true, scrollWheelZoom: false, attributionControl: true })
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      className: 'tiles-gray',
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(st.minimap)
    st.minimapLayer = L.layerGroup().addTo(st.minimap)
  }
  st.minimapLayer.clearLayers()
  if (coords.length < 2) return st.minimap.setView([-3.99, -79.2], 14)
  L.polyline(coords, { color: '#fff', weight: 13, lineCap: 'round' }).addTo(st.minimapLayer)
  L.polyline(coords, { color: '#16a37f', weight: 7, lineCap: 'round' }).addTo(st.minimapLayer)
  const end = (t) => L.divIcon({ className: 'end-label', html: t, iconSize: [22, 22] })
  L.marker(coords[0], { icon: end('A'), interactive: false }).addTo(st.minimapLayer)
  L.marker(coords[coords.length - 1], { icon: end('B'), interactive: false }).addTo(st.minimapLayer)
  setTimeout(() => {
    st.minimap.invalidateSize()
    st.minimap.fitBounds(coords, { padding: [40, 40], maxZoom: 17 })
  }, 0)
}

function renderLive() {
  const l = st.live
  const s = liveState(l?.status, l?.updated_at)
  const text = {
    ok: 'Contando en vivo',
    warn: l?.status === 'reconnecting' ? 'Reconectando la cámara' : l?.status === 'error' ? 'Error en el equipo' : 'Conteo detenido',
    off: 'Sin conexión',
  }[s]
  let html = `<div class="status"><span class="dot ${s}"></span>${text}</div>
    <div class="muted small">Último dato ${ago(l?.updated_at)}${s === 'ok' && l?.fps ? ` · ${l.fps.toFixed(1)} fps` : ''}${
      l?.pending ? ` · ${fmt(l.pending)} periodos por subir` : ''}</div>`
  if (l?.period_start && s !== 'off') {
    const p0 = new Date(l.period_start)
    const p1 = new Date(p0.getTime() + 15 * 60_000)
    const hm = (d) => d.toLocaleTimeString('es-EC', { hour: '2-digit', minute: '2-digit' })
    const c = l.counts ?? {}
    const a = esc(st.site.label_a), b = esc(st.site.label_b)
    html += `<table><tr><th></th><th>${a} → ${b}</th><th>${b} → ${a}</th></tr>`
    for (const k of DISPLAY)
      html += `<tr><td style="color:${k.color}">${icon(k.icon, 18)}<span style="color:var(--text)">${k.label}</span></td>
        <td>${fmt(c.ab?.[k.key])}</td><td>${fmt(c.ba?.[k.key])}</td></tr>`
    html += `</table><div class="period">Periodo en curso ${hm(p0)}–${hm(p1)} · ${fmt(l.minutes_measured)} de 15 min medidos</div>`
  } else {
    html += `<p class="muted small" style="margin-top:.8rem">Cuando el equipo esté contando, aquí se ven los conteos del periodo de 15 minutos en curso.</p>`
  }
  $('live-box').innerHTML = html
}

// ---------------------------------------------------------------------------------------------------------------
// Totales y resumen diario

function totals() {
  const sums = Object.fromEntries(CLASSES.map((c) => [c.key, 0]))
  for (const r of st.daily) if (keep(r)) for (const c of CLASSES) sums[c.key] += Number(r[c.key])
  return sums
}

function renderKpis(sums) {
  const all = CLASSES.reduce((s, c) => s + sums[c.key], 0)
  const motor = MOTOR.reduce((s, k) => s + sums[k], 0)
  const cards = [`<div class="kpi total"><div class="head">${icon('layers', 20)}Motorizados</div>
    <div class="n">${fmt(motor)}</div><div class="p">${pct(motor, all)}</div></div>`]
  for (const c of DISPLAY) {
    cards.push(`<div class="kpi" style="--c:${c.color}"><div class="head">${icon(c.icon, 22)}${c.label}</div>
      <div class="n">${fmt(sums[c.key])}</div><div class="p">${pct(sums[c.key], all)}</div></div>`)
  }
  $('totals').innerHTML = cards.join('')
}

function renderDaily() {
  const days = []
  for (let t = st.from.getTime(); t < st.to.getTime(); t += DAY) days.push(new Date(t))
  const byDay = new Map()
  for (const r of st.daily) {
    if (!keep(r)) continue
    const k = new Date(r.bucket_start).toDateString()
    const e = byDay.get(k) ?? {}
    for (const c of CLASSES) e[c.key] = (e[c.key] ?? 0) + Number(r[c.key])
    byDay.set(k, e)
  }
  const long = days.length > 16
  $('daily-legend').innerHTML = CLASSES.map((c) => `<span><i class="sw" style="background:${c.color}"></i>${c.label}</span>`).join('')
  stackedBars($('chart-daily'), {
    height: 280,
    labels: days.map((d) => d.toLocaleDateString('es-EC', long ? { day: 'numeric', month: 'short' } : { weekday: 'short', day: 'numeric', month: 'short' })),
    stacks: CLASSES.map((c) => ({ label: c.label, color: c.color, values: days.map((d) => byDay.get(d.toDateString())?.[c.key] ?? 0) })),
  })
}

// ---------------------------------------------------------------------------------------------------------------
// Serie temporal (Dygraphs)

/** Una entrada por intervalo del rango (también los vacíos, para que se vean los huecos). */
function buildBuckets() {
  const ms = st.bucket * 60_000
  const byStart = new Map()
  for (const r of st.rows) {
    const t = Date.parse(r.bucket_start)
    if (!byStart.has(t)) byStart.set(t, { ab: null, ba: null })
    byStart.get(t)[r.direction] = r
  }
  const out = []
  // alinea el primer intervalo con el inicio local del rango (las filas vienen alineadas a la hora local)
  for (let t = st.from.getTime(); t < st.to.getTime() && t <= Date.now(); t += ms) {
    const e = byStart.get(t) ?? { ab: null, ba: null }
    const values = {}
    let any = false
    for (const c of CLASSES) {
      let v = 0
      for (const d of dirs()) if (e[d]) ((v += Number(e[d][c.key])), (any = true))
      values[c.key] = v
    }
    const minutes = Math.max(...dirs().map((d) => Number(e[d]?.minutes_measured ?? 0)))
    out.push({ t, values: any ? values : null, coverage: Math.min(1, minutes / st.bucket) })
  }
  return out
}

function seriesToggles() {
  $('series-toggles').innerHTML = CLASSES.map(
    (c, i) => `<label style="color:${c.color}"><input type="checkbox" data-i="${i}" ${st.visible[i] ? 'checked' : ''}>
      ${icon(c.icon, 18)}<span style="color:var(--text)">${c.label}</span></label>`,
  ).join('')
  $('series-toggles').onchange = (e) => {
    const i = Number(e.target.dataset.i)
    st.visible[i] = e.target.checked
    st.graphs.series?.setVisibility(i, e.target.checked)
  }
}

const COLOR_OF = Object.fromEntries(CLASSES.map((c) => [c.label, c.color]))

/**
 * Barras apiladas para Dygraphs. Dygraphs apila las series (stackedGraph) y calcula la escala del eje Y según el
 * tramo visible; aquí solo se dibuja cada intervalo como una barra que ocupa su duración, en vez de áreas.
 * En una gráfica apilada de Dygraphs la última serie visible queda abajo: la base de la serie j es la cima de la j+1.
 */
function stackedBarPlotter(e) {
  if (e.seriesIndex !== 0) return // se dibujan todas las series de una vez
  const g = e.dygraph
  const ctx = e.drawingContext
  const sets = e.allSeriesPoints
  const ms = st.bucket * 60_000
  const y0 = g.toDomYCoord(0)
  const tops = sets.map((pts) => new Map(pts.map((p) => [p.xval, p.canvasy])))
  const [xMin, xMax] = g.xAxisRange()
  for (let j = 0; j < sets.length; j++) {
    for (const p of sets[j]) {
      ctx.fillStyle = COLOR_OF[p.name] ?? '#999'
      if (p.xval + ms < xMin || p.xval > xMax || !Number.isFinite(p.canvasy)) continue
      const below = j + 1 < sets.length ? tops[j + 1].get(p.xval) : y0
      const base = Number.isFinite(below) ? below : y0
      const x1 = g.toDomXCoord(p.xval)
      const w = g.toDomXCoord(p.xval + ms) - x1
      const gap = w > 4 ? Math.min(3, w * 0.18) : 0
      const h = base - p.canvasy
      if (h > 0) ctx.fillRect(x1 + gap / 2, p.canvasy, Math.max(1, w - gap), h)
    }
  }
}

/**
 * Columna resaltada bajo el cursor (en vez de círculos en cada serie). Dygraphs llama a esta función una vez por
 * serie con la misma x: se dibuja solo la primera vez de cada selección.
 */
function highlightColumn(g, seriesName, ctx, cx) {
  if (ctx.__columnDrawn) return
  ctx.__columnDrawn = true
  queueMicrotask(() => (ctx.__columnDrawn = false))
  const t = g.toDataXCoord(cx)
  const w = g.toDomXCoord(t + st.bucket * 60_000) - cx
  const area = g.getArea()
  ctx.save()
  // Dygraphs solo borra una franja estrecha alrededor de la selección anterior: se limpia toda la capa
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height)
  ctx.restore()
  ctx.save()
  ctx.fillStyle = 'rgba(17, 24, 39, 0.16)'
  ctx.fillRect(cx, area.y, Math.max(2, w), area.h)
  ctx.restore()
}

/** Título de un intervalo: «lun 24 nov, 06:00–07:00» (o solo el día). */
function bucketTitle(t) {
  const d = new Date(t)
  const day = d.toLocaleDateString('es-EC', { weekday: 'short', day: 'numeric', month: 'short' })
  if (st.bucket === 1440) return day
  const hm = (x) => x.toLocaleTimeString('es-EC', { hour: '2-digit', minute: '2-digit', hour12: false })
  return `${day}, ${hm(d)}–${hm(new Date(t + st.bucket * 60_000))}`
}

/**
 * Detalle del intervalo bajo el cursor, con el mismo aspecto que el de «Resumen diario»: título y total, y cada clase
 * visible de arriba abajo como en la barra. Solo cambia el contenido al cambiar de barra; la posición sigue al cursor.
 */
function showSeriesTip(g, points, row) {
  const tip = $('series-tip')
  const b = st.buckets?.[row]
  if (!g || !b) return void (tip.hidden = true)
  const roll = g.rollPeriod()
  const num = (v) => Number(v).toLocaleString('es-EC', { maximumFractionDigits: roll > 1 ? 1 : 0 })
  const vals = points.filter((p) => Number.isFinite(p.yval))
  const total = vals.reduce((s, p) => s + p.yval, 0)
  if (!b.values || !vals.length) {
    tip.innerHTML = `<b>${esc(bucketTitle(b.t))}</b><br>Sin datos`
  } else {
    const rows = vals.map((p) => `<span class="sw" style="background:${COLOR_OF[p.name] ?? '#999'}"></span>${esc(p.name)} <b>${num(p.yval)}</b>`)
    if (b.coverage < 0.999) {
      const done = st.bucket === 1440
        ? `${(b.coverage * 24).toLocaleString('es-EC', { maximumFractionDigits: 1 })} de 24 h`
        : `${Math.round(b.coverage * st.bucket)} de ${st.bucket} min`
      rows.push(`<span class="tnote">Medido ${done}</span>`)
    }
    if (roll > 1) rows.push(`<span class="tnote">Media de ${roll} intervalos</span>`)
    tip.innerHTML = `<b>${esc(bucketTitle(b.t))}</b> · ${num(total)}<br>${rows.join('<br>')}`
  }
  tip.hidden = false
}

/** Coloca el detalle junto al cursor (como el tooltip de las gráficas SVG). */
function moveSeriesTip(e) {
  const tip = $('series-tip')
  if (tip.hidden) return
  const r = tip.getBoundingClientRect()
  let x = e.clientX + 14
  if (x + r.width > innerWidth - 8) x = e.clientX - r.width - 14
  tip.style.left = `${x}px`
  tip.style.top = `${Math.max(8, e.clientY - r.height - 10)}px`
}

/** Ventana inicial: con muchos intervalos, la gráfica abre en el tramo final y el selector de abajo recorre el resto. */
function initialWindow(buckets) {
  if (!buckets.length) return null
  const ms = st.bucket * 60_000
  const end = buckets[buckets.length - 1].t + ms
  const span = { 15: 2 * DAY, 60: 7 * DAY }[st.bucket]
  const start = buckets[0].t
  return span && end - start > span ? [end - span, end] : [start, end]
}

function renderSeries({ keepWindow = false } = {}) {
  const buckets = buildBuckets()
  st.buckets = buckets
  $('series-tip').hidden = true
  const data = buckets.map((b) => [new Date(b.t), ...CLASSES.map((c) => (b.values ? b.values[c.key] : null))])
  const ms = st.bucket * 60_000
  // fila vacía al final: la última barra (que ocupa [t, t + intervalo]) entra completa al restablecer el zoom
  data.push([new Date((buckets.at(-1)?.t ?? st.from.getTime()) + ms), ...CLASSES.map(() => null)])
  // franjas grises: intervalos sin medir completos (en días, solo si falta más del 5 %)
  const gaps = buckets.filter((b) => b.coverage < (st.bucket === 1440 ? 0.95 : 0.999))
  const unit = st.bucket === 1440 ? 'día' : st.bucket === 60 ? 'hora' : '15 min'
  const prev = keepWindow ? st.graphs.series?.xAxisRange() : null
  // el extremo derecho incluye el último intervalo completo (las barras ocupan [t, t + intervalo])
  const win = prev ?? initialWindow(buckets)
  const opts = {
    labels: ['Fecha', ...CLASSES.map((c) => c.label)],
    colors: CLASSES.map((c) => c.color),
    visibility: st.visible,
    stackedGraph: true,
    stackedGraphNaNFill: 'none',
    plotter: stackedBarPlotter,
    drawHighlightPointCallback: highlightColumn,
    includeZero: true,
    dateWindow: win,
    connectSeparatedPoints: false,
    showRangeSelector: true,
    rangeSelectorHeight: 56,
    rangeSelectorPlotFillColor: '#a3adbd',
    rangeSelectorPlotFillGradientColor: '#e5e8ed',
    rangeSelectorPlotStrokeColor: '#6b7280',
    rangeSelectorBackgroundStrokeColor: '#d1d5db',
    rangeSelectorForegroundStrokeColor: '#6b7280',
    showRoller: true,
    rollPeriod: 1,
    legend: 'never',
    highlightCallback: (e, x, points, row) => {
      showSeriesTip(st.graphs.series, points, row)
      moveSeriesTip(e)
    },
    unhighlightCallback: () => ($('series-tip').hidden = true),
    ylabel: `Usuarios / ${unit}`,
    axisLineColor: '#cbd2d9',
    gridLineColor: '#eef0f3',
    highlightCircleSize: 4,
    highlightSeriesOpts: null,
    xRangePad: 0,
    axes: {
      x: {
        axisLabelFontSize: 12,
        drawGrid: true,
        valueFormatter: (t) => bucketTitle(t),
      },
      y: { axisLabelFontSize: 12, axisLabelWidth: 46 },
    },
    underlayCallback: (ctx, area, g) => {
      ctx.fillStyle = 'rgba(148, 155, 168, 0.18)'
      for (const b of gaps) {
        const x1 = g.toDomXCoord(b.t)
        const x2 = g.toDomXCoord(b.t + ms)
        ctx.fillRect(x1, area.y, Math.max(1, x2 - x1), area.h)
      }
    },
  }
  if (st.graphs.series) st.graphs.series.updateOptions({ file: data, ...opts })
  else st.graphs.series = new Dygraph($('chart-series'), data, opts)
}

// ---------------------------------------------------------------------------------------------------------------
// Perfil horario y sentidos (horas completas)

/** Horas completas: Map(t → {ab,ba}) con solo las horas en que se midieron los 60 minutos. */
function fullHours() {
  const m = new Map()
  for (const r of st.hourly) {
    const t = Date.parse(r.bucket_start)
    const e = m.get(t) ?? {}
    e[r.direction] = r
    m.set(t, e)
  }
  return m
}

function renderProfile() {
  const acc = Array.from({ length: 24 }, () => ({ n: 0, v: Object.fromEntries(CLASSES.map((c) => [c.key, 0])) }))
  for (const [t, e] of fullHours()) {
    const d = new Date(t)
    const we = d.getDay() === 0 || d.getDay() === 6
    if ((st.daytype === 'we') !== we) continue
    if (!dirs().every((k) => Number(e[k]?.minutes_measured ?? 0) >= 60)) continue
    const a = acc[d.getHours()]
    a.n++
    for (const c of CLASSES) for (const k of dirs()) a.v[c.key] += Number(e[k][c.key])
  }
  const data = acc.map((a, h) => [h, ...CLASSES.map((c) => (a.n ? a.v[c.key] / a.n : null))])
  const opts = {
    labels: ['Hora', ...CLASSES.map((c) => c.label)],
    colors: CLASSES.map((c) => c.color),
    strokeWidth: 2,
    drawPoints: true,
    pointSize: 2.5,
    legend: 'always',
    labelsDiv: $('chart-day-legend'),
    ylabel: 'Promedio / hora',
    axisLineColor: '#cbd2d9',
    gridLineColor: '#eef0f3',
    valueRange: [0, null],
    axes: {
      x: { valueFormatter: (h) => `${h}:00–${h + 1}:00`, axisLabelFormatter: (h) => `${h}h`, drawGrid: false, pixelsPerLabel: 34 },
      y: { valueFormatter: (v) => v.toFixed(1), axisLabelWidth: 40 },
    },
  }
  if (st.graphs.day) st.graphs.day.updateOptions({ file: data, ...opts })
  else st.graphs.day = new Dygraph($('chart-day'), data, opts)
}

function renderDirections() {
  const acc = Array.from({ length: 24 }, () => ({ ab: [0, 0], ba: [0, 0] }))
  for (const [t, e] of fullHours()) {
    const h = new Date(t).getHours()
    for (const k of ['ab', 'ba']) {
      if (Number(e[k]?.minutes_measured ?? 0) < 60) continue
      acc[h][k][0] += motorOf(e[k])
      acc[h][k][1]++
    }
  }
  const avg = ([s, n]) => (n ? s / n : null)
  const a = st.site.label_a, b = st.site.label_b
  const data = acc.map((x, h) => [h, avg(x.ab), avg(x.ba)])
  const opts = {
    labels: ['Hora', `${a} → ${b}`, `${b} → ${a}`],
    colors: ['#16a37f', '#e8774a'],
    strokeWidth: 2.4,
    fillGraph: true,
    fillAlpha: 0.08,
    drawPoints: true,
    pointSize: 2.5,
    legend: 'always',
    labelsDiv: $('chart-dir-legend'),
    ylabel: 'Vehículos / hora',
    axisLineColor: '#cbd2d9',
    gridLineColor: '#eef0f3',
    valueRange: [0, null],
    axes: {
      x: { valueFormatter: (h) => `${h}:00–${h + 1}:00`, axisLabelFormatter: (h) => `${h}h`, drawGrid: false, pixelsPerLabel: 34 },
      y: { valueFormatter: (v) => v.toFixed(1), axisLabelWidth: 40 },
    },
  }
  if (st.graphs.dir) st.graphs.dir.updateOptions({ file: data, ...opts })
  else st.graphs.dir = new Dygraph($('chart-dir'), data, opts)
}

// ---------------------------------------------------------------------------------------------------------------
// Velocidades

function renderSpeeds(counts, byHour) {
  const limit = st.site.speed_limit_kmh
  const total = counts.reduce((a, b) => a + b, 0)
  const share = counts.map((n) => (total ? (100 * n) / total : 0))
  bars($('chart-speed'), {
    height: 240,
    labels: BIN_LABELS,
    values: share,
    unit: ' %',
    color: (_, i) => (limit && i * 10 >= limit ? '#e0533d' : '#3497c4'),
    fmtValue: (v, i) => `${v.toFixed(1)} % · ${fmt(counts[i])} vehículos`,
    empty: 'Sin datos de velocidad en el periodo',
  })
  const v = v85(counts)
  const over = limit ? counts.reduce((s, n, i) => s + (i * 10 >= limit ? n : 0), 0) : 0
  $('speed-note').innerHTML = total
    ? `${icon('info', 16)}<span>V85 del periodo: <b>${Math.round(v)} km/h</b> · ${fmt(total)} vehículos (ambos sentidos)${
        limit ? ` · <b>${pct(over, total)}</b> en rangos desde ${limit} km/h (en rojo)` : ''}.</span>`
    : ''

  const v85h = byHour.map((row) => v85(row, 10))
  bars($('chart-v85'), {
    height: 240,
    labels: Array.from({ length: 24 }, (_, h) => `${h}h`),
    values: v85h.map((x) => (x == null ? null : Math.round(x))),
    unit: '',
    ref: limit ? { value: limit, label: `Límite ${limit} km/h` } : null,
    color: (x) => (limit && x > limit ? '#e0533d' : '#7cc7c0'),
    fmtValue: (x, h) => `V85 ${x} km/h · ${fmt(byHour[h].reduce((a, b) => a + b, 0))} vehículos`,
    empty: 'Sin datos de velocidad en el periodo',
  })
  $('v85-note').innerHTML = `${icon('info', 16)}<span>La V85 es el indicador habitual en seguridad vial: refleja la velocidad que
    la mayoría considera razonable en la vía. Solo se muestran horas con 10 o más vehículos. Velocidades indicativas.</span>`
}

// ---------------------------------------------------------------------------------------------------------------
// Reparto modal

function renderSplit(sums) {
  const all = CLASSES.reduce((s, c) => s + sums[c.key], 0)
  donut($('chart-donut'), CLASSES.map((c) => ({ label: c.label, color: c.color, value: sums[c.key] })), fmt(all))
  $('split-list').innerHTML = DISPLAY.map((c) => {
    const p = all ? (100 * sums[c.key]) / all : 0
    return `<li style="--c:${c.color}">${icon(c.icon, 22)}<span class="name">${c.label}</span>
      <span class="track"><span class="fill" style="display:block;width:${p}%"></span></span>
      <span class="v">${p.toLocaleString('es-EC', { maximumFractionDigits: 1 })} %</span></li>`
  }).join('')
}

// ---------------------------------------------------------------------------------------------------------------

function renderByDirection(keepWindow = false) {
  const sums = totals()
  renderKpis(sums)
  renderDaily()
  renderSeries({ keepWindow })
  renderProfile()
  renderSplit(sums)
}

async function reload() {
  const token = ++st.loading
  const id = st.id
  const [rows, hourly, daily, sp, spHour] = await Promise.all([
    st.bucket === 60 ? null : series(id, st.from, st.to, st.bucket),
    series(id, st.from, st.to, 60),
    series(id, st.from, st.to, 1440),
    speeds(id, st.from, st.to),
    speedsByHour(id, st.from, st.to),
  ])
  if (token !== st.loading || id !== st.id) return
  st.hourly = hourly
  st.rows = rows ?? hourly
  st.daily = daily
  renderByDirection()
  renderDirections()
  renderSpeeds(sp, spHour)
}

async function reloadSeries() {
  st.rows = st.bucket === 60 ? st.hourly : await series(st.id, st.from, st.to, st.bucket)
  renderSeries()
}

function exportPng() {
  const g = st.graphs.series
  if (!g) return
  const src = g.hidden_
  const out = document.createElement('canvas')
  out.width = src.width
  out.height = src.height + 44
  const ctx = out.getContext('2d')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, out.width, out.height)
  ctx.fillStyle = '#1b2230'
  ctx.font = '600 16px Outfit, system-ui, sans-serif'
  ctx.fillText(`${st.site.name} · ${$('from').value} a ${$('to').value}`, 12, 26)
  ctx.drawImage(src, 0, 44)
  const a = document.createElement('a')
  a.download = `aforo_${st.site.name.replace(/[^\w-]+/g, '_')}_${$('from').value}.png`
  a.href = out.toDataURL('image/png')
  a.click()
}

// ---------------------------------------------------------------------------------------------------------------
// Controles

function toast(text) {
  const t = $('toast')
  t.textContent = text
  t.hidden = false
  setTimeout(() => (t.hidden = true), 4000)
}

const fail = (e) => toast(`No se pudieron cargar los datos: ${e.message ?? e}`)

function bindControls() {
  if (bindControls.done) return
  bindControls.done = true
  $('chart-series').addEventListener('mousemove', moveSeriesTip)
  $('chart-series').addEventListener('mouseleave', () => ($('series-tip').hidden = true))
  const pick = (sel, el) => document.querySelectorAll(sel).forEach((b) => b.classList.toggle('on', b === el))
  document.querySelectorAll('[data-range]').forEach((b) =>
    b.addEventListener('click', () => {
      pick('[data-range]', b)
      setRange(Number(b.dataset.range))
      reload().catch(fail)
    }),
  )
  document.querySelectorAll('[data-dir]').forEach((b) =>
    b.addEventListener('click', () => {
      pick('[data-dir]', b)
      st.dir = b.dataset.dir
      renderByDirection(true)
    }),
  )
  document.querySelectorAll('[data-bucket]').forEach((b) =>
    b.addEventListener('click', () => {
      pick('[data-bucket]', b)
      st.bucket = Number(b.dataset.bucket)
      reloadSeries().catch(fail)
    }),
  )
  document.querySelectorAll('[data-daytype]').forEach((b) =>
    b.addEventListener('click', () => {
      pick('[data-daytype]', b)
      st.daytype = b.dataset.daytype
      renderProfile()
    }),
  )
  const dates = () => {
    const f = parseDate($('from').value)
    const t = new Date(parseDate($('to').value).getTime() + DAY)
    if (!(t > f) || t - f > 93 * DAY) return toast('Elija un rango de hasta 93 días.')
    pick('[data-range]', null)
    st.from = f
    st.to = t
    reload().catch(fail)
  }
  $('from').addEventListener('change', dates)
  $('to').addEventListener('change', dates)
  $('reset-zoom').innerHTML = `${icon('reset', 16)}Restablecer`
  $('export-png').innerHTML = `${icon('download', 16)}PNG`
  $('reset-zoom').addEventListener('click', () => st.graphs.series?.resetZoom())
  $('export-png').addEventListener('click', exportPng)
}

// ---------------------------------------------------------------------------------------------------------------
// Entrada y salida de la vista

export async function showSite(id) {
  bindControls()
  if (st.id !== id) {
    leaveSite()
    st.id = id
    for (const g of Object.values(st.graphs)) g.destroy?.()
    st.graphs = {}
    st.dir = 'both'
    document.querySelectorAll('[data-dir]').forEach((b) => b.classList.toggle('on', b.dataset.dir === 'both'))
    setRange(7)
    document.querySelectorAll('[data-range]').forEach((b) => b.classList.toggle('on', b.dataset.range === '7'))
    window.scrollTo(0, 0)
  }
  st.site = await loadSite(id)
  if (!st.site) {
    $('site-name').textContent = 'Estación no encontrada'
    return
  }
  renderHead()
  renderMinimap()
  seriesToggles()
  st.live = await liveRow(id)
  renderLive()
  await reload()

  // en vivo: el estado cambia cada ~2 min; cuando cierra un periodo, se recargan las gráficas
  st.unsubscribe?.()
  st.unsubscribe = onLive(id, (row) => {
    const closed = st.live?.period_start && row?.period_start !== st.live.period_start
    st.live = row
    renderLive()
    if (closed && st.to.getTime() > Date.now()) setTimeout(() => reload().catch(() => {}), 3000)
  })
  clearInterval(st.ticker)
  st.ticker = setInterval(renderLive, 10_000)
}

export function leaveSite() {
  st.unsubscribe?.()
  st.unsubscribe = null
  clearInterval(st.ticker)
}
