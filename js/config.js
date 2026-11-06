// Connexion à la base Supabase (projet « kombrio », région São Paulo).
// La clé « publishable » est faite pour être visible dans les applications :
// la sécurité vient des règles d'accès de la base (supabase/schema.sql).
// Ne JAMAIS mettre ici la clé secrète (sb_secret_…).
export const SUPABASE_URL = 'https://pdgmmucyzixfxzmrtwhh.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_xAkmmV2JSogQ7F45fp9OAQ_gqGhd6cb';

// Bouton « Adicionar à Carteira do Google » sur la page client.
// À passer à true une fois la fonction Supabase « carteira-google » déployée et ses secrets remplis.
export const WALLET_GOOGLE = true;
