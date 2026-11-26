// Escena de la portada: un aforo. Una sola cámara, fija en un poste junto a la vía, mira un tramo de calle en Loja;
// mientras se baja con el scroll pasan vehículos y peatones en los dos sentidos, la cámara marca con un recuadro a cada
// uno que entra en su zona de estudio y lo suma al cruzar la línea de conteo (que va por el medio de esa zona).
// El fondo no se mueve: cerros de Loja con el Villonaco y su parque eólico (las aspas giran), nubes que derivan y el
// skyline de la ciudad. Lo que se mueve con el scroll es función del avance p (0..1): subir y bajar es exactamente
// reversible. Las ruedas giran lo recorrido y la carrocería vibra.
import { CLASSES } from './data.js'

const SVGNS = 'http://www.w3.org/2000/svg'
const IMG = 'img/portada/'

// ───── Geometría (unidades de la escena, 1600 de ancho) ─────
const W = 1600
const GROUND = 470 // pie de los edificios
const WALK = 492 // vereda lejana, donde está el poste
const ROAD = [494, 650] // calzada
const LANE = { walk: 491, ba: 556, ab: 612, edge: 646 }
// lo que siempre tiene que verse: el poste, la zona de estudio y cielo para el título (en el celular manda el ancho)
const VISTA = { x0: 470, x1: 1210, y0: -40, y1: 760 }

// La cámara: en lo alto del poste, mira hacia abajo y hacia la derecha. Su zona de estudio es el tramo de calzada
// entre CONE[0] y CONE[1]; la línea de conteo va por el medio de esa zona, desde la cámara hacia el borde cercano de la
// vía (por eso es inclinada: cruza la calle en profundidad, de la vereda lejana a la cercana).
const POLE_X = 560
const CAM = { x: 604, y: WALK - 160 }
const CONE = [650, 1210]
const LINE_FOOT = (CONE[0] + CONE[1]) / 2 // donde la línea toca el borde cercano de la vía
const lineX = (y) => CAM.x + ((y - CAM.y) * (LINE_FOOT - CAM.x)) / (ROAD[1] - CAM.y)
const coneX = (y, side) => CAM.x + ((y - CAM.y) * (CONE[side] - CAM.x)) / (ROAD[1] - CAM.y)

// Fondo: cerros (img/portada/loja-montanas.webp, cielo transparente) con los aerogeneradores del Villonaco en su cresta
// [x, y del pie, alto] (los saca herramientas/montanas.py del dibujo), y el skyline de Loja (herramientas/skyline.py).
// (python herramientas/montanas.py imagenes/loja-montanas.png public/img/portada/loja-montanas.webp 450 58 170)
// El Villonaco queda detrás de la cámara: así se ve también en el celular.
const MOUNTAINS = { src: 'loja-montanas.webp', y: 58, h: 450, dx: 170 }
const TURBINES = [[459.7, 276.2, 28], [489.5, 269.9, 28], [519.4, 261.2, 28], [549.2, 250.1, 28], [578.4, 247.0, 28], [608.3, 243.2, 28],
  [638.1, 238.2, 28], [667.3, 243.8, 28], [697.1, 253.8, 28], [727.0, 263.1, 28], [756.8, 273.1, 28]]
const SKYLINE = { main: ['loja-skyline-1.webp', 2172, 274], side: ['loja-skyline-2.webp', 2172, 253] }

// ilustraciones de perfil mirando a la derecha (img/portada) y su escala en la escena
const K = 1.45
const BASE = {
  car: [120, 47], taxi: [120, 50], bus: [272, 101], truck: [240, 97], motorcycle: [62, 52], bicycle: [56, 58], person: [31, 52],
}
const SPRITES = Object.fromEntries(Object.entries(BASE).map(([k, [w, h]]) => [k, { w: w * K, h: h * K }]))

