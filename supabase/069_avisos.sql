-- Kombrio v117 (demande de JC du 20/11/2026) : Admin › Avisos — communiquer avec les groupes Kombrio.
--   Un aviso = un message écrit une fois (portugais obligatoire, traductions facultatives), envoyé à un ou plusieurs publics :
--     guide (guides), tc (Tour Companies), agency (agences), partner (gérants des partenaires), staff (équipe + caisse).
--   Trois niveaux :
--     info       : bandeau dans l'app, qu'on peut fermer ;
--     important  : bandeau + e-mail (guides et gérants ; l'équipe n'a pas d'e-mail) ;
--     legal      : bandeau + e-mail + lecture obligatoire (« Li e entendi ») avant de continuer dans l'app.
--   Chaque lecture et chaque confirmation est datée (traçabilité).
--   Seuls les comptes déjà inscrits au moment de l'envoi le reçoivent (les nouveaux acceptent les conditions en vigueur).
-- À lancer une fois dans Supabase › SQL Editor. Peut être relancé sans danger.

-- 1. Langue du guide (pour l'e-mail dans sa langue ; l'app la met à jour toute seule).
alter table guides add column if not exists lang text not null default 'pt';
alter table guides drop constraint if exists guides_lang_check;
alter table guides add constraint guides_lang_check check (lang in ('pt', 'fr', 'en', 'es', 'de'));

create or replace function public.guide_set_lang(p_lang text) returns void
language sql security definer set search_path = public as $$
  update guides set lang = p_lang where id = auth.uid() and p_lang in ('pt', 'fr', 'en', 'es', 'de') and lang is distinct from p_lang
$$;
grant execute on function public.guide_set_lang(text) to authenticated;

-- 2. Les avisos et leurs lectures.
create table if not exists broadcasts (
  id          uuid primary key default gen_random_uuid(),
  num         bigint generated always as identity unique,
  audience    text[] not null check (array_length(audience, 1) > 0 and audience <@ array['guide', 'tc', 'agency', 'partner', 'staff']),
  level       text not null check (level in ('info', 'important', 'legal')),
  title       jsonb not null,      -- { pt, fr, en, es, de } : pt obligatoire
  body        jsonb not null,
  emails      int not null default 0,
  created_at  timestamptz not null default now(),
  archived_at timestamptz
);
alter table broadcasts enable row level security;
drop policy if exists "admin lit les avisos" on broadcasts;
create policy "admin lit les avisos" on broadcasts for select using (is_admin());

create table if not exists broadcast_reads (
  broadcast_id uuid not null references broadcasts on delete cascade,
  reader_kind  text not null check (reader_kind in ('guide', 'manager', 'staff', 'counter')),
  reader_id    uuid not null,
  seen_at      timestamptz not null default now(),
  acked_at     timestamptz,
  primary key (broadcast_id, reader_kind, reader_id)
);
alter table broadcast_reads enable row level security;
drop policy if exists "admin lit les lectures" on broadcast_reads;
create policy "admin lit les lectures" on broadcast_reads for select using (is_admin());

-- Nouveau modèle d'e-mail.
alter table mail_outbox drop constraint if exists mail_outbox_kind_check;
alter table mail_outbox add constraint mail_outbox_kind_check check (kind in
  ('payout_paid', 'payment_verified', 'payment_rejected', 'month_closed', 'visits_pending', 'admin_report', 'j1_reminder', 'partner_welcome', 'broadcast'));

-- Texte dans la langue demandée, sinon en portugais.
create or replace function public.bc_pick(p jsonb, p_lang text) returns text
language sql immutable as $$ select coalesce(nullif(trim(p->>p_lang), ''), p->>'pt', '') $$;

-- 3. Admin : envoyer.
create or replace function public.admin_broadcast_send(p_audience text[], p_level text, p_title jsonb, p_body jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare b broadcasts; g record; p record; n int := 0;
begin
  if not is_admin() then raise exception 'réservé à l''administrateur'; end if;
  if coalesce(trim(p_title->>'pt'), '') = '' or coalesce(trim(p_body->>'pt'), '') = '' then
    return jsonb_build_object('ok', false, 'reason', 'pt'); end if;
  insert into broadcasts (audience, level, title, body) values (p_audience, p_level, p_title, p_body) returning * into b;
  if p_level in ('important', 'legal') then
    for g in select email, lang, coalesce(badge_name, name) as name from guides
             where status = 'validated' and actor_kind = any(p_audience) and email is not null loop
      perform queue_mail('broadcast', g.email, jsonb_build_object('broadcast', b.id, 'num', b.num, 'level', p_level, 'app', 'guide',
        'lang', g.lang, 'name', g.name, 'title', bc_pick(p_title, g.lang), 'body', bc_pick(p_body, g.lang)));
      n := n + 1;
    end loop;
    if 'partner' = any(p_audience) then
      for p in select manager_email, lang, manager_name from partners where status = 'active' and manager_email is not null loop
        perform queue_mail('broadcast', p.manager_email, jsonb_build_object('broadcast', b.id, 'num', b.num, 'level', p_level, 'app', 'partner',
          'lang', p.lang, 'name', p.manager_name, 'title', bc_pick(p_title, p.lang), 'body', bc_pick(p_body, p.lang)));
        n := n + 1;
      end loop;
    end if;
    update broadcasts set emails = n where id = b.id;
  end if;
  insert into ledger (actor_kind, event, data) values ('admin', 'broadcast_sent',
    jsonb_build_object('broadcast', b.id, 'num', b.num, 'level', p_level, 'audience', p_audience, 'emails', n));
  return jsonb_build_object('ok', true, 'id', b.id, 'num', b.num, 'emails', n);
end $$;
grant execute on function public.admin_broadcast_send(text[], text, jsonb, jsonb) to authenticated;

create or replace function public.admin_broadcast_archive(p_id uuid, p_archived boolean default true) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'réservé à l''administrateur'; end if;
  update broadcasts set archived_at = case when p_archived then now() end where id = p_id;
end $$;
grant execute on function public.admin_broadcast_archive(uuid, boolean) to authenticated;

-- Qui doit recevoir un aviso (comptes existant au moment de l'envoi).
create or replace function public.bc_targets(b broadcasts)
returns table (reader_kind text, reader_id uuid, name text, grp text)
language sql stable security definer set search_path = public as $$
  select 'guide', g.id, coalesce(g.badge_name, g.name), g.actor_kind from guides g
    where g.status = 'validated' and g.actor_kind = any(b.audience) and g.created_at <= b.created_at
  union all
  select 'manager', p.id, p.name, 'partner' from partners p
    where 'partner' = any(b.audience) and p.status = 'active' and p.created_at <= b.created_at
  union all
  select 'staff', s.id, s.name || ' · ' || p.name, 'staff' from partner_staff s join partners p on p.id = s.partner_id
    where 'staff' = any(b.audience) and s.enrolled_at is not null and s.revoked_at is null and p.status = 'active' and s.created_at <= b.created_at
$$;

create or replace function public.admin_broadcasts() returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'réservé à l''administrateur'; end if;
  return coalesce((select jsonb_agg(x order by x->>'created_at' desc) from (
    select to_jsonb(b) || jsonb_build_object(
      'targets', (select count(*) from bc_targets(b)),
      'seen', (select count(*) from bc_targets(b) t join broadcast_reads r on r.broadcast_id = b.id and r.reader_kind = t.reader_kind and r.reader_id = t.reader_id),
      'acked', (select count(*) from bc_targets(b) t join broadcast_reads r on r.broadcast_id = b.id and r.reader_kind = t.reader_kind and r.reader_id = t.reader_id and r.acked_at is not null)) as x
    from broadcasts b) s), '[]'::jsonb);
end $$;
grant execute on function public.admin_broadcasts() to authenticated;

create or replace function public.admin_broadcast_readers(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare b broadcasts;
begin
  if not is_admin() then raise exception 'réservé à l''administrateur'; end if;
  select * into b from broadcasts where id = p_id;
  return coalesce((select jsonb_agg(jsonb_build_object('kind', t.reader_kind, 'group', t.grp, 'name', t.name, 'seen_at', r.seen_at, 'acked_at', r.acked_at)
    order by r.acked_at nulls first, r.seen_at nulls first, t.name)
    from bc_targets(b) t left join broadcast_reads r on r.broadcast_id = b.id and r.reader_kind = t.reader_kind and r.reader_id = t.reader_id), '[]'::jsonb);
end $$;
grant execute on function public.admin_broadcast_readers(uuid) to authenticated;

-- 4. Côté guide (et TC / agence).
create or replace function public.guide_broadcasts() returns jsonb
language plpgsql security definer set search_path = public as $$
declare g guides;
begin
  select * into g from guides where id = auth.uid();
  if g.id is null then return '[]'::jsonb; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'num', b.num, 'level', b.level, 'title', b.title, 'body', b.body,
      'created_at', b.created_at, 'seen_at', r.seen_at, 'acked_at', r.acked_at) order by b.created_at desc)
    from broadcasts b left join broadcast_reads r on r.broadcast_id = b.id and r.reader_kind = 'guide' and r.reader_id = g.id
    where b.archived_at is null and g.actor_kind = any(b.audience) and b.created_at >= g.created_at and b.created_at > now() - interval '180 days'), '[]'::jsonb);
