// Gráficas SVG ligeras: barras apiladas, barras con línea de referencia y dona. Se redibujan al cambiar el ancho.
import { esc } from './data.js'

const specs = new WeakMap()
const ro = new ResizeObserver((entries) => {
  for (const e of entries) {
    const s = specs.get(e.target)
    if (s && Math.abs(e.contentRect.width - s.w) > 2) draw(e.target, s)
  }
})

function draw(el, s) {
  s.w = el.clientWidth
  el.innerHTML = s.fn(el.clientWidth, s.opts)
}

function mount(el, fn, opts) {
  const s = { fn, opts, w: 0 }
  specs.set(el, s)
  ro.observe(el)
  draw(el, s)
}

// Tooltip compartido: cualquier elemento SVG con data-tip
let tip
function ensureTip() {
  if (tip) return
  tip = document.createElement('div')
  tip.className = 'tip'
  tip.hidden = true
  document.body.append(tip)
  document.addEventListener('mousemove', (e) => {
    const t = e.target.closest?.('[data-tip]')
    if (!t) return void (tip.hidden = true)
    tip.innerHTML = t.dataset.tip
    tip.hidden = false
    const r = tip.getBoundingClientRect()
    let x = e.clientX + 14
    if (x + r.width > innerWidth - 8) x = e.clientX - r.width - 14
    tip.style.left = `${x}px`
    tip.style.top = `${Math.max(8, e.clientY - r.height - 10)}px`
  })
}

/** Escala "bonita" para el eje Y: [máximo, paso]. */
function niceScale(max, ticks = 4) {
  if (!(max > 0)) return [ticks, 1]
  const raw = max / ticks
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)
  return [step * Math.ceil(max / step), step]
}

const nf = (v) => Number(v).toLocaleString('es-EC', { maximumFractionDigits: 1 })

function axes(w, h, pad, yMax, step, unit) {
  let g = ''
  for (let v = 0; v <= yMax + 1e-9; v += step) {
    const y = pad.t + (h - pad.t - pad.b) * (1 - v / yMax)
    g += `<line x1="${pad.l}" x2="${w - pad.r}" y1="${y}" y2="${y}" class="grid"/>`
    g += `<text x="${pad.l - 8}" y="${y + 4}" class="ylab" text-anchor="end">${nf(v)}${unit}</text>`
  }
  return g
}

function xLabels(labels, x0, bw, gap, h, pad) {
  const every = Math.max(1, Math.ceil(labels.length / Math.max(1, Math.floor((labels.length * (bw + gap)) / 46))))
  return labels
    .map((l, i) =>
      i % every ? '' : `<text x="${x0 + i * (bw + gap) + bw / 2}" y="${h - pad.b + 16}" class="xlab" text-anchor="middle">${esc(l)}</text>`,
    )
    .join('')
}

/**
 * Barras apiladas. opts: { labels: [..], stacks: [{label, color, values: [..]}], unit, height, empty }
 */
export function stackedBars(el, opts) {
  ensureTip()
  mount(el, (w, o) => {
    const h = o.height ?? 260
    const pad = { t: 12, r: 8, b: 28, l: 48 }
    const n = o.labels.length
    const totals = o.labels.map((_, i) => o.stacks.reduce((s, st) => s + (st.values[i] ?? 0), 0))
    const [yMax, step] = niceScale(Math.max(...totals, 0))
    const iw = w - pad.l - pad.r
    const gap = Math.max(2, Math.min(14, (iw / Math.max(1, n)) * 0.28))
    const bw = Math.max(2, (iw - gap * (n - 1)) / Math.max(1, n))
    const ih = h - pad.t - pad.b
    let bars = ''
    for (let i = 0; i < n; i++) {
      let y = pad.t + ih
      const x = pad.l + i * (bw + gap)
      const rows = o.stacks
        .map((st) => `<span class="sw" style="background:${st.color}"></span>${esc(st.label)} <b>${nf(st.values[i] ?? 0)}</b>`)
        .reverse()
        .join('<br>')
      for (const st of o.stacks) {
        const v = st.values[i] ?? 0
        if (!v) continue
        const bh = (ih * v) / yMax
        y -= bh
        bars += `<rect x="${x}" y="${y}" width="${bw}" height="${Math.max(0, bh)}" fill="${st.color}"/>`
      }
      // zona invisible para el tooltip de toda la columna
      bars += `<rect x="${x - gap / 2}" y="${pad.t}" width="${bw + gap}" height="${ih}" fill="transparent" class="hit"
        data-tip="${esc(`<b>${esc(o.labels[i])}</b> · ${nf(totals[i])}<br>${rows}`)}"/>`
    }
    const empty = totals.every((t) => !t) ? `<text x="${w / 2}" y="${h / 2}" class="empty" text-anchor="middle">${esc(o.empty ?? 'Sin datos en el periodo')}</text>` : ''
    return `<svg width="${w}" height="${h}" class="svgchart">${axes(w, h, pad, yMax, step, o.unit ?? '')}${bars}
      ${xLabels(o.labels, pad.l, bw, gap, h, pad)}${empty}</svg>`
  }, opts)
}

