// Página de una estación: totales, serie temporal (Dygraphs), día promedio, sentidos, velocidades y estado en vivo.
import { CLASSES, site as loadSite, series, speeds, liveRow, onLive, liveState, ago, fmt, esc } from './data.js'

const $ = (id) => document.getElementById(id)
const DAY = 86_400_000
const MOTOR = CLASSES.filter((c) => c.motor).map((c) => c.key)

const st = {
  id: null,
  site: null,
  from: null,
  to: null,
  dir: 'both',
  bucket: 60,
  visible: CLASSES.map(() => true),
  rows: [],
  buckets: [],
  live: null,
  unsubscribe: null,
  ticker: null,
  graphs: {},
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

// ---------------------------------------------------------------------------------------------------------------
// Datos

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
  for (let t = st.from.getTime(); t < st.to.getTime() && t <= Date.now(); t += ms) {
    const e = byStart.get(t) ?? { ab: null, ba: null }
    const dirs = st.dir === 'both' ? ['ab', 'ba'] : [st.dir]
    const values = {}
    let any = false
    for (const c of CLASSES) {
      let v = 0
      for (const d of dirs) if (e[d]) ((v += Number(e[d][c.key])), (any = true))
      values[c.key] = v
    }
    const minutes = Math.max(...dirs.map((d) => Number(e[d]?.minutes_measured ?? 0)))
    out.push({ t, values: any ? values : null, coverage: Math.min(1, minutes / st.bucket), ab: e.ab, ba: e.ba })
  }
  return out
}

const motorOf = (row) => (row ? MOTOR.reduce((s, k) => s + Number(row[k]), 0) : null)

// ---------------------------------------------------------------------------------------------------------------
// Dibujo

function renderTotals() {
  const sums = Object.fromEntries(CLASSES.map((c) => [c.key, 0]))
  for (const b of st.buckets) if (b.values) for (const c of CLASSES) sums[c.key] += b.values[c.key]
  const motor = MOTOR.reduce((s, k) => s + sums[k], 0)
  const all = CLASSES.reduce((s, c) => s + sums[c.key], 0) || 1
  const cards = [`<div class="card total" style="--c:#1d2330"><div class="n">${fmt(motor)}</div><div class="k">Vehículos motorizados</div></div>`]
  for (const c of CLASSES) {
    cards.push(`<div class="card total" style="--c:${c.color}"><div class="n">${fmt(sums[c.key])}</div>
      <div class="k">${c.label} · ${((100 * sums[c.key]) / all).toFixed(1)} %</div></div>`)
  }
  $('totals').innerHTML = cards.join('')
  $('modal-split').innerHTML = CLASSES.map((c) => {
    const p = (100 * sums[c.key]) / all
    return `<div class="row"><span>${c.label}</span><div class="track"><div class="fill" style="width:${p}%;background:${c.color}"></div></div><span>${p.toFixed(1)} %</span></div>`
  }).join('')
}

function seriesToggles() {
  $('series-toggles').innerHTML = CLASSES.map(
    (c, i) => `<label><input type="checkbox" data-i="${i}" ${st.visible[i] ? 'checked' : ''}>
      <span class="swatch" style="background:${c.color}"></span>${c.label}</label>`,
  ).join('')
  $('series-toggles').onchange = (e) => {
    const i = Number(e.target.dataset.i)
    st.visible[i] = e.target.checked
    st.graphs.series?.setVisibility(i, e.target.checked)
  }
}

