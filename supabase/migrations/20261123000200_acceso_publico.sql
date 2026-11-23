-- Acceso publico temporal: el visor funciona sin iniciar sesion (REQUIRE_LOGIN = false en public/js/config.js).
-- anon recibe la misma lectura que authenticated; nadie mas que la Edge Function escribe y `devices` sigue cerrada.
--
-- Para volver a exigir sesion: aplicar una migracion que ejecute los `revoke` y `drop policy` de abajo
-- (ver bloque "Revertir") y poner REQUIRE_LOGIN = true.

grant select on public.sites, public.device_live, public.counts_15min to anon;
grant select on public.site_overview to anon;
grant execute on function public.get_site_series(uuid, timestamptz, timestamptz, integer) to anon;
grant execute on function public.get_site_speeds(uuid, timestamptz, timestamptz) to anon;

create policy "publico lee estaciones" on public.sites for select to anon using (true);
create policy "publico lee estado en vivo" on public.device_live for select to anon using (true);
create policy "publico lee conteos" on public.counts_15min for select to anon using (true);

-- Revertir:
--   drop policy "publico lee estaciones" on public.sites;
--   drop policy "publico lee estado en vivo" on public.device_live;
--   drop policy "publico lee conteos" on public.counts_15min;
--   revoke select on public.sites, public.device_live, public.counts_15min, public.site_overview from anon;
--   revoke execute on function public.get_site_series(uuid, timestamptz, timestamptz, integer) from anon;
--   revoke execute on function public.get_site_speeds(uuid, timestamptz, timestamptz) from anon;
