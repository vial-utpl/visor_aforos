// Administración: alta de estaciones con un asistente como el de Telraam (equipo → dirección → ubicación →
// preparación → vincular → listo) y la lista de estaciones con sus equipos. Solo usuarios en la tabla `admins`.
import { db, esc, ago, liveState } from './data.js'

const $ = (id) => document.getElementById(id)

export const KINDS = {
  v1: { name: 'V1', title: 'Raspberry Pi con cámara', text: 'Telraam V1 adaptado a esta plataforma. Necesita wifi y buena vista de la calle desde una ventana.', prefix: 'rpi' },
  s2: { name: 'S2', title: 'Jetson con FreeCount Traffic', text: 'Visión artificial en la GPU del Jetson, con cámara IP o USB. Cuenta varias clases, sentidos y velocidades.', prefix: 'jetson' },
  v3: { name: 'V3', title: 'App móvil o videos grabados', text: 'Próximamente: aforos desde el teléfono o desde videos ya grabados.', prefix: 'v3', soon: true },
}
const STEPS = ['Equipo', 'Dirección', 'Ubicación', 'Preparación', 'Vincular', 'Listo']

let map = null
let line = null
let markers = []
let poll = null
let w = null

function rpc(fn, args) {
  return db.rpc(fn, args).then(({ data, error }) => {
    if (error) throw new Error(error.message)
    return data
  })
}

export function leaveAdmin() {
  clearInterval(poll)
  poll = null
  if (map) {
    map.remove()
    map = null
  }
}

/** #/admin (lista), #/admin/nueva (asistente), #/admin/editar/<id> (asistente con la estación). */
export async function showAdmin(path, session) {
  leaveAdmin()
  const body = $('admin-body')
  if (!session) return // el router muestra el inicio de sesión
  const admin = await rpc('is_admin').catch(() => false)
  if (!admin) {
    body.innerHTML = `<div class="card admin-empty"><h2>Sin permiso de administración</h2>
      <p class="muted">La cuenta ${esc(session.user.email)} no es administradora. Pida acceso al responsable del visor.</p></div>`
    return
  }
  const edit = path.match(/^editar\/([0-9a-f-]{36})/)
  if (path === 'nueva' || edit) {
    w = newWizard()
    if (edit) {
      const s = (await rpc('admin_sites')).find((x) => x.id === edit[1])
      if (!s) return (location.hash = '#/admin')
      Object.assign(w, {
        id: s.id, kind: s.device_kind, name: s.name, description: s.description ?? '', address: s.address ?? '',
        city: s.city ?? '', country: s.country, labelA: s.label_a, labelB: s.label_b, limit: s.speed_limit_kmh ?? '',
        points: s.segment.coordinates.map(([lon, lat]) => [lat, lon]),
        deviceName: s.devices[0]?.name ?? '', step: 1, editing: true,
      })
    }
    renderWizard()
  } else {
    await renderList()
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Lista de estaciones

async function renderList() {
  const body = $('admin-body')
  body.innerHTML = '<p class="muted">Cargando…</p>'
  const sites = await rpc('admin_sites')
  body.innerHTML = `
    <div class="admin-head">
      <div><h1>Estaciones</h1><p class="muted">${sites.length} estaciones. Cree una nueva o genere un código para vincular un equipo.</p></div>
      <a class="btn primary" href="#/admin/nueva">+ Nueva estación</a>
    </div>
    <div class="admin-list">${sites.map(siteCard).join('') || '<p class="muted">Todavía no hay estaciones.</p>'}</div>`
  body.querySelectorAll('[data-code]').forEach((b) => b.addEventListener('click', () => newCode(b.dataset.code, b.dataset.device)))
  body.querySelectorAll('[data-active]').forEach((b) =>
    b.addEventListener('click', async () => {
      await rpc('admin_set_device_active', { p_device: b.dataset.active, p_active: b.dataset.to === '1' })
      renderList()
    }),
  )
  body.querySelectorAll('[data-delete]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!confirm('¿Borrar esta estación? No tiene equipos ni datos; no se puede deshacer.')) return
      await rpc('admin_delete_site', { p_site: b.dataset.delete }).catch((e) => alert(e.message))
      renderList()
    }),
  )
}

