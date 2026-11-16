-- v77 · 16/11/2026 : le paiement J+1 du guide présent devient un CHOIX DU PARTENAIRE (décision de JC du 16/11/2026).
--   - partners.j1_enabled (faux par défaut) : le gérant l'active dans son espace (Config) ; l'admin peut aussi le changer.
--   - Le guide présent touche toujours 100 % (mode 2, inchangé). Seul le délai change :
--       partenaire J+1 activé  → virement J+1 (carte « Virements J+1 » de l'admin, rappel du matin) ;
--       sinon                  → avec le reversement habituel (mensuel).
--   - Les guides voient la liste des partenaires qui proposent le J+1 (public_partners renvoie j1_enabled).
-- Aucune donnée existante n'est modifiée. À lancer une fois dans Supabase › SQL Editor. Relançable sans effet de bord.

alter table partners add column if not exists j1_enabled boolean not null default false;

-- 1. Réglage par le gérant (par son lien), avec trace dans le journal.
create or replace function public.partner_set_j1(p_manager_token text, p_on boolean) returns boolean
language plpgsql security definer set search_path = public as $$
declare pid uuid;
begin
  update partners set j1_enabled = coalesce(p_on, false)
  where p_manager_token is not null and manager_token = p_manager_token and status = 'active' returning id into pid;
  if pid is null then return false; end if;
  perform log_event('manager', 'partner_j1_' || case when p_on then 'on' else 'off' end, null, null, null, jsonb_build_object('partner', pid));
  return true;
end $$;
grant execute on function public.partner_set_j1(text, boolean) to anon, authenticated;

-- 2. Le circuit J+1 ne prend que les passages des partenaires qui l'ont activé.
do $$
declare f text; src text; n1 int; n2 int;
  longp text := 'v.status = ''received'' and v.mode = 2';
  shortp text := 'status = ''received'' and mode = 2';
begin
  foreach f in array array['public.start_payout_express(uuid)', 'public.express_payouts_due()', 'public.j1_morning_reminder()'] loop
    select pg_get_functiondef(f::regprocedure) into src;
    if src like '%j1_enabled%' then continue; end if;   -- déjà fait
    src := replace(src, longp, '#LONG#');                -- la forme « v. » d'abord, mise de côté
    n1 := (length(src) - length(replace(src, '#LONG#', ''))) / length('#LONG#');
    n2 := (length(src) - length(replace(src, shortp, ''))) / length(shortp);
    if n1 + n2 = 0 then raise exception '% : condition « mode 2 » introuvable, script arrêté', f; end if;
    src := replace(src, shortp, shortp || ' and partner_id in (select id from partners where j1_enabled)');
    src := replace(src, '#LONG#', longp || ' and v.partner_id in (select id from partners where j1_enabled)');
    execute src;
  end loop;
end $$;

-- 3. Liste publique des partenaires : on ajoute j1_enabled (vu par le guide).
drop function if exists public.public_partners(text);
create function public.public_partners(p_city text)
returns table (id uuid, type text, name text, area text, offer text, photo text, address text,
               offer_price_cents bigint, offer_promo_cents bigint, offer_end date, j1_enabled boolean)
language sql stable security definer set search_path = public as $$
  select p.id, p.type, p.name, p.area,
         case when act then nullif(p.offer, '') end, p.photo, nullif(p.address, ''),
         case when act then p.offer_price_cents end, case when act then p.offer_promo_cents end,
         case when act and (nullif(p.offer, '') is not null or p.offer_promo_cents is not null) then p.offer_end end,
         p.j1_enabled
  from partners p join cities c on c.id = p.city_id
  cross join lateral (select partner_offer_active(p, (now() at time zone c.timezone)::date) as act) x
  where p.city_id = p_city and p.status = 'active' order by p.name
$$;
grant execute on function public.public_partners(text) to anon, authenticated;

insert into ledger (actor_kind, event, data) values ('system', 'j1_choix_partenaire_installed', jsonb_build_object('version', 'v77'));
select (select count(*) from partners where j1_enabled) as partenaires_j1,
       (select count(*) from pg_proc where proname in ('start_payout_express', 'express_payouts_due', 'j1_morning_reminder')
          and prosrc like '%j1_enabled%') as fonctions_j1;