// Ruedas, en px de cada ilustración (iw × ih): centro x, y y radio. Autos, buses y camiones: recortes del mismo dibujo
// (img/portada/ruedas/<clase>-<n>.webp, radio c) que giran sobre la rueda quieta. Moto y bicicleta: el cuadro y el pie
// tapan las ruedas, así que el dibujo trae el interior liso (<clase>-cuerpo.webp) y encima giran rayos dibujados que
// una máscara deja ver solo dentro de la rueda.
const WHEELS = {
  car: { iw: 319, ih: 124, c: 19, w: [[70, 94, 26.4], [254, 93.5, 26.9]] },
  taxi: { iw: 404, ih: 170, c: 23, w: [[85, 134.5, 32.5], [322.5, 134.5, 32.8]] },
  bus: { iw: 501, ih: 186, c: 20, w: [[121.5, 154.5, 28.4], [368, 155, 27.9]] },
  truck: { iw: 463, ih: 187, c: 21, w: [[78.5, 151.5, 28.9], [148.5, 154.5, 28.9], [382, 154.5, 28.9]] },
  motorcycle: { iw: 226, ih: 189, spokes: { n: 6, from: 9, to: 25, width: 2.6, color: '#7f8890' }, w: [[44, 151.5, 34], [188, 151, 34.7]] },
  bicycle: { iw: 231, ih: 240, spokes: { n: 16, from: 6, to: 37, width: 1.1, color: '#6f7c86' }, w: [[47, 189, 47], [181, 189, 47]] },
}
// vibración de la carrocería: periodo (s) y amplitud; la persona y la bici se mecen con el paso o la pedalada
const VIBRA = { car: [0.3, 1.2], taxi: [0.3, 1.2], bus: [0.44, 1.5], truck: [0.48, 1.7], motorcycle: [0.17, 1.1] }

// Lo que pasa frente a la cámara, en orden. dir: ab = de izquierda a derecha. Cada uno entra a su turno y cruza la
// escena en TRAVEL del avance; el peatón recorre solo un tramo de la vereda, más despacio.
const EVENTS = [
  { cls: 'car', sprite: 'taxi', dir: 'ab' },
  { cls: 'motorcycle', dir: 'ba' },
  { cls: 'bus', dir: 'ab' },
  { cls: 'person', dir: 'ba', lane: 'walk', from: 1420, to: 300 },
  { cls: 'truck', dir: 'ba' },
  { cls: 'bicycle', dir: 'ab', lane: 'edge' },
  { cls: 'car', dir: 'ba' },
  { cls: 'motorcycle', dir: 'ab' },
]
const START = 0.04
const STEP = 0.107
const TRAVEL = 0.2
const ENTER = -320 // de dónde salen y adónde llegan (fuera de la vista)
const EXIT = W + 320

export const NAME = { car: 'Auto', taxi: 'Taxi', motorcycle: 'Moto', bus: 'Bus', truck: 'Camión', bicycle: 'Bicicleta', person: 'Peatón' }

// ───── Dibujo ─────

const band = (y, h, fill) => `<rect x="-3000" y="${y}" width="${W + 6000}" height="${h}" fill="${fill}"/>`

/** Nubes planas, repetidas cada 480; derivan solas (CSS) y vuelven a empezar sin salto. */
function cloudsSvg() {
  const cloud = 'M30 0a10 10 0 1 1 20 0a10 10 0 1 1-20 0ZM38-7a14 14 0 1 1 28 0a14 14 0 1 1-28 0ZM57-2a11 11 0 1 1 22 0a11 11 0 1 1-22 0ZM32 0h46v8h-46ZM216-30a14 14 0 1 1 28 0a14 14 0 1 1-28 0ZM227-40a20 20 0 1 1 39 0a20 20 0 1 1-39 0ZM254-33a15 15 0 1 1 31 0a15 15 0 1 1-31 0ZM219-30h64v11h-64ZM392 10a8 8 0 1 1 16 0a8 8 0 1 1-16 0ZM398 4a11 11 0 1 1 23 0a11 11 0 1 1-23 0ZM414 8a9 9 0 1 1 17 0a9 9 0 1 1-17 0ZM394 10h37v6h-37Z'
  let s = ''
  for (let x = -2400; x < W + 2880; x += 480) s += `<path d="${cloud}" transform="translate(${x},0)"/>`
  return `<g transform="translate(0,150)"><g class="h-clouds" fill="#ffffff">${s}</g></g>`
}

