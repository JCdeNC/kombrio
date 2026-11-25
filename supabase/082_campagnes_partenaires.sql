-- Kombrio v142 (25/11/2026, lot H, décisions de JC) : CAMPAGNES À OBJECTIF CRÉÉES ET PAYÉES PAR L'ÉTABLISSEMENT.
-- Ex. « Dezembro : 20 clientes = R$ 100 de bônus ». Le gérant crée la campagne (période, objectif en clients, prime) ;
-- chaque guide qui atteint l'objectif gagne la prime (une fois par campagne). Kombrio ne paie jamais de prime :
-- l'établissement paie la prime + 5 % de frais Kombrio (referral_settings.campaign_fee_rate), seulement si elle est gagnée.
-- La prime gagnée devient une ligne « guide présent » (mode 2) de la loja : le guide touche 100 %, Kombrio les frais ;
-- elle passe dans le Pix unique du partenaire et le virement au guide comme les autres commissions.
-- Clients comptés : personnes servies des passages du guide dans la loja pendant la période, avec une commission déclarée
-- (pas les passages à zéro ni les jours sans commission). Peut être relancé sans danger.

alter table referral_settings add column if not exists campaign_fee_rate numeric not null default 0.05;

create table if not exists partner_campaigns (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid not null references partners(id) on delete cascade,
  title text not null check (length(trim(title)) between 2 and 80),
  start_day date not null,
  end_day date not null,
  target_clients int not null check (target_clients between 1 and 1000),
  bonus_cents bigint not null check (bonus_cents between 100 and 1000000),
  fee_rate numeric not null,
  status text not null default 'active' check (status in ('active', 'cancelled')),
  created_at timestamptz not null default now(),
  constraint partner_campaigns_days check (end_day >= start_day and end_day - start_day <= 92)
);
alter table partner_campaigns enable row level security;

alter table visits add column if not exists campaign_id uuid references partner_campaigns(id);
create unique index if not exists visits_campaign_award_once on visits (campaign_id, guide_id) where campaign_id is not null and status <> 'cancelled';

