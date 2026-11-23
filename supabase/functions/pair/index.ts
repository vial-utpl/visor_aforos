// Edge Function `pair`: un equipo canjea el codigo de vinculacion que genero el asistente del visor y recibe su token.
//
// POST /functions/v1/pair
//   body   { "code": "K7QM-4D2X", "app_version": "0.2.1" }
//   reply  { "ok": true, "token": "...", "device": "jetson-01", "kind": "s2",
//            "site": { "id": "...", "name": "Av. ...", "label_a": "Sur", "label_b": "Norte" } }
//
// El token solo viaja en esta respuesta: la base guarda su hash (devices.token_hash). Un codigo vale 24 h y una vez.

import { createClient } from 'npm:@supabase/supabase-js@2.119.2'

const url = Deno.env.get('SUPABASE_URL')!
const secretKeys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}') as Record<string, string>
const secret = secretKeys['default'] ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const db = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } })

const ALPHABET = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** 32 bytes aleatorios en base64url (43 caracteres), como secrets.token_urlsafe(32). */
function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json(405, { ok: false, error: 'use POST' })
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return json(400, { ok: false, error: 'body is not JSON' })
  }
  // con o sin guion y en minusculas; el alfabeto no tiene O, I, L, 0 ni 1 (no se confunden al copiarlo)
  const code = String(body.code ?? '').toUpperCase().replace(/[\s-]/g, '')
  if (!ALPHABET.test(code)) return json(400, { ok: false, error: 'invalid code: 8 letters and digits, like K7QM-4D2X' })

  const token = newToken()
  const appVersion = typeof body.app_version === 'string' ? body.app_version.slice(0, 40) : null
  const { data, error } = await db.rpc('claim_pairing_code', {
    p_code_hash: await sha256Hex(code),
    p_token_hash: await sha256Hex(token),
    p_app_version: appVersion,
  })
  if (error) return json(409, { ok: false, error: error.message })
  const row = Array.isArray(data) ? data[0] : null
  if (!row) return json(404, { ok: false, error: 'unknown, used or expired code: create a new one in the viewer' })

  return json(200, {
    ok: true,
    token,
    device: row.device_name,
    kind: row.kind,
    site: { id: row.site_id, name: row.site_name, label_a: row.label_a, label_b: row.label_b },
  })
})
