-- Kombrio v31 : vérification Cadastur des guides (demande de JC du 06/11/2026).
-- L'admin consulte le site public du Cadastur depuis l'app, fait une capture d'écran de la fiche du guide,
-- et l'enregistre ici avec la date de fin de validité. Chaque vérification est gardée (historique), jamais modifiée.
-- La date la plus récente est recopiée dans guides.cadastur_valid_until pour l'affichage et les alertes.
-- À lancer une fois dans Supabase › SQL Editor. Peut être relancé sans danger.

alter table guides add column if not exists cadastur_valid_until date;

create table if not exists guide_cadastur_checks (
  id          uuid primary key default gen_random_uuid(),
  num         bigint generated always as identity unique,
  guide_id    uuid not null references guides on delete cascade,
  valid_until date not null,
  proof       text not null check (proof like 'data:image/jpeg;base64,%' and length(proof) < 700000),
  checked_at  timestamptz not null default now(),
  checked_by  uuid
);
create index if not exists guide_cadastur_checks_guide on guide_cadastur_checks (guide_id, checked_at desc);
alter table guide_cadastur_checks enable row level security;
drop policy if exists "admin lit les vérifications Cadastur" on guide_cadastur_checks;
create policy "admin lit les vérifications Cadastur" on guide_cadastur_checks for select using (is_admin());
create or replace function public.cadastur_checks_readonly() returns trigger language plpgsql as $$
begin raise exception 'vérification Cadastur non modifiable'; end $$;
drop trigger if exists cadastur_checks_no_change on guide_cadastur_checks;
create trigger cadastur_checks_no_change before update on guide_cadastur_checks for each row execute function public.cadastur_checks_readonly();

-- Enregistrer une vérification (admin) : capture d'écran JPEG + date de fin de validité (pas dans le passé).
create or replace function public.record_cadastur_check(p_guide uuid, p_valid_until date, p_proof text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c guide_cadastur_checks;
begin
  if not is_admin() then raise exception 'réservé à l''administrateur'; end if;
  if p_valid_until is null or p_valid_until < current_date then return jsonb_build_object('ok', false, 'reason', 'date'); end if;
  if coalesce(p_proof, '') not like 'data:image/jpeg;base64,%' then return jsonb_build_object('ok', false, 'reason', 'proof'); end if;
  if not exists (select 1 from guides where id = p_guide) then return jsonb_build_object('ok', false, 'reason', 'guide'); end if;
  insert into guide_cadastur_checks (guide_id, valid_until, proof, checked_by)
  values (p_guide, p_valid_until, p_proof, auth.uid()) returning * into c;
  update guides set cadastur_valid_until = p_valid_until where id = p_guide;
  perform log_event('admin', 'cadastur_checked', null, null, null,
    jsonb_build_object('guide', p_guide, 'check', c.id, 'num', c.num, 'valid_until', p_valid_until));
  return jsonb_build_object('ok', true, 'id', c.id);
end $$;
grant execute on function public.record_cadastur_check(uuid, date, text) to authenticated;

insert into ledger (actor_kind, event, data) values ('system', 'cadastur_module_installed', jsonb_build_object('version', 'v31'));
select data from ledger where event = 'cadastur_module_installed' order by id desc limit 1;