function renderSeries() {
  const data = st.buckets.map((b) => [new Date(b.t), ...CLASSES.map((c) => (b.values ? b.values[c.key] : null))])
  if (!data.length) data.push([new Date(st.from), ...CLASSES.map(() => null)])
  const ms = st.bucket * 60_000
  const gaps = st.buckets.filter((b) => b.coverage < 0.999)
  const opts = {
    labels: ['Fecha', ...CLASSES.map((c) => c.label)],
    colors: CLASSES.map((c) => c.color),
    visibility: st.visible,
    stackedGraph: true,
    fillGraph: true,
    fillAlpha: 0.75,
    stepPlot: true,
    strokeWidth: 1,
    connectSeparatedPoints: false,
    showRangeSelector: true,
    rangeSelectorHeight: 36,
    showRoller: true,
    rollPeriod: 1,
    legend: 'always',
    labelsDiv: $('chart-series-legend'),
    labelsSeparateLines: false,
    ylabel: st.bucket === 1440 ? 'Vehículos / día' : st.bucket === 60 ? 'Vehículos / hora' : 'Vehículos / 15 min',
    highlightCircleSize: 3,
    underlayCallback: (ctx, area, g) => {
      ctx.fillStyle = 'rgba(140, 145, 155, 0.22)'
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

function renderDirections() {
  const a = st.site.label_a, b = st.site.label_b
  const data = st.buckets.map((x) => [new Date(x.t), motorOf(x.ab), motorOf(x.ba)])
  if (!data.length) data.push([new Date(st.from), null, null])
  const opts = {
    labels: ['Fecha', `A → B (${a} → ${b})`, `B → A (${b} → ${a})`],
    colors: ['#ff9900', '#3d9ac0'],
    strokeWidth: 2,
    legend: 'always',
    labelsDiv: $('chart-dir-legend'),
    ylabel: 'Vehículos motorizados',
    stepPlot: true,
  }
  if (st.graphs.dir) st.graphs.dir.updateOptions({ file: data, ...opts })
  else st.graphs.dir = new Dygraph($('chart-dir'), data, opts)
}

/** Día promedio (vehículos motorizados por hora), laborables y fin de semana; solo horas medidas completas. */
async function renderAverageDay() {
  const rows = st.bucket === 60 ? st.rows : await series(st.id, st.from, st.to, 60)
  const acc = { wd: Array.from({ length: 24 }, () => [0, 0]), we: Array.from({ length: 24 }, () => [0, 0]) }
  const byHour = new Map()
  for (const r of rows) {
    if (st.dir !== 'both' && r.direction !== st.dir) continue
    const t = Date.parse(r.bucket_start)
    const e = byHour.get(t) ?? { v: 0, full: true }
    e.v += motorOf(r)
    e.full &&= Number(r.minutes_measured) >= 60
    byHour.set(t, e)
  }
  for (const [t, e] of byHour) {
    if (!e.full) continue
    const d = new Date(t)
    const k = d.getDay() === 0 || d.getDay() === 6 ? 'we' : 'wd'
    acc[k][d.getHours()][0] += e.v
    acc[k][d.getHours()][1] += 1
  }
  const avg = ([s, n]) => (n ? s / n : null)
  const data = Array.from({ length: 24 }, (_, h) => [h, avg(acc.wd[h]), avg(acc.we[h])])
  const opts = {
    labels: ['Hora', 'Laborables', 'Fin de semana'],
    colors: ['#3d9ac0', '#f08a5d'],
    strokeWidth: 2,
    drawPoints: true,
    pointSize: 2.5,
    legend: 'always',
    labelsDiv: $('chart-day-legend'),
    ylabel: 'Vehículos / hora',
    axes: { x: { valueFormatter: (h) => `${h}:00–${h + 1}:00`, axisLabelFormatter: (h) => `${h}h` } },
  }
  if (st.graphs.day) st.graphs.day.updateOptions({ file: data, ...opts })
  else st.graphs.day = new Dygraph($('chart-day'), data, opts)
}

/** Histograma de velocidades y V85 (interpolando dentro del rango de 10 km/h). */
async function renderSpeeds() {
  const rows = await speeds(st.id, st.from, st.to)
  const counts = rows.map((r) => Number(r.vehicles))
  const total = counts.reduce((a, b) => a + b, 0)
  const max = Math.max(1, ...counts)
  $('speed-bars').innerHTML =
    counts.map((n) => `<div class="bar" style="height:${(100 * n) / max}%" title="${fmt(n)}"><span>${total ? Math.round((100 * n) / total) : 0}%</span></div>`).join('') +
    ''
  let note = 'Sin datos de velocidad en el periodo.'
  if (total) {
    let acc = 0, v85 = null
    for (let i = 0; i < 12 && v85 === null; i++) {
      if (acc + counts[i] >= 0.85 * total) v85 = i * 10 + (10 * (0.85 * total - acc)) / Math.max(1, counts[i])
      acc += counts[i]
    }
    const mean = counts.reduce((s, n, i) => s + n * (i * 10 + 5), 0) / total
    note = `V85: <b>${v85.toFixed(0)} km/h</b> · media ≈ ${mean.toFixed(0)} km/h · ${fmt(total)} vehículos (ambos sentidos). Rangos de 10 km/h: 0–10 … 110+. Velocidades indicativas.`
  }
  $('speed-note').innerHTML = note
  if (!$('speed-axis')) {
    const axis = document.createElement('div')
    axis.className = 'bars-axis'
    axis.id = 'speed-axis'
    axis.innerHTML = Array.from({ length: 12 }, (_, i) => `<span>${i === 11 ? '110+' : i * 10}</span>`).join('')
    $('speed-bars').after(axis)
  }
}

function renderLive() {
  const l = st.live
  const s = liveState(l?.status, l?.updated_at)
  const dotText = {
    ok: `En vivo · ${l?.fps?.toFixed(1) ?? '–'} fps`,
    warn: l?.status === 'reconnecting' ? 'Reconectando la cámara' : l?.status === 'error' ? 'Error en el equipo' : 'Conteo detenido',
    off: 'Sin conexión',
  }[s]
  let html = `<div class="status"><span class="dot ${s}"></span>${dotText}</div><div class="muted small">Último dato ${ago(l?.updated_at)}`
  if (l?.pending) html += ` · ${fmt(l.pending)} periodos por subir`
  html += '</div>'
  if (l?.period_start && s !== 'off') {
    const p0 = new Date(l.period_start)
    const p1 = new Date(p0.getTime() + 15 * 60_000)
    const hm = (d) => d.toLocaleTimeString('es-EC', { hour: '2-digit', minute: '2-digit' })
    const c = l.counts ?? {}
    html += `<table><tr><th>Periodo ${hm(p0)}–${hm(p1)}</th><th>A → B</th><th>B → A</th></tr>`
    for (const k of CLASSES) html += `<tr><td>${k.label}</td><td>${fmt(c.ab?.[k.key])}</td><td>${fmt(c.ba?.[k.key])}</td></tr>`
    html += '</table>'
  }
  $('live-box').innerHTML = html
}

async function reload() {
  st.rows = await series(st.id, st.from, st.to, st.bucket)
  st.buckets = buildBuckets()
  renderTotals()
  renderSeries()
  renderDirections()
  await Promise.all([renderAverageDay(), renderSpeeds()])
}

function exportPng() {
  const g = st.graphs.series
  if (!g) return
  const src = g.hidden_
  const out = document.createElement('canvas')
  out.width = src.width
  out.height = src.height + 40
  const ctx = out.getContext('2d')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, out.width, out.height)
  ctx.fillStyle = '#1d2330'
  ctx.font = 'bold 16px system-ui, sans-serif'
  ctx.fillText(`${st.site.name} · ${$('from').value} a ${$('to').value}`, 12, 24)
  ctx.drawImage(src, 0, 40)
  const a = document.createElement('a')
  a.download = `aforo_${st.site.name.replace(/[^\w-]+/g, '_')}_${$('from').value}.png`
  a.href = out.toDataURL('image/png')
  a.click()
}

// ---------------------------------------------------------------------------------------------------------------
// Entrada y salida de la vista

function bindControls() {
  if (bindControls.done) return
  bindControls.done = true
  const pick = (sel, el) => {
    document.querySelectorAll(sel).forEach((b) => b.classList.toggle('on', b === el))
  }
  document.querySelectorAll('[data-range]').forEach((b) =>
    b.addEventListener('click', () => {
      pick('[data-range]', b)
      setRange(Number(b.dataset.range))
      reload()
    }),
  )
  document.querySelectorAll('[data-dir]').forEach((b) =>
    b.addEventListener('click', () => {
      pick('[data-dir]', b)
      st.dir = b.dataset.dir
      st.buckets = buildBuckets()
      renderTotals()
      renderSeries()
      renderAverageDay()
    }),
  )
  document.querySelectorAll('[data-bucket]').forEach((b) =>
    b.addEventListener('click', () => {
      pick('[data-bucket]', b)
      st.bucket = Number(b.dataset.bucket)
      reload()
    }),
  )
  const dates = () => {
    const f = parseDate($('from').value)
    const t = new Date(parseDate($('to').value).getTime() + DAY)
    if (!(t > f) || t - f > 93 * DAY) return alertBox('Elija un rango de hasta 93 días.')
    pick('[data-range]', null)
    st.from = f
    st.to = t
    reload()
  }
  $('from').addEventListener('change', dates)
  $('to').addEventListener('change', dates)
  $('reset-zoom').addEventListener('click', () => st.graphs.series?.resetZoom())
  $('export-png').addEventListener('click', exportPng)
}

function alertBox(text) {
  const t = $('toast')
  t.textContent = text
  t.hidden = false
  setTimeout(() => (t.hidden = true), 4000)
}

export async function showSite(id) {
  bindControls()
  if (st.id !== id) {
    leaveSite()
    st.id = id
    st.graphs = {}
    for (const el of ['chart-series', 'chart-dir', 'chart-day']) $(el).innerHTML = ''
    setRange(7)
    document.querySelectorAll('[data-range]').forEach((b) => b.classList.toggle('on', b.dataset.range === '7'))
  }
  st.site = await loadSite(id)
  if (!st.site) {
    $('site-name').textContent = 'Estación no encontrada'
    return
  }
  $('site-name').textContent = st.site.name
  $('site-desc').innerHTML = `${esc(st.site.description ?? '')} · A = ${esc(st.site.label_a)}, B = ${esc(st.site.label_b)}`
  $('dir-ab').textContent = `${st.site.label_a} → ${st.site.label_b}`
  $('dir-ba').textContent = `${st.site.label_b} → ${st.site.label_a}`
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
    if (closed && st.to.getTime() > Date.now()) setTimeout(() => reload(), 3000)
  })
  clearInterval(st.ticker)
  st.ticker = setInterval(renderLive, 5000)
}

export function leaveSite() {
  st.unsubscribe?.()
  st.unsubscribe = null
  clearInterval(st.ticker)
}
