-- Kombrio v16 : taux de commission choisi par le partenaire, option « paiement à la semaine » du guide.
-- Taux autorisés : 5 à 15 % ou 20 % (10 % par défaut). Partage : guide 80 % / Kombrio 20 % ; option hebdo : 75 % / 25 %.

alter table partners add column if not exists commission_rate numeric not null default 0.10;
alter table partners drop constraint if exists partners_commission_rate_check;
alter table partners add constraint partners_commission_rate_check check (
  commission_rate in (0.05, 0.06, 0.07, 0.08, 0.09, 0.10, 0.11, 0.12, 0.13, 0.14, 0.15, 0.20));

alter table guides add column if not exists weekly_payout boolean not null default false;

-- Le partenaire (gérant) choisit son taux ; il s'applique aux prochains passages.
create or replace function public.set_commission_rate(p_manager_token text, p_rate numeric) returns boolean
language plpgsql security definer set search_path = public as $$
declare old numeric;
begin
  select commission_rate into old from partners where manager_token = p_manager_token and status = 'active';
  if not found then return false; end if;
  if p_rate not in (0.05, 0.06, 0.07, 0.08, 0.09, 0.10, 0.11, 0.12, 0.13, 0.14, 0.15, 0.20) then return false; end if;
  update partners set commission_rate = p_rate where manager_token = p_manager_token;
  perform log_event('manager', 'commission_rate_set', null, null, null, jsonb_build_object('from', old, 'to', p_rate));
  return true;
end $$;

-- Le guide coche ou décoche le paiement à la semaine (sa part passe à 75 %).
create or replace function public.set_weekly_payout(p_on boolean) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  update guides set weekly_payout = coalesce(p_on, false) where id = auth.uid();
  if not found then return false; end if;
  perform log_event('guide', 'weekly_payout_set', null, null, null, jsonb_build_object('on', coalesce(p_on, false)));
  return true;
end $$;

grant execute on function public.set_commission_rate(text, numeric) to anon, authenticated;
grant execute on function public.set_weekly_payout(boolean) to authenticated;

-- Encaissement : la part Kombrio est de 25 % si le guide a choisi le paiement à la semaine, sinon celle de la ville (20 %).
create or replace function public.verify_payment(p_payment uuid, p_received_cents bigint, p_pix_ref text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare pay payments; v record; sp record;
begin
  if not is_admin() then raise exception 'réservé à l''administrateur'; end if;
  select * into pay from payments where id = p_payment and status = 'submitted' for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'payment'); end if;
  if p_received_cents is distinct from pay.amount_cents then
    return jsonb_build_object('ok', false, 'reason', 'mismatch', 'expected', pay.amount_cents);
  end if;
  begin
    update payments set status = 'verified', received_cents = p_received_cents, verified_at = now(),
           pix_ref = coalesce(nullif(trim(coalesce(p_pix_ref, '')), ''), pix_ref)
    where id = pay.id;
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'reason', 'duplicate');
  end;
  for v in select vi.id, vi.declared_cents,
                  case when g.weekly_payout then 0.25 else c.platform_share end as platform_share
           from visits vi
           join partners pa on pa.id = vi.partner_id join cities c on c.id = pa.city_id
           join guides g on g.id = vi.guide_id
           where vi.payment_id = pay.id and vi.status = 'verifying' loop
    select * into sp from split_cents(v.declared_cents, v.platform_share);
    update visits set status = 'received', received_cents = v.declared_cents, guide_cents = sp.guide,
           kombrio_cents = sp.kombrio, received_at = now() where id = v.id;
    perform log_event('admin', 'commission_received', v.id, pay.id, null,
      jsonb_build_object('received', v.declared_cents, 'guide', sp.guide, 'kombrio', sp.kombrio));
  end loop;
  perform log_event('admin', 'payment_verified', null, pay.id, null, jsonb_build_object('received', p_received_cents));
  return jsonb_build_object('ok', true);
end $$;
grant execute on function public.verify_payment(uuid, bigint, text) to authenticated;
