-- Kombrio v118 (demande de JC du 20/11/2026).
-- 1. Lojas PROPRES et lojas en FRANCHISE dans un groupe (ex. une marque avec ses boutiques et ses franchisés).
--    - partners.ownership : 'own' (loja du propriétaire, par défaut) ou 'franchise' (loja d'un franchisé).
--    - Une franchise se gère seule : son gérant, son taux, son équipe, son Pix, ses relevés et ses notes, sous son CNPJ.
--      Elle ne voit pas le tableau du groupe ; le franchiseur voit seulement son nom (jamais ses montants ni son lien de gérant).
--    - Le Pix unique du groupe ne couvre que les lojas propres ; une franchise paie toujours la sienne.
-- 2. JOURS SANS COMMISSION (ex. une boutique qui ne commissionne pas les jours de match).
--    - Le gérant coche des dates dans un calendrier et écrit le MOTIF, obligatoire (ex. « Dia de jogo : oferta Kombrio não válida »).
--      Le motif s'affiche aussi à l'équipe au moment du scan, pour informer le client.
--    - Ces jours-là : la commission du passage vaut 0 (guide, TC, agence, frais de gestion), l'offre Kombrio n'est pas proposée.
--      Le passage est quand même enregistré (suivi).
--    - Le message s'affiche sur la page du client et dans l'app du guide (jours à venir).
--    - Un gérant d'une loja propre peut appliquer les mêmes jours à toutes les lojas propres de son groupe.
-- Aucune donnée existante n'est modifiée. À lancer une fois dans Supabase › SQL Editor. Peut être relancé sans danger.

------------------------------------------------------------------------------------------------
-- 1. Propre / franchise
------------------------------------------------------------------------------------------------
alter table partners add column if not exists ownership text not null default 'own';
alter table partners drop constraint if exists partners_ownership_check;
alter table partners add constraint partners_ownership_check check (ownership in ('own', 'franchise'));

-- Tableau du groupe : seulement pour les lojas propres ; les franchises n'y apparaissent que par leur nom.
create or replace function public.group_space(p_manager_token text) returns jsonb
language sql stable security definer set search_path = public as $$
  with me as (select * from partners where p_manager_token is not null and manager_token = p_manager_token and group_id is not null and ownership = 'own'),
       grp as (select g.* from partner_groups g join me on me.group_id = g.id),
       mem as (select p.* from partners p join me on p.group_id = me.group_id where p.status in ('active', 'paused') and p.ownership = 'own')
  select case when not exists (select 1 from grp) then null else jsonb_build_object(
    'group', (select jsonb_build_object('id', id, 'name', name, 'pay_mode', pay_mode) from grp),
    'me', (select id from me),
    'members', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', m.id, 'name', m.name, 'area', m.area, 'status', m.status, 'manager_token', m.manager_token,
        'to_pay_cents', (select coalesce(sum(v.declared_cents + v.fee_cents), 0) from visits v where v.partner_id = m.id and v.status = 'declared' and v.declared_cents > 0),
        'to_pay_count', (select count(*) from visits v where v.partner_id = m.id and v.status = 'declared' and v.declared_cents > 0),
        'to_declare', (select count(*) from visits v where v.partner_id = m.id and v.status = 'visited'),
        'verifying_cents', (select coalesce(sum(v.declared_cents + v.fee_cents), 0) from visits v where v.partner_id = m.id and v.status = 'verifying'),
        'month_visits', (select count(*) from visits v where v.partner_id = m.id and v.status <> 'cancelled' and v.at >= date_trunc('month', now()))
      ) order by m.name), '[]'::jsonb) from mem m),
    'franchises', (select coalesce(jsonb_agg(jsonb_build_object('name', f.name, 'area', f.area) order by f.name), '[]'::jsonb)
      from partners f join me on f.group_id = me.group_id where f.ownership = 'franchise' and f.status in ('active', 'paused')),
    'to_pay', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', v.id, 'num', v.num, 'code', v.code, 'partner_id', v.partner_id, 'partner_name', m.name, 'at', v.at,
        'client', s.client, 'declared_cents', v.declared_cents, 'fee_cents', v.fee_cents, 'status', v.status
      ) order by m.name, v.at), '[]'::jsonb)
      from visits v join mem m on m.id = v.partner_id left join stays s on s.id = v.stay_id
      where v.status = 'declared' and v.declared_cents > 0),
    'payments', (select coalesce(jsonb_agg(jsonb_build_object('id', y.id, 'num', y.num, 'amount_cents', y.amount_cents,
        'status', y.status, 'submitted_at', y.submitted_at, 'note', y.note) order by y.submitted_at desc), '[]'::jsonb)
      from (select * from payments y where y.group_id = (select id from grp) order by submitted_at desc limit 12) y)
  ) end
