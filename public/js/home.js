// Portada: una cámara en un poste cuenta lo que pasa por la calle mientras se baja con el scroll (cada vehículo recibe
// su recuadro, cruza la línea de conteo y suma en su clase), y después los totales reales de la base.
// La escena no usa librerías: la posición de cada vehículo sale del avance del scroll en una sección "sticky", así que
// subir y bajar es exactamente reversible. Con "reducir movimiento" la escena queda quieta.
import { CLASSES, db, siteOverview, liveState, fmt, esc } from './data.js'
import { icon } from './icons.js'

const $ = (id) => document.getElementById(id)
const SVGNS = 'http://www.w3.org/2000/svg'
const C = Object.fromEntries(CLASSES.map((c) => [c.key, c]))

// Escena (viewBox 1600 × 720): cielo arriba (ahí va el título), la silueta de Loja con su suelo en y = 524, la acera
// lejana, la vía con el carril B→A arriba y el A→B abajo, y la acera cercana. Línea de conteo en x = 900.
const W = 1600
const H = 720
const GROUND = 524
const LINE_X = 900
const CONE = [640, 1190] // tramo de la vía que ve la cámara
const LANE = { walk: GROUND + 14, ba: GROUND + 74, ab: GROUND + 144 }
const NAME = { car: 'Auto', taxi: 'Taxi', motorcycle: 'Moto', bus: 'Bus', truck: 'Camión', bicycle: 'Bicicleta', person: 'Peatón' }
const PLURAL = { car: 'Autos', motorcycle: 'Motos', bus: 'Buses', truck: 'Camiones', bicycle: 'Bicicletas', person: 'Peatones' }
const IMG = 'img/portada/'

// Ilustraciones de perfil mirando a la derecha (img/portada, generadas para el visor): ancho y alto en la escena.
const SPRITES = {
  car: { w: 120, h: 47 },
  taxi: { w: 120, h: 50 },
  bus: { w: 272, h: 101 },
  truck: { w: 240, h: 97 },
  motorcycle: { w: 62, h: 52 },
  bicycle: { w: 56, h: 58 },
  person: { w: 31, h: 52 },
}

// Lo que pasa frente a la cámara, en orden. dir: ab = de izquierda a derecha; sprite: el dibujo si no es el de la clase.
const EVENTS = [
  { cls: 'car', dir: 'ab' },
  { cls: 'motorcycle', dir: 'ba' },
  { cls: 'bus', dir: 'ab' },
  { cls: 'person', dir: 'ba', lane: 'walk' },
  { cls: 'truck', dir: 'ba' },
  { cls: 'bicycle', dir: 'ab' },
  { cls: 'car', sprite: 'taxi', dir: 'ba' },
  { cls: 'motorcycle', dir: 'ab' },
]
const START = 0.05
const STEP = 0.105
const TRAVEL = 0.2 // fracción del scroll que tarda cada uno en cruzar la escena
const FROM = -260
const TO = 1860

/** Fondo: cielo, la silueta de Loja (dos panorámicas unidas, con el parque eólico Villonaco en los cerros), aceras, vía,
 *  poste con la cámara, cono de visión y línea de conteo. */
function sceneSvg() {
  const far = 3200 // las bandas de la vía siguen más allá del viewBox
  const dashes = Array.from({ length: 90 }, (_, i) => `<rect x="${i * 72 - far}" y="${GROUND + 86}" width="40" height="5" rx="2"/>`).join('')
  const panH = (W / 3000) * 500 // panorama 3000 × 500, suelo a 446 px
  const panY = GROUND - (W / 3000) * 446
  const band = (y, h, fill) => `<rect x="${-far}" y="${y}" width="${W + 2 * far}" height="${h}" fill="${fill}"/>`
  return `
    <defs>
      <linearGradient id="h-cone" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#16a37f" stop-opacity=".05"/><stop offset="1" stop-color="#16a37f" stop-opacity=".22"/></linearGradient>
    </defs>
    ${band(-600, H + 1200, '#e6eff7')}
    <image href="${IMG}loja-panorama.webp" x="0" y="${panY}" width="${W}" height="${panH}" preserveAspectRatio="none"/>
    ${band(GROUND - 1, 17, '#cfd8e0')}
    ${band(GROUND + 16, 140, '#e1e6eb')}
    <g fill="#ffffff">${dashes}</g>
    ${band(GROUND + 156, 600, '#cfd8e0')}
    <polygon points="589,${GROUND - 156} ${CONE[1]},${GROUND + 160} ${CONE[0]},${GROUND + 160}" fill="url(#h-cone)"/>
    <line x1="${LINE_X}" x2="${LINE_X}" y1="${GROUND + 12}" y2="${GROUND + 160}" stroke="#16a37f" stroke-width="3" stroke-dasharray="10 8"/>
    <text x="${LINE_X}" y="${GROUND + 182}" text-anchor="middle" class="h-svg-note">línea de conteo</text>
    <image href="${IMG}pole.webp" x="538" y="${GROUND + 10 - 170}" width="55" height="170"/>
    <g class="h-end"><circle cx="46" cy="${GROUND + 86}" r="20"/><text x="46" y="${GROUND + 93}" text-anchor="middle">A</text></g>
    <g class="h-end"><circle cx="1554" cy="${GROUND + 86}" r="20"/><text x="1554" y="${GROUND + 93}" text-anchor="middle">B</text></g>`
}

/** La escena llena el espacio y se recorta a los lados (o arriba, en el cielo) según la forma de la pantalla. */
function fitScene() {
  $('home-svg').setAttribute('preserveAspectRatio', 'xMidYMax slice')
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
  actors = EVENTS.map((e, i) => {
    const sp = SPRITES[e.sprite ?? e.cls]
    const g = document.createElementNS(SVGNS, 'g')
    g.innerHTML = `<image href="${IMG}${e.sprite ?? e.cls}.webp" x="${-sp.w / 2}" y="${-sp.h}" width="${sp.w}" height="${sp.h}"/>`
    const box = document.createElementNS(SVGNS, 'g')
    box.setAttribute('class', 'h-box')
    const bw = sp.w + 16
    const bh = sp.h + 14
    const label = `${NAME[e.sprite ?? e.cls].toUpperCase()} ${e.dir === 'ab' ? 'A→B' : 'B→A'}`
    box.innerHTML = `<rect class="frame" x="${-bw / 2}" y="${-bh + 4}" width="${bw}" height="${bh}" rx="6"/>
      <g class="h-tag" transform="translate(${-bw / 2},${-bh - 22})"><rect width="${label.length * 9.4 + 18}" height="24" rx="6"/>
      <text x="9" y="17">${label}</text></g>
      <text class="h-plus" x="${bw / 2 - 4}" y="${-bh - 4}" text-anchor="end">+1</text>`
    svg.append(g, box)
    return { ...e, g, box, y: LANE[e.lane ?? e.dir], start: START + i * STEP }
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
  const title = p < START + 0.03 ? null : focus ? `${focus.sprite ?? focus.cls}|${focus.dir}` : shownTitle
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
  fitScene()
  addEventListener('resize', fitScene)
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
  removeEventListener('resize', fitScene)
  removeEventListener('scroll', onScroll)
  removeEventListener('resize', onScroll)
}