/** Aerogenerador del Villonaco: torre y góndola quietas, aspas que giran (cada uno a su ritmo). */
function turbineSvg([x, y, h], i) {
  const blade = `M0,0 C${h * 0.06},${-h * 0.12} ${h * 0.05},${-h * 0.4} 0,${-h * 0.58} C${-h * 0.03},${-h * 0.4} ${-h * 0.03},${-h * 0.12} 0,0Z`
  return `<g transform="translate(${x},${y})">
    <path d="M${-h * 0.035},0 L${h * 0.035},0 L${h * 0.016},${-h} L${-h * 0.016},${-h}Z" class="h-tw"/>
    <g transform="translate(0,${-h})"><g class="h-blades" style="--t:${(5.2 + (i % 3) * 0.9).toFixed(1)}s;--d:${(-i * 1.37).toFixed(2)}s">
      ${[0, 120, 240].map((a) => `<path d="${blade}" transform="rotate(${a + i * 17})" class="h-tw"/>`).join('')}
    </g><circle r="${(h * 0.05).toFixed(1)}" class="h-tw"/></g></g>`
}

/** Cerros, aerogeneradores y skyline: la tira principal (con la Puerta de la Ciudad) ocupa el ancho de la escena y la
 *  otra sigue a los costados para las pantallas más anchas. */
function backdropSvg() {
  const m = MOUNTAINS
  const mw = m.h * 3
  // a los costados, el mismo dibujo en espejo: así la línea de los cerros sigue sin cortes en pantallas anchas
  const mx = (W - mw) / 2 + m.dx
  const img = (t) => `<image href="${IMG}${m.src}" x="0" y="${m.y}" width="${mw}" height="${m.h}" transform="${t}"/>`
  // más claros que el skyline, para que los edificios se lean contra los cerros
  const mountains = `<g opacity="0.6">${img(`translate(${mx},0) scale(-1,1)`)}${img(`translate(${mx},0)`)}${img(`translate(${mx + 2 * mw},0) scale(-1,1)`)}</g>`
  const [src, pw, ph] = SKYLINE.main
  const s = W / pw
  const [src2, pw2, ph2] = SKYLINE.side
  const side = (x) => `<image href="${IMG}${src2}" x="${x}" y="${GROUND + 1 - ph2 * s}" width="${pw2 * s}" height="${ph2 * s}"/>`
  return `${mountains}${TURBINES.map(turbineSvg).join('')}
    ${side(-pw2 * s - 30)}<image href="${IMG}${src}" x="0" y="${GROUND + 1 - ph * s}" width="${W}" height="${ph * s}"/>${side(W + 30)}`
}

/** Calle, poste con la cámara, zona de estudio y línea de conteo. */
function streetSvg() {
  let dashes = ''
  for (let x = -3000; x < W + 3000; x += 80) dashes += `M${x} ${LANE.ab - 36}h40`
  const y0 = ROAD[0] + 2
  const y1 = ROAD[1]
  return `
    ${band(GROUND - 1, WALK - GROUND + 3, '#d9e0e8')}
    <path d="M-3000 ${GROUND}H${W + 3000}" stroke="#b9c3cf" stroke-width="1.5"/>
    ${band(ROAD[0], ROAD[1] - ROAD[0], '#e5e9ee')}
    <path d="${dashes}" stroke="#ffffff" stroke-width="5" stroke-linecap="round"/>
    <g class="h-station" id="h-station">
      <polygon class="h-cone" points="${CAM.x},${CAM.y} ${CONE[1]},${y1} ${CONE[0]},${y1}"/>
      <polygon class="h-zone" points="${coneX(y0, 0)},${y0} ${coneX(y0, 1)},${y0} ${CONE[1]},${y1} ${CONE[0]},${y1}"/>
      <line class="h-line" x1="${lineX(y0 - 14)}" y1="${y0 - 14}" x2="${LINE_FOOT}" y2="${y1}"/>
      <image href="${IMG}pole.webp" x="${POLE_X - 22}" y="${WALK + 4 - 175}" width="57" height="175"/>
    </g>`
}

/** Vereda de adelante con baldosas y rejillas. */
function frontSvg() {
  let tiles = ''
  for (let x = -3000; x < W + 3000; x += 44) tiles += `M${x} ${ROAD[1] + 14}V1400`
  for (let y = ROAD[1] + 14; y < 1400; y += 44) tiles += `M-3000 ${y}H${W + 3000}`
  let grates = ''
  for (let x = -2420; x < W + 3000; x += 968) // (ninguna debajo del rótulo de la línea) grates += `<rect x="${x}" y="${ROAD[1] + 22}" width="48" height="16" rx="3" fill="#e3e8f0" stroke="#c9d2de"/>`
  return `${band(ROAD[1], 1000, '#eef1f6')}${band(ROAD[1], 14, '#d9e0e8')}
    <path d="${tiles}" stroke="#dde3ec" stroke-width="1" fill="none"/>${grates}
    <text x="${LINE_FOOT}" y="${ROAD[1] + 40}" text-anchor="middle" class="h-svg-note">línea de conteo</text>`
}