function siteCard(s) {
  const kind = KINDS[s.device_kind] ?? KINDS.s2
  const devices = s.devices
    .map((d) => {
      const st = d.active ? liveState(d.status, d.live_updated_at) : 'off'
      const label = !d.active ? 'desactivado' : st === 'ok' ? 'contando' : st === 'warn' ? 'reconectando' : `visto ${ago(d.last_seen)}`
      return `<li><span class="dot ${st}"></span><b>${esc(d.name)}</b> <span class="muted small">${label}${d.app_version ? ` · v${esc(d.app_version)}` : ''}</span>
        <span class="row-actions">
          <button class="link" data-code="${s.id}" data-device="${esc(d.name)}">Volver a vincular</button>
          <button class="link" data-active="${d.id}" data-to="${d.active ? 0 : 1}">${d.active ? 'Desactivar' : 'Activar'}</button>
        </span></li>`
    })
    .join('')
  const pending = s.pending_codes.map((c) => `<li class="muted small"><span>Código pendiente para <b>${esc(c.device_name)}</b>, vence ${new Date(c.expires_at).toLocaleString('es-EC', { hour12: false })}</span></li>`).join('')
  return `<article class="card admin-site">
    <div class="admin-site-head">
      <span class="kind-badge kind-${esc(s.device_kind)}">${kind.name}</span>
      <div><h3><a href="#/estacion/${s.id}">${esc(s.name)}</a></h3>
        <p class="muted small">${esc([s.address, s.city, s.country].filter(Boolean).join(', '))} · ${esc(s.label_a)} → ${esc(s.label_b)}${s.speed_limit_kmh ? ` · ${s.speed_limit_kmh} km/h` : ''}</p></div>
    </div>
    <ul class="device-list">${devices}${pending}${!devices && !pending ? '<li class="muted small">Sin equipo vinculado.</li>' : ''}</ul>
    <div class="admin-site-foot">
      <button class="ghost" data-code="${s.id}" data-device="">Generar código</button>
      <a class="btn ghost" href="#/admin/editar/${s.id}">Editar</a>
      ${s.devices.length ? '' : `<button class="ghost danger" data-delete="${s.id}">Borrar</button>`}
    </div>
    <div class="code-slot" id="code-${s.id}"></div>
  </article>`
}

async function newCode(siteId, device) {
  const sites = await rpc('admin_sites')
  const s = sites.find((x) => x.id === siteId)
  const name = device || prompt('Nombre del equipo (letras, números y guiones):', `${(KINDS[s.device_kind] ?? KINDS.s2).prefix}-${slug(s.name)}`)
  if (!name) return
  try {
    const [c] = await rpc('admin_new_pairing_code', { p_site: siteId, p_device_name: name.trim() })
    $(`code-${siteId}`).innerHTML = codeBox(c.code, c.expires_at, name.trim(), s.device_kind)
  } catch (e) {
    alert(e.message)
  }
}

function codeBox(code, expires, device, kind) {
  return `<div class="code-box">
    <div class="code">${esc(code)}</div>
    <p class="muted small">Para el equipo <b>${esc(device)}</b>. Vale una vez, hasta ${new Date(expires).toLocaleString('es-EC', { hour12: false })}.</p>
    ${pairHowto(kind)}
  </div>`
}

function pairHowto(kind) {
  if (kind === 'v1')
    return `<ol class="steps-list"><li>Conecte el teléfono a la red wifi de la Raspberry Pi y abra su página de configuración.</li>
      <li>Escriba el código en <b>Código de vinculación</b> y pulse <b>Vincular</b>.</li></ol>`
  return `<ol class="steps-list"><li>En el Jetson abra <b>FreeCount Traffic</b> → <b>Conectar una cámara</b>.</li>
    <li>En el panel <b>Visor de aforos</b> escriba el código en <b>Código de vinculación</b> y pulse <b>Vincular</b>.</li>
    <li>La app guarda sola la dirección y el token del equipo.</li></ol>`
}

// ---------------------------------------------------------------------------------------------------------------
// Asistente

function newWizard() {
  return { step: 0, id: null, kind: 's2', name: '', description: '', address: '', city: 'Loja', country: 'Ecuador', points: [], labelA: 'A', labelB: 'B', limit: 50, deviceName: '', code: null, expires: null }
}

const slug = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 30) || 'estacion'