$$;
grant execute on function public.group_space(text) to anon, authenticated;

-- Pix unique : lojas propres seulement.
create or replace function public.submit_group_payment(p_manager_token text, p_visits uuid[], p_method text, p_pix_ref text, p_receipt jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare p partners; g partner_groups; total bigint; cnt int; pay payments;
begin
  select * into p from partners where manager_token = p_manager_token and status = 'active' and group_id is not null and ownership = 'own';
  if not found then return jsonb_build_object('ok', false, 'reason', 'partner'); end if;
  select * into g from partner_groups where id = p.group_id;
  if g.pay_mode <> 'single' then return jsonb_build_object('ok', false, 'reason', 'mode'); end if;
  if p_receipt is null or coalesce(p_receipt->>'data', '') = '' then return jsonb_build_object('ok', false, 'reason', 'receipt'); end if;
  select count(*), sum(v.declared_cents + v.fee_cents) into cnt, total from visits v join partners m on m.id = v.partner_id
  where v.id = any(p_visits) and m.group_id = g.id and m.ownership = 'own' and v.status = 'declared' and v.declared_cents > 0;
  if cnt = 0 or cnt <> coalesce(array_length(p_visits, 1), 0) then return jsonb_build_object('ok', false, 'reason', 'visits'); end if;
  begin
    insert into payments (partner_id, group_id, amount_cents, method, pix_ref, receipt, receipt_hash)
    values (p.id, g.id, total, coalesce(nullif(p_method, ''), 'pix'), nullif(trim(coalesce(p_pix_ref, '')), ''), p_receipt, md5(p_receipt->>'data'))
    returning * into pay;
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'reason', 'duplicate');
  end;
  update visits set status = 'verifying', payment_id = pay.id where id = any(p_visits);
  perform log_event('manager', 'group_payment_submitted', null, pay.id, null,
    jsonb_build_object('num', pay.num, 'cents', total, 'group', g.id, 'visits', to_jsonb(p_visits), 'pix_ref', pay.pix_ref));
  return jsonb_build_object('ok', true, 'payment_id', pay.id, 'num', pay.num, 'cents', total);
end $$;
grant execute on function public.submit_group_payment(text, uuid[], text, text, jsonb) to anon, authenticated;

-- Paiement loja par loja : une franchise paie toujours la sienne, même dans un groupe à Pix unique.
create or replace function public.submit_payment(p_manager_token text, p_visits uuid[], p_method text, p_pix_ref text, p_receipt jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare p partners; total bigint; cnt int; pay payments;
begin
  select * into p from partners where manager_token = p_manager_token and status = 'active';
  if not found then return jsonb_build_object('ok', false, 'reason', 'partner'); end if;
  if p.group_id is not null and p.ownership = 'own' and exists (select 1 from partner_groups where id = p.group_id and pay_mode = 'single') then
    return jsonb_build_object('ok', false, 'reason', 'group');
  end if;
  if p_receipt is null or coalesce(p_receipt->>'data', '') = '' then return jsonb_build_object('ok', false, 'reason', 'receipt'); end if;
  select count(*), sum(declared_cents + fee_cents) into cnt, total from visits
  where id = any(p_visits) and partner_id = p.id and status = 'declared' and declared_cents > 0;
  if cnt = 0 or cnt <> coalesce(array_length(p_visits, 1), 0) then return jsonb_build_object('ok', false, 'reason', 'visits'); end if;
  begin
    insert into payments (partner_id, amount_cents, method, pix_ref, receipt, receipt_hash)
    values (p.id, total, coalesce(nullif(p_method, ''), 'pix'), nullif(trim(coalesce(p_pix_ref, '')), ''), p_receipt, md5(p_receipt->>'data'))
    returning * into pay;
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'reason', 'duplicate');
  end;
  update visits set status = 'verifying', payment_id = pay.id where id = any(p_visits);
  perform log_event('manager', 'payment_submitted', null, pay.id, null,
    jsonb_build_object('num', pay.num, 'cents', total, 'visits', to_jsonb(p_visits), 'pix_ref', pay.pix_ref));
  return jsonb_build_object('ok', true, 'payment_id', pay.id, 'num', pay.num, 'cents', total);
end $$;
grant execute on function public.submit_payment(text, uuid[], text, text, jsonb) to anon, authenticated;

