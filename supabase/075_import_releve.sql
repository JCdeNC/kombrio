-- Kombrio v134 (24/11/2026, demande de JC, « dossier Pierim », lot 1) : IMPORT DU RELEVÉ DU MOIS.
-- Beaucoup de partenaires (ex. Pierim) suivent déjà les ventes des guides dans leur logiciel ou dans une planilha :
-- la vendeuse note son code et le code (ou le nom) du guide ; en fin de mois, ils font le rapprochement.
-- Ici, le gérant dépose ce relevé dans Kombrio : chaque ligne devient une vente « guide présent » (mode 2, comme la
-- vente directe de la caisse) À LA DATE DE LA VENTE, puis il paie le tout par le circuit habituel (« Pagar »).
--   1. Codes guides du partenaire : sa propre base de guides (ex. « G-017 Marcos ») reliée UNE fois à un guide Kombrio.
--   2. Modèle d'import : la correspondance des colonnes est gardée, le mois suivant se fait sans rien régler.
--   3. Import : contrôles ligne par ligne (date du mois, pas dans le futur, guide validé, montant, ticket déjà importé) ;
--      une ligne refusée n'empêche pas les autres ; la commission suit les règles du partenaire (taux, forfait, plafonds,
--      palier, turbo, jours sans commission) ; une commission donnée par le fichier ne peut pas dépasser le calcul Kombrio.
--   4. Annuler un import tant que rien n'est payé.
-- Chaque ligne a sa propre fiche technique « Relatório » (un guide peut avoir plusieurs tickets le même jour).
-- Peut être relancé sans danger.

