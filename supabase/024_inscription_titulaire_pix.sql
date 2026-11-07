-- Kombrio v47 (demande de JC du 07/11/2026) : page d'inscription du guide refaite.
--   1. Le guide donne le NOM DU TITULAIRE de sa clé Pix (tel qu'il apparaît dans la banque) et le type de clé.
--   2. Le numéro Cadastur peut être un numéro de 11 chiffres (guide en nom propre) ou un CNPJ (14 chiffres).
-- À lancer une fois dans Supabase › SQL Editor. Peut être relancé sans danger.

alter table guides add column if not exists pix_holder text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'guides_pix_holder_len') then
    alter table guides add constraint guides_pix_holder_len check (pix_holder is null or length(pix_holder) between 3 and 120);
  end if;
end $$;

-- Inscription : titulaire et type de la clé Pix.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  m jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  r text;
  typed text := regexp_replace(upper(coalesce(m->>'code', '')), '[^A-Z0-9]', '', 'g');
  v_ref text := regexp_replace(upper(coalesce(m->>'ref_code', '')), '[^A-Z0-9]', '', 'g');
  v_cpf text := nullif(regexp_replace(coalesce(m->>'cpf', ''), '[^0-9]', '', 'g'), '');
  v_pix text := nullif(trim(m->>'pix_key'), '');
  v_kind text := case when m->>'tax_kind' = 'cnpj' then 'cnpj' else 'cpf' end;
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
    -- Identité fiscale : CPF (11 chiffres) ou CNPJ (14 chiffres) selon la case cochée.
    if v_cpf is not null and not ((v_kind = 'cnpj' and v_cpf ~ '^[0-9]{14}$') or (v_kind = 'cpf' and v_cpf ~ '^[0-9]{11}$')) then
      raise exception 'tax_id';
    end if;
    -- Parrain : guide validé, parrainage activé, pas le même CPF/CNPJ ni la même clé Pix.
    if v_ref <> '' then
      select * into parrain from guides g
      where g.status = 'validated' and g.referral_enabled and g.code is not null
        and (regexp_replace(g.code, '[^A-Z0-9]', '', 'g') = v_ref or (v_ref ~ '^[0-9]{5}$' and right(g.code, 5) = v_ref))
        and (v_cpf is null or g.cpf is distinct from v_cpf) and (v_pix is null or g.pix_key is distinct from v_pix)
      limit 1;
    end if;
    insert into guides (id, city_id, name, phone, license, email, cpf, tax_kind, pix_key, pix_key_type, pix_holder, referred_by)
    values (new.id, coalesce(m->>'city_id', 'rio'), coalesce(nullif(m->>'name', ''), new.email), m->>'phone', m->>'license', new.email,
            v_cpf, v_kind, v_pix, v_ptype, left(v_holder, 120), parrain.id);
    if parrain.id is not null then
      insert into ledger (actor, actor_kind, event, data)
      values (new.id, 'guide', 'referral_signup', jsonb_build_object('parrain', parrain.id, 'code', parrain.code));
    end if;
  end if;
  return new;
end $$;