------------------------------------------------------------------------------------------------
-- 2. Jours sans commission
------------------------------------------------------------------------------------------------
create table if not exists partner_blackouts (
  partner_id uuid not null references partners on delete cascade,
  day        date not null,
  note       text not null default '' check (length(note) <= 160),
  created_at timestamptz not null default now(),
  primary key (partner_id, day)
);
alter table partner_blackouts enable row level security;
drop policy if exists "admin lit les jours sans commission" on partner_blackouts;
create policy "admin lit les jours sans commission" on partner_blackouts for select using (is_admin());

alter table visits add column if not exists no_commission boolean not null default false;
alter table visits add column if not exists no_commission_note text;

-- Gérant : lire, ajouter, retirer.
create or replace function public.partner_blackouts_list(p_token text) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('day', b.day, 'note', b.note) order by b.day), '[]'::jsonb)
  from partner_access(p_token) a join partner_blackouts b on b.partner_id = a.partner_id
  join partners p on p.id = a.partner_id join cities c on c.id = p.city_id
  where b.day >= (now() at time zone c.timezone)::date - 1
$$;
grant execute on function public.partner_blackouts_list(text) to anon, authenticated;

create or replace function public.partner_blackouts_add(p_manager_token text, p_days date[], p_note text, p_all_group boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p partners; n int := 0; nt text := left(trim(coalesce(p_note, '')), 160); today date;
begin
  select * into p from partners where manager_token = p_manager_token and status in ('active', 'paused');
  if not found then return jsonb_build_object('ok', false, 'reason', 'partner'); end if;
  select (now() at time zone timezone)::date into today from cities where id = p.city_id;
  if nt = '' then return jsonb_build_object('ok', false, 'reason', 'note'); end if;   -- le motif est obligatoire (affiché au client, au guide et au scan)
  if coalesce(array_length(p_days, 1), 0) = 0 or coalesce(array_length(p_days, 1), 0) > 120 then return jsonb_build_object('ok', false, 'reason', 'days'); end if;
  if exists (select 1 from unnest(p_days) d where d < today or d > today + 400) then return jsonb_build_object('ok', false, 'reason', 'days'); end if;
  insert into partner_blackouts (partner_id, day, note)
  select x.id, d, nt from unnest(p_days) d
  cross join (select id from partners where id = p.id
              union select id from partners where p_all_group and p.group_id is not null and p.ownership = 'own'
                                                and group_id = p.group_id and ownership = 'own' and status in ('active', 'paused')) x
  on conflict (partner_id, day) do update set note = excluded.note;
  get diagnostics n = row_count;
  perform log_event('manager', 'blackout_days_added', null, null, null,
    jsonb_build_object('partner', p.id, 'days', to_jsonb(p_days), 'note', nt, 'all_group', coalesce(p_all_group, false), 'rows', n));
  return jsonb_build_object('ok', true, 'rows', n);
end $$;
grant execute on function public.partner_blackouts_add(text, date[], text, boolean) to anon, authenticated;

create or replace function public.partner_blackouts_remove(p_manager_token text, p_day date, p_all_group boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p partners; n int;
begin
  select * into p from partners where manager_token = p_manager_token and status in ('active', 'paused');
  if not found then return jsonb_build_object('ok', false, 'reason', 'partner'); end if;
  delete from partner_blackouts b where b.day = p_day and (b.partner_id = p.id
    or (p_all_group and p.group_id is not null and p.ownership = 'own'
        and b.partner_id in (select id from partners where group_id = p.group_id and ownership = 'own')));
  get diagnostics n = row_count;
  perform log_event('manager', 'blackout_day_removed', null, null, null, jsonb_build_object('partner', p.id, 'day', p_day, 'rows', n));
  return jsonb_build_object('ok', true, 'rows', n);
end $$;
grant execute on function public.partner_blackouts_remove(text, date, boolean) to anon, authenticated;

-- Page du client et app du guide : jours sans commission des 45 prochains jours, avec le message.
create or replace function public.public_blackouts(p_city text) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('partner_id', b.partner_id, 'day', b.day, 'note', b.note) order by b.day), '[]'::jsonb)
  from partner_blackouts b join partners p on p.id = b.partner_id join cities c on c.id = p.city_id
  where p.city_id = p_city and p.status = 'active'
    and b.day between (now() at time zone c.timezone)::date and (now() at time zone c.timezone)::date + 45
$$;
grant execute on function public.public_blackouts(text) to anon, authenticated;