/** Un vehículo o peatón: sombra y encima la carrocería con sus ruedas (en px de la ilustración, escalada). */
function actorSvg(key) {
  const sp = SPRITES[key]
  const wh = WHEELS[key]
  const shadow = `<ellipse class="h-shadow" cx="0" cy="-1" rx="${sp.w * 0.44}" ry="${Math.max(3, sp.h * 0.05)}"/>`
  if (!wh) return { html: `${shadow}<g class="h-bob"><image href="${IMG}${key}.webp" x="${-sp.w / 2}" y="${-sp.h}" width="${sp.w}" height="${sp.h}"/></g>` }
  const k = sp.w / wh.iw
  let body
  let wheels
  if (wh.spokes) {
    const s = wh.spokes
    const rays = Array.from({ length: s.n }, (_, i) => {
      const a = (i * 2 * Math.PI) / s.n
      return `M${(s.from * Math.cos(a)).toFixed(1)},${(s.from * Math.sin(a)).toFixed(1)}L${(s.to * Math.cos(a)).toFixed(1)},${(s.to * Math.sin(a)).toFixed(1)}`
    }).join('')
    body = `<image href="${IMG}ruedas/${key}-cuerpo.webp" width="${wh.iw}" height="${wh.ih}"/>`
    wheels = `<g mask="url(#h-mask-${key})">${wh.w.map(([x, y]) => `<g transform="translate(${x},${y})"><path class="spin" d="${rays}"
      stroke="${s.color}" stroke-width="${s.width}" stroke-linecap="round" fill="none"/></g>`).join('')}</g>`
  } else {
    body = `<image href="${IMG}${key}.webp" width="${wh.iw}" height="${wh.ih}"/>`
    wheels = wh.w.map(([x, y], i) => `<g transform="translate(${x},${y})"><image class="spin" href="${IMG}ruedas/${key}-${i}.webp"
      x="${-wh.c}" y="${-wh.c}" width="${2 * wh.c}" height="${2 * wh.c}"/></g>`).join('')
  }
  const [vib, amp] = VIBRA[key] ?? [0, 0]
  const style = vib ? ` style="--vib:${vib}s;--amp:${-amp}px"` : ''
  return {
    html: `${shadow}<g class="${vib ? 'h-veh' : 'h-bob'}"${style}><g transform="translate(${-sp.w / 2},${-sp.h}) scale(${k})">${body}${wheels}</g></g>`,
    radius: wh.w[0][2] * k,
  }
}

function masksSvg() {
  return Object.entries(WHEELS)
    .filter(([, wh]) => wh.spokes)
    .map(([key, wh]) => `<mask id="h-mask-${key}" maskUnits="userSpaceOnUse" x="0" y="0" width="${wh.iw}" height="${wh.ih}">
      <image href="${IMG}ruedas/${key}-mascara.png" width="${wh.iw}" height="${wh.ih}"/></mask>`)
    .join('')
}

// ───── Escena ─────

let svg
let actors = []
let station

