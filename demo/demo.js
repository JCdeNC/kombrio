// KOMBRIO DEMO COMPLETA (v104, 18/11/2026) : présentation aux établissements (3 min), en portugais du Brésil,
// qui se termine sur l'inscription. La version courte (« pub ») est demo/index.html + pub.js.
// Tout est fictif et calculé dans la page : aucune connexion à Supabase, aucun Pix, aucune donnée enregistrée.
// Mêmes règles de calcul que l'application : commission = addition × taux ; guide = 80 % arrondi au centavo
// inférieur, Kombrio = le reste ; INSS du guide CPF = 11 % de sa part, arrondi (comme le script 028).
// Écrit sans syntaxe récente (?. ??) pour les vieux téléphones (exigence : iOS 13.4 / Chrome 80).
(function () {
  'use strict';

  // Fin de la démonstration : inscription de l'établissement et FAQ (pas de numéro de téléphone).
  var SIGNUP = '../partner/#/parceria';
  var FAQ = '../faq/?s=partner';

  var GUIDE_SHARE = 0.8;
  var INSS_RATE = 0.11;
  var TOTAL = 10;

  var state;
  function reset() {
    state = { step: 1, bill: 50000, rate: 10, scanned: false, stage: 2, cpf: true, paid: false };
  }
  reset();

  // ---------- Calculs (centavos) ----------
  function commission(bill, rate) { return Math.round(bill * rate / 100); }
  function guidePart(c) { return Math.floor(c * GUIDE_SHARE); }
  function inss(g) { return Math.round(g * INSS_RATE); }
  function brl(c) { return (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }
  function day(offset) {
    var d = new Date(); d.setDate(d.getDate() + offset);
    return ('0' + d.getDate()).slice(-2) + '/' + ('0' + (d.getMonth() + 1)).slice(-2);
  }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  var EX = '<span class="dm-ex">exemplo</span>';

  // ---------- Données fictives ----------
  var REST = 'Restaurante Vista Mar';
  function monthRows() {
    var r = state.rate;
    return [
      { d: day(-14), guide: 'Bruno Lima', p: 2, bill: 18000 },
      { d: day(-11), guide: 'Ana Souza', p: 6, bill: 72000 },
      { d: day(-8), guide: 'Carla Mendes', p: 3, bill: 26000 },
      { d: day(-5), guide: 'Bruno Lima', p: 5, bill: 41000 },
      { d: day(0), guide: 'Ana Souza', p: 4, bill: state.bill, now: true }
    ].map(function (x) { x.c = commission(x.bill, r); return x; });
  }
  function anaRows() {
    return [
      { d: day(-11), place: REST, p: 6, bill: 72000, rate: state.rate },
      { d: day(-9), place: 'Bistrô Santa Teresa', p: 3, bill: 30000, rate: 12 },
      { d: day(-2), place: 'Loja Arte Rio', p: 2, bill: 25000, rate: 8 },
      { d: day(0), place: REST, p: 4, bill: state.bill, rate: state.rate, now: true }
    ].map(function (x) { x.c = commission(x.bill, x.rate); x.g = guidePart(x.c); x.i = state.cpf ? inss(x.g) : 0; return x; });
  }

  // ---------- Écrans ----------
  var screens = {};

  screens[1] = function () {
    return '<p class="dm-kicker">Kombrio</p>'
      + '<h1>Comissões entre restaurantes e guias, sem planilha e sem cobrança.</h1>'
      + '<p class="dm-lead">A KOMBRIO simplifica o controle e o pagamento das comissões entre estabelecimentos e guias, com transparência e rastreabilidade.</p>'
      + '<ul class="dm-points">'
      + '<li><span class="dm-ico">✓</span><span><b>Cada cliente trazido por um guia fica registrado</b>, na hora, com data e número de pessoas.</span></li>'
      + '<li><span class="dm-ico">✓</span><span><b>A comissão é calculada sozinha</b> com a taxa que você combinou.</span></li>'
      + '<li><span class="dm-ico">✓</span><span><b>Um único Pix por mês</b> para todos os guias: a Kombrio repassa a cada um.</span></li>'
      + '</ul>'
      + '<button type="button" class="btn dm-big" data-go="2">Começar a demonstração (3 min)</button>'
      + '<p class="dm-muted" style="margin-top:12px">Esta demonstração usa apenas exemplos: nenhum pagamento é feito.</p>';
  };

  screens[2] = function () {
    return '<p class="dm-kicker">O problema hoje</p>'
      + '<h1>Como funciona hoje com os guias?</h1>'
      + '<ul class="dm-points">'
      + '<li><span class="dm-ico bad">✕</span><span>Anotações no caderno, mensagens no WhatsApp, planilhas.</span></li>'
      + '<li><span class="dm-ico bad">✕</span><span>Nem sempre se sabe <b>quem trouxe qual cliente</b>.</span></li>'
      + '<li><span class="dm-ico bad">✕</span><span>Comissões pagas uma a uma, às vezes em dinheiro, sem comprovante.</span></li>'
      + '<li><span class="dm-ico bad">✕</span><span>Cobranças, dúvidas e discussões no fim do mês.</span></li>'
      + '</ul>'
      + '<div class="notice ok"><b>Com a Kombrio:</b> tudo é registrado na hora e cada um — restaurante, guia e Kombrio — vê a mesma informação.</div>';
  };

  screens[3] = function () {
    return '<p class="dm-kicker">Etapa 1 · O guia</p>'
      + '<h1>O guia cria o QR do cliente</h1>'
      + '<div class="dm-pass">'
      + '<div><b>Ana Souza</b> · guia de turismo ' + EX + '</div>'
      + '<div class="dm-qr" id="dm-qr"></div>'
      + '<div><b>Família Martin · 4 pessoas</b></div>'
      + '<div class="dm-muted">Válido de ' + day(0) + ' a ' + day(4) + '</div>'
      + '</div>'
      + '<ul class="dm-points">'
      + '<li><span class="dm-ico">📱</span><span>O cliente guarda o QR no celular. <b>Nada para instalar.</b></span></li>'
      + '<li><span class="dm-ico">📅</span><span>O QR vale só durante a estadia (no máximo 7 dias).</span></li>'
      + '</ul>';
  };

  screens[4] = function () {
    var body = state.scanned
      ? '<div class="notice ok"><div class="dm-ok"><span class="dm-ico">✓</span><b>Visita registrada</b></div></div>'
        + '<div class="card"><div class="dm-row"><span>Guia</span><b>Ana Souza</b></div>'
        + '<div class="dm-row"><span>Cliente</span><b>Família Martin</b></div>'
        + '<div class="dm-row"><span>Pessoas</span><b>4</b></div>'
        + '<div class="dm-row"><span>Data</span><b>' + day(0) + '</b></div></div>'
        + '<p class="dm-muted">Ninguém precisa anotar nada: o guia certo recebe a visita.</p>'
      : '<p>O cliente mostra o QR. O restaurante escaneia com a câmera do celular.</p>'
        + '<button type="button" class="btn dm-big" id="dm-scan">📷 Simular a leitura do QR</button>';
    return '<p class="dm-kicker">Etapa 2 · ' + REST + ' ' + EX + '</p>'
      + '<h1>O cliente chega ao restaurante</h1>' + body;
  };

  screens[5] = function () {
    var c = commission(state.bill, state.rate), g = guidePart(c), k = c - g;
    var pct = c ? Math.round(g / c * 100) : 80;
    return '<p class="dm-kicker">Etapa 3 · A conta ' + EX + '</p>'
      + '<h1>O restaurante informa o valor da conta</h1>'
      + '<div class="card">'
      + '<div class="dm-slider"><label for="dm-bill"><span>Valor da conta</span><span id="dm-bill-v">' + brl(state.bill) + '</span></label>'
      + '<input type="range" id="dm-bill" min="5000" max="200000" step="1000" value="' + state.bill + '"></div>'
      + '<div class="dm-slider"><label for="dm-rate"><span>Comissão combinada</span><span id="dm-rate-v">' + state.rate + ' %</span></label>'
      + '<input type="range" id="dm-rate" min="1" max="30" step="1" value="' + state.rate + '"></div>'
      + '</div>'
      + '<div class="card" id="dm-calc">' + calcBox(c, g, k, pct) + '</div>'
      + '<p class="dm-muted">Você escolhe a sua taxa. Os 20 % da Kombrio saem da comissão, não da conta: <b>o cliente e o restaurante não pagam nada a mais.</b></p>';
  };
  function calcBox(c, g, k, pct) {
    return '<div class="dm-row"><span>Conta</span><b>' + brl(state.bill) + '</b></div>'
      + '<div class="dm-row total"><span>Comissão (' + state.rate + ' %)</span><b>' + brl(c) + '</b></div>'
      + '<div class="dm-split" aria-hidden="true"><span style="width:' + pct + '%"></span><span style="width:' + (100 - pct) + '%"></span></div>'
      + '<div class="dm-row sub"><span>Para o guia (80 %)</span><b>' + brl(g) + ' bruto</b></div>'
      + '<div class="dm-row sub"><span>Para a Kombrio (20 %)</span><b>' + brl(k) + '</b></div>'
      + '<p class="dm-muted" style="margin:8px 0 0">Do valor do guia são retidos os impostos previstos em lei (INSS): veja no painel do guia.</p>';
  }

  screens[6] = function () {
    var rows = monthRows(), total = rows.reduce(function (s, x) { return s + x.c; }, 0);
    return '<p class="dm-kicker">Etapa 4 · O mês do restaurante ' + EX + '</p>'
      + '<h1>Tudo em um só lugar</h1>'
      + '<div class="card" style="padding:10px 12px"><table class="dm-table"><tr><th>Data</th><th>Guia</th><th class="r">Conta</th><th class="r">Comissão</th></tr>'
      + rows.map(function (x) {
        return '<tr' + (x.now ? ' class="now"' : '') + '><td>' + x.d + '</td><td>' + esc(x.guide) + '<div class="dm-muted">' + x.p + ' pessoas</div></td><td class="r">' + brl(x.bill) + '</td><td class="r"><b>' + brl(x.c) + '</b></td></tr>';
      }).join('')
      + '</table>'
      + '<div class="dm-row total" style="margin-top:6px"><span>Total do mês</span><b>' + brl(total) + '</b></div></div>'
      + (state.paid
        ? '<div class="notice ok"><b>Simulação:</b> nenhum Pix foi feito. Na vida real, a Kombrio confirma o recebimento e repassa a cada guia a sua parte.</div>'
        : '<button type="button" class="btn dm-big" id="dm-pay">Pagar com um único Pix (simulação)</button>')
      + '<p class="dm-muted" style="margin-top:10px">Um Pix para a Kombrio, em vez de pagar cada guia. Cada pagamento tem o seu comprovante.</p>';
  };

  screens[7] = function () {
    var rows = anaRows();
    var g = rows.reduce(function (s, x) { return s + x.g; }, 0), i = rows.reduce(function (s, x) { return s + x.i; }, 0);
    return '<p class="dm-kicker">Etapa 5 · O painel da guia ' + EX + '</p>'
      + '<h1>Ana vê tudo o que ganhou</h1>'
      + '<div class="card" style="padding:10px 12px"><table class="dm-table"><tr><th>Data</th><th>Onde</th><th class="r">Para a guia</th></tr>'
      + rows.map(function (x) {
        return '<tr' + (x.now ? ' class="now"' : '') + '><td>' + x.d + '</td><td>' + esc(x.place) + '<div class="dm-muted">' + x.p + ' pessoas · comissão ' + brl(x.c) + '</div></td><td class="r">' + brl(x.g) + '</td></tr>';
      }).join('')
      + '</table>'
      + '<div class="dm-row" style="margin-top:6px"><span>Total bruto</span><b>' + brl(g) + '</b></div>'
      + '<div class="dm-row"><span>INSS retido (' + (state.cpf ? '11 %' : 'não se aplica') + ')</span><b>' + (i ? '− ' + brl(i) : brl(0)) + '</b></div>'
      + '<div class="dm-row total"><span>Pix para a guia</span><b>' + brl(g - i) + '</b></div></div>'
      + '<div class="row" style="gap:8px;justify-content:center;margin:4px 0 10px">'
      + '<button type="button" class="btn small ' + (state.cpf ? '' : 'ghost') + '" data-cpf="1">Guia com CPF</button>'
      + '<button type="button" class="btn small ' + (state.cpf ? 'ghost' : '') + '" data-cpf="0">Guia com CNPJ</button></div>'
      + '<p class="dm-muted">Guia com CPF: a Kombrio retém e declara o INSS (11 %) como a lei exige, com recibo para cada estabelecimento. Guia com CNPJ: sem retenção.</p>'
      + '<p class="dm-muted">Vários estabelecimentos, <b>um único repasse por Pix</b>, com histórico confiável.</p>';
  };

  var STAGES = ['Visita criada', 'Comissão devida', 'Pix do restaurante recebido', 'A repassar ao guia', 'Pago ao guia (Pix)'];
  screens[8] = function () {
    var c = commission(state.bill, state.rate), g = guidePart(c), k = c - g, i = state.cpf ? inss(g) : 0;
    var month = monthRows(), byGuide = {};
    month.forEach(function (x) { byGuide[x.guide] = (byGuide[x.guide] || 0) + guidePart(x.c); });
    return '<p class="dm-kicker">Etapa 6 · O controle da Kombrio ' + EX + '</p>'
      + '<h1>Cada transação, passo a passo</h1>'
      + '<div class="card"><div class="dm-muted">Família Martin · ' + REST + ' · comissão ' + brl(c) + '</div>'
      + '<ul class="dm-steps">' + STAGES.map(function (s, n) {
        var cls = n < state.stage ? 'done' : n === state.stage ? 'cur' : '';
        return '<li class="' + cls + '"><span class="dot">' + (n < state.stage ? '✓' : n + 1) + '</span>' + s + '</li>';
      }).join('') + '</ul>'
      + (state.stage < STAGES.length
        ? '<button type="button" class="btn small" id="dm-stage">Avançar uma etapa (simulação)</button>'
        : '<div class="notice ok" style="margin:0">Concluído: Ana recebeu ' + brl(g - i) + ' por Pix'
          + (i ? ' (' + brl(g) + ' bruto − INSS ' + brl(i) + ')' : ' (guia com CNPJ: sem retenção)') + '. Kombrio: ' + brl(k) + '.</div>')
      + '</div>'
      + '<div class="card"><h3>Este mês no ' + REST + '</h3>'
      + Object.keys(byGuide).map(function (n) { return '<div class="dm-row"><span>' + esc(n) + '</span><b>' + brl(byGuide[n]) + ' bruto</b></div>'; }).join('')
      + '<p class="dm-muted" style="margin:8px 0 0">Para cada guia, a Kombrio soma as comissões de todos os estabelecimentos e faz um único Pix.</p></div>';
  };

  // Agências e Tour Companies : chaque rôle a son taux, tout est payé en un seul Pix.
  screens[9] = function () {
    var bill = 100000, roles = [['Guia', 10, 'Ana Souza'], ['Tour Company', 5, 'Rio Tours'], ['Agência', 5, 'Viagens Sol']];
    var tot = 0;
    var rows = roles.map(function (r) { var c = commission(bill, r[1]); tot += c; return '<div class="dm-row"><span>' + r[0] + ' · ' + esc(r[2]) + ' (' + r[1] + ' %)</span><b>' + brl(c) + '</b></div>'; }).join('');
    return '<p class="dm-kicker">Guias, Tour Companies e agências ' + EX + '</p>'
      + '<h1>Um grupo, vários parceiros, um só Pix</h1>'
      + '<p>Uma agência traz um grupo com uma Tour Company e um guia. <b>Você define uma taxa para cada função</b>; a Kombrio reparte.</p>'
      + '<div class="card"><div class="dm-row"><span>Conta (loja de joias)</span><b>' + brl(bill) + '</b></div>' + rows
      + '<div class="dm-row total"><span>Você paga em um só Pix</span><b>' + brl(tot) + '</b></div></div>'
      + '<p class="dm-muted">Restaurante onde o guia nunca vem? Coloque 0 % para o guia: só a Tour Company ou a agência recebe.</p>';
  };

  screens[10] = function () {
    return '<p class="dm-kicker">Próximo passo</p>'
      + '<h1>Cadastre o seu estabelecimento</h1>'
      + '<ul class="dm-points">'
      + '<li><span class="dm-ico">✓</span><span><b>Cadastro gratuito</b>, em poucos minutos, pelo celular ou pelo computador.</span></li>'
      + '<li><span class="dm-ico">✓</span><span><b>Você escolhe a sua taxa</b> e pode mudar quando quiser.</span></li>'
      + '<li><span class="dm-ico">✓</span><span><b>Um único Pix</b> para todas as comissões, com comprovante e relatório para o contador.</span></li>'
      + '<li><span class="dm-ico">✓</span><span>Seu estabelecimento aparece na página dos turistas trazidos pelos guias.</span></li>'
      + '</ul>'
      + '<a class="btn dm-big" style="display:block;text-align:center;text-decoration:none" href="' + SIGNUP + '">Cadastrar meu estabelecimento</a>'
      + '<a class="btn secondary dm-big" style="display:block;text-align:center;text-decoration:none;margin-top:8px" href="' + FAQ + '">Perguntas frequentes</a>'
      + '<button type="button" class="btn ghost dm-big" id="dm-reset" style="margin-left:0">Recomeçar a demonstração</button>'
      + '<p class="dm-muted" style="margin-top:12px">Demonstração: nenhum dado foi guardado e nenhum pagamento foi feito.</p>';
  };

  // ---------- Affichage et navigation ----------
  var root = document.getElementById('dm');
  function render() {
    root.innerHTML = screens[state.step]();
    document.getElementById('dm-prev').style.visibility = state.step > 1 ? 'visible' : 'hidden';
    var next = document.getElementById('dm-next');
    next.style.visibility = state.step < TOTAL ? 'visible' : 'hidden';
    var dots = '';
    for (var n = 1; n <= TOTAL; n++) dots += '<i class="' + (n <= state.step ? 'on' : '') + '"></i>';
    document.getElementById('dm-step').innerHTML = state.step + ' / ' + TOTAL + '<span class="dm-dots">' + dots + '</span>';
    mount();
    window.scrollTo(0, 0);
  }
  function go(n) {
    n = Math.max(1, Math.min(TOTAL, n));
    if (n === 5 && !state.scanned) state.scanned = true;   // la visite existe avant la conta
    state.step = n;
    try { history.replaceState(null, '', '#' + n); } catch (e) { /* rien */ }
    render();
  }
  function mount() {
    Array.prototype.forEach.call(root.querySelectorAll('[data-go]'), function (b) { b.onclick = function () { go(Number(b.getAttribute('data-go'))); }; });
    var qr = document.getElementById('dm-qr');
    if (qr) {
      if (typeof window.qrcode === 'function') {
        var q = window.qrcode(0, 'M'); q.addData('KOMBRIO DEMO - exemplo, sem valor'); q.make();
        qr.innerHTML = q.createSvgTag({ cellSize: 5, margin: 2, scalable: true });
      } else qr.innerHTML = '<div class="dm-muted">[ QR ]</div>';
    }
    var scan = document.getElementById('dm-scan');
    if (scan) scan.onclick = function () { state.scanned = true; render(); };
    var bill = document.getElementById('dm-bill'), rate = document.getElementById('dm-rate');
    if (bill && rate) {
      var upd = function () {
        state.bill = Number(bill.value); state.rate = Number(rate.value);
        document.getElementById('dm-bill-v').textContent = brl(state.bill);
        document.getElementById('dm-rate-v').textContent = state.rate + ' %';
        var c = commission(state.bill, state.rate), g = guidePart(c);
        document.getElementById('dm-calc').innerHTML = calcBox(c, g, c - g, c ? Math.round(g / c * 100) : 80);
      };
      bill.oninput = upd; rate.oninput = upd;
    }
    var pay = document.getElementById('dm-pay');
    if (pay) pay.onclick = function () { state.paid = true; render(); };
    Array.prototype.forEach.call(root.querySelectorAll('[data-cpf]'), function (b) { b.onclick = function () { state.cpf = b.getAttribute('data-cpf') === '1'; render(); }; });
    var stage = document.getElementById('dm-stage');
    if (stage) stage.onclick = function () { state.stage = Math.min(STAGES.length, state.stage + 1); render(); };
    var rs = document.getElementById('dm-reset');
    if (rs) rs.onclick = function () { reset(); go(1); };
  }
  document.getElementById('dm-prev').onclick = function () { go(state.step - 1); };
  document.getElementById('dm-next').onclick = function () { go(state.step + 1); };
  document.addEventListener('keydown', function (e) {
    if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
    if (e.key === 'ArrowRight') go(state.step + 1);
    if (e.key === 'ArrowLeft') go(state.step - 1);
  });
  var start = Number((location.hash || '').replace('#', ''));
  if (start >= 1 && start <= TOTAL) state.step = start;
  if (state.step >= 5) state.scanned = true;
  render();
})();
