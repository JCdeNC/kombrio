-- Kombrio v101 (18/11/2026) : CORRECTIF DU 061. L'inscription « Tour Company » ou « Agência » créait un compte GUIDE.
-- Cause : le 061 sautait la mise à jour de handle_new_user() s'il y voyait déjà le mot « actor_kind » ; or ce mot y
-- figure depuis longtemps (journal « insert into ledger (actor, actor_kind, ...) »). La mise à jour n'a donc jamais eu lieu.
-- Ce script :
--   1. branche vraiment le type choisi (guide / TC / agence) dans l'inscription, avec CNPJ obligatoire pour TC et agence ;
--   2. remet au bon type les comptes déjà créés comme TC ou agence (s'il y en a) : type + code KG → KT / KA (mêmes chiffres).
-- À lancer une fois dans Supabase › SQL Editor. Peut être relancé sans danger.

do $$ declare src text; begin
  select pg_get_functiondef('public.handle_new_user()'::regprocedure) into src;
  if src like '%cnpj_required%' then return; end if;   -- déjà branché
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

-- Comptes déjà inscrits comme TC ou agence mais enregistrés en guide (seulement s'ils ont un CNPJ).
with fix as (
  select g.id, u.raw_user_meta_data->>'actor_kind' as k
  from guides g join auth.users u on u.id = g.id
  where g.actor_kind = 'guide' and g.tax_kind = 'cnpj' and u.raw_user_meta_data->>'actor_kind' in ('tc', 'agency'))
update guides g set actor_kind = fix.k,
       code = case when g.code like '%-KG-%' then replace(g.code, '-KG-', case fix.k when 'tc' then '-KT-' else '-KA-' end) else g.code end
from fix where g.id = fix.id;

insert into ledger (actor_kind, event, data) values ('system', 'actor_signup_fixed', jsonb_build_object('version', 'v101'));

-- Contrôle : doit valoir true.
select pg_get_functiondef('public.handle_new_user()'::regprocedure) like '%cnpj_required%' as inscription_tc_agence,
       (select count(*) from guides where actor_kind <> 'guide') as comptes_tc_agence;
