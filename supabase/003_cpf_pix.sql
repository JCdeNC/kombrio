-- Kombrio : CPF et clé Pix des guides, CNPJ (ou CPF) des partenaires.
alter table guides add column if not exists cpf text check (cpf is null or cpf ~ '^[0-9]{11}$');
alter table guides add column if not exists pix_key text;
alter table partners add column if not exists tax_id text check (tax_id is null or tax_id ~ '^([0-9]{11}|[0-9]{14})$');

-- L'inscription du guide enregistre aussi son CPF et sa clé Pix.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  m jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  r text;
begin
  r := case when m->>'role' = 'admin' and not exists (select 1 from profiles where role = 'admin') then 'admin' else 'guide' end;
  insert into profiles (id, role) values (new.id, r);
  if r = 'guide' then
    insert into guides (id, city_id, name, phone, license, email, cpf, pix_key)
    values (new.id, coalesce(m->>'city_id', 'rio'), coalesce(nullif(m->>'name', ''), new.email), m->>'phone', m->>'license', new.email,
            nullif(regexp_replace(coalesce(m->>'cpf', ''), '[^0-9]', '', 'g'), ''), nullif(trim(m->>'pix_key'), ''));
  end if;
  return new;
end $$;
