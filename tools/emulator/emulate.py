#!/usr/bin/env python3
"""Emulador de equipos FreeCount Traffic (Jetson) para trabajar en la base de datos y el visor sin el equipo real.

Envia exactamente lo mismo que enviara la app: totales cada 15 minutos por sentido (A->B / B->A) y clase, rangos de
velocidad, y el estado en vivo cada 30 s, a la Edge Function `ingest`. Solo usa la biblioteca estandar de Python 3.8+.

  python emulate.py init [--devices 3]          crea estaciones y equipos de prueba: devices.local.json (tokens,
                                                 no subir a git) y seed_devices.local.sql (para ejecutar en Supabase)
  python emulate.py backfill --days 14          sube el historico de los ultimos N dias
  python emulate.py live [--offline-every 20 --offline-minutes 5]
                                                 cuenta "en vivo": estado cada 30 s y cada periodo al cerrarse;
                                                 simula cortes de red (guarda en cola y sube al reconectar)

La URL del proyecto va en --url o en la variable FCT_SUPABASE_URL (https://<ref>.supabase.co).
"""

import argparse
import datetime as dt
import hashlib
import json
import math
import os
import random
import secrets
import sys
import time
import urllib.error
import urllib.request
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
DEVICES_FILE = os.path.join(HERE, "devices.local.json")
SEED_FILE = os.path.join(HERE, "seed_devices.local.sql")
OUTBOX_FILE = os.path.join(HERE, "outbox.local.json")
APP_VERSION = "emulator-1"
PERIOD = dt.timedelta(minutes=15)
CLASSES = ["car", "truck", "bus", "motorcycle", "bicycle", "person"]
TZ = dt.timezone(dt.timedelta(hours=-5))  # America/Guayaquil (sin horario de verano)

# Estaciones de prueba en Loja: tramos de ~160 m de A a B (lon, lat) recortados de la geometria de OpenStreetMap,
# para que queden sobre la via. speed_limit: limite (maxspeed) de la via en OSM.
SITES = [
    {"name": "Av. Universitaria (emulada)", "peak": 520, "label_a": "Sur", "label_b": "Norte", "speed_limit": 50,
     "path": [(-79.205350, -3.994076), (-79.205403, -3.993393), (-79.205502, -3.992668), (-79.205504, -3.992638)]},
    {"name": "Av. Marcelino Champagnat - UTPL (emulada)", "peak": 380, "label_a": "Sur", "label_b": "Norte",
     "speed_limit": 30,
     "path": [(-79.200357, -3.989193), (-79.200255, -3.988977), (-79.200196, -3.988740), (-79.200166, -3.988594),
              (-79.200127, -3.988318), (-79.200093, -3.988085), (-79.200039, -3.987927), (-79.199941, -3.987815),
              (-79.199896, -3.987774)]},
    {"name": "Av. Orillas del Zamora (emulada)", "peak": 640, "label_a": "Sur", "label_b": "Norte", "speed_limit": 50,
     "path": [(-79.202943, -3.987932), (-79.202908, -3.987851), (-79.202657, -3.987265), (-79.202554, -3.986949),
              (-79.202474, -3.986689), (-79.202437, -3.986551), (-79.202422, -3.986489)]},
]

# Reparto por clase (vehiculos motorizados + bicicletas + personas)
MIX = {"car": 0.70, "motorcycle": 0.13, "truck": 0.06, "bus": 0.04, "bicycle": 0.02, "person": 0.05}

# Intensidad relativa por hora (0..23): laborable y fin de semana
WEEKDAY = [0.06, 0.04, 0.03, 0.03, 0.05, 0.15, 0.45, 0.95, 1.0, 0.75, 0.65, 0.7, 0.85, 0.9, 0.75, 0.7, 0.75, 0.9, 1.0,
           0.85, 0.6, 0.4, 0.25, 0.12]
WEEKEND = [0.10, 0.07, 0.05, 0.04, 0.04, 0.07, 0.15, 0.3, 0.45, 0.6, 0.7, 0.75, 0.8, 0.75, 0.7, 0.65, 0.65, 0.65, 0.6,
           0.5, 0.4, 0.3, 0.2, 0.14]


def poisson(lam):
    if lam <= 0:
        return 0
    if lam > 40:
        return max(0, int(round(random.gauss(lam, math.sqrt(lam)))))
    limit, k, p = math.exp(-lam), 0, 1.0
    while True:
        p *= random.random()
        if p <= limit:
            return k
        k += 1


