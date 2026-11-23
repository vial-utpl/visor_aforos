-- Aforos (FreeCount Traffic en NVIDIA Jetson): estaciones, equipos, totales cada 15 minutos y estado en vivo.
--
-- Modelo "Telraam": cada estacion es un tramo de via con extremos A y B; los conteos van por sentido (ab = A->B,
-- ba = B->A). Los equipos escriben solo a traves de la Edge Function `ingest` (clave secreta en el servidor); los
-- usuarios con sesion (invitados) solo leen.

create extension if not exists postgis with schema extensions;

-- ---------------------------------------------------------------------------------------------------------------
-- Tablas
-- ---------------------------------------------------------------------------------------------------------------

create table public.sites (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  -- tramo de A a B (lon/lat WGS84); su sentido define "ab"
  segment extensions.geography(LineString, 4326) not null,
  label_a text not null default 'A',
  label_b text not null default 'B',
  timezone text not null default 'America/Guayaquil',
  speed_limit_kmh smallint,
  created_at timestamptz not null default now()
);
comment on table public.sites is 'Estaciones de aforo: un tramo de via de A a B.';

create table public.devices (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites (id) on delete restrict,
  name text not null unique,
  -- sha256 (hex) del token del equipo; el token solo lo conoce el equipo
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  active boolean not null default true,
  app_version text,
  last_seen timestamptz,
  created_at timestamptz not null default now()
);
comment on table public.devices is 'Equipos (Jetson) que cuentan en una estacion. Sin acceso para usuarios: solo la Edge Function.';
create index devices_site_idx on public.devices (site_id);

-- Una fila por equipo, sobrescrita cada ~30 s: no crece.
create table public.device_live (
  device_id uuid primary key references public.devices (id) on delete cascade,
  site_id uuid not null references public.sites (id) on delete cascade,
  updated_at timestamptz not null default now(),
  -- running | reconnecting | stopped | error
  status text not null,
  fps real,
  -- periodo de 15 min en curso y sus conteos parciales: {"ab": {"car": 3, ...}, "ba": {...}}
  period_start timestamptz,
  minutes_measured smallint,
  counts jsonb not null default '{}'::jsonb,
  -- periodos cerrados que el equipo aun no pudo subir
  pending integer not null default 0,
  clock_synced boolean
);
create index device_live_site_idx on public.device_live (site_id);

-- Historico: una fila por equipo, periodo de 15 min y sentido. ~2 filas por periodo y estacion.
create table public.counts_15min (
  device_id uuid not null references public.devices (id) on delete cascade,
  site_id uuid not null references public.sites (id) on delete cascade,
  period_start timestamptz not null check (extract(epoch from period_start)::bigint % 900 = 0),
  direction text not null check (direction in ('ab', 'ba')),
  -- minutos del periodo en que el equipo estuvo contando (15 = completo); distingue "0 vehiculos" de "sin datos"
  minutes_measured smallint not null check (minutes_measured between 0 and 15),
  car smallint not null default 0 check (car >= 0),
  truck smallint not null default 0 check (truck >= 0),
  bus smallint not null default 0 check (bus >= 0),
  motorcycle smallint not null default 0 check (motorcycle >= 0),
  bicycle smallint not null default 0 check (bicycle >= 0),
  person smallint not null default 0 check (person >= 0),
  -- vehiculos motorizados por velocidad, 12 rangos de 10 km/h: [0-10, 10-20, ..., 100-110, 110+]
  speed_bins smallint[] check (speed_bins is null or cardinality(speed_bins) = 12),
  received_at timestamptz not null default now(),
  primary key (device_id, period_start, direction)
);
create index counts_15min_site_time_idx on public.counts_15min (site_id, period_start);

-- ---------------------------------------------------------------------------------------------------------------
-- Acceso: RLS en todo; los usuarios con sesion leen, nadie escribe salvo service_role (Edge Function)
-- ---------------------------------------------------------------------------------------------------------------

alter table public.sites enable row level security;
alter table public.devices enable row level security;
alter table public.device_live enable row level security;
alter table public.counts_15min enable row level security;

revoke all on public.sites, public.devices, public.device_live, public.counts_15min from anon, authenticated;
grant select on public.sites, public.device_live, public.counts_15min to authenticated;
grant all on public.sites, public.devices, public.device_live, public.counts_15min to service_role;

-- Todos los usuarios invitados ven todas las estaciones (el registro publico esta desactivado).
create policy "usuarios leen estaciones" on public.sites for select to authenticated using (true);
create policy "usuarios leen estado en vivo" on public.device_live for select to authenticated using (true);
create policy "usuarios leen conteos" on public.counts_15min for select to authenticated using (true);
-- devices: sin politicas para authenticated (contiene el hash del token)

