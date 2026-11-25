// Silueta de Loja para el fondo de la portada, dibujada a línea fina: casas de teja, la Catedral, la torre del reloj de
// la plaza de la Independencia (San Sebastián) y la Puerta de la Ciudad. Cada pieza se dibuja con su base en y = 0 y se
// coloca con translate; todo usa las clases .sk-* (relleno claro y trazo gris azulado) definidas en app.css.

/** Almenas sobre un muro: dientes de `w` de ancho entre x1 y x2, con la base en y. */
function merlons(x1, x2, y, w = 9, h = 9) {
  let d = ''
  for (let x = x1; x + w <= x2 + 0.1; x += w * 2) d += `M${x},${y} v${-h} h${w} v${h} `
  return `<path class="sk" d="${d}"/>`
}

const arch = (x, w, h) => `M${x - w / 2},0 V${-(h - w / 2)} A${w / 2},${w / 2} 0 0 1 ${x + w / 2},${-(h - w / 2)} V0`
const win = (x, y, w = 9, h = 13) => `<rect class="sk-w" x="${x}" y="${y}" width="${w}" height="${h}" rx="1"/>`

/** Puerta de la Ciudad: arco entre dos torres redondas almenadas, alas a los lados y torre del reloj con aguja. */
function puerta() {
  return `
    <rect class="sk" x="-170" y="-58" width="74" height="58"/>${merlons(-170, -96, -58)}
    <rect class="sk" x="96" y="-58" width="74" height="58"/>${merlons(96, 170, -58)}
    <rect class="sk" x="-182" y="-80" width="22" height="80" rx="3"/>${merlons(-185, -157, -80, 6, 7)}
    <rect class="sk" x="160" y="-80" width="22" height="80" rx="3"/>${merlons(157, 185, -80, 6, 7)}
    <rect class="sk" x="-58" y="-104" width="116" height="104"/>
    <path class="sk-w" d="${arch(0, 64, 82)}"/>
    <path class="sk-l" d="M-40,-86 A44,44 0 0 1 40,-86"/>
    <path class="sk" d="M-64,-104 L-52,-118 L52,-118 L64,-104 Z"/>
    <rect class="sk" x="-98" y="-124" width="42" height="124" rx="4"/>${merlons(-102, -52, -124, 7, 9)}
    <rect class="sk" x="56" y="-124" width="42" height="124" rx="4"/>${merlons(52, 102, -124, 7, 9)}
    ${win(-82, -96, 8, 14)}${win(72, -96, 8, 14)}
    <path class="sk-l" d="M-98,-30 h42 M56,-30 h42"/>
    <rect class="sk" x="-24" y="-206" width="48" height="88"/>
    <rect class="sk" x="-29" y="-212" width="58" height="8" rx="2"/>
    <circle class="sk-w" cx="0" cy="-160" r="13"/><path class="sk-l" d="M0,-160 v-8 M0,-160 l6,3"/>
    <path class="sk-w" d="${arch(0, 14, 24)}" transform="translate(0,-178)"/>
    <path class="sk" d="M-22,-212 L0,-266 L22,-212 Z"/>
    <path class="sk" d="M-29,-212 l4,-16 l4,16 M21,-212 l4,-16 l4,16"/>
    <path class="sk-l" d="M0,-266 v-10 M-4,-272 h8"/>`
}

