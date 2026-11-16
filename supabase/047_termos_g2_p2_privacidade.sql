-- v74 · 16/11/2026 : conditions du guide G-2 (nouvelles), conditions du partenaire P-2, politique de confidentialité v1.
-- Acceptation obligatoire : le guide et le gérant du partenaire acceptent la version en vigueur à leur prochaine connexion
-- (version, date et empreinte SHA-256 gardées, événement dans le journal). Textes : document « Kombrio — Termos do guia… ».
-- À lancer une fois dans Supabase › SQL Editor. Relançable sans effet de bord.

------------------------------------------------------------------------------------------------
-- 1. Un troisième type de texte : la politique de confidentialité
------------------------------------------------------------------------------------------------
alter table terms_texts drop constraint if exists terms_texts_kind_check;
alter table terms_texts add constraint terms_texts_kind_check check (kind in ('partner', 'guide', 'privacy'));

------------------------------------------------------------------------------------------------
-- 2. Les textes (non modifiables une fois insérés : une correction = une nouvelle version)
------------------------------------------------------------------------------------------------
insert into terms_texts (kind, version, body, sha256) values ('guide', 'G-2 · 16/11/2026', $body$<h3>1. O serviço</h3>
<p>A Kombrio (Kombrio Intermediação Ltda.) é uma rede de estabelecimentos parceiros recomendados (restaurantes, lojas, atividades). O guia pode recomendar esses parceiros aos seus clientes. A Kombrio não é agência de turismo, não organiza visitas e não é empregadora do guia.</p>
<h3>2. Cadastro</h3>
<p>O guia informa nome, telefone, CPF, número Cadastur válido e uma chave Pix no seu próprio nome. Informa também o seu status fiscal (só CPF, MEI ou outra empresa) e continua responsável pelas suas próprias obrigações fiscais. A Kombrio verifica o cadastro antes de ativar a conta. O guia avisa a Kombrio se o seu Cadastur vencer ou for cancelado.</p>
<h3>3. Independência</h3>
<p>O guia continua totalmente livre de recomendar ou não um parceiro, de levar ou não os seus clientes a um parceiro e de montar o seu roteiro como quiser. A Kombrio não impõe nenhuma meta de recomendações, visitas ou vendas, e não aplica nenhuma penalidade se o guia não recomendar ninguém.</p>
<h3>4. O que é proibido</h3>
<p>O guia não pode: cobrar ou exigir comissão de um estabelecimento como condição para levar turistas (Portaria MTur 37/2021, art. 9, VI); condicionar o acompanhamento do turista a uma visita ou a uma compra; pressionar o turista a consumir, ou dar informações falsas sobre um parceiro; usar, copiar ou repassar o QR de outro guia ou de outro cliente.</p>
<h3>5. Informação ao turista</h3>
<p>O guia informa ao turista os serviços que presta e os preços correspondentes. Informa também que pode ser remunerado pelos parceiros da Kombrio, e que o turista é livre de não ir a nenhum deles.</p>
<h3>6. Remuneração</h3>
<p>A remuneração do guia corresponde a uma indicação de negócio efetivamente reconhecida. Ela só é devida sobre comissões efetivamente recebidas pela Kombrio dos parceiros. A parte do guia é de 80 % da comissão, fixada no dia da visita, com repasse mensal por Pix e extrato detalhado no aplicativo. Quando o guia acompanha o cliente no parceiro (modo «guia presente»), o repasse pode ser feito no dia útil seguinte ao recebimento, como indicado no aplicativo. Um erro ou uma devolução é corrigido por um lançamento de ajuste no repasse seguinte, nunca apagando a transação. Nenhum repasse é feito sem CPF ou CNPJ e chave Pix válidos no cadastro. A chave Pix é informada pelo guia, no seu próprio nome: a Kombrio não responde por um repasse enviado à chave informada pelo guia.</p>
<h3>7. QR do cliente</h3>
<p>O guia cria um QR por cliente ou grupo, válido só nas datas da estadia. Uma visita só é registrada pelo parceiro, uma vez por dia e por grupo. Qualquer uso fraudulento leva à suspensão da conta e ao cancelamento das comissões envolvidas.</p>
<h3>8. Programa de indicação</h3>
<p>Quando ativado pela Kombrio, o guia pode indicar outros guias. As regras ficam no aplicativo. Autoindicação e contas múltiplas são proibidas.</p>
<h3>9. Dados pessoais</h3>
<p>A Kombrio trata os dados do guia só para o serviço e os pagamentos (execução do contrato e obrigações legais). Os dados são guardados durante a relação e por 5 anos depois, para as obrigações fiscais e de prova. O guia pode pedir acesso, correção ou exclusão (salvo o que a lei obriga a guardar) pelo e-mail contato@kombrio.com.br. Detalhes na Política de privacidade.</p>
<h3>10. Suspensão e encerramento</h3>
<p>O guia pode encerrar a conta a qualquer momento. A Kombrio pode suspender a conta em caso de Cadastur vencido, fraude ou descumprimento destes termos, após aviso ao guia e oportunidade de resposta. O guia tem 10 dias para responder a um aviso de suspensão. As remunerações já devidas são pagas, salvo as ligadas a uma fraude.</p>
<h3>11. Alterações</h3>
<p>Uma nova versão destes termos é apresentada ao guia para aceite, com pelo menos 15 dias de antecedência. O guia que não aceitar pode encerrar a conta e recebe o que já é devido.</p>
<h3>12. Responsabilidade</h3>
<p>A Kombrio não responde pelos serviços prestados pelo guia nem pelos parceiros. O guia responde pelos seus serviços e pela sua conduta perante o turista.</p>
<h3>13. Contestação</h3>
<p>Um valor ou uma visita pode ser contestado em até 30 dias após o extrato do mês. Depois desse prazo, o extrato é considerado aceito.</p>
<h3>14. Comunicações</h3>
<p>Os avisos são enviados ao e-mail ou WhatsApp do cadastro, que o guia mantém atualizado.</p>
<h3>15. Lei e foro</h3>
<p>Estes termos seguem a lei brasileira. Fica eleito o foro da comarca do Rio de Janeiro (RJ).</p>$body$, '')
on conflict (kind, version) do nothing;