function renderWizard() {
  if (map) {
    map.remove()
    map = null
  }
  const body = $('admin-body')
  body.innerHTML = `
    <div class="admin-head"><div><a href="#/admin" class="back-dark">← Estaciones</a><h1>${w.editing ? 'Editar estación' : 'Nueva estación'}</h1></div></div>
    <ol class="stepper">${STEPS.map((t, i) => `<li class="${i < w.step ? 'done' : i === w.step ? 'on' : ''}"><span>${i + 1}</span>${t}</li>`).join('')}</ol>
    <section class="card wizard" id="wizard"></section>`
  ;[stepKind, stepAddress, stepLocation, stepPrepare, stepPair, stepReady][w.step]($('wizard'))
}

function go(step) {
  w.step = step
  renderWizard()
  window.scrollTo({ top: 0 })
}

function nav(el, { back = true, next = 'Siguiente', ok = () => true } = {}) {
  const f = document.createElement('div')
  f.className = 'wizard-nav'
  f.innerHTML = `${back && w.step > 0 ? '<button class="ghost" data-back>‹ Atrás</button>' : '<span></span>'}
    <span class="msg" id="wizard-msg"></span>${next ? `<button class="primary" data-next>${next} ›</button>` : ''}`
  el.append(f)
  f.querySelector('[data-back]')?.addEventListener('click', () => go(w.step - 1))
  f.querySelector('[data-next]')?.addEventListener('click', async (e) => {
    e.target.disabled = true
    try {
      if (await ok()) go(w.step + 1)
    } catch (err) {
      $('wizard-msg').textContent = err.message
    }
    e.target.disabled = false
  })
}

function stepKind(el) {
  el.innerHTML = `<h2>¿Qué equipo tiene?</h2>
    <div class="kind-grid">${Object.entries(KINDS)
      .map(([k, d]) => `<button class="kind-card ${w.kind === k ? 'on' : ''}" data-kind="${k}" ${d.soon ? 'disabled' : ''}>
        <span class="kind-badge kind-${k}">${d.name}</span><b>${d.title}</b><span class="muted">${d.text}</span>
        ${d.soon ? '<span class="soon">Próximamente</span>' : ''}</button>`)
      .join('')}</div>`
  el.querySelectorAll('[data-kind]').forEach((b) =>
    b.addEventListener('click', () => {
      w.kind = b.dataset.kind
      go(1)
    }),
  )
}

function stepAddress(el) {
  el.innerHTML = `<h2>¿Dónde está la estación?</h2>
    <p class="muted">La dirección solo la ven los administradores; en el mapa público aparece el nombre de la estación.</p>
    <div class="form-grid">
      <label class="span2">Nombre de la estación (la vía) <input id="f-name" value="${esc(w.name)}" placeholder="Av. Universitaria" required></label>
      <label class="span2">Dirección o referencia <input id="f-address" value="${esc(w.address)}" placeholder="Av. Universitaria y Mercadillo, poste frente al parque"></label>
      <label>Ciudad <input id="f-city" value="${esc(w.city)}"></label>
      <label>País <input id="f-country" value="${esc(w.country)}"></label>
      <label class="span2">Descripción pública (opcional) <input id="f-desc" value="${esc(w.description)}" placeholder="Tramo entre ... y ..."></label>
    </div>`
  nav(el, {
    ok: () => {
      w.name = $('f-name').value.trim()
      w.address = $('f-address').value.trim()
      w.city = $('f-city').value.trim()
      w.country = $('f-country').value.trim() || 'Ecuador'
      w.description = $('f-desc').value.trim()
      if (!w.name) throw new Error('Escriba el nombre de la estación.')
      return true
    },
  })
}

function metres(points) {
  let m = 0
  for (let i = 1; i < points.length; i++) m += L.latLng(points[i - 1]).distanceTo(points[i])
  return m
}

