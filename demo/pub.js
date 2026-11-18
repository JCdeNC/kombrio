// KOMBRIO DEMO « PUB » (v104, 18/11/2026) : 6 écrans de 5 secondes, comme une story. Toucher à droite/gauche pour avancer
// ou revenir ; le dernier écran reste affiché avec les boutons (démonstration complète, inscription, FAQ).
// Écrit sans syntaxe récente (?. ??) pour les vieux téléphones (exigence : iOS 13.4 / Chrome 80).
(function () {
  'use strict';
  var DURATION = 5000;
  var SLIDES = [
    { ico: '🍽️', title: 'Seus clientes chegam com um guia?', text: 'A Kombrio registra, calcula e paga as comissões por você.' },
    { ico: '📱', title: 'Escaneie o QR do cliente', text: 'Um segundo, com a câmera do celular. Nada para instalar.', mock: 'scan' },
    { ico: '🧾', title: 'Digite o valor da conta', text: 'A comissão é calculada sozinha, com a taxa que você escolhe.', mock: 'bill', ms: 8000 },
    { ico: '💸', title: 'Um só Pix por mês', text: 'A Kombrio repassa a cada guia, Tour Company ou agência.', mock: 'pix' },
    { ico: '✅', title: 'Zero planilha. Zero cobrança.', text: 'Tudo registrado, com comprovante e relatório para o seu contador.' },
    { end: true, title: 'Cadastro gratuito.', text: 'Você só paga as comissões que definir.' }
  ];
  var MOCKS = {
    scan: '<div class="pub-phone"><div class="pub-ok">✓ Visita registrada</div><div class="pub-line"><span>Guia</span><b>Ana Souza</b></div><div class="pub-line"><span>Pessoas</span><b>4</b></div></div>',
    bill: '<div class="pub-phone"><div class="pub-line"><span>Conta</span><b>R$ 500,00</b></div><div class="pub-line big"><span>Comissão 10 %</span><b>R$ 50,00</b></div></div>'
      + '<p class="pub-note">10 % é só um exemplo. Você define tudo: a taxa, um valor fixo por pessoa, bônus, taxas diferentes para guias, Tour Companies e agências. E muda quando quiser.</p>',
    pix: '<div class="pub-phone"><div class="pub-line"><span>Ana · Bruno · Carla</span><b>12 visitas</b></div><div class="pub-line big"><span>Um Pix</span><b>R$ 640,00</b></div></div>'
  };
  var i = 0, timer = null, started = 0, left = DURATION, paused = false;
  var stage = document.getElementById('pub-stage'), bars = document.getElementById('pub-bars');
  bars.innerHTML = SLIDES.map(function () { return '<span><i></i></span>'; }).join('');

  function slideHtml(s) {
    if (s.end) {
      return '<div class="pub-slide pub-end"><img src="../icon.svg" alt="" class="pub-logo"><h1>' + s.title + '</h1><p>' + s.text + '</p>'
        + '<a class="btn pub-btn" href="completa.html">Ver a demonstração completa (3 min)</a>'
        + '<a class="btn secondary pub-btn" href="../partner/#/parceria">Cadastrar meu estabelecimento</a>'
        + '<a class="pub-link" href="../faq/?s=partner">Perguntas frequentes</a>'
        + '<button type="button" class="pub-link" id="pub-again">↺ Rever</button></div>';
    }
    return '<div class="pub-slide"><div class="pub-ico">' + s.ico + '</div><h1>' + s.title + '</h1><p>' + s.text + '</p>' + (s.mock ? MOCKS[s.mock] : '') + '</div>';
  }
  function setBars() {
    Array.prototype.forEach.call(bars.children, function (b, n) {
      var bar = b.firstChild;
      bar.style.transition = 'none';
      bar.style.width = n < i ? '100%' : '0%';
    });
  }
  function runBar(ms) {
    var bar = bars.children[i].firstChild;
    // Relance l'animation de la barre en cours sur le temps restant.
    void bar.offsetWidth;
    bar.style.transition = 'width ' + ms + 'ms linear';
    bar.style.width = '100%';
  }
  function freezeBar() {
    var bar = bars.children[i].firstChild;
    var w = getComputedStyle(bar).width;
    bar.style.transition = 'none'; bar.style.width = w;
  }
  function show(n) {
    clearTimeout(timer);
    i = Math.max(0, Math.min(SLIDES.length - 1, n));
    stage.innerHTML = slideHtml(SLIDES[i]);
    setBars();
    var again = document.getElementById('pub-again');
    if (again) again.onclick = function (e) { e.stopPropagation(); paused = false; show(0); };
    document.getElementById('pub').classList.toggle('is-end', !!SLIDES[i].end);
    if (SLIDES[i].end) { bars.children[i].firstChild.style.width = '100%'; return; }
    left = SLIDES[i].ms || DURATION;
    if (!paused) play();
  }
  function play() {
    started = Date.now();
    runBar(left);
    timer = setTimeout(function () { show(i + 1); }, left);
  }
  function pause() {
    if (paused || SLIDES[i].end) return;
    paused = true; clearTimeout(timer);
    left = Math.max(300, left - (Date.now() - started));
    freezeBar();
    document.getElementById('pub-pause').textContent = '▶';
  }
  function resume() {
    if (!paused) return;
    paused = false; document.getElementById('pub-pause').textContent = '❚❚';
    if (!SLIDES[i].end) play();
  }
  document.getElementById('pub-next').onclick = function () { paused = false; document.getElementById('pub-pause').textContent = '❚❚'; show(i + 1); };
  document.getElementById('pub-prev').onclick = function () { paused = false; document.getElementById('pub-pause').textContent = '❚❚'; show(i - 1); };
  document.getElementById('pub-pause').onclick = function () { if (paused) resume(); else pause(); };
  // Onglet caché : pause ; retour sur l'onglet : reprise (sauf si la personne avait mis pause elle-même).
  var autoPaused = false;
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { if (!paused) { autoPaused = true; pause(); } }
    else if (autoPaused) { autoPaused = false; resume(); }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowRight') show(i + 1);
    if (e.key === 'ArrowLeft') show(i - 1);
    if (e.key === ' ') { e.preventDefault(); if (paused) resume(); else pause(); }
  });
  show(0);
})();
