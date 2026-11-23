-- Alta de estaciones desde el visor (como el asistente de Telraam): un administrador crea la estacion, elige el tipo
-- de equipo, dibuja el tramo de A a B y obtiene un codigo de vinculacion. En el equipo se escribe ese codigo y la
-- Edge Function `pair` le entrega su token (solo se guarda su hash).
--
-- Tipos de equipo: v1 = Raspberry Pi (Telraam adaptado), s2 = Jetson con FreeCount Traffic,
--                  v3 = reservado (app movil o aforos de videos grabados).
--
-- El visor sigue publico para leer; solo las funciones admin_* escriben, y solo para usuarios en `admins`.

-- ---------------------------------------------------------------------------------------------------------------
-- Administradores
-- ---------------------------------------------------------------------------------------------------------------

create table public.admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);
comment on table public.admins is 'Usuarios que pueden dar de alta estaciones y equipos. Se agregan a mano (SQL).';
alter table public.admins enable row level security;
revoke all on public.admins from anon, authenticated;
grant select on public.admins to authenticated;
grant all on public.admins to service_role;
create policy "cada usuario ve si es admin" on public.admins for select to authenticated
  using (user_id = (select auth.uid()));

create function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.admins a where a.user_id = (select auth.uid()));
$$;
revoke execute on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- Datos de alta (privados: la direccion de un V1 puede ser una vivienda) y tipo de equipo
-- ---------------------------------------------------------------------------------------------------------------

