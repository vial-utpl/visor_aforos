-- Portada del visor: totales contados por clase, para el contador y las tarjetas "clase por clase".
--
-- Las estaciones de prueba del emulador (nombre con "(emulada)") no cuentan: la portada muestra solo conteos reales.
-- Lee counts_15min, que anon ya puede leer (acceso_publico), por eso no hace falta security definer.

create or replace function public.get_totals()
returns table (
  car bigint,
  truck bigint,
  bus bigint,
  motorcycle bigint,
  bicycle bigint,
  person bigint,
  sites bigint,
  since timestamptz
)
language sql
stable
set search_path = ''
as $$
  select
    coalesce(sum(c.car), 0)::bigint,
    coalesce(sum(c.truck), 0)::bigint,
    coalesce(sum(c.bus), 0)::bigint,
    coalesce(sum(c.motorcycle), 0)::bigint,
    coalesce(sum(c.bicycle), 0)::bigint,
    coalesce(sum(c.person), 0)::bigint,
    count(distinct c.site_id)::bigint,
    min(c.period_start)
  from public.counts_15min c
  join public.sites s on s.id = c.site_id
  where s.name not ilike '%(emulada)%';
$$;

comment on function public.get_totals() is 'Totales por clase de todas las estaciones reales (sin las emuladas), para la portada.';

revoke all on function public.get_totals() from public;
grant execute on function public.get_totals() to anon, authenticated;

-- Revertir:
--   drop function if exists public.get_totals();
