-- Kombrio v120 (demande de JC du 22/11/2026).
-- 1. « MINHA EMPRESA » : le patron gère lui-même son groupe de lojas, depuis l'app du gérant.
--    - Le gérant d'une loja crée son entreprise (nom) et en devient le RESPONSÁVEL (partner_groups.owner_partner_id).
--    - Ajouter une loja :
--        a) nouvelle loja : nom + adresse ; CNPJ, langue, réglages de commission et compte du gérant repris de sa loja ;
--           elle reste « pending » jusqu'à la validation de Kombrio, comme une inscription normale ;
--        b) loja déjà dans Kombrio : invitation par code (7 jours) ; le gérant de l'autre loja accepte ou refuse.
--           Le double accord remplace le contrôle de Kombrio. Propre ou franchise : choisi par le responsável,
--           proposé d'après les CNPJ (même racine de 8 chiffres = propre).
--    - Le responsável : mode de paiement, nom de l'entreprise, retirer une loja, passer la main.
--    - Une loja peut quitter le groupe d'elle-même. Chaque changement crée une alerte non urgente pour Kombrio,
--      qui garde la main dans Admin › Partenaires (et y désigne le responsável des groupes déjà créés, ex. Pierim).
-- 2. JOURS SANS COMMISSION AVEC HORAIRE (ex. « soirs de match » à la loja du Maracanã seulement) :
--    - from_time / to_time facultatifs (vide = toute la journée). Chaque loja garde son propre calendrier ;
--      appliquer à tout le groupe reste un choix, réservé au responsável quand le groupe en a un.
-- Aucune donnée existante n'est modifiée. À lancer une fois dans Supabase › SQL Editor. Peut être relancé sans danger.

------------------------------------------------------------------------------------------------
-- 1. Minha empresa
------------------------------------------------------------------------------------------------
alter table partner_groups add column if not exists owner_partner_id uuid references partners on delete set null;

create table if not exists group_invites (
  id           uuid primary key default gen_random_uuid(),
  code         text not null unique,
  group_id     uuid not null references partner_groups on delete cascade,
  ownership    text not null check (ownership in ('own', 'franchise')),
  created_by   uuid references partners on delete set null,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default now() + interval '7 days',
  used_at      timestamptz,
  used_by      uuid references partners on delete set null,
  refused_at   timestamptz,
  cancelled_at timestamptz
);
alter table group_invites enable row level security;
drop policy if exists "admin lit les invitations" on group_invites;
create policy "admin lit les invitations" on group_invites for select using (is_admin());

-- Alerte non urgente pour Kombrio (jamais montrée au partenaire).
create or replace function public.company_alert(p_partner uuid, p_msg text) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into alerts (author_kind, partner_id, topic, message, internal, urgent)
  values ('partner', p_partner, 'other', left('Minha empresa · ' || p_msg, 1000), true, false);
exception when others then null;
end $$;
revoke execute on function public.company_alert(uuid, text) from public, anon, authenticated;

create or replace function public.tax_root(t text) returns text language sql immutable as $$
  select case when length(coalesce(t, '')) = 14 then left(t, 8) else null end
$$;

