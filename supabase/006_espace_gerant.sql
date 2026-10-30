-- Kombrio v12 : la caisse et la gestion sont séparées.
-- QR de caisse (token)        : relier un téléphone, enregistrer les passages, voir l'offre à accorder.
-- Lien gérant (manager_token) : déclarer et payer, historique, offre, relevés, lien du comptable.
alter table partners add column if not exists manager_token text unique;
update partners set manager_token = 'G-' || replace(gen_random_uuid()::text, '-', '') where manager_token is null;

-- Espace du partenaire : complet avec le lien gérant, réduit (24 h, sans les liens secrets) avec le QR de caisse.
create or replace function public.partner_space(p_token text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'role', case when p.manager_token = p_token then 'manager' else 'counter' end,
    'partner', case when p.manager_token = p_token then to_jsonb(p)
                    else to_jsonb(p) - 'manager_token' - 'report_token' - 'tax_id' end,
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

-- Passage : le téléphone peut être relié par le QR de caisse ou par le lien gérant.
create or replace function public.record_visit(p_stay_token text, p_partner_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  s stays; g guides; p partners; c cities; v visits; had_offer boolean;
begin
  select * into p from partners where (token = p_partner_token or manager_token = p_partner_token) and status = 'active';
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

-- Déclarer et payer : réservé au lien gérant.
create or replace function public.declare_visit(p_partner_token text, p_visit uuid, p_amount numeric, p_method text, p_receipt text)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if p_amount is null or p_amount <= 0 then return false; end if;
  update visits v set status = 'declared', amount = p_amount, method = p_method, receipt = p_receipt,
         declared_at = now(), rejected = false
  from partners p
  where p.manager_token = p_partner_token and v.partner_id = p.id and v.id = p_visit and v.status = 'visited';
  return found;
end $$;

-- Changer l'offre : réservé au lien gérant.
create or replace function public.set_partner_offer(p_token text, p_offer text) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  update partners set offer = nullif(trim(p_offer), '') where manager_token = p_token;
  return found;
end $$;

-- Lien du comptable : réservé au lien gérant.
create or replace function public.renew_report_token(p_partner_token text) returns text
language plpgsql security definer set search_path = public as $$
declare t text := 'R-' || replace(gen_random_uuid()::text, '-', '');
begin
  update partners set report_token = t where manager_token = p_partner_token and status = 'active';
  if not found then return null; end if;
  return t;
end $$;