-- Changement de clé Pix depuis le compte du guide : le titulaire est demandé aussi (nouvelle clé = nouvelle vérification).
create or replace function public.set_my_pix_key(p_key text, p_type text, p_holder text) returns boolean
language plpgsql security definer set search_path = public as $$
declare g guides; k text := trim(coalesce(p_key, '')); h text := trim(regexp_replace(coalesce(p_holder, ''), '\s+', ' ', 'g'));
begin
  select * into g from guides where id = auth.uid() for update;
  if not found then return false; end if;
  if length(h) < 3 or length(h) > 120 then return false; end if;
  if k = '' or p_type not in ('cpf', 'cnpj', 'phone', 'email', 'random') then return false; end if;
  -- Contrôle de forme selon le type (la banque reste juge de l'existence de la clé).
  if (p_type = 'cpf' and regexp_replace(k, '[^0-9]', '', 'g') !~ '^[0-9]{11}$')
     or (p_type = 'cnpj' and regexp_replace(k, '[^0-9]', '', 'g') !~ '^[0-9]{14}$')
     or (p_type = 'phone' and regexp_replace(k, '[^0-9+]', '', 'g') !~ '^\+?[0-9]{10,13}$')
     or (p_type = 'email' and k !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')
     or (p_type = 'random' and lower(k) !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
    return false;
  end if;
  if p_type in ('cpf', 'cnpj', 'phone') then k := regexp_replace(k, '[^0-9+]', '', 'g'); end if;
  if p_type in ('email', 'random') then k := lower(k); end if;
  if k = g.pix_key and p_type is not distinct from g.pix_key_type and h is not distinct from g.pix_holder then return true; end if;
  update pix_verifications set status = 'cancelled', admin_note = 'clé Pix modifiée par le guide'
  where guide_id = g.id and status in ('pending', 'sent') and verified_at is null;
  update guides set pix_key = k, pix_key_type = p_type, pix_holder = h, pix_key_version = g.pix_key_version + 1,
         pix_status = 'unverified', pix_verified_at = null where id = g.id;
  perform log_event('guide', 'pix_key_changed', null, null, null,
    jsonb_build_object('guide', g.id, 'from', mask_pix(g.pix_key), 'to', mask_pix(k), 'type', p_type, 'holder', h, 'version', g.pix_key_version + 1));
  return true;
end $$;
grant execute on function public.set_my_pix_key(text, text, text) to authenticated;

-- Vérification Cadastur : 11 chiffres ou CNPJ.
create or replace function public.record_cadastur_check(p_guide uuid, p_valid_until date, p_proof text,
  p_number text, p_category text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c guide_cadastur_checks; g guides; n text := upper(trim(coalesce(p_number, '')));
begin
  if not is_admin() then raise exception 'réservé à l''administrateur'; end if;
  if p_valid_until is null or p_valid_until < current_date then return jsonb_build_object('ok', false, 'reason', 'date'); end if;
  if coalesce(p_proof, '') not like 'data:image/jpeg;base64,%' then return jsonb_build_object('ok', false, 'reason', 'proof'); end if;
  -- Numéro Cadastur : 11 chiffres (ex. 19.954875.78-5, guide en nom propre) ou 14 chiffres (CNPJ, guide en société).
  n := regexp_replace(n, '[^0-9]', '', 'g');
  if n !~ '^([0-9]{11}|[0-9]{14})$' then return jsonb_build_object('ok', false, 'reason', 'number'); end if;
  -- Catégorie : facultative (lue sur le certificat officiel).
  if p_category is not null and p_category not in ('regional', 'nacional', 'internacional', 'atrativo') then
    return jsonb_build_object('ok', false, 'reason', 'category'); end if;
  select * into g from guides where id = p_guide;
  if g.id is null then return jsonb_build_object('ok', false, 'reason', 'guide'); end if;
  -- Jamais le CPF du guide à la place du numéro Cadastur (un CNPJ de 14 chiffres, lui, est accepté).
  if length(n) = 11 and g.cpf is not null and n = g.cpf then return jsonb_build_object('ok', false, 'reason', 'cpf'); end if;
  n := case when length(n) = 11 then regexp_replace(n, '^([0-9]{2})([0-9]{6})([0-9]{2})([0-9])$', '\1.\2.\3-\4')
            else regexp_replace(n, '^([0-9]{2})([0-9]{3})([0-9]{3})([0-9]{4})([0-9]{2})$', '\1.\2.\3/\4-\5') end;
  insert into guide_cadastur_checks (guide_id, valid_until, proof, checked_by, cadastur_number, category)
  values (p_guide, p_valid_until, p_proof, auth.uid(), n, p_category) returning * into c;
  update guides set cadastur_valid_until = p_valid_until, cadastur_number = n, cadastur_category = p_category, license = n where id = p_guide;
  perform log_event('admin', 'cadastur_checked', null, null, null,
    jsonb_build_object('guide', p_guide, 'check', c.id, 'num', c.num, 'valid_until', p_valid_until,
                       'cadastur_number', n, 'category', p_category));
  return jsonb_build_object('ok', true, 'id', c.id);
end $$;
grant execute on function public.record_cadastur_check(uuid, date, text, text, text) to authenticated;

insert into ledger (actor_kind, event, data) values ('system', 'signup_pix_holder_installed', jsonb_build_object('version', 'v47'));
select data from ledger where event = 'signup_pix_holder_installed' order by id desc limit 1;
