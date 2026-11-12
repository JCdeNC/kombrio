-- Kombrio v64 (décision de JC du 12/11/2026) : inscription simple du guide.
--   1. CPF OBLIGATOIRE : identification du guide (avec le Cadastur, vérifié par Kombrio).
--   2. Clé Pix : pour recevoir les commissions.
--   3. CNPJ FACULTATIF : si le guide veut recevoir ses commissions dans le cadre de son entreprise (MEI, etc.).
--      Avec un CNPJ, le guide est payé « en CNPJ » (pas de retenue INSS) ; sans CNPJ, il est payé en CPF
--      et Kombrio retient l'INSS comme la loi l'impose à l'entreprise qui paie. Le reste de sa fiscalité lui appartient.
-- Avant : guides.cpf contenait « CPF ou CNPJ ». Maintenant : guides.cpf = toujours le CPF, guides.cnpj = le CNPJ (facultatif).
-- Les guides déjà inscrits avec un CNPJ : le CNPJ passe dans guides.cnpj ; leur CPF leur sera demandé dans « Minha conta ».
-- À lancer une fois dans Supabase › SQL Editor. Peut être relancé sans danger.

alter table guides add column if not exists cnpj text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'guides_cnpj_format') then
    alter table guides add constraint guides_cnpj_format check (cnpj is null or cnpj ~ '^[0-9]{14}$');
  end if;
end $$;