def hourly_rate(peak, when):
    """Vehiculos por hora esperados en ese momento (ambos sentidos)."""
    local = when.astimezone(TZ)
    profile = WEEKEND if local.weekday() >= 5 else WEEKDAY
    h = local.hour + local.minute / 60.0
    a, b = profile[int(h) % 24], profile[(int(h) + 1) % 24]
    return peak * (a + (b - a) * (h - int(h)))


def split_ab(when):
    """Parte que va de A a B: mas por la manana, menos por la tarde (ida y vuelta)."""
    h = when.astimezone(TZ).hour
    return 0.62 if 6 <= h < 11 else 0.40 if 15 <= h < 20 else 0.5


def speed_bins(n_motor, mean=38.0, sd=10.0):
    bins = [0] * 12
    for _ in range(n_motor):
        v = max(2.0, random.gauss(mean, sd))
        bins[min(11, int(v // 10))] += 1
    return bins


def period_counts(peak, start, minutes=15, fraction=1.0):
    """Conteos de un periodo (o de la parte transcurrida, con `fraction`) por sentido."""
    rate = hourly_rate(peak, start + PERIOD / 2) * (minutes / 60.0) * fraction
    out = {}
    for d, share in (("ab", split_ab(start)), ("ba", 1 - split_ab(start))):
        c = {k: poisson(rate * share * MIX[k] * random.uniform(0.85, 1.15)) for k in CLASSES}
        out[d] = c
    return out


def period_rows(peak, start, minutes=15):
    counts = period_counts(peak, start, minutes)
    rows = []
    for d, c in counts.items():
        motor = c["car"] + c["truck"] + c["bus"] + c["motorcycle"]
        rows.append({"period_start": start.isoformat(), "direction": d, "minutes_measured": minutes, **c,
                     "speed_bins": speed_bins(motor)})
    return rows


def floor_period(t):
    return t.replace(minute=t.minute - t.minute % 15, second=0, microsecond=0)


def endpoint(args):
    url = (args.url or os.environ.get("FCT_SUPABASE_URL") or "").rstrip("/")
    if not url:
        sys.exit("falta --url o FCT_SUPABASE_URL (https://<ref>.supabase.co)")
    return url + "/functions/v1/ingest"


def post(url, token, body, timeout=30):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
                                 headers={"Content-Type": "application/json", "x-device-token": token,
                                          "User-Agent": "FreeCountTraffic-emulator"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, {"error": e.read().decode(errors="replace")[:300]}
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        return 0, {"error": str(e)}


def load_devices():
    if not os.path.exists(DEVICES_FILE):
        sys.exit("primero: python emulate.py init")
    with open(DEVICES_FILE, encoding="utf-8") as f:
        return json.load(f)


# ---------------------------------------------------------------------------------------------------------------

def cmd_init(args):
    if os.path.exists(DEVICES_FILE) and not args.force:
        sys.exit(f"ya existe {DEVICES_FILE} (use --force para crear otros equipos)")
    n = max(1, min(args.devices, len(SITES)))
    devices, sql = [], ["-- Estaciones y equipos del emulador. Generado por emulate.py init; contiene solo hashes.", "begin;"]
    for i, s in enumerate(SITES[:n]):
        site_id, token = str(uuid.uuid4()), secrets.token_urlsafe(32)
        name = f"emulador-{i + 1}"
        wkt = ", ".join(f"{x} {y}" for x, y in s["path"])
        sql.append(
            "insert into public.sites (id, name, description, segment, label_a, label_b, speed_limit_kmh) values "
            f"('{site_id}', '{s['name']}', 'Estacion de prueba del emulador', "
            f"extensions.st_geogfromtext('SRID=4326;LINESTRING({wkt})'), '{s['label_a']}', '{s['label_b']}', "
            f"{s['speed_limit']});")
        sql.append(
            "insert into public.devices (site_id, name, token_hash) values "
            f"('{site_id}', '{name}', '{hashlib.sha256(token.encode()).hexdigest()}');")
        devices.append({"name": name, "token": token, "site": s["name"], "peak": s["peak"]})
    sql.append("commit;")
    with open(DEVICES_FILE, "w", encoding="utf-8") as f:
        json.dump(devices, f, indent=2, ensure_ascii=False)
    with open(SEED_FILE, "w", encoding="utf-8") as f:
        f.write("\n".join(sql) + "\n")
    print(f"{n} equipos creados.\n  tokens: {DEVICES_FILE}\n  SQL para Supabase: {SEED_FILE}")


def send_periods(url, dev, rows, live=None, batch=800):
    sent = 0
    for i in range(0, max(1, len(rows)), batch):
        chunk = rows[i:i + batch]
        body = {"app_version": APP_VERSION, "periods": chunk, "live": live if i + batch >= len(rows) else None}
        status, reply = post(url, dev["token"], body)
        if status != 200:
            return sent, f"HTTP {status}: {reply.get('error')}"
        if reply.get("rejected"):
            print(f"  {dev['name']}: rechazados {reply['rejected'][:3]}")
        sent += len(chunk)
    return sent, None


def cmd_backfill(args):
    url, devices = endpoint(args), load_devices()
    end = floor_period(dt.datetime.now(dt.timezone.utc))
    start = end - dt.timedelta(days=args.days)
    for dev in devices:
        rows, t = [], start
        while t < end:
            # de vez en cuando, un hueco (camara apagada) o un periodo incompleto
            r = random.random()
            if r < 0.004:
                t += PERIOD * random.randint(4, 16)
                continue
            rows.extend(period_rows(dev["peak"], t, 15 if r > 0.01 else random.randint(3, 14)))
            t += PERIOD
        sent, err = send_periods(url, dev, rows)
        print(f"{dev['name']}: {sent} filas enviadas" + (f" (error: {err})" if err else ""))


def cmd_live(args):
    url, devices = endpoint(args), load_devices()
    outbox = {}
    if os.path.exists(OUTBOX_FILE):
        with open(OUTBOX_FILE, encoding="utf-8") as f:
            outbox = json.load(f)
    state = {d["name"]: {"period": floor_period(dt.datetime.now(dt.timezone.utc)), "counts": None} for d in devices}
    offline_until = 0.0
    next_offline = time.time() + args.offline_every * 60 if args.offline_every > 0 else float("inf")
    print("en vivo: Ctrl+C para terminar")
    try:
        while True:
            now = dt.datetime.now(dt.timezone.utc)
            if time.time() >= next_offline:
                offline_until = time.time() + args.offline_minutes * 60
                next_offline = offline_until + args.offline_every * 60
                print(f"{now.astimezone(TZ):%H:%M:%S} SIN CONEXION durante {args.offline_minutes} min (simulado)")
            online = time.time() >= offline_until
            for dev in devices:
                st, q = state[dev["name"]], outbox.setdefault(dev["name"], [])
                current = floor_period(now)
                if current > st["period"]:
                    # se cerro el periodo: a la cola
                    q.extend(period_rows(dev["peak"], st["period"]))
                    st["period"], st["counts"] = current, None
                elapsed = (now - current).total_seconds() / 60.0
                partial = period_counts(dev["peak"], current, 15, fraction=elapsed / 15.0)
                live = {"status": "running", "fps": round(random.uniform(14.2, 15.0), 1),
                        "period_start": current.isoformat(), "minutes_measured": int(elapsed),
                        "counts": partial, "pending": len(q) // 2, "clock_synced": True}
                if not online:
                    continue
                sent, err = send_periods(url, dev, q, live=live)
                if err:
                    print(f"{now.astimezone(TZ):%H:%M:%S} {dev['name']}: {err}; {len(q)} filas en cola")
                    continue
                if q:
                    print(f"{now.astimezone(TZ):%H:%M:%S} {dev['name']}: subidas {sent} filas de la cola")
                q.clear()
            with open(OUTBOX_FILE, "w", encoding="utf-8") as f:
                json.dump(outbox, f)
            time.sleep(args.interval)
    except KeyboardInterrupt:
        print("fin")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--url", help="https://<ref>.supabase.co (o FCT_SUPABASE_URL)")
    sub = p.add_subparsers(dest="cmd", required=True)
    i = sub.add_parser("init")
    i.add_argument("--devices", type=int, default=3)
    i.add_argument("--force", action="store_true")
    b = sub.add_parser("backfill")
    b.add_argument("--days", type=int, default=14)
    l = sub.add_parser("live")
    l.add_argument("--interval", type=int, default=30, help="segundos entre envios")
    l.add_argument("--offline-every", type=float, default=0, help="minutos entre cortes simulados (0 = sin cortes)")
    l.add_argument("--offline-minutes", type=float, default=5)
    args = p.parse_args()
    {"init": cmd_init, "backfill": cmd_backfill, "live": cmd_live}[args.cmd](args)


if __name__ == "__main__":
    main()