end $$;
grant execute on function public.guide_broadcasts() to authenticated;

create or replace function public.guide_broadcast_mark(p_id uuid, p_ack boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare g guides;
begin
  select * into g from guides where id = auth.uid();
  if g.id is null or not exists (select 1 from broadcasts where id = p_id and g.actor_kind = any(audience)) then
    return jsonb_build_object('ok', false); end if;
  insert into broadcast_reads (broadcast_id, reader_kind, reader_id, acked_at) values (p_id, 'guide', g.id, case when p_ack then now() end)
  on conflict (broadcast_id, reader_kind, reader_id) do update set acked_at = coalesce(broadcast_reads.acked_at, excluded.acked_at);
  return jsonb_build_object('ok', true);
end $$;
grant execute on function public.guide_broadcast_mark(uuid, boolean) to authenticated;

-- 5. Côté partenaire : gérant (public « partner »), équipe et caisse (public « staff »).
create or replace function public.bc_partner_reader(p_token text, out reader_kind text, out reader_id uuid, out aud text, out since timestamptz)
language plpgsql stable security definer set search_path = public as $$
declare ac record;
begin
  select * into ac from partner_access(p_token);
  if ac.partner_id is null then return; end if;
  if ac.kind = 'manager' then reader_kind := 'manager'; reader_id := ac.partner_id; aud := 'partner';
    select created_at into since from partners where id = ac.partner_id;
  elsif ac.kind = 'staff' then reader_kind := 'staff'; reader_id := ac.staff_id; aud := 'staff';
    select created_at into since from partner_staff where id = ac.staff_id;
  else reader_kind := 'counter'; reader_id := ac.partner_id; aud := 'staff';
    select created_at into since from partners where id = ac.partner_id;
  end if;
end $$;

create or replace function public.partner_broadcasts(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare x record;
begin
  select * into x from bc_partner_reader(p_token);
  if x.reader_id is null then return '[]'::jsonb; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'num', b.num, 'level', b.level, 'title', b.title, 'body', b.body,
      'created_at', b.created_at, 'seen_at', r.seen_at, 'acked_at', r.acked_at) order by b.created_at desc)
    from broadcasts b left join broadcast_reads r on r.broadcast_id = b.id and r.reader_kind = x.reader_kind and r.reader_id = x.reader_id
    where b.archived_at is null and x.aud = any(b.audience) and b.created_at >= x.since and b.created_at > now() - interval '180 days'), '[]'::jsonb);