-- 1. Tables et colonnes ------------------------------------------------------------------------------------------------
create table if not exists partner_guide_aliases (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid not null references partners(id) on delete cascade,
  ext_key text not null,                       -- code (ou nom) du guide chez le partenaire, en majuscules, espaces réduits
  ext_label text not null default '',          -- tel qu'écrit dans le relevé
  guide_id uuid not null references guides(id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint partner_guide_aliases_key check (length(ext_key) between 1 and 80),
  unique (partner_id, ext_key)
);
alter table partner_guide_aliases enable row level security;

create table if not exists partner_import_templates (
  partner_id uuid primary key references partners(id) on delete cascade,
  mapping jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table partner_import_templates enable row level security;

create table if not exists partner_imports (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid not null references partners(id) on delete cascade,
  month date not null,
  file_name text not null default '',
  rows_total int not null default 0,
  rows_ok int not null default 0,
  invoice_cents bigint not null default 0,
  commission_cents bigint not null default 0,
  status text not null default 'done' check (status in ('done', 'cancelled')),
  created_at timestamptz not null default now()
);
alter table partner_imports enable row level security;

alter table visits add column if not exists import_id uuid references partner_imports(id);
alter table visits add column if not exists ext_ticket text;
alter table visits add column if not exists ext_seller text;
create unique index if not exists visits_ext_ticket_uq on visits (partner_id, ext_ticket)
  where ext_ticket is not null and status <> 'cancelled';

create or replace function public.import_key(p text) returns text
language sql immutable set search_path = public as $$
  select left(upper(regexp_replace(trim(coalesce(p, '')), '\s+', ' ', 'g')), 80)
$$;

-- Le gérant (et seulement lui : jeton G-) ; les lojas d'un même groupe partagent les codes guides.
create or replace function public.import_manager(p_manager_token text) returns partners
language sql stable security definer set search_path = public as $$
  select * from partners where p_manager_token is not null and manager_token = p_manager_token and status = 'active'
$$;
revoke execute on function public.import_manager(text) from public, anon, authenticated;

-- 2. Espace import : modèle, codes guides connus, derniers imports -------------------------------------------------------
create or replace function public.import_space(p_manager_token text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare p partners;
begin
  p := import_manager(p_manager_token);
  if p.id is null then return null; end if;
  return jsonb_build_object(
    'mapping', (select mapping from partner_import_templates where partner_id = p.id),
    'aliases', coalesce((select jsonb_agg(jsonb_build_object('key', a.ext_key, 'label', a.ext_label, 'code', g.code,
                  'name', coalesce(g.badge_name, g.name)) order by a.ext_label)
                from partner_guide_aliases a join guides g on g.id = a.guide_id
                where a.partner_id = p.id or (p.group_id is not null and a.partner_id in (select id from partners where group_id = p.group_id))), '[]'::jsonb),
    'imports', coalesce((select jsonb_agg(x order by x->>'created_at' desc) from (
                select jsonb_build_object('id', i.id, 'month', i.month, 'file', i.file_name, 'total', i.rows_total, 'ok', i.rows_ok,
                  'invoice_cents', i.invoice_cents, 'commission_cents', i.commission_cents, 'status', i.status, 'created_at', i.created_at,
                  'can_undo', i.status = 'done' and not exists (select 1 from visits v where v.import_id = i.id and v.payment_id is not null)) x
                from partner_imports i where i.partner_id = p.id order by i.created_at desc limit 12) s), '[]'::jsonb));
end $$;

create or replace function public.import_template_set(p_manager_token text, p_mapping jsonb) returns boolean
language plpgsql security definer set search_path = public as $$
declare p partners;
begin
  p := import_manager(p_manager_token);
  if p.id is null or jsonb_typeof(p_mapping) is distinct from 'object' or length(p_mapping::text) > 4000 then return false; end if;
  insert into partner_import_templates (partner_id, mapping, updated_at) values (p.id, p_mapping, now())
  on conflict (partner_id) do update set mapping = excluded.mapping, updated_at = now();
  return true;
end $$;

-- 3. Reconnaître les guides du relevé ------------------------------------------------------------------------------------
-- p_refs : [{ "code": "...", "name": "..." }] (l'un ou l'autre peut manquer) → même ordre :
-- { guide: {code, name, badge_name} | null, via: 'alias' | 'code' | 'name' | null, candidates: [...] }
-- « name » = un seul guide trouvé par le nom : à confirmer par le gérant.
create or replace function public.import_match_guides(p_manager_token text, p_refs jsonb) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare p partners; ref jsonb; out jsonb := '[]'::jsonb; k_code text; k_name text; gid uuid; via text; cands jsonb; n int;
begin
  p := import_manager(p_manager_token);
  if p.id is null or jsonb_typeof(p_refs) is distinct from 'array' or jsonb_array_length(p_refs) > 500 then return null; end if;
  for ref in select * from jsonb_array_elements(p_refs) loop
    k_code := nullif(import_key(ref->>'code'), ''); k_name := nullif(import_key(ref->>'name'), '');
    gid := null; via := null; cands := '[]'::jsonb;
    -- a) code du partenaire déjà relié (ou nom déjà relié), dans la loja ou son groupe
    select a.guide_id into gid from partner_guide_aliases a
     where a.ext_key in (coalesce(k_code, '§'), coalesce(k_name, '§'))
       and (a.partner_id = p.id or (p.group_id is not null and a.partner_id in (select id from partners where group_id = p.group_id)))
     order by (a.partner_id = p.id) desc, (a.ext_key = coalesce(k_code, '§')) desc limit 1;
    if gid is not null then via := 'alias'; end if;
    -- b) code Kombrio
    if gid is null and k_code is not null then
      select g.id into gid from guides g where upper(g.code) = k_code and g.city_id = p.city_id;
      if gid is not null then via := 'code'; end if;
    end if;
    -- c) nom (proposition à confirmer)
    if gid is null and length(coalesce(k_name, '')) >= 3 then
      select coalesce(jsonb_agg(jsonb_build_object('code', g.code, 'name', g.name, 'badge_name', g.badge_name) order by g.name), '[]'::jsonb), count(*)
        into cands, n
        from (select g.* from guides g
               where g.city_id = p.city_id and g.status = 'validated' and g.code is not null
                 and (upper(g.name) like '%' || k_name || '%' or upper(coalesce(g.badge_name, '')) like '%' || k_name || '%'
                      or k_name like '%' || upper(g.name) || '%')
               order by g.name limit 5) g;
      if n = 1 then select g.id into gid from guides g where g.code = cands->0->>'code'; via := 'name'; end if;
    end if;
    out := out || jsonb_build_array(jsonb_build_object(
      'guide', (select jsonb_build_object('code', g.code, 'name', g.name, 'badge_name', g.badge_name, 'status', g.status)
                  from guides g where g.id = gid),
      'via', via, 'candidates', cands));
  end loop;
  return out;
