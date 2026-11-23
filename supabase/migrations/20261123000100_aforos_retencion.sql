-- Retencion: los periodos de 15 min se guardan 13 meses; despues se resumen en totales por hora y se borran.
-- Con 15 equipos, counts_15min queda en ~1 millon de filas (~150-200 MB) y el archivo horario crece 4 veces mas lento.

create extension if not exists pg_cron;

create table public.counts_hourly_archive (
  device_id uuid not null references public.devices (id) on delete cascade,
  site_id uuid not null references public.sites (id) on delete cascade,
  hour_start timestamptz not null,
  direction text not null check (direction in ('ab', 'ba')),
  minutes_measured smallint not null,
  car integer not null,
  truck integer not null,
  bus integer not null,
  motorcycle integer not null,
  bicycle integer not null,
  person integer not null,
  speed_bins integer[],
  primary key (device_id, hour_start, direction)
);
create index counts_hourly_archive_site_time_idx on public.counts_hourly_archive (site_id, hour_start);

alter table public.counts_hourly_archive enable row level security;
revoke all on public.counts_hourly_archive from anon, authenticated;
grant select on public.counts_hourly_archive to authenticated;
grant all on public.counts_hourly_archive to service_role;
create policy "usuarios leen archivo horario" on public.counts_hourly_archive for select to authenticated using (true);

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
  select t.device_id, t.site_id, t.h, t.direction, t.m, t.car, t.truck, t.bus, t.motorcycle, t.bicycle, t.person, ba.arr
  from totals t
  left join bin_arrays ba on ba.device_id = t.device_id and ba.direction = t.direction and ba.h = t.h
  on conflict (device_id, hour_start, direction) do update set
    minutes_measured = least(60, a.minutes_measured + excluded.minutes_measured),
    car = a.car + excluded.car,
    truck = a.truck + excluded.truck,
    bus = a.bus + excluded.bus,
    motorcycle = a.motorcycle + excluded.motorcycle,
    bicycle = a.bicycle + excluded.bicycle,
    person = a.person + excluded.person;

  delete from public.counts_15min where period_start < v_cut;
  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

revoke execute on function public.archive_old_counts() from public, anon, authenticated;

-- Todos los dias a las 03:15 UTC
select cron.schedule('aforos-archivar-15min', '15 3 * * *', $$select public.archive_old_counts()$$);
