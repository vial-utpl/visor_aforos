// Portada: un taxi recorre Loja mientras se baja con el scroll y las estaciones de conteo que pasa cuentan lo que ven
// (js/escena.js), y después los totales reales de la base. Con "reducir movimiento" la escena queda quieta.
import { CLASSES, db, siteOverview, liveState, fmt, esc } from './data.js'
import { icon } from './icons.js'
import { buildScene, fitScene, renderScene, NAME } from './escena.js'

const $ = (id) => document.getElementById(id)
const C = Object.fromEntries(CLASSES.map((c) => [c.key, c]))
const PLURAL = { car: 'Autos', motorcycle: 'Motos', bus: 'Buses', truck: 'Camiones', bicycle: 'Bicicletas', person: 'Peatones' }

// ---------------------------------------------------------------------------------------------------------------
// Escena con scroll

let counts = {}
let shownTitle = null
let raf = 0
let lastP = -1

function build() {
  buildScene($('home-svg'))
  $('home-hud').innerHTML = CLASSES.slice()
    .reverse()
    .map((c) => `<div class="h-chip" id="h-chip-${c.key}" style="--c:${c.color}">${icon(c.icon, 22)}<span>${PLURAL[c.key]}</span><b>0</b></div>`)
    .join('')
}

function render(p) {
  if (p === lastP) return
  const forward = p > lastP
  lastP = p
  const { counts: next, focus } = renderScene(p)
  for (const c of CLASSES) {
    if (next[c.key] === counts[c.key]) continue
    const chip = $(`h-chip-${c.key}`)
    chip.querySelector('b').textContent = next[c.key]
    if (forward && next[c.key] > (counts[c.key] ?? 0)) {
      chip.classList.remove('bump')
      void chip.offsetWidth // reinicia la animación
      chip.classList.add('bump')
    }
  }
  counts = next
  // título: lo que la cámara está viendo, o el mensaje inicial
  const title = p < 0.04 ? null : focus ? `${focus.key}|${focus.dir}` : shownTitle
  if (title !== shownTitle) {
    shownTitle = title
    const [kind, dir] = title ? title.split('|') : []
    const cls = kind === 'taxi' ? 'car' : kind
    $('home-intro').classList.toggle('off', !!title)
    $('home-now').classList.toggle('off', !title)
    if (title) $('home-now').innerHTML = `<span style="color:${C[cls].color}">${icon(C[cls].icon, 40)}</span>${NAME[kind]} <small>${dir === 'ab' ? 'A → B' : 'B → A'}</small>`
  }
  $('home-hint').classList.toggle('off', p > 0.02)
}

function progress() {
  const sec = $('home-scroll')
  const r = sec.getBoundingClientRect()
  const span = sec.offsetHeight - innerHeight
  return span > 0 ? Math.min(1, Math.max(0, -r.top / span)) : 0
}

function onScroll() {
  if (raf) return
  raf = requestAnimationFrame(() => {
    raf = 0
    render(progress())
  })
}

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches

// ---------------------------------------------------------------------------------------------------------------
// Totales reales

let loaded = 0

function countUp(el, to) {
  if (reduced() || !to) return void (el.textContent = fmt(to))
  const t0 = performance.now()
  const dur = 1600
  const step = (now) => {
    const k = Math.min(1, (now - t0) / dur)
    el.textContent = fmt(Math.round(to * (1 - (1 - k) ** 3)))
    if (k < 1) requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
}

async function loadTotals() {
  if (Date.now() - loaded < 60_000) return
  loaded = Date.now()
  const [tot, sites] = await Promise.all([
    db.rpc('get_totals').then(({ data, error }) => (error ? null : data?.[0] ?? null)),
    siteOverview().catch(() => []),
  ])
  const real = sites.filter((s) => !/\(emulada\)/i.test(s.name))
  const live = real.filter((s) => liveState(s.live_status, s.live_updated_at) === 'ok').length
  const total = tot ? CLASSES.reduce((s, c) => s + Number(tot[c.key] ?? 0), 0) : null
  const big = $('home-total')
  big.dataset.to = total ?? ''
  big.textContent = total == null ? '–' : '0'
  const since = tot?.since ? new Date(tot.since).toLocaleDateString('es-EC', { day: 'numeric', month: 'long', year: 'numeric' }) : null
  $('home-total-sub').innerHTML = total == null
    ? 'Los totales aparecerán cuando la base tenga la función de la portada.'
    : `usuarios de la vía contados en ${fmt(real.length)} ${real.length === 1 ? 'estación' : 'estaciones'}${since ? ` desde el ${esc(since)}` : ''}.
       <span class="h-live"><span class="dot ${live ? 'ok' : ''}"></span>${live ? `${live} contando ahora` : 'Ninguna contando en este momento'}</span>`
  $('home-classes').innerHTML = CLASSES.slice()
    .reverse()
    .map((c) => {
      const v = tot ? Number(tot[c.key] ?? 0) : null
      const pct = total ? (100 * v) / total : 0
      return `<a class="h-class" href="#/mapa" style="--c:${c.color}">
        <span class="ic">${icon(c.icon, 30)}</span>
        <b>${v == null ? '–' : fmt(v)}</b>
        <span class="k">${PLURAL[c.key]}</span>
        <span class="bar"><i style="width:${pct.toFixed(1)}%"></i></span>
        <span class="go">Ver en el mapa →</span></a>`
    })
    .join('')
  // el contador sube al verse
  const io = new IntersectionObserver((entries) => {
    if (!entries.some((e) => e.isIntersecting)) return
    io.disconnect()
    if (big.dataset.to) countUp(big, Number(big.dataset.to))
  }, { threshold: 0.4 })
  io.observe(big)
}

// ---------------------------------------------------------------------------------------------------------------

let built = false
let revealIo
let sizeObs

export async function showHome() {
  if (!built) {
    built = true
    build()
    revealIo = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) e.target.classList.add('in')
    }, { threshold: 0.2 })
    document.querySelectorAll('#view-home .reveal').forEach((el) => revealIo.observe(el))
    sizeObs = new ResizeObserver(() => fitScene())
  }
  $('view-home').classList.toggle('still', reduced())
  sizeObs.observe($('home-svg'))
  lastP = -1
  if (reduced()) {
    render(0.17) // el taxi recién contado en la primera estación
  } else {
    addEventListener('scroll', onScroll, { passive: true })
    addEventListener('resize', onScroll)
    render(progress())
  }
  loadTotals().catch(() => {})
}

export function leaveHome() {
  sizeObs?.disconnect()
  removeEventListener('scroll', onScroll)
  removeEventListener('resize', onScroll)
}
