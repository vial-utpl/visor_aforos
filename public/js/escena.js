// Escena de la portada: un taxi recorre Loja y pasa por estaciones de conteo. El taxi queda quieto en la pantalla y la
// ciudad pasa por detrás en capas, cada una a su velocidad (parallax): nubes, cerros con el parque eólico Villonaco,
// el skyline de Loja, la calle y la vereda de adelante. Cada estación (poste, cámara y línea de conteo) marca con un
// recuadro lo que ve y suma al cruzar su línea: el taxi y los que vienen o van por la vía.
// Todo es función del avance p (0..1) del scroll: subir y bajar es exactamente reversible. Las ruedas giran lo que
// corresponde a lo recorrido; la carrocería vibra, las aspas giran y las nubes derivan solas (CSS).
import { CLASSES } from './data.js'

const SVGNS = 'http://www.w3.org/2000/svg'
const IMG = 'img/portada/'

// ───── Geometría (unidades de la escena) ─────
const GROUND = 470 // pie de los edificios
const WALK = 492 // vereda lejana (detrás de la vía), donde están los postes
const ROAD = [494, 650] // calzada
const LANE = { walk: 491, ba: 556, ab: 612, edge: 646 }
const CAR_X = 430 // dónde queda el taxi en la pantalla
const D = 4600 // lo que recorre el taxi en todo el scroll
// lo que siempre tiene que verse: el taxi, la estación que se acerca y cielo para el título
// (en el celular manda el ancho: x0..x1 es lo mínimo; en pantallas anchas sobra a los costados)
const VISTA = { x0: 320, x1: 900, y0: -40, y1: 760 }
const SPEED = { clouds: 0.06, far: 0.18, city: 0.42, street: 1, front: 1.18 }

// estaciones: avance en que el taxi cruza cada línea de conteo; el poste va antes de la línea
const STATIONS = [0.16, 0.39, 0.62, 0.85]
const LINE_OFF = 170 // del poste a la línea
const CONE = [-40, 360] // tramo de la calzada que ve la cámara, desde el poste
const lineWorld = (i) => CAR_X + STATIONS[i] * D

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

// Lo que pasa. v: velocidad respecto del taxi (1 = como el taxi; negativa = viene de frente). at: [estación, avance en
// que cruza su línea]. own: el taxi.
const EVENTS = [
  { cls: 'car', sprite: 'taxi', dir: 'ab', v: 1, own: true },
  { cls: 'motorcycle', dir: 'ba', v: -0.9, at: [0, 0.12] },
  { cls: 'bus', dir: 'ba', v: -0.55, at: [1, 0.33] },
  { cls: 'person', dir: 'ba', v: -0.025, at: [1, 0.485], lane: 'walk' },
  { cls: 'bicycle', dir: 'ab', v: 0.35, at: [2, 0.5], lane: 'edge' }, // el taxi la pasa después de la estación
  { cls: 'truck', dir: 'ba', v: -0.65, at: [2, 0.665] },
  { cls: 'car', dir: 'ba', v: -1, at: [3, 0.8] },
  { cls: 'motorcycle', dir: 'ab', v: 1.35, at: [3, 0.885], lane: 'edge' },
]

// Skyline de Loja (herramientas/skyline.py: un tono, cielo transparente), una tira tras otra a lo largo del recorrido.
// Las dos miden 2172 px de ancho; s: unidades de la escena por px (las dos a la misma escala).
const CITY = { s: 0.84, gap: 40, strips: [['loja-skyline-1.webp', 2172, 274], ['loja-skyline-2.webp', 2172, 253]] }

export const NAME = { car: 'Auto', taxi: 'Taxi', motorcycle: 'Moto', bus: 'Bus', truck: 'Camión', bicycle: 'Bicicleta', person: 'Peatón' }

// ───── Dibujo ─────

const band = (y, h, fill) => `<rect x="-4000" y="${y}" width="12000" height="${h}" fill="${fill}"/>`

/** Cerros lejanos con el cordón del Villonaco y sus aerogeneradores (vectores: las aspas giran), y edificios lejanos
 *  muy claros, como en un contraluz. */
