-- Kombrio v99 (17/11/2026, idée de Frank validée par JC) : MODULE AGENCES ET TOUR COMPANIES, lot 1 = inscription.
--   - guides.actor_kind : 'guide' (KG), 'tc' = Tour Company (KT), 'agency' = agence (KA). Même compte, même app,
--     même vérification Pix, mêmes virements, NFS-e et IRRF PJ. TC et agence : CNPJ obligatoire, statut fiscal « entreprise ».
--   - Code donné à la validation : RIO-KG-…, RIO-KT-… ou RIO-KA-… (les 5 chiffres restent uniques entre les trois).
--   - Partenaire : un taux par rôle, qui s'ajoutent (ex. H Stern 10 % guide + 5 % TC + 5 % agence) :
--     commission_rate (guide, inchangé), rate_tc, rate_agency (0 = rien ; 5 % conseillé pour l'agence).
--   Les groupes rattachés (lot 2) et le calcul des commissions par rôle (lot 3) viendront ensuite : ce lot ne change aucun calcul.
-- Aucune donnée existante n'est modifiée. À lancer une fois dans Supabase › SQL Editor. Peut être relancé sans danger.

-- 1. Type d'apporteur.
alter table guides add column if not exists actor_kind text not null default 'guide';
alter table guides drop constraint if exists guides_actor_kind_chk;
alter table guides add constraint guides_actor_kind_chk check (actor_kind in ('guide', 'tc', 'agency') and (actor_kind = 'guide' or tax_kind = 'cnpj'));

-- Statut fiscal : une agence ou un TC est toujours une entreprise.
create or replace function public.guide_fiscal_sync() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.tax_kind = 'cpf' then new.fiscal_status := 'cpf';
  elsif new.actor_kind in ('tc', 'agency') then new.fiscal_status := case when new.fiscal_status = 'rep' then 'rep' else 'company' end;
  elsif new.fiscal_status is null or new.fiscal_status = 'cpf' then new.fiscal_status := 'mei';
  end if;
  return new;
end $$;
drop trigger if exists guides_fiscal_sync on guides;
create trigger guides_fiscal_sync before insert or update of tax_kind, fiscal_status, actor_kind on guides
  for each row execute function public.guide_fiscal_sync();

-- 2. Codes : KT et KA uniques avec KG (sur les 5 chiffres).
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
      union all select 1 from guides where p_kind in ('KG', 'KT', 'KA') and right(coalesce(code, ''), 5) = n);
    tries := tries + 1;
    if tries > 50 then raise exception 'plus de codes libres'; end if;
  end loop;
  return pre || '-' || p_kind || '-' || n;
end $$;
revoke execute on function public.make_code(text, text) from public, anon, authenticated;

create or replace function public.guide_code_on_validate() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'validated' and new.code is null then
    new.code := make_code(new.city_id, case new.actor_kind when 'tc' then 'KT' when 'agency' then 'KA' else 'KG' end);
  end if;
  return new;
end $$;

-- 3. Inscription : type choisi par l'apporteur ; TC et agence sans CNPJ refusés.
do $$ declare src text; begin
  select pg_get_functiondef('public.handle_new_user()'::regprocedure) into src;
  if src like '%cnpj_required%' then return; end if;   -- (corrigé en v101 : « actor_kind » figurait déjà dans le journal)
  if src not like '%pix_holder, referred_by)%' or src not like '%left(v_holder, 120), parrain.id);%'
     or src not like '%    insert into guides (id, city_id%' then
    raise exception 'handle_new_user : inscription du guide introuvable, script arrêté';
  end if;
  src := replace(src, '    insert into guides (id, city_id',
    '    if m->>''actor_kind'' in (''tc'', ''agency'') and v_cnpj is null then raise exception ''cnpj_required''; end if;   -- v99
    insert into guides (id, city_id');
  src := replace(src, 'pix_holder, referred_by)', 'pix_holder, referred_by, actor_kind)');
  src := replace(src, 'left(v_holder, 120), parrain.id);',
    'left(v_holder, 120), parrain.id, case when m->>''actor_kind'' in (''tc'', ''agency'') then m->>''actor_kind'' else ''guide'' end);');
  execute src;
end $$;

-- 4. Taux du partenaire par rôle (en plus du taux guide existant).
alter table partners add column if not exists rate_tc numeric not null default 0;
alter table partners add column if not exists rate_agency numeric not null default 0;
alter table partners drop constraint if exists partners_role_rates_chk;
alter table partners add constraint partners_role_rates_chk check (rate_tc >= 0 and rate_tc <= 0.5 and rate_agency >= 0 and rate_agency <= 0.5);

create or replace function public.set_partner_role_rates(p_manager_token text, p_tc numeric, p_agency numeric) returns boolean
language plpgsql security definer set search_path = public as $$
declare p partners;
begin
  select * into p from partners where manager_token = p_manager_token and status = 'active';
  if not found then return false; end if;
  if p_tc is null or p_agency is null or p_tc < 0 or p_tc > 0.5 or p_agency < 0 or p_agency > 0.5 then return false; end if;
  update partners set rate_tc = round(p_tc, 4), rate_agency = round(p_agency, 4) where id = p.id;
  perform log_event('manager', 'role_rates_set', null, null, null, jsonb_build_object(
    'tc', p_tc, 'agency', p_agency, 'from', jsonb_build_object('tc', p.rate_tc, 'agency', p.rate_agency)));
  return true;
end $$;
grant execute on function public.set_partner_role_rates(text, numeric, numeric) to anon, authenticated;

insert into ledger (actor_kind, event, data) values ('system', 'agencies_tc_signup_installed', jsonb_build_object('version', 'v99'));

-- Contrôle : les trois doivent valoir true.
select exists (select 1 from information_schema.columns where table_name = 'guides' and column_name = 'actor_kind') as type_apporteur,
       pg_get_functiondef('public.handle_new_user()'::regprocedure) like '%cnpj_required%' as inscription,
       exists (select 1 from information_schema.columns where table_name = 'partners' and column_name = 'rate_agency') as taux_partenaire;
