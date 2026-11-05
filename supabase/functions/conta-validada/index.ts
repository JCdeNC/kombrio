// Fonction Supabase « conta-validada » : e-mail « Sua conta foi validada! » au guide.
// Appelée par l'app Admin juste après la validation. Seul un administrateur connecté peut l'utiliser.
// Secret à définir dans Supabase (Edge Functions › Secrets) : BREVO_API_KEY (clé API Brevo, pas la clé SMTP).

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'apikey, content-type, authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

const URL_ = Deno.env.get('SUPABASE_URL')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const admin = (path: string, init: RequestInit = {}) =>
  fetch(`${URL_}${path}`, { ...init, headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const brevo = Deno.env.get('BREVO_API_KEY');
    if (!brevo) return json({ error: 'not_configured' }, 503);

    // Qui appelle ? Il doit être administrateur.
    const me = await (await fetch(`${URL_}/auth/v1/user`, { headers: { apikey: SERVICE, Authorization: req.headers.get('Authorization') ?? '' } })).json();
    if (!me?.id) return json({ error: 'auth' }, 401);
    const prof = await (await admin(`/rest/v1/profiles?id=eq.${me.id}&select=role`)).json();
    if (prof?.[0]?.role !== 'admin') return json({ error: 'forbidden' }, 403);

    const { guideId } = await req.json();
    if (!/^[0-9a-f-]{36}$/.test(guideId ?? '')) return json({ error: 'guide' }, 400);
    const g = (await (await admin(`/rest/v1/guides?id=eq.${guideId}&select=name,status`)).json())?.[0];
    if (!g || g.status !== 'validated') return json({ error: 'guide' }, 400);
    const user = await (await admin(`/auth/v1/admin/users/${guideId}`)).json();
    if (!user?.email) return json({ error: 'guide' }, 400);

    const nome = esc(String(g.name || '').split(' ')[0] || '');
    const html = TEMPLATE.replace('${nome}', nome);
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': brevo, 'Content-Type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        sender: { name: 'Kombrio', email: 'nao-responda@kombrio.com.br' },
        replyTo: { email: 'contato@kombrio.com.br' },
        to: [{ email: user.email, name: g.name || undefined }],
        subject: 'Kombrio: sua conta foi validada!',
        htmlContent: html,
      }),
    });
    if (!r.ok) return json({ error: 'brevo', status: r.status, detail: (await r.text()).slice(0, 200) }, 502);
    return json({ ok: true });
  } catch (e) {
    return json({ error: 'crash', detail: String((e as Error)?.message ?? e).slice(0, 200) }, 500);
  }
});

const TEMPLATE = '<!doctype html>\n<html lang="pt-BR">\n<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>\n<body style="margin:0;padding:0;background:#F4F7F8;font-family:Arial,Helvetica,sans-serif;color:#102C38;">\n  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F7F8;padding:24px 12px;">\n    <tr><td align="center">\n      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid #D9E6E9;border-radius:16px;overflow:hidden;">\n        <tr><td style="background:#102C38;padding:18px 24px;">\n          <img src="https://app.kombrio.com.br/icon-192.png" width="32" height="32" alt="" style="vertical-align:middle;border-radius:8px;">\n          <span style="vertical-align:middle;color:#ffffff;font-size:22px;font-weight:bold;margin-left:8px;">kombrio</span>\n        </td></tr>\n        <tr><td style="padding:28px 24px 8px;">\n          <h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;color:#102C38;">Sua conta foi validada!</h1>\n          <p style="margin:0 0 20px;font-size:16px;line-height:1.5;color:#102C38;">Olá, ${nome}! A equipe Kombrio validou sua conta de guia. Você já pode criar os QR dos seus clientes e acompanhar suas comissões.</p>\n          <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="background:#007F65;border-radius:12px;">\n            <a href="https://app.kombrio.com.br/guide/" style="display:inline-block;padding:14px 24px;color:#ffffff;font-size:16px;font-weight:bold;text-decoration:none;">Abrir o aplicativo Guia</a>\n          </td></tr></table>\n          <p style="margin:20px 0 0;font-size:14px;line-height:1.5;color:#5B6F78;">Dica: no celular, adicione o aplicativo à tela inicial para encontrá-lo sempre com um toque.</p>\n        </td></tr>\n        <tr><td style="padding:20px 24px 24px;">\n          <p style="margin:0;font-size:13px;line-height:1.5;color:#5B6F78;border-top:1px solid #D9E6E9;padding-top:16px;">\n            Kombrio · Guias e parceiros em Rio de Janeiro<br>\n            Dúvidas? Escreva para <a href="mailto:contato@kombrio.com.br" style="color:#2761BA;">contato@kombrio.com.br</a>\n          </p>\n        </td></tr>\n      </table>\n    </td></tr>\n  </table>\n</body>\n</html>\n';