end $$;

-- Relier (ou délier, p_guide_code vide) un code/nom du partenaire à un guide Kombrio.
create or replace function public.import_alias_set(p_manager_token text, p_label text, p_guide_code text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p partners; k text := import_key(p_label); gid uuid;
begin
  p := import_manager(p_manager_token);
  if p.id is null then return jsonb_build_object('ok', false, 'reason', 'partner'); end if;
  if k = '' then return jsonb_build_object('ok', false, 'reason', 'label'); end if;
  if trim(coalesce(p_guide_code, '')) = '' then
    delete from partner_guide_aliases where partner_id = p.id and ext_key = k;
    perform log_event('manager', 'import_alias_removed', null, null, null, jsonb_build_object('partner', p.id, 'key', k));
    return jsonb_build_object('ok', true);
  end if;
  select g.id into gid from guides g where upper(g.code) = upper(trim(p_guide_code)) and g.city_id = p.city_id and g.status = 'validated';
  if gid is null then return jsonb_build_object('ok', false, 'reason', 'guide'); end if;
  insert into partner_guide_aliases (partner_id, ext_key, ext_label, guide_id) values (p.id, k, left(trim(p_label), 80), gid)
  on conflict (partner_id, ext_key) do update set guide_id = excluded.guide_id, ext_label = excluded.ext_label, created_at = now();
  perform log_event('manager', 'import_alias_set', null, null, null, jsonb_build_object('partner', p.id, 'key', k, 'guide', gid));
  return jsonb_build_object('ok', true);
end $$;

-- 4. Import ------------------------------------------------------------------------------------------------------------
-- p_month : un jour du mois du relevé ; p_rows : [{ line, day 'AAAA-MM-JJ', time 'HH:MM'?, ticket?, seller?, guide (code Kombrio),
--   invoice_cents, commission_cents?, people? }] (2 000 lignes au plus).
create or replace function public.import_sales(p_manager_token text, p_month date, p_file text, p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p partners; c cities; m date; today date; imp partner_imports; x jsonb; d date; tm time; gid uuid; g guides; s stays; v visits;
        r jsonb; inv bigint; com bigint; ppl int; tk text; why text; bad jsonb := '[]'::jsonb; okn int := 0; tot int := 0;
        sum_inv bigint := 0; sum_com bigint := 0;
begin
  p := import_manager(p_manager_token);
  if p.id is null then return jsonb_build_object('ok', false, 'reason', 'partner'); end if;
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) = 0 then return jsonb_build_object('ok', false, 'reason', 'empty'); end if;
  if jsonb_array_length(p_rows) > 2000 then return jsonb_build_object('ok', false, 'reason', 'too_many'); end if;
  select * into c from cities where id = p.city_id;
  today := (now() at time zone c.timezone)::date;
  m := date_trunc('month', coalesce(p_month, today))::date;
  if m > today then return jsonb_build_object('ok', false, 'reason', 'month'); end if;
  insert into partner_imports (partner_id, month, file_name) values (p.id, m, left(trim(coalesce(p_file, '')), 120)) returning * into imp;

  for x in select * from jsonb_array_elements(p_rows) loop
    tot := tot + 1; why := null;
    begin
      d := nullif(x->>'day', '')::date;
      tm := coalesce(nullif(x->>'time', '')::time, time '12:00');
      inv := nullif(x->>'invoice_cents', '')::bigint;
      com := nullif(x->>'commission_cents', '')::bigint;
      ppl := greatest(1, least(coalesce(nullif(x->>'people', '')::int, 1), 500));
      tk := nullif(left(trim(coalesce(x->>'ticket', '')), 60), '');
      if d is null then why := 'date';
      elsif date_trunc('month', d)::date <> m then why := 'other_month';
      elsif d > today then why := 'future';
      elsif inv is null or inv <= 0 or inv > 100000000 then why := 'amount';
      elsif com is not null and com < 0 then why := 'commission';
      elsif tk is not null and exists (select 1 from visits where partner_id = p.id and ext_ticket = tk and status <> 'cancelled') then why := 'duplicate';
      end if;
      if why is null then
        select guide_id, reason into gid, why from resolve_guide_ref(p.id, x->>'guide');
        if why is null and gid is null then why := 'guide'; end if;
      end if;
      if why is null then
        select * into g from guides where id = gid;
        insert into stays (guide_id, client, people, start_day, end_day, token, direct, archived_at)
        values (g.id, 'Relatório', ppl, d, d, 'C-' || md5(random()::text || clock_timestamp()::text || g.id::text), true, now())
        returning * into s;
        insert into visits (stay_id, partner_id, guide_id, people, people_served, visit_day, at, offer_given, commission_rate, platform_share,
                            direct, guide_present, mode, import_id, ext_ticket, ext_seller)
        values (s.id, p.id, g.id, ppl, ppl, d, (d + tm) at time zone c.timezone, false, p.commission_rate, 0,
                true, true, 2, imp.id, tk, nullif(left(trim(coalesce(x->>'seller', '')), 60), ''))
        returning * into v;
        r := declare_visit_ex(p_manager_token, v.id, inv, null, com, false, null, null, 'Relatório ' || to_char(m, 'MM/YYYY'));
        if not coalesce((r->>'ok')::boolean, false) then raise exception 'import_row:%', coalesce(r->>'reason', 'declare'); end if;
        select * into v from visits where id = v.id;
        okn := okn + 1; sum_inv := sum_inv + inv; sum_com := sum_com + coalesce(v.declared_cents, 0);
      end if;
    exception
      when unique_violation then why := 'duplicate';
      when invalid_datetime_format or datetime_field_overflow or invalid_text_representation or numeric_value_out_of_range then why := 'format';
      when raise_exception then why := case when sqlerrm like 'import_row:%' then split_part(sqlerrm, ':', 2) else 'error' end;
    end;
    if why is not null then
      bad := bad || jsonb_build_array(jsonb_build_object('line', x->'line', 'reason', why));
    end if;
  end loop;

  update partner_imports set rows_total = tot, rows_ok = okn, invoice_cents = sum_inv, commission_cents = sum_com,
         status = case when okn = 0 then 'cancelled' else 'done' end
  where id = imp.id;
  perform log_event('manager', 'import_sales', null, null, null, jsonb_build_object('partner', p.id, 'import', imp.id, 'month', m,
    'file', imp.file_name, 'total', tot, 'ok', okn, 'invoice', sum_inv, 'commission', sum_com));
  return jsonb_build_object('ok', true, 'import_id', imp.id, 'total', tot, 'imported', okn, 'invoice_cents', sum_inv,
    'commission_cents', sum_com, 'rejected', bad);
end $$;

-- Annuler un import (rien ne doit être payé ni en cours de vérification).
create or replace function public.import_undo(p_manager_token text, p_import uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p partners; imp partner_imports; n int;
begin
  p := import_manager(p_manager_token);
  if p.id is null then return jsonb_build_object('ok', false, 'reason', 'partner'); end if;
  select * into imp from partner_imports where id = p_import and partner_id = p.id and status = 'done' for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'import'); end if;
  if exists (select 1 from visits where import_id = imp.id and (payment_id is not null or status not in ('visited', 'declared', 'zero'))) then
    return jsonb_build_object('ok', false, 'reason', 'paid'); end if;
  update visits set prev_status = status, status = 'cancelled', status_note = 'import annulé'
   where import_id = imp.id and status <> 'cancelled';
  get diagnostics n = row_count;
  update partner_imports set status = 'cancelled' where id = imp.id;
  perform log_event('manager', 'import_undone', null, null, null, jsonb_build_object('partner', p.id, 'import', imp.id, 'visits', n));
  return jsonb_build_object('ok', true, 'cancelled', n);
end $$;

grant execute on function public.import_space(text), public.import_template_set(text, jsonb), public.import_match_guides(text, jsonb),
  public.import_alias_set(text, text, text), public.import_sales(text, date, text, jsonb), public.import_undo(text, uuid)
  to anon, authenticated;
