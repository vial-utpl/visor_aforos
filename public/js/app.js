// Arranque: sesión (solo usuarios invitados) y rutas por hash: #/ mapa, #/estacion/<id>.
import { db } from './data.js'
import { showMap, leaveMap } from './map.js'
import { showSite, leaveSite } from './station.js'

const $ = (id) => document.getElementById(id)
const views = ['view-login', 'view-map', 'view-site']

// Un enlace de invitación o de recuperación trae la sesión en la URL: después hay que fijar la contraseña.
const mustSetPassword = /type=(invite|recovery)/.test(location.hash + location.search)

export function toast(text, ms = 4000) {
  const t = $('toast')
  t.textContent = text
  t.hidden = false
  clearTimeout(toast.timer)
  toast.timer = setTimeout(() => (t.hidden = true), ms)
}

function show(view) {
  for (const v of views) $(v).hidden = v !== view
}

async function route() {
  const { data } = await db.auth.getSession()
  const session = data.session
  $('topnav').hidden = !session
  if (!session || mustSetPassword) {
    leaveMap()
    leaveSite()
    show('view-login')
    $('login-form').hidden = !!session
    $('password-form').hidden = !session
    return
  }
  $('user-email').textContent = session.user.email ?? ''
  const m = location.hash.match(/^#\/estacion\/([0-9a-f-]{36})/)
  if (m) {
    leaveMap()
    show('view-site')
    await showSite(m[1])
  } else {
    leaveSite()
    show('view-map')
    await showMap()
  }
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const f = new FormData(e.target)
  $('login-msg').textContent = 'Entrando…'
  const { error } = await db.auth.signInWithPassword({ email: f.get('email'), password: f.get('password') })
  $('login-msg').textContent = error ? 'Correo o contraseña incorrectos.' : ''
  if (!error) route()
})

$('forgot').addEventListener('click', async () => {
  const email = new FormData($('login-form')).get('email')
  if (!email) return ($('login-msg').textContent = 'Escriba su correo y vuelva a pulsar.')
  const { error } = await db.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname })
  $('login-msg').textContent = error ? 'No se pudo enviar el correo.' : 'Le enviamos un enlace para cambiar la contraseña.'
})

$('password-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const password = new FormData(e.target).get('password')
  const { error } = await db.auth.updateUser({ password })
  if (error) return ($('password-msg').textContent = error.message)
  history.replaceState(null, '', location.pathname + '#/')
  location.reload()
})

$('logout').addEventListener('click', async () => {
  await db.auth.signOut()
  location.hash = '#/'
  route()
})

window.addEventListener('hashchange', route)
db.auth.onAuthStateChange((event) => {
  if (event === 'SIGNED_OUT') route()
})
route().catch((e) => toast(`Error: ${e.message}`))