end $$;
grant execute on function public.partner_broadcasts(text) to anon, authenticated;

create or replace function public.partner_broadcast_mark(p_token text, p_id uuid, p_ack boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare x record;
begin
  select * into x from bc_partner_reader(p_token);
  if x.reader_id is null or not exists (select 1 from broadcasts where id = p_id and x.aud = any(audience)) then
    return jsonb_build_object('ok', false); end if;
  insert into broadcast_reads (broadcast_id, reader_kind, reader_id, acked_at) values (p_id, x.reader_kind, x.reader_id, case when p_ack then now() end)
  on conflict (broadcast_id, reader_kind, reader_id) do update set acked_at = coalesce(broadcast_reads.acked_at, excluded.acked_at);
  return jsonb_build_object('ok', true);
end $$;
grant execute on function public.partner_broadcast_mark(text, uuid, boolean) to anon, authenticated;

-- Fonctions internes : jamais appelables directement.
revoke execute on function public.bc_targets(broadcasts) from public, anon, authenticated;
revoke execute on function public.bc_partner_reader(text) from public, anon, authenticated;

insert into ledger (actor_kind, event, data) values ('system', 'broadcasts_installed', jsonb_build_object('version', 'v117'));

-- Contrôle : 5 lignes « oui » attendues.
select 'langue des guides' as point, case when exists (select 1 from information_schema.columns where table_name = 'guides' and column_name = 'lang') then 'oui' else 'NON' end as ok
union all select 'tables des avisos', case when to_regclass('public.broadcasts') is not null and to_regclass('public.broadcast_reads') is not null then 'oui' else 'NON' end
union all select 'e-mail « broadcast » autorisé', case when pg_get_constraintdef((select oid from pg_constraint where conname = 'mail_outbox_kind_check')) like '%broadcast%' then 'oui' else 'NON' end
union all select 'fonctions admin', case when (select count(*) from pg_proc where proname in ('admin_broadcast_send', 'admin_broadcasts', 'admin_broadcast_readers', 'admin_broadcast_archive')) = 4 then 'oui' else 'NON' end
union all select 'fonctions guide et partenaire', case when (select count(*) from pg_proc where proname in ('guide_broadcasts', 'guide_broadcast_mark', 'partner_broadcasts', 'partner_broadcast_mark', 'guide_set_lang')) = 5 then 'oui' else 'NON' end;