/**
 * Barras simples. opts: { labels, values, color: (v, i) => css, ref: {value, label}, unit, height, fmtValue, empty }
 */
export function bars(el, opts) {
  ensureTip()
  mount(el, (w, o) => {
    const h = o.height ?? 240
    const pad = { t: 16, r: 8, b: 28, l: 52 }
    const n = o.labels.length
    const vals = o.values.map((v) => v ?? 0)
    const [yMax, step] = niceScale(Math.max(...vals, o.ref?.value ?? 0) * 1.05)
    const iw = w - pad.l - pad.r
    const gap = Math.max(2, Math.min(12, (iw / Math.max(1, n)) * 0.25))
    const bw = Math.max(2, (iw - gap * (n - 1)) / Math.max(1, n))
    const ih = h - pad.t - pad.b
    let out = ''
    o.values.forEach((v, i) => {
      if (v == null) return
      const bh = (ih * v) / yMax
      const x = pad.l + i * (bw + gap)
      out += `<rect x="${x}" y="${pad.t + ih - bh}" width="${bw}" height="${bh}" rx="2" fill="${o.color(v, i)}"
        data-tip="${esc(`<b>${esc(o.labels[i])}</b><br>${o.fmtValue ? o.fmtValue(v, i) : nf(v)}`)}"/>`
    })
    if (o.ref?.value) {
      const y = pad.t + ih * (1 - o.ref.value / yMax)
      out += `<line x1="${pad.l}" x2="${w - pad.r}" y1="${y}" y2="${y}" class="refline"/>
        <text x="${w - pad.r}" y="${y - 6}" class="reflab" text-anchor="end">${esc(o.ref.label)}</text>`
    }
    const empty = vals.every((v) => !v) ? `<text x="${w / 2}" y="${h / 2}" class="empty" text-anchor="middle">${esc(o.empty ?? 'Sin datos en el periodo')}</text>` : ''
    return `<svg width="${w}" height="${h}" class="svgchart">${axes(w, h, pad, yMax, step, o.unit ?? '')}${out}
      ${xLabels(o.labels, pad.l, bw, gap, h, pad)}${empty}</svg>`
  }, opts)
}

/** Dona. items: [{label, color, value}] */
export function donut(el, items, center = '') {
  ensureTip()
  mount(el, (w) => {
    const size = Math.min(260, w)
    const r = size / 2 - 6
    const r0 = r * 0.62
    const c = size / 2
    const total = items.reduce((s, x) => s + x.value, 0)
    if (!total) return `<svg width="${size}" height="${size}" class="svgchart"><circle cx="${c}" cy="${c}" r="${(r + r0) / 2}" fill="none" stroke="#e6e8ec" stroke-width="${r - r0}"/>
      <text x="${c}" y="${c + 5}" class="empty" text-anchor="middle">Sin datos</text></svg>`
    let a = -Math.PI / 2
    let paths = ''
    for (const it of items) {
      if (!it.value) continue
      const f = it.value / total
      const a2 = a + f * 2 * Math.PI - (f < 1 ? 0.012 : 0)
      const large = a2 - a > Math.PI ? 1 : 0
      const p = (rad, ang) => `${c + rad * Math.cos(ang)} ${c + rad * Math.sin(ang)}`
      const d = f >= 0.9999
        ? `M ${p(r, 0)} A ${r} ${r} 0 1 1 ${p(r, Math.PI)} A ${r} ${r} 0 1 1 ${p(r, 0)} M ${p(r0, 0)} A ${r0} ${r0} 0 1 0 ${p(r0, Math.PI)} A ${r0} ${r0} 0 1 0 ${p(r0, 0)}`
        : `M ${p(r, a)} A ${r} ${r} 0 ${large} 1 ${p(r, a2)} L ${p(r0, a2)} A ${r0} ${r0} 0 ${large} 0 ${p(r0, a)} Z`
      paths += `<path d="${d}" fill="${it.color}" fill-rule="evenodd" data-tip="${esc(`<b>${esc(it.label)}</b><br>${nf(it.value)} · ${nf((100 * it.value) / total)} %`)}"/>`
      a += f * 2 * Math.PI
    }
    return `<svg width="${size}" height="${size}" class="svgchart">${paths}
      <text x="${c}" y="${c - 2}" class="donut-n" text-anchor="middle">${esc(center)}</text>
      <text x="${c}" y="${c + 18}" class="donut-k" text-anchor="middle">en total</text></svg>`
  }, items)
}
