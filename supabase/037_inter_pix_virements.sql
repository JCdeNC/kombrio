-- Kombrio v65 : virement d'un guide par Pix Banco Inter (bouton « Enviar pelo Inter » de l'admin).
-- La fonction Edge « inter » envoie le Pix, suit son statut et ne marque le virement « payé » (confirm_payout)
-- qu'une fois la banque a confirmé, avec l'E2E comme référence. Ce script ajoute seulement les colonnes de suivi.
-- Aucune donnée existante n'est modifiée. À lancer une fois dans Supabase › SQL Editor. Peut être relancé sans danger.

alter table payouts add column if not exists inter_codigo text;               -- codigoSolicitacao d'Inter
alter table payouts add column if not exists inter_idem uuid;                 -- clé d'idempotence (vide = l'identifiant du virement)
alter table payouts add column if not exists inter_status text;               -- dernier statut connu chez Inter
alter table payouts add column if not exists inter_e2e text;                  -- identifiant Pix de bout en bout
alter table payouts add column if not exists inter_recebedor_nome text;       -- titulaire de la clé selon la banque
alter table payouts add column if not exists inter_recebedor_doc text;        -- son CPF/CNPJ (parfois masqué)
alter table payouts add column if not exists inter_holder_ok boolean;         -- même CPF/CNPJ que le guide ?
alter table payouts add column if not exists inter_sent_at timestamptz;
alter table payouts add column if not exists inter_checked_at timestamptz;
alter table payouts add column if not exists inter_error text;
create unique index if not exists payouts_inter_codigo_key on payouts (inter_codigo) where inter_codigo is not null;

insert into ledger (actor_kind, event, data) values ('system', 'inter_payout_installed', jsonb_build_object('version', 'v65'));
select 'suivi Inter des virements installé' as resultat;
