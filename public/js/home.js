// Portada: una cámara en un poste cuenta lo que pasa por la calle mientras se baja con el scroll (cada vehículo recibe
// su recuadro, cruza la línea de conteo y suma en su clase), y después los totales reales de la base.
// La escena no usa librerías: la posición de cada vehículo sale del avance del scroll en una sección "sticky", así que
// subir y bajar es exactamente reversible. Con "reducir movimiento" la escena queda quieta.
import { CLASSES, db, siteOverview, liveState, fmt, esc } from './data.js'
import { icon } from './icons.js'
import { lojaSkyline } from './skyline.js'

const $ = (id) => document.getElementById(id)
const SVGNS = 'http://www.w3.org/2000/svg'
const C = Object.fromEntries(CLASSES.map((c) => [c.key, c]))

// Escena (viewBox 1600 × 640): carril lejano B→A, carril cercano A→B, línea de conteo en x = 900.
const LINE_X = 900
const CONE = [640, 1190] // tramo de la vía que ve la cámara
const LANE = { ba: 492, ab: 556, walk: 424 }
const NAME = { car: 'Auto', motorcycle: 'Moto', bus: 'Bus', truck: 'Camión', bicycle: 'Bicicleta', person: 'Peatón' }
const PLURAL = { car: 'Autos', motorcycle: 'Motos', bus: 'Buses', truck: 'Camiones', bicycle: 'Bicicletas', person: 'Peatones' }

// Lo que pasa frente a la cámara, en orden. dir: ab = de izquierda a derecha.
const EVENTS = [
  { cls: 'car', dir: 'ab' },
  { cls: 'motorcycle', dir: 'ba' },
  { cls: 'bus', dir: 'ab' },
  { cls: 'person', dir: 'ba', lane: 'walk' },
  { cls: 'truck', dir: 'ba' },
  { cls: 'bicycle', dir: 'ab' },
  { cls: 'car', dir: 'ba' },
  { cls: 'motorcycle', dir: 'ab' },
]
const START = 0.05
const STEP = 0.105
const TRAVEL = 0.2 // fracción del scroll que tarda cada uno en cruzar la escena
const FROM = -220
const TO = 1820

// Siluetas de perfil mirando a la derecha, con el suelo en y = 0. w/h: recuadro de detección.
const SHAPES = {
  car: {
    w: 156, h: 62,
    svg: (c) => `<path fill="${c}" d="M-76,-14 L-73,-30 Q-69,-37 -58,-38 L-38,-39 L-20,-57 Q-14,-61 -4,-61 L30,-61 Q41,-61 47,-55 L63,-39 L69,-37 Q77,-34 77,-25 L77,-13 Q77,-9 72,-9 L-72,-9 Q-76,-9 -76,-14 Z"/>
      <path fill="#d7e8f1" d="M-31,-41 L-17,-55 L6,-55 L6,-41 Z M12,-55 L35,-55 L49,-41 L12,-41 Z"/>
      <rect x="70" y="-31" width="7" height="6" rx="2" fill="#fde68a"/>
      ${wheel(-44, 13)}${wheel(46, 13)}`,
  },
  bus: {
    w: 270, h: 108,
    svg: (c) => `<rect x="-134" y="-104" width="268" height="92" rx="12" fill="${c}"/>
      <rect x="-122" y="-92" width="196" height="34" rx="4" fill="#fdf3d6"/>
      <path d="M-73,-92 V-58 M-24,-92 V-58 M25,-92 V-58" stroke="${c}" stroke-width="5"/>
      <rect x="86" y="-92" width="38" height="66" rx="4" fill="#fdf3d6"/>
      <rect x="-134" y="-40" width="268" height="7" fill="rgba(0,0,0,.12)"/>
      ${wheel(-88, 15)}${wheel(84, 15)}`,
  },
  truck: {
    w: 250, h: 112,
    svg: (c) => `<rect x="-124" y="-110" width="176" height="92" rx="5" fill="${c}"/>
      <path fill="${c}" d="M58,-80 L98,-80 Q106,-80 110,-72 L124,-46 L124,-18 L58,-18 Z"/>
      <path fill="#d7e8f1" d="M72,-72 L96,-72 L108,-50 L72,-50 Z"/>
      <rect x="-124" y="-30" width="248" height="10" fill="#374151"/>
      ${wheel(-92, 14)}${wheel(-56, 14)}${wheel(90, 14)}`,
  },
  motorcycle: {
    w: 104, h: 92,
    svg: (c) => `${wheel(-34, 13)}${wheel(36, 13)}
      <path fill="${c}" d="M-34,-13 L-8,-34 L22,-36 L36,-13 L26,-13 L16,-26 L-6,-24 L-22,-13 Z"/>
      <path d="M22,-36 L30,-50" stroke="#374151" stroke-width="4" stroke-linecap="round"/>
      <path d="M-4,-38 L4,-62 M4,-62 L18,-48" stroke="#374151" stroke-width="7" stroke-linecap="round"/>
      <circle cx="6" cy="-74" r="11" fill="${c}"/><rect x="8" y="-78" width="9" height="5" rx="2" fill="#d7e8f1"/>`,
  },
  bicycle: {
    w: 96, h: 96,
    svg: (c) => `<circle cx="-28" cy="-16" r="16" fill="none" stroke="#374151" stroke-width="4"/>
      <circle cx="30" cy="-16" r="16" fill="none" stroke="#374151" stroke-width="4"/>
      <path d="M-28,-16 L-8,-44 L20,-44 L30,-16 M-8,-44 L2,-16 L-28,-16 M20,-44 L16,-54" fill="none" stroke="${c}" stroke-width="5" stroke-linejoin="round"/>
      <path d="M-6,-50 L4,-74 L18,-56 M4,-74 L-2,-50" fill="none" stroke="${c}" stroke-width="7" stroke-linecap="round"/>
      <circle cx="6" cy="-86" r="9" fill="${c}"/>`,
  },
  person: {
    w: 40, h: 96,
    svg: (c) => `<circle cx="0" cy="-84" r="9" fill="${c}"/>
      <path d="M0,-72 L0,-38 M0,-38 L-10,0 M0,-38 L12,-2 M0,-64 L-12,-44 M0,-64 L12,-46" fill="none" stroke="${c}" stroke-width="7" stroke-linecap="round"/>`,
  },
}

