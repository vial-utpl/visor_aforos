-- Prueba de la migracion 20261123000400_aforos_retencion.sql SIN cambiar nada: todo ocurre dentro de una transaccion
-- que termina en ROLLBACK. Ejecutar completo en el SQL Editor de Supabase ANTES de aplicar la migracion.
--
-- Copia el ultimo dia de la estacion "Av. Universitaria (emulada)" a hace 400 dias, ejecuta el archivado y compara
-- lo que devuelve el visor antes y despues. Resultado esperado (una fila):
--   antes = despues, sp_antes = sp_despues, sph_antes = sph_despues   (los totales no cambian)
--   filas60_antes = filas60_despues                                    (por hora, mismas filas)
--   archivadas > 0, archivo > 0, cron = 1, rec_antes = rec_despues     (lo reciente no se toca)
-- El editor muestra un ERROR a proposito: "PRUEBA OK: {...}" o "PRUEBA FALLA: {...}". Ese error deshace todo.
begin;

create extension if not exists pg_cron;

-- ---------------------------------------------------------------------------------------------------------------
-- Archivo por hora
-- ---------------------------------------------------------------------------------------------------------------

create table public.counts_hourly_archive (
  device_id uuid not null references public.devices (id) on delete cascade,
  site_id uuid not null references public.sites (id) on delete cascade,
  hour_start timestamptz not null,
  direction text not null check (direction in ('ab', 'ba')),
  minutes_measured smallint not null check (minutes_measured between 0 and 60),
  car integer not null,
  truck integer not null,
  bus integer not null,
  motorcycle integer not null,
  bicycle integer not null,
  person integer not null,
  speed_bins integer[] check (speed_bins is null or cardinality(speed_bins) = 12),
  primary key (device_id, hour_start, direction)
);
comment on table public.counts_hourly_archive is 'Totales por hora de los periodos de 15 min con mas de 13 meses (ver archive_old_counts).';
create index counts_hourly_archive_site_time_idx on public.counts_hourly_archive (site_id, hour_start);

alter table public.counts_hourly_archive enable row level security;
revoke all on public.counts_hourly_archive from anon, authenticated;
grant select on public.counts_hourly_archive to authenticated;
grant all on public.counts_hourly_archive to service_role;
create policy "usuarios leen archivo horario" on public.counts_hourly_archive for select to authenticated using (true);
-- visor publico por ahora (ver acceso_publico): al reactivar el login, revocar tambien esto
grant select on public.counts_hourly_archive to anon;
create policy "publico lee archivo horario" on public.counts_hourly_archive for select to anon using (true);

-- Suma elemento a elemento de dos histogramas de velocidad (null si ambos son null).
create function public.add_speed_bins(a integer[], b integer[])
returns integer[]
language sql
immutable
set search_path = ''
as $$
  select case when a is null and b is null then null
    else array(select coalesce(a[i], 0) + coalesce(b[i], 0) from generate_series(1, 12) as i order by i) end;
$$;
revoke execute on function public.add_speed_bins(integer[], integer[]) from public, anon, authenticated;

-- Mueve al archivo horario los periodos de mas de 13 meses. Devuelve cuantas filas de 15 min se archivaron.
create function public.archive_old_counts()
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_cut timestamptz := date_trunc('hour', now() - interval '13 months');
  v_rows integer;
