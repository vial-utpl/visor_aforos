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

function renderSeries() {
  const buckets = buildBuckets()
  const data = buckets.map((b) => [new Date(b.t), ...CLASSES.map((c) => (b.values ? b.values[c.key] : null))])
  if (!data.length) data.push([new Date(st.from), ...CLASSES.map(() => null)])
  const ms = st.bucket * 60_000
  const gaps = buckets.filter((b) => b.coverage < 0.999)
  const unit = st.bucket === 1440 ? 'día' : st.bucket === 60 ? 'hora' : '15 min'
  const opts = {
    labels: ['Fecha', ...CLASSES.map((c) => c.label)],
    colors: CLASSES.map((c) => c.color),
    visibility: st.visible,
    stackedGraph: true,
    stackedGraphNaNFill: 'none',
    fillGraph: true,
    fillAlpha: 0.88,
    strokeWidth: 0.6,
    stepPlot: false,
    connectSeparatedPoints: false,
    showRangeSelector: true,
    rangeSelectorHeight: 44,
    rangeSelectorPlotFillColor: '#a3adbd',
    rangeSelectorPlotFillGradientColor: '#e5e8ed',
    rangeSelectorPlotStrokeColor: '#6b7280',
    rangeSelectorBackgroundStrokeColor: '#d1d5db',
    rangeSelectorForegroundStrokeColor: '#6b7280',
    showRoller: true,
    rollPeriod: 1,
    legend: 'always',
    labelsDiv: $('chart-series-legend'),
    labelsSeparateLines: false,
    ylabel: `Usuarios / ${unit}`,
    axisLineColor: '#cbd2d9',
    gridLineColor: '#eef0f3',
    highlightCircleSize: 3,
    highlightSeriesOpts: null,
    axes: {
      x: { axisLabelFontSize: 12, drawGrid: false },
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

function renderByDirection() {
  const sums = totals()
  renderKpis(sums)
  renderDaily()
  renderSeries()
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
      renderByDirection()
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

  // en vivo: el estado cambia cada ~30 s; cuando cierra un periodo, se recargan las gráficas
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