insert into terms_texts (kind, version, body, sha256) values ('partner', 'P-2 · 16/11/2026', $body$<h3>1. O serviço</h3>
<p>A Kombrio (Kombrio Intermediação Ltda.) conecta guias de turismo cadastrados e estabelecimentos parceiros (restaurantes, lojas). O guia recomenda o parceiro ao seu cliente; o cliente apresenta o QR Kombrio no estabelecimento; a visita é registrada pelo parceiro.</p>
<h3>2. Cadastro e acesso</h3>
<p>O acesso do gerente é pessoal, com e-mail e senha. O responsável informado no primeiro acesso representa o estabelecimento perante a Kombrio. O QR da caixa serve apenas para registrar as visitas e não dá acesso aos pagamentos.</p>
<h3>3. Registro das visitas</h3>
<p>O parceiro se compromete a escanear o QR de cada cliente Kombrio atendido e a conceder, quando houver, a oferta anunciada, uma vez por grupo e por estadia.</p>
<h3>4. Comissão</h3>
<p>Para cada visita registrada, a comissão segue o modelo escolhido pelo parceiro no seu espaço (percentual da conta, valor por pessoa, bônus). Ela é calculada sobre o consumo pago, depois dos descontos, sem a taxa de serviço de 10 % e sem gorjetas. A comissão é paga à Kombrio por Pix ou transferência, com o comprovante, de uma vez ou agrupada (por exemplo, mensalmente).</p>
<h3>5. Prazo de pagamento</h3>
<p>As comissões do mês devem ser declaradas e pagas até o dia 10 do mês seguinte. A Kombrio pode enviar lembretes ao responsável (WhatsApp ou e-mail).</p>
<h3>6. Repasse ao guia</h3>
<p>A Kombrio repassa 80 % de cada comissão recebida ao guia que fez a recomendação e conserva 20 % pelo serviço. O parceiro não paga nada ao guia diretamente.</p>
<h3>7. Oferta</h3>
<p>A oferta aos clientes Kombrio é opcional, definida e alterada pelo próprio parceiro no seu espaço, com as datas de validade que ele escolher.</p>
<h3>8. Dados pessoais (LGPD)</h3>
<p>A Kombrio trata apenas os dados necessários ao serviço (nome do cliente ou grupo, número de pessoas, data da visita, valores e comprovantes) e não os vende. Ela os compartilha só com os prestadores necessários ao serviço (hospedagem dos dados, banco para os Pix). O parceiro pode pedir acesso, correção ou exclusão dos seus dados. Detalhes na Política de privacidade.</p>
<h3>9. Relatórios</h3>
<p>O parceiro tem acesso aos relatórios mensais e pode compartilhar um link somente leitura com o seu contador.</p>
<h3>10. Duração e encerramento</h3>
<p>Prazo indeterminado. Qualquer uma das partes pode encerrar a parceria a qualquer momento, com as comissões das visitas já registradas devidas.</p>
<h3>11. Alterações</h3>
<p>A Kombrio pode atualizar estes termos. A nova versão é apresentada ao parceiro para aceite, com pelo menos 15 dias de antecedência. O parceiro que não aceitar pode encerrar a parceria nas condições da cláusula 10.</p>
<h3>12. Equipe</h3>
<p>O gerente pode criar acessos para a sua equipe (caixa, garçons). Ele responde pelo uso desses acessos e os desativa quando um funcionário sai.</p>
<h3>13. Responsabilidade</h3>
<p>A Kombrio faz a intermediação e o cálculo das comissões. Ela não responde pelos produtos e serviços do parceiro nem pelos serviços do guia.</p>
<h3>14. Contestação</h3>
<p>O parceiro pode contestar uma visita ou um valor em até 30 dias após o relatório do mês, pelo aplicativo ou por e-mail. Depois desse prazo, o relatório é considerado aceito.</p>
<h3>15. Atraso de pagamento</h3>
<p>Sem pagamento após o prazo da cláusula 5 e um lembrete, a Kombrio pode suspender o parceiro da lista mostrada aos guias e turistas até a regularização. As comissões devidas continuam devidas.</p>
<h3>16. Declarações falsas</h3>
<p>Deixar de registrar visitas de clientes Kombrio ou declarar um valor falso é motivo de encerramento imediato da parceria, sem prejuízo das comissões devidas.</p>
<h3>17. Comunicações</h3>
<p>Os avisos são enviados ao e-mail ou WhatsApp do responsável, que o parceiro mantém atualizados. Contato da Kombrio: contato@kombrio.com.br.</p>
<h3>18. Lei e foro</h3>
<p>Estes termos seguem a lei brasileira. Fica eleito o foro da comarca do Rio de Janeiro (RJ).</p>$body$, '')
on conflict (kind, version) do nothing;