-- Ce que voit le gérant dans « Minha empresa ».
create or replace function public.company_space(p_manager_token text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare me partners; g partner_groups; owner boolean; ow partners;
begin
  select * into me from partners where p_manager_token is not null and manager_token = p_manager_token;
  if not found then return null; end if;
  if me.group_id is null then
    return jsonb_build_object('me', jsonb_build_object('id', me.id, 'name', me.name, 'tax_root', tax_root(me.tax_id)), 'group', null);
  end if;
  select * into g from partner_groups where id = me.group_id;
  owner := g.owner_partner_id = me.id;
  select * into ow from partners where id = g.owner_partner_id;
  return jsonb_build_object(
    'me', jsonb_build_object('id', me.id, 'name', me.name, 'ownership', me.ownership, 'tax_root', tax_root(me.tax_id)),
    'group', jsonb_build_object('id', g.id, 'name', g.name, 'pay_mode', g.pay_mode, 'is_owner', coalesce(owner, false),
                                'has_owner', g.owner_partner_id is not null, 'owner_name', ow.name),
    -- les franchises ne voient que le nom du groupe et du responsável
    'members', case when me.ownership = 'franchise' then '[]'::jsonb else (select coalesce(jsonb_agg(jsonb_build_object(
        'id', p.id, 'name', p.name, 'area', p.area, 'status', p.status, 'ownership', p.ownership,
        'is_owner', p.id = g.owner_partner_id, 'is_me', p.id = me.id,
        'same_tax', tax_root(p.tax_id) is not null and tax_root(p.tax_id) = tax_root(me.tax_id),
        'manager_token', case when p.ownership = 'own' and p.status <> 'pending' then p.manager_token end
      ) order by (p.id = g.owner_partner_id) desc, p.ownership, p.name), '[]'::jsonb)
      from partners p where p.group_id = g.id) end,
    'invites', case when owner then (select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'code', i.code, 'ownership', i.ownership,
        'expires_at', i.expires_at) order by i.created_at desc), '[]'::jsonb)
      from group_invites i where i.group_id = g.id and i.used_at is null and i.refused_at is null and i.cancelled_at is null and i.expires_at > now())
      else '[]'::jsonb end);
end $$;
grant execute on function public.company_space(text) to anon, authenticated;