begin
  with old as (
    select c.*, date_trunc('hour', c.period_start) as h from public.counts_15min c where c.period_start < v_cut
  ),
  bins as (
    select o.device_id, o.direction, o.h, b.i, sum(b.v)::integer as v
    from old o cross join lateral unnest(o.speed_bins) with ordinality as b(v, i)
    group by o.device_id, o.direction, o.h, b.i
  ),
  bin_arrays as (
    select device_id, direction, h, array_agg(v order by i) as arr from bins group by device_id, direction, h
  ),
  totals as (
    select o.device_id, o.site_id, o.h, o.direction,
      sum(o.minutes_measured) as m, sum(o.car) as car, sum(o.truck) as truck, sum(o.bus) as bus,
      sum(o.motorcycle) as motorcycle, sum(o.bicycle) as bicycle, sum(o.person) as person
    from old o
    group by o.device_id, o.site_id, o.h, o.direction
  )
  insert into public.counts_hourly_archive as a
    (device_id, site_id, hour_start, direction, minutes_measured, car, truck, bus, motorcycle, bicycle, person, speed_bins)
  select t.device_id, t.site_id, t.h, t.direction, least(60, t.m), t.car, t.truck, t.bus, t.motorcycle, t.bicycle,
    t.person, ba.arr
  from totals t
  left join bin_arrays ba on ba.device_id = t.device_id and ba.direction = t.direction and ba.h = t.h
  -- un periodo que llega tarde (equipo sin red mucho tiempo) se suma a la hora ya archivada
  on conflict (device_id, hour_start, direction) do update set
    minutes_measured = least(60, a.minutes_measured + excluded.minutes_measured),
    car = a.car + excluded.car,
    truck = a.truck + excluded.truck,
    bus = a.bus + excluded.bus,
    motorcycle = a.motorcycle + excluded.motorcycle,
    bicycle = a.bicycle + excluded.bicycle,
    person = a.person + excluded.person,
    speed_bins = public.add_speed_bins(a.speed_bins, excluded.speed_bins);

  delete from public.counts_15min where period_start < v_cut;
  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

revoke execute on function public.archive_old_counts() from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- Consultas del visor: periodos de 15 min + archivo por hora
-- ---------------------------------------------------------------------------------------------------------------

-- Misma firma y resultado que en aforos_init; ahora tambien suma el archivo horario.
create or replace function public.get_site_series(p_site uuid, p_from timestamptz, p_to timestamptz, p_bucket_minutes integer default 15)
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
    with rows as (
      select c.period_start as t, c.direction as d, c.minutes_measured::integer as m, c.car::integer as car,
        c.truck::integer as truck, c.bus::integer as bus, c.motorcycle::integer as motorcycle,
        c.bicycle::integer as bicycle, c.person::integer as person
      from public.counts_15min c
      where c.site_id = p_site and c.period_start >= p_from and c.period_start < p_to
      union all
      select a.hour_start, a.direction, a.minutes_measured::integer, a.car, a.truck, a.bus, a.motorcycle, a.bicycle, a.person
      from public.counts_hourly_archive a
      where a.site_id = p_site and a.hour_start >= p_from and a.hour_start < p_to
    )
    select
      date_bin(make_interval(mins => p_bucket_minutes), r.t, (timestamp '2000-01-01 00:00' at time zone coalesce(v_tz, 'UTC'))) as b,
      r.d,
      sum(r.m)::bigint,
      sum(r.car)::bigint,
      sum(r.truck)::bigint,
      sum(r.bus)::bigint,
      sum(r.motorcycle)::bigint,
      sum(r.bicycle)::bigint,
      sum(r.person)::bigint
    from rows r
    group by 1, 2
    order by 1, 2;
end;
$$;