create table public.site_setup (
  site_id uuid primary key references public.sites (id) on delete cascade,
  device_kind text not null default 's2' check (device_kind in ('v1', 's2', 'v3')),
  address text,
  city text,
  country text not null default 'Ecuador',
  notes text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.site_setup is 'Datos de alta de cada estacion. Solo administradores (por las funciones admin_*).';
alter table public.site_setup enable row level security;
revoke all on public.site_setup from anon, authenticated;
grant all on public.site_setup to service_role;

alter table public.devices add column kind text not null default 's2' check (kind in ('v1', 's2', 'v3'));

-- ---------------------------------------------------------------------------------------------------------------
-- Codigos de vinculacion: 8 caracteres (XXXX-XXXX), un solo uso, 24 h
-- ---------------------------------------------------------------------------------------------------------------

create table public.pairing_codes (
  code_hash text primary key check (code_hash ~ '^[0-9a-f]{64}$'),
  site_id uuid not null references public.sites (id) on delete cascade,
  device_name text not null check (device_name ~ '^[A-Za-z0-9._-]{1,60}$'),
  kind text not null check (kind in ('v1', 's2', 'v3')),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  device_id uuid references public.devices (id) on delete set null
);
comment on table public.pairing_codes is 'Codigos para vincular un equipo con su estacion (solo el hash). Los usa la Edge Function pair.';
create index pairing_codes_site_idx on public.pairing_codes (site_id);
alter table public.pairing_codes enable row level security;
revoke all on public.pairing_codes from anon, authenticated;
grant all on public.pairing_codes to service_role;

-- ---------------------------------------------------------------------------------------------------------------
-- Funciones del asistente (solo administradores)
-- ---------------------------------------------------------------------------------------------------------------

create function public.assert_admin()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'solo administradores' using errcode = '42501';
  end if;
end;
$$;
revoke execute on function public.assert_admin() from public, anon, authenticated;

-- Crea (p_id null) o actualiza una estacion. p_segment: GeoJSON LineString de A a B (lon, lat).
create function public.admin_save_site(
  p_id uuid,
  p_name text,
  p_description text,
  p_kind text,
  p_address text,
  p_city text,
  p_country text,
  p_segment jsonb,
  p_label_a text,
  p_label_b text,
  p_speed_limit integer
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_seg extensions.geography;
  v_len double precision;
  v_id uuid := p_id;
begin
  perform public.assert_admin();
  if coalesce(trim(p_name), '') = '' then
    raise exception 'falta el nombre de la estacion';
  end if;
  if p_kind not in ('v1', 's2', 'v3') then
    raise exception 'tipo de equipo invalido';
  end if;
  if p_segment ->> 'type' <> 'LineString' or jsonb_array_length(p_segment -> 'coordinates') < 2 then
    raise exception 'el tramo debe tener al menos dos puntos (A y B)';
  end if;
  v_seg := extensions.st_setsrid(extensions.st_geomfromgeojson(p_segment::text), 4326)::extensions.geography;
  v_len := extensions.st_length(v_seg);
  if v_len < 5 or v_len > 3000 then
    raise exception 'el tramo mide % m: debe medir entre 5 m y 3 km', round(v_len);
  end if;
  if p_speed_limit is not null and (p_speed_limit < 5 or p_speed_limit > 130) then
    raise exception 'limite de velocidad invalido';
  end if;

  if v_id is null then
    insert into public.sites (name, description, segment, label_a, label_b, speed_limit_kmh)
    values (trim(p_name), nullif(trim(p_description), ''), v_seg, coalesce(nullif(trim(p_label_a), ''), 'A'),
            coalesce(nullif(trim(p_label_b), ''), 'B'), p_speed_limit)
    returning id into v_id;
  else
    update public.sites set
      name = trim(p_name),
      description = nullif(trim(p_description), ''),
      segment = v_seg,
      label_a = coalesce(nullif(trim(p_label_a), ''), 'A'),
      label_b = coalesce(nullif(trim(p_label_b), ''), 'B'),
      speed_limit_kmh = p_speed_limit
    where id = v_id;
    if not found then
      raise exception 'la estacion no existe';
    end if;
  end if;

  insert into public.site_setup as s (site_id, device_kind, address, city, country, created_by)
  values (v_id, p_kind, nullif(trim(p_address), ''), nullif(trim(p_city), ''), coalesce(nullif(trim(p_country), ''), 'Ecuador'),
          (select auth.uid()))
  on conflict (site_id) do update set
    device_kind = excluded.device_kind,
    address = excluded.address,
    city = excluded.city,
    country = excluded.country,
    updated_at = now();
  return v_id;
end;
$$;

-- Nuevo codigo de vinculacion para un equipo de la estacion. Si el equipo ya existe en esa estacion, al vincularse
-- recibe un token nuevo (el anterior deja de valer) y conserva sus conteos.
create function public.admin_new_pairing_code(p_site uuid, p_device_name text)
returns table (code text, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_bytes bytea := extensions.gen_random_bytes(8);
  v_raw text := '';
  v_kind text;
  v_other uuid;
  v_exp timestamptz := now() + interval '24 hours';
begin
  perform public.assert_admin();
  if p_device_name !~ '^[A-Za-z0-9._-]{1,60}$' then
    raise exception 'nombre de equipo invalido: solo letras, numeros, punto, guion y guion bajo';
  end if;
  select ss.device_kind into v_kind from public.site_setup ss where ss.site_id = p_site;
  if v_kind is null then
    select 's2' into v_kind from public.sites s where s.id = p_site;
    if v_kind is null then
      raise exception 'la estacion no existe';
    end if;
  end if;
  select d.site_id into v_other from public.devices d where d.name = p_device_name;
  if v_other is not null and v_other <> p_site then
    raise exception 'ya hay un equipo llamado % en otra estacion', p_device_name;
  end if;
  for i in 0..7 loop
    v_raw := v_raw || substr(v_alphabet, (get_byte(v_bytes, i) % 32) + 1, 1);
  end loop;
  -- un codigo pendiente por equipo: el nuevo reemplaza al anterior
  delete from public.pairing_codes pc where pc.site_id = p_site and pc.device_name = p_device_name and pc.used_at is null;
  insert into public.pairing_codes (code_hash, site_id, device_name, kind, created_by, expires_at)
  values (encode(extensions.digest(v_raw, 'sha256'), 'hex'), p_site, p_device_name, v_kind, (select auth.uid()), v_exp);
  return query select substr(v_raw, 1, 4) || '-' || substr(v_raw, 5, 4), v_exp;
end;
$$;

-- Estaciones con sus datos de alta, equipos y codigos pendientes (para la pagina de administracion).
create function public.admin_sites()
returns table (
  id uuid,
  name text,
  description text,
  label_a text,
  label_b text,
  speed_limit_kmh smallint,
  segment jsonb,
  device_kind text,
  address text,
  city text,
  country text,
  created_at timestamptz,
  devices jsonb,
  pending_codes jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.assert_admin();
  return query
  select s.id, s.name, s.description, s.label_a, s.label_b, s.speed_limit_kmh,
    extensions.st_asgeojson(s.segment)::jsonb,
    coalesce(ss.device_kind, 's2'), ss.address, ss.city, coalesce(ss.country, 'Ecuador'), s.created_at,
    coalesce((
      select jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name, 'kind', d.kind, 'active', d.active,
        'app_version', d.app_version, 'last_seen', d.last_seen, 'status', dl.status, 'live_updated_at', dl.updated_at)
        order by d.name)
      from public.devices d left join public.device_live dl on dl.device_id = d.id
      where d.site_id = s.id), '[]'::jsonb),
    coalesce((
      select jsonb_agg(jsonb_build_object('device_name', pc.device_name, 'expires_at', pc.expires_at,
        'created_at', pc.created_at) order by pc.created_at desc)
      from public.pairing_codes pc
      where pc.site_id = s.id and pc.used_at is null and pc.expires_at > now()), '[]'::jsonb)
  from public.sites s
  left join public.site_setup ss on ss.site_id = s.id
  order by s.created_at desc;
end;
$$;

-- Ultimo uso de un codigo: para la pantalla "Listo" del asistente, que espera a que el equipo se vincule.
create function public.admin_pairing_status(p_site uuid, p_device_name text)
returns table (paired_at timestamptz, device_id uuid, last_seen timestamptz, live_status text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.assert_admin();
  return query
  select pc.used_at, d.id, d.last_seen, dl.status
  from public.pairing_codes pc
  left join public.devices d on d.id = pc.device_id
  left join public.device_live dl on dl.device_id = d.id
  where pc.site_id = p_site and pc.device_name = p_device_name and pc.used_at is not null
  order by pc.used_at desc
  limit 1;
end;
$$;

create function public.admin_set_device_active(p_device uuid, p_active boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.assert_admin();
  update public.devices set active = p_active where id = p_device;
end;
$$;

-- Borra una estacion que todavia no tiene equipos (un alta que quedo a medias).
create function public.admin_delete_site(p_site uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.assert_admin();
  if exists (select 1 from public.devices d where d.site_id = p_site) then
    raise exception 'la estacion tiene equipos: desactivelos en lugar de borrarla';
  end if;
  delete from public.sites where id = p_site;
end;
$$;

revoke execute on function public.admin_save_site(uuid, text, text, text, text, text, text, jsonb, text, text, integer) from public, anon;
revoke execute on function public.admin_new_pairing_code(uuid, text) from public, anon;
revoke execute on function public.admin_sites() from public, anon;
revoke execute on function public.admin_pairing_status(uuid, text) from public, anon;
revoke execute on function public.admin_set_device_active(uuid, boolean) from public, anon;
revoke execute on function public.admin_delete_site(uuid) from public, anon;
grant execute on function public.admin_save_site(uuid, text, text, text, text, text, text, jsonb, text, text, integer) to authenticated;
grant execute on function public.admin_new_pairing_code(uuid, text) to authenticated;
grant execute on function public.admin_sites() to authenticated;
grant execute on function public.admin_pairing_status(uuid, text) to authenticated;
grant execute on function public.admin_set_device_active(uuid, boolean) to authenticated;
grant execute on function public.admin_delete_site(uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- Vinculacion (la llama la Edge Function `pair` con la clave de servicio)
-- ---------------------------------------------------------------------------------------------------------------

-- Canjea un codigo vigente: crea el equipo (o le cambia el token si ya existia en esa estacion). Atomico: un codigo
-- solo se canjea una vez aunque lleguen dos pedidos a la vez.
create function public.claim_pairing_code(p_code_hash text, p_token_hash text, p_app_version text)
returns table (device_id uuid, device_name text, site_id uuid, site_name text, label_a text, label_b text, kind text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code public.pairing_codes;
  v_device uuid;
begin
  update public.pairing_codes pc set used_at = now()
  where pc.code_hash = p_code_hash and pc.used_at is null and pc.expires_at > now()
  returning * into v_code;
  if v_code.code_hash is null then
    return;
  end if;
  insert into public.devices as d (site_id, name, token_hash, kind, active, app_version)
  values (v_code.site_id, v_code.device_name, p_token_hash, v_code.kind, true, left(p_app_version, 40))
  on conflict (name) do update set token_hash = excluded.token_hash, kind = excluded.kind, active = true,
    app_version = coalesce(excluded.app_version, d.app_version)
    where d.site_id = excluded.site_id
  returning d.id into v_device;
  if v_device is null then
    raise exception 'el equipo % pertenece a otra estacion', v_code.device_name;
  end if;
  update public.pairing_codes pc set device_id = v_device where pc.code_hash = p_code_hash;
  return query select v_device, v_code.device_name, s.id, s.name, s.label_a, s.label_b, v_code.kind
    from public.sites s where s.id = v_code.site_id;
end;
$$;
revoke execute on function public.claim_pairing_code(text, text, text) from public, anon, authenticated;
grant execute on function public.claim_pairing_code(text, text, text) to service_role;