-- Créer son entreprise : la loja devient la première loja propre et son gérant le responsável.
create or replace function public.company_create(p_manager_token text, p_name text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me partners; nm text := nullif(left(trim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g')), 80), ''); gid uuid;
begin
  select * into me from partners where manager_token = p_manager_token and status in ('active', 'paused');
  if not found then return jsonb_build_object('ok', false, 'reason', 'partner'); end if;
  if me.group_id is not null then return jsonb_build_object('ok', false, 'reason', 'in_group'); end if;
  if nm is null then return jsonb_build_object('ok', false, 'reason', 'name'); end if;
  insert into partner_groups (name, pay_mode, owner_partner_id) values (nm, 'each', me.id) returning id into gid;
  update partners set group_id = gid, ownership = 'own' where id = me.id;
  perform log_event('manager', 'company_created', null, null, null, jsonb_build_object('group', gid, 'partner', me.id, 'name', nm));
  perform company_alert(me.id, me.name || ' a créé l''entreprise « ' || nm || ' ».');
  return jsonb_build_object('ok', true, 'group_id', gid);
end $$;
grant execute on function public.company_create(text, text) to anon, authenticated;

-- Le responsável : retrouver sa loja et son groupe, sinon refus.
create or replace function public.company_owner(p_manager_token text, out me partners, out g partner_groups)
language plpgsql stable security definer set search_path = public as $$
begin
  select * into me from partners where manager_token = p_manager_token and status in ('active', 'paused') and group_id is not null;
  if not found then return; end if;
  select * into g from partner_groups where id = me.group_id and owner_partner_id = me.id;
end $$;
revoke execute on function public.company_owner(text) from public, anon, authenticated;

create or replace function public.company_update(p_manager_token text, p_name text, p_pay_mode text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare o record; nm text := nullif(left(trim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g')), 80), '');
begin
  select * into o from company_owner(p_manager_token);
  if (o.g).id is null then return jsonb_build_object('ok', false, 'reason', 'owner'); end if;
  if p_pay_mode is not null and p_pay_mode not in ('single', 'each') then return jsonb_build_object('ok', false, 'reason', 'mode'); end if;
  update partner_groups set name = coalesce(nm, name), pay_mode = coalesce(p_pay_mode, pay_mode) where id = (o.g).id;
  perform log_event('manager', 'company_updated', null, null, null, jsonb_build_object('group', (o.g).id, 'name', nm, 'pay_mode', p_pay_mode));
  if p_pay_mode is not null and p_pay_mode <> (o.g).pay_mode then
    perform company_alert((o.me).id, '« ' || (o.g).name || ' » passe en ' || case p_pay_mode when 'single' then 'Pix unique' else 'paiement par loja' end || '.');
  end if;
  return jsonb_build_object('ok', true);
end $$;
grant execute on function public.company_update(text, text, text) to anon, authenticated;

-- Invitation d'une loja déjà dans Kombrio : code de 6 caractères, 7 jours.
create or replace function public.company_invite(p_manager_token text, p_ownership text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare o record; cd text; n int := 0;
begin
  select * into o from company_owner(p_manager_token);
  if (o.g).id is null then return jsonb_build_object('ok', false, 'reason', 'owner'); end if;
  if p_ownership not in ('own', 'franchise') then return jsonb_build_object('ok', false, 'reason', 'ownership'); end if;
  if (select count(*) from group_invites where group_id = (o.g).id and used_at is null and refused_at is null and cancelled_at is null and expires_at > now()) >= 20 then
    return jsonb_build_object('ok', false, 'reason', 'too_many');
  end if;
  loop
    cd := (select string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 1 + floor(random() * 32)::int, 1), '') from generate_series(1, 6));
    exit when not exists (select 1 from group_invites where code = cd);
    n := n + 1; if n > 20 then return jsonb_build_object('ok', false, 'reason', 'code'); end if;
  end loop;
  insert into group_invites (code, group_id, ownership, created_by) values (cd, (o.g).id, p_ownership, (o.me).id);
  perform log_event('manager', 'company_invite', null, null, null, jsonb_build_object('group', (o.g).id, 'code', cd, 'ownership', p_ownership));
  return jsonb_build_object('ok', true, 'code', cd);
end $$;
grant execute on function public.company_invite(text, text) to anon, authenticated;

create or replace function public.company_invite_cancel(p_manager_token text, p_invite uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare o record;
begin
  select * into o from company_owner(p_manager_token);
  if (o.g).id is null then return jsonb_build_object('ok', false, 'reason', 'owner'); end if;
  update group_invites set cancelled_at = now() where id = p_invite and group_id = (o.g).id and used_at is null;
  return jsonb_build_object('ok', true);
end $$;
grant execute on function public.company_invite_cancel(text, uuid) to anon, authenticated;

-- Le gérant invité lit l'invitation avant de répondre.
create or replace function public.company_invite_peek(p_manager_token text, p_code text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare me partners; i group_invites; g partner_groups; ow partners;
begin
  select * into me from partners where manager_token = p_manager_token and status in ('active', 'paused');
  if not found then return jsonb_build_object('ok', false, 'reason', 'partner'); end if;
  select * into i from group_invites where code = upper(trim(coalesce(p_code, '')));
  if not found or i.cancelled_at is not null or i.refused_at is not null then return jsonb_build_object('ok', false, 'reason', 'code'); end if;
  if i.used_at is not null then return jsonb_build_object('ok', false, 'reason', 'used'); end if;
  if i.expires_at <= now() then return jsonb_build_object('ok', false, 'reason', 'expired'); end if;
  select * into g from partner_groups where id = i.group_id;
  select * into ow from partners where id = g.owner_partner_id;
  return jsonb_build_object('ok', true, 'group', g.name, 'owner', ow.name, 'ownership', i.ownership,
    'same_group', me.group_id = g.id, 'in_group', me.group_id is not null and me.group_id <> g.id,
    'same_tax', tax_root(me.tax_id) is not null and tax_root(me.tax_id) = tax_root(ow.tax_id),
    'tax_known', tax_root(me.tax_id) is not null and tax_root(ow.tax_id) is not null);
end $$;
grant execute on function public.company_invite_peek(text, text) to anon, authenticated;

create or replace function public.company_invite_answer(p_manager_token text, p_code text, p_accept boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me partners; i group_invites; g partner_groups;
begin
  select * into me from partners where manager_token = p_manager_token and status in ('active', 'paused');
  if not found then return jsonb_build_object('ok', false, 'reason', 'partner'); end if;
  select * into i from group_invites where code = upper(trim(coalesce(p_code, ''))) for update;
  if not found or i.cancelled_at is not null or i.refused_at is not null or i.used_at is not null or i.expires_at <= now() then
    return jsonb_build_object('ok', false, 'reason', 'code');
  end if;
  select * into g from partner_groups where id = i.group_id;
  if not p_accept then
    update group_invites set refused_at = now(), used_by = me.id where id = i.id;
    perform company_alert(me.id, me.name || ' a refusé l''invitation de « ' || g.name || ' ».');
    return jsonb_build_object('ok', true, 'joined', false);
  end if;
  if me.group_id is not null then return jsonb_build_object('ok', false, 'reason', 'in_group'); end if;
  update partners set group_id = g.id, ownership = i.ownership where id = me.id;
  update group_invites set used_at = now(), used_by = me.id where id = i.id;
  perform log_event('manager', 'company_joined', null, null, null, jsonb_build_object('group', g.id, 'partner', me.id, 'ownership', i.ownership, 'code', i.code));
  perform company_alert(me.id, me.name || ' a rejoint « ' || g.name || ' » comme ' || case i.ownership when 'own' then 'loja propre' else 'franchise' end || '.');
  return jsonb_build_object('ok', true, 'joined', true);
end $$;
grant execute on function public.company_invite_answer(text, text, boolean) to anon, authenticated;

-- Nouvelle loja créée par le responsável : en attente de validation par Kombrio.
create or replace function public.company_add_shop(p_manager_token text, p_name text, p_area text, p_address text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare o record; me partners; nm text := nullif(left(trim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g')), 120), ''); v_id uuid;
begin
  select * into o from company_owner(p_manager_token);
  if (o.g).id is null then return jsonb_build_object('ok', false, 'reason', 'owner'); end if;
  me := o.me;
  if nm is null then return jsonb_build_object('ok', false, 'reason', 'name'); end if;
  if (select count(*) from partners where group_id = (o.g).id and status = 'pending') >= 10 then return jsonb_build_object('ok', false, 'reason', 'too_many'); end if;
  insert into partners (city_id, type, name, area, address, tax_id, status, lang,
                        token, manager_token, manager_user, manager_name, manager_phone, manager_email,
                        terms_version, terms_accepted_at, commission_rate, commission_model, per_person_cents,
                        bonus_every, bonus_cents, meal_every, mode2_fee_rate, mode2_fee_cap_cents, rate_tc, rate_agency, child_cents,
                        staff_photo_required, group_id, ownership)
  values (me.city_id, me.type, nm, nullif(left(trim(coalesce(p_area, '')), 120), ''), nullif(left(trim(coalesce(p_address, '')), 200), ''),
          me.tax_id, 'pending', me.lang,
          'P-' || left(replace(gen_random_uuid()::text, '-', ''), 24), 'G-' || replace(gen_random_uuid()::text, '-', ''),
          me.manager_user, me.manager_name, me.manager_phone, me.manager_email,
          me.terms_version, me.terms_accepted_at, me.commission_rate, me.commission_model, me.per_person_cents,
          me.bonus_every, me.bonus_cents, me.meal_every, me.mode2_fee_rate, me.mode2_fee_cap_cents, me.rate_tc, me.rate_agency, me.child_cents,
          me.staff_photo_required, (o.g).id, 'own')
  returning id into v_id;
  perform log_event('manager', 'company_shop_added', null, null, null, jsonb_build_object('group', (o.g).id, 'partner', v_id, 'name', nm));
  perform company_alert(v_id, 'Nouvelle loja à valider : ' || nm || ', ajoutée par ' || me.name || ' dans « ' || (o.g).name || ' » (onglet Partenaires).');
  return jsonb_build_object('ok', true, 'partner_id', v_id);
end $$;
grant execute on function public.company_add_shop(text, text, text, text) to anon, authenticated;

-- Retirer une loja (responsável) ou quitter le groupe (n'importe quelle loja, sauf le responsável qui doit passer la main).
create or replace function public.company_remove(p_manager_token text, p_partner uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare o record; t partners;
begin
  select * into o from company_owner(p_manager_token);
  if (o.g).id is null then return jsonb_build_object('ok', false, 'reason', 'owner'); end if;
  select * into t from partners where id = p_partner and group_id = (o.g).id and id <> (o.me).id;
  if not found then return jsonb_build_object('ok', false, 'reason', 'partner'); end if;
  update partners set group_id = null, ownership = 'own' where id = t.id;
  perform log_event('manager', 'company_removed', null, null, null, jsonb_build_object('group', (o.g).id, 'partner', t.id));
  perform company_alert(t.id, t.name || ' a été retirée de « ' || (o.g).name || ' » par ' || (o.me).name || '.');
  return jsonb_build_object('ok', true);
end $$;
grant execute on function public.company_remove(text, uuid) to anon, authenticated;

create or replace function public.company_leave(p_manager_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me partners; g partner_groups; others int;
begin
  select * into me from partners where manager_token = p_manager_token and group_id is not null;
  if not found then return jsonb_build_object('ok', false, 'reason', 'partner'); end if;
  select * into g from partner_groups where id = me.group_id;
  select count(*) into others from partners where group_id = g.id and id <> me.id;
  if g.owner_partner_id = me.id and others > 0 then return jsonb_build_object('ok', false, 'reason', 'owner'); end if;
  update partners set group_id = null, ownership = 'own' where id = me.id;
  if others = 0 then
    update group_invites set cancelled_at = now() where group_id = g.id and used_at is null and cancelled_at is null;
    update partner_groups set owner_partner_id = null where id = g.id;
  end if;
  perform log_event('manager', 'company_left', null, null, null, jsonb_build_object('group', g.id, 'partner', me.id));
  perform company_alert(me.id, me.name || ' a quitté « ' || g.name || ' ».');
  return jsonb_build_object('ok', true);
end $$;
grant execute on function public.company_leave(text) to anon, authenticated;

create or replace function public.company_transfer(p_manager_token text, p_partner uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare o record; t partners;
begin
  select * into o from company_owner(p_manager_token);
  if (o.g).id is null then return jsonb_build_object('ok', false, 'reason', 'owner'); end if;
  select * into t from partners where id = p_partner and group_id = (o.g).id and ownership = 'own' and status in ('active', 'paused');
  if not found then return jsonb_build_object('ok', false, 'reason', 'partner'); end if;
  update partner_groups set owner_partner_id = t.id where id = (o.g).id;
  perform log_event('manager', 'company_transfer', null, null, null, jsonb_build_object('group', (o.g).id, 'from', (o.me).id, 'to', t.id));
  perform company_alert(t.id, 'Responsável de « ' || (o.g).name || ' » : ' || (o.me).name || ' → ' || t.name || '.');
  return jsonb_build_object('ok', true);
end $$;
grant execute on function public.company_transfer(text, uuid) to anon, authenticated;

------------------------------------------------------------------------------------------------
-- 2. Jours sans commission avec horaire
------------------------------------------------------------------------------------------------
alter table partner_blackouts add column if not exists from_time time;
alter table partner_blackouts add column if not exists to_time time;
alter table partner_blackouts drop constraint if exists partner_blackouts_times_check;
alter table partner_blackouts add constraint partner_blackouts_times_check check (to_time is null or from_time is null or to_time > from_time);

-- Le passage tombe-t-il dans la plage ? (horaire vide = toute la journée)
create or replace function public.blackout_covers(b partner_blackouts, t time) returns boolean language sql immutable as $$
  select (b.from_time is null or t >= b.from_time) and (b.to_time is null or t < b.to_time)
$$;

create or replace function public.partner_blackouts_list(p_token text) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('day', b.day, 'note', b.note, 'from', to_char(b.from_time, 'HH24:MI'), 'to', to_char(b.to_time, 'HH24:MI')) order by b.day), '[]'::jsonb)
  from partner_access(p_token) a join partner_blackouts b on b.partner_id = a.partner_id
  join partners p on p.id = a.partner_id join cities c on c.id = p.city_id
  where b.day >= (now() at time zone c.timezone)::date - 1
$$;
grant execute on function public.partner_blackouts_list(text) to anon, authenticated;

drop function if exists public.partner_blackouts_add(text, date[], text, boolean);
create or replace function public.partner_blackouts_add(p_manager_token text, p_days date[], p_note text, p_all_group boolean default false,
                                                        p_from text default null, p_to text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p partners; n int := 0; nt text := left(trim(coalesce(p_note, '')), 160); today date; f time; tt time; allg boolean := coalesce(p_all_group, false);
begin
  select * into p from partners where manager_token = p_manager_token and status in ('active', 'paused');
  if not found then return jsonb_build_object('ok', false, 'reason', 'partner'); end if;
  select (now() at time zone timezone)::date into today from cities where id = p.city_id;
  if nt = '' then return jsonb_build_object('ok', false, 'reason', 'note'); end if;
  if coalesce(array_length(p_days, 1), 0) = 0 or coalesce(array_length(p_days, 1), 0) > 120 then return jsonb_build_object('ok', false, 'reason', 'days'); end if;
  if exists (select 1 from unnest(p_days) d where d < today or d > today + 400) then return jsonb_build_object('ok', false, 'reason', 'days'); end if;
  begin f := nullif(p_from, '')::time; tt := nullif(p_to, '')::time;
  exception when others then return jsonb_build_object('ok', false, 'reason', 'time'); end;
  if f is not null and tt is not null and tt <= f then return jsonb_build_object('ok', false, 'reason', 'time'); end if;
  -- appliquer à tout le groupe : lojas propres seulement, et seulement le responsável quand le groupe en a un
  if allg and (p.group_id is null or p.ownership <> 'own'
               or exists (select 1 from partner_groups g where g.id = p.group_id and g.owner_partner_id is not null and g.owner_partner_id <> p.id)) then
    allg := false;
  end if;
  insert into partner_blackouts (partner_id, day, note, from_time, to_time)
  select x.id, d, nt, f, tt from unnest(p_days) d
  cross join (select id from partners where id = p.id
              union select id from partners where allg and group_id = p.group_id and ownership = 'own' and status in ('active', 'paused')) x
  on conflict (partner_id, day) do update set note = excluded.note, from_time = excluded.from_time, to_time = excluded.to_time;
  get diagnostics n = row_count;
  perform log_event('manager', 'blackout_days_added', null, null, null,
    jsonb_build_object('partner', p.id, 'days', to_jsonb(p_days), 'note', nt, 'from', p_from, 'to', p_to, 'all_group', allg, 'rows', n));
  return jsonb_build_object('ok', true, 'rows', n, 'all_group', allg);
end $$;
grant execute on function public.partner_blackouts_add(text, date[], text, boolean, text, text) to anon, authenticated;

create or replace function public.partner_blackouts_remove(p_manager_token text, p_day date, p_all_group boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p partners; n int; allg boolean := coalesce(p_all_group, false);
begin
  select * into p from partners where manager_token = p_manager_token and status in ('active', 'paused');
  if not found then return jsonb_build_object('ok', false, 'reason', 'partner'); end if;
  if allg and (p.group_id is null or p.ownership <> 'own'
               or exists (select 1 from partner_groups g where g.id = p.group_id and g.owner_partner_id is not null and g.owner_partner_id <> p.id)) then
    allg := false;
  end if;
  delete from partner_blackouts b where b.day = p_day and (b.partner_id = p.id
    or (allg and b.partner_id in (select id from partners where group_id = p.group_id and ownership = 'own')));
  get diagnostics n = row_count;
  perform log_event('manager', 'blackout_day_removed', null, null, null, jsonb_build_object('partner', p.id, 'day', p_day, 'rows', n));
  return jsonb_build_object('ok', true, 'rows', n);
end $$;
grant execute on function public.partner_blackouts_remove(text, date, boolean) to anon, authenticated;

create or replace function public.public_blackouts(p_city text) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('partner_id', b.partner_id, 'day', b.day, 'note', b.note,
                                               'from', to_char(b.from_time, 'HH24:MI'), 'to', to_char(b.to_time, 'HH24:MI')) order by b.day), '[]'::jsonb)
  from partner_blackouts b join partners p on p.id = b.partner_id join cities c on c.id = p.city_id
  where p.city_id = p_city and p.status = 'active'
    and b.day between (now() at time zone c.timezone)::date and (now() at time zone c.timezone)::date + 45
$$;
grant execute on function public.public_blackouts(text) to anon, authenticated;

-- L'offre reste annoncée un jour à horaire (ex. match le soir) ; le déclencheur la retire pour un passage dans la plage.
create or replace function public.partner_offer_active(p partners, d date) returns boolean
language sql stable set search_path = public as $$
  select (p.offer_start is null or d >= p.offer_start) and (p.offer_end is null or d <= p.offer_end)
     and (p.offer_days is null or extract(isodow from d)::smallint = any (p.offer_days))
     and not exists (select 1 from partner_blackouts b where b.partner_id = p.id and b.day = d and b.from_time is null and b.to_time is null)
$$;
revoke execute on function public.partner_offer_active(partners, date) from public, anon, authenticated;

create or replace function public.visit_no_commission() returns trigger
language plpgsql security definer set search_path = public as $$
declare b partner_blackouts; tz text; ts timestamp;
begin
  if tg_op = 'INSERT' then
    select c.timezone into tz from partners p join cities c on c.id = p.city_id where p.id = new.partner_id;
    ts := coalesce(new.at, now()) at time zone coalesce(tz, 'America/Sao_Paulo');
    select * into b from partner_blackouts
      where partner_id = new.partner_id and day = coalesce(new.visit_day, ts::date);
    if found and blackout_covers(b, ts::time) then new.no_commission := true; new.no_commission_note := nullif(b.note, ''); end if;
  end if;
  if new.no_commission then
    new.commission_rate := 0; new.per_person_cents := null; new.child_cents := null;
    new.bonus_every := null; new.bonus_cents := null; new.meal_every := null;
    new.fee_cents := 0; new.fee_rate := null; new.offer_given := false;
  end if;
  return new;
end $$;
drop trigger if exists zzz_visits_no_commission on visits;
create trigger zzz_visits_no_commission before insert or update on visits for each row execute function public.visit_no_commission();

insert into ledger (actor_kind, event, data) values ('system', 'company_self_service_installed', jsonb_build_object('version', 'v120'));

-- Contrôle : 5 lignes « oui » attendues.
select 'responsável du groupe' as point, case when exists (select 1 from information_schema.columns where table_name = 'partner_groups' and column_name = 'owner_partner_id') then 'oui' else 'NON' end as ok
union all select 'invitations', case when to_regclass('public.group_invites') is not null then 'oui' else 'NON' end
union all select 'fonctions Minha empresa', case when (select count(*) from pg_proc where proname in ('company_space', 'company_create', 'company_update', 'company_invite', 'company_invite_cancel',
  'company_invite_peek', 'company_invite_answer', 'company_add_shop', 'company_remove', 'company_leave', 'company_transfer')) = 11 then 'oui' else 'NON' end
union all select 'horaires des jours sans commission', case when exists (select 1 from information_schema.columns where table_name = 'partner_blackouts' and column_name = 'from_time') then 'oui' else 'NON' end
union all select 'déclencheur zzz', case when exists (select 1 from pg_trigger where tgname = 'zzz_visits_no_commission') then 'oui' else 'NON' end;
