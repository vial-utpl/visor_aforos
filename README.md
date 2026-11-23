# Visor de Aforos

Visor web de los aforos vehiculares que cuentan los equipos **FreeCount Traffic** (NVIDIA Jetson) y base de datos en
**Supabase**. Inspirado en [Telraam](https://telraam.net): cada estación es un tramo de vía de **A a B** y los conteos
van por sentido (A → B, B → A), en totales de **15 minutos** por clase de vehículo.

```
Jetson (FreeCount) ──POST /functions/v1/ingest──▶ Supabase (Postgres + PostGIS) ◀── Visor (Vercel)
  cola en disco, reintenta       Edge Function: valida el token     tablas con RLS        Leaflet + Dygraphs
  al volver la conexión          del equipo e inserta               Realtime (en vivo)    login de invitados
```

## Contenido
| Carpeta | Qué es |
|---|---|
| `public/` | El visor: HTML + JavaScript sin compilación (Leaflet 1.9.4, Dygraphs 2.2.2, supabase-js 2.119.2). Vercel lo publica tal cual. |
| `supabase/migrations/` | Esquema: `sites`, `devices`, `device_live`, `counts_15min`, vistas y funciones del visor, RLS, Realtime; retención (archivo horario después de 13 meses). `supabase/tests/`: pruebas que terminan en rollback. |
| `supabase/functions/ingest/` | Edge Function que reciben los equipos. |
| `tools/emulator/` | Emulador de equipos para trabajar sin el Jetson. |

## Base de datos
- **`sites`**: estación, tramo `LINESTRING` de A a B (PostGIS), nombres de los extremos, zona horaria.
- **`devices`**: cada equipo, su estación y el **hash** (sha256) de su token. Los usuarios no la ven.
- **`device_live`**: una fila por equipo, sobrescrita cada ~2 min (estado, fps, conteos del periodo en curso). No crece.
- **`counts_15min`**: una fila por equipo, periodo y sentido: `minutes_measured` (0–15) y conteos de `car`, `truck`,
  `bus`, `motorcycle`, `bicycle`, `person`, más `speed_bins` (12 rangos de 10 km/h, vehículos motorizados).
  Con 15 equipos: ~2.900 filas/día, ~230 MB/año (medido: ~220–270 bytes por fila).
- **`counts_hourly_archive`** (migración `aforos_retencion`): una tarea diaria de `pg_cron` resume por hora los
  periodos de más de 13 meses y los borra de `counts_15min`; las consultas del visor leen ambas tablas. Así la base
  cabe en los 500 MB del plan gratuito (~250 MB de 15 min + ~60 MB/año de archivo con 15 equipos). Probarla antes con
  `supabase/tests/prueba_retencion.sql` (no cambia nada).

## Plan gratuito de Supabase
- **Invocaciones de Edge Functions: 500.000/mes.** Cada equipo hace una petición cada **2 min** (estado en vivo +
  periodos en cola): 15 equipos ≈ 324.000/mes. Con envíos cada 30 s solo alcanzaría para ~5 equipos.
- **Base de datos: 500 MB** (ver retención arriba). **Realtime: 2 millones de mensajes/mes** (solo las páginas de
  estación abiertas reciben cambios).
- **Pausa tras 1 semana sin actividad**: mientras algún equipo envíe datos el proyecto sigue activo; sin equipos,
  abrir el visor o el panel de Supabase al menos una vez por semana.
- Acceso: **RLS** en todas las tablas; escribe solo la Edge Function. **Por ahora el visor es público** (solo
  lectura, sin login: `REQUIRE_LOGIN = false` en `public/js/config.js` y migración `acceso_publico`). Para volver a
  exigir sesión: `REQUIRE_LOGIN = true` y aplicar el bloque "Revertir" de esa migración.
  El registro público está desactivado: los usuarios se **invitan** desde Supabase (Authentication → Users → Invite).

## Lo que envía un equipo
```http
POST https://<ref>.supabase.co/functions/v1/ingest
x-device-token: <token del equipo>
Content-Type: application/json

{
  "app_version": "0.2.1",
  "live": { "status": "running", "fps": 14.7, "period_start": "2026-11-23T08:15:00-05:00", "minutes_measured": 7,
            "counts": { "ab": { "car": 3, "motorcycle": 1 }, "ba": { "car": 2 } }, "pending": 0, "clock_synced": true },
  "periods": [
    { "period_start": "2026-11-23T08:00:00-05:00", "direction": "ab", "minutes_measured": 15,
      "car": 12, "truck": 1, "bus": 0, "motorcycle": 3, "bicycle": 0, "person": 2,
      "speed_bins": [0, 1, 3, 5, 2, 1, 0, 0, 0, 0, 0, 0] }
  ]
}
```
- `period_start` en un múltiplo de 15 minutos; `status`: `running`, `reconnecting`, `stopped` o `error`.
- Volver a enviar un periodo lo **reemplaza** (no duplica): el equipo guarda los periodos en disco mientras no hay
  conexión y los sube al volver.
- Respuesta: `{ "ok": true, "device": "...", "accepted": 2, "rejected": [ { "index": 3, "reason": "..." } ] }`.

## Puesta en marcha
1. **Base de datos** (proyecto `agfcwepbdkcojykvnqpj`): aplicar `supabase/migrations/*.sql` en orden y desplegar la
   función `ingest` con `verify_jwt = false` (ver `supabase/config.toml`).
2. **Equipos de prueba**: `python tools/emulator/emulate.py init --devices 3` crea los tokens en
   `tools/emulator/devices.local.json` (no se sube a git) y el SQL `seed_devices.local.sql` (solo hashes) para
   ejecutar en Supabase.
3. **Datos**: `python tools/emulator/emulate.py --url https://agfcwepbdkcojykvnqpj.supabase.co backfill --days 14`
   y luego `... live --offline-every 20 --offline-minutes 5` para simular el envío en vivo con cortes de red.
4. **Visor**: poner la clave *publishable* en `public/js/config.js`, invitar a los usuarios y publicar en Vercel
   (sin compilación; `vercel.json` publica `public/`). Para probar localmente: `python -m http.server -d public 8080`
   y en Supabase → Authentication → URL Configuration añadir `http://localhost:8080` y la URL de Vercel.

## Alta de estaciones desde el visor (administración)
Como el asistente de Telraam: **Administrar → Nueva estación** recorre *Equipo* (V1 Raspberry Pi, S2 Jetson, V3
próximamente) → *Dirección* → *Ubicación* (clic sobre la vía: A, puntos intermedios, B) → *Preparación* →
*Vincular* → *Listo*. Al vincular se guarda la estación y se genera un **código de un solo uso** (`XXXX-XXXX`, 24 h).
En la app del Jetson: panel **Visor de aforos** → **Código de vinculación** → **Vincular**; la Edge Function `pair`
canjea el código, crea el equipo (o le renueva el token) y devuelve el token, que solo se guarda en el equipo.
La pantalla *Listo* espera sola a que el equipo se vincule y envíe.

- Requiere la migración `alta_estaciones` y la función `pair` (`verify_jwt = false`).
- El mapa sigue público; `#/admin` pide sesión y solo deja pasar a usuarios de la tabla `admins`:
  1. Supabase → Authentication → URL Configuration: *Site URL* `https://visoraforos.vercel.app` (y en Redirect URLs
     también `http://localhost:8080`).
  2. Authentication → Users → *Invite user* con el correo del administrador; el enlace lleva a fijar la contraseña.
  3. `insert into public.admins (user_id) select id from auth.users where email = '<correo>';`
- La dirección y el tipo de equipo quedan en `site_setup`, que solo leen los administradores.

## Alta de un equipo real (sin el visor)
**Con el script** (recomendado): genera el token y deja el SQL y los ajustes del Jetson en `tools/altas/` (no se
suben a git). Los puntos van como `"lat,lon"`, el primero es A y el último B:
```bash
python tools/alta_equipo.py --nombre "Av. ..." --equipo jetson-01 --punto "-4.0123,-79.2011" --punto "-4.0110,-79.2005"     --a Sur --b Norte --limite 50 --descripcion "..."
```
Ejecutar `tools/altas/jetson-01.local.sql` en el SQL Editor y copiar `jetson-01.cloud.local.json` al Jetson como
`~/.config/FreeCountTraffic/cloud.json` (o pegar la dirección y el token en el panel **Visor de aforos** de la app).

**A mano:**
1. Crear la estación (tramo de A a B):
   ```sql
   insert into public.sites (name, description, segment, label_a, label_b)
   values ('Av. ...', '...', extensions.st_geogfromtext('SRID=4326;LINESTRING(lonA latA, lonB latB)'), 'Sur', 'Norte')
   returning id;
   ```
2. Generar un token largo y aleatorio (p. ej. `python -c "import secrets; print(secrets.token_urlsafe(32))"`), guardarlo
   en el equipo y registrar solo su hash:
   ```sql
   insert into public.devices (site_id, name, token_hash)
   values ('<id de la estación>', 'jetson-01', encode(extensions.digest('<token>', 'sha256'), 'hex'));
   ```
   Para retirar un equipo: `update public.devices set active = false where name = 'jetson-01';`