function stepLocation(el) {
  el.innerHTML = `<h2>Ubique el tramo que cuenta</h2>
    <p class="muted">Haga clic sobre la vía: el primer punto es <b>A</b> y el último <b>B</b>. Agregue puntos intermedios si la vía curva.
      El sentido A → B del mapa es el que luego se elige en cada zona del equipo.</p>
    <div class="loc-tools">
      <input id="f-search" placeholder="Buscar dirección o lugar" value="${esc([w.address, w.city].filter(Boolean).join(', '))}">
      <button class="ghost" id="b-search">Buscar</button>
      <span class="grow"></span>
      <button class="ghost" id="b-undo">Deshacer punto</button>
      <button class="ghost" id="b-swap">Invertir A ↔ B</button>
      <button class="ghost" id="b-clear">Borrar</button>
    </div>
    <div id="wizard-map"></div>
    <p class="muted small" id="loc-info"></p>
    <div class="form-grid three">
      <label>Nombre del extremo A <input id="f-la" value="${esc(w.labelA)}" placeholder="Sur"></label>
      <label>Nombre del extremo B <input id="f-lb" value="${esc(w.labelB)}" placeholder="Norte"></label>
      <label>Límite de velocidad (km/h) <input id="f-limit" type="number" min="5" max="130" value="${esc(w.limit)}"></label>
    </div>`
  map = L.map('wizard-map', { zoomControl: true }).setView([-3.996, -79.204], 14)
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map)
  const draw = () => {
    line?.remove()
    markers.forEach((m) => m.remove())
    markers = []
    if (w.points.length) {
      line = L.polyline(w.points, { color: '#0f6fb0', weight: 6 }).addTo(map)
      const end = (p, t) => L.marker(p, { icon: L.divIcon({ className: 'end-label', html: t, iconSize: [22, 22] }), interactive: false }).addTo(map)
      markers.push(end(w.points[0], 'A'))
      if (w.points.length > 1) markers.push(end(w.points.at(-1), 'B'))
    }
    const m = metres(w.points)
    $('loc-info').textContent = w.points.length < 2 ? 'Faltan puntos: marque al menos A y B.' : `Tramo de ${Math.round(m)} m con ${w.points.length} puntos.`
  }
  map.on('click', (e) => {
    w.points.push([+e.latlng.lat.toFixed(7), +e.latlng.lng.toFixed(7)])
    draw()
  })
  $('b-undo').onclick = () => (w.points.pop(), draw())
  $('b-clear').onclick = () => ((w.points = []), draw())
  $('b-swap').onclick = () => {
    w.points.reverse()
    ;[w.labelA, w.labelB] = [$('f-lb').value, $('f-la').value]
    $('f-la').value = w.labelA
    $('f-lb').value = w.labelB
    draw()
  }
  const search = async () => {
    const q = $('f-search').value.trim()
    if (!q) return
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`).then((x) => x.json()).catch(() => [])
    if (r[0]) map.setView([+r[0].lat, +r[0].lon], 18)
    else $('loc-info').textContent = 'No se encontró ese lugar; acerque el mapa a mano.'
  }
  $('b-search').onclick = search
  $('f-search').addEventListener('keydown', (e) => e.key === 'Enter' && search())
  draw()
  if (w.points.length) map.fitBounds(L.latLngBounds(w.points), { padding: [40, 40], maxZoom: 18 })
  else if ($('f-search').value) search()
  nav(el, {
    next: w.editing ? 'Guardar cambios' : 'Siguiente',
    ok: async () => {
      w.labelA = $('f-la').value.trim() || 'A'
      w.labelB = $('f-lb').value.trim() || 'B'
      w.limit = $('f-limit').value ? Number($('f-limit').value) : ''
      if (w.points.length < 2) throw new Error('Marque al menos dos puntos (A y B).')
      const m = metres(w.points)
      if (m < 5 || m > 3000) throw new Error(`El tramo mide ${Math.round(m)} m: debe medir entre 5 m y 3 km.`)
      if (!w.editing) return true
      await saveSite()
      location.hash = '#/admin'
      return false
    },
  })
}

function stepPrepare(el) {
  const s2 = `<ol class="steps-list big">
      <li><b>Instale la app en el Jetson.</b> <code>bash desktop/packaging/linux/build-jetson.sh --install --prepare-gpu</code>
        (la primera vez TensorRT prepara los modelos, unos minutos).</li>
      <li><b>Ubique la cámara</b> con vista despejada del tramo, de preferencia alta y en diagonal a la vía, sin
        contraluz. Que se vean ambos carriles si va a contar los dos sentidos.</li>
      <li><b>Red y hora.</b> El Jetson necesita internet para enviar y para tener la hora correcta
        (<code>timedatectl</code> debe decir <i>synchronized: yes</i>). Sin red, los conteos esperan en el equipo.</li>
      <li><b>Abra FreeCount Traffic → Conectar una cámara</b>, dibuje las zonas o líneas de conteo y, en cada una,
        elija en <b>Visor</b> si suma a <b>${esc(w.labelA)} → ${esc(w.labelB)}</b> (A → B) o al revés.</li>
    </ol>`
  const v1 = `<ol class="steps-list big">
      <li><b>Elija la ventana:</b> primer piso o más alto, con vista despejada de la calle y sin cortinas ni reflejos.</li>
      <li><b>Prepare el material:</b> Raspberry Pi con cámara y su programa (Telraam V1 adaptado), fuente de poder y
        acceso al wifi.</li>
      <li><b>Instale y encienda:</b> fije la cámara al vidrio apuntando a la calle y conéctela a la corriente.</li>
      <li><b>Wifi:</b> desde el teléfono conéctese a la red del equipo y configure el wifi de la casa.</li>
    </ol>
    <p class="note">El programa de la V1 para esta plataforma está en preparación: el alta y el código ya funcionan igual que en S2.</p>`
  el.innerHTML = `<h2>Preparación ${KINDS[w.kind].name}</h2>${w.kind === 'v1' ? v1 : s2}`
  nav(el, { next: 'Listo, vincular' })
}

function stepPair(el) {
  if (!w.deviceName) w.deviceName = `${KINDS[w.kind].prefix}-${slug(w.name)}`
  el.innerHTML = `<h2>Vincular el equipo</h2>
    <p class="muted">Se guarda la estación y se genera un código de un solo uso (24 h) que se escribe en el equipo.</p>
    <div class="form-grid">
      <label>Nombre del equipo <input id="f-dev" value="${esc(w.deviceName)}" pattern="[A-Za-z0-9._-]{1,60}"></label>
    </div>
    <div id="pair-code">${w.code ? codeBox(w.code, w.expires, w.deviceName, w.kind) : ''}</div>`
  nav(el, {
    next: w.code ? 'Esperar al equipo' : w.id ? 'Guardar y generar código' : 'Crear estación y generar código',
    ok: async () => {
      if (w.code) return true
      w.deviceName = $('f-dev').value.trim()
      if (!/^[A-Za-z0-9._-]{1,60}$/.test(w.deviceName)) throw new Error('Nombre del equipo: solo letras, números, punto y guiones.')
      $('wizard-msg').textContent = 'Guardando…'
      await saveSite()
      const [c] = await rpc('admin_new_pairing_code', { p_site: w.id, p_device_name: w.deviceName })
      w.code = c.code
      w.expires = c.expires_at
      renderWizard()
      return false
    },
  })
}

async function saveSite() {
  w.id = await rpc('admin_save_site', {
    p_id: w.id, p_name: w.name, p_description: w.description, p_kind: w.kind, p_address: w.address, p_city: w.city,
    p_country: w.country, p_segment: { type: 'LineString', coordinates: w.points.map(([lat, lon]) => [lon, lat]) },
    p_label_a: w.labelA, p_label_b: w.labelB, p_speed_limit: w.limit === '' ? null : Number(w.limit),
  })
}

function stepReady(el) {
  el.innerHTML = `<h2>Esperando al equipo…</h2>
    <div class="ready-steps">
      <div id="r-pair" class="ready-row"><span class="dot"></span>Código canjeado por <b>${esc(w.deviceName)}</b></div>
      <div id="r-live" class="ready-row"><span class="dot"></span>Primer envío del equipo</div>
    </div>
    ${codeBox(w.code, w.expires, w.deviceName, w.kind)}
    <p class="muted small">Esta página se actualiza sola. Puede cerrarla: el código sigue valiendo hasta que venza.</p>
    <div class="wizard-nav"><a class="btn ghost" href="#/admin">Ir a estaciones</a><span></span><a class="btn primary" href="#/estacion/${w.id}">Ver la estación ›</a></div>`
  const check = async () => {
    const [s] = await rpc('admin_pairing_status', { p_site: w.id, p_device_name: w.deviceName }).catch(() => [])
    if (s?.paired_at) $('r-pair').querySelector('.dot').className = 'dot ok'
    if (s?.last_seen) {
      $('r-live').querySelector('.dot').className = 'dot ok'
      el.querySelector('h2').textContent = '¡Listo! El equipo está enviando'
      clearInterval(poll)
    }
  }
  check()
  poll = setInterval(check, 5000)
}
