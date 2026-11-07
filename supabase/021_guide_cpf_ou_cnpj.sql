-- Kombrio v42 (demande de JC du 07/11/2026) : un guide s'inscrit avec un CPF (pessoa física) ou un CNPJ (empresa, ex. MEI).
-- Le numéro (11 ou 14 chiffres) reste dans la colonne guides.cpf, qui contient désormais « CPF ou CNPJ » ;
-- guides.tax_kind dit lequel. Les guides déjà inscrits restent en CPF. Le numéro Cadastur reste un champ à part
-- (attribué par le Ministère du Tourisme). Aucun de ces numéros n'est jamais affiché en public.
-- À lancer une fois dans Supabase › SQL Editor. Peut être relancé sans danger.

alter table guides add column if not exists tax_kind text not null default 'cpf';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'guides_tax_kind_check') then
    alter table guides add constraint guides_tax_kind_check check (tax_kind in ('cpf', 'cnpj'));
  end if;
  -- L'ancienne règle « 11 chiffres seulement » est remplacée par la règle CPF ou CNPJ ci-dessous.
  alter table guides drop constraint if exists guides_cpf_check;
  if not exists (select 1 from pg_constraint where conname = 'guides_tax_id_length') then
    alter table guides add constraint guides_tax_id_length check (
      cpf is null or (tax_kind = 'cpf' and cpf ~ '^[0-9]{11}$') or (tax_kind = 'cnpj' and cpf ~ '^[0-9]{14}$'));
  end if;
end $$;
comment on column guides.cpf is 'CPF (11 chiffres) ou CNPJ (14 chiffres) du guide, selon tax_kind. Jamais affiché en public.';

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
    insert into guides (id, city_id, name, phone, license, email, cpf, tax_kind, pix_key, referred_by)
    values (new.id, coalesce(m->>'city_id', 'rio'), coalesce(nullif(m->>'name', ''), new.email), m->>'phone', m->>'license', new.email,
            v_cpf, v_kind, v_pix, parrain.id);
    if parrain.id is not null then
      insert into ledger (actor, actor_kind, event, data)
      values (new.id, 'guide', 'referral_signup', jsonb_build_object('parrain', parrain.id, 'code', parrain.code));
    end if;
  end if;
  return new;
end $$;

insert into ledger (actor_kind, event, data) values ('system', 'guide_cnpj_installed', jsonb_build_object('version', 'v42'));
select tax_kind, count(*) as guides from guides group by tax_kind;
