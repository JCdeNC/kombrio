-- Kombrio v144 (25/11/2026, lot J, décisions de JC) : CONTADORES PARCEIROS — un lien de parrainage, sans prime.
-- Kombrio ne paie rien aux comptables. Un comptable s'inscrit (nom, cabinet, CRC, e-mail), Kombrio le valide ;
-- il reçoit alors son lien / QR de parrainage (#/parceria/CT-XXXXXX) et le lien secret de son espace (#/a/A-…).
-- L'établissement qui s'inscrit par ce lien est rattaché au comptable ; une case (cochée d'office) partage son relevé
-- mensuel avec lui. Un établissement déjà inscrit peut aussi entrer le code de son comptable, couper le partage ou le retirer.
-- L'espace du comptable : ses établissements et, s'ils partagent, leur relevé du mois (lecture seule). Rien d'autre.
-- Jamais d'accès aux réglages, aux paiements ni aux données des guides. Peut être relancé sans danger.

-- 1. Tables et colonnes -------------------------------------------------------------------------------------------------
create table if not exists accountants (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 2 and 120),
  firm text not null default '' check (length(firm) <= 120),
  crc text not null check (length(trim(crc)) between 3 and 30),
  email text not null check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' and length(email) <= 160),
  phone text not null default '' check (length(phone) <= 30),
  lang text not null default 'pt',
  status text not null default 'pending' check (status in ('pending', 'active', 'refused')),
  ref_code text unique,
  space_token text unique,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
create unique index if not exists accountants_email on accountants (lower(email));
alter table accountants enable row level security;   -- aucun accès direct : seulement par les fonctions ci-dessous

alter table partners add column if not exists accountant_id uuid references accountants(id) on delete set null;
alter table partners add column if not exists accountant_share boolean not null default false;

-- 2. Inscription du comptable (page publique, sans compte) ------------------------------------------------------------
create or replace function public.accountant_signup(p_name text, p_firm text, p_crc text, p_email text, p_phone text, p_lang text default 'pt') returns jsonb
language plpgsql security definer set search_path = public as $$
declare e text := lower(trim(coalesce(p_email, ''))); v_id uuid;
begin
  if length(trim(coalesce(p_name, ''))) < 2 then return jsonb_build_object('ok', false, 'reason', 'name'); end if;
  if length(trim(coalesce(p_crc, ''))) < 3 then return jsonb_build_object('ok', false, 'reason', 'crc'); end if;
  if e !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then return jsonb_build_object('ok', false, 'reason', 'email'); end if;
  if exists (select 1 from accountants where lower(email) = e) then return jsonb_build_object('ok', true, 'already', true); end if;
  if (select count(*) from accountants where status = 'pending' and created_at > now() - interval '1 hour') >= 30 then
    return jsonb_build_object('ok', false, 'reason', 'quota'); end if;
  insert into accountants (name, firm, crc, email, phone, lang)
  values (left(trim(p_name), 120), left(trim(coalesce(p_firm, '')), 120), left(trim(p_crc), 30), e, left(trim(coalesce(p_phone, '')), 30),
          case when p_lang in ('pt', 'fr') then p_lang else 'pt' end)
  returning id into v_id;
  perform log_event('system', 'accountant_signup', null, null, null, jsonb_build_object('accountant', v_id));
  -- L'admin le voit dans l'onglet « Comptables » (pastille du nombre à valider).
  return jsonb_build_object('ok', true);
end $$;
grant execute on function public.accountant_signup(text, text, text, text, text, text) to anon, authenticated;

-- 3. Page d'inscription de l'établissement : qui le recommande (comptable validé seulement) --------------------------
create or replace function public.accountant_ref_info(p_code text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('name', a.name, 'firm', a.firm)
  from accountants a where p_code is not null and a.ref_code = upper(trim(p_code)) and a.status = 'active'
$$;
grant execute on function public.accountant_ref_info(text) to anon, authenticated;

-- 4. Établissement inscrit par le lien : rattaché au comptable (lu dans les données de l'inscription) ----------------
create or replace function public.partner_accountant_from_signup() returns trigger
language plpgsql security definer set search_path = public as $$
declare m jsonb; a uuid;
begin
  if new.manager_user is null or new.accountant_id is not null then return new; end if;
  select raw_user_meta_data into m from auth.users where id = new.manager_user;
  if coalesce(m->>'accountant_ref', '') = '' then return new; end if;
  select id into a from accountants where ref_code = upper(trim(m->>'accountant_ref')) and status = 'active';
  if a is not null then
    new.accountant_id := a;
    new.accountant_share := coalesce((m->>'accountant_share')::boolean, true);
  end if;
  return new;
exception when others then return new;   -- ne bloque jamais une inscription
end $$;
drop trigger if exists partners_accountant_from_signup on partners;
create trigger partners_accountant_from_signup before insert on partners for each row execute function public.partner_accountant_from_signup();

-- 5. Côté gérant : voir son comptable, entrer un code, couper le partage, retirer -----------------------------------
create or replace function public.partner_accountant(p_manager_token text) returns jsonb
language sql stable security definer set search_path = public as $$
  select case when p.id is null then null else jsonb_build_object('ok', true, 'share', p.accountant_share,
    'accountant', (select jsonb_build_object('name', a.name, 'firm', a.firm, 'crc', a.crc) from accountants a where a.id = p.accountant_id)) end
  from partners p where p_manager_token is not null and p.manager_token = p_manager_token and p.status in ('active', 'pending')
$$;
grant execute on function public.partner_accountant(text) to anon, authenticated;

create or replace function public.partner_accountant_set(p_manager_token text, p_code text, p_share boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p partners; a accountants;
begin
  select * into p from partners where p_manager_token is not null and manager_token = p_manager_token and status in ('active', 'pending');
  if not found then return jsonb_build_object('ok', false, 'reason', 'partner'); end if;
  if p_code is not null and trim(p_code) = '' then   -- retirer le comptable
    update partners set accountant_id = null, accountant_share = false where id = p.id;
    perform log_event('manager', 'accountant_removed', null, null, null, jsonb_build_object('partner', p.id, 'accountant', p.accountant_id));
    return jsonb_build_object('ok', true);
  end if;
  if p_code is not null then
    select * into a from accountants where ref_code = upper(trim(p_code)) and status = 'active';
    if not found then return jsonb_build_object('ok', false, 'reason', 'code'); end if;
    update partners set accountant_id = a.id, accountant_share = coalesce(p_share, true) where id = p.id;
    perform log_event('manager', 'accountant_linked', null, null, null, jsonb_build_object('partner', p.id, 'accountant', a.id));
    return jsonb_build_object('ok', true);
  end if;
  if p.accountant_id is null then return jsonb_build_object('ok', false, 'reason', 'none'); end if;
  update partners set accountant_share = coalesce(p_share, false) where id = p.id;
  perform log_event('manager', 'accountant_share', null, null, null, jsonb_build_object('partner', p.id, 'share', coalesce(p_share, false)));
  return jsonb_build_object('ok', true);
end $$;
grant execute on function public.partner_accountant_set(text, text, boolean) to anon, authenticated;

-- 6. Espace du comptable (lien secret A-…) ------------------------------------------------------------------------------
create or replace function public.accountant_space(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a accountants;
begin
  select * into a from accountants where p_token is not null and p_token like 'A-%' and space_token = p_token and status = 'active';
  if not found then return null; end if;
  -- Relevé partagé sans lien encore créé : on le crée (même format que « renew_report_token »).
  update partners set report_token = 'R-' || replace(gen_random_uuid()::text, '-', '')
   where accountant_id = a.id and accountant_share and status = 'active' and report_token is null;
  return jsonb_build_object(
    'accountant', jsonb_build_object('name', a.name, 'firm', a.firm, 'ref_code', a.ref_code),
    'partners', coalesce((select jsonb_agg(jsonb_build_object('name', p.name, 'type', p.type, 'area', p.area, 'status', p.status,
                  'share', p.accountant_share, 'report_token', case when p.accountant_share and p.status = 'active' then p.report_token end)
                  order by p.name) from partners p where p.accountant_id = a.id), '[]'::jsonb));
end $$;
grant execute on function public.accountant_space(text) to anon, authenticated;

-- 7. Administration : liste, validation (e-mail avec les deux liens), refus -------------------------------------------
create or replace function public.admin_accountants() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'réservé à l''administrateur'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'firm', a.firm, 'crc', a.crc, 'email', a.email, 'phone', a.phone,
           'status', a.status, 'ref_code', a.ref_code, 'space_token', a.space_token, 'created_at', a.created_at,
           'partners', (select coalesce(jsonb_agg(jsonb_build_object('name', p.name, 'status', p.status, 'share', p.accountant_share) order by p.name), '[]'::jsonb)
                          from partners p where p.accountant_id = a.id))
         order by case a.status when 'pending' then 0 when 'active' then 1 else 2 end, a.created_at desc) from accountants a), '[]'::jsonb);
end $$;
grant execute on function public.admin_accountants() to authenticated;

create or replace function public.admin_accountant_decide(p_id uuid, p_status text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a accountants; code text; tok text; i int := 0;
begin
  if not is_admin() then raise exception 'réservé à l''administrateur'; end if;
  if p_status not in ('active', 'refused') then return jsonb_build_object('ok', false, 'reason', 'status'); end if;
  select * into a from accountants where id = p_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'accountant'); end if;
  if p_status = 'active' then
    code := a.ref_code;
    while code is null loop
      code := 'CT-' || upper(substr(translate(md5(random()::text || clock_timestamp()::text), '0123456789abcdef', 'BCDFGHJKLMNPQRST'), 1, 6));
      if exists (select 1 from accountants where ref_code = code) then code := null; end if;
      i := i + 1; if i > 20 then raise exception 'ref_code'; end if;
    end loop;
    tok := coalesce(a.space_token, 'A-' || replace(gen_random_uuid()::text, '-', ''));
    update accountants set status = 'active', ref_code = code, space_token = tok, decided_at = now() where id = a.id;
    if a.status <> 'active' then
      begin
        perform queue_mail('broadcast', a.email, jsonb_build_object('lang', a.lang, 'level', 'info', 'name', split_part(a.name, ' ', 1), 'app', 'partner',
          'title', case when a.lang = 'fr' then 'Votre accès de comptable partenaire' else 'Seu acesso de contador parceiro' end,
          'body', case when a.lang = 'fr' then
              'Kombrio a validé votre inscription.' || E'\n\n' ||
              'Votre lien de parrainage, à envoyer à vos clients (restaurants, boutiques, agences) : https://app.kombrio.com.br/partner/#/parceria/' || code || E'\n\n' ||
              'Votre espace (gardez ce lien pour vous) : https://app.kombrio.com.br/partner/#/a/' || tok || E'\n\n' ||
              'Les établissements inscrits par votre lien peuvent partager avec vous leur relevé du mois, en lecture seule.'
            else
              'A Kombrio validou o seu cadastro.' || E'\n\n' ||
              'Seu link de indicação, para enviar aos seus clientes (restaurantes, lojas, agências): https://app.kombrio.com.br/partner/#/parceria/' || code || E'\n\n' ||
              'Seu espaço (guarde este link só para você): https://app.kombrio.com.br/partner/#/a/' || tok || E'\n\n' ||
              'Os estabelecimentos cadastrados pelo seu link podem compartilhar com você o relatório do mês, só para leitura.' end));
      exception when others then null;
      end;
    end if;
  else
    update accountants set status = 'refused', decided_at = now() where id = a.id;
    update partners set accountant_share = false where accountant_id = a.id;
  end if;
  perform log_event('admin', 'accountant_' || p_status, null, null, null, jsonb_build_object('accountant', a.id));
  return jsonb_build_object('ok', true, 'ref_code', code, 'space_token', tok);
end $$;
grant execute on function public.admin_accountant_decide(uuid, text) to authenticated;