function farSvg() {
  const path = (f, x0, x1, base) => {
    let d = `M${x0},${base}`
    for (let x = x0; x <= x1; x += 20) d += `L${x},${f(x).toFixed(1)}`
    return `${d}L${x1},${base}Z`
  }
  const back = (x) => GROUND - 150 - 26 * Math.sin(x / 300 + 1.2) - 12 * Math.sin(x / 97)
  // el Villonaco: un lomo largo que se repite cada 2400 (las capas lejanas se mueven poco)
  const vill = (x) => {
    const m = ((x % 2400) + 2400) % 2400
    return GROUND - 118 - 58 * Math.exp(-(((m - 700) / 460) ** 2)) - 6 * Math.sin(x / 53)
  }
  const turbine = (x, i) => {
    const y = vill(x) + 2
    const h = 44 - Math.abs((((x % 2400) + 2400) % 2400) - 700) / 28
    const blade = `M0,0 C${h * 0.06},${-h * 0.12} ${h * 0.05},${-h * 0.4} 0,${-h * 0.58} C${-h * 0.03},${-h * 0.4} ${-h * 0.03},${-h * 0.12} 0,0Z`
    return `<g transform="translate(${x},${y.toFixed(1)})">
      <path d="M${-h * 0.035},0 L${h * 0.035},0 L${h * 0.016},${-h} L${-h * 0.016},${-h}Z" class="h-tw"/>
      <g transform="translate(0,${-h})"><g class="h-blades" style="--t:${(5.2 + (i % 3) * 0.9).toFixed(1)}s;--d:${(-i * 1.37).toFixed(2)}s">
        ${[0, 120, 240].map((a) => `<path d="${blade}" transform="rotate(${a + i * 17})" class="h-tw"/>`).join('')}
      </g><circle r="${(h * 0.045).toFixed(1)}" class="h-tw"/></g></g>`
  }
  const turbines = []
  for (let k = -1; k < 3; k++) for (let j = 0; j < 11; j++) turbines.push(k * 2400 + 430 + j * 54)
  // edificios lejanos: cajas y árboles redondos, como en el modelo, repetidos cada 480
  let blocks = ''
  for (let x0 = -2400; x0 < 4800; x0 += 480) {
    blocks += `<g transform="translate(${x0},${GROUND - 158})"><path d="M0 158V62H44V158ZM52 158V88H82V158ZM94 158V106h4V158ZM82 106a14 14 0 1 1 28 0a14 14 0 1 1-28 0ZM120 158V48H182V158ZM190 158V74H226V158ZM238 158V98h4V158ZM224 98a16 16 0 1 1 32 0a16 16 0 1 1-32 0ZM264 158V58H314V158ZM322 158V92H350V158ZM358 158V36H416V158ZM428 158V110h4V158ZM417 110a13 13 0 1 1 26 0a13 13 0 1 1-26 0ZM452 158V82H478V158Z"/></g>`
  }
  return `
    <path d="${path(back, -2400, 4800, GROUND)}" fill="#e8edf4"/>
    <path d="${path(vill, -2400, 4800, GROUND)}" fill="#e2e8f0"/>
    <g class="h-far-tw">${turbines.map(turbine).join('')}</g>
    <g fill="#e9eef5" transform="translate(0,${GROUND}) scale(1,0.62) translate(0,${-GROUND})">${blocks}</g>`
}

/** Nubes planas, repetidas cada 480. */
function cloudsSvg() {
  const cloud = 'M30 0a10 10 0 1 1 20 0a10 10 0 1 1-20 0ZM38-7a14 14 0 1 1 28 0a14 14 0 1 1-28 0ZM57-2a11 11 0 1 1 22 0a11 11 0 1 1-22 0ZM32 0h46v8h-46ZM216-30a14 14 0 1 1 28 0a14 14 0 1 1-28 0ZM227-40a20 20 0 1 1 39 0a20 20 0 1 1-39 0ZM254-33a15 15 0 1 1 31 0a15 15 0 1 1-31 0ZM219-30h64v11h-64ZM392 10a8 8 0 1 1 16 0a8 8 0 1 1-16 0ZM398 4a11 11 0 1 1 23 0a11 11 0 1 1-23 0ZM414 8a9 9 0 1 1 17 0a9 9 0 1 1-17 0ZM394 10h37v6h-37Z'
  let s = ''
  for (let x = -2400; x < 4800; x += 480) s += `<path d="${cloud}" transform="translate(${x},0)"/>`
  return `<g class="h-clouds" fill="#ffffff">${s}</g>`
}