function wheel(x, r) {
  return `<circle cx="${x}" cy="-${r}" r="${r}" fill="#1f2329"/><circle cx="${x}" cy="-${r}" r="${r * 0.4}" fill="#9ca3af"/>`
}

/** Fondo de la escena: cielo, cerros, ciudad, vía, poste con la cámara, cono de visión y línea de conteo. */
function sceneSvg() {
  const dashes = Array.from({ length: 23 }, (_, i) => `<rect x="${i * 72}" y="521" width="40" height="5" rx="2"/>`).join('')
  return `
    <defs>
      <linearGradient id="h-sky" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#e8f1f8"/><stop offset="1" stop-color="#f5f8fb"/></linearGradient>
      <linearGradient id="h-cone" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#16a37f" stop-opacity=".05"/><stop offset="1" stop-color="#16a37f" stop-opacity=".22"/></linearGradient>
    </defs>
    <rect width="1600" height="640" fill="url(#h-sky)"/>
    <path fill="#dfe8ef" d="M0,330 C120,250 230,240 340,300 C430,230 560,190 690,280 C800,220 900,200 1010,270 C1120,210 1260,180 1380,260 C1480,220 1560,240 1600,250 L1600,420 L0,420 Z"/>
    <path fill="#d3dee7" d="M0,370 C160,320 260,330 380,360 C520,300 640,320 760,350 C900,300 1040,310 1160,350 C1300,310 1450,320 1600,340 L1600,420 L0,420 Z"/>
    ${lojaSkyline()}
    <rect y="418" width="1600" height="16" fill="#cfd6dd"/>
    <rect y="434" width="1600" height="140" fill="#e3e7eb"/>
    <g fill="#ffffff">${dashes}</g>
    <rect y="574" width="1600" height="66" fill="#cfd6dd"/>
    <polygon points="616,336 ${CONE[1]},590 ${CONE[0]},590" fill="url(#h-cone)"/>
    <line x1="${LINE_X}" x2="${LINE_X}" y1="430" y2="592" stroke="#16a37f" stroke-width="3" stroke-dasharray="10 8"/>
    <text x="${LINE_X}" y="612" text-anchor="middle" class="h-svg-note">línea de conteo</text>
    <rect x="552" y="318" width="9" height="104" rx="3" fill="#4b5563"/>
    <path d="M556,328 L598,328" stroke="#4b5563" stroke-width="6" stroke-linecap="round"/>
    <rect x="586" y="316" width="38" height="24" rx="6" fill="#1f2937"/><circle cx="619" cy="328" r="6" fill="#16a37f"/>
    <g class="h-end"><circle cx="46" cy="504" r="20"/><text x="46" y="511" text-anchor="middle">A</text></g>
    <g class="h-end"><circle cx="1554" cy="504" r="20"/><text x="1554" y="511" text-anchor="middle">B</text></g>`
}

