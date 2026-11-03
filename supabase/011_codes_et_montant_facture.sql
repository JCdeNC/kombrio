-- Kombrio v17 : codes ville (IATA) + KP (partenaire) / KG (guide), montant de la facture saisi par le partenaire,
-- suspension des partenaires qui ne paient pas (J+30).

------------------------------------------------------------------------------------------------
-- Codes
------------------------------------------------------------------------------------------------
alter table cities add column if not exists code text;
update cities set code = 'RIO' where id = 'rio' and code is null;
create unique index if not exists cities_code_key on cities (code);
alter table cities drop constraint if exists cities_code_check;
alter table cities add constraint cities_code_check check (code is null or code ~ '^[A-Z]{3}$');

alter table guides add column if not exists code text;
create unique index if not exists guides_code_key on guides (code);

-- Code à 5 chiffres : VILLE-KP-12345 (partenaire) ou VILLE-KG-12345 (guide). Les 5 chiffres sont uniques par type.
create or replace function public.make_code(p_city text, p_kind text) returns text
language plpgsql security definer set search_path = public as $$
declare pre text; n text; tries int := 0;
begin
  select coalesce(code, 'KBR') into pre from cities where id = p_city;
  pre := coalesce(pre, 'KBR');
  loop
    n := lpad((10000 + floor(random() * 90000))::int::text, 5, '0');
    exit when not exists (
      select 1 from partners where p_kind = 'KP' and right(coalesce(activation_code, ''), 5) = n
      union all select 1 from guides where p_kind = 'KG' and right(coalesce(code, ''), 5) = n);
    tries := tries + 1;
    if tries > 50 then raise exception 'plus de codes libres'; end if;
  end loop;
  return pre || '-' || p_kind || '-' || n;
end $$;
revoke execute on function public.make_code(text, text) from public, anon, authenticated;

-- Le guide reçoit son code KG quand l'administrateur le valide.
create or replace function public.guide_code_on_validate() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'validated' and new.code is null then new.code := make_code(new.city_id, 'KG'); end if;
  return new;
end $$;
drop trigger if exists guides_code on guides;
create trigger guides_code before insert or update on guides for each row execute function public.guide_code_on_validate();
update guides set code = make_code(city_id, 'KG') where status = 'validated' and code is null;

-- Code d'activation d'un partenaire (administrateur).
create or replace function public.new_activation_code(p_partner uuid) returns text
language plpgsql security definer set search_path = public as $$
declare c text;
begin
  if not is_admin() then raise exception 'réservé à l''administrateur'; end if;
  select make_code(city_id, 'KP') into c from partners where id = p_partner and manager_user is null;
  if c is null then return null; end if;
  update partners set activation_code = c where id = p_partner;
  return c;
end $$;
grant execute on function public.new_activation_code(uuid) to authenticated;

-- Création de compte : le gérant peut taper le code complet (avec ou sans tirets) ou seulement les 5 chiffres.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  m jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  r text;
  typed text := regexp_replace(upper(coalesce(m->>'code', '')), '[^A-Z0-9]', '', 'g');
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
    insert into guides (id, city_id, name, phone, license, email, cpf, pix_key)
    values (new.id, coalesce(m->>'city_id', 'rio'), coalesce(nullif(m->>'name', ''), new.email), m->>'phone', m->>'license', new.email,
            nullif(regexp_replace(coalesce(m->>'cpf', ''), '[^0-9]', '', 'g'), ''), nullif(trim(m->>'pix_key'), ''));
  end if;
  return new;
end $$;

-- Code de ville modifiable (administrateur).
create or replace function public.set_city_code(p_city text, p_code text) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'réservé à l''administrateur'; end if;
  update cities set code = upper(trim(p_code)) where id = p_city;
  return found;
exception when unique_violation or check_violation then return false;
end $$;
grant execute on function public.set_city_code(text, text) to authenticated;

------------------------------------------------------------------------------------------------
-- Montant de la facture : le partenaire saisit la facture, la commission = facture × son taux.
------------------------------------------------------------------------------------------------
alter table visits add column if not exists invoice_cents bigint check (invoice_cents >= 0);
alter table visits add column if not exists commission_rate numeric;

create or replace function public.declare_commissions(p_manager_token text, p_items jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare p partners; it jsonb; vid uuid; inv bigint; com bigint; n int := 0;
begin
  select * into p from partners where manager_token = p_manager_token and status = 'active';
  if not found then return 0; end if;
  for it in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    vid := (it->>'visit')::uuid;
    inv := (it->>'cents')::bigint;
    if inv is null or inv < 0 then continue; end if;
    com := round(inv * p.commission_rate)::bigint;
    update visits set invoice_cents = inv, commission_rate = p.commission_rate, declared_cents = com, declared_at = now(),
           status = case when com = 0 then 'zero' else 'declared' end
    where id = vid and partner_id = p.id and status = 'visited';
    if found then
      n := n + 1;
      perform log_event('manager', 'commission_declared', vid, null, null,
        jsonb_build_object('invoice', inv, 'rate', p.commission_rate, 'cents', com));
    end if;
  end loop;
  return n;
end $$;
grant execute on function public.declare_commissions(text, jsonb) to anon, authenticated;

------------------------------------------------------------------------------------------------
-- Partenaires en retard : suspension à J+30 après la déclaration, tant qu'aucun paiement n'est envoyé.
------------------------------------------------------------------------------------------------
create or replace function public.suspend_late_partners() returns int
language plpgsql security definer set search_path = public as $$
declare n int := 0; x record;
begin
  if not is_admin() then raise exception 'réservé à l''administrateur'; end if;
  for x in select distinct partner_id from visits
           where status = 'declared' and declared_at < now() - interval '30 days' loop
    update partners set status = 'paused' where id = x.partner_id and status = 'active';
    if found then
      n := n + 1;
      perform log_event('admin', 'partner_suspended_late', null, null, null, jsonb_build_object('partner', x.partner_id));
    end if;
  end loop;
  return n;
end $$;
grant execute on function public.suspend_late_partners() to authenticated;