create or replace function public.get_site_speeds(p_site uuid, p_from timestamptz, p_to timestamptz)
returns table (bin integer, from_kmh integer, vehicles bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  with bins as (
    select c.speed_bins::integer[] as sb from public.counts_15min c
    where c.site_id = p_site and c.period_start >= p_from and c.period_start < p_to and c.speed_bins is not null
    union all
    select a.speed_bins from public.counts_hourly_archive a
    where a.site_id = p_site and a.hour_start >= p_from and a.hour_start < p_to and a.speed_bins is not null
  )
  select i - 1, (i - 1) * 10, coalesce(sum(b.sb[i]), 0)::bigint
  from generate_series(1, 12) as i
  left join bins b on true
  group by i
  order by i;
$$;

create or replace function public.get_site_speeds_by_hour(p_site uuid, p_from timestamptz, p_to timestamptz)
returns table (hour integer, bin integer, vehicles bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  with rows as (
    select c.period_start as t, c.speed_bins::integer[] as sb from public.counts_15min c
    where c.site_id = p_site and c.period_start >= p_from and c.period_start < p_to and c.speed_bins is not null
    union all
    select a.hour_start, a.speed_bins from public.counts_hourly_archive a
    where a.site_id = p_site and a.hour_start >= p_from and a.hour_start < p_to and a.speed_bins is not null
  )
  select
    extract(hour from r.t at time zone coalesce(s.timezone, 'UTC'))::integer,
    (b.i - 1)::integer,
    sum(b.v)::bigint
  from rows r
  join public.sites s on s.id = p_site
  cross join lateral unnest(r.sb) with ordinality as b(v, i)
  group by 1, 2
  order by 1, 2;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Tarea diaria: 03:15 UTC (22:15 en Ecuador)
-- ---------------------------------------------------------------------------------------------------------------

select cron.schedule('aforos-archivar-15min', '15 3 * * *', $$select public.archive_old_counts()$$);
insert into public.counts_15min (device_id, site_id, period_start, direction, minutes_measured, car, truck, bus, motorcycle, bicycle, person, speed_bins)
select device_id, site_id, period_start - interval '400 days', direction, minutes_measured, car, truck, bus, motorcycle, bicycle, person, speed_bins
from public.counts_15min where site_id = '5550e5b2-d4ea-48c7-a04e-bb2f162f12b2' and period_start >= now() - interval '1 day';
create temp table t_before as
select (select sum(car + truck + bus + motorcycle + bicycle + person) from public.get_site_series('5550e5b2-d4ea-48c7-a04e-bb2f162f12b2', now() - interval '402 days', now() - interval '398 days', 60)) tot,
       (select sum(vehicles) from public.get_site_speeds('5550e5b2-d4ea-48c7-a04e-bb2f162f12b2', now() - interval '402 days', now() - interval '398 days')) sp,
       (select sum(vehicles) from public.get_site_speeds_by_hour('5550e5b2-d4ea-48c7-a04e-bb2f162f12b2', now() - interval '402 days', now() - interval '398 days')) sph,
       (select count(*) from public.get_site_series('5550e5b2-d4ea-48c7-a04e-bb2f162f12b2', now() - interval '402 days', now() - interval '398 days', 60)) n60,
       (select sum(car) from public.get_site_series('5550e5b2-d4ea-48c7-a04e-bb2f162f12b2', now() - interval '7 days', now(), 60)) rec;
create temp table t_arch as select public.archive_old_counts() n;
do $$
declare r record;
begin
  select (select n from t_arch) archivadas,
    b.tot antes, (select sum(car + truck + bus + motorcycle + bicycle + person) from public.get_site_series('5550e5b2-d4ea-48c7-a04e-bb2f162f12b2', now() - interval '402 days', now() - interval '398 days', 60)) despues,
    b.sp sp_antes, (select sum(vehicles) from public.get_site_speeds('5550e5b2-d4ea-48c7-a04e-bb2f162f12b2', now() - interval '402 days', now() - interval '398 days')) sp_despues,
    b.sph sph_antes, (select sum(vehicles) from public.get_site_speeds_by_hour('5550e5b2-d4ea-48c7-a04e-bb2f162f12b2', now() - interval '402 days', now() - interval '398 days')) sph_despues,
    b.n60 filas60_antes, (select count(*) from public.get_site_series('5550e5b2-d4ea-48c7-a04e-bb2f162f12b2', now() - interval '402 days', now() - interval '398 days', 60)) filas60_despues,
    (select count(*) from public.counts_hourly_archive) archivo, (select count(*) from cron.job where jobname = 'aforos-archivar-15min') cron,
    b.rec rec_antes, (select sum(car) from public.get_site_series('5550e5b2-d4ea-48c7-a04e-bb2f162f12b2', now() - interval '7 days', now(), 60)) rec_despues
  into r from t_before b;
  -- el error deshace toda la transaccion (nada queda guardado) y muestra el resultado
  raise exception 'PRUEBA %: %',
    case when r.antes = r.despues and r.sp_antes = r.sp_despues and r.sph_antes = r.sph_despues and r.filas60_antes = r.filas60_despues
      and r.archivadas > 0 and r.archivo > 0 and r.cron = 1 and r.rec_antes = r.rec_despues then 'OK' else 'FALLA' end,
    row_to_json(r);
end $$;
rollback;