-- L'offre Kombrio n'est pas proposée un jour sans commission.
create or replace function public.partner_offer_active(p partners, d date) returns boolean
language sql stable set search_path = public as $$
  select (p.offer_start is null or d >= p.offer_start) and (p.offer_end is null or d <= p.offer_end)
     and (p.offer_days is null or extract(isodow from d)::smallint = any (p.offer_days))
     and not exists (select 1 from partner_blackouts b where b.partner_id = p.id and b.day = d)
$$;
revoke execute on function public.partner_offer_active(partners, date) from public, anon, authenticated;

-- À la création d'un passage un jour sans commission (dernier déclencheur, « zzz ») : tout à 0, et ça le reste.
create or replace function public.visit_no_commission() returns trigger
language plpgsql security definer set search_path = public as $$
declare nt text; tz text;
begin
  if tg_op = 'INSERT' then
    select c.timezone into tz from partners p join cities c on c.id = p.city_id where p.id = new.partner_id;
    select note into nt from partner_blackouts
      where partner_id = new.partner_id and day = coalesce(new.visit_day, (coalesce(new.at, now()) at time zone coalesce(tz, 'America/Sao_Paulo'))::date);
    if found then new.no_commission := true; new.no_commission_note := nullif(nt, ''); end if;
  end if;
  if new.no_commission then
    new.commission_rate := 0; new.per_person_cents := null; new.child_cents := null;
    new.bonus_every := null; new.bonus_cents := null; new.meal_every := null;
    new.fee_cents := 0; new.fee_rate := null; new.offer_given := false;
  end if;
  return new;
end $$;
drop trigger if exists zzz_visits_no_commission on visits;
create trigger zzz_visits_no_commission before insert or update on visits for each row execute function public.visit_no_commission();

-- Lignes filles (TC, agence, guides d'un groupe) : rien un jour sans commission (même texte qu'au script 063, plus ce contrôle).
create or replace function public.sync_child_visit(par visits, p_actor uuid, p_role text, p_rate numeric) returns void
language plpgsql security definer set search_path = public as $$
declare c visits; calc bigint;
begin
  if par.no_commission then p_rate := 0; end if;
  select * into c from visits where parent_visit_id = par.id and guide_id = p_actor;
  if c.id is not null and (c.payment_id is not null or c.status not in ('declared', 'zero', 'cancelled')) then return; end if;   -- payée : figée
  if c.id is null then
    if coalesce(p_rate, 0) <= 0 and p_role <> 'guide' then return; end if;
    insert into visits (stay_id, partner_id, guide_id, people, people_served, visit_day, at, status, commission_rate,
                        parent_visit_id, actor_role, children)
    values (par.stay_id, par.partner_id, p_actor, par.people, par.people_served, par.visit_day, par.at, 'cancelled', p_rate,
            par.id, p_role, par.children)
    returning * into c;
  end if;
  c.people_served := par.people_served; c.children := par.children;
  calc := case when par.no_commission then 0 else commission_for(c, par.invoice_cents, p_rate) end;
  update visits set invoice_cents = par.invoice_cents, commission_rate = p_rate, computed_cents = calc, declared_cents = calc,
         people_served = par.people_served, children = par.children, declared_at = coalesce(par.declared_at, now()),
         status = case when calc > 0 then 'declared' else 'cancelled' end, status_note = null
  where id = c.id;
end $$;
revoke execute on function public.sync_child_visit(visits, uuid, text, numeric) from public, anon, authenticated;

insert into ledger (actor_kind, event, data) values ('system', 'franchises_blackouts_installed', jsonb_build_object('version', 'v118'));

-- Contrôle : 5 lignes « oui » attendues.
select 'propre / franchise' as point, case when exists (select 1 from information_schema.columns where table_name = 'partners' and column_name = 'ownership') then 'oui' else 'NON' end as ok
union all select 'jours sans commission', case when to_regclass('public.partner_blackouts') is not null then 'oui' else 'NON' end
union all select 'passage marqué sans commission', case when exists (select 1 from information_schema.columns where table_name = 'visits' and column_name = 'no_commission') then 'oui' else 'NON' end
union all select 'déclencheur zzz', case when exists (select 1 from pg_trigger where tgname = 'zzz_visits_no_commission') then 'oui' else 'NON' end
union all select 'fonctions gérant et vitrine', case when (select count(*) from pg_proc where proname in ('partner_blackouts_list', 'partner_blackouts_add', 'partner_blackouts_remove', 'public_blackouts')) = 4 then 'oui' else 'NON' end;
