-- Kombrio v13 : compte du gérant. Lien unique https://app.kombrio.com.br/partner/
-- Premier accès : code d'activation (donné par Kombrio) + responsable + e-mail + mot de passe + conditions générales.
alter table profiles drop constraint if exists profiles_role_check;
alter table profiles add constraint profiles_role_check check (role in ('guide', 'admin', 'partner'));

alter table partners add column if not exists activation_code text unique;
alter table partners add column if not exists manager_user uuid references auth.users on delete set null;
alter table partners add column if not exists manager_name text;
alter table partners add column if not exists manager_phone text;
alter table partners add column if not exists manager_email text;
alter table partners add column if not exists terms_version text;
alter table partners add column if not exists terms_accepted_at timestamptz;

-- Création d'un compte : guide (par défaut), premier administrateur, ou gérant de partenaire (avec code d'activation).
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  m jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  r text;
begin
  if m->>'role' = 'partner' then
    update partners set manager_user = new.id, manager_name = nullif(trim(m->>'name'), ''),
           manager_phone = nullif(trim(m->>'phone'), ''), manager_email = new.email,
           terms_version = nullif(m->>'terms', ''), terms_accepted_at = now(), activation_code = null
    where activation_code = upper(trim(m->>'code')) and manager_user is null and status = 'active';
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

-- Le gérant connecté retrouve son espace.
create or replace function public.my_partner_token() returns text
language sql stable security definer set search_path = public as $$
  select manager_token from partners where manager_user = auth.uid() and status = 'active' limit 1
$$;
grant execute on function public.my_partner_token() to authenticated;

-- La caisse ne voit jamais les données du gérant.
create or replace function public.partner_space(p_token text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'role', case when p.manager_token = p_token then 'manager' else 'counter' end,
    'partner', case when p.manager_token = p_token then to_jsonb(p)
                    else to_jsonb(p) - 'manager_token' - 'report_token' - 'tax_id' - 'activation_code' - 'manager_user'
                         - 'manager_name' - 'manager_phone' - 'manager_email' end,
    'city', to_jsonb(c),
    'visits', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', v.id, 'stay_id', v.stay_id, 'partner_id', v.partner_id, 'guide_id', v.guide_id, 'at', v.at,
        'people', v.people, 'offer_given', v.offer_given, 'status', v.status, 'amount', v.amount,
        'method', v.method, 'rejected', v.rejected, 'declared_at', v.declared_at,
        'client', s.client, 'guide_name', g.name) order by v.at desc)
      from visits v join stays s on s.id = v.stay_id join guides g on g.id = v.guide_id
      where v.partner_id = p.id and (p.manager_token = p_token or v.at > now() - interval '24 hours')), '[]'::jsonb))
  from partners p join cities c on c.id = p.city_id
  where p_token is not null and (p.token = p_token or p.manager_token = p_token)
$$;