/** Catedral: fachada con rosetón y puertas en arco, torre central del reloj con aguja y pináculos. */
function catedral() {
  return `
    <rect class="sk" x="-96" y="-112" width="192" height="112"/>
    <path class="sk" d="M-96,-112 L-70,-134 L70,-134 L96,-112 Z"/>
    <path class="sk-w" d="${arch(0, 34, 54)}"/>
    <path class="sk-w" d="${arch(-58, 22, 40)}"/><path class="sk-w" d="${arch(58, 22, 40)}"/>
    <circle class="sk-w" cx="0" cy="-84" r="14"/><circle class="sk-l" cx="0" cy="-84" r="6"/>
    ${win(-63, -96, 10, 22)}${win(53, -96, 10, 22)}
    <path class="sk-l" d="M-96,-62 h192"/>
    <path class="sk" d="M-100,-112 l6,-36 l6,36 M88,-112 l6,-36 l6,36"/>
    <rect class="sk" x="-26" y="-210" width="52" height="78"/>
    <rect class="sk" x="-31" y="-216" width="62" height="8" rx="2"/>
    <circle class="sk-w" cx="0" cy="-160" r="12"/><path class="sk-l" d="M0,-160 v-7 M0,-160 l5,3"/>
    <path class="sk-w" d="${arch(-10, 10, 22)}" transform="translate(0,-186)"/>
    <path class="sk-w" d="${arch(10, 10, 22)}" transform="translate(0,-186)"/>
    <path class="sk" d="M-24,-216 L0,-268 L24,-216 Z"/>
    <path class="sk" d="M-31,-216 l4,-18 l4,18 M23,-216 l4,-18 l4,18"/>
    <path class="sk-l" d="M0,-268 v-14 M-6,-276 h12"/>`
}

/** Torre del reloj de la plaza de la Independencia: alta y delgada, con el reloj arriba. */
function torreReloj() {
  return `
    <rect class="sk" x="-22" y="-34" width="44" height="34"/>
    <rect class="sk" x="-26" y="-40" width="52" height="8" rx="2"/>
    <path class="sk" d="M-14,-40 L-11,-236 L11,-236 L14,-40 Z"/>
    <path class="sk-l" d="M-12,-120 h24 M-11.5,-180 h23"/>
    <rect class="sk" x="-15" y="-266" width="30" height="32" rx="2"/>
    <circle class="sk-w" cx="0" cy="-250" r="9"/><path class="sk-l" d="M0,-250 v-6 M0,-250 l4,2"/>
    <path class="sk" d="M-18,-266 L0,-284 L18,-266 Z"/>
    <path class="sk-l" d="M0,-284 v-9"/>`
}

/** Casa de teja de una o dos plantas, con ventanas y, a veces, balcón. */
function casa(w, h, seed) {
  const floors = h > 60 ? 2 : 1
  let wins = ''
  const n = Math.max(2, Math.floor(w / 30))
  for (let f = 0; f < floors; f++) {
    for (let i = 0; i < n; i++) {
      const x = -w / 2 + (w / n) * (i + 0.5) - 5
      const y = -h + 12 + f * 34
      if (f === floors - 1 && i === Math.floor(n / 2)) continue // puerta
      wins += win(x, y, 10, 16)
    }
  }
  const door = `<path class="sk-w" d="${arch(-w / 2 + (w / n) * (Math.floor(n / 2) + 0.5), 14, 26)}"/>`
  const balcony = floors === 2 && seed % 2 ? `<path class="sk-l" d="M${-w / 2 + 6},${-h + 32} h${w - 12} M${-w / 2 + 6},${-h + 40} h${w - 12}"/>` : ''
  return `
    <rect class="sk ${seed % 3 === 0 ? 'sk-alt' : ''}" x="${-w / 2}" y="${-h}" width="${w}" height="${h}"/>
    <path class="sk-roof" d="M${-w / 2 - 8},${-h} L${-w / 2 + 10},${-h - 18} L${w / 2 - 10},${-h - 18} L${w / 2 + 8},${-h} Z"/>
    ${wins}${door}${balcony}`
}

/** Toda la silueta, con el suelo en y = 420 del viewBox de la escena (1600 de ancho). */
export function lojaSkyline() {
  const g = (x, body, s = 1) => `<g transform="translate(${x},420) scale(${s})">${body}</g>`
  const houses = [
    [40, 110, 56], [150, 96, 72], [400, 120, 52], [500, 90, 74], [640, 110, 58], [880, 100, 70], [985, 120, 54],
    [1090, 96, 76], [1500, 110, 60], [1580, 90, 72],
  ]
  return `<g class="skyline">
    ${houses.map(([x, w, h], i) => g(x, casa(w, h, i))).join('')}
    ${g(270, catedral(), 0.95)}
    ${g(760, torreReloj(), 0.92)}
    ${g(1290, puerta(), 0.98)}
  </g>`
}
