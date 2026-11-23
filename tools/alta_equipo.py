"""Alta de una estacion real y su equipo (Jetson con FreeCount Traffic).

Genera un token nuevo para el equipo y deja dos archivos (no se suben a git):
  tools/altas/<equipo>.local.sql    -> ejecutar en Supabase (SQL Editor): crea la estacion y el equipo (solo el hash)
  tools/altas/<equipo>.cloud.local.json -> copiar al Jetson como ~/.config/FreeCountTraffic/cloud.json
                                         (o pegar la direccion y el token en el panel "Visor de aforos" de la app)

El tramo va de A a B: A es el primer punto y B el ultimo. Los puntos se dan como "lat,lon" (copiados de Google Maps
o de OpenStreetMap); con mas de dos puntos el tramo sigue la curva de la via.

Ejemplo:
  python tools/alta_equipo.py --nombre "Av. Pio Jaramillo" --equipo jetson-01 \
      --punto "-4.0123,-79.2011" --punto "-4.0110,-79.2005" --a Sur --b Norte --limite 50 \
      --descripcion "Frente al parque, camara en el poste norte"

Retirar un equipo: update public.devices set active = false where name = 'jetson-01';
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import secrets
import sys
from pathlib import Path

URL = 'https://agfcwepbdkcojykvnqpj.supabase.co'
OUT = Path(__file__).resolve().parent / 'altas'


def sql_text(v: str | None) -> str:
    return 'null' if v is None else "'" + v.replace("'", "''") + "'"


def punto(texto: str) -> tuple[float, float]:
    partes = [p for p in re.split(r'[,\s;]+', texto.strip()) if p]
    if len(partes) != 2:
        raise argparse.ArgumentTypeError(f'"{texto}": use "lat,lon"')
    lat, lon = float(partes[0]), float(partes[1])
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        raise argparse.ArgumentTypeError(f'"{texto}": fuera de rango (¿lat y lon al reves?)')
    return lat, lon


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--nombre', required=True, help='nombre de la estacion (la via)')
    ap.add_argument('--equipo', required=True, help='nombre del equipo, p. ej. jetson-01')
    ap.add_argument('--punto', type=punto, action='append', required=True, help='"lat,lon"; el primero es A y el ultimo B')
    ap.add_argument('--a', default='A', help='nombre del extremo A (p. ej. Sur)')
    ap.add_argument('--b', default='B', help='nombre del extremo B (p. ej. Norte)')
    ap.add_argument('--limite', type=int, help='limite de velocidad en km/h')
    ap.add_argument('--descripcion')
    ap.add_argument('--zona-horaria', default='America/Guayaquil')
    # "--punto -4.01,-79.20": argparse toma el valor negativo por una opcion; se une como "--punto=-4.01,-79.20"
    argv, i = [], 0
    while i < len(sys.argv) - 1:
        i += 1
        if sys.argv[i] == '--punto' and i + 1 < len(sys.argv):
            argv.append('--punto=' + sys.argv[i + 1])
            i += 1
        else:
            argv.append(sys.argv[i])
    a = ap.parse_args(argv)
    if len(a.punto) < 2:
        ap.error('hacen falta al menos dos --punto (A y B)')
    if not re.fullmatch(r'[A-Za-z0-9._-]{1,60}', a.equipo):
        ap.error('--equipo: solo letras, numeros, punto, guion y guion bajo')

    token = secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    linea = 'SRID=4326;LINESTRING(' + ', '.join(f'{lon:.7f} {lat:.7f}' for lat, lon in a.punto) + ')'

    sql = f"""-- Alta de la estacion {a.nombre!r} y del equipo {a.equipo!r} (generado por tools/alta_equipo.py).
-- Ejecutar una sola vez en Supabase -> SQL Editor. Solo contiene el hash del token, no el token.
with estacion as (
  insert into public.sites (name, description, segment, label_a, label_b, timezone, speed_limit_kmh)
  values ({sql_text(a.nombre)}, {sql_text(a.descripcion)}, extensions.st_geogfromtext({sql_text(linea)}),
          {sql_text(a.a)}, {sql_text(a.b)}, {sql_text(a.zona_horaria)}, {a.limite if a.limite else 'null'})
  returning id
)
insert into public.devices (site_id, name, token_hash)
select id, {sql_text(a.equipo)}, '{token_hash}' from estacion
returning site_id, id as device_id, name;
"""
    OUT.mkdir(exist_ok=True)
    sql_path = OUT / f'{a.equipo}.local.sql'
    cfg_path = OUT / f'{a.equipo}.cloud.local.json'
    if sql_path.exists() or cfg_path.exists():
        raise SystemExit(f'Ya existe un alta para {a.equipo} en {OUT}; borre esos archivos o use otro nombre.')
    sql_path.write_text(sql, encoding='utf-8')
    cfg_path.write_text(json.dumps({'enabled': True, 'url': URL, 'token': token}, indent=2) + '\n', encoding='utf-8')

    print(f'SQL para Supabase:      {sql_path}')
    print(f'Ajustes para el Jetson: {cfg_path}')
    print(f'  scp "{cfg_path}" <usuario>@<jetson>:~/.config/FreeCountTraffic/cloud.json')
    print(f'  (y en el Jetson: chmod 600 ~/.config/FreeCountTraffic/cloud.json)')
    print(f'Tramo: {a.a} (A) -> {a.b} (B), {len(a.punto)} puntos. En la app, cada zona suma a "A -> B" o "B -> A".')


if __name__ == '__main__':
    main()