insert into terms_texts (kind, version, body, sha256) values ('privacy', 'v1 · 16/11/2026', $body$<p>Uma única política para guias, parceiros e turistas.</p>
<h3>Responsável</h3>
<p>Kombrio Intermediação Ltda., Rio de Janeiro (RJ). Contato para os dados pessoais: contato@kombrio.com.br.</p>
<h3>Dados, finalidades e base legal (LGPD, art. 7)</h3>
<table class="tbl"><thead><tr><th>Quem</th><th>Dados</th><th>Para quê</th><th>Base legal</th></tr></thead><tbody>
<tr><td>Guia</td><td>nome, telefone, e-mail, CPF ou CNPJ, Cadastur, chave Pix, foto do crachá</td><td>verificar o guia, calcular e pagar as comissões</td><td>execução do contrato, obrigações legais</td></tr>
<tr><td>Parceiro</td><td>nome e contato do responsável e da equipe, valores, comprovantes</td><td>registrar visitas, cobrar e repassar as comissões</td><td>execução do contrato, obrigações legais</td></tr>
<tr><td>Turista</td><td>nome do grupo, número de pessoas (e de crianças), datas da estadia e das visitas</td><td>registrar as visitas nos parceiros</td><td>legítimo interesse</td></tr>
</tbody></table>
<h3>Compartilhamento</h3>
<p>Os dados não são vendidos. São compartilhados só com os prestadores necessários: hospedagem dos dados (Supabase), banco para os Pix (Banco Inter), envio de e-mails (Brevo). O parceiro vê só as visitas do seu estabelecimento; o guia vê só as suas comissões. O CPF do guia nunca é mostrado publicamente.</p>
<h3>Prazo de conservação</h3>
<p>Dados de pagamento e comprovantes: 5 anos após o fim da relação, para as obrigações fiscais e de prova. Dados do turista: 2 anos após a estadia, depois anonimizados.</p>
<h3>Direitos</h3>
<p>Qualquer pessoa pode pedir acesso, correção, cópia ou exclusão dos seus dados pelo e-mail acima, com resposta em até 15 dias. O que a lei obriga a guardar não pode ser apagado antes do prazo. Também é possível reclamar à ANPD.</p>
<h3>Segurança</h3>
<p>Acesso por e-mail e senha, permissões separadas por função, histórico das operações e cópia de segurança diária.</p>$body$, '')
on conflict (kind, version) do nothing;