// ---------------------------------------------------------------------------------------------------------------
// Escena con scroll

let actors = []
let counts = {}
let shownTitle = null
let raf = 0
let lastP = -1

function buildScene() {
  const svg = $('home-svg')
  svg.innerHTML = sceneSvg()
  actors = EVENTS.map((e) => {
    const shape = SHAPES[e.cls]
    const color = C[e.cls].color
    const g = document.createElementNS(SVGNS, 'g')
    g.innerHTML = shape.svg(color)
    const box = document.createElementNS(SVGNS, 'g')
    box.setAttribute('class', 'h-box')
    const bw = shape.w + 16
    const bh = shape.h + 16
    box.innerHTML = `<rect class="frame" x="${-bw / 2}" y="${-bh + 4}" width="${bw}" height="${bh}" rx="6"/>
      <g class="h-tag" transform="translate(${-bw / 2},${-bh - 22})"><rect width="${NAME[e.cls].length * 11 + 54}" height="24" rx="6"/>
      <text x="9" y="17">${NAME[e.cls].toUpperCase()} ${e.dir === 'ab' ? 'A→B' : 'B→A'}</text></g>
      <text class="h-plus" x="${bw / 2 - 4}" y="${-bh - 4}" text-anchor="end">+1</text>`
    svg.append(g, box)
    return { ...e, g, box, y: LANE[e.lane ?? e.dir], start: START + EVENTS.indexOf(e) * STEP }
  })
  $('home-hud').innerHTML = CLASSES.slice()
    .reverse()
    .map((c) => `<div class="h-chip" id="h-chip-${c.key}" style="--c:${c.color}">${icon(c.icon, 22)}<span>${PLURAL[c.key]}</span><b>0</b></div>`)
    .join('')
}

/** Posición de cada vehículo y estado de los contadores para un avance p (0..1) de la sección. */
function render(p) {
  if (p === lastP) return
  const forward = p > lastP
  lastP = p
  const next = Object.fromEntries(CLASSES.map((c) => [c.key, 0]))
  let focus = null
  for (const a of actors) {
    const f = (p - a.start) / TRAVEL
    const t = Math.min(1, Math.max(0, f))
    const x = a.dir === 'ab' ? FROM + (TO - FROM) * t : TO - (TO - FROM) * t
    const onStage = f > 0 && f < 1
    a.g.style.display = onStage ? '' : 'none'
    a.g.setAttribute('transform', `translate(${x},${a.y}) scale(${a.dir === 'ab' ? 1 : -1},1)`)
    const crossed = a.dir === 'ab' ? x >= LINE_X : x <= LINE_X
    if (f > 0 && crossed) next[a.cls]++
    const seen = onStage && x > CONE[0] && x < CONE[1]
    a.box.style.display = seen ? '' : 'none'
    a.box.setAttribute('transform', `translate(${x},${a.y})`)
    a.box.classList.toggle('done', crossed)
    if (seen && (!focus || Math.abs(x - LINE_X) < Math.abs(focus.x - LINE_X))) focus = { ...a, x }
  }
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
  const title = p < START + 0.03 ? null : focus ? `${focus.cls}|${focus.dir}` : shownTitle
  if (title !== shownTitle) {
    shownTitle = title
    const [cls, dir] = title ? title.split('|') : []
    $('home-intro').classList.toggle('off', !!title)
    $('home-now').classList.toggle('off', !title)
    if (title) $('home-now').innerHTML = `<span style="color:${C[cls].color}">${icon(C[cls].icon, 40)}</span>${NAME[cls]} <small>${dir === 'ab' ? 'A → B' : 'B → A'}</small>`
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

export async function showHome() {
  if (!built) {
    built = true
    buildScene()
    revealIo = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) e.target.classList.add('in')
    }, { threshold: 0.2 })
    document.querySelectorAll('#view-home .reveal').forEach((el) => revealIo.observe(el))
  }
  $('view-home').classList.toggle('still', reduced())
  lastP = -1
  if (reduced()) {
    render(0.17) // un auto recién contado
  } else {
    addEventListener('scroll', onScroll, { passive: true })
    addEventListener('resize', onScroll)
    render(progress())
  }
  loadTotals().catch(() => {})
}

export function leaveHome() {
  removeEventListener('scroll', onScroll)
  removeEventListener('resize', onScroll)
}