/** Skyline de Loja: las tiras una tras otra (y vuelta a empezar) a lo largo de lo que recorre la capa. */
function citySvg() {
  let out = ''
  let i = 0
  for (let x = -1700; x < 1600 + D * SPEED.city + 1600; i++) {
    const [src, pw, ph] = CITY.strips[i % CITY.strips.length]
    const w = pw * CITY.s
    const h = ph * CITY.s
    out += `<image href="${IMG}${src}" x="${x.toFixed(1)}" y="${(GROUND + 1 - h).toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}"/>`
    x += w + CITY.gap
  }
  return out
}

/** Calle: líneas del centro y las estaciones de conteo (poste con cámara, cono de visión y línea de conteo). */
function streetSvg() {
  let dashes = ''
  for (let x = -1600; x < D + 3200; x += 80) dashes += `M${x} ${LANE.ab - 36}h40`
  const stations = STATIONS.map((_, i) => {
    const x = lineWorld(i) - LINE_OFF
    return `<g class="h-station" id="h-st-${i}" transform="translate(${x},0)">
      <polygon class="h-cone" points="44,${WALK - 160} ${CONE[1]},${ROAD[1]} ${CONE[0]},${ROAD[1]}"/>
      <line x1="${LINE_OFF}" x2="${LINE_OFF}" y1="${ROAD[0] + 4}" y2="${ROAD[1]}" class="h-line"/>
      <image href="${IMG}pole.webp" x="-20" y="${WALK + 4 - 175}" width="57" height="175"/>
    </g>`
  }).join('')
  return `<path d="${dashes}" stroke="#ffffff" stroke-width="5" stroke-linecap="round"/>${stations}`
}

