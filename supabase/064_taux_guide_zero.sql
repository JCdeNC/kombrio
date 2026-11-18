-- Kombrio v101 (17/11/2026, cas de Frank : au restaurant, le guide n'est jamais présent) : le partenaire peut choisir
-- un taux GUIDE de 0 % (il ne paie alors que le TC et/ou l'agence). Les autres taux possibles ne changent pas.
-- Aucune donnée existante n'est modifiée. À lancer une fois dans Supabase › SQL Editor. Peut être relancé sans danger.

alter table partners drop constraint if exists partners_commission_rate_check;
alter table partners add constraint partners_commission_rate_check check (
  commission_rate in (0, 0.05, 0.06, 0.07, 0.08, 0.09, 0.10, 0.11, 0.12, 0.13, 0.14, 0.15, 0.20));

create or replace function public.set_commission_rate(p_manager_token text, p_rate numeric) returns boolean
language plpgsql security definer set search_path = public as $$
declare old numeric;
begin
  select commission_rate into old from partners where manager_token = p_manager_token and status = 'active';
  if not found then return false; end if;
  if p_rate not in (0, 0.05, 0.06, 0.07, 0.08, 0.09, 0.10, 0.11, 0.12, 0.13, 0.14, 0.15, 0.20) then return false; end if;
  update partners set commission_rate = p_rate where manager_token = p_manager_token;
  perform log_event('manager', 'commission_rate_set', null, null, null, jsonb_build_object('from', old, 'to', p_rate));
  return true;
end $$;
grant execute on function public.set_commission_rate(text, numeric) to anon, authenticated;

insert into ledger (actor_kind, event, data) values ('system', 'guide_rate_zero_allowed', jsonb_build_object('version', 'v101'));
select exists (select 1 from pg_constraint where conname = 'partners_commission_rate_check'
                and pg_get_constraintdef(oid) like '%(0)::numeric%') as taux_zero_autorise;