------------------------------------------------------------------------------------------------
-- 3. Acceptation par le guide (version, date, empreinte du texte accepté)
------------------------------------------------------------------------------------------------
alter table guides add column if not exists terms_version text;
alter table guides add column if not exists terms_accepted_at timestamptz;
alter table guides add column if not exists terms_sha256 text;

create or replace function public.accept_guide_terms(p_version text) returns boolean
language plpgsql security definer set search_path = public as $$
declare s text;
begin
  select sha256 into s from terms_texts where kind = 'guide' and version = p_version;
  if s is null or auth.uid() is null or not exists (select 1 from guides where id = auth.uid()) then return false; end if;
  update guides set terms_version = p_version, terms_accepted_at = now(), terms_sha256 = s where id = auth.uid();
  perform log_event('guide', 'guide_terms_accepted', null, null, null, jsonb_build_object('version', p_version, 'sha256', s));
  return true;
end $$;
revoke execute on function public.accept_guide_terms(text) from public, anon;
grant execute on function public.accept_guide_terms(text) to authenticated;

------------------------------------------------------------------------------------------------
-- 4. Acceptation d'une nouvelle version par le gérant d'un partenaire déjà actif
--    (l'empreinte est posée par le déclencheur partners_terms_hash du script 020)
------------------------------------------------------------------------------------------------
create or replace function public.accept_partner_terms(p_manager_token text, p_version text) returns boolean
language plpgsql security definer set search_path = public as $$
declare p partners;
begin
  select * into p from partners where manager_token = p_manager_token and status = 'active';
  if not found or not exists (select 1 from terms_texts where kind = 'partner' and version = p_version) then return false; end if;
  update partners set terms_version = p_version, terms_accepted_at = now() where id = p.id;
  perform log_event('manager', 'partner_terms_accepted', null, null, null,
    jsonb_build_object('partner', p.id, 'version', p_version, 'from', p.terms_version));
  return true;
end $$;
grant execute on function public.accept_partner_terms(text, text) to anon, authenticated;

insert into ledger (actor_kind, event, data) values ('system', 'termos_g2_p2_privacidade_installed', jsonb_build_object('version', 'v74'));
select (select count(*) from terms_texts) as textes_conditions,
       (select string_agg(kind || ' ' || version, ', ' order by kind) from terms_texts where created_at > now() - interval '1 day') as nouveaux;
