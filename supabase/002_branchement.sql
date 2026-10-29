-- Kombrio : branchement des applications (à exécuter après schema.sql).
-- Comptes guide et administrateur, et fonctions pour les pages sans compte
-- (client et partenaire), qui passent toujours par le code secret du QR.

-- Le guide garde son e-mail visible pour l'administrateur.
alter table guides add column if not exists email text;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'admin')
$$;

-- À chaque nouveau compte : profil + fiche guide (en attente de validation).
-- Le tout premier compte qui demande le rôle « admin » le reçoit ; ensuite, plus personne.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  m jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  r text;
begin
  r := case when m->>'role' = 'admin' and not exists (select 1 from profiles where role = 'admin') then 'admin' else 'guide' end;
  insert into profiles (id, role) values (new.id, r);
  if r = 'guide' then
    insert into guides (id, city_id, name, phone, license, email)
    values (new.id, coalesce(m->>'city_id', 'rio'), coalesce(nullif(m->>'name', ''), new.email), m->>'phone', m->>'license', new.email);
  end if;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
for each row execute function public.handle_new_user();

-- Liste publique des partenaires d'une ville (sans leur code secret).
create or replace function public.public_partners(p_city text)
returns table (id uuid, type text, name text, area text, offer text)
language sql stable security definer set search_path = public as $$
  select id, type, name, area, nullif(offer, '') from partners
  where city_id = p_city and status = 'active' order by name
$$;

-- Page du client et page du scan : le séjour, son guide et sa ville, à partir du QR.
create or replace function public.stay_public(p_token text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'stay', jsonb_build_object('id', s.id, 'guide_id', s.guide_id, 'client', s.client, 'people', s.people,
                               'start_day', s.start_day, 'end_day', s.end_day, 'token', s.token),
    'guide', jsonb_build_object('id', g.id, 'city_id', g.city_id, 'name', g.name, 'license', g.license,
                                'photo', g.photo, 'status', g.status),
    'city', to_jsonb(c))
  from stays s join guides g on g.id = s.guide_id join cities c on c.id = g.city_id
  where s.token = p_token
$$;

-- Le partenaire a scanné le QR du client puis son QR Partenaire.
create or replace function public.record_visit(p_stay_token text, p_partner_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  s stays; g guides; p partners; c cities; v visits; had_offer boolean;
begin
  select * into p from partners where token = p_partner_token and status = 'active';
  if not found then return jsonb_build_object('ok', false, 'reason', 'partner'); end if;
  select * into s from stays where token = p_stay_token;
  if not found then return jsonb_build_object('ok', false, 'reason', 'unknown'); end if;
  select * into g from guides where id = s.guide_id;
  select * into c from cities where id = p.city_id;
  if (now() at time zone c.timezone)::date > s.end_day then return jsonb_build_object('ok', false, 'reason', 'expired'); end if;
  if g.status <> 'validated' then return jsonb_build_object('ok', false, 'reason', 'guide'); end if;
  had_offer := exists (select 1 from visits where stay_id = s.id and partner_id = p.id and offer_given);
  insert into visits (stay_id, partner_id, guide_id, people, offer_given)
  values (s.id, p.id, s.guide_id, s.people, nullif(p.offer, '') is not null and not had_offer)
  returning * into v;
  return jsonb_build_object('ok', true, 'visit_id', v.id);
end $$;

-- Espace du partenaire : sa fiche, sa ville et ses passages.
create or replace function public.partner_space(p_token text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('partner', to_jsonb(p), 'city', to_jsonb(c), 'visits', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', v.id, 'stay_id', v.stay_id, 'partner_id', v.partner_id, 'guide_id', v.guide_id, 'at', v.at,
      'people', v.people, 'offer_given', v.offer_given, 'status', v.status, 'amount', v.amount,
      'method', v.method, 'rejected', v.rejected, 'declared_at', v.declared_at,
      'client', s.client, 'guide_name', g.name) order by v.at desc)
    from visits v join stays s on s.id = v.stay_id join guides g on g.id = v.guide_id
    where v.partner_id = p.id), '[]'::jsonb))
  from partners p join cities c on c.id = p.city_id
  where p.token = p_token
$$;

-- Déclaration de la commission avec le comprovante.
create or replace function public.declare_visit(p_partner_token text, p_visit uuid, p_amount numeric, p_method text, p_receipt text)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if p_amount is null or p_amount <= 0 then return false; end if;
  update visits v set status = 'declared', amount = p_amount, method = p_method, receipt = p_receipt,
         declared_at = now(), rejected = false
  from partners p
  where p.token = p_partner_token and v.partner_id = p.id and v.id = p_visit and v.status = 'visited';
  return found;
end $$;

-- Le partenaire change son offre (vide = rien d'affiché).
create or replace function public.set_partner_offer(p_token text, p_offer text) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  update partners set offer = nullif(trim(p_offer), '') where token = p_token;
  return found;
end $$;

-- Virement mensuel au guide (administrateur seulement).
create or replace function public.pay_guide(p_guide uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  share numeric; total numeric; pid uuid;
begin
  if not is_admin() then raise exception 'réservé à l''administrateur'; end if;
  select 1 - c.platform_share into share from guides g join cities c on c.id = g.city_id where g.id = p_guide;
  select round(sum(amount * share), 2) into total from visits where guide_id = p_guide and status = 'received';
  if total is null then return null; end if;
  insert into payouts (guide_id, amount) values (p_guide, total) returning id into pid;
  update visits set status = 'paid', payout_id = pid where guide_id = p_guide and status = 'received';
  return jsonb_build_object('id', pid, 'amount', total);
end $$;

grant execute on function public.public_partners(text), public.stay_public(text), public.record_visit(text, text),
  public.partner_space(text), public.declare_visit(text, uuid, numeric, text, text), public.set_partner_offer(text, text)
  to anon, authenticated;
grant execute on function public.pay_guide(uuid) to authenticated;

-- Deux partenaires de test, à retirer avant le pilote.
insert into partners (city_id, type, name, area, offer, token) values
  ('rio', 'restaurant', 'Restaurante Teste', 'Copacabana', 'Uma caipirinha por pessoa', 'P-' || replace(gen_random_uuid()::text, '-', '')),
  ('rio', 'shop', 'Loja Teste', 'Vidigal', null, 'P-' || replace(gen_random_uuid()::text, '-', ''));