export function buildScene(el) {
  svg = el
  svg.innerHTML = `<defs>
      <linearGradient id="h-cone-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#16a37f" stop-opacity=".03"/><stop offset="1" stop-color="#16a37f" stop-opacity=".16"/></linearGradient>
      ${masksSvg()}</defs>
    ${band(-2000, 2600, '#eef3f8')}
    ${cloudsSvg()}
    ${backdropSvg()}
    ${streetSvg()}
    <g id="h-actors"></g>
    ${frontSvg()}
    <g id="h-boxes"></g>`
  station = svg.querySelector('#h-station')
  const actorsG = svg.querySelector('#h-actors')
  const boxesG = svg.querySelector('#h-boxes')
  actors = EVENTS.map((e, i) => {
    const key = e.sprite ?? e.cls
    const sp = SPRITES[key]
    const y = LANE[e.lane ?? e.dir]
    const el = document.createElementNS(SVGNS, 'g')
    const { html, radius } = actorSvg(key)
    el.innerHTML = html
    const box = document.createElementNS(SVGNS, 'g')
    box.setAttribute('class', 'h-box')
    const bw = sp.w + 16
    const bh = sp.h + 14
    const label = `${NAME[key].toUpperCase()} ${e.dir === 'ab' ? 'A→B' : 'B→A'}`
    box.innerHTML = `<rect class="frame" x="${-bw / 2}" y="${-bh + 4}" width="${bw}" height="${bh}" rx="6"/>
      <g class="h-tag" transform="translate(${-bw / 2},${-bh - 22})"><rect width="${label.length * 9.4 + 18}" height="24" rx="6"/>
      <text x="9" y="17">${label}</text></g>
      <text class="h-plus" x="${bw / 2 - 4}" y="${-bh - 4}" text-anchor="end">+1</text>`
    boxesG.append(box)
    const from = e.from ?? (e.dir === 'ab' ? ENTER : EXIT)
    const to = e.to ?? (e.dir === 'ab' ? EXIT : ENTER)
    return {
      ...e, key, el, box, y, from, to, start: START + i * STEP, radius,
      line: lineX(y), zone: [coneX(y, 0), coneX(y, 1)],
      spin: [...el.querySelectorAll('.spin')], bob: el.querySelector('.h-bob'),
    }
  })
  // de atrás hacia adelante: la vereda lejana, el carril B→A, el A→B
  actors.slice().sort((a, b) => a.y - b.y).forEach((a) => actorsG.append(a.el))
}

/** El viewBox sigue la forma de la pantalla y siempre deja ver la cámara, su zona de estudio y cielo para el título. */
export function fitScene() {
  const r = svg.getBoundingClientRect()
  if (!r.width || !r.height) return
  const ar = r.width / r.height
  const vw = Math.max(VISTA.x1 - VISTA.x0, (VISTA.y1 - VISTA.y0) * ar)
  const vh = vw / ar
  const x = Math.min(Math.max((VISTA.x0 + VISTA.x1) / 2 - vw / 2, -vw / 2 + W / 2 - 1400), W / 2 - vw / 2 + 1400)
  svg.setAttribute('viewBox', `${x.toFixed(1)} ${(VISTA.y1 - vh).toFixed(1)} ${vw.toFixed(1)} ${vh.toFixed(1)}`)
  svg.setAttribute('preserveAspectRatio', 'xMidYMax meet')
}

/** Estado de la escena para un avance p: posición de cada uno, recuadros y conteo. Devuelve lo contado por clase y lo
 *  que la cámara mira (para el título). */
export function renderScene(p) {
  const counts = Object.fromEntries(CLASSES.map((c) => [c.key, 0]))
  let focus = null
  for (const a of actors) {
    const f = (p - a.start) / TRAVEL
    const t = Math.min(1, Math.max(0, f))
    const x = a.from + (a.to - a.from) * t
    const onStage = f > 0 && f < 1
    a.el.style.display = onStage ? '' : 'none'
    a.el.setAttribute('transform', `translate(${x.toFixed(1)},${a.y}) scale(${a.dir === 'ab' ? 1 : -1},1)`)
    const dist = Math.abs(x - a.from)
    if (onStage && a.radius) {
      const deg = ((dist / a.radius) * (180 / Math.PI)) % 360
      for (const s of a.spin) s.setAttribute('transform', `rotate(${deg.toFixed(1)})`)
    }
    if (onStage && a.bob) {
      const [stride, amp] = a.cls === 'person' ? [24, 2.4] : [60, 1.2]
      a.bob.setAttribute('transform', `translate(0,${(-amp * Math.abs(Math.sin((dist / stride) * Math.PI))).toFixed(2)})`)
    }
    // el peatón aparece y se va despacio en los extremos de su tramo
    if (a.cls === 'person') a.el.style.opacity = Math.min(1, f * 8, (1 - f) * 8).toFixed(2)
    const crossed = f > 0 && (a.dir === 'ab' ? x >= a.line : x <= a.line)
    if (crossed) counts[a.cls]++
    const seen = onStage && x > a.zone[0] && x < a.zone[1]
    a.box.style.display = seen ? '' : 'none'
    if (seen) {
      a.box.setAttribute('transform', `translate(${x.toFixed(1)},${a.y})`)
      a.box.classList.toggle('done', crossed)
      const dl = Math.abs(x - a.line)
      if (!focus || dl < focus.dl) focus = { key: a.key, cls: a.cls, dir: a.dir, dl }
    }
  }
  station.classList.toggle('on', !!focus)
  return { counts, focus }
}