-- ---------------------------------------------------------------------------------------------------------------
-- Consultas del visor
-- ---------------------------------------------------------------------------------------------------------------

-- Mapa: cada estacion con su tramo (GeoJSON), los vehiculos de la ultima hora y el estado del equipo.
create view public.site_overview with (security_invoker = true) as
select
  s.id,
  s.name,
  s.description,
  s.label_a,
  s.label_b,
  s.timezone,
  extensions.st_asgeojson(s.segment)::jsonb as segment,
  coalesce(h.vehicles, 0) as vehicles_last_hour,
  coalesce(h.ab, 0) as ab_last_hour,
  coalesce(h.ba, 0) as ba_last_hour,
  coalesce(h.minutes, 0) as minutes_last_hour,
  l.status as live_status,
  l.updated_at as live_updated_at,
  l.fps as live_fps,
  l.pending as live_pending
from public.sites s
left join lateral (
  select
    sum(c.car + c.truck + c.bus + c.motorcycle) as vehicles,
    sum(c.car + c.truck + c.bus + c.motorcycle) filter (where c.direction = 'ab') as ab,
    sum(c.car + c.truck + c.bus + c.motorcycle) filter (where c.direction = 'ba') as ba,
    max(c.minutes_measured) as minutes
  from public.counts_15min c
  where c.site_id = s.id and c.period_start >= now() - interval '1 hour'
) h on true
left join lateral (
  select dl.status, dl.updated_at, dl.fps, dl.pending
  from public.device_live dl
  where dl.site_id = s.id
  order by dl.updated_at desc
  limit 1
) l on true;

grant select on public.site_overview to authenticated;

-- Serie de una estacion agrupada en intervalos de p_bucket_minutes (15, 60, 1440...), alineados a la hora local
-- de la estacion. Maximo 93 dias por consulta.
create function public.get_site_series(p_site uuid, p_from timestamptz, p_to timestamptz, p_bucket_minutes integer default 15)
returns table (
  bucket_start timestamptz,
  direction text,
  minutes_measured bigint,
  car bigint,
  truck bigint,
  bus bigint,
  motorcycle bigint,
  bicycle bigint,
  person bigint
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_tz text;
begin
  if p_to <= p_from or p_to - p_from > interval '93 days' then
    raise exception 'rango invalido: maximo 93 dias';
  end if;
  if p_bucket_minutes < 15 or p_bucket_minutes % 15 <> 0 then
    raise exception 'el intervalo debe ser multiplo de 15 minutos';
  end if;
  select s.timezone into v_tz from public.sites s where s.id = p_site;
  return query
    select
      date_bin(make_interval(mins => p_bucket_minutes), c.period_start, (timestamp '2000-01-01 00:00' at time zone coalesce(v_tz, 'UTC'))) as b,
      c.direction,
      sum(c.minutes_measured)::bigint,
      sum(c.car)::bigint,
      sum(c.truck)::bigint,
      sum(c.bus)::bigint,
      sum(c.motorcycle)::bigint,
      sum(c.bicycle)::bigint,
      sum(c.person)::bigint
    from public.counts_15min c
    where c.site_id = p_site and c.period_start >= p_from and c.period_start < p_to
    group by 1, 2
    order by 1, 2;
end;
$$;

-- Histograma de velocidades (vehiculos motorizados) de una estacion en un rango: 12 rangos de 10 km/h.
create function public.get_site_speeds(p_site uuid, p_from timestamptz, p_to timestamptz)
returns table (bin integer, from_kmh integer, vehicles bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  select i - 1, (i - 1) * 10, coalesce(sum(c.speed_bins[i]), 0)::bigint
  from generate_series(1, 12) as i
  left join public.counts_15min c
    on c.site_id = p_site and c.period_start >= p_from and c.period_start < p_to and c.speed_bins is not null
  group by i
  order by i;
$$;

revoke execute on function public.get_site_series(uuid, timestamptz, timestamptz, integer) from public, anon;
revoke execute on function public.get_site_speeds(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.get_site_series(uuid, timestamptz, timestamptz, integer) to authenticated;
grant execute on function public.get_site_speeds(uuid, timestamptz, timestamptz) to authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- En vivo: el visor se suscribe a los cambios de device_live (15 filas como maximo)
-- ---------------------------------------------------------------------------------------------------------------

alter publication supabase_realtime add table public.device_live;
