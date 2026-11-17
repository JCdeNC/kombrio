-- Kombrio (17/11/2026, demande de JC pendant le test avec Frank) : chaque nouveau partenaire reçoit
-- son code d'activation RIO-KP-12345 dès sa création, comme le guide reçoit son code KG à la validation.
-- Les partenaires déjà créés, sans gérant et sans code, en reçoivent un aussi.
-- Le bouton « Nouveau code » de l'admin reste disponible (code perdu, code à changer).
-- À lancer une fois dans Supabase › SQL Editor. Peut être relancé sans danger.

create or replace function public.partner_code_on_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.manager_user is null and new.activation_code is null then
    new.activation_code := make_code(new.city_id, 'KP');
  end if;
  return new;
end $$;
revoke execute on function public.partner_code_on_insert() from public, anon, authenticated;

drop trigger if exists partners_activation_code on partners;
create trigger partners_activation_code before insert on partners
  for each row execute function public.partner_code_on_insert();

-- Rattrapage, un partenaire à la fois (make_code vérifie l'unicité à chaque tour).
do $$ declare r record; n int := 0; begin
  for r in select id, city_id from partners where manager_user is null and activation_code is null loop
    update partners set activation_code = make_code(r.city_id, 'KP') where id = r.id;
    n := n + 1;
  end loop;
  if n > 0 then
    insert into ledger (actor_kind, event, data)
    values ('system', 'partner_activation_codes_backfilled', jsonb_build_object('count', n));
  end if;
end $$;

-- Contrôle : 0 attendu (aucun partenaire sans gérant ni code).
select count(*) as partenaires_sans_code from partners where manager_user is null and activation_code is null;