/** Vereda de adelante: baldosas y algún árbol, más rápida que la calle. */
function frontSvg() {
  let tiles = ''
  for (let x = -2400; x < D * SPEED.front + 3200; x += 44) tiles += `M${x} ${ROAD[1] + 14}V1400`
  for (let y = ROAD[1] + 14; y < 1400; y += 44) tiles += `M-2400 ${y}H${D * SPEED.front + 3200}`
  let grates = ''
  for (let x = -2400; x < D * SPEED.front + 3200; x += 968) {
    grates += `<rect x="${x + 110}" y="${ROAD[1] + 22}" width="48" height="16" rx="3" fill="#e3e8f0" stroke="#c9d2de"/>`
  }
  return `${band(ROAD[1], 1000, '#eef1f6')}<rect x="-4000" y="${ROAD[1]}" width="12000" height="14" fill="#d9e0e8"/>
    <path d="${tiles}" stroke="#dde3ec" stroke-width="1" fill="none"/>${grates}`
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
let layers = {}
let actors = []
let stations = []

export function buildScene(el) {
  svg = el
  const g = (id, html) => `<g id="h-${id}">${html}</g>`
  svg.innerHTML = `<defs>
      <linearGradient id="h-cone-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#16a37f" stop-opacity=".04"/><stop offset="1" stop-color="#16a37f" stop-opacity=".24"/></linearGradient>
      ${masksSvg()}</defs>
    ${band(-2000, 2600, '#eef3f8')}
    <g transform="translate(0,150)">${g('clouds', cloudsSvg())}</g>
    ${g('far', farSvg())}
    ${g('city', citySvg())}
    ${band(GROUND - 1, WALK - GROUND + 3, '#d9e0e8')}
    <path d="M-4000 ${GROUND}H8000" stroke="#b9c3cf" stroke-width="1.5"/>
    ${band(ROAD[0], ROAD[1] - ROAD[0], '#e5e9ee')}
    ${g('street', streetSvg())}
    <g id="h-actors"></g>
    ${g('front', frontSvg())}
    <g id="h-boxes"></g>`
  layers = Object.fromEntries(['clouds', 'far', 'city', 'street', 'front'].map((k) => [k, svg.querySelector(`#h-${k}`)]))
  stations = STATIONS.map((_, i) => svg.querySelector(`#h-st-${i}`))
  const actorsG = svg.querySelector('#h-actors')
  const boxesG = svg.querySelector('#h-boxes')
  actors = EVENTS.map((e) => {
    const key = e.sprite ?? e.cls
    const sp = SPRITES[key]
    const lane = e.lane ?? e.dir
    const x0 = e.own ? CAR_X : lineWorld(e.at[0]) - e.v * e.at[1] * D
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
    return { ...e, key, el, box, x0, y: LANE[lane], radius, spin: [...el.querySelectorAll('.spin')], bob: el.querySelector('.h-bob') }
  })
  // de atrás hacia adelante: la vereda lejana, el carril B→A, el A→B
  actors.slice().sort((a, b) => a.y - b.y).forEach((a) => actorsG.append(a.el))
}

/** El viewBox sigue la forma de la pantalla y siempre deja ver el taxi, la estación que viene y cielo para el título. */
export function fitScene() {
  const r = svg.getBoundingClientRect()
  if (!r.width || !r.height) return
  const ar = r.width / r.height
  const vw = Math.max(VISTA.x1 - VISTA.x0, (VISTA.y1 - VISTA.y0) * ar)
  const vh = vw / ar
  const x = (VISTA.x0 + VISTA.x1) / 2 - vw / 2
  svg.setAttribute('viewBox', `${x.toFixed(1)} ${(VISTA.y1 - vh).toFixed(1)} ${vw.toFixed(1)} ${vh.toFixed(1)}`)
  svg.setAttribute('preserveAspectRatio', 'xMidYMax meet')
}

/** Estado de la escena para un avance p: capas, vehículos, recuadros y conteo. Devuelve lo contado por clase y lo que
 *  la cámara mira (para el título). */
export function renderScene(p) {
  const cam = p * D
  for (const [k, el] of Object.entries(layers)) el.setAttribute('transform', `translate(${(-cam * SPEED[k]).toFixed(1)},0)`)
  const counts = Object.fromEntries(CLASSES.map((c) => [c.key, 0]))
  const lines = STATIONS.map((_, i) => lineWorld(i))
  let focus = null
  const watching = new Set()
  for (const a of actors) {
    const wx = a.x0 + a.v * cam // posición en la calle
    const sx = wx - cam // en la pantalla
    const onStage = sx > -700 && sx < 2900
    a.el.style.display = onStage ? '' : 'none'
    a.el.setAttribute('transform', `translate(${sx.toFixed(1)},${a.y}) scale(${a.dir === 'ab' ? 1 : -1},1)`)
    const dist = Math.abs(a.v * cam)
    if (onStage && a.radius) {
      const deg = ((dist / a.radius) * (180 / Math.PI)) % 360
      for (const s of a.spin) s.setAttribute('transform', `rotate(${deg.toFixed(1)})`)
    }
    if (onStage && a.bob) {
      const [stride, amp] = a.cls === 'person' ? [9, 2.4] : [60, 1.2]
      a.bob.setAttribute('transform', `translate(0,${(-amp * Math.abs(Math.sin(((a.cls === 'person' ? p * D * 0.05 : dist) / stride) * Math.PI))).toFixed(2)})`)
    }
    // cada uno se cuenta en su estación (el taxi, en todas las que pasa): al cruzar su línea
    const mine = a.own ? lines.map((_, i) => i) : [a.at[0]]
    counts[a.cls] += mine.filter((i) => (a.dir === 'ab' ? wx >= lines[i] : wx <= lines[i])).length
    // ¿lo ve la cámara de su estación?
    let seen = -1
    for (const i of mine) {
      const pole = lines[i] - LINE_OFF
      if (wx > pole + CONE[0] && wx < pole + CONE[1]) seen = i
    }
    a.box.style.display = seen >= 0 && onStage ? '' : 'none'
    if (seen >= 0) {
      watching.add(seen)
      const crossed = a.dir === 'ab' ? wx >= lines[seen] : wx <= lines[seen]
      a.box.setAttribute('transform', `translate(${sx.toFixed(1)},${a.y})`)
      a.box.classList.toggle('done', crossed)
      const dl = Math.abs(wx - lines[seen])
      if (!focus || dl < focus.dl) focus = { key: a.key, cls: a.cls, dir: a.dir, dl }
    }
  }
  stations.forEach((st, i) => st.classList.toggle('on', watching.has(i)))
  return { counts, focus }
}
