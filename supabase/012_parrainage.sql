-- Kombrio v26 : parrainage V1 (document « KOMBRIO — Parrainage V1 », 5 novembre 2026).
-- Filleul : part Kombrio 18 % au lieu de 20 % pendant 30 jours après sa 1re transaction encaissée (plancher 1 R$).
-- Parrain : activé par l'admin ; 3 filleuls validés ayant chacun 2 transactions encaissées ;
--           10 % de la part Kombrio de ces 3 filleuls pendant 6 mois, limité par la marge (P = max(0, min(10 % K, K - F - S - 1 R$ × n))).
-- Un seul niveau. Primes versées à part des commissions, après clôture mensuelle et validation. Tout passe au journal.
-- À lancer une fois dans Supabase › SQL Editor. Peut être relancé sans danger.

------------------------------------------------------------------------------------------------
-- Paramètres (une seule ligne, modifiable par l'admin)
------------------------------------------------------------------------------------------------
create table if not exists referral_settings (
  id            int primary key default 1 check (id = 1),
  filleul_share numeric not null default 0.18,  -- part Kombrio pendant la promotion du filleul
  promo_days    int     not null default 30,
  parrain_rate  numeric not null default 0.10,  -- part de la recette Kombrio reversée au parrain
  needed        int     not null default 3,     -- filleuls qualifiants pour activer le parrain
  tx_needed     int     not null default 2,     -- transactions encaissées pour qu'un filleul soit qualifiant
  months        int     not null default 6,
  floor_cents   bigint  not null default 100,   -- Kombrio garde au moins 1 R$ par transaction en promotion
  cost_cents    bigint  not null default 0,     -- coûts attribuables par transaction (F)
  safety_cents  bigint  not null default 0,     -- marge de sécurité par mois et par filleul (S)
  updated_at    timestamptz not null default now()
);
insert into referral_settings (id) values (1) on conflict (id) do nothing;
alter table referral_settings enable row level security;
drop policy if exists "admin lit les paramètres de parrainage" on referral_settings;
create policy "admin lit les paramètres de parrainage" on referral_settings for select using (is_admin());

------------------------------------------------------------------------------------------------
-- Guides : parrain et activation
------------------------------------------------------------------------------------------------
alter table guides add column if not exists referred_by uuid references guides on delete set null;
alter table guides add column if not exists referral_enabled boolean not null default false;
alter table guides drop constraint if exists guides_no_self_referral;
alter table guides add constraint guides_no_self_referral check (referred_by is null or referred_by <> id);
create index if not exists guides_referred_by on guides (referred_by);

------------------------------------------------------------------------------------------------
-- Primes
------------------------------------------------------------------------------------------------
create table if not exists referral_rewards (
  id           uuid primary key default gen_random_uuid(),
  parrain_id   uuid not null references guides on delete cascade,
  filleul_id   uuid not null references guides on delete cascade,
  month        date not null,                   -- 1er jour du mois
  k_cents      bigint not null default 0,       -- part Kombrio encaissée sur ce filleul ce mois-là
  tx_count     int not null default 0,
  reward_cents bigint not null default 0,
  status       text not null default 'estimated' check (status in ('estimated', 'validated', 'paid', 'cancelled')),
  pix_ref      text,
  note         text,
  created_at   timestamptz not null default now(),
  validated_at timestamptz,
  paid_at      timestamptz,
  unique (parrain_id, filleul_id, month)
);
alter table referral_rewards enable row level security;
drop policy if exists "admin lit les primes" on referral_rewards;
create policy "admin lit les primes" on referral_rewards for select using (is_admin());

------------------------------------------------------------------------------------------------
-- Inscription : code de parrainage facultatif (code complet ou 5 chiffres)
------------------------------------------------------------------------------------------------
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  m jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  r text;
  typed text := regexp_replace(upper(coalesce(m->>'code', '')), '[^A-Z0-9]', '', 'g');
  ref text := regexp_replace(upper(coalesce(m->>'ref_code', '')), '[^A-Z0-9]', '', 'g');
  cpf text := nullif(regexp_replace(coalesce(m->>'cpf', ''), '[^0-9]', '', 'g'), '');
  pix text := nullif(trim(m->>'pix_key'), '');
  parrain guides;
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
    -- Parrain : guide validé, parrainage activé, pas le même CPF ni la même clé Pix.
    if ref <> '' then
      select * into parrain from guides g
      where g.status = 'validated' and g.referral_enabled and g.code is not null
        and (regexp_replace(g.code, '[^A-Z0-9]', '', 'g') = ref or (ref ~ '^[0-9]{5}$' and right(g.code, 5) = ref))
        and (cpf is null or g.cpf is distinct from cpf) and (pix is null or g.pix_key is distinct from pix)
      limit 1;
    end if;
    insert into guides (id, city_id, name, phone, license, email, cpf, pix_key, referred_by)
    values (new.id, coalesce(m->>'city_id', 'rio'), coalesce(nullif(m->>'name', ''), new.email), m->>'phone', m->>'license', new.email,
            cpf, pix, parrain.id);
    if parrain.id is not null then
      insert into ledger (actor, actor_kind, event, data)
      values (new.id, 'guide', 'referral_signup', jsonb_build_object('parrain', parrain.id, 'code', parrain.code));
    end if;
  end if;
  return new;
end $$;

------------------------------------------------------------------------------------------------
-- Encaissement : part Kombrio réduite pendant la promotion du filleul (avec plancher)
------------------------------------------------------------------------------------------------
create or replace function public.verify_payment(p_payment uuid, p_received_cents bigint, p_pix_ref text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare pay payments; v record; sp record; rs referral_settings; first_rx timestamptz; promo boolean; g_cents bigint; k_cents bigint;
begin
  if not is_admin() then raise exception 'réservé à l''administrateur'; end if;
  select * into rs from referral_settings where id = 1;
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
  for v in select vi.id, vi.declared_cents, vi.guide_id, g.referred_by,
                  case when g.weekly_payout then 0.25 else c.platform_share end as platform_share
           from visits vi
           join partners pa on pa.id = vi.partner_id join cities c on c.id = pa.city_id
           join guides g on g.id = vi.guide_id
           where vi.payment_id = pay.id and vi.status = 'verifying' loop
    promo := false;
    if v.referred_by is not null and rs.id is not null then
      select min(received_at) into first_rx from visits
      where guide_id = v.guide_id and status in ('received', 'payout_pending', 'paid');
      promo := first_rx is null or now() < first_rx + make_interval(days => rs.promo_days);
    end if;
    if promo then
      select * into sp from split_cents(v.declared_cents, least(v.platform_share, rs.filleul_share));
      g_cents := sp.guide; k_cents := sp.kombrio;
      if k_cents < rs.floor_cents then
        k_cents := least(v.declared_cents, rs.floor_cents); g_cents := v.declared_cents - k_cents;
      end if;
    else
      select * into sp from split_cents(v.declared_cents, v.platform_share);
      g_cents := sp.guide; k_cents := sp.kombrio;
    end if;
    update visits set status = 'received', received_cents = v.declared_cents, guide_cents = g_cents,
           kombrio_cents = k_cents, received_at = now() where id = v.id;
    perform log_event('admin', 'commission_received', v.id, pay.id, null,
      jsonb_build_object('received', v.declared_cents, 'guide', g_cents, 'kombrio', k_cents, 'referral_promo', promo));
  end loop;
  perform log_event('admin', 'payment_verified', null, pay.id, null, jsonb_build_object('received', p_received_cents));
  return jsonb_build_object('ok', true);
end $$;
grant execute on function public.verify_payment(uuid, bigint, text) to authenticated;

------------------------------------------------------------------------------------------------
-- Calculs
------------------------------------------------------------------------------------------------
-- Transactions comptées : commission réellement encaissée par Kombrio.
create or replace function public.referral_filleuls(p_parrain uuid)
returns table (filleul_id uuid, label text, guide_status text, tx int, first_rx timestamptz, qualified_at timestamptz, rank int)
language sql stable security definer set search_path = public as $$
  with rs as (select * from referral_settings where id = 1),
  f as (
    select g.id, g.status,
           split_part(trim(g.name), ' ', 1) || coalesce(' ' || nullif(left(split_part(trim(g.name), ' ', 2), 1), '') || '.', '') as label,
           g.created_at
    from guides g where g.referred_by = p_parrain
  ),
  t as (
    select f.id, count(v.id)::int as tx, min(v.received_at) as first_rx,
           (array_agg(v.received_at order by v.received_at, v.id) filter (where v.id is not null))[(select tx_needed from rs)] as q
    from f left join visits v on v.guide_id = f.id and v.status in ('received', 'payout_pending', 'paid')
    group by f.id
  )
  select f.id, f.label, f.status, t.tx, t.first_rx,
         case when f.status = 'validated' then t.q end,
         (case when f.status = 'validated' and t.q is not null
               then row_number() over (partition by (f.status = 'validated' and t.q is not null) order by t.q, f.id) end)::int
  from f join t on t.id = f.id
  order by t.q nulls last, f.created_at
$$;
revoke execute on function public.referral_filleuls(uuid) from public, anon, authenticated;

-- Vue complète d'un parrain (pour lui-même ou pour l'admin).
create or replace function public.referral_overview(p_parrain uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare rs referral_settings; g guides; q3 timestamptz; res jsonb;
begin
  if p_parrain is distinct from auth.uid() and not is_admin() then raise exception 'non autorisé'; end if;
  select * into rs from referral_settings where id = 1;
  select * into g from guides where id = p_parrain;
  if not found then return null; end if;
  select qualified_at into q3 from referral_filleuls(p_parrain) where rank = rs.needed;
  select jsonb_build_object(
    'guide_id', g.id, 'name', g.name, 'code', g.code, 'enabled', g.referral_enabled,
    'settings', jsonb_build_object('filleul_share', rs.filleul_share, 'promo_days', rs.promo_days, 'parrain_rate', rs.parrain_rate,
                                   'needed', rs.needed, 'tx_needed', rs.tx_needed, 'months', rs.months, 'floor_cents', rs.floor_cents),
    'qualified_at', q3,
    'period_end', case when q3 is not null then q3 + make_interval(months => rs.months) end,
    'filleuls', coalesce((select jsonb_agg(jsonb_build_object(
        'label', f.label, 'validated', f.guide_status = 'validated', 'tx', f.tx,
        'promo_until', case when f.first_rx is not null then f.first_rx + make_interval(days => rs.promo_days) end,
        'qualified_at', f.qualified_at, 'rewarded', f.rank is not null and f.rank <= rs.needed)
        order by f.qualified_at nulls last) from referral_filleuls(p_parrain) f), '[]'::jsonb),
    'rewards', coalesce((select jsonb_agg(jsonb_build_object(
        'id', r.id, 'month', r.month, 'filleul', (select label from referral_filleuls(p_parrain) x where x.filleul_id = r.filleul_id),
        'k_cents', r.k_cents, 'tx', r.tx_count, 'reward_cents', r.reward_cents, 'status', r.status,
        'pix_ref', r.pix_ref, 'paid_at', r.paid_at) order by r.month desc, r.created_at)
        from referral_rewards r where r.parrain_id = p_parrain and r.status <> 'cancelled'), '[]'::jsonb)
  ) into res;
  return res;
end $$;
grant execute on function public.referral_overview(uuid) to authenticated;

-- Guide connecté : son propre parrainage (null si pas activé).
create or replace function public.my_referral() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not exists (select 1 from guides where id = auth.uid() and status = 'validated' and referral_enabled) then return null; end if;
  return referral_overview(auth.uid());
end $$;
grant execute on function public.my_referral() to authenticated;

------------------------------------------------------------------------------------------------
-- Administration
------------------------------------------------------------------------------------------------
create or replace function public.set_referral_enabled(p_guide uuid, p_on boolean) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'réservé à l''administrateur'; end if;
  update guides set referral_enabled = coalesce(p_on, false) where id = p_guide and status = 'validated';
  if not found then return false; end if;
  perform log_event('admin', 'referral_enabled_set', null, null, null, jsonb_build_object('guide', p_guide, 'on', coalesce(p_on, false)));
  return true;
end $$;
grant execute on function public.set_referral_enabled(uuid, boolean) to authenticated;

-- Liste des guides validés avec leur état de parrainage.
create or replace function public.admin_referrals() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'réservé à l''administrateur'; end if;
  return coalesce((select jsonb_agg(referral_overview(g.id) order by g.referral_enabled desc, g.name)
                   from guides g where g.status = 'validated'), '[]'::jsonb);
end $$;
grant execute on function public.admin_referrals() to authenticated;

-- Clôture d'un mois : calcule (ou recalcule) les primes encore « estimées ». Les primes validées ou versées ne bougent plus.
create or replace function public.close_referral_month(p_month date) returns int
language plpgsql security definer set search_path = public as $$
declare rs referral_settings; m0 date := date_trunc('month', p_month)::date; m1 date; p record; f record;
        q3 timestamptz; w_end timestamptz; k bigint; n int; reward bigint; done int := 0;
begin
  if not is_admin() then raise exception 'réservé à l''administrateur'; end if;
  select * into rs from referral_settings where id = 1;
  m1 := (m0 + interval '1 month')::date;
  for p in select id from guides where status = 'validated' and referral_enabled loop
    select qualified_at into q3 from referral_filleuls(p.id) where rank = rs.needed;
    continue when q3 is null;
    w_end := q3 + make_interval(months => rs.months);
    for f in select filleul_id from referral_filleuls(p.id) where rank <= rs.needed loop
      select coalesce(sum(kombrio_cents), 0), count(*) into k, n from visits
      where guide_id = f.filleul_id and status in ('received', 'payout_pending', 'paid')
        and received_at >= greatest(m0::timestamptz, q3) and received_at < least(m1::timestamptz, w_end);
      continue when n = 0;
      reward := greatest(0, least(floor(k * rs.parrain_rate)::bigint, k - rs.cost_cents * n - rs.safety_cents - rs.floor_cents * n));
      insert into referral_rewards (parrain_id, filleul_id, month, k_cents, tx_count, reward_cents)
      values (p.id, f.filleul_id, m0, k, n, reward)
      on conflict (parrain_id, filleul_id, month) do update
        set k_cents = excluded.k_cents, tx_count = excluded.tx_count, reward_cents = excluded.reward_cents
        where referral_rewards.status = 'estimated';
      done := done + 1;
    end loop;
  end loop;
  perform log_event('admin', 'referral_month_closed', null, null, null, jsonb_build_object('month', m0, 'rows', done));
  return done;
end $$;
grant execute on function public.close_referral_month(date) to authenticated;

-- Primes : valider, marquer versée (référence Pix) ou annuler (motif).
create or replace function public.set_referral_reward(p_reward uuid, p_action text, p_text text) returns boolean
language plpgsql security definer set search_path = public as $$
declare r referral_rewards;
begin
  if not is_admin() then raise exception 'réservé à l''administrateur'; end if;
  select * into r from referral_rewards where id = p_reward for update;
  if not found then return false; end if;
  if p_action = 'validate' and r.status = 'estimated' then
    update referral_rewards set status = 'validated', validated_at = now() where id = r.id;
  elsif p_action = 'pay' and r.status = 'validated' and nullif(trim(coalesce(p_text, '')), '') is not null then
    update referral_rewards set status = 'paid', paid_at = now(), pix_ref = trim(p_text) where id = r.id;
  elsif p_action = 'cancel' and r.status in ('estimated', 'validated') and nullif(trim(coalesce(p_text, '')), '') is not null then
    update referral_rewards set status = 'cancelled', note = trim(p_text) where id = r.id;
  else
    return false;
  end if;
  perform log_event('admin', 'referral_reward_' || p_action, null, null, null,
    jsonb_build_object('reward', r.id, 'parrain', r.parrain_id, 'cents', r.reward_cents, 'text', p_text));
  return true;
end $$;
grant execute on function public.set_referral_reward(uuid, text, text) to authenticated;