-- Rattrapage : un CNPJ rangé dans la colonne cpf part dans la colonne cnpj.
alter table guides drop constraint if exists guides_tax_id_length;
update guides set cnpj = cpf, cpf = null where cpf ~ '^[0-9]{14}$' and cnpj is null;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'guides_cpf_format') then
    alter table guides add constraint guides_cpf_format check (cpf is null or cpf ~ '^[0-9]{11}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'guides_cnpj_kind') then
    alter table guides add constraint guides_cnpj_kind check (tax_kind <> 'cnpj' or cnpj is not null);
  end if;
end $$;
comment on column guides.cpf is 'CPF du guide (11 chiffres), obligatoire à l''inscription. Jamais affiché en public.';
comment on column guides.cnpj is 'CNPJ facultatif (14 chiffres) : s''il est donné, le guide est payé en CNPJ (tax_kind = cnpj).';

-- Inscription : CPF obligatoire, CNPJ facultatif. tax_kind = cnpj seulement si un CNPJ est donné.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  m jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  r text;
  typed text := regexp_replace(upper(coalesce(m->>'code', '')), '[^A-Z0-9]', '', 'g');
  v_ref text := regexp_replace(upper(coalesce(m->>'ref_code', '')), '[^A-Z0-9]', '', 'g');
  v_cpf text := nullif(regexp_replace(coalesce(m->>'cpf', ''), '[^0-9]', '', 'g'), '');
  v_cnpj text := nullif(regexp_replace(coalesce(m->>'cnpj', ''), '[^0-9]', '', 'g'), '');
  v_pix text := nullif(trim(m->>'pix_key'), '');
  v_kind text;
  v_holder text := nullif(trim(regexp_replace(coalesce(m->>'pix_holder', ''), '\s+', ' ', 'g')), '');
  v_ptype text := case when m->>'pix_type' in ('cpf', 'cnpj', 'phone', 'email', 'random') then m->>'pix_type' end;
  parrain guides;
begin
  if m->>'role' = 'partner' then
    update partners set manager_user = new.id, manager_name = nullif(trim(m->>'name'), ''),
           manager_phone = nullif(trim(m->>'phone'), ''), manager_email = new.email,
           terms_version = nullif(m->>'terms', ''), terms_accepted_at = now(), activation_code = null
    where manager_user is null and status = 'active' and activation_code is not null and typed <> ''
      and (regexp_replace(activation_code, '[^A-Z0-9]', '', 'g') = typed
           or (typed ~ '^[0-9]{5}$' and right(activation_code, 5) = typed));
    if not found then raise exception 'activation_code'; end if;
    insert into profiles (id, role) values (new.id, 'partner');
    return new;
  end if;
  r := case when m->>'role' = 'admin' and not exists (select 1 from profiles where role = 'admin') then 'admin' else 'guide' end;
  insert into profiles (id, role) values (new.id, r);
  if r = 'guide' then
    -- Ancienne version de l'app (case « CNPJ » cochée, numéro dans le champ cpf) : on range le CNPJ au bon endroit.
    if m->>'tax_kind' = 'cnpj' and v_cnpj is null and v_cpf ~ '^[0-9]{14}$' then v_cnpj := v_cpf; v_cpf := null; end if;
    if v_cpf is not null and v_cpf !~ '^[0-9]{11}$' then raise exception 'tax_id'; end if;
    if v_cnpj is not null and v_cnpj !~ '^[0-9]{14}$' then raise exception 'tax_id'; end if;
    v_kind := case when v_cnpj is not null then 'cnpj' else 'cpf' end;
    -- Parrain : guide validé, parrainage activé, pas le même CPF ni la même clé Pix.
    if v_ref <> '' then
      select * into parrain from guides g
      where g.status = 'validated' and g.referral_enabled and g.code is not null
        and (regexp_replace(g.code, '[^A-Z0-9]', '', 'g') = v_ref or (v_ref ~ '^[0-9]{5}$' and right(g.code, 5) = v_ref))
        and (v_cpf is null or g.cpf is distinct from v_cpf) and (v_pix is null or g.pix_key is distinct from v_pix)
      limit 1;
    end if;
    insert into guides (id, city_id, name, phone, license, email, cpf, cnpj, tax_kind, pix_key, pix_key_type, pix_holder, referred_by)
    values (new.id, coalesce(m->>'city_id', 'rio'), coalesce(nullif(m->>'name', ''), new.email), m->>'phone', m->>'license', new.email,
            v_cpf, v_cnpj, v_kind, v_pix, v_ptype, left(v_holder, 120), parrain.id);
    if parrain.id is not null then
      insert into ledger (actor, actor_kind, event, data)
      values (new.id, 'guide', 'referral_signup', jsonb_build_object('parrain', parrain.id, 'code', parrain.code));
    end if;
  end if;
  return new;
end $$;

-- « Minha conta » : le guide complète son CPF (s'il manque) et ajoute, change ou retire son CNPJ.
-- Le changement CPF ↔ CNPJ est gardé dans l'historique fiscal (trigger guides_tax_history) : il vaut pour les virements suivants.
create or replace function public.set_my_tax_ids(p_cpf text, p_cnpj text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare g guides; c text := nullif(regexp_replace(coalesce(p_cpf, ''), '[^0-9]', '', 'g'), '');
        j text := nullif(regexp_replace(coalesce(p_cnpj, ''), '[^0-9]', '', 'g'), '');
begin
  select * into g from guides where id = auth.uid() for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'guide'); end if;
  if c is not null and c !~ '^[0-9]{11}$' then return jsonb_build_object('ok', false, 'reason', 'cpf'); end if;
  if j is not null and j !~ '^[0-9]{14}$' then return jsonb_build_object('ok', false, 'reason', 'cnpj'); end if;
  -- Le CPF ne se change pas une fois donné (identité) : seulement le compléter s'il manque.
  if g.cpf is not null and c is not null and c <> g.cpf then return jsonb_build_object('ok', false, 'reason', 'cpf_locked'); end if;
  if coalesce(g.cpf, c) is null then return jsonb_build_object('ok', false, 'reason', 'cpf_required'); end if;
  update guides set cpf = coalesce(g.cpf, c), cnpj = j, tax_kind = case when j is not null then 'cnpj' else 'cpf' end where id = g.id;
  perform log_event('guide', 'tax_ids_changed', null, null, null,
    jsonb_build_object('cpf_added', g.cpf is null and c is not null, 'cnpj', case when j is null then 'removed' when g.cnpj is distinct from j then 'set' else 'same' end));
  return jsonb_build_object('ok', true, 'tax_kind', case when j is not null then 'cnpj' else 'cpf' end);
end $$;
grant execute on function public.set_my_tax_ids(text, text) to authenticated;
revoke execute on function public.set_my_tax_ids(text, text) from anon;

-- Relevé d'un virement : le numéro fiscal affiché suit le mode de paiement (CNPJ si payé en CNPJ, sinon CPF).
do $$ declare src text; begin
  select pg_get_functiondef('public.payout_statement(uuid)'::regprocedure) into src;
  if src not like '%''cnpj'', g.cnpj%' then
    src := replace(src, '''tax_id'', g.cpf, ''tax_kind'', g.tax_kind',
      '''tax_id'', case when g.tax_kind = ''cnpj'' then coalesce(g.cnpj, g.cpf) else g.cpf end, ''cpf'', g.cpf, ''cnpj'', g.cnpj, ''tax_kind'', g.tax_kind');
    execute src;
  end if;
end $$;

insert into ledger (actor_kind, event, data) values ('system', 'cpf_required_cnpj_optional_installed', jsonb_build_object('version', 'v64'));
select tax_kind, count(*) as guides, count(*) filter (where cpf is null) as sans_cpf from guides group by tax_kind;