-- 1. Les lignes de prime gardent leurs frais de campagne (pas le calcul du mode 2) et ignorent les jours sans commission.
do $$ declare src text; begin
  select pg_get_functiondef('public.visit_mode_fee()'::regprocedure) into src;
  if src not like '%campaign_id%' then
    if src not like '%if new.payment_id is not null or new.status not in (''visited'', ''declared'', ''zero'') then return new; end if;%' then
      raise exception 'visit_mode_fee : texte attendu introuvable, script arrêté'; end if;
    src := replace(src, 'if new.payment_id is not null or new.status not in (''visited'', ''declared'', ''zero'') then return new; end if;',
      'if new.payment_id is not null or new.status not in (''visited'', ''declared'', ''zero'') then return new; end if;
  -- v142 : prime de campagne = mode 2, frais de campagne figés sur la ligne.
  if new.campaign_id is not null then
    new.mode := 2; new.guide_present := true; new.platform_share := 0;
    new.fee_rate := coalesce(new.fee_rate, (select fee_rate from partner_campaigns where id = new.campaign_id));
    new.fee_cents := round(coalesce(new.declared_cents, 0) * coalesce(new.fee_rate, 0))::bigint;
    return new;
  end if;');
    execute src;
  end if;
  select pg_get_functiondef('public.visit_no_commission()'::regprocedure) into src;
  if src not like '%campaign_id%' then
    if src not like '%begin
  if tg_op = ''INSERT'' then%' then raise exception 'visit_no_commission : texte attendu introuvable, script arrêté'; end if;
    src := replace(src, 'begin
  if tg_op = ''INSERT'' then', 'begin
  if new.campaign_id is not null then return new; end if;   -- v142 : prime de campagne
  if tg_op = ''INSERT'' then');
    execute src;
  end if;
end $$;

-- 1 bis. Les frais de campagne ne comptent pas dans le plafond mensuel des frais du mode 2.
do $$ declare src text; begin
  select pg_get_functiondef('public.mode2_fee(uuid, uuid, bigint, timestamptz)'::regprocedure) into src;
  if src like '%campaign_id%' then return; end if;
  if src not like '%and v.id <> p_visit and v.status <> ''cancelled''%' then raise exception 'mode2_fee : texte attendu introuvable, script arrêté'; end if;
  src := replace(src, 'and v.id <> p_visit and v.status <> ''cancelled''', 'and v.id <> p_visit and v.status <> ''cancelled'' and v.campaign_id is null');
  execute src;
end $$;

-- 2. Progression d'un guide dans une campagne (clients servis avec commission déclarée).
create or replace function public.campaign_progress(p_campaign uuid, p_guide uuid) returns int
language sql stable security definer set search_path = public as $$
  select coalesce(sum(greatest(coalesce(v.people_served, v.people, 1), 1)), 0)::int
  from partner_campaigns c join visits v on v.partner_id = c.partner_id and v.guide_id = p_guide
  join cities ci on ci.id = (select city_id from partners where id = c.partner_id)
  where c.id = p_campaign and v.parent_visit_id is null and v.campaign_id is null and not coalesce(v.no_commission, false)
    and v.status in ('declared', 'verifying', 'received', 'payout_pending', 'paid')
    and coalesce(v.visit_day, (v.at at time zone ci.timezone)::date) between c.start_day and c.end_day
$$;
revoke execute on function public.campaign_progress(uuid, uuid) from public, anon, authenticated;

-- 3. Prime gagnée : une ligne de commission « Campanha · titre » (fiche technique à part), une seule fois par guide.
create or replace function public.campaign_award(p_campaign uuid, p_guide uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare c partner_campaigns; s stays; v visits; tz text; today date;
begin
  select * into c from partner_campaigns where id = p_campaign and status = 'active';
  if not found then return null; end if;
  if exists (select 1 from visits where campaign_id = c.id and guide_id = p_guide and status <> 'cancelled') then return null; end if;
  if campaign_progress(c.id, p_guide) < c.target_clients then return null; end if;
  select ci.timezone into tz from partners p join cities ci on ci.id = p.city_id where p.id = c.partner_id;
  today := (now() at time zone coalesce(tz, 'America/Sao_Paulo'))::date;
  insert into stays (guide_id, client, people, start_day, end_day, token, direct, archived_at)
  values (p_guide, left('Campanha · ' || c.title, 120), 1, today, today, 'C-' || md5(random()::text || clock_timestamp()::text || p_guide::text), true, now())
  returning * into s;
  insert into visits (stay_id, partner_id, guide_id, people, people_served, visit_day, at, offer_given, commission_rate, platform_share,
                      direct, guide_present, mode, campaign_id, invoice_cents, computed_cents, declared_cents, declared_at, declared_by, status, commission_note)
  values (s.id, c.partner_id, p_guide, 1, 1, today, now(), false, 0, 0, true, true, 2, c.id, 0, c.bonus_cents, c.bonus_cents, now(), 'manager', 'declared',
          left('Prêmio da campanha « ' || c.title || ' »', 200))
  returning * into v;
  perform log_event('system', 'campaign_award', v.id, null, null, jsonb_build_object('campaign', c.id, 'guide', p_guide, 'bonus', c.bonus_cents, 'fee', v.fee_cents));
  return v.id;
end $$;
revoke execute on function public.campaign_award(uuid, uuid) from public, anon, authenticated;

-- 4. Après chaque passage déclaré : la prime est attribuée dès que l'objectif est atteint.
create or replace function public.visit_campaign_check() returns trigger
language plpgsql security definer set search_path = public as $$
declare k record;
begin
  if new.campaign_id is not null or new.parent_visit_id is not null
     or new.status not in ('declared', 'verifying', 'received', 'payout_pending', 'paid') then return new; end if;
  if tg_op = 'UPDATE' and old.status = new.status and old.people_served is not distinct from new.people_served then return new; end if;
  for k in select c.id from partner_campaigns c where c.partner_id = new.partner_id and c.status = 'active'
             and coalesce(new.visit_day, now()::date) between c.start_day and c.end_day loop
    perform campaign_award(k.id, new.guide_id);
  end loop;
  return new;
end $$;
drop trigger if exists zzzz_visits_campaign on visits;
create trigger zzzz_visits_campaign after insert or update on visits for each row execute function public.visit_campaign_check();

-- 5. Gérant : créer, annuler (si aucune prime gagnée), voir ses campagnes avec le classement.
create or replace function public.campaign_create(p_manager_token text, p_title text, p_start date, p_end date, p_target int, p_bonus_cents bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p partners; c partner_campaigns; today date;
begin
  select * into p from partners where p_manager_token is not null and manager_token = p_manager_token and status = 'active';
  if not found then return jsonb_build_object('ok', false, 'reason', 'partner'); end if;
  today := (now() at time zone (select timezone from cities where id = p.city_id))::date;
  if p_start is null or p_end is null or p_end < p_start or p_end < today or p_end - p_start > 92 then return jsonb_build_object('ok', false, 'reason', 'dates'); end if;
  if coalesce(p_target, 0) < 1 or p_target > 1000 then return jsonb_build_object('ok', false, 'reason', 'target'); end if;
  if coalesce(p_bonus_cents, 0) < 100 or p_bonus_cents > 1000000 then return jsonb_build_object('ok', false, 'reason', 'bonus'); end if;
  if length(trim(coalesce(p_title, ''))) < 2 then return jsonb_build_object('ok', false, 'reason', 'title'); end if;
  if (select count(*) from partner_campaigns where partner_id = p.id and status = 'active' and end_day >= today) >= 3 then
    return jsonb_build_object('ok', false, 'reason', 'too_many'); end if;
  insert into partner_campaigns (partner_id, title, start_day, end_day, target_clients, bonus_cents, fee_rate)
  values (p.id, left(trim(p_title), 80), p_start, p_end, p_target, p_bonus_cents, coalesce((select campaign_fee_rate from referral_settings where id = 1), 0.05))
  returning * into c;
  perform log_event('manager', 'campaign_created', null, null, null, jsonb_build_object('partner', p.id, 'campaign', c.id, 'target', p_target, 'bonus', p_bonus_cents));
  return jsonb_build_object('ok', true, 'id', c.id);
end $$;

create or replace function public.campaign_cancel(p_manager_token text, p_campaign uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p partners;
begin
  select * into p from partners where p_manager_token is not null and manager_token = p_manager_token and status = 'active';
  if not found then return jsonb_build_object('ok', false, 'reason', 'partner'); end if;
  if exists (select 1 from visits where campaign_id = p_campaign and status <> 'cancelled') then return jsonb_build_object('ok', false, 'reason', 'awarded'); end if;
  update partner_campaigns set status = 'cancelled' where id = p_campaign and partner_id = p.id and status = 'active';
  if not found then return jsonb_build_object('ok', false, 'reason', 'campaign'); end if;
  perform log_event('manager', 'campaign_cancelled', null, null, null, jsonb_build_object('partner', p.id, 'campaign', p_campaign));
  return jsonb_build_object('ok', true);
end $$;

-- Classement d'une campagne (nom du crachá seulement).
create or replace function public.campaign_board(p_campaign uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(x order by (x->>'clients')::int desc, x->>'name'), '[]'::jsonb) from (
    select jsonb_build_object('guide_id', g.id, 'name', coalesce(g.badge_name, split_part(g.name, ' ', 1)), 'clients', campaign_progress(p_campaign, g.id),
      'won', exists (select 1 from visits w where w.campaign_id = p_campaign and w.guide_id = g.id and w.status <> 'cancelled')) x
    from guides g where g.id in (select distinct v.guide_id from visits v join partner_campaigns c on c.id = p_campaign
                                   where v.partner_id = c.partner_id and v.parent_visit_id is null and v.campaign_id is null
                                     and v.visit_day between c.start_day and c.end_day)
  ) s where (x->>'clients')::int > 0
$$;
revoke execute on function public.campaign_board(uuid) from public, anon, authenticated;

create or replace function public.partner_campaigns_list(p_token text) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'title', c.title, 'start', c.start_day, 'end', c.end_day, 'target', c.target_clients,
           'bonus_cents', c.bonus_cents, 'fee_rate', c.fee_rate, 'status', c.status,
           'awards', (select count(*) from visits w where w.campaign_id = c.id and w.status <> 'cancelled'),
           'board', case when a.kind = 'manager' then campaign_board(c.id) else '[]'::jsonb end) order by c.end_day desc), '[]'::jsonb)
  from partner_access(p_token) a join partner_campaigns c on c.partner_id = a.partner_id
  where c.created_at > now() - interval '1 year'
$$;

-- 6. Guide : campagnes en cours de sa ville, sa progression et le classement.
create or replace function public.guide_campaigns() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'partner', p.name, 'type', p.type, 'area', p.area, 'title', c.title,
           'start', c.start_day, 'end', c.end_day, 'target', c.target_clients, 'bonus_cents', c.bonus_cents,
           'mine', campaign_progress(c.id, g.id),
           'won', exists (select 1 from visits w where w.campaign_id = c.id and w.guide_id = g.id and w.status <> 'cancelled'),
           'board', (select coalesce(jsonb_agg(jsonb_build_object('name', b->>'name', 'clients', (b->>'clients')::int, 'me', (b->>'guide_id')::uuid = g.id)), '[]'::jsonb)
                     from (select * from jsonb_array_elements(campaign_board(c.id)) b limit 5) t(b))) order by c.end_day), '[]'::jsonb)
  from guides g join partners p on p.city_id = g.city_id and p.status = 'active'
  join partner_campaigns c on c.partner_id = p.id and c.status = 'active'
  where g.id = auth.uid() and g.status = 'validated'
    and c.end_day >= (now() at time zone 'America/Sao_Paulo')::date and c.start_day <= (now() at time zone 'America/Sao_Paulo')::date + 14
$$;

grant execute on function public.campaign_create(text, text, date, date, int, bigint), public.campaign_cancel(text, uuid),
  public.partner_campaigns_list(text) to anon, authenticated;
grant execute on function public.guide_campaigns() to authenticated;
