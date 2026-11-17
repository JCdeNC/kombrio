-- Kombrio v85 (17/11/2026, demande de JC) : le bilan hebdomadaire du lundi part aussi, en copie, sur jean.c.turcon@gmail.com.
-- Seul l'e-mail de bilan (weekly_routine, script 038) change ; les rappels INSS et agenda gardent leurs deux boîtes.
-- À lancer une fois dans Supabase › SQL Editor. Peut être relancé sans danger.
do $$ declare src text; begin
  select pg_get_functiondef('public.weekly_routine(jsonb)'::regprocedure) into src;
  if src like '%jean.c.turcon@gmail.com%' then return; end if;   -- déjà fait
  if src not like '%array[''jean.c@kombrio.com.br'', ''kombrio.admin@gmail.com'']%' then
    raise exception 'weekly_routine : liste des destinataires introuvable, script arrêté';
  end if;
  src := replace(src, 'array[''jean.c@kombrio.com.br'', ''kombrio.admin@gmail.com'']',
                      'array[''jean.c@kombrio.com.br'', ''kombrio.admin@gmail.com'', ''jean.c.turcon@gmail.com'']');
  execute src;
end $$;
revoke execute on function public.weekly_routine(jsonb) from public, anon, authenticated;
insert into ledger (actor_kind, event, data) values ('system', 'weekly_report_recipient_added', jsonb_build_object('to', 'jean.c.turcon@gmail.com'));
select pg_get_functiondef('public.weekly_routine(jsonb)'::regprocedure) like '%jean.c.turcon@gmail.com%' as copie_gmail_en_place;
