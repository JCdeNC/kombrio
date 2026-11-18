-- Kombrio v103 (18/11/2026) : ACTIVATION IMMÉDIATE + INSCRIPTION ENTREPRISE.
--   1. Un guide, une Tour Company ou une agence travaille dès que son e-mail est confirmé (groupes, QR, badge, passages,
--      commissions). La validation par Kombrio (Cadastur, documents) rend le compte DÉFINITIF : les VIREMENTS (repasses)
--      attendent cette validation (guides.verified_at). Rien d'autre n'est bloqué.
--   2. Tour Company et agence : nom de l'entreprise + CNPJ + nom du responsable (guides.contact_name) + CPF du responsable.
--   3. Les comptes déjà validés sont marqués « vérifiés » ; les inscriptions en attente dont l'e-mail est déjà confirmé
--      deviennent actives tout de suite (elles restent dans « À valider » chez l'admin).
-- À lancer une fois dans Supabase › SQL Editor. Peut être relancé sans danger.

-- 1. Colonnes.
alter table guides add column if not exists verified_at timestamptz;
alter table guides add column if not exists contact_name text;
update guides set verified_at = coalesce(verified_at, created_at, now()) where status in ('validated', 'suspended') and verified_at is null;

-- 2. Inscription : nom du responsable (obligatoire pour TC et agence).
do $$ declare src text; begin
  select pg_get_functiondef('public.handle_new_user()'::regprocedure) into src;
  if src like '%contact_required%' then return; end if;
  if src not like '%pix_holder, referred_by, actor_kind)%'
     or src not like '%then m->>''actor_kind'' else ''guide'' end);%'
     or src not like '%raise exception ''cnpj_required''; end if;%' then
    raise exception 'handle_new_user : inscription TC/agence introuvable (lancer 065 d''abord), script arrêté';
  end if;
  src := replace(src, 'raise exception ''cnpj_required''; end if;',
    'raise exception ''cnpj_required''; end if;
    if m->>''actor_kind'' in (''tc'', ''agency'') and nullif(trim(coalesce(m->>''contact_name'', '''')), '''') is null then raise exception ''contact_required''; end if;   -- v103');
  src := replace(src, 'pix_holder, referred_by, actor_kind)', 'pix_holder, referred_by, actor_kind, contact_name)');
  src := replace(src, 'then m->>''actor_kind'' else ''guide'' end);',
    'then m->>''actor_kind'' else ''guide'' end, nullif(left(trim(coalesce(m->>''contact_name'', '''')), 120), ''''));');
  execute src;
end $$;

-- 3. E-mail confirmé : le compte devient actif (code KG/KT/KA attribué tout de suite).
create or replace function public.guide_activate_on_confirm() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.email_confirmed_at is not null and (tg_op = 'INSERT' or old.email_confirmed_at is null) then
    update guides set status = 'validated' where id = new.id and status = 'pending';
  end if;
  return new;
end $$;
drop trigger if exists on_auth_user_email_confirmed on auth.users;
create trigger on_auth_user_email_confirmed after insert or update of email_confirmed_at on auth.users
  for each row execute function public.guide_activate_on_confirm();

-- Inscriptions déjà en attente avec e-mail confirmé : actives maintenant.
update guides g set status = 'validated' from auth.users u
where u.id = g.id and g.status = 'pending' and u.email_confirmed_at is not null;

-- 4. Virements : seulement pour un compte vérifié par Kombrio.
create or replace function public.payout_needs_verified() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (select verified_at from guides where id = new.guide_id) is null then raise exception 'guide_not_verified'; end if;
  return new;
end $$;
drop trigger if exists payouts_verified_only on payouts;
create trigger payouts_verified_only before insert on payouts for each row execute function public.payout_needs_verified();

insert into ledger (actor_kind, event, data) values ('system', 'immediate_activation_installed', jsonb_build_object('version', 'v103'));

-- Contrôle : les trois doivent valoir true ; « a_valider » = comptes actifs qui attendent ta validation.
select pg_get_functiondef('public.handle_new_user()'::regprocedure) like '%contact_required%' as inscription_entreprise,
       exists (select 1 from pg_trigger where tgname = 'on_auth_user_email_confirmed') as activation_email,
       exists (select 1 from pg_trigger where tgname = 'payouts_verified_only') as virement_apres_validation,
       (select count(*) from guides where verified_at is null and status <> 'refused') as a_valider;
