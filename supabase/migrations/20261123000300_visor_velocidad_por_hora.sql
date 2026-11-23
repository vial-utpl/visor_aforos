-- Visor v2: limite de velocidad en la vista del mapa y velocidades por hora del dia (para la V85 por hora).

-- La vista se recrea igual que en aforos_init, con speed_limit_kmh al final (create or replace solo admite columnas
-- nuevas al final).
create or replace view public.site_overview with (security_invoker = true) as
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
  l.pending as live_pending,
  s.speed_limit_kmh
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

-- Vehiculos motorizados por hora del dia (hora local de la estacion, 0..23) y rango de 10 km/h, en un rango de fechas.
create function public.get_site_speeds_by_hour(p_site uuid, p_from timestamptz, p_to timestamptz)
returns table (hour integer, bin integer, vehicles bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    extract(hour from c.period_start at time zone coalesce(s.timezone, 'UTC'))::integer,
    (b.i - 1)::integer,
    sum(b.v)::bigint
  from public.counts_15min c
  join public.sites s on s.id = c.site_id
  cross join lateral unnest(c.speed_bins) with ordinality as b(v, i)
  where c.site_id = p_site and c.period_start >= p_from and c.period_start < p_to and c.speed_bins is not null
  group by 1, 2
  order by 1, 2;
$$;

revoke execute on function public.get_site_speeds_by_hour(uuid, timestamptz, timestamptz) from public;
-- anon: el visor es publico por ahora (ver acceso_publico); al reactivar el login, revocar tambien esta.
grant execute on function public.get_site_speeds_by_hour(uuid, timestamptz, timestamptz) to anon, authenticated;
