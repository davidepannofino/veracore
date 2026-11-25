// Design versione 32 (sessione 06, 23/11/2026): la home, il Neural Core e la risposta del prototipo, dietro proposte.design_nuovo
// (web/sito/sito.yaml). Si portano l'aspetto e il movimento; le parole vengono dalla pagina (data-parole, da web/sito/testi.yaml),
// i numeri dalla pagina (costruita da strumenti/sito_design32.py con i file del progetto), le risposte dal catalogo verificato
// (vera/catalogo.json) o, dal vivo, dal widget dell'assistente con i suoi eventi veri (docs/VERA_EVENTI.md).
// Domanda a voce (decisione del gruppo del 25/11/2026): il riconoscimento vocale del browser, un ascolto per tocco sul tasto;
// nessuna apertura diretta del microfono, nessuna registrazione, niente sintesi nel browser; nessuna richiesta fuori dal sito.
(() => {
  "use strict";
  const pagina = document.querySelector('.pagina[data-design="32"]');
  if (!pagina) return;
  let PAROLE = {};
  try { PAROLE = JSON.parse(pagina.getAttribute("data-parole") || "{}"); } catch (e) { PAROLE = {}; }
  const NOME = String(PAROLE.nome || "");
  const PR = PAROLE.risposta || {};
  const PC = PAROLE.core || {};
  const PV = PAROLE.video || {};
  const CAMPIONI = (PAROLE.metodo || {}).campioni || [];   // N2.1 (notte 25/11): «Campione 1» e «Campione 2» sulla figura del metodo
  const STATI = PC.stati || {};
  const VIA = PC.via || {};
  const SAT_ETI = PC.satelliti || {};
  const ANELLO = (k) => String((PC.anello || {})[k] || "") + " · ";
  let AUDIO = {};
  // N1.7 (notte 25/11): un istante di silenzio (WAV di 0,05 s fatto qui), per sbloccare l'elemento audio dentro un gesto (iOS)
  const SILENZIO = (() => { const n = 800, b = new Uint8Array(44 + n * 2), v = new DataView(b.buffer), w = (o, t) => { for (let i = 0; i < t.length; i++) b[o + i] = t.charCodeAt(i); };
      w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
      v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
      let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return 'data:audio/wav;base64,' + btoa(s); })();
  const ANELLO_P = (i) => String((PAROLE.anelli || [])[i] || "") + " · ";
  // i tempi (ms) della risposta e del passaggio dalla sfera alla risposta, tutti qui
  const TEMPI_RC = {
    tuffoIngresso: 4000,
    tuffoUscita: 1400,
    tuffoDissolvenza: 300,
    tuffoPrima: 250,
      parola: 80,
      primaFrase: 1.3,
      pausaFrase: 500,
      coda: 500,
      domanda: 600,
      respiro: 700,
      respiroVoce: 300,      // M4 (mattino 25/11): con la voce accesa la risposta parte prima (sempre dopo la domanda comparsa)
      scorri: 700,
      tracciato: 1250,
      copiata: 1600
  };
  class DCLogic { constructor() { this.props = {}; } }
  class Component extends DCLogic {
      renderVals() {
          return { prendiRadice: (el) => { this.radice = el; } };
      }
      applicaScelte() {
          const r = this.radice;
          if (!r)
              return;
          const p = this.props || {};
          r.classList.toggle('senza-alone', p.bagliore === false);
          this._squadrato = false;
          this._mono = ((r.ownerDocument.defaultView || window).getComputedStyle(r).getPropertyValue('--font-main') || '').trim() || 'monospace';
          if (this._aggiornaColori)
              this._aggiornaColori();
      }
      componentDidUpdate() { this.applicaScelte(); }
      componentWillUnmount() {
          this._fermo = true;
          const win = (this.radice && this.radice.ownerDocument.defaultView) || window;
          (this._timer || []).forEach((t) => win.clearTimeout(t));
          (this._intervalli || []).forEach((t) => win.clearInterval(t));
          if (this._io)
              this._io.disconnect();
          if (this._lenis) {
              try {
                  this._lenis.destroy();
              }
              catch (e) { }
          }
          if (this._clic && this.radice)
              this.radice.removeEventListener('click', this._clic);
          if (this._invio && this.radice)
              this.radice.removeEventListener('submit', this._invio);
          if (this._ridim)
              win.removeEventListener('resize', this._ridim);
          (this._ascolti || []).forEach((a) => { try {
              a[0].removeEventListener(a[1], a[2]);
          }
          catch (e) { } });
          if (this._video) {
              try {
                  this._video.pause();
              }
              catch (e) { }
          }
          if (this._voce) {
              try {
                  this._voce.pause();
              }
              catch (e) { }
          }
          if (this._fermaVoce) {
              try {
                  this._fermaVoce();
              }
              catch (e) { }
          }
          if (this._flusso) {
              try {
                  this._flusso.getTracks().forEach((t) => t.stop());
              }
              catch (e) { }
          }
          if (this._suono) {
              try {
                  this._suono.smonta();
              }
              catch (e) { }
          }
          if (this._actx) {
              try {
                  this._actx.close();
              }
              catch (e) { }
          }
      }
      componentDidMount() {
          const root = this.radice;
          if (!root)
              return;
          this.applicaScelte();
          this._timer = [];
          this._intervalli = [];
          this._ascolti = [];
          this._fermo = false;
          const doc = root.ownerDocument;
          const win = doc.defaultView || window;
          const dopo = (fn, ms) => { const t = win.setTimeout(fn, ms); this._timer.push(t); return t; };
          const ogni = (fn, ms) => { const t = win.setInterval(fn, ms); this._intervalli.push(t); return t; };
          const ascolta = (el, ev, fn, opz) => { if (!el)
              return; el.addEventListener(ev, fn, opz); this._ascolti.push([el, ev, fn]); };
          const lim = (v, a, b) => Math.min(b === undefined ? 1 : b, Math.max(a === undefined ? 0 : a, v));
          const facile = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
          const esce = (t) => 1 - Math.pow(1 - t, 3);
          const liscio = (t) => t * t * (3 - 2 * t);
          const fm = () => this._mono || 'monospace';
          let scorre = null;
          let n = root.parentElement;
          while (n && n !== doc.body && n !== doc.documentElement) {
              const s = win.getComputedStyle(n);
              if (/(auto|scroll)/.test(s.overflowY) && n.scrollHeight > n.clientHeight + 4) {
                  scorre = n;
                  break;
              }
              n = n.parentElement;
          }
          // B2 (24/11): l'altezza usata per --vh e per le misure e' STABILE: cambia solo con la larghezza o l'orientamento (o a richiesta),
          // non quando su iPhone e iPad la barra del browser compare o sparisce durante lo scorrimento
          const altezzaVera = () => (scorre ? scorre.clientHeight : win.innerHeight);
          const larghezza = () => (scorre ? scorre.clientWidth : win.innerWidth);
          const orientamento = () => (larghezza() > altezzaVera() ? 'o' : 'v');
          let hStabile = altezzaVera(), wStabile = larghezza(), oStabile = orientamento();
          const altezza = () => hStabile;
          // fino al caricamento completo (e alla posizione ripristinata da una ricarica) lo stato delle sezioni segue subito la posizione vera
          let saltaMorbido = true;
          const finePartenza = () => win.requestAnimationFrame(() => win.requestAnimationFrame(() => { saltaMorbido = false; }));
          if (doc.readyState === 'complete')
              finePartenza();
          else
              win.addEventListener('load', finePartenza, { once: true });
          const posizione = () => (scorre ? scorre.scrollTop : (win.scrollY || win.pageYOffset || 0));
          const ridotto = !!(win.matchMedia && win.matchMedia('(prefers-reduced-motion: reduce)').matches);
          const alTocco = () => !!(win.matchMedia && win.matchMedia('(hover: none), (pointer: coarse)').matches);    // N2 (25/11)
          // N1.9 (notte 25/11): la pagina diventa statica solo oltre 2400 px di altezza (prima 1600, dal prototipo: proteggeva le
          // fotografie della pagina intera, dove la finestra e' alta quanto la pagina). Gli schermi 4K (2160) hanno il movimento
          const SOGLIA_STATICA = 2400;
          let statico = altezza() > SOGLIA_STATICA;
          let fermo = ridotto || statico || this.props.movimento === false;
          const stretto = () => larghezza() < 900;
          root.style.setProperty('--vh', (statico ? 900 : Math.round(lim(altezza(), 560, SOGLIA_STATICA))) + 'px');
          root.classList.add(fermo ? 'modo-fermo' : 'modo-movimento');
          if (statico)
              root.classList.add('modo-statico');
          if (this.props.parte === 'seguito')
              root.classList.add('solo-seguito');
          const segnaBasso = () => root.classList.toggle('schermo-basso', !statico && altezza() < 760);
          segnaBasso();
          // la barra fissa in basso (le scritte obbligatorie): i comandi del Neural Core le stanno sopra, mai sotto (24/11)
          const barraFissa = doc.getElementById('barra-fissa');
          const misuraBarra = () => root.style.setProperty('--barra', (barraFissa ? Math.ceil(barraFissa.getBoundingClientRect().height) : 0) + 'px');
          misuraBarra();
          if (barraFissa && win.ResizeObserver)
              new win.ResizeObserver(misuraBarra).observe(barraFissa);
          const COL = { brina: [236, 237, 232], inchiostro: [20, 21, 23], segnale: [255, 122, 26], carta: [242, 241, 236], stanza: [14, 16, 18], nebbia: [142, 146, 151] };
          const daHex = (h, d) => { const m = /^#?([0-9a-f]{6})$/i.exec(String(h || '').trim()); if (!m)
              return d; const v = parseInt(m[1], 16); return [(v >> 16) & 255, (v >> 8) & 255, v & 255]; };
          const rgba = (c, a) => 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + (a < 0 ? 0 : a > 1 ? 1 : a).toFixed(3) + ')';
          const mescolaCol = (a, b, t) => [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)];
          const fontStretta = (ctx) => { if ('fontStretch' in ctx) {
              try {
                  ctx.fontStretch = this._squadrato ? 'semi-condensed' : 'normal';
              }
              catch (e) { }
          } };
          if (!fermo && !stretto() && win.Lenis) {
              try {
                  const opz = { lerp: 0.085, smoothWheel: true, wheelMultiplier: 0.95 };
                  if (scorre) {
                      opz.wrapper = scorre;
                      opz.content = scorre.firstElementChild || root;
                  }
                  this._lenis = new win.Lenis(opz);
              }
              catch (e) {
                  this._lenis = null;
              }
          }
          const segni = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
          // 24/11, parte 1, punto 8: mentre una scritta si anima, il testo intero resta nel DOM per chi usa un lettore di schermo
          // (un livello nascosto agli occhi) e le lettere che cambiano sono nascoste ai lettori; a fine animazione torna testo semplice
          const dueLivelli = (el, fine) => {
              el.textContent = '';
              const sr = doc.createElement('span');
              sr.className = 'solo-lettori';
              sr.textContent = fine;
              const vis = doc.createElement('span');
              vis.setAttribute('aria-hidden', 'true');
              el.append(sr, vis);
              return vis;
          };
          const mescola = (el, ms) => {
              const fine = el.getAttribute('data-testo') || el.textContent;
              el.setAttribute('data-testo', fine);
              if (el.__mx) {
                  win.clearInterval(el.__mx);
                  el.__mx = 0;
              }
              if (fermo) {
                  el.textContent = fine;
                  return;
              }
              const vis = dueLivelli(el, fine);
              let f = 0;
              const passi = 12;
              const fotogramma = () => fine.split('').map((c, i) => (/[\s\/·.,:&—§_-]/.test(c) || i < (f / passi) * fine.length ? c : segni[Math.floor(Math.random() * segni.length)])).join('');
              vis.textContent = fotogramma();      // B11 (24/11): subito, alla stessa lunghezza: la riga non si svuota e il testo non salta
              const id = ogni(() => {
                  f++;
                  vis.textContent = fotogramma();
                  if (f >= passi) {
                      win.clearInterval(id);
                      el.__mx = 0;
                      el.textContent = fine;
                  }
              }, ms || 38);
              el.__mx = id;
          };
          // battitura: il testo cresce un carattere ogni ms (spazio riservato: chi la chiama lo tiene in un posto fisso), niente
          // cursore, testo intero nel DOM per i lettori di schermo, subito intero con il movimento ridotto
          const batti = (el, testo, ms, finito) => {
              if (!el)
                  return 0;
              if (el.__bt) {
                  win.clearInterval(el.__bt);
                  el.__bt = 0;
              }
              if (fermo || !testo) {
                  el.textContent = testo || '';
                  if (finito)
                      finito();
                  return 0;
              }
              const vis = dueLivelli(el, testo);
              let k = 0;
              const id = ogni(() => {
                  k++;
                  vis.textContent = testo.slice(0, k);
                  if (k >= testo.length) {
                      win.clearInterval(id);
                      el.__bt = 0;
                      el.textContent = testo;
                      if (finito)
                          finito();
                  }
              }, ms);
              el.__bt = id;
              return id;
          };
          const caso = (() => { let s = 20261119; return () => { s |= 0; s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; })();
          const N = 211;
          const SEGNI = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
          const unisci = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
          const CENTRI = [[-0.62, 0.2, 0.76], [0.62, -0.16, 0.77], [0.08, 0.9, -0.42], [-0.74, -0.58, -0.34], [0.8, 0.46, -0.38], [0.02, -0.82, -0.57]].map(unisci);
          const P = [];
          const oro = Math.PI * (3 - Math.sqrt(5));
          for (let i = 0; i < N; i++) {
              const y = 1 - ((i + 0.5) / N) * 2;
              const rr = Math.sqrt(1 - y * y);
              const th = oro * i;
              const p = unisci([Math.cos(th) * rr + (caso() - 0.5) * 0.07, y + (caso() - 0.5) * 0.07, Math.sin(th) * rr + (caso() - 0.5) * 0.07]);
              let c = 0;
              let mx = -9;
              CENTRI.forEach((C, k) => { const d = p[0] * C[0] + p[1] * C[1] + p[2] * C[2]; if (d > mx) {
                  mx = d;
                  c = k;
              } });
              const C = CENTRI[c];
              const m = unisci([p[0] + (C[0] - p[0]) * 0.52, p[1] + (C[1] - p[1]) * 0.52, p[2] + (C[2] - p[2]) * 0.52]);
              const a = caso() * Math.PI * 2;
              const rs = 2.2 + caso() * 3.4;
              P.push({ p, m, c, s: [Math.cos(a) * rs, Math.sin(a) * rs * 0.62, (caso() - 0.5) * 2.4], g: Math.floor(caso() * SEGNI.length), t: caso() < 0.34 ? 1 : 0, f: caso() });
          }
          let F1 = 0;
          let F1b = 0;
          {
              let a = -9;
              let b = -9;
              P.forEach((q, i) => {
                  const da = q.p[0] * CENTRI[0][0] + q.p[1] * CENTRI[0][1] + q.p[2] * CENTRI[0][2];
                  const db = q.p[0] * CENTRI[1][0] + q.p[1] * CENTRI[1][1] + q.p[2] * CENTRI[1][2];
                  if (q.c === 0 && da > a && da < 0.985) {
                      a = da;
                      F1 = i;
                  }
                  if (q.c === 1 && db > b && db < 0.985) {
                      b = db;
                      F1b = i;
                  }
              });
          }
          const VICINI = [];
          P.forEach((q, i) => {
              const d = P.map((r, j) => [j === i ? 9 : Math.hypot(q.p[0] - r.p[0], q.p[1] - r.p[1], q.p[2] - r.p[2]), j]).sort((x, y) => x[0] - y[0]);
              for (let k = 0; k < 2; k++) {
                  const j = d[k][1];
                  if (!VICINI.some((v) => v[0] === j && v[1] === i))
                      VICINI.push([i, j]);
              }
          });
          const GEO = (() => {
              const t0 = (1 + Math.sqrt(5)) / 2;
              const V = [[-1, t0, 0], [1, t0, 0], [-1, -t0, 0], [1, -t0, 0], [0, -1, t0], [0, 1, t0], [0, -1, -t0], [0, 1, -t0], [t0, 0, -1], [t0, 0, 1], [-t0, 0, -1], [-t0, 0, 1]].map(unisci);
              let F = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
              for (let s = 0; s < 2; s++) {
                  const cache = new Map();
                  const NF = [];
                  const mezzo = (a, b) => { const k = a < b ? a + '_' + b : b + '_' + a; if (cache.has(k))
                      return cache.get(k); V.push(unisci([(V[a][0] + V[b][0]) / 2, (V[a][1] + V[b][1]) / 2, (V[a][2] + V[b][2]) / 2])); cache.set(k, V.length - 1); return V.length - 1; };
                  F.forEach((f) => { const ab = mezzo(f[0], f[1]); const bc = mezzo(f[1], f[2]); const ca = mezzo(f[2], f[0]); NF.push([f[0], ab, ca], [f[1], bc, ab], [f[2], ca, bc], [ab, bc, ca]); });
                  F = NF;
              }
              const E = new Set();
              const S = [];
              F.forEach((f) => [[f[0], f[1]], [f[1], f[2]], [f[2], f[0]]].forEach((e) => { const a = Math.min(e[0], e[1]); const b = Math.max(e[0], e[1]); const k = a + '_' + b; if (!E.has(k)) {
                  E.add(k);
                  S.push([a, b]);
              } }));
              const ph = V.map(() => caso());
              return { V, S, ph };
          })();
          const SATELLITI = [{ n: 'METODO', a: -2.53 }, { n: 'DATI', a: -0.61 }, { n: 'EVIDENZE', a: 2.53 }, { n: 'VERIFICATORE', a: 0.61 }];
          const preparaAnello = (a) => {
              // 24/11, parte 1, punto 7: il giro si chiude a fine testo, cosi' nessuna parola resta tagliata dove il cerchio si chiude
              const n0 = Math.max(14, Math.floor((2 * Math.PI * a.k * 210) / (a.px * 0.84)));
              const L = (a.testo || '').length;
              const nn = L ? Math.max(L, Math.round(n0 / L) * L) : n0;
              const h = [];
              for (let i = 0; i < nn; i++)
                  h.push(caso());
              return Object.assign({}, a, { n: nn, h, g0: caso(), gw: 0.05 + caso() * 0.08, g1: caso(), gw1: caso() < 0.6 ? 0.03 + caso() * 0.05 : 0 });
          };
          const ANELLI_GRANDI = [
              { k: 1.3, testo: ANELLO_P(0), px: 10, v: 0.05, a: 0.92 },
              { k: 1.62, testo: ANELLO_P(1), px: 12, v: -0.034, a: 0.82 },
              { k: 2.02, testo: ANELLO_P(2), px: 15.5, v: 0.024, a: 0.74 },
              { k: 2.56, testo: ANELLO_P(3), px: 20.5, v: -0.017, a: 0.64 },
              { k: 3.28, testo: ANELLO_P(4), px: 27, v: 0.012, a: 0.54 }
          ];
          const ANELLI_PICCOLI = [
              { k: 1.36, testo: ANELLO_P(5), px: 10, v: 0.04, a: 0.35 }
          ];
          const GUIDE = [1.16, 1.46, 1.82, 2.28, 2.9, 3.7];
          // S4 (25/11): sugli apparecchi a tocco ogni tela al massimo 2,0 milioni di pixel al telefono e 3,0 a iPad (larghezza x altezza x
          // densita'^2); con il modo leggero deciso durante la visita (fotogrammi lenti nei primi 3 s) densita' 1
          let leggeroVisita = false;
          const misuraLeggero = { fine: 0, s: 0, n: 0 };
          const tettoDpr = (w, h) => {
              if (leggeroVisita)
                  return 1;
              if (!(win.matchMedia && win.matchMedia('(hover: none), (pointer: coarse)').matches))
                  return 99;
              const tetto = Math.min(win.innerWidth, win.innerHeight) < 600 ? 2.0e6 : 3.0e6;
              return Math.max(1, Math.sqrt(tetto / Math.max(1, w * h)));
          };
          const creaCore = (tela, cfg) => {
              const ctx = tela && tela.getContext ? tela.getContext('2d') : null;
              const cur = P.map((q) => ({ x: q.p[0], y: q.p[1], z: q.p[2], al: 1, ar: 0, ci: 0 }));
              const anelli = (cfg.anelli || []).map(preparaAnello);
              const lab = { camp: 0, f1: 0, sec: 0, reg: 0, cie: 0 };
              const onde = [];
              const sat = SATELLITI.map(() => 0);
              let ampPrima = 0;
              let assV = 0;
              let ultimaOnda = 0, ultimoImp = 0, ultimoImpP = 0;
              let filoS = null, filoK = null, filoT0 = -1e9;
              let ang = cfg.ang0 || 0.7;
              let incl = 0.36;
              let ultimo = 0;
              let dpr = 1;
              let W = 0;
              let H = 0;
              const dimensiona = () => {
                  if (!ctx)
                      return;
                  const w = tela.clientWidth;
                  const h = tela.clientHeight;
                  if (!w || !h)
                      return;
                  dpr = Math.min(win.devicePixelRatio || 1, cfg.dprMax || 2, tettoDpr(w, h));
                  W = tela.width = Math.round(w * dpr);
                  H = tela.height = Math.round(h * dpr);
                  escluseT = -1e9;
              };
              // le etichette della sezione (FIG, NEURAL CORE...): le parole degli anelli non ci passano mai sopra (24/11, punto 7)
              let escluse = [];
              let escluseT = -1e9;
              const aggiornaEscluse = (t) => {
                  if (t - escluseT < 500)
                      return;
                  escluseT = t;
                  leggiRitaglio();
                  const sez = tela.closest ? tela.closest('section') : null;
                  if (!sez || !anelli.length) {
                      escluse = [];
                      return;
                  }
                  const rt = tela.getBoundingClientRect();
                  const fuori = Array.from(doc.querySelectorAll('nav, #barra-fissa')).concat(Array.from(sez.querySelectorAll('.angolo, .angolo-fig, .occhiello')));
                  escluse = fuori.map((el) => el.getBoundingClientRect())
                      .filter((r) => r.width && r.height).map((r) => [(r.left - rt.left) * dpr, (r.top - rt.top) * dpr, (r.right - rt.left) * dpr, (r.bottom - rt.top) * dpr]);
              };
              // la parte visibile della tela: il ritaglio (clip-path: inset) del pannello scuro che la contiene
              let visibile = null;
              const leggiRitaglio = () => {
                  const sc = tela.parentElement;
                  const cp = sc ? (win.getComputedStyle(sc).clipPath || '') : '';
                  const m = /inset\(([^)]*)\)/.exec(cp);
                  if (!m) {
                      visibile = null;
                      return;
                  }
                  const v = m[1].trim().split(/\s+/);
                  const q = [v[0], v[1] || v[0], v[2] || v[0], v[3] || v[1] || v[0]];
                  const px = (x, tot) => (/%$/.test(x) ? parseFloat(x) / 100 * tot : parseFloat(x) * dpr) || 0;
                  visibile = [px(q[3], W), px(q[0], H), W - px(q[1], W), H - px(q[2], H)];
              };
              const sopraEtichetta = (x, y, m) => escluse.some((r) => x > r[0] - m && x < r[2] + m && y > r[1] - m && y < r[3] + m)
                  || !!(visibile && (x < visibile[0] + m || x > visibile[2] - m || y < visibile[1] + m || y > visibile[3] - m));
              const etichetta = (testo, x, y, col, a, allinea) => {
                  if (a < 0.02)
                      return;
                  ctx.font = '500 ' + Math.round(11 * dpr) + 'px ' + fm();
                  fontStretta(ctx);
                  const lw = ctx.measureText(testo).width;
                  const m0 = 10 * dpr;
                  if ((allinea || 'left') === 'left')
                      x = Math.max(m0, Math.min(x, W - lw - m0));
                  else if (allinea === 'right')
                      x = Math.min(W - m0, Math.max(x, lw + m0));
                  else
                      x = Math.max(lw / 2 + m0, Math.min(x, W - lw / 2 - m0));
                  ctx.textAlign = allinea || 'left';
                  ctx.textBaseline = 'middle';
                  ctx.fillStyle = rgba(col, a);
                  ctx.fillText(testo, x, y);
              };
              const coda = [];
              // U6 (ultimo giro 25/11): «Campione 1» e «Campione 2» si scrivono lettera per lettera quando compaiono (45 ms a lettera)
              let campDa = 0;
              const scriviCamp = (testo, a) => {
                  if (a > 0.05) {
                      if (!campDa)
                          campDa = win.performance.now();
                  }
                  else if (a < 0.02)
                      campDa = 0;
                  if (ridotto || !campDa)
                      return testo;
                  return testo.slice(0, Math.max(0, Math.floor((win.performance.now() - campDa) / 45)));
              };
              const pillola = (testo, x, y, col, a, allinea, accesa) => { if (a >= 0.02 && testo)
                  coda.push([testo, x, y, col, a, allinea || 'left', !!accesa]); };
              const tondo = (x, y, w, h, r) => {
                  ctx.beginPath();
                  if (ctx.roundRect) {
                      ctx.roundRect(x, y, w, h, r);
                      return;
                  }
                  ctx.moveTo(x + r, y);
                  ctx.arcTo(x + w, y, x + w, y + h, r);
                  ctx.arcTo(x + w, y + h, x, y + h, r);
                  ctx.arcTo(x, y + h, x, y, r);
                  ctx.arcTo(x, y, x + w, y, r);
                  ctx.closePath();
              };
              const svuotaCoda = () => {
                  if (!coda.length)
                      return;
                  const fs = (W / dpr < 600 ? 12 : 14) * dpr;
                  const spazia = 'letterSpacing' in ctx;
                  for (const v of coda) {
                      const testo = v[0], x0 = v[1], y = v[2], col = v[3], a = v[4], al = v[5], accesa = v[6];
                      ctx.font = '500 ' + Math.round(fs) + 'px ' + fm();
                      fontStretta(ctx);
                      if (spazia)
                          ctx.letterSpacing = (0.03 * fs).toFixed(1) + 'px';
                      const lw = ctx.measureText(testo).width;
                      const px = 8 * dpr;
                      const bh = fs + 10 * dpr;
                      const m0 = 10 * dpr;
                      let x = al === 'right' ? x0 - lw : al === 'center' ? x0 - lw / 2 : x0;
                      x = Math.max(m0 + px, Math.min(x, W - lw - px - m0));
                      ctx.globalAlpha = Math.min(1, a);
                      ctx.fillStyle = 'rgba(11,13,16,0.88)';
                      tondo(x - px, y - bh / 2, lw + px * 2, bh, 3 * dpr);
                      ctx.fill();
                      ctx.lineWidth = 1 * dpr;
                      ctx.strokeStyle = accesa ? rgba(col, 0.95) : 'rgba(236,237,232,0.5)';
                      tondo(x - px + 0.5 * dpr, y - bh / 2 + 0.5 * dpr, lw + px * 2 - dpr, bh - dpr, 3 * dpr);
                      ctx.stroke();
                      ctx.shadowColor = 'rgba(0,0,0,0.9)';
                      ctx.shadowBlur = 6 * dpr;
                      ctx.fillStyle = rgba(col, 1);
                      ctx.textAlign = 'left';
                      ctx.textBaseline = 'middle';
                      ctx.fillText(testo, x, y + 0.5 * dpr);
                      ctx.shadowBlur = 0;
                      ctx.shadowColor = 'rgba(0,0,0,0)';
                      if (spazia)
                          ctx.letterSpacing = '0px';
                      ctx.globalAlpha = 1;
                  }
                  coda.length = 0;
              };
              // S5 (25/11): ogni anello si disegna UNA volta su una tela fuori schermo (si rifa' solo se cambiano testo, raggio oltre il 2%,
              // grandezza delle lettere o colore) e a ogni fotogramma si ruota l'immagine con drawImage: a regime 0 fillText. Le parole vicino
              // alle etichette sfumano (maschera morbida) invece di sparire di colpo; con S2 nessuna parola si toglie per il bordo
              const spriteAn = [];
              const glifi = new Map();
              const glifo = (ch, f, px, col) => {
                  const k = ch + '|' + f + '|' + col[0] + ',' + col[1] + ',' + col[2];
                  let g = glifi.get(k);
                  if (g)
                      return g;
                  if (glifi.size > 4000)
                      glifi.clear();
                  const S = Math.ceil(px * 1.8) + 2, c = doc.createElement('canvas');
                  c.width = S;
                  c.height = S;
                  const x = c.getContext('2d');
                  x.font = f;
                  fontStretta(x);
                  x.textAlign = 'center';
                  x.textBaseline = 'middle';
                  x.fillStyle = rgba(col, 1);
                  x.fillText(ch, S / 2, S / 2);
                  g = { c, m: S / 2 };
                  glifi.set(k, g);
                  return g;
              };
              win.__spriteRifatti = win.__spriteRifatti || 0;
              const spriteAnello = (j, an, testo, rad, fs, col) => {
                  const key = testo + '|' + fs.toFixed(1) + '|' + col.join(',') + '|' + dpr;
                  const c0 = spriteAn[j];
                  if (c0 && c0.key === key && Math.abs(c0.rad - rad) / Math.max(1, rad) < 0.02)
                      return c0;
                  const S = Math.ceil(2 * (rad + fs * 1.3)) + 4;
                  const cv = c0 ? c0.cv : doc.createElement('canvas');
                  cv.width = S;
                  cv.height = S;
                  const g = cv.getContext('2d');
                  g.clearRect(0, 0, S, S);
                  g.font = '500 ' + fs.toFixed(1) + 'px ' + fm();
                  fontStretta(g);
                  g.textAlign = 'center';
                  g.textBaseline = 'middle';
                  g.fillStyle = rgba(col, 1);
                  const nT = testo.length, nUsa = nT ? (Math.floor(an.n / nT) * nT || an.n) : an.n, m = S / 2;
                  let i = 0;
                  while (i < nUsa) {
                      if (testo[i % nT] === ' ') {
                          i++;
                          continue;
                      }
                      let fine = i;
                      while (fine < nUsa && testo[fine % nT] !== ' ')
                          fine++;
                      const frM = (i + fine - 1) / 2 / an.n;
                      const salta = ((frM - an.g0 + 1) % 1) < an.gw || !!(an.gw1 && ((frM - an.g1 + 1) % 1) < an.gw1);
                      for (let k = i; k < fine && !salta; k++) {
                          const th = (k / an.n) * Math.PI * 2, r = th + Math.PI / 2, co = Math.cos(r), si = Math.sin(r);
                          g.setTransform(co, si, -si, co, m + Math.cos(th) * rad, m + Math.sin(th) * rad);
                          g.fillText(testo[k % nT], 0, 0);
                      }
                      i = fine;
                  }
                  g.setTransform(1, 0, 0, 1, 0, 0);
                  win.__spriteRifatti++;
                  return (spriteAn[j] = { cv, key, rad, S });
              };
              const disegnaAnelli = (cx, cy, R, t, zoom, alfa, col, ass, diag, jv, testoStato) => {
                  aggiornaEscluse(t);
                  ctx.textAlign = 'center';
                  ctx.textBaseline = 'middle';
                  // S5: a regime (anelli composti) gli anelli passano dalle immagini, su uno strato da cui le etichette tolgono la loro zona sfumata
                  const regime = ass >= 0.999;
                  let usati = 0;
                  if (regime) {          // le zone delle etichette escluse con un ritaglio (le parole ci scorrono sotto, non spariscono intere)
                      ctx.save();
                      ctx.beginPath();
                      ctx.rect(0, 0, W, H);
                      for (const r of escluse)
                          ctx.rect(r[0] - 6 * dpr, r[1] - 6 * dpr, r[2] - r[0] + 12 * dpr, r[3] - r[1] + 12 * dpr);
                      ctx.clip('evenodd');
                  }
                  const sctx = ctx;
                  for (let j = 0; j < anelli.length; j++) {
                      const an = anelli[j];
                      const multi = j === 0 ? 1 : 1 - (jv || 0);
                      const rad = R * an.k * zoom;
                      const fs = an.px * (R / 210) * Math.pow(zoom, 0.92);
                      if (fs < 3 * dpr)
                          continue;
                      const via = lim((rad / diag - 0.6) / 0.55);
                      const a0 = alfa * an.a * (1 - via) * multi;
                      if (a0 < 0.01)
                          continue;
                      // S2 (25/11): ogni anello di testo tutto dentro il riquadro visibile (raggio + altezza del testo + 8 px entro il bordo
                      // piu' vicino); un anello che non ci sta non si disegna, cosi' nessuna parola resta tagliata dal bordo
                      {      // S2/S5: per tutte le tele un anello o sta tutto dentro il riquadro visibile o non si disegna
                          const bx = visibile || [0, 0, W, H];
                          const spazio = Math.min(cx - bx[0], bx[2] - cx, cy - bx[1], bx[3] - cy);
                          if (rad + fs + 8 * dpr > spazio)
                              continue;
                          (win.__anelli = win.__anelli || {})[j] = { rad: rad / dpr, fs: fs / dpr, spazio: spazio / dpr, t: Math.round(win.performance.now()) };
                      }
                      const testo = j === 0 && testoStato && jv > 0.5 ? testoStato : an.testo;
                      if (regime && testo.length) {
                          const sp = spriteAnello(j, an, testo, rad, fs, col);
                          const sc = rad / sp.rad, giroI = t * 0.001 * an.v * (j === 0 && jv > 0.5 ? 1.6 : 1);
                          sctx.save();
                          sctx.globalAlpha = a0;
                          sctx.translate(cx, cy);
                          sctx.rotate(giroI);
                          if (sc !== 1)
                              sctx.scale(sc, sc);
                          sctx.drawImage(sp.cv, -sp.S / 2, -sp.S / 2);
                          sctx.restore();
                          usati++;
                          continue;
                      }
                      ctx.font = '500 ' + fs.toFixed(1) + 'px ' + fm();
                      fontStretta(ctx);
                      const giro = t * 0.001 * an.v * (j === 0 && jv > 0.5 ? 1.6 : 1);
                      let colA = -1;
                      // parola per parola (24/11, punto 7): a riposo si vedono solo parole intere; un taglio o un'etichetta
                      // tolgono la parola tutta; niente lettere che lampeggiano
                      const nT = testo.length;
                      const nUsa = nT ? (Math.floor(an.n / nT) * nT || an.n) : an.n;
                      const pos = [];
                      let i = 0;
                      while (i < nUsa) {
                          if (testo[i % nT] === ' ') {
                              i++;
                              continue;
                          }
                          let fine = i;
                          while (fine < nUsa && testo[fine % nT] !== ' ')
                              fine++;
                          const frM = (i + fine - 1) / 2 / an.n;
                          let salta = ((frM - an.g0 + 1) % 1) < an.gw || !!(an.gw1 && ((frM - an.g1 + 1) % 1) < an.gw1);
                          pos.length = 0;
                          for (let k = i; k < fine && !salta; k++) {
                              const h = an.h[k];
                              let ai = 1;
                              if (ass < 1)
                                  ai = facile(lim(ass * 1.5 - h * 0.5));
                              const fr = k / an.n;
                              const th = giro + fr * Math.PI * 2 + (1 - ai) * (h - 0.5) * 2.6;
                              const rr = rad * (1 + (1 - ai) * (h * 2.2 - 0.5));
                              const x = cx + Math.cos(th) * rr;
                              const y = cy + Math.sin(th) * rr;
                              if (ai > 0.01 && (sopraEtichetta(x, y, fs * 0.7) || x < fs * 0.6 || x > W - fs * 0.6 || y < fs * 0.6 || y > H - fs * 0.6))
                                  salta = true;           // sopra un'etichetta o tagliata dal bordo: via la parola intera
                              pos.push([k, th, x, y, ai]);
                          }
                          i = fine;
                          if (salta)
                              continue;
                          for (const q of pos) {
                              const k = q[0], th = q[1], x = q[2], y = q[3], ai = q[4];
                              if (ai <= 0.01 || x < -fs || x > W + fs || y < -fs || y > H + fs)
                                  continue;
                              const aa = Math.round(a0 * ai * 40) / 40;
                              if (aa !== colA) {
                                  ctx.fillStyle = rgba(col, aa);
                                  colA = aa;
                              }
                              const r = th + Math.PI / 2;
                              const co = Math.cos(r);
                              const si = Math.sin(r);
                              ctx.setTransform(co, si, -si, co, x, y);
                              ctx.fillText(testo[k % nT], 0, 0);
                          }
                      }
                      ctx.setTransform(1, 0, 0, 1, 0, 0);
                  }
                  if (regime)
                      ctx.restore();
                  if (cfg.nome === 'metodo')
                      win.__anelliMetodo = usati;
              };
              const esterno = (st, t, dt, k) => {
                  const cx = st.cx * W;
                  const cy = st.cy * H;
                  const R = st.R * dpr;
                  const diag = Math.hypot(W, H);
                  const col = COL.brina;
                  const modo = st.modo || 0;
                  const jv = st.jv || 0;
                  const fisso = modo >= 1 && modo <= 4;
                  const tf = st.tuffo || null;
                  const teT = tf ? tf.te : 0, imT = tf ? tf.im : 0, apT = tf ? tf.ap : 0, satA = tf ? tf.sa : 1, roT = tf ? tf.ro : 0, coT = tf ? tf.co : 0, strT = tf ? tf.st : 0;
                  if (fisso) {
                      const meta = Math.round(ang / (Math.PI * 2)) * Math.PI * 2;
                      ang += (meta - ang) * (1 - Math.exp(-dt * 2.2));
                      incl += (0.14 - incl) * k;
                  }
                  else {
                      ang += dt * (0.13 + (st.luce || 0) * 0.7) * (1 + 3 * roT);
                      incl += ((jv > 0 ? 0.3 : 0.36) - incl) * k;
                  }
                  const zoom = st.zoom || 1;
                  const alfa = st.alfa === undefined ? 1 : st.alfa;
                  const ass = st.ass === undefined ? 1 : st.ass;
                  const amp = st.amp || 0;
                  assV += (ass - assV) * (st.subito ? 1 : 1 - Math.exp(-dt * 2.6));
                  ctx.lineCap = 'round';
                  ctx.lineWidth = 1.25 * dpr;
                  GUIDE.forEach((g, j) => {
                      const rad = R * g * zoom;
                      if (rad > diag)
                          return;
                      const a = alfa * (0.2 - j * 0.022) * ass * (1 - lim((rad / diag - 0.5) / 0.45)) * (1 - jv * 0.55) * satA * (st.anelloMax && rad > st.anelloMax * dpr + 0.5 ? 1 - (st.anelloK || 0) : 1);
                      if (a <= 0.005)
                          return;
                      ctx.setLineDash([0.01 * dpr, 7 * dpr]);
                      ctx.strokeStyle = rgba(col, a);
                      ctx.beginPath();
                      ctx.arc(cx, cy, rad, 0, Math.PI * 2);
                      ctx.stroke();
                  });
                  ctx.setLineDash([]);
                  if (anelli.length)
                      disegnaAnelli(cx, cy, R, t, zoom, alfa, col, ass, diag, jv, st.anello);
                  for (let i = 0; i < N; i++) {
                      const q = P[i];
                      const c = cur[i];
                      const usaM = modo >= 1 && modo <= 4;
                      const tx = usaM ? q.m[0] : q.p[0];
                      const ty = usaM ? q.m[1] : q.p[1];
                      const tz = usaM ? q.m[2] : q.p[2];
                      if (ass < 1) {
                          const ai = facile(lim(ass * 1.4 - q.f * 0.4));
                          c.x = q.s[0] + (tx - q.s[0]) * ai;
                          c.y = q.s[1] + (ty - q.s[1]) * ai;
                          c.z = q.s[2] + (tz - q.s[2]) * ai;
                      }
                      else {
                          c.x += (tx - c.x) * k;
                          c.y += (ty - c.y) * k;
                          c.z += (tz - c.z) * k;
                      }
                      const al = modo >= 2 && modo <= 4 ? (q.c === 0 || q.c === 1 ? 1 : 0.13) : 1;
                      c.al += (al - c.al) * k;
                      const ar = (modo >= 3 && modo <= 4 && i === F1) || (modo === 4 && i === F1b) ? 1 : 0;
                      c.ar += (ar - c.ar) * k;
                      c.ci += ((modo === 6 ? 1 : 0) - c.ci) * k;
                  }
                  lab.camp += ((modo >= 2 && modo <= 4 ? 1 : 0) - lab.camp) * k;
                  lab.f1 += ((modo >= 3 && modo <= 4 ? 1 : 0) - lab.f1) * k;
                  lab.sec += ((modo === 4 ? 1 : 0) - lab.sec) * k;
                  lab.reg += ((modo === 5 ? 1 : 0) - lab.reg) * k;
                  lab.cie += ((modo === 6 ? 1 : 0) - lab.cie) * k;
                  if (win.__misuraFig && cfg.nome === 'metodo')      // S6 (25/11): solo per le prove, che cosa prevede la figura in questo passo
                      win.__fig = { modo, camp: +lab.camp.toFixed(2), f1: +lab.f1.toFixed(2), sec: +lab.sec.toFixed(2), reg: +lab.reg.toFixed(2), cie: +lab.cie.toFixed(2), corta: !!st.figCorta, anelli: win.__anelliMetodo || 0 };
                  const ca = Math.cos(ang);
                  const sa = Math.sin(ang);
                  const ci = Math.cos(incl);
                  const si = Math.sin(incl);
                  const cam = st.cam || 3.4;
                  const ruota = (x, y, z) => { const x0 = x * ca + z * sa; const z0 = -x * sa + z * ca; return [x0, y * ci - z0 * si, y * si + z0 * ci]; };
                  const proietta = (v) => { const d = cam - v[2]; if (d < 0.08)
                      return null; const s = cam / d; return [cx + v[0] * R * s, cy + v[1] * R * s, s]; };
                  const kp = 1 - 0.24 * jv;
                  const pos = new Array(N);
                  const ordine = [];
                  for (let i = 0; i < N; i++) {
                      const c = cur[i];
                      const v = ruota(c.x * kp, c.y * kp, c.z * kp);
                      const pp = proietta(v);
                      if (!pp)
                          continue;
                      if (pp[0] < -80 || pp[0] > W + 80 || pp[1] < -80 || pp[1] > H + 80)
                          continue;
                      const o = { i, X: pp[0], Y: pp[1], z: v[2] / kp, s: pp[2] };
                      pos[i] = o;
                      ordine.push(o);
                  }
                  ordine.sort((a, b) => a.z - b.z);
                  const scala = R / (210 * dpr);
                  let pv = null;
                  if (jv > 0.01 && !st.gl) {
                      const t1 = t * 0.001;
                      const vib = amp * 0.085 + (st.vibra || 0) * 0.04;
                      pv = new Array(GEO.V.length);
                      for (let i = 0; i < GEO.V.length; i++) {
                          const v = GEO.V[i];
                          const r = 1.06 * (1 + vib * Math.sin(t1 * 19 + GEO.ph[i] * 40) + 0.012 * Math.sin(t1 * 1.4 + GEO.ph[i] * 9)) * (1 - 0.08 * coT * (1 - apT));
                          const w = ruota(v[0] * r, v[1] * r, v[2] * r);
                          const pp = proietta(w);
                          let qx = pp ? pp[0] : 0, qy = pp ? pp[1] : 0, kq = 0;
                          if (pp && apT > 0.001) {
                              kq = Math.floor((Math.atan2(qy - cy, qx - cx) + Math.PI) / (Math.PI / 3)) % 6;
                              const ac = -Math.PI + (kq + 0.5) * (Math.PI / 3) + apT * 0.22;
                              const sp = apT * (0.18 + 1.25 * Math.pow(lim((w[2] / 1.06 + 1) / 2), 1.5)) * R;
                              qx += Math.cos(ac) * sp;
                              qy += Math.sin(ac) * sp;
                          }
                          pv[i] = pp ? [qx, qy, w[2], v[1], kq] : null;
                      }
                      const dietro = [];
                      for (const e of GEO.S) {
                          const A = pv[e[0]];
                          const B = pv[e[1]];
                          if (!A || !B)
                              continue;
                          if (apT > 0.25 && A[4] !== B[4])
                              continue;
                          if ((A[2] + B[2]) / 2 < 0)
                              dietro.push(A, B);
                      }
                      ctx.lineWidth = 1 * dpr;
                      ctx.strokeStyle = rgba(col, 0.1 * jv);
                      ctx.beginPath();
                      for (let j = 0; j < dietro.length; j += 2) {
                          ctx.moveTo(dietro[j][0], dietro[j][1]);
                          ctx.lineTo(dietro[j + 1][0], dietro[j + 1][1]);
                      }
                      ctx.stroke();
                      const lc = lim((st.lc || 0) + imT * 0.55 + apT * 0.25, 0, 1.1);
                      const rg = R * (0.92 + 0.08 * amp) * (1 + 0.35 * apT);
                      ctx.globalCompositeOperation = 'lighter';
                      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rg);
                      g.addColorStop(0, rgba(COL.segnale, Math.min(1, 0.95 * lc) * jv));
                      g.addColorStop(0.28, rgba(COL.segnale, 0.42 * lc * jv));
                      g.addColorStop(0.62, rgba(COL.segnale, 0.12 * lc * jv));
                      g.addColorStop(1, rgba(COL.segnale, 0));
                      ctx.fillStyle = g;
                      ctx.beginPath();
                      ctx.arc(cx, cy, rg, 0, Math.PI * 2);
                      ctx.fill();
                      if (amp > 0.02) {
                          ctx.fillStyle = rgba([255, 236, 214], Math.min(0.9, amp * 1.1) * jv);
                          ctx.beginPath();
                          ctx.arc(cx, cy, R * (0.06 + 0.1 * amp), 0, Math.PI * 2);
                          ctx.fill();
                      }
                      ctx.globalCompositeOperation = 'source-over';
                  }
                  const vie = [[], [], []];
                  VICINI.forEach((v) => {
                      const A = pos[v[0]];
                      const B = pos[v[1]];
                      if (!A || !B)
                          return;
                      if (Math.min(cur[v[0]].al, cur[v[1]].al) < 0.5)
                          return;
                      const dn = lim(((A.z + B.z) / 2 + 1) / 2);
                      vie[dn < 0.42 ? 0 : dn < 0.72 ? 1 : 2].push(A, B);
                  });
                  ctx.lineWidth = 1 * dpr;
                  const alfaLinee = alfa * lim((Math.min(ass, assV) - 0.75) / 0.25) * (1 - jv * 0.45) * (1 - 0.5 * lab.camp);
                  [0.05, 0.1, 0.16].forEach((a, f) => {
                      const l = vie[f];
                      if (!l.length || alfaLinee <= 0)
                          return;
                      ctx.strokeStyle = rgba(col, a * alfaLinee);
                      ctx.beginPath();
                      for (let j = 0; j < l.length; j += 2) {
                          ctx.moveTo(l[j].X, l[j].Y);
                          ctx.lineTo(l[j + 1].X, l[j + 1].Y);
                      }
                      ctx.stroke();
                  });
                  const lettere = [];
                  for (const o of ordine) {
                      const c = cur[o.i];
                      const q = P[o.i];
                      const dn = lim((o.z + 1) / 2);
                      const a = alfa * c.al * (0.2 + 0.8 * dn) * (0.35 + 0.65 * ass) * (1 - jv * 0.35);
                      if (a < 0.01)
                          continue;
                      const cc = c.ar > 0.02 ? mescolaCol(col, COL.segnale, c.ar) : col;
                      if (q.t === 1 || c.ci > 0.5) {
                          lettere.push([o, a, cc, dn]);
                          continue;
                      }
                      const lato = Math.max(1, (1.3 + 2.2 * dn) * dpr * scala * o.s * (1 + c.ar * 0.8));
                      ctx.fillStyle = rgba(cc, a);
                      ctx.fillRect(o.X - lato / 2, o.Y - lato / 2, lato, lato);
                      if (strT > 0.03) {
                          ctx.strokeStyle = rgba(cc, a * 0.55);
                          ctx.lineWidth = lato;
                          ctx.beginPath();
                          ctx.moveTo(o.X, o.Y);
                          ctx.lineTo(o.X + (o.X - cx) * 0.16 * strT, o.Y + (o.Y - cy) * 0.16 * strT);
                          ctx.stroke();
                      }
                  }
                  ctx.textAlign = 'center';
                  ctx.textBaseline = 'middle';
                  let fa = '';
                  lettere.forEach((v) => {
                      const o = v[0];
                      const c = cur[o.i];
                      const q = P[o.i];
                      const px = Math.max(5, Math.round((8 + 6.5 * v[3]) * dpr * scala * o.s * (1 - jv * 0.2)));
                      const f = '500 ' + px + 'px ' + fm();
                      if (f !== fa) {
                          ctx.font = f;
                          fontStretta(ctx);
                          fa = f;
                      }
                      const ch = c.ci > 0.5 ? '?' : SEGNI[(q.g + Math.floor(t / (jv > 0.5 && (st.luce || 0) > 0.5 ? 180 : 2300) + q.f * 13)) % SEGNI.length];
                      // S5 (25/11): le lettere della sfera da un archivio di glifi (ogni lettera, grandezza e colore disegnata una volta)
                      const cg = c.ci > 0.5 ? COL.nebbia : v[2], al = v[1] * (c.ci > 0.5 ? 0.8 : 1);
                      if (al < 0.005)
                          return;
                      if (!cfg.glifi) {        // dove l'archivio non conviene (misurato: «Come lo misuriamo») resta il testo diretto
                          ctx.fillStyle = rgba(cg, al);
                          ctx.fillText(ch, o.X, o.Y);
                          return;
                      }
                      const gl = glifo(ch, f, px, cg);
                      ctx.globalAlpha = al > 1 ? 1 : al;
                      ctx.drawImage(gl.c, o.X - gl.m, o.Y - gl.m);
                  });
                  ctx.globalAlpha = 1;
                  if (jv > 0.01) {
                      if (pv) {
                          const davanti = [];
                          const accesi = [];
                          const scan = teT > 0.05 ? undefined : st.scanY;
                          for (const e of GEO.S) {
                              const A = pv[e[0]];
                              const B = pv[e[1]];
                              if (!A || !B)
                                  continue;
                              if (apT > 0.25 && A[4] !== B[4])
                                  continue;
                              const z = (A[2] + B[2]) / 2;
                              if (z < 0)
                                  continue;
                              if (scan !== undefined && Math.abs((A[3] + B[3]) / 2 - scan) < 0.09)
                                  accesi.push(A, B);
                              else
                                  davanti.push(A, B, z);
                          }
                          ctx.lineWidth = 1.1 * dpr;
                          ctx.strokeStyle = rgba(col, (0.26 + 0.3 * amp) * jv);
                          ctx.beginPath();
                          for (let j = 0; j < davanti.length; j += 3) {
                              ctx.moveTo(davanti[j][0], davanti[j][1]);
                              ctx.lineTo(davanti[j + 1][0], davanti[j + 1][1]);
                          }
                          ctx.stroke();
                          if (accesi.length) {
                              ctx.lineWidth = 1.6 * dpr;
                              ctx.strokeStyle = rgba(COL.segnale, 0.85 * jv);
                              ctx.beginPath();
                              for (let j = 0; j < accesi.length; j += 2) {
                                  ctx.moveTo(accesi[j][0], accesi[j][1]);
                                  ctx.lineTo(accesi[j + 1][0], accesi[j + 1][1]);
                              }
                              ctx.stroke();
                          }
                          if (scan !== undefined) {
                              const rl = Math.sqrt(Math.max(0, 1 - scan * scan)) * 1.07;
                              const fronte = [];
                              const retro = [];
                              let pp0 = null;
                              for (let i = 0; i <= 96; i++) {
                                  const a = (i / 96) * Math.PI * 2;
                                  const w = ruota(Math.cos(a) * rl, scan * 1.07, Math.sin(a) * rl);
                                  const pp = proietta(w);
                                  if (pp && pp0)
                                      (w[2] >= 0 ? fronte : retro).push(pp0[0], pp0[1], pp[0], pp[1]);
                                  pp0 = pp;
                              }
                              ctx.globalCompositeOperation = 'lighter';
                              [[retro, 0.16, 1.1], [fronte, 0.18, 8], [fronte, 0.95, 1.6]].forEach((v) => {
                                  if (!v[0].length)
                                      return;
                                  ctx.lineWidth = v[2] * dpr;
                                  ctx.strokeStyle = rgba(COL.segnale, v[1] * jv);
                                  ctx.beginPath();
                                  for (let j = 0; j < v[0].length; j += 4) {
                                      ctx.moveTo(v[0][j], v[0][j + 1]);
                                      ctx.lineTo(v[0][j + 2], v[0][j + 3]);
                                  }
                                  ctx.stroke();
                              });
                              ctx.globalCompositeOperation = 'source-over';
                          }
                          ctx.fillStyle = rgba(col, 0.5 * jv);
                          for (let i = 0; i < pv.length; i++) {
                              const p = pv[i];
                              if (p && p[2] > 0.35)
                                  ctx.fillRect(p[0] - dpr, p[1] - dpr, 2 * dpr, 2 * dpr);
                          }
                      }
                      if (!st.subito) {
                          if (amp > 0.3 && ampPrima <= 0.3 && t - ultimaOnda > 170) {
                              onde.push({ t0: t, c: onde.length % 2 });
                              ultimaOnda = t;
                          }
                          if (st.ascolto && t - ultimaOnda > 650) {
                              onde.push({ t0: t, c: 1, dentro: true });
                              ultimaOnda = t;
                          }
                          // L1 (25/11): un impulso verso il nucleo a ogni risultato del riconoscimento, uno piccolo a ogni tasto
                          if ((st.impulsi || 0) !== ultimoImp) {
                              ultimoImp = st.impulsi || 0;
                              onde.push({ t0: t, c: 1, dentro: true });
                          }
                          if ((st.impulsiP || 0) !== ultimoImpP) {
                              ultimoImpP = st.impulsiP || 0;
                              onde.push({ t0: t, c: 0, dentro: true, piccola: true });
                          }
                      }
                      else
                          onde.length = 0;
                      ampPrima = amp;
                      for (let j = onde.length - 1; j >= 0; j--) {
                          const o = onde[j];
                          const p = (t - o.t0) / 1500;
                          if (p >= 1) {
                              onde.splice(j, 1);
                              continue;
                          }
                          const rr = Math.min(o.dentro ? R * (2.5 - 1.35 * esce(p)) : R * (1.14 + 1.55 * esce(p)), st.anelloMax ? st.anelloMax * dpr : 1e9);
                          ctx.lineWidth = 1.3 * dpr;
                          ctx.strokeStyle = rgba(o.c ? COL.segnale : col, (o.piccola ? 0.3 : 0.55) * Math.pow(1 - p, 1.5) * jv);
                          ctx.beginPath();
                          ctx.arc(cx, cy, rr, 0, Math.PI * 2);
                          ctx.stroke();
                      }
                      const dist = R * (st.distSat || 1.62);
                      const jvS = jv * satA;
                      if (!st.senzaSat)
                          SATELLITI.forEach((s, j) => {
                              const jv = jvS;
                              const att = st.sat === s.n ? 1 : 0;
                              sat[j] += (att - sat[j]) * (st.subito ? 1 : 1 - Math.exp(-dt * 6));
                              const x = cx + Math.cos(s.a) * dist;
                              const y = cy + Math.sin(s.a) * dist;
                              const x0 = cx + Math.cos(s.a) * R * 1.12;
                              const y0 = cy + Math.sin(s.a) * R * 1.12;
                              ctx.lineWidth = (1 + sat[j]) * dpr;
                              ctx.setLineDash(sat[j] > 0.5 ? [] : [2 * dpr, 4 * dpr]);
                              ctx.strokeStyle = rgba(sat[j] > 0.05 ? mescolaCol(col, COL.segnale, sat[j]) : col, (0.22 + 0.6 * sat[j]) * jv);
                              ctx.beginPath();
                              ctx.moveTo(x0, y0);
                              ctx.lineTo(x, y);
                              ctx.stroke();
                              ctx.setLineDash([]);
                              if (sat[j] > 0.05) {
                                  ctx.fillStyle = rgba(COL.segnale, 0.22 * sat[j] * jv);
                                  ctx.beginPath();
                                  ctx.arc(x, y, (9 + 5 * Math.sin(t * 0.006)) * dpr, 0, Math.PI * 2);
                                  ctx.fill();
                              }
                              ctx.fillStyle = sat[j] > 0.05 ? rgba(COL.segnale, jv) : rgba(COL.stanza, jv);
                              ctx.strokeStyle = rgba(sat[j] > 0.05 ? COL.segnale : col, 0.9 * jv);
                              ctx.lineWidth = 1.2 * dpr;
                              ctx.beginPath();
                              ctx.arc(x, y, 4.5 * dpr, 0, Math.PI * 2);
                              ctx.fill();
                              ctx.stroke();
                              const sopra = Math.sin(s.a) < 0;
                              etichetta(SAT_ETI[s.n] || '', x, y + (sopra ? -16 : 17) * dpr, sat[j] > 0.05 ? mescolaCol(col, COL.segnale, sat[j]) : COL.nebbia, (0.55 + 0.45 * sat[j]) * jv, 'center');
                              if (win.__misuraEti)            // N6 (25/11): solo per le prove, dove cadono le etichette (px CSS)
                                  (win.__etiSat = win.__etiSat || {})[s.n] = { x: x / dpr, w: ctx.measureText(SAT_ETI[s.n] || '').width / dpr, W: ctx.canvas.width / dpr };
                          });
                      if (st.filo && st.filoA > 0.01) {
                          const tx = st.filo.x * dpr, ty = st.filo.y * dpr;
                          const kf = st.subito || !filoS || tf ? 1 : 1 - Math.exp(-dt * 9);
                          if (!filoS)
                              filoS = { x: tx, y: ty };
                          filoS.x += (tx - filoS.x) * kf;
                          filoS.y += (ty - filoS.y) * kf;
                          if (st.filo.k !== filoK) {
                              if (filoK !== null && !st.subito)
                                  filoT0 = t;
                              filoK = st.filo.k;
                          }
                          const ex = filoS.x, ey = filoS.y;
                          const sx = cx + R * 1.12, sy = cy;
                          const L = Math.max(2 * dpr, ex - sx);
                          const c1x = sx + L * 0.45, c1y = sy, c2x = ex - L * 0.45, c2y = ey;
                          const fa = tf ? tf.fa : 1;
                          const a = (st.attivo ? 0.9 : 0.35) * st.filoA * jv * fa;
                          const cf = st.attivo ? COL.segnale : col;
                          if (a > 0.005 && ex > sx) {
                              ctx.lineWidth = 1.3 * dpr;
                              ctx.setLineDash([5 * dpr, 5 * dpr]);
                              ctx.lineDashOffset = -t * 0.035 * dpr;
                              ctx.strokeStyle = rgba(cf, a);
                              ctx.beginPath();
                              ctx.moveTo(sx, sy);
                              ctx.bezierCurveTo(c1x, c1y, c2x, c2y, ex - 2 * dpr, ey);
                              ctx.stroke();
                              ctx.setLineDash([]);
                              ctx.lineDashOffset = 0;
                              ctx.beginPath();
                              ctx.moveTo(cx + R * 1.03, cy);
                              ctx.lineTo(sx, sy);
                              ctx.stroke();
                              ctx.fillStyle = rgba(COL.stanza, Math.min(1, a * 1.4));
                              ctx.lineWidth = 1.2 * dpr;
                              ctx.beginPath();
                              ctx.arc(sx, sy, 3.2 * dpr, 0, Math.PI * 2);
                              ctx.fill();
                              ctx.stroke();
                              ctx.fillStyle = rgba(cf, a);
                              ctx.beginPath();
                              ctx.arc(ex, ey, 2.4 * dpr, 0, Math.PI * 2);
                              ctx.fill();
                          }
                          const uo = (t - filoT0) / 520;
                          if (!tf && uo > 0 && uo < 1 && ex > sx) {
                              const u = esce(uo), v = 1 - u, fz = 0.15 + 0.85 * Math.sin(Math.PI * uo);
                              const qx = v * v * v * sx + 3 * v * v * u * c1x + 3 * v * u * u * c2x + u * u * u * ex, qy = v * v * v * sy + 3 * v * v * u * c1y + 3 * v * u * u * c2y + u * u * u * ey;
                              ctx.globalCompositeOperation = 'lighter';
                              ctx.fillStyle = rgba(COL.segnale, 0.24 * fz * jv);
                              ctx.beginPath();
                              ctx.arc(qx, qy, 10 * dpr, 0, Math.PI * 2);
                              ctx.fill();
                              ctx.fillStyle = rgba([255, 214, 176], 0.95 * fz * jv);
                              ctx.beginPath();
                              ctx.arc(qx, qy, 3 * dpr, 0, Math.PI * 2);
                              ctx.fill();
                              ctx.globalCompositeOperation = 'source-over';
                          }
                      }
                      else
                          filoS = null;
                      if (tf && tf.parti && tf.parti.length) {
                          ctx.globalCompositeOperation = 'lighter';
                          for (const q of tf.parti) {
                              const x0 = q.x * dpr, y0 = q.y * dpr, dx = cx - x0, dy = cy - y0, l = Math.hypot(dx, dy) || 1;
                              const kx = (x0 + cx) / 2 - (dy / l) * l * 0.28 * q.lato, ky = (y0 + cy) / 2 + (dx / l) * l * 0.28 * q.lato;
                              for (let s = 0; s < 5; s++) {
                                  const u = facile(lim(q.u - s * 0.045)), v = 1 - u;
                                  if (q.u - s * 0.045 <= 0)
                                      break;
                                  const px = v * v * x0 + 2 * v * u * kx + u * u * cx, py = v * v * y0 + 2 * v * u * ky + u * u * cy;
                                  const al = (1 - s / 5) * (0.35 + 0.65 * Math.sin(Math.PI * Math.min(1, q.u * 1.1)));
                                  if (s === 0) {
                                      ctx.fillStyle = rgba(COL.segnale, 0.22 * al);
                                      ctx.beginPath();
                                      ctx.arc(px, py, 12 * dpr, 0, Math.PI * 2);
                                      ctx.fill();
                                  }
                                  ctx.fillStyle = rgba(s === 0 ? [255, 220, 186] : COL.segnale, (s === 0 ? 0.95 : 0.5) * al);
                                  ctx.beginPath();
                                  ctx.arc(px, py, (3.2 - s * 0.45) * dpr, 0, Math.PI * 2);
                                  ctx.fill();
                              }
                          }
                          ctx.globalCompositeOperation = 'source-over';
                      }
                      if (tf && tf.m > 1400 && tf.m < 2900) {
                          ctx.globalCompositeOperation = 'lighter';
                          for (let s = 0; s < 3; s++) {
                              const u = (tf.m - 1400 - s * 220) / 900;
                              if (u <= 0 || u >= 1)
                                  continue;
                              ctx.lineWidth = (2.2 - 1.2 * u) * dpr;
                              ctx.strokeStyle = rgba(COL.segnale, 0.55 * Math.pow(1 - u, 1.6) * jv);
                              ctx.beginPath();
                              ctx.arc(cx, cy, R * (1.1 + 2.4 * esce(u)), 0, Math.PI * 2);
                              ctx.stroke();
                          }
                          ctx.globalCompositeOperation = 'source-over';
                      }
                      if (st.conto > 0.001) {
                          const rc = R * 1.22;
                          ctx.lineWidth = 1 * dpr;
                          ctx.strokeStyle = rgba(col, 0.14 * jv);
                          ctx.beginPath();
                          ctx.arc(cx, cy, rc, 0, Math.PI * 2);
                          ctx.stroke();
                          ctx.lineWidth = 2 * dpr;
                          ctx.strokeStyle = rgba(COL.segnale, 0.9 * jv);
                          ctx.beginPath();
                          ctx.arc(cx, cy, rc, -Math.PI / 2, -Math.PI / 2 + st.conto * Math.PI * 2);
                          ctx.stroke();
                      }
                      if (st.scena && st.scena.q > 0.01) {
                          const sc = st.scena;
                          const q = sc.q;
                          let pts;
                          if (sc.verticale)
                              pts = [[cx, cy + R * 1.12], [cx, sc.y * dpr]];
                          else {
                              const x0 = cx + R * 1.12;
                              const x1 = sc.x * dpr;
                              const y1 = (sc.y + 26) * dpr;
                              const gx = x0 + (x1 - x0) * 0.55;
                              pts = [[x0, cy], [gx, cy], [gx, y1], [x1, y1]];
                          }
                          let tot = 0;
                          for (let i = 1; i < pts.length; i++)
                              tot += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
                          let resto = tot * q;
                          ctx.lineWidth = 1 * dpr;
                          ctx.setLineDash([4 * dpr, 4 * dpr]);
                          ctx.lineDashOffset = -t * 0.03 * dpr;
                          ctx.strokeStyle = rgba(col, 0.42 * jv);
                          ctx.beginPath();
                          ctx.moveTo(pts[0][0], pts[0][1]);
                          let ex = pts[0][0];
                          let ey = pts[0][1];
                          for (let i = 1; i < pts.length && resto > 0; i++) {
                              const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
                              const f = Math.min(1, resto / (l || 1));
                              ex = pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f;
                              ey = pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f;
                              ctx.lineTo(ex, ey);
                              resto -= l;
                          }
                          ctx.stroke();
                          ctx.setLineDash([]);
                          ctx.lineDashOffset = 0;
                          ctx.fillStyle = rgba(COL.segnale, q * jv);
                          ctx.beginPath();
                          ctx.arc(ex, ey, 3 * dpr, 0, Math.PI * 2);
                          ctx.fill();
                      }
                      if (st.verso && st.verso.a > 0.01) {
                          const vx = st.verso.x * dpr;
                          const vy = st.verso.y * dpr;
                          const an = Math.atan2(vy - cy, vx - cx);
                          const x0 = cx + Math.cos(an) * R * 1.1;
                          const y0 = cy + Math.sin(an) * R * 1.1;
                          ctx.lineWidth = 1 * dpr;
                          ctx.strokeStyle = rgba(COL.segnale, 0.34 * st.verso.a * jv);
                          ctx.beginPath();
                          ctx.moveTo(x0, y0);
                          ctx.quadraticCurveTo((x0 + vx) / 2, Math.min(y0, vy) - 40 * dpr, vx, vy);
                          ctx.stroke();
                      }
                  }
                  const FA = pos[F1];
                  const FB = pos[F1b];
                  const arancio = COL.segnale;
                  if (FA && lab.f1 > 0.02) {
                      ctx.setLineDash([3 * dpr, 4 * dpr]);
                      ctx.lineWidth = 1.2 * dpr;
                      [12, 21, 32].forEach((r0, j) => {
                          ctx.strokeStyle = rgba(arancio, lab.f1 * (0.75 - j * 0.2));
                          ctx.beginPath();
                          ctx.arc(FA.X, FA.Y, r0 * dpr * Math.max(0.7, scala), 0, Math.PI * 2);
                          ctx.stroke();
                      });
                      ctx.setLineDash([]);
                      if (st.figCorta)
                          etichetta('F1', FA.X, FA.Y - (32 * Math.max(0.7, scala) + 10) * dpr, arancio, lab.f1, 'center');
                      else if (W / dpr < 600) {
                          const PB = proietta(ruota(CENTRI[1][0], CENTRI[1][1], CENTRI[1][2]));
                          const yA = PB ? PB[1] - 74 * dpr : cy - R;
                          ctx.lineWidth = 1 * dpr;
                          ctx.strokeStyle = rgba(arancio, 0.6 * lab.f1);
                          ctx.beginPath();
                          ctx.moveTo(FA.X, FA.Y - 34 * dpr * Math.max(0.7, scala));
                          ctx.lineTo(FA.X, yA);
                          ctx.lineTo(Math.min(FA.X, 120 * dpr), yA);
                          ctx.stroke();
                          pillola('', 10 * dpr, yA, arancio, lab.f1, 'left', true);
                      }
                      else
                          pillola('', FA.X - 52 * dpr, FA.Y - 48 * dpr, arancio, lab.f1, 'right', true);
                  }
                  if (lab.camp > 0.02 && st.figCorta) {
                      [[CENTRI[0], '1'], [CENTRI[1], '2']].forEach((v) => {
                          const P0 = proietta(ruota(v[0][0], v[0][1], v[0][2]));
                          if (!P0)
                              return;
                          const x = P0[0];
                          const y = P0[1] + R * 0.38;
                          ctx.fillStyle = rgba(COL.stanza, 0.82 * lab.camp);
                          ctx.beginPath();
                          ctx.arc(x, y, 9 * dpr, 0, Math.PI * 2);
                          ctx.fill();
                          ctx.lineWidth = 1 * dpr;
                          ctx.strokeStyle = rgba(col, lab.camp * 0.7);
                          ctx.stroke();
                          etichetta(v[1], x, y, col, lab.camp, 'center');
                      });
                  }
                  else if (lab.camp > 0.02) {
                      const A = proietta(ruota(CENTRI[0][0], CENTRI[0][1], CENTRI[0][2]));
                      const B = proietta(ruota(CENTRI[1][0], CENTRI[1][1], CENTRI[1][2]));
                      ctx.lineWidth = 1 * dpr;
                      if (A) {
                          ctx.strokeStyle = rgba(col, lab.camp * 0.35);
                          ctx.beginPath();
                          ctx.moveTo(A[0] - 30 * dpr, A[1] + 34 * dpr);
                          ctx.lineTo(A[0] - 70 * dpr, A[1] + 74 * dpr);
                          ctx.lineTo(A[0] - 120 * dpr, A[1] + 74 * dpr);
                          ctx.stroke();
                          pillola(scriviCamp(String(CAMPIONI[0] || '').toUpperCase(), lab.camp), A[0] - 124 * dpr, A[1] + 74 * dpr, COL.brina, lab.camp, 'right', false);
                      }
                      if (B) {
                          ctx.strokeStyle = rgba(col, lab.camp * 0.35);
                          ctx.beginPath();
                          ctx.moveTo(B[0] + 30 * dpr, B[1] - 34 * dpr);
                          ctx.lineTo(B[0] + 70 * dpr, B[1] - 74 * dpr);
                          ctx.lineTo(B[0] + 120 * dpr, B[1] - 74 * dpr);
                          ctx.stroke();
                          pillola(scriviCamp(String(CAMPIONI[1] || '').toUpperCase(), lab.camp), B[0] + 124 * dpr, B[1] - 74 * dpr, COL.brina, lab.camp, 'left', false);
                      }
                  }
                  if (FA && FB && lab.sec > 0.02) {
                      ctx.setLineDash([6 * dpr, 5 * dpr]);
                      ctx.lineWidth = 2 * dpr;
                      ctx.strokeStyle = rgba(arancio, lab.sec);
                      ctx.beginPath();
                      ctx.moveTo(FA.X, FA.Y);
                      ctx.quadraticCurveTo((FA.X + FB.X) / 2, Math.min(FA.Y, FB.Y) - 120 * dpr * scala, FB.X, FB.Y);
                      ctx.stroke();
                      ctx.setLineDash([]);
                      if (st.figCorta)
                          etichetta('?', FB.X, FB.Y - 18 * dpr, arancio, lab.sec, 'center');
                      else if (W / dpr < 600) {
                          const PA = proietta(ruota(CENTRI[0][0], CENTRI[0][1], CENTRI[0][2]));
                          const yB = PA ? PA[1] + 110 * dpr : cy + R;
                          ctx.lineWidth = 1 * dpr;
                          ctx.strokeStyle = rgba(arancio, 0.6 * lab.sec);
                          ctx.beginPath();
                          ctx.moveTo(FB.X, FB.Y + 8 * dpr);
                          ctx.lineTo(FB.X, yB);
                          ctx.lineTo(Math.max(FB.X, W - 120 * dpr), yB);
                          ctx.stroke();
                          pillola('', W - 10 * dpr, yB, arancio, lab.sec, 'right', true);
                      }
                      else
                          pillola('', FB.X + 10 * dpr, FB.Y + 52 * dpr, arancio, lab.sec, 'left', true);
                  }
                  if (lab.reg > 0.02) {
                      const lato = R * 2.55;
                      const x0 = cx - lato / 2;
                      const y0 = cy - lato / 2;
                      ctx.lineWidth = 1 * dpr;
                      ctx.strokeStyle = rgba(col, lab.reg * 0.45);
                      ctx.setLineDash([4 * dpr, 6 * dpr]);
                      ctx.strokeRect(x0, y0, lato, lato);
                      ctx.setLineDash([]);
                      ctx.lineWidth = 2 * dpr;
                      ctx.strokeStyle = rgba(col, lab.reg * 0.95);
                      const b = 18 * dpr;
                      [[x0, y0, 1, 1], [x0 + lato, y0, -1, 1], [x0, y0 + lato, 1, -1], [x0 + lato, y0 + lato, -1, -1]].forEach((v) => {
                          ctx.beginPath();
                          ctx.moveTo(v[0] + b * v[2], v[1]);
                          ctx.lineTo(v[0], v[1]);
                          ctx.lineTo(v[0], v[1] + b * v[3]);
                          ctx.stroke();
                      });
                      if (!st.figCorta) {
                          pillola('', x0, y0 - 20 * dpr, COL.brina, lab.reg, 'left', false);
                          pillola('', x0 + lato, y0 + lato + 22 * dpr, arancio, lab.reg, 'right', true);
                      }
                  }
                  if (lab.cie > 0.02 && !st.figCorta)
                      pillola('', cx, cy + R * 1.62, COL.brina, lab.cie, 'center', false);
                  if (st.centro > 0.01) {
                      const r0 = 4.5 * dpr;
                      const ph = (t % 1800) / 1800;
                      const pp = Math.min(1, ph / 0.75);
                      ctx.fillStyle = rgba(arancio, st.centro * 0.45 * (1 - pp));
                      ctx.beginPath();
                      ctx.arc(cx, cy, r0 * (1 + 1.6 * pp), 0, Math.PI * 2);
                      ctx.fill();
                      ctx.fillStyle = rgba(arancio, st.centro);
                      ctx.beginPath();
                      ctx.arc(cx, cy, r0, 0, Math.PI * 2);
                      ctx.fill();
                  }
                  svuotaCoda();
              };
              const disegna = (st, t) => {
                  if (!ctx)
                      return;
                  if (!W)
                      dimensiona();
                  if (!W)
                      return;
                  const dt = ultimo ? Math.min(0.05, (t - ultimo) / 1000) : 0.016;
                  ultimo = t;
                  const k = st.subito ? 1 : 1 - Math.exp(-dt * 3.4);
                  ctx.setTransform(1, 0, 0, 1, 0, 0);
                  ctx.clearRect(0, 0, W, H);
                  esterno(st, t, dt, k);
              };
              return { dimensiona, disegna, tela, cfg };
          };
          const geodetico = (liv) => {
              const t0 = (1 + Math.sqrt(5)) / 2;
              const V = [[-1, t0, 0], [1, t0, 0], [-1, -t0, 0], [1, -t0, 0], [0, -1, t0], [0, 1, t0], [0, -1, -t0], [0, 1, -t0], [t0, 0, -1], [t0, 0, 1], [-t0, 0, -1], [-t0, 0, 1]].map(unisci);
              let F = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
              for (let s = 0; s < liv; s++) {
                  const cache = new Map();
                  const NF = [];
                  const mezzo = (a, b) => { const k = a < b ? a + '_' + b : b + '_' + a; if (cache.has(k))
                      return cache.get(k); V.push(unisci([(V[a][0] + V[b][0]) / 2, (V[a][1] + V[b][1]) / 2, (V[a][2] + V[b][2]) / 2])); cache.set(k, V.length - 1); return V.length - 1; };
                  F.forEach((f) => { const ab = mezzo(f[0], f[1]); const bc = mezzo(f[1], f[2]); const ca = mezzo(f[2], f[0]); NF.push([f[0], ab, ca], [f[1], bc, ab], [f[2], ca, bc], [ab, bc, ca]); });
                  F = NF;
              }
              const E = new Set();
              const S = [];
              F.forEach((f) => [[f[0], f[1]], [f[1], f[2]], [f[2], f[0]]].forEach((e) => { const a = Math.min(e[0], e[1]); const b = Math.max(e[0], e[1]); const k = a + '_' + b; if (!E.has(k)) {
                  E.add(k);
                  S.push([a, b]);
              } }));
              return { V, S, F };
          };
          const creaNucleoGL = (tela) => {
              if (!tela || !tela.getContext)
                  return null;
              let gl = null;
              try {
                  gl = tela.getContext('webgl2', { antialias: true, alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: !!fermo, powerPreference: 'high-performance' });
              }
              catch (e) {
                  gl = null;
              }
              if (!gl)
                  return null;
              let perso = false;
              ascolta(tela, 'webglcontextlost', (e) => { e.preventDefault(); perso = true; });
              const nc = win.navigator && win.navigator.hardwareConcurrency;
              const leggero = stretto() || (nc && nc <= 4);
              const EST = geodetico(leggero ? 2 : 3);
              const INT = geodetico(1);
              const NE = EST.V.length;
              const NI = INT.V.length;
              const NS = EST.S.length;
              const NSI = INT.S.length;
              const BANDE = 9;
              const reg = new Float32Array(NE * 3);
              const banda = new Int8Array(NE);
              const seme = new Float32Array(NE);
              const fd = new Float32Array(NE * 3);
              const rit = new Float32Array(NE);
              for (let i = 0; i < NE; i++) {
                  const p = EST.V[i];
                  const k = Math.round(((p[1] + 1) / 2) * (BANDE - 1));
                  const yq = -0.88 + (k * 1.76) / (BANDE - 1);
                  const rr = Math.sqrt(1 - yq * yq);
                  let dx = p[0];
                  let dz = p[2];
                  let l = Math.hypot(dx, dz);
                  if (l < 1e-3) {
                      const a = caso() * Math.PI * 2;
                      dx = Math.cos(a);
                      dz = Math.sin(a);
                      l = 1;
                  }
                  reg[i * 3] = (dx / l) * rr * 1.03;
                  reg[i * 3 + 1] = yq;
                  reg[i * 3 + 2] = (dz / l) * rr * 1.03;
                  banda[i] = k;
                  seme[i] = caso();
                  const d = unisci([caso() - 0.5, caso() - 0.5, caso() - 0.5]);
                  fd[i * 3] = d[0];
                  fd[i * 3 + 1] = d[1];
                  fd[i * 3 + 2] = d[2];
              }
              const adia = Array.from({ length: NE }, () => []);
              EST.S.forEach((e, j) => { adia[e[0]].push(j); adia[e[1]].push(j); });
              const soglia = new Float32Array(NS);
              for (let j = 0; j < NS; j++)
                  soglia[j] = caso();
              const FAC = [];
              for (let j = 0; j < EST.F.length; j++)
                  if (caso() < 0.06)
                      FAC.push(j);
              const facFase = FAC.map(() => caso());
              const MAXI = 48;
              const NUC = geodetico(0);
              const NNU = NUC.V.length;
              const NSN = NUC.S.length;
              const NPART = leggero ? 26 : 60;
              const NSEG = NS + NSI + 12 + NSN + NNU + 8;
              const NPT = NE + NI + MAXI + NNU + NPART + 16;
              const segBuf = new Float32Array(NSEG * 7);
              const ptBuf = new Float32Array(NPT * 5);
              const triBuf = new Float32Array(FAC.length * 3 * 4);
              const PX = new Float32Array(NE * 4);
              const PI2 = new Float32Array(NI * 4);
              const PN = new Float32Array(NNU * 4);
              const PART = [];
              for (let i = 0; i < NPART; i++) {
                  const inc = caso() * Math.PI, nod = caso() * Math.PI * 2;
                  PART.push({ a: 1.16 + 0.34 * caso(), ci: Math.cos(inc), si: Math.sin(inc), cn: Math.cos(nod), sn: Math.sin(nod), f0: caso() * 6.2832, vel: (0.05 + 0.1 * caso()) * (caso() < 0.5 ? -1 : 1), sz: 0.7 + 1.1 * caso(), lu: 0.24 + 0.5 * caso(), conv: i % 5 === 0, v: caso() });
              }
              const acc = new Float32Array(NS);
              const PET = Math.PI / 3;
              const pet = new Int8Array(NE);
              let imPrima = 0;
              let petFisso = false;
              let colpiPrima = 0;
              let pmx = 0, pmy = 0, pax = 0, pay = 0, pbx = 0, pby = 0, bat = 0, yaw3 = 0, tpa = 0;
              const puntatoreFine = !!(win.matchMedia && win.matchMedia('(hover: hover) and (pointer: fine)').matches);
              if (puntatoreFine && !fermo)
                  ascolta(root, 'pointermove', (e) => { pmx = lim(e.clientX / Math.max(1, win.innerWidth)) - 0.5; pmy = lim(e.clientY / Math.max(1, win.innerHeight)) - 0.5; }, { passive: true });
              const prog = (vs, fs) => {
                  const c = (tipo, src) => { const s = gl.createShader(tipo); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
                      throw new Error(gl.getShaderInfoLog(s) || 'shader'); return s; };
                  const p = gl.createProgram();
                  gl.attachShader(p, c(gl.VERTEX_SHADER, vs));
                  gl.attachShader(p, c(gl.FRAGMENT_SHADER, fs));
                  gl.linkProgram(p);
                  if (!gl.getProgramParameter(p, gl.LINK_STATUS))
                      throw new Error(gl.getProgramInfoLog(p) || 'link');
                  const u = {};
                  const nu = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
                  for (let i = 0; i < nu; i++) {
                      const inf = gl.getActiveUniform(p, i);
                      u[inf.name] = gl.getUniformLocation(p, inf.name);
                  }
                  return { p, u };
              };
              const COLORI = 'uniform vec3 uA; uniform vec3 uB; uniform vec3 uG; uniform float uGr;\n';
              let PL, PP, PT, PG;
              try {
                  PL = prog('#version 300 es\nlayout(location=0) in vec2 aC;\nlayout(location=1) in vec4 aS;\nlayout(location=2) in vec3 aP;\nuniform vec2 uRes;\nout float vA; out float vW; out float vD; out float vH;\nvoid main(){ vec2 A=aS.xy, B=aS.zw; vec2 d=B-A; float L=length(d); vec2 dir=L>1e-4?d/L:vec2(1.0,0.0); vec2 nn=vec2(-dir.y,dir.x); float h=aP.z*0.5+1.0; vec2 P=mix(A,B,aC.x)+nn*aC.y*h+dir*(aC.x*2.0-1.0)*0.5; vec2 c=P/uRes*2.0-1.0; gl_Position=vec4(c.x,-c.y,0.0,1.0); vA=aP.x; vW=aP.y; vD=aC.y*h; vH=aP.z*0.5; }', '#version 300 es\nprecision mediump float;\nin float vA; in float vW; in float vD; in float vH;\n' + COLORI + 'out vec4 o;\nvoid main(){ float cov=clamp(vH+0.5-abs(vD),0.0,1.0); vec3 c=mix(mix(uA,uB,clamp(vW,0.0,1.0)),uG,uGr); vec3 k=c*(vA*cov); o=vec4(k,max(k.r,max(k.g,k.b))); }');
                  PP = prog('#version 300 es\nlayout(location=0) in vec4 aP;\nlayout(location=1) in float aW;\nuniform vec2 uRes;\nout float vA; out float vW;\nvoid main(){ vec2 c=aP.xy/uRes*2.0-1.0; gl_Position=vec4(c.x,-c.y,0.0,1.0); gl_PointSize=aP.z; vA=aP.w; vW=aW; }', '#version 300 es\nprecision mediump float;\nin float vA; in float vW;\n' + COLORI + 'out vec4 o;\nvoid main(){ vec2 q=gl_PointCoord*2.0-1.0; float r=dot(q,q); if(r>1.0) discard; float a=vA*(exp(-r*7.0)*0.85+smoothstep(0.16,0.0,r)*0.6); vec3 c=mix(mix(uA,uB,clamp(vW,0.0,1.0)),uG,uGr); vec3 k=c*a; o=vec4(k,max(k.r,max(k.g,k.b))); }');
                  PT = prog('#version 300 es\nlayout(location=0) in vec4 aT;\nuniform vec2 uRes;\nout float vA; out float vW;\nvoid main(){ vec2 c=aT.xy/uRes*2.0-1.0; gl_Position=vec4(c.x,-c.y,0.0,1.0); vA=aT.z; vW=aT.w; }', '#version 300 es\nprecision mediump float;\nin float vA; in float vW;\n' + COLORI + 'out vec4 o;\nvoid main(){ vec3 c=mix(mix(uA,uB,clamp(vW,0.0,1.0)),uG,uGr); vec3 k=c*vA; o=vec4(k,max(k.r,max(k.g,k.b))); }');
                  PG = prog('#version 300 es\nlayout(location=0) in vec2 aQ;\nuniform vec2 uRes; uniform vec2 uC; uniform float uR;\nout vec2 vP;\nvoid main(){ vec2 P=uC+aQ*uR*1.55; vP=P; vec2 c=P/uRes*2.0-1.0; gl_Position=vec4(c.x,-c.y,0.0,1.0); }', '#version 300 es\nprecision highp float;\nin vec2 vP;\nuniform vec2 uC; uniform float uR; uniform float uI; uniform float uW; uniform float uT; uniform float uAmp; uniform vec3 uK;\n' + COLORI + 'out vec4 o;\nfloat h(vec3 p){ p=fract(p*0.3183099+0.1); p*=17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }\nfloat vn(vec3 x){ vec3 i=floor(x); vec3 f=fract(x); f=f*f*(3.0-2.0*f); return mix(mix(mix(h(i),h(i+vec3(1,0,0)),f.x),mix(h(i+vec3(0,1,0)),h(i+vec3(1,1,0)),f.x),f.y),mix(mix(h(i+vec3(0,0,1)),h(i+vec3(1,0,1)),f.x),mix(h(i+vec3(0,1,1)),h(i+vec3(1,1,1)),f.x),f.y),f.z); }\nuniform float uFbm;\nfloat fbm(vec3 p){ float a=0.5, s=0.0; for(int k=0;k<3;k++){ s+=a*vn(p); p*=2.03; a*=0.5; } return s; }\nuniform float uP; uniform vec2 uL; uniform float uAp;\nvoid main(){ vec2 q=(vP-uC)/uR; float r=length(q); float n=(uFbm>0.5 && r<1.15)?fbm(vec3(q*2.4,uT*0.12)):0.5; float caldo=exp(-r*r*30.0)*(0.9+0.5*uP); float cuore=exp(-r*r*5.6)*(0.34+0.8*n)*(1.0+0.25*uP); float raggi=0.0; if(uFbm>0.5 && r>0.02 && r<1.5){ vec2 d=q/r; raggi=pow(fbm(vec3(d*2.6,uT*0.05)),3.0)*exp(-r*1.7)*0.9*smoothstep(0.02,0.25,r); } float alone=exp(-r*r*0.9)*0.13*smoothstep(1.52,1.12,r); float lato=0.6+0.4*dot(q/max(r,0.001),uL); float bordo=smoothstep(1.13,1.02,r)*smoothstep(0.8,1.03,r)*0.26*lato*(1.0-uAp); vec3 base=mix(mix(uB,uK,clamp(uAmp*1.15,0.0,1.0)),uG,uGr); vec3 bianco=mix(uK,uG,uGr); vec3 col=mix(base,bianco,clamp(caldo*0.85,0.0,1.0)); vec3 c=col*uI*(cuore+alone+raggi)+bianco*uI*caldo*1.6+mix(mix(uA,uB,uW),uG,uGr)*bordo*uI; o=vec4(c,max(c.r,max(c.g,c.b))); }');
              }
              catch (e) {
                  return null;
              }
              const vao = (fn) => { const v = gl.createVertexArray(); gl.bindVertexArray(v); fn(); gl.bindVertexArray(null); return v; };
              const angolo = gl.createBuffer();
              const segVbo = gl.createBuffer();
              const ptVbo = gl.createBuffer();
              const triVbo = gl.createBuffer();
              const quadVbo = gl.createBuffer();
              const vaoL = vao(() => {
                  gl.bindBuffer(gl.ARRAY_BUFFER, angolo);
                  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, -1, 1, -1, 0, 1, 1, 1]), gl.STATIC_DRAW);
                  gl.enableVertexAttribArray(0);
                  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
                  gl.bindBuffer(gl.ARRAY_BUFFER, segVbo);
                  gl.bufferData(gl.ARRAY_BUFFER, segBuf.byteLength, gl.DYNAMIC_DRAW);
                  gl.enableVertexAttribArray(1);
                  gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 28, 0);
                  gl.vertexAttribDivisor(1, 1);
                  gl.enableVertexAttribArray(2);
                  gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 28, 16);
                  gl.vertexAttribDivisor(2, 1);
              });
              const vaoP = vao(() => {
                  gl.bindBuffer(gl.ARRAY_BUFFER, ptVbo);
                  gl.bufferData(gl.ARRAY_BUFFER, ptBuf.byteLength, gl.DYNAMIC_DRAW);
                  gl.enableVertexAttribArray(0);
                  gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 20, 0);
                  gl.enableVertexAttribArray(1);
                  gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 20, 16);
              });
              const vaoT = vao(() => {
                  gl.bindBuffer(gl.ARRAY_BUFFER, triVbo);
                  gl.bufferData(gl.ARRAY_BUFFER, Math.max(16, triBuf.byteLength), gl.DYNAMIC_DRAW);
                  gl.enableVertexAttribArray(0);
                  gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 16, 0);
              });
              const vaoG = vao(() => {
                  gl.bindBuffer(gl.ARRAY_BUFFER, quadVbo);
                  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
                  gl.enableVertexAttribArray(0);
                  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
              });
              let W = 0;
              let H = 0;
              let dpr = 1;
              let lato = 0;
              let qualita = 2;
              let posa = '';
              const dprMax = () => (qualita >= 2 ? Math.min(win.devicePixelRatio || 1, leggero ? 1.5 : 2) : 1);
              const dimensiona = (Rcss) => {
                  const nuovo = Math.ceil((Rcss || lato / 3.7 || 200) * 3.7 / 8) * 8;
                  const d = dprMax();
                  if (W && Math.abs(nuovo - lato) < lato * 0.12 && d === dpr)
                      return;
                  lato = nuovo;
                  dpr = d;
                  W = H = Math.round(lato * dpr);
                  tela.width = W;
                  tela.height = H;
                  tela.style.setProperty('--nw', lato + 'px');
              };
              const T = {
                  pronta: { an: 0, as: 0, en: 0.24, ca: 0.1, gr: 0, rot: 0.07, den: 0.72, lin: 0.5, pul: 0.3 },
                  ascolto: { an: 0, as: 1, en: 0.34, ca: 0.38, gr: 0, rot: 0.05, den: 0.86, lin: 0.66, pul: 0 },
                  trascrivo: { an: 0, as: 0.35, en: 0.38, ca: 0.32, gr: 0, rot: 0.09, den: 0.86, lin: 0.62, pul: 2.2 },
                  da_inviare: { an: 0, as: 0, en: 0.3, ca: 0.3, gr: 0, rot: 0.06, den: 0.8, lin: 0.58, pul: 0.4 },
                  inviata: { an: 1, as: 0, en: 0.42, ca: 0.22, gr: 0, rot: 0.04, den: 1, lin: 0.72, pul: 8 },
                  parla: { an: 0, as: 0, en: 0.3, ca: 0.52, gr: 0, rot: 0.11, den: 0.9, lin: 0.68, pul: 0 },
                  rifiuto: { an: 0, as: 0, en: 0.12, ca: 0, gr: 1, rot: 0.03, den: 0.55, lin: 0.42, pul: 0 }
              };
              const sm = Object.assign({}, T.pronta);
              let yaw = 0.6;
              let yaw2 = 0;
              let pit2 = 0;
              let tAn = 0;
              let ultimo = 0;
              let statoPrima = 'pronta';
              let frT0 = -1e9;
              let frForza = 0;
              let pulAcc = 0;
              let parolaPrima = -1;
              let ultimaOnda = 0;
              let fig = 0;
              const impulsi = [];
              const onde = [];
              const nuovoImpulso = (v, salti, caldo) => {
                  if (impulsi.length >= MAXI)
                      return;
                  const ed = adia[v];
                  if (!ed || !ed.length)
                      return;
                  const e = ed[Math.floor(caso() * ed.length)];
                  impulsi.push({ e, da: v, p: 0, vel: 1.5 + caso() * 1.4, salti, caldo });
              };
              const sl = (a, b, x) => { const u = lim((x - a) / (b - a)); return u * u * (3 - 2 * u); };
              const disegna = (st, t) => {
                  if (perso)
                      return false;
                  dimensiona(st.R * (st.tuffo ? 1.5 : 1));
                  if (!W)
                      return false;
                  const dt = st.subito ? 0.016 : (ultimo ? Math.min(0.05, (t - ultimo) / 1000) : 0.016);
                  ultimo = t;
                  const jv = lim(st.jv === undefined ? 1 : st.jv);
                  gl.viewport(0, 0, W, H);
                  gl.clearColor(0, 0, 0, 0);
                  gl.clear(gl.COLOR_BUFFER_BIT);
                  if (jv < 0.01)
                      return true;
                  const modo = st.rifiuto ? 'rifiuto' : (T[st.stato] ? st.stato : 'pronta');
                  const tg = T[modo];
                  const k = st.subito ? 1 : 1 - Math.exp(-dt * 3.2);
                  for (const key in tg)
                      sm[key] += (tg[key] - sm[key]) * k;
                  if (!st.subito)
                      bat = (bat + dt / Math.max(2.4, 6.4 - 2.4 * lim(sm.pul / 3) - 1.4 * sm.as)) % 1;
                  const gob = (c, w) => { let dd = Math.abs(bat - c); if (dd > 0.5)
                      dd = 1 - dd; return Math.exp(-(dd * dd) / (w * w)); };
                  const forzaB = st.subito ? 0 : (1 - sm.an) * (1 - 0.7 * sm.gr) * (st.tuffo ? 1 - st.tuffo.te : 1);
                  const bNu = gob(0.1, 0.11) * forzaB, bIn = gob(0.22, 0.1) * forzaB, bGu = gob(0.47, 0.13) * forzaB;
                  const org = st.subito ? 0 : 1 - sm.an;
                  const tf = st.tuffo || null;
                  const teT = tf ? tf.te : 0, imT = tf ? tf.im : 0, apT = tf ? tf.ap : 0;
                  if (tf) {
                      const kk = (1 - Math.exp(-dt * 9)) * teT;
                      sm.an += (0 - sm.an) * kk;
                      sm.pul += (0 - sm.pul) * kk;
                  }
                  if (imT > 0.02 && imPrima <= 0.02 && !st.subito) {
                      for (let q = 0; q < 14; q++)
                          nuovoImpulso(Math.floor(caso() * NE), 4 + Math.floor(caso() * 3), 1);
                      onde.push({ t0: t, a: 0.11 });
                  }
                  imPrima = imT;
                  const caT = Math.max(sm.ca, 0.75 * imT);
                  const crT = tf ? (tf.cr || 0) : 0;
                  if (!tf)
                      petFisso = false;
                  const coT = tf ? tf.co : 0;
                  const fren = 1 + 3 * (tf ? tf.ro : 0);
                  const colpi = tf ? tf.colpi || 0 : 0;
                  if (colpi > colpiPrima && !st.subito) {
                      onde.push({ t0: t, a: 0.09 });
                      for (let q = 0; q < 5; q++)
                          nuovoImpulso(Math.floor(caso() * NE), 4, 1);
                  }
                  colpiPrima = colpi;
                  fig += ((st.figura ? 1 : 0) - fig) * k;
                  const amp = lim(st.amp || 0);
                  const inLev = lim(st.livello || 0);
                  const conto = lim(st.conto || 0);
                  if (modo !== statoPrima) {
                      if (!st.subito) {
                          frT0 = t;
                          const ax = unisci([caso() - 0.5, caso() - 0.5, caso() - 0.5]);
                          for (let i = 0; i < NE; i++) {
                              const p = EST.V[i];
                              rit[i] = (p[0] * ax[0] + p[1] * ax[1] + p[2] * ax[2] + 1) / 2;
                          }
                          frForza = modo === 'inviata' || statoPrima === 'inviata' ? 0.24 : 0.13;
                      }
                      statoPrima = modo;
                  }
                  if (!st.subito) {
                      yaw += dt * sm.rot * (1 + 1.6 * amp) * fren;
                      yaw3 += dt * (0.27 + 0.5 * amp) * fren;
                      tpa += dt * (1 + 0.9 * lim(sm.pul / 3) + 0.6 * sm.an);
                      yaw2 -= dt * (0.13 + 0.55 * sm.an + 0.7 * amp) * fren;
                      pit2 += dt * 0.05 * fren;
                      tAn += dt * (0.25 + 0.9 * sm.an) * fren;
                  }
                  const kp1 = st.subito ? 1 : 1 - Math.exp(-dt * 2.4), kp2 = st.subito ? 1 : 1 - Math.exp(-dt * 1.3), paT = tf ? 0 : 1;
                  pax += (pmx * 0.24 * paT - pax) * kp1;
                  pay += (pmy * 0.16 * paT - pay) * kp1;
                  pbx += (pmx * 0.4 * paT - pbx) * kp2;
                  pby += (pmy * 0.28 * paT - pby) * kp2;
                  const pit = 0.3 + 0.07 * Math.sin(t * 0.00021) + pay;
                  const rol = 0.05 * Math.sin(t * 0.00017);
                  const cy0 = Math.cos(yaw + pax), sy0 = Math.sin(yaw + pax), cp = Math.cos(pit), sp = Math.sin(pit), cr = Math.cos(rol), sr = Math.sin(rol);
                  const cy2 = Math.cos(yaw2 + pbx), sy2 = Math.sin(yaw2 + pbx), cp2 = Math.cos(pit2 + pby), sp2 = Math.sin(pit2 + pby);
                  const rw = st.larghezza || tela.parentElement.clientWidth;
                  const rh = st.altezza || tela.parentElement.clientHeight;
                  const px = st.cx * rw - lato / 2;
                  const py = st.cy * rh - lato / 2;
                  const k2 = Math.round(px) + ',' + Math.round(py);
                  if (k2 !== posa) {
                      posa = k2;
                      tela.style.setProperty('--nx', Math.round(px) + 'px');
                      tela.style.setProperty('--ny', Math.round(py) + 'px');
                  }
                  const cx = W / 2 + (px - Math.round(px)) * dpr;
                  const cyy = H / 2 + (py - Math.round(py)) * dpr;
                  const R = st.R * dpr;
                  const cam = 3.4;
                  if (st.parola !== undefined && st.parola !== parolaPrima) {
                      if (st.parola > parolaPrima && modo === 'parla' && !st.subito) {
                          onde.push({ t0: t, a: 0.05 + 0.04 * amp });
                          for (let q = 0; q < 2; q++)
                              nuovoImpulso(Math.floor(caso() * NE), 3, 1);
                      }
                      parolaPrima = st.parola;
                  }
                  if (sm.as > 0.5 && !st.subito && t - ultimaOnda > 440 - 260 * inLev) {
                      onde.push({ t0: t, a: 0.03 + 0.06 * inLev });
                      ultimaOnda = t;
                  }
                  while (onde.length > 7)
                      onde.shift();
                  for (let j = onde.length - 1; j >= 0; j--)
                      if (t - onde[j].t0 > 1600)
                          onde.splice(j, 1);
                  const respiro = 0.015 * Math.sin(t * 0.00105) * (1 - sm.an);
                  const fr0 = t - frT0;
                  for (let i = 0; i < NE; i++) {
                      const p = EST.V[i];
                      let x = p[0], y = p[1], z = p[2];
                      const wa = sl(0, 1, sm.an * 1.6 - seme[i] * 0.6);
                      if (wa > 0.001) {
                          const a = (banda[i] % 2 ? 1 : -1) * tAn * 0.85 + banda[i] * 0.37;
                          const ca = Math.cos(a), sa = Math.sin(a);
                          const rx = reg[i * 3] * ca - reg[i * 3 + 2] * sa;
                          const rz = reg[i * 3] * sa + reg[i * 3 + 2] * ca;
                          x += (rx - x) * wa;
                          y += (reg[i * 3 + 1] - y) * wa;
                          z += (rz - z) * wa;
                      }
                      let fr = 0;
                      if (fr0 < 1600) {
                          const fp = fr0 / 950 - rit[i] * 0.45;
                          if (fp > 0 && fp < 1) {
                              fr = Math.sin(Math.PI * fp);
                              fr = fr * fr * frForza;
                          }
                      }
                      if (fr > 0) {
                          x = x * (1 + fr * 0.5) + fd[i * 3] * fr * 0.45;
                          y = y * (1 + fr * 0.5) + fd[i * 3 + 1] * fr * 0.45;
                          z = z * (1 + fr * 0.5) + fd[i * 3 + 2] * fr * 0.45;
                      }
                      let x1 = x * cy0 + z * sy0;
                      let z1 = -x * sy0 + z * cy0;
                      let y1 = y * cp - z1 * sp;
                      let z2 = y * sp + z1 * cp;
                      const x2 = x1 * cr - y1 * sr;
                      const y2 = x1 * sr + y1 * cr;
                      const ln = Math.hypot(x2, y2, z2) || 1;
                      const fz = z2 / ln;
                      let r = 1.06 * (1 + respiro + 0.012 * bGu) * (1 - 0.08 * coT * (1 - apT));
                      if (org > 0.01)
                          r *= 1 + org * (0.011 * Math.sin(2.3 * p[0] + 1.7 * p[1] + t * 0.00061) + 0.008 * Math.sin(3.9 * p[2] - 2.1 * p[0] - t * 0.00047));
                      if (amp > 0.002)
                          r *= 1 + amp * (0.075 * Math.sin(3.1 * p[0] + t * 0.0023) * Math.sin(2.7 * p[1] - t * 0.0017) + 0.045 * Math.sin(5.3 * p[2] + t * 0.0039));
                      if (onde.length) {
                          const th = Math.acos(lim(fz, -1, 1));
                          for (let j = 0; j < onde.length; j++) {
                              const e = t - onde[j].t0;
                              const fronte = e * 0.0022;
                              const dd = th - fronte;
                              r *= 1 + onde[j].a * Math.exp(-(dd * dd) / 0.03) * Math.exp(-e * 0.0016);
                          }
                      }
                      if (sm.as > 0.002 && fz > 0)
                          r *= 1 - sm.as * (0.1 + 0.3 * inLev) * fz * fz;
                      let vx = x2 * r, vy = y2 * r, vz = z2 * r;
                      if (tf && !petFisso) {
                          const bx = p[0] * cy0 + p[2] * sy0, bz = -p[0] * sy0 + p[2] * cy0, by = p[1] * cp - bz * sp;
                          pet[i] = Math.floor((Math.atan2(bx * sr + by * cr, bx * cr - by * sr) + Math.PI) / PET) % 6;
                      }
                      if (tf && apT > 0.001) {
                          const kq = pet[i];
                          const ac = -Math.PI + (kq + 0.5) * PET + apT * 0.22;
                          const fzz = (fz + 1) / 2;
                          const sp = apT * (0.18 + 1.25 * Math.pow(fzz, 1.5));
                          vx += Math.cos(ac) * sp;
                          vy += Math.sin(ac) * sp;
                          vz += apT * 0.28 * fzz;
                      }
                      const s = cam / (cam - vz);
                      PX[i * 4] = cx + vx * R * s;
                      PX[i * 4 + 1] = cyy + vy * R * s;
                      PX[i * 4 + 2] = vz;
                      PX[i * 4 + 3] = lim((fz + 1) / 2);
                  }
                  if (tf)
                      petFisso = true;
                  const ri = (0.5 + 0.07 * amp + 0.04 * sm.an + 0.018 * bIn) * (1 + 0.3 * apT);
                  for (let i = 0; i < NI; i++) {
                      const p = INT.V[i];
                      const x1 = p[0] * cy2 + p[2] * sy2;
                      const z1 = -p[0] * sy2 + p[2] * cy2;
                      const y1 = p[1] * cp2 - z1 * sp2;
                      const z2 = p[1] * sp2 + z1 * cp2;
                      const vx = x1 * ri, vy = y1 * ri, vz = z2 * ri;
                      const s = cam / (cam - vz);
                      PI2[i * 4] = cx + vx * R * s;
                      PI2[i * 4 + 1] = cyy + vy * R * s;
                      PI2[i * 4 + 2] = vz;
                      PI2[i * 4 + 3] = lim((z2 + 1) / 2);
                  }
                  const rn = (0.2 + 0.022 * bNu + 0.03 * amp) * (1 + 0.6 * apT);
                  const c3 = Math.cos(yaw3), s3 = Math.sin(yaw3), c4 = Math.cos(yaw3 * 0.61 + 0.8), s4 = Math.sin(yaw3 * 0.61 + 0.8);
                  for (let i = 0; i < NNU; i++) {
                      const p = NUC.V[i];
                      const x1 = p[0] * c3 + p[2] * s3, z1 = -p[0] * s3 + p[2] * c3;
                      const y1 = p[1] * c4 - z1 * s4, z2 = p[1] * s4 + z1 * c4;
                      const s = cam / (cam - z2 * rn);
                      PN[i * 4] = cx + x1 * rn * R * s;
                      PN[i * 4 + 1] = cyy + y1 * rn * R * s;
                      PN[i * 4 + 2] = z2 * rn;
                      PN[i * 4 + 3] = lim((z2 + 1) / 2);
                  }
                  if (!st.subito) {
                      pulAcc += dt * sm.pul;
                      while (pulAcc >= 1) {
                          pulAcc -= 1;
                          nuovoImpulso(Math.floor(caso() * NE), 3 + Math.floor(caso() * 5), sm.an > 0.5 ? 0.9 : 0.6);
                      }
                  }
                  acc.fill(0);
                  for (let j = impulsi.length - 1; j >= 0; j--) {
                      const q = impulsi[j];
                      if (!st.subito)
                          q.p += dt * q.vel;
                      if (q.p >= 1) {
                          const e = EST.S[q.e];
                          const arrivo = e[0] === q.da ? e[1] : e[0];
                          q.salti--;
                          if (q.salti <= 0) {
                              impulsi.splice(j, 1);
                              continue;
                          }
                          const ed = adia[arrivo];
                          let ne = ed[Math.floor(caso() * ed.length)];
                          if (ne === q.e && ed.length > 1)
                              ne = ed[(ed.indexOf(ne) + 1) % ed.length];
                          q.e = ne;
                          q.da = arrivo;
                          q.p = 0;
                      }
                      acc[q.e] = Math.max(acc[q.e], 1 - Math.abs(q.p - 0.5));
                  }
                  const lw = 1.05 * dpr;
                  let ns = 0;
                  const seg = (ax, ay, bx, by, a, w, wid) => {
                      if (a < 0.004)
                          return;
                      const o = ns * 7;
                      segBuf[o] = ax;
                      segBuf[o + 1] = ay;
                      segBuf[o + 2] = bx;
                      segBuf[o + 3] = by;
                      segBuf[o + 4] = a;
                      segBuf[o + 5] = w;
                      segBuf[o + 6] = wid;
                      ns++;
                  };
                  const linA = sm.lin * jv * (1 - 0.45 * fig);
                  for (let j = 0; j < NS; j++) {
                      const e = EST.S[j];
                      const a = e[0] * 4;
                      const b = e[1] * 4;
                      const d = (PX[a + 3] + PX[b + 3]) / 2;
                      const seamT = !!tf && pet[e[0]] !== pet[e[1]];
                      const vis = seamT && crT > 0.02 ? 1 : lim((sm.den + 0.05 * org * Math.sin(t * 0.00031 + soglia[j] * 6.2832) - soglia[j]) * 8 + 0.5);
                      const ac = acc[j];
                      if (vis <= 0 && ac <= 0)
                          continue;
                      const lung = sm.an > 0.02 ? Math.hypot(PX[b] - PX[a], PX[b + 1] - PX[a + 1]) / R : 0;
                      const corto = sm.an > 0.02 ? 1 - sm.an * (1 - lim((0.36 - lung) / 0.12)) : 1;
                      if (corto <= 0.002)
                          continue;
                      const fT = !tf ? 1 : seamT ? (1 - apT) * (1 + 5 * crT) : 1 + 1.5 * apT;
                      const occ = d < 0.5 && !tf ? 0.3 + 0.7 * sl(0.16, 0.6, Math.hypot((PX[a] + PX[b]) / 2 - cx, (PX[a + 1] + PX[b + 1]) / 2 - cyy) / R) : 1;
                      const pbj = bGu > 0.01 ? forzaB * gob(0.46 + 0.16 * soglia[j], 0.06) : 0;
                      const al = linA * (0.1 + 0.9 * Math.pow(d, 1.6)) * (vis * 0.42 + ac * 1.6 + pbj * 0.3 * vis) * corto * fT * occ;
                      seg(PX[a], PX[a + 1], PX[b], PX[b + 1], al, (seamT ? Math.max(caT, crT) : caT) + ac * 0.9 + (1 - d) * 0.28 + pbj * 0.35, lw * (0.82 + 0.36 * d) * (1 + ac * 0.6 + (seamT ? 0.8 * crT : 0)));
                  }
                  for (let j = 0; j < NSI; j++) {
                      const e = INT.S[j];
                      const a = e[0] * 4;
                      const b = e[1] * 4;
                      const d = (PI2[a + 3] + PI2[b + 3]) / 2;
                      seg(PI2[a], PI2[a + 1], PI2[b], PI2[b + 1], linA * (0.34 + 0.5 * bIn) * (0.2 + 0.8 * d) * (1 - 0.6 * apT), caT * 1.1 + 0.4 + 0.3 * bIn, lw * (0.8 + 0.3 * d));
                  }
                  for (let j = 0; j < 12; j++) {
                      const a = j * 4;
                      const d = (PI2[a + 3] + PX[a + 3]) / 2;
                      seg(PI2[a], PI2[a + 1], PX[a], PX[a + 1], linA * 0.22 * (0.2 + 0.8 * d) * (1 + sm.an) * (1 - apT), 0.3 + 0.5 * sm.an, lw);
                  }
                  for (let j = 0; j < NSN; j++) {
                      const e = NUC.S[j], a = e[0] * 4, b = e[1] * 4, d = (PN[a + 3] + PN[b + 3]) / 2;
                      seg(PN[a], PN[a + 1], PN[b], PN[b + 1], linA * (0.5 + 0.5 * bNu) * (0.3 + 0.7 * d) * (1 - 0.4 * apT), 0.85, lw * (0.8 + 0.4 * d));
                  }
                  for (let j = 0; j < NNU; j++) {
                      const a = j * 4, d = (PN[a + 3] + PI2[a + 3]) / 2;
                      seg(PN[a], PN[a + 1], PI2[a], PI2[a + 1], linA * (0.1 + 0.3 * bIn) * (0.2 + 0.8 * d) * (1 - apT), 0.7, lw * 0.8);
                  }
                  let np = 0;
                  const pt = (x, y, sz, a, w) => { if (a < 0.004)
                      return; const o = np * 5; ptBuf[o] = x; ptBuf[o + 1] = y; ptBuf[o + 2] = sz; ptBuf[o + 3] = a; ptBuf[o + 4] = w; np++; };
                  for (let i = 0; i < NE; i++) {
                      const d = PX[i * 4 + 3];
                      const nb = bGu > 0.005 && seme[i] < 0.26 ? forzaB * gob(0.5 + 0.55 * seme[i], 0.05) : 0;
                      pt(PX[i * 4], PX[i * 4 + 1], (1.4 + 2.3 * d + 2.6 * nb) * dpr, (0.1 + 0.55 * d) * linA * 0.8 * (1 + 0.5 * apT) * (1 + 2.2 * nb), caT + 0.6 * nb);
                  }
                  for (let i = 0; i < NI; i++) {
                      const d = PI2[i * 4 + 3];
                      pt(PI2[i * 4], PI2[i * 4 + 1], (1.6 + 1.6 * d) * dpr, (0.2 + 0.5 * d) * linA * 0.7, 0.3 + sm.ca);
                  }
                  for (const q of impulsi) {
                      const e = EST.S[q.e];
                      const A = q.da === e[0] ? e[0] : e[1];
                      const B = A === e[0] ? e[1] : e[0];
                      const x = PX[A * 4] + (PX[B * 4] - PX[A * 4]) * q.p;
                      const y = PX[A * 4 + 1] + (PX[B * 4 + 1] - PX[A * 4 + 1]) * q.p;
                      const d = PX[A * 4 + 3] + (PX[B * 4 + 3] - PX[A * 4 + 3]) * q.p;
                      pt(x, y, (6 + 5 * d) * dpr, (0.35 + 0.6 * d) * jv, q.caldo);
                  }
                  for (let i = 0; i < NNU; i++) {
                      const d = PN[i * 4 + 3];
                      pt(PN[i * 4], PN[i * 4 + 1], (2 + 2 * d + 1.5 * bNu) * dpr, (0.35 + 0.5 * d) * linA * (1 + 0.6 * bNu) * (1 - 0.4 * apT), 0.9);
                  }
                  const uRa = (bat - 0.2) / 0.22;
                  if (forzaB > 0.02 && uRa > 0 && uRa < 1 && apT < 0.01) {
                      const dentro = sm.pul > 1.2;
                      for (let j = 0; j < 12; j++) {
                          const a = j * 4, u = dentro ? 1 - uRa : uRa;
                          pt(PI2[a] + (PX[a] - PI2[a]) * u, PI2[a + 1] + (PX[a + 1] - PI2[a + 1]) * u, 4.5 * dpr, 0.55 * forzaB * Math.sin(Math.PI * uRa) * (0.3 + 0.7 * PX[a + 3]) * jv, 0.9);
                      }
                  }
                  {
                      const fP = (1 - 0.5 * fig) * (1 - 0.55 * apT) * (1 - 0.5 * sm.gr) * (0.55 + 0.9 * sm.lin) * jv;
                      const cpa = Math.cos(pax * 1.5), spa = Math.sin(pax * 1.5), limB = tf ? 2.6 : 1.8, camP = 6;
                      for (let i = 0; i < NPART; i++) {
                          const q = PART[i];
                          let ra = q.a, vita = 1;
                          if (q.conv) {
                              if (!st.subito) {
                                  q.v += dt * (0.07 + 0.1 * lim(sm.pul / 3) + 0.16 * sm.an);
                                  if (q.v >= 1) {
                                      q.v -= 1;
                                      q.f0 = caso() * 6.2832;
                                  }
                              }
                              ra = q.a * (1 - 0.86 * q.v * q.v);
                              vita = Math.sin(Math.PI * q.v);
                          }
                          ra *= 1 + 0.9 * apT;
                          const an = q.f0 + tpa * q.vel;
                          const X = Math.cos(an) * ra, Y = Math.sin(an) * ra * q.ci, Z = Math.sin(an) * ra * q.si;
                          const X1 = X * q.cn + Z * q.sn, Z1 = -X * q.sn + Z * q.cn;
                          const X2 = X1 * cpa + Z1 * spa, Z2 = -X1 * spa + Z1 * cpa;
                          const s = camP / (camP - Z2), prx = X2 * s, pry = Y * s, prr = Math.hypot(prx, pry);
                          const dz = lim((Z2 / 1.6 + 1) / 2);
                          const dietro = Z2 < 0 && X2 * X2 + Y * Y < 1.05 ? 0.2 : 1;
                          const luc = 0.75 + 0.25 * Math.sin(t * 0.0013 + q.f0 * 7);
                          const vic = lim(1.7 - Math.hypot(X2, Y, Z2));
                          pt(cx + prx * R, cyy + pry * R, (1.8 + q.sz + 2.4 * dz) * dpr, (0.5 + q.lu) * (0.3 + 0.7 * dz) * vita * dietro * luc * fP * (1 - sl(limB - 0.25, limB, prr)), 0.5 + 0.5 * vic);
                      }
                  }
                  let nt = 0;
                  for (let j = 0; j < (qualita >= 1 && apT < 0.2 ? FAC.length : 0); j++) {
                      const f = EST.F[FAC[j]];
                      const A = f[0] * 4, B = f[1] * 4, C = f[2] * 4;
                      const d = (PX[A + 3] + PX[B + 3] + PX[C + 3]) / 3;
                      let a = 0.012 * (1 - sm.an) + 0.05 * amp * d * d;
                      if (sm.an > 0.2 && Math.sin(t * 0.004 + facFase[j] * 40) > 0.82)
                          a += 0.07 * sm.an;
                      a *= jv * (0.3 + 0.7 * d);
                      if (a < 0.003)
                          continue;
                      [A, B, C].forEach((v) => { const o = nt * 4; triBuf[o] = PX[v]; triBuf[o + 1] = PX[v + 1]; triBuf[o + 2] = a; triBuf[o + 3] = 0.6; nt++; });
                  }
                  const cA = COL.brina.map((v) => v / 255);
                  const cB = COL.segnale.map((v) => v / 255);
                  const cG = COL.nebbia.map((v) => v / 255);
                  const U = (P, nome) => P.u[nome] || null;
                  const usa = (P) => { gl.useProgram(P.p); gl.uniform2f(U(P, 'uRes'), W, H); gl.uniform3fv(U(P, 'uA'), cA); gl.uniform3fv(U(P, 'uB'), cB); gl.uniform3fv(U(P, 'uG'), cG); gl.uniform1f(U(P, 'uGr'), sm.gr); };
                  gl.enable(gl.BLEND);
                  gl.blendFunc(gl.ONE, gl.ONE);
                  usa(PG);
                  const en = sm.en * (0.85 + 0.15 * Math.sin(t * 0.0011)) + amp * 0.85 + inLev * 0.5 * sm.as + conto * 0.22 + imT * 0.9 + apT * 0.3 + 0.07 * bNu;
                  gl.uniform2f(U(PG, 'uC'), cx, cyy);
                  gl.uniform1f(U(PG, 'uR'), R * 1.06 * (1 + 0.35 * apT) * (1 + 0.03 * bNu));
                  gl.uniform1f(U(PG, 'uI'), en * jv * (1 - 0.3 * fig));
                  gl.uniform1f(U(PG, 'uW'), caT);
                  gl.uniform1f(U(PG, 'uT'), st.subito ? 4 : t * 0.001);
                  gl.uniform1f(U(PG, 'uAmp'), Math.max(amp, 0.35 * imT));
                  gl.uniform3f(U(PG, 'uK'), 1, 236 / 255, 214 / 255);
                  gl.uniform1f(U(PG, 'uFbm'), qualita >= 1 ? 1 : 0);
                  gl.uniform1f(U(PG, 'uP'), bNu);
                  gl.uniform1f(U(PG, 'uAp'), lim(apT * 1.6));
                  gl.uniform2f(U(PG, 'uL'), Math.cos(st.subito ? 2.4 : 2.4 + t * 0.00013), Math.sin(st.subito ? 2.4 : 2.4 + t * 0.00013));
                  gl.bindVertexArray(vaoG);
                  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
                  if (nt) {
                      usa(PT);
                      gl.bindVertexArray(vaoT);
                      gl.bindBuffer(gl.ARRAY_BUFFER, triVbo);
                      gl.bufferSubData(gl.ARRAY_BUFFER, 0, triBuf, 0, nt * 4);
                      gl.drawArrays(gl.TRIANGLES, 0, nt);
                  }
                  if (ns) {
                      usa(PL);
                      gl.bindVertexArray(vaoL);
                      gl.bindBuffer(gl.ARRAY_BUFFER, segVbo);
                      gl.bufferSubData(gl.ARRAY_BUFFER, 0, segBuf, 0, ns * 7);
                      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, ns);
                  }
                  if (np) {
                      usa(PP);
                      gl.bindVertexArray(vaoP);
                      gl.bindBuffer(gl.ARRAY_BUFFER, ptVbo);
                      gl.bufferSubData(gl.ARRAY_BUFFER, 0, ptBuf, 0, np * 5);
                      gl.drawArrays(gl.POINTS, 0, np);
                  }
                  gl.bindVertexArray(null);
                  return true;
              };
              const pulisci = () => { if (perso || !W)
                  return; gl.viewport(0, 0, W, H); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); };
              return { dimensiona: () => { W = 0; dimensiona(); }, disegna, pulisci, tela, get vivo() { return !perso; }, get qualita() { return qualita; }, set qualita(q) { const v = Math.max(0, Math.min(2, q)); if (v !== qualita) {
                      qualita = v;
                      W = 0;
                  } }, info: { NE, NS, NI, leggero } };
          };
          const creaCampo = (tela) => {
              const ctx = tela && tela.getContext ? tela.getContext('2d') : null;
              let W = 0;
              let H = 0;
              let dpr = 1;
              let cw = 0;
              let chh = 0;
              let cols = 0;
              let celle = [];
              const nuova = () => (Math.random() < 0.22 ? { g: SEGNI[Math.floor(Math.random() * SEGNI.length)], a: 0.008 + Math.random() * 0.014 } : null);   // 24/11: quasi invisibile
              const figura = tela && tela.getAttribute('data-campo') === 'metodo' ? root.querySelector('[data-core="metodo"]') : null;
              let molt = null;
              const maschera = () => {
                  molt = null;
                  if (!figura || !W)
                      return;
                  const rf = figura.getBoundingClientRect();
                  const rc = tela.getBoundingClientRect();
                  if (!rf.width || !rf.height)
                      return;
                  const fx = (rf.left - rc.left + rf.width / 2) * dpr;
                  const fy = (figura.clientHeight / 2) * dpr;
                  const R = Math.min(rf.width, figura.clientHeight) * 0.29 * dpr;
                  const r0 = R * 1.9;
                  const r1 = R * 2.9;
                  molt = new Float32Array(celle.length);
                  for (let i = 0; i < celle.length; i++) {
                      const x = (i % cols) * cw + cw / 2;
                      const y = Math.floor(i / cols) * chh + chh / 2;
                      const d = Math.hypot(x - fx, y - fy);
                      const u = Math.max(0, Math.min(1, (d - r0) / (r1 - r0)));
                      molt[i] = 0.25 + 0.75 * u * u * (3 - 2 * u);
                  }
              };
              const alfaCella = (i) => (molt ? celle[i].a * molt[i] : celle[i].a);
              const font = () => { ctx.font = '400 ' + Math.round(12 * dpr) + 'px ' + fm(); fontStretta(ctx); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; };
              const cella = (i) => {
                  const x = (i % cols) * cw;
                  const y = Math.floor(i / cols) * chh;
                  ctx.fillStyle = rgba(COL.stanza, 1);
                  ctx.fillRect(x, y, cw, chh);
                  const c = celle[i];
                  if (c) {
                      ctx.fillStyle = rgba(COL.brina, alfaCella(i));
                      ctx.fillText(c.g, x + cw / 2, y + chh / 2);
                  }
              };
              const tutto = () => {
                  if (!ctx || !W)
                      return;
                  ctx.fillStyle = rgba(COL.stanza, 1);
                  ctx.fillRect(0, 0, W, H);
                  font();
                  for (let i = 0; i < celle.length; i++)
                      if (celle[i]) {
                          const x = (i % cols) * cw;
                          const y = Math.floor(i / cols) * chh;
                          ctx.fillStyle = rgba(COL.brina, alfaCella(i));
                          ctx.fillText(celle[i].g, x + cw / 2, y + chh / 2);
                      }
              };
              const dimensiona = () => {
                  if (!ctx)
                      return;
                  const w = tela.clientWidth;
                  const h = tela.clientHeight;
                  if (!w || !h)
                      return;
                  dpr = Math.min(win.devicePixelRatio || 1, 1.5);
                  W = tela.width = Math.round(w * dpr);
                  H = tela.height = Math.round(h * dpr);
                  cw = 11 * dpr;
                  chh = 19 * dpr;
                  cols = Math.ceil(W / cw);
                  const rows = Math.ceil(H / chh);
                  celle = [];
                  for (let i = 0; i < cols * rows; i++)
                      celle.push(nuova());
                  maschera();
                  tutto();
              };
              const sfarfalla = () => {
                  if (!ctx || !W || !celle.length)
                      return;
                  font();
                  for (let j = 0; j < 30; j++) {
                      const i = Math.floor(Math.random() * celle.length);
                      celle[i] = nuova();
                      cella(i);
                  }
              };
              return { dimensiona, sfarfalla, tutto, tela };
          };
          const VOC = String(PAROLE.vocabolario || '') + ' ';
          const creaCucitura = (tela, verso) => {
              const ctx = tela && tela.getContext ? tela.getContext('2d') : null;
              let W = 0;
              let H = 0;
              let dpr = 1;
              let cw = 0;
              let chh = 0;
              let cols = 0;
              let rows = 0;
              let rumore = null;
              let fisso = null;
              let tremito = null;
              let righe = [];
              let ultimaP = -1;
              let ultimoFl = -1;
              const dimensiona = () => {
                  if (!ctx)
                      return;
                  const w = tela.clientWidth;
                  const h = tela.clientHeight;
                  if (!w || !h)
                      return;
                  dpr = Math.min(win.devicePixelRatio || 1, 1.5);
                  W = tela.width = Math.round(w * dpr);
                  H = tela.height = Math.round(h * dpr);
                  cw = 10 * dpr;
                  chh = 16.5 * dpr;
                  cols = Math.ceil(W / cw);
                  rows = Math.ceil(H / chh);
                  rumore = new Float32Array(cols * rows);
                  fisso = new Float32Array(cols * rows);
                  tremito = new Float32Array(cols * rows + 4096);
                  righe = [];
                  const r0 = (() => { let s = 1234 + rows; return () => { s = (s * 16807) % 2147483647; return s / 2147483647; }; })();
                  for (let j = 0; j < rows; j++) {
                      let v = r0();
                      for (let i = 0; i < cols; i++) {
                          v += (r0() - 0.5) * 0.38;
                          if (v < 0)
                              v = -v;
                          if (v > 1)
                              v = 2 - v;
                          rumore[j * cols + i] = v * 0.8 + r0() * 0.2;
                          fisso[j * cols + i] = r0();
                      }
                      const sp = Math.floor(r0() * VOC.length);
                      righe.push(VOC.slice(sp) + VOC + VOC.slice(0, sp));
                  }
                  for (let i = 0; i < tremito.length; i++)
                      tremito[i] = r0() - 0.5;
                  ultimaP = -1;
              };
              const disegna = (p, t) => {
                  if (!ctx)
                      return;
                  if (!W)
                      dimensiona();
                  if (!W)
                      return;
                  const fl = Math.floor(t / 120);
                  if (Math.abs(p - ultimaP) < 0.0015 && fl === ultimoFl)
                      return;
                  ultimaP = p;
                  ultimoFl = fl;
                  const sopra = verso === 'giu' ? COL.carta : COL.stanza;
                  const sotto = verso === 'giu' ? COL.stanza : COL.carta;
                  const soglia = 0.78 - 0.56 * p;
                  const sposta = (fl * 977) % 4096;
                  ctx.setTransform(1, 0, 0, 1, 0, 0);
                  ctx.fillStyle = rgba(sopra, 1);
                  ctx.fillRect(0, 0, W, H);
                  ctx.fillStyle = rgba(sotto, 1);
                  const tutteD = new Float32Array(cols * rows);
                  for (let j = 0; j < rows; j++) {
                      const y = (j + 0.5) / rows;
                      let inizio = -1;
                      for (let i = 0; i < cols; i++) {
                          const idx = j * cols + i;
                          const v = y - soglia + (rumore[idx] - 0.5) * 0.36 + tremito[idx + sposta] * 0.035;
                          tutteD[idx] = v;
                          if (v >= -0.06) {
                              if (inizio < 0)
                                  inizio = i;
                          }
                          else if (inizio >= 0) {
                              ctx.fillRect(inizio * cw, j * chh, (i - inizio) * cw + 0.5, chh + 0.5);
                              inizio = -1;
                          }
                      }
                      if (inizio >= 0)
                          ctx.fillRect(inizio * cw, j * chh, (cols - inizio) * cw, chh + 0.5);
                  }
                  ctx.font = '500 ' + Math.round(11 * dpr) + 'px ' + fm();
                  fontStretta(ctx);
                  ctx.textAlign = 'center';
                  ctx.textBaseline = 'middle';
                  const cSotto = rgba(sotto, 0.9);
                  const cSopra = rgba(sopra, 0.95);
                  const cTenue = rgba(verso === 'giu' ? COL.brina : COL.inchiostro, 0.22);
                  let stileAtt = '';
                  for (let j = 0; j < rows; j++) {
                      const riga = righe[j];
                      for (let i = 0; i < cols; i++) {
                          const idx = j * cols + i;
                          const v = tutteD[idx];
                          if (v < -0.3 || v > 0.4)
                              continue;
                          const ch = riga[(i + j * 3) % riga.length];
                          if (ch === ' ')
                              continue;
                          const h2 = fisso[idx];
                          let stile = null;
                          if (v < -0.06) {
                              if (h2 < 0.3 * (1 + v / 0.3))
                                  stile = cSotto;
                          }
                          else if (v < 0.03) {
                              if (h2 < 0.88)
                                  stile = cSopra;
                          }
                          else if (h2 < 0.03 + 0.14 * (1 - lim((v - 0.03) / 0.32)))
                              stile = cTenue;
                          if (!stile)
                              continue;
                          if (stile !== stileAtt) {
                              ctx.fillStyle = stile;
                              stileAtt = stile;
                          }
                          ctx.fillText(ch, i * cw + cw / 2, j * chh + chh / 2 + dpr);
                      }
                  }
              };
              return { dimensiona, disegna, tela };
          };
          const creaOdometro = (el) => {
              if (!el)
                  return () => { };
              const colonne = Array.prototype.slice.call(el.querySelectorAll('.cifra'));
              colonne.forEach((c, i) => { c.firstElementChild.style.transitionDelay = (i * 70) + 'ms'; });
              let ultimo = null;
              return (testo) => {
                  const s = String(testo);
                  if (s === ultimo)
                      return;
                  ultimo = s;
                  const nn = colonne.length;
                  const pad = s.length >= nn ? s.slice(-nn) : ' '.repeat(nn - s.length) + s;
                  colonne.forEach((c, i) => {
                      const ch = pad[i];
                      const k = ch === '?' ? 10 : ch === ' ' ? 11 : Number(ch);
                      c.classList.toggle('vuota', ch === ' ');
                      c.firstElementChild.style.transform = 'translateY(' + (-k) + 'em)';
                  });
                  el.setAttribute('aria-label', s.trim());
              };
          };
          const q1 = (s) => root.querySelector(s);
          const qq = (s) => Array.prototype.slice.call(root.querySelectorAll(s));
          const cores = {};
          qq('[data-core]').forEach((c) => {
              const tipo = c.getAttribute('data-core');
              cores[tipo] = creaCore(c, { nome: tipo, glifi: tipo !== 'metodo', anelliDentro: tipo === 'apertura', anelli: tipo === 'metodo' ? ANELLI_PICCOLI : tipo === 'apertura' ? ANELLI_GRANDI : [], ang0: tipo === 'finale' ? 2.2 : 0.7, dprMax: tipo === 'metodo' ? 2 : 1.5 });
          });
          const campi = qq('[data-campo]').map(creaCampo);
          const cuciture = qq('[data-cucitura]').map((c) => creaCucitura(c, c.getAttribute('data-cucitura')));
          this._aggiornaColori = () => {
              const p = this.props || {};
              COL.segnale = daHex(p.segnale, [255, 122, 26]);
              COL.carta = daHex(p.carta, [242, 241, 236]);
              campi.forEach((c) => c.tutto());
          };
          this._aggiornaColori();
          const odoP = creaOdometro(q1('[data-odometro="problema"]'));
          const odoR = creaOdometro(q1('[data-odometro="risultato"]'));
          const etiP = q1('[data-odometro-eti="problema"]');
          const chipP = q1('[data-odometro-chip="problema"]');
          const apertura = q1('[data-tuffo="apertura"]');
          const fissoA = apertura ? apertura.querySelector('.tuffo-fisso') : null;
          const finale = q1('[data-tuffo="finale"]');
          const registroBox = q1('[data-registro]');
          const righe = registroBox ? [...registroBox.querySelectorAll('.registro-riga')] : [];
          const frasiPasso = qq('.frase-passo[data-righe]');   // B4: solo il registro che scorre
          const scansione = q1('.scansione');
          const passi = qq('.passo');
          const pistaPassi = q1('.passi-pista'), olPassi = q1('.passi');
          // U6 (ultimo giro 25/11): il contatore «03 / 06» si prepara una volta sola all'avvio; il movimento (contatore, barra, luce della
          // tacca) lo fanno classi e ritardi CSS quando il passo diventa attivo. Titolo e frase parola per parola: provati e tolti (nella
          // sezione i fotogrammi oltre 50 ms salivano oltre la base)
          if (!fermo && pistaPassi) {
              qq('.passi-pista .passo').forEach((p) => {
                  const nEl = p.querySelector('.passo-num');
                  const m = nEl ? /^(\d+)(.*)$/.exec(nEl.textContent) : null;
                  if (m) {
                      const k = Number(m[1]), L = m[1].length;
                      nEl.textContent = '';
                      const c = doc.createElement('span'); c.className = 'cnt'; c.setAttribute('aria-label', m[1]);
                      const st = doc.createElement('span'); st.className = 'cnt-s'; st.setAttribute('aria-hidden', 'true');
                      st.style.setProperty('--k', String(k - 1));
                      for (let q = 1; q <= k; q++) { const r = doc.createElement('span'); r.textContent = String(q).padStart(L, '0'); st.appendChild(r); }
                      c.appendChild(st); nEl.appendChild(c); nEl.appendChild(doc.createTextNode(m[2]));
                  }
              });
          }
          const metodo = q1('.metodo');
          // V5 (25/11): «Come lo misuriamo» con righe legate allo scorrimento (al posto della maschera di L3). Titolo e frase divisi in
          // righe una volta sola (e al cambio di larghezza); il ciclo scrive una sola variabile, --t (la posizione nella corsa dei passi),
          // sul contenitore: ogni riga calcola posizione e opacita' con calc() e il suo ritardo con :nth-child (design32.css). Sicurezza:
          // se nei primi due cambi un fotogramma dura in media piu' di 28 ms, si torna alla dissolvenza semplice del mattino (M6)
          const righeMov = { on: false, w: 0, tS: '', campioni: [], cambi: 0, ultimo: -1 };
          const spezzaRighe = () => {
              righeMov.w = larghezza();
              passi.forEach((p) => {
                  p.querySelectorAll('.passo-titolo, .passo-testo').forEach((el) => {
                      const testo = el.__testo || (el.__testo = el.textContent);
                      el.textContent = '';
                      const parole = [];
                      testo.split(/\s+/).filter(Boolean).forEach((w, k) => {
                          if (k) el.appendChild(doc.createTextNode(' '));
                          const sp = doc.createElement('span'); sp.textContent = w; if (/\d/.test(w)) sp.className = 'cifra';
                          el.appendChild(sp); parole.push(sp);
                      });
                      const righeT = []; let y0 = null;
                      parole.forEach((sp) => { const y = sp.offsetTop; if (y0 === null || Math.abs(y - y0) > 4) { righeT.push([]); y0 = y; } righeT[righeT.length - 1].push(sp); });
                      el.textContent = '';
                      righeT.forEach((r) => { const o = doc.createElement('span'); o.className = 'riga-p'; const d = doc.createElement('span'); d.className = 'riga-in';
                          r.forEach((sp, k) => { if (k) d.appendChild(doc.createTextNode(' ')); d.appendChild(sp); }); o.appendChild(d); el.appendChild(o); });
                  });
              });
          };
          if (!fermo && olPassi && passi.length && win.CSS && win.CSS.supports && win.CSS.supports('width', 'clamp(0px, calc(1px * 2), 3px)')) {
              root.classList.add('righe-mov');
              spezzaRighe();
              if (doc.fonts && doc.fonts.ready) doc.fonts.ready.then(() => { if (righeMov.on) spezzaRighe(); });
              passi.forEach((p) => { p.style.opacity = ''; p.style.visibility = ''; p.style.filter = ''; p.style.transform = ''; });
              righeMov.on = true;
              ascolta(win, 'resize', () => { if (righeMov.on && larghezza() !== righeMov.w) spezzaRighe(); });
              ascolta(win, 'orientationchange', () => dopo(() => { if (righeMov.on) spezzaRighe(); }, 250));      // P4: anche alla rotazione
          }
          const risSez = q1('.risultato');
          const foglioEl = q1('#due-campioni');
          let pFoglio = '', foglioSu = false, lineaFoglio = null;
          if (foglioEl && !fermo) {          // G1: la linea tratteggiata e' il bordo alto del foglio e si disegna con lo scorrimento
              lineaFoglio = doc.createElement('span');
              lineaFoglio.className = 'foglio-linea';
              lineaFoglio.setAttribute('aria-hidden', 'true');
              foglioEl.insertBefore(lineaFoglio, foglioEl.firstChild);
          }
          const celleP = qq('.paz');
          const videoSez = q1('.video-sez');
          const pista = q1('[data-video-pista]');
          const portale = q1('[data-portale]');
          const videoHud = q1('[data-video-hud]');
          const video = q1('[data-video]');
          this._video = video;
          const chiedi = q1('[data-chiedi]');
          const chiediPiu = chiedi ? chiedi.querySelector('.chiedi-piu') : null;
          const daNonCoprire = qq('.registro-riga, .registro-coda, .registro-gruppo, .registro-testa, .corpo, .lead, .passo, .contatore-piede, .ris-numeri, .legenda, .nota-sintetico, .video-testa, .finale-testo, .piede-griglia');
          let chiediT = 0;
          let chiediSotto = false;
          const chiediCopre = (t) => {
              if (!chiediPiu || !daNonCoprire.length)
                  return false;
              if (t - chiediT < 150)
                  return chiediSotto;
              chiediT = t;
              const c = chiediPiu.getBoundingClientRect();
              chiediSotto = daNonCoprire.some((el) => { const r = el.getBoundingClientRect(); return !(r.right <= c.left - 4 || r.left >= c.right + 4 || r.bottom <= c.top - 4 || r.top >= c.bottom + 4); });
              return chiediSotto;
          };
          const navG = q1('.nav-guscio');
          const sezioni = qq('[data-sezione]');
          const voci = qq('[data-vai]');
          let offRighe = [];
          let offPassi = [];
          let limBasso = 0;
          let cyVideo = 50;
          let vtPx = 64;
          let vbPx = 150;
          const comandiEl = q1('.comandi');
          const stageF = finale ? finale.querySelector('.tuffo-fisso') : null;
          const misura = () => {
              if (comandiEl && stageF)
                  limBasso = comandiEl.getBoundingClientRect().top - stageF.getBoundingClientRect().top;
              if (zonaEl && stanzaEl) {
                  const z = zonaEl.getBoundingClientRect(), s = stanzaEl.getBoundingClientRect();
                  zonaR = z.width > 0 && s.width > 0 ? { x: z.left - s.left, w: z.width, sw: s.width } : null;
              }
              if (videoSez) {
                  const cs = win.getComputedStyle(videoSez);
                  vtPx = parseFloat(cs.getPropertyValue('--vt')) || 64;
                  vbPx = parseFloat(cs.getPropertyValue('--vb')) || 150;
                  const Hs = statico ? 900 : altezza();
                  cyVideo = lim(((vtPx + Hs - vbPx) / 2 / Hs) * 100, 30, 70);
              }
              if (registroBox) {
                  const b = registroBox.getBoundingClientRect().top;
                  offRighe = righe.map((r) => r.getBoundingClientRect().top - b);
              }
              if (metodo) {
                  const m = metodo.getBoundingClientRect().top;
                  offPassi = passi.map((p) => p.getBoundingClientRect().top - m);
              }
          };
          let rigaAtt = -2;
          const segnaRiga = (k) => {
              if (k === rigaAtt)
                  return;
              rigaAtt = k;
              righe.forEach((r, i) => r.classList.toggle('attiva', i === k));
              // B8 (24/11): la frase del paragrafo del problema che parla della riga accesa
              frasiPasso.forEach((f) => f.classList.toggle('accesa', k >= 0 && (' ' + f.getAttribute('data-righe') + ' ').indexOf(' ' + k + ' ') >= 0));
              const r = righe[Math.max(0, k)];
              if (!r)
                  return;
              odoP(r.getAttribute('data-valore'));
              if (etiP) {
                  etiP.setAttribute('data-testo', r.getAttribute('data-eti'));
                  if (fermo)
                      etiP.textContent = r.getAttribute('data-eti');
                  else
                      mescola(etiP);
              }
              if (chipP)
                  chipP.textContent = r.getAttribute('data-chip') || 'Dato';
          };
          segnaRiga(-1);
          let visti = -1;
          const segnaPazienti = (v) => {
              if (v === visti)
                  return;
              visti = v;
              let ev = 0;
              celleP.forEach((c, i) => {
                  const on = i < v;
                  c.classList.toggle('visto', on);
                  if (on && c.getAttribute('data-ev') === '1')
                      ev++;
              });
              odoR(String(ev));
              if (risSez) {
                  risSez.classList.toggle('completo', v >= celleP.length);
                  if (v >= celleP.length && root.__contaSu)       // U7: il 34% conta quando il risultato compare
                      root.__contaSu(q1('.esito .grande'));
              }
          };
          let utentePausa = false;
          let avviato = false;
          let viaggioFino = 0;
          const tempo = q1('[data-tempo]');
          const durata = q1('span[data-durata]');
          const capitolo = q1('[data-capitolo]');
          const attoOra = q1('[data-atto-ora]');
          const righelloV = q1('[data-righello]');
          const tacche = qq('.tacca');
          const atti = qq('.atti span');
          const tPlayTesto = q1('[data-play-testo]');
          const mmss = (s) => { if (!isFinite(s) || s < 0)
              return '--:--'; const m = Math.floor(s / 60); const r = Math.floor(s % 60); return m + ':' + String(r).padStart(2, '0'); };
          const posizionaScene = (d) => {
              if (!isFinite(d) || d <= 0)
                  return;
              tacche.forEach((tc) => { tc.style.left = (Number(tc.getAttribute('data-t')) / d * 100).toFixed(2) + '%'; });
              atti.forEach((a) => { const f = Number(a.getAttribute('data-t')) / d; a.style.left = (f * 100).toFixed(2) + '%'; a.classList.toggle('fine', f > 0.86); });
          };
          const durataMeta = Number(righelloV ? righelloV.getAttribute('data-durata') : NaN);
          posizionaScene(durataMeta);
          if (durata && isFinite(durataMeta))
              durata.textContent = mmss(durataMeta);
          let capAtt = -1;
          const aggiornaVideo = () => {
              if (!video)
                  return;
              const d = isFinite(video.duration) && video.duration > 0 ? video.duration : durataMeta;
              const c = video.currentTime || 0;
              if (tempo)
                  tempo.textContent = mmss(c) + ' / ' + mmss(d);
              if (righelloV && isFinite(d) && d > 0)
                  righelloV.style.setProperty('--pv', ((c / d) * 100).toFixed(2) + '%');
              let k = 0;
              for (let i = 0; i < tacche.length; i++)
                  if (Number(tacche[i].getAttribute('data-t')) <= c + 0.05)
                      k = i;
              if (k !== capAtt) {
                  capAtt = k;
                  tacche.forEach((tc, i) => tc.classList.toggle('attiva', i === k));
                  const tk = tacche[k];
                  if (tk) {
                      if (capitolo) {
                          capitolo.setAttribute('data-testo', tk.getAttribute('data-nome'));
                          mescola(capitolo, 30);
                      }
                      const at = tk.getAttribute('data-atto');
                      if (attoOra && attoOra.getAttribute('data-testo') !== at) {
                          attoOra.setAttribute('data-testo', at);
                          mescola(attoOra, 30);
                      }
                      atti.forEach((a) => a.classList.toggle('attivo', a.textContent === at));
                  }
              }
          };
          const statoPlay = () => { if (video && tPlayTesto)
              tPlayTesto.textContent = (!video.paused && !video.ended ? PV.pausa : PV.riproduci) || ''; };
          // N4.4 (notte 25/11): su telefono il video non parte da solo; si scarica solo l'inizio (preload="metadata") fino al tocco
          const videoTelefono = !!(win.matchMedia && (win.matchMedia('(max-width: 599px)').matches || win.matchMedia('(pointer: coarse) and (max-height: 500px)').matches));
          if (video) {
              if (statico)
                  video.preload = 'none';
              if (videoTelefono && tPlayTesto)
                  tPlayTesto.textContent = PV.riproduci || tPlayTesto.textContent;
              ascolta(video, 'timeupdate', aggiornaVideo);
              ascolta(video, 'loadedmetadata', () => {
                  if (durata && isFinite(video.duration))
                      durata.textContent = mmss(video.duration);
                  posizionaScene(video.duration);
                  capAtt = -1;
                  aggiornaVideo();
              });
              ascolta(video, 'play', statoPlay);
              ascolta(video, 'pause', statoPlay);
              ascolta(video, 'ended', statoPlay);
          }
          const hudEl = q1('[data-hud]');
          const statoEl = q1('[data-stato-core]');
          const orologio = q1('[data-orologio]');
          const notaCore = q1('[data-nota-core]');
          const annuncio = q1('[data-annuncio]');
          const inputCore = q1('#domanda-core');
          const formCore = q1('[data-form-core]');
          const elencoEl = q1('[data-elenco]');
          const elencoApri = q1('[data-elenco-apri]');
          const esempioBtn = q1('[data-esempio]');
          const esempioTesto = q1('[data-esempio-testo]');
          const tastoVoce = q1('[data-voce-toggle]');
          const voceEti = q1('[data-voce-eti]');
          const voceEl = q1('[data-voce-vera]');
          // M4 (mattino 25/11): la voce e' accesa per impostazione predefinita, spenta solo se la persona l'ha spenta (ricordato in
          // ncb.voce.on); il tasto dice subito «Voce accesa», e «Attiva la voce» compare solo dopo averla spenta
          const PREF_VOCE = 'ncb.voce.on';
          let voceSpentaPrima = false;
          try {
              voceSpentaPrima = win.localStorage.getItem(PREF_VOCE) === '0';
          }
          catch (e) { }
          const tastoVoce0 = q1('[data-voce-toggle]');
          if (tastoVoce0)
              tastoVoce0.setAttribute('aria-pressed', voceSpentaPrima ? 'false' : 'true');
          if (voceEti)
              voceEti.textContent = String((PC.voce || {})[voceSpentaPrima ? 'attiva' : 'accesa'] || voceEti.textContent);
          this._voce = voceEl;
          const modVoce = q1('[data-mod-voce]');
          const modAscolto = q1('[data-mod-ascolto]');
          const modCatalogo = q1('[data-mod-catalogo]');
          const percorso = q1('[data-percorso]');
          const telaFinale = cores.finale ? cores.finale.tela : null;
          const stanzaEl = finale ? finale.querySelector('.stanza-core') : null;
          const zonaEl = q1('[data-sfera-zona]'), fusEl = q1('[data-nc-fusione]'), luceEl = q1('[data-nc-luce]'), lampoEl = q1('[data-nc-lampo]');
          let zonaR = null;
          const NODI = ['domanda', 'presa', 'fonte', 'risposta', 'esito'];
          const nodo = {};
          NODI.forEach((k) => { nodo[k] = q1('[data-nodo="' + k + '"]'); });
          const nT = { domanda: q1('[data-n-domanda]'), via: q1('[data-n-via]'), presa: q1('[data-n-presa]'), fonte: q1('[data-n-fonte]'), tipofonte: q1('[data-n-tipofonte]'), impronta: q1('[data-n-impronta]'), etirisposta: q1('[data-n-etirisposta]'), risposta: q1('[data-n-risposta]'), esito: q1('[data-n-esito]'), tipo: q1('[data-n-tipo]') };
          const avvisoEl = q1('[data-avviso]');
          const avvisoTesto = q1('[data-avviso-testo]');
          const contoBarra = q1('[data-conto-barra]');
          const contoTesto = q1('[data-conto-testo]');
          const suggG = q1('[data-sugg-guscio]');
          const suggR = q1('.suggerimenti');
          const scenaEl = q1('[data-scena]');
          const aloneEl = q1('[data-alone]');
          const creaAlone = () => {
              // L2 (25/11): solo con il mouse e senza movimento ridotto; altrimenti l'elemento non c'e' proprio
              if (!aloneEl || ridotto || !win.matchMedia || !win.matchMedia('(hover: hover) and (pointer: fine)').matches) {
                  if (aloneEl)
                      aloneEl.remove();
                  return null;
              }
              const strati = Array.prototype.slice.call(aloneEl.children);
              let x = -999, y = -999, tx = -999, ty = -999;
              let visto = false;
              let scuro = 0, scuroT = 0, comando = 0, comandoT = 0, premuto = 0, video = 0, videoT = 0;
              let ultimoCampione = 0;
              let ultimaChiave = '';
              let attivo = true;
              const cache = new WeakMap();
              const lum = (c) => {
                  const m = /rgba?\(([^)]+)\)/.exec(c || '');
                  if (!m)
                      return null;
                  const v = m[1].split(',').map(parseFloat);
                  if ((v.length > 3 ? v[3] : 1) < 0.4)
                      return null;
                  const f = (u) => { u /= 255; return u <= 0.03928 ? u / 12.92 : Math.pow((u + 0.055) / 1.055, 2.4); };
                  return 0.2126 * f(v[0]) + 0.7152 * f(v[1]) + 0.0722 * f(v[2]);
              };
              const campiona = () => {
                  const els = doc.elementsFromPoint ? doc.elementsFromPoint(tx, ty) : [];
                  let l = null;
                  videoT = 0;
                  for (const el of els) {
                      if (aloneEl.contains(el))
                          continue;
                      if (el.tagName === 'VIDEO') {
                          l = 0.01;
                          videoT = 1;
                          break;
                      }
                      if (el.tagName === 'CANVAS') {
                          if (el.closest('.stanza-core, .stanza, .tuffo-scuro, .portale')) {
                              l = 0.01;
                              break;
                          }
                          continue;
                      }
                      let v = cache.get(el);
                      if (v === undefined) {
                          v = lum(win.getComputedStyle(el).backgroundColor);
                          cache.set(el, v);
                      }
                      if (v !== null) {
                          l = v;
                          break;
                      }
                  }
                  scuroT = (l === null ? 0.85 : l) < 0.25 ? 1 : 0;
              };
              ascolta(root, 'pointermove', (e) => { if (e.pointerType === 'touch') {
                  visto = false;
                  return;
              } tx = e.clientX; ty = e.clientY; if (!visto) {
                  x = tx;
                  y = ty;
                  visto = true;
                  ultimoCampione = 0;
              } }, { passive: true });
              ascolta(root, 'pointerleave', () => { visto = false; });
              ascolta(root, 'pointerover', (e) => { const c = e.target && e.target.closest ? e.target.closest('a, button, input, [role="button"], .tacca, .sugg') : null; comandoT = c ? 1 : 0; });
              ascolta(root, 'pointerdown', (e) => { if (e.pointerType !== 'touch')
                  premuto = 1; });
              return {
                  set attivo(v) { attivo = !!v; if (!attivo)
                      aloneEl.classList.remove('on'); },
                  passo(dt, t) {
                      if (!attivo)
                          return;
                      if (visto && t - ultimoCampione > 110) {
                          ultimoCampione = t;
                          campiona();
                      }
                      if (ridotto) {
                          x = tx;
                          y = ty;
                      }
                      else {
                          const k = 1 - Math.exp(-dt * 17);
                          x += (tx - x) * k;
                          y += (ty - y) * k;
                      }
                      scuro += (scuroT - scuro) * (1 - Math.exp(-dt * 7));
                      comando += (comandoT - comando) * (1 - Math.exp(-dt * 10));
                      video += (videoT - video) * (1 - Math.exp(-dt * 6));
                      premuto *= Math.exp(-dt * 9);
                      aloneEl.classList.toggle('on', visto);
                      const sc = (1 - 0.42 * comando - 0.12 * premuto).toFixed(3);
                      const forza = ((1 + 0.55 * comando + 0.4 * premuto) * (1 - 0.6 * video)).toFixed(3);
                      const chiave = x.toFixed(1) + y.toFixed(1) + sc + forza + scuro.toFixed(3);
                      if (chiave === ultimaChiave)
                          return;
                      ultimaChiave = chiave;
                      for (const s of strati) {
                          s.style.setProperty('--ax', x.toFixed(1) + 'px');
                          s.style.setProperty('--ay', y.toFixed(1) + 'px');
                          s.style.setProperty('--as', sc);
                          s.style.setProperty('--af', forza);
                          s.style.setProperty('--asc', scuro.toFixed(3));
                      }
                  }
              };
          };
          // B10 (24/11): il suono dell'ambiente del prototipo 32, generato dal vivo con Web Audio (oscillatori e rumore filtrato),
          // nessun file. Spento fino al gesto di chi guarda (il tasto nella barra); si abbassa quando parla la voce dell'assistente.
          const creaSuono = (prendiCtx) => {
              let ctx = null;
              let n = null;
              let acceso = false;
              let vol = 0.6;
              let voce = false;
              let presenza = 0;
              let stato = 'pronta';
              let livIn = 0;
              let timerDeriva = 0;
              let timerElab = 0;
              let ultimoPassa = 0;
              let nascosto = false;
              const RE2 = 73.4162;
              // N1.5 (notte 25/11): i livelli del suono, tarati con la misura sull'uscita (livelli32.mjs)
              const SUONO_K = 0.029 * 6.6, SUONO_ARIA = 0.16, SUONO_UI = 0.55 * 2.4, SUONO_CLIC = 0.2;
              // M3 (mattino 25/11): tutto piu' basso, stesso timbro (un solo fattore sull'uscita): ambiente tra -38 e -34 dBFS RMS, clic 0,06-0,10
              const SUONO_GIU = 0.4;
              // V6 (25/11): livelli del tuffo e del pensiero (picco del tuffo sull'uscita tra 0,08 e 0,14, misurato con suonotuffo32.mjs)
              const V6_SOFFIO = 0.81, V6_BASSA = 0.32, V6_CODA = 0.08, V6_PENSA = 0.012;
              let ultimoPensa = 0, tuffoFino = 0;
              const hz = (semi) => RE2 * Math.pow(2, semi / 12);
              const ora = () => (ctx ? ctx.currentTime : 0);
              const verso = (p, v, t0, tau) => { try {
                  p.cancelScheduledValues(t0);
                  p.setTargetAtTime(v, t0, tau);
              }
              catch (e) { } };
              const rosa = (sec) => {
                  const sr = ctx.sampleRate;
                  const L = Math.floor(sr * 0.08);
                  const nn = Math.floor(sr * sec);
                  const b = ctx.createBuffer(2, nn, sr);
                  for (let c = 0; c < 2; c++) {
                      const tmp = new Float32Array(nn + L);
                      let b0 = 0, b1 = 0, b2 = 0;
                      for (let i = 0; i < nn + L; i++) {
                          const w = Math.random() * 2 - 1;
                          b0 = 0.99765 * b0 + w * 0.099046;
                          b1 = 0.963 * b1 + w * 0.2965164;
                          b2 = 0.57 * b2 + w * 1.0526913;
                          tmp[i] = (b0 + b1 + b2 + w * 0.1848) * 0.11;
                      }
                      const d = b.getChannelData(c);
                      for (let i = 0; i < nn; i++)
                          d[i] = tmp[i];
                      for (let i = 0; i < L; i++) {
                          const x = i / L;
                          d[i] = tmp[i] * x + tmp[nn + i] * (1 - x);
                      }
                  }
                  return b;
              };
              const impulso = (sec) => {
                  const sr = ctx.sampleRate;
                  const nn = Math.floor(sr * sec);
                  const b = ctx.createBuffer(2, nn, sr);
                  for (let c = 0; c < 2; c++) {
                      const d = b.getChannelData(c);
                      let lp = 0;
                      for (let i = 0; i < nn; i++) {
                          const x = i / nn;
                          const a = 0.9 - 0.78 * x;
                          lp += (Math.random() * 2 - 1 - lp) * a;
                          const t = i / sr;
                          d[i] = lp * Math.pow(1 - x, 2.4) * Math.exp(-t * 1.4) * (t < 0.012 ? t / 0.012 : 1) * 0.5;
                      }
                  }
                  return b;
              };
              const costruisci = () => {
                  ctx = prendiCtx();
                  if (!ctx)
                      return false;
                  const t = ctx.currentTime;
                  n = { osc: [], parz: [], rumori: [] };
                  n.master = ctx.createGain();
                  n.master.gain.value = 0;
                  n.comp = ctx.createDynamicsCompressor();
                  n.comp.threshold.value = -20;
                  n.comp.knee.value = 14;
                  n.comp.ratio.value = 3;
                  n.comp.attack.value = 0.006;
                  n.comp.release.value = 0.28;
                  n.master.connect(n.comp);
                  n.comp.connect(ctx.destination);
                  n.rev = ctx.createConvolver();
                  n.rev.buffer = impulso(2.6);
                  n.revOut = ctx.createGain();
                  n.revOut.gain.value = 0.5;
                  n.rev.connect(n.revOut);
                  n.revOut.connect(n.master);
                  n.amb = ctx.createGain();
                  n.amb.gain.value = 1;
                  n.ambF = ctx.createBiquadFilter();
                  n.ambF.type = 'lowpass';
                  n.ambF.frequency.value = 1800;
                  n.ambF.Q.value = 0.5;
                  n.ambD = ctx.createGain();
                  n.ambD.gain.value = 1;
                  n.amb.connect(n.ambF);
                  n.ambF.connect(n.ambD);
                  n.ambD.connect(n.master);
                  n.ambR = ctx.createGain();
                  n.ambR.gain.value = 0.16;
                  n.ambD.connect(n.ambR);
                  n.ambR.connect(n.rev);
                  // N1.5 (notte 25/11): l'accordo un'ottava sopra (Re3 … La5) e piu' forte, perche' sugli altoparlanti di telefono e iPad
                  // si senta: a volume predefinito l'ambiente sta tra -30 e -24 dBFS RMS, con l'energia tra 200 e 1200 Hz almeno pari a
                  // quella sotto 150 Hz (misura: web/test/js/livelli32.mjs). Prima: Re2 … La4, -42 dBFS, quasi tutto sotto 150 Hz
                  const P = [[12, 0.45, -0.28], [19, 0.6, 0.24], [24, 0.55, -0.12], [28, 0.34, 0.33], [31, 0.34, -0.36], [38, 0.17, 0.18], [43, 0.09, -0.05]];
                  const K = SUONO_K;
                  P.forEach((p, i) => {
                      const g = ctx.createGain();
                      g.gain.value = p[1] * K * 0.8;
                      const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
                      if (pan) {
                          pan.pan.value = p[2];
                          g.connect(pan);
                          pan.connect(n.amb);
                      }
                      else
                          g.connect(n.amb);
                      const coppia = [-3, 3].map((cents, j) => {
                          const o = ctx.createOscillator();
                          o.type = 'sine';
                          o.frequency.value = hz(p[0]);
                          o.detune.value = cents + (Math.random() - 0.5) * 2;
                          const go = ctx.createGain();
                          go.gain.value = j ? 0.3 : 0.7;
                          o.connect(go);
                          go.connect(g);
                          o.start(t);
                          n.osc.push(o);
                          return o;
                      });
                      n.parz.push({ g, pan, a: p[1] * K, p0: p[2], semi: p[0], coppia });
                  });
                  n.ariaF = ctx.createBiquadFilter();
                  n.ariaF.type = 'bandpass';
                  n.ariaF.frequency.value = 520;
                  n.ariaF.Q.value = 0.8;
                  n.ariaG = ctx.createGain();
                  n.ariaG.gain.value = SUONO_ARIA;
                  n.ariaF.connect(n.ariaG);
                  n.ariaG.connect(n.amb);
                  [7.3, 11.9].forEach((s, i) => {
                      const src = ctx.createBufferSource();
                      src.buffer = rosa(s);
                      src.loop = true;
                      src.playbackRate.value = i ? 0.97 : 1;
                      src.connect(n.ariaF);
                      src.start(t, Math.random() * s);
                      n.rumori.push(src);
                  });
                  n.core = ctx.createGain();
                  n.core.gain.value = 0;
                  n.coreD = ctx.createGain();
                  n.coreD.gain.value = 1;
                  n.coreF = ctx.createBiquadFilter();
                  n.coreF.type = 'lowpass';
                  n.coreF.frequency.value = 2400;
                  n.coreF.Q.value = 0.4;
                  n.core.connect(n.coreF);
                  n.coreF.connect(n.coreD);
                  n.coreD.connect(n.master);
                  n.coreR = ctx.createGain();
                  n.coreR.gain.value = 0.35;
                  n.coreD.connect(n.coreR);
                  n.coreR.connect(n.rev);
                  [[36, 0.13, 1], [43, 0.19, 0.7], [50, 0.29, 0.38]].forEach((f) => {
                      const o = ctx.createOscillator();
                      o.type = 'sine';
                      o.frequency.value = hz(f[0]);
                      const g = ctx.createGain();
                      g.gain.value = f[2] * 0.6;
                      const lfo = ctx.createOscillator();
                      lfo.frequency.value = f[1];
                      const lg = ctx.createGain();
                      lg.gain.value = f[2] * 0.35;
                      lfo.connect(lg);
                      lg.connect(g.gain);
                      o.connect(g);
                      g.connect(n.core);
                      o.start(t);
                      lfo.start(t);
                      n.osc.push(o, lfo);
                  });
                  n.lucF = ctx.createBiquadFilter();
                  n.lucF.type = 'bandpass';
                  n.lucF.frequency.value = 3600;
                  n.lucF.Q.value = 1.6;
                  n.lucG = ctx.createGain();
                  n.lucG.gain.value = 0;
                  n.lucF.connect(n.lucG);
                  n.lucG.connect(n.coreD);
                  const lsrc = ctx.createBufferSource();
                  lsrc.buffer = rosa(5.1);
                  lsrc.loop = true;
                  lsrc.connect(n.lucF);
                  lsrc.start(t, Math.random() * 5);
                  n.rumori.push(lsrc);
                  n.ui = ctx.createGain();
                  n.ui.gain.value = SUONO_UI;
                  n.ui.connect(n.master);
                  n.uiR = ctx.createGain();
                  n.uiR.gain.value = 0.22;
                  n.ui.connect(n.uiR);
                  n.uiR.connect(n.rev);
                  n.tick = rosa(0.4);
                  deriva(t + 12);
                  return true;
              };
              let derivaFino = 0;
              const deriva = (fino) => {
                  if (!n)
                      return;
                  let t = Math.max(derivaFino, ora());
                  while (t < fino) {
                      n.parz.forEach((p) => {
                          const tau = 2.5 + Math.random() * 6.5;
                          try {
                              p.g.gain.setTargetAtTime(p.a * (0.5 + 0.5 * Math.random()), t, tau);
                          }
                          catch (e) { }
                          if (p.pan) {
                              try {
                                  p.pan.pan.setTargetAtTime(Math.max(-1, Math.min(1, p.p0 + (Math.random() - 0.5) * 0.18)), t, 7);
                              }
                              catch (e) { }
                          }
                          p.coppia.forEach((o, j) => { try {
                              o.detune.setTargetAtTime((j ? 1 : -1) * (1 + Math.random() * 5), t, 5 + Math.random() * 6);
                          }
                          catch (e) { } });
                      });
                      try {
                          n.ariaF.frequency.setTargetAtTime(300 + Math.random() * 600, t, 5);
                          n.ariaG.gain.setTargetAtTime(0.03 + Math.random() * 0.04, t, 6);
                      }
                      catch (e) { }
                      t += 1.7 + Math.random() * 1.6;
                  }
                  derivaFino = t;
              };
              const livelloMaster = () => (acceso && !nascosto ? vol * vol * SUONO_GIU : 0);
              const livelloCore = () => {
                  const base = { pronta: 0.55, ascolto: 0.8, trascrivo: 0.7, da_inviare: 0.7, inviata: 0.85, parla: 0.6 }[stato] || 0.55;
                  return 0.011 * presenza * base;
              };
              const aggiornaCore = () => {
                  if (!n)
                      return;
                  const t = ora();
                  verso(n.core.gain, livelloCore(), t, 0.5);
                  verso(n.coreF.frequency, stato === 'inviata' ? 3600 : stato === 'ascolto' ? 3000 : 2200, t, 0.4);
              };
              const tono = (f, tipo, dur, v, t, pan, att) => {
                  const o = ctx.createOscillator();
                  o.type = tipo;
                  o.frequency.value = f;
                  const g = ctx.createGain();
                  g.gain.value = 0.0001;
                  const a = att || 0.0007;
                  g.gain.setValueAtTime(0.0001, t);
                  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, v), t + a);
                  g.gain.exponentialRampToValueAtTime(0.0001, t + a + dur);
                  let out = g;
                  if (pan && ctx.createStereoPanner) {
                      const p = ctx.createStereoPanner();
                      p.pan.value = pan;
                      g.connect(p);
                      out = p;
                  }
                  o.connect(g);
                  out.connect(n.ui);
                  o.start(t);
                  o.stop(t + a + dur + 0.03);
              };
              const soffio = (f0, f1, dur, v, t) => {
                  const s = ctx.createBufferSource();
                  s.buffer = n.tick;
                  s.loop = true;
                  const f = ctx.createBiquadFilter();
                  f.type = 'bandpass';
                  f.Q.value = 1.3;
                  f.frequency.setValueAtTime(f0, t);
                  f.frequency.exponentialRampToValueAtTime(f1, t + dur);
                  const g = ctx.createGain();
                  g.gain.setValueAtTime(0.0001, t);
                  g.gain.exponentialRampToValueAtTime(v, t + dur * 0.45);
                  g.gain.exponentialRampToValueAtTime(0.0001, t + dur * 1.35);
                  s.connect(f);
                  f.connect(g);
                  g.connect(n.ui);
                  s.start(t);
                  s.stop(t + dur * 1.4 + 0.05);
              };
              const scatto = (t, v) => {
                  const s = ctx.createBufferSource();
                  s.buffer = n.tick;
                  const f = ctx.createBiquadFilter();
                  f.type = 'bandpass';
                  f.frequency.value = 3200;
                  f.Q.value = 1.1;
                  const g = ctx.createGain();
                  g.gain.setValueAtTime(0.0001, t);
                  g.gain.exponentialRampToValueAtTime(v, t + 0.0006);
                  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.005);
                  s.connect(f);
                  f.connect(g);
                  g.connect(n.ui);
                  s.start(t, Math.random() * 0.3);
                  s.stop(t + 0.03);
              };
              const EV = {
                  // N1.5: il clic un'ottava sotto (1,2-2,3 kHz) e piu' forte: picco tra 0,15 e 0,30 (mai oltre 0,9)
                  clic: (t) => { tono(hz(48), 'triangle', 0.02, SUONO_CLIC, t); tono(hz(55), 'sine', 0.014, SUONO_CLIC * 0.7, t); tono(hz(60), 'sine', 0.009, SUONO_CLIC * 0.45, t); scatto(t, 0.012); },
                  passa: (t) => { tono(hz(55), 'sine', 0.008, SUONO_CLIC * 0.4, t); tono(hz(60), 'sine', 0.006, SUONO_CLIC * 0.25, t); },
                  attiva: (t) => { tono(hz(48), 'sine', 0.42, 0.03, t, -0.2, 0.004); tono(hz(55), 'sine', 0.5, 0.026, t + 0.07, 0.2, 0.004); },
                  disattiva: (t) => { tono(hz(55), 'sine', 0.36, 0.024, t, 0.2, 0.004); tono(hz(48), 'sine', 0.42, 0.022, t + 0.07, -0.2, 0.004); },
                  annulla: (t) => { tono(hz(60), 'sine', 0.03, 0.022, t); tono(hz(55), 'sine', 0.05, 0.02, t + 0.04); },
                  apertura: (t) => { soffio(260, 1700, 0.7, 0.05, t); tono(hz(24), 'sine', 1.1, 0.012, t + 0.05, -0.1, 0.25); tono(hz(31), 'sine', 1.1, 0.009, t + 0.12, 0.1, 0.25); },
                  chiusura: (t) => { soffio(1600, 260, 0.55, 0.09, t); },
                  verificato: (t) => { [36, 40, 43].forEach((s, i) => tono(hz(s), 'sine', 1.1, 0.016, t + i * 0.035, (i - 1) * 0.25, 0.006)); },
                  rifiuto: (t) => { tono(hz(19), 'triangle', 0.7, 0.02, t, -0.1, 0.01); tono(hz(12), 'triangle', 0.8, 0.018, t + 0.05, 0.1, 0.01); },
                  core_on: (t) => { [36, 43].forEach((s, i) => tono(hz(s), 'sine', 1.4, 0.014, t + i * 0.09, (i ? 0.25 : -0.25), 0.12)); },
                  core_off: (t) => { [43, 36].forEach((s, i) => tono(hz(s), 'sine', 0.9, 0.01, t + i * 0.08, (i ? -0.25 : 0.25), 0.06)); },
                  ascolta: (t) => { tono(hz(55), 'sine', 0.12, 0.02, t, -0.15, 0.003); tono(hz(62), 'sine', 0.16, 0.017, t + 0.055, 0.15, 0.003); },
                  // V6 (25/11): il tuffo verso la pagina della risposta, circa 1,2 s: soffio filtrato che sale, nota bassa che scende, coda
                  // luminosa. Su un suo livello (tuffoG), che la voce di VERA abbassa; mai due insieme (vedi evento)
                  tuffo: (t) => {
                      const g = ctx.createGain(); g.gain.value = voce ? 0.3 : 1; g.connect(n.ui); n.tuffoG = g;
                      const s = ctx.createBufferSource(); s.buffer = n.tick; s.loop = true;
                      const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 1.1;
                      f.frequency.setValueAtTime(220, t); f.frequency.exponentialRampToValueAtTime(3200, t + 0.9);
                      const gs = ctx.createGain(); gs.gain.setValueAtTime(0.0001, t); gs.gain.exponentialRampToValueAtTime(V6_SOFFIO, t + 0.55); gs.gain.exponentialRampToValueAtTime(0.0001, t + 1.15);
                      s.connect(f); f.connect(gs); gs.connect(g); s.start(t); s.stop(t + 1.2);
                      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(hz(19), t); o.frequency.exponentialRampToValueAtTime(hz(7), t + 1.0);
                      const go = ctx.createGain(); go.gain.setValueAtTime(0.0001, t); go.gain.exponentialRampToValueAtTime(V6_BASSA, t + 0.12); go.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
                      o.connect(go); go.connect(g); o.start(t); o.stop(t + 1.15);
                      [60, 64, 67].forEach((sm, i) => { const c = ctx.createOscillator(); c.type = 'sine'; c.frequency.value = hz(sm);
                          const gc = ctx.createGain(); const t1 = t + 0.62 + i * 0.07; gc.gain.setValueAtTime(0.0001, t1); gc.gain.exponentialRampToValueAtTime(V6_CODA, t1 + 0.01); gc.gain.exponentialRampToValueAtTime(0.0001, t1 + 0.5);
                          c.connect(gc); gc.connect(g); c.start(t1); c.stop(t1 + 0.55); });
                  },
                  // V6: mentre aspetta la risposta dal vivo, impulsi morbidi e lenti (uno al secondo, attacco lento)
                  pensa: (t) => { tono(hz(36), 'sine', 0.55, V6_PENSA, t, 0, 0.22); tono(hz(43), 'sine', 0.45, V6_PENSA * 0.5, t + 0.04, 0, 0.25); }
              };
              const elab = () => {
                  if (!n || !acceso || nascosto || stato !== 'inviata' || presenza < 0.5)
                      return;
                  const adesso = performance.now();       // V6 (25/11): impulsi morbidi e lenti al posto dei tic veloci
                  if (adesso - ultimoPensa < 1050 || adesso < tuffoFino)
                      return;
                  ultimoPensa = adesso;
                  EV.pensa(ora() + 0.02);
              };
              const avviaTimer = () => {
                  if (!timerDeriva)
                      timerDeriva = setInterval(() => { if (n)
                          deriva(ora() + 12); }, 4000);
                  if (!timerElab)
                      timerElab = setInterval(elab, 170);
              };
              const fermaTimer = () => {
                  if (timerDeriva) {
                      clearInterval(timerDeriva);
                      timerDeriva = 0;
                  }
                  if (timerElab) {
                      clearInterval(timerElab);
                      timerElab = 0;
                  }
              };
              const smonta = () => {
                  fermaTimer();
                  if (!n)
                      return;
                  n.osc.forEach((o) => { try {
                      o.stop();
                  }
                  catch (e) { } });
                  n.rumori.forEach((o) => { try {
                      o.stop();
                  }
                  catch (e) { } });
                  try {
                      n.master.disconnect();
                  }
                  catch (e) { }
                  n = null;
                  derivaFino = 0;
              };
              let smontaTimer = 0;
              const api = {
                  get acceso() { return acceso; },
                  get volume() { return vol; },
                  accendi() {
                      if (smontaTimer) {
                          clearTimeout(smontaTimer);
                          smontaTimer = 0;
                      }
                      if (!n && !costruisci())
                          return false;
                      try {
                          if (ctx.state !== 'running' && ctx.state !== 'closed')      // anche 'interrupted' (iOS)
                              ctx.resume();
                      }
                      catch (e) { }
                      acceso = true;
                      const t = ora();
                      verso(n.master.gain, livelloMaster(), t, 1.0);      // M3: dissolvenza di circa 3 s
                      aggiornaCore();
                      avviaTimer();
                      EV.attiva(t + 0.02);
                      return true;
                  },
                  spegni() {
                      if (!n) {
                          acceso = false;
                          return;
                      }
                      const t = ora();
                      EV.disattiva(t + 0.01);
                      acceso = false;
                      verso(n.master.gain, 0, t + 0.25, 0.22);
                      smontaTimer = setTimeout(() => { smontaTimer = 0; if (!acceso)
                          smonta(); }, 2200);
                  },
                  volume(v) { vol = Math.max(0, Math.min(1, v)); if (n)
                      verso(n.master.gain, livelloMaster(), ora(), 0.08); },
                  nascosto(h) { nascosto = !!h; if (n)
                      verso(n.master.gain, livelloMaster(), ora(), h ? 0.12 : 0.6); },
                  voce(on) {
                      if (voce === !!on)
                          return;
                      voce = !!on;
                      if (!n)
                          return;
                      const t = ora();
                      if (n.tuffoG)
                          verso(n.tuffoG.gain, voce ? 0.3 : 1, t, 0.08);       // V6: il tuffo si abbassa quando parla VERA
                      if (voce) {
                          verso(n.ambD.gain, 0.28, t, 0.12);
                          verso(n.ambF.frequency, 520, t, 0.15);
                          verso(n.coreD.gain, 0.25, t, 0.1);
                      }
                      else {
                          verso(n.ambD.gain, 1, t, 0.9);
                          verso(n.ambF.frequency, 1800, t, 1.0);
                          verso(n.coreD.gain, 1, t, 0.9);
                      }
                  },
                  presenza(p) { const v = Math.max(0, Math.min(1, p)); if (Math.abs(v - presenza) < 0.02)
                      return; presenza = v; if (n)
                      aggiornaCore(); },
                  stato(s) { if (s === stato)
                      return; stato = s; if (n)
                      aggiornaCore(); },
                  livello(x) { const v = stato === 'ascolto' ? Math.min(0.05, 0.004 + x * 0.05) : 0; if (Math.abs(v - livIn) < 0.002)
                      return; livIn = v; if (n && acceso)
                      verso(n.lucG.gain, v, ora(), 0.05); },
                  evento(nome) {
                      if (!n || !acceso || nascosto || !EV[nome])
                          return;
                      const t = ora() + 0.005;
                      if (nome === 'tuffo') {           // V6: mai due tuffi insieme
                          const adesso = performance.now();
                          if (adesso < tuffoFino)
                              return;
                          tuffoFino = adesso + 1300;
                      }
                      if (nome === 'passa') {
                          const adesso = performance.now();
                          if (adesso - ultimoPassa < 90)
                              return;
                          ultimoPassa = adesso;
                      }
                      try {
                          EV[nome](t);
                      }
                      catch (e) { }
                  },
                  prova(c, fino) { ctx = null; const pc = prendiCtx; prendiCtx = () => c; const ok = costruisci(); prendiCtx = pc; if (!ok)
                      return null; acceso = true; n.master.gain.value = livelloMaster(); deriva(fino); return { n, EV, ctx: c, tono, api }; },
                  smonta() { if (smontaTimer) {
                      clearTimeout(smontaTimer);
                      smontaTimer = 0;
                  } acceso = false; smonta(); }
              };
              return api;
          };
          const PREF_SUONO = 'ncb.suono.v1';
          const leggiPref = () => { try {
              const v = JSON.parse(win.localStorage.getItem(PREF_SUONO) || 'null');
              return v && typeof v === 'object' ? v : null;
          }
          catch (e) {
              return null;
          } };
          const salvaPref = (o) => { try {
              win.localStorage.setItem(PREF_SUONO, JSON.stringify(o));
          }
          catch (e) { } };
          const suono = creaSuono(() => { preparaAudio(); return actx; });
          root.__suono = suono;      // N1.5 (notte 25/11): per le misure del suono (prova con OfflineAudioContext), nessun effetto sulla pagina
          this._suono = suono;
          const DATI_RC = { storie: {} };
          const creaTuffo = () => {
              const T_IN = TEMPI_RC.tuffoIngresso, T_OUT = TEMPI_RC.tuffoUscita, T_FADE = TEMPI_RC.tuffoDissolvenza, PRIMA = TEMPI_RC.tuffoPrima;
              const lento = () => root.__tuffoScala || 1;
              const ora = () => win.performance.now();
              const sm = (a, b, x) => { const u = lim((x - a) / (b - a)); return u * u * (3 - 2 * u); };
              const bez = (x) => {
                  x = lim(x);
                  if (x <= 0 || x >= 1)
                      return x;
                  let a = 0, b = 1, t = x;
                  for (let i = 0; i < 16; i++) {
                      t = (a + b) / 2;
                      const u = 1 - t;
                      const bx = 3 * u * u * t * 0.65 + 3 * u * t * t * 0.35 + t * t * t;
                      if (bx < x)
                          a = t;
                      else
                          b = t;
                  }
                  const u = 1 - t;
                  return 3 * u * t * t + t * t * t;
              };
              let modo = 'camera', p = 0, p0 = 0, t0 = 0, verso = 0, attendiFino = 0, fine = null, f = null, suonato = false;
              const geo = { x: 0, y: 0, R: 120 };
              const durata = () => (modo === 'camera' ? (verso > 0 ? T_IN : T_OUT) : T_FADE) * lento();
              const fissa = () => { p0 = p; t0 = ora(); };
              const attivo = () => verso !== 0 || p > 0 || attendiFino > 0;
              return {
                  geo,
                  get modo() { return modo; },
                  get p() { return p; },
                  get f() { return f; },
                  get verso() { return verso; },
                  get attivo() { return attivo(); },
                  get dentro() { return p >= 1 && verso === 0; },
                  curva(x) { return bez(x); },
                  avvia(m) {
                      if (!attivo()) {
                          attendiFino = m === 'camera' ? ora() + PRIMA * lento() : 0;
                          suonato = false;
                      }
                      modo = m;
                      verso = 1;
                      fine = null;
                      fissa();
                  },
                  esci(cb) {
                      if (!attivo()) {
                          if (cb)
                              cb();
                          return;
                      }
                      attendiFino = 0;
                      verso = -1;
                      fine = cb || null;
                      fissa();
                  },
                  // S1 (25/11): uscita senza animazione (al fotogramma dopo il tuffo e' finito)
                  subito(cb) {
                      if (!attivo()) {
                          if (cb)
                              cb();
                          return;
                      }
                      attendiFino = 0;
                      verso = -1;
                      fine = cb || null;
                      p = Math.min(p, 0.0001);
                      fissa();
                  },
                  attesa() {
                      const resto = Math.max(0, attendiFino - ora());
                      return Math.round(resto + ((1 - p) * (modo === 'camera' ? T_IN : T_FADE) + (modo === 'camera' ? 60 : 130)) * lento());
                  },
                  avanza() {
                      const n = ora();
                      if (!(attendiFino && n < attendiFino)) {
                          if (attendiFino) {
                              attendiFino = 0;
                              fissa();
                          }
                          if (verso) {
                              p = lim(p0 + verso * (n - t0) / durata());
                              if (verso > 0 && p >= 1) {
                                  p = 1;
                                  verso = 0;
                              }
                              else if (verso < 0 && p <= 0) {
                                  p = 0;
                                  verso = 0;
                                  f = null;
                                  const cb = fine;
                                  fine = null;
                                  if (cb)
                                      cb();
                                  return null;
                              }
                          }
                      }
                      if (!attivo()) {
                          f = null;
                          return null;
                      }
                      if (modo !== 'camera') {
                          f = { modo, p, m: 0, verso, o: sm(0, 1, p), cv: 0, te: 0, im: 0, ap: 0, cr: 0, ro: 0, co: 0, ft: 0, lf: 0, ls: 0, lo: 0, sa: 1, hc: 1, fa: 1, pm: 1, tz: 1, st: 0, to: 1, tz2: 1, to2: 1, colpi: 0 };
                          return f;
                      }
                      const m = p * T_IN;
                      if (!suonato && verso > 0 && m > 2150) {
                          suonato = true;
                          suono.evento('tuffo');       // V6 (25/11): il passaggio «spaziale» verso la risposta
                      }
                      const c = bez((m - 2200) / 1000), d = bez((m - 3200) / 800);
                      f = {
                          modo, p, m, verso,
                          cv: bez(m / 1400), te: sm(0, 300, m), sa: 1 - sm(0, 450, m), hc: 1 - sm(0, 400, m), fa: 1 - sm(1050, 1400, m), pm: 1 - sm(1150, 1400, m),
                          im: sm(1400, 1900, m), ro: sm(1400, 1700, m) * (1 - sm(2150, 2450, m)), co: sm(1950, 2200, m), cr: sm(1850, 2150, m) * (1 - sm(2350, 2700, m)),
                          ft: sm(1450, 1650, m) * (1 - sm(2080, 2230, m)),
                          ap: c, lf: m < 2200 || m > 2350 ? 0 : m < 2250 ? 0.3 * (m - 2200) / 50 : 0.3 * (1 - (m - 2250) / 100),
                          ls: m < 2200 ? 0.02 : 0.03 + 0.17 * c + 1.2 * d, lo: 0.92 * sm(2200, 2600, m), lk: sm(3150, 3700, m),
                          tz: 1 + 1.5 * d, st: Math.sin(Math.PI * lim((m - 3200) / 800)), to: 1 - sm(3400, 3850, m), tz2: 1 + 0.25 * d, to2: 1 - sm(3300, 3800, m),
                          o: sm(3450, 4000, m), colpi: 0
                      };
                      return f;
                  }
              };
          };
          const tuffo = creaTuffo();
          root.__tuffo = tuffo;
          const creaTessuto = (cv) => {
              const c = cv && cv.getContext ? cv.getContext('2d') : null;
              if (!c)
                  return null;
              let W = 0, H = 0, d = 1, nodi = [], fili = [], catene = [], part = [], imp = [], fermoFatto = false, seme = 7;
              const rnd = () => { seme = (seme * 16807) % 2147483647; return seme / 2147483647; };
              const AR = COL.segnale;
              const bordo = (s, w, h) => {
                  const P = 2 * (w + h);
                  s = ((s % P) + P) % P;
                  if (s < w)
                      return [s, 0, 0, 1];
                  if (s < w + h)
                      return [w, s - w, -1, 0];
                  if (s < 2 * w + h)
                      return [w - (s - w - h), h, 0, -1];
                  return [0, h - (s - 2 * w - h), 1, 0];
              };
              const costruisci = (w, h, stt) => {
                  seme = 7;
                  nodi = [];
                  fili = [];
                  catene = [];
                  part = [];
                  imp = [];
                  const np = stt ? 20 : 50;
                  for (let i = 0; i < np; i++)
                      part.push({ s: rnd() * 2 * (w + h), u: rnd(), v: 0.012 + rnd() * 0.02, dev: (rnd() - 0.5) * 0.5, r: 1.2 + rnd() * 1.3 });
                  if (stt)
                      return;
                  const P = 2 * (w + h), n = Math.round(P / 34);
                  for (let i = 0; i < n; i++) {
                      const b = bordo(((i + rnd() * 0.7) / n) * P, w, h);
                      const fascia = 0.12 * (b[2] !== 0 ? w : h) * 1.15;
                      const pr = Math.pow(rnd(), 1.5);
                      nodi.push({ x: b[0] + b[2] * fascia * pr, y: b[1] + b[3] * fascia * pr, pr, ph: rnd() * 6.283, i });
                  }
                  const lega = (a, b) => { fili.push({ a, b, ph: rnd() * 6.283, am: 4 + rnd() * 7 }); };
                  for (let i = 0; i < n; i++) {
                      lega(i, (i + 1) % n);
                      if (rnd() < 0.55)
                          lega(i, (i + 2) % n);
                      if (rnd() < 0.3)
                          lega(i, (i + 3) % n);
                  }
                  for (let i = 0; i < n; i++) {
                      if (nodi[i].pr > 0.22)
                          continue;
                      const ch = [i];
                      let k = i;
                      for (let s = 0; s < 4; s++) {
                          let best = -1;
                          for (let j = -3; j <= 3; j++) {
                              const q = (k + j + n) % n;
                              if (q !== k && nodi[q].pr > nodi[k].pr + 0.12 && (best < 0 || nodi[q].pr < nodi[best].pr))
                                  best = q;
                          }
                          if (best < 0)
                              break;
                          ch.push(best);
                          k = best;
                      }
                      if (ch.length >= 3)
                          catene.push(ch);
                  }
              };
              return {
                  impulso(n) { if (!catene.length || fermo)
                      return; for (let i = 0; i < n && imp.length < 14; i++)
                      imp.push({ ch: catene[Math.floor(rnd() * catene.length)], t0: win.performance.now() }); },
                  disegna(now, stt) {
                      const w = cv.clientWidth, h = cv.clientHeight;
                      if (!w || !h)
                          return;
                      const dd = Math.min(win.devicePixelRatio || 1, 1.5);
                      if (Math.round(w * dd) !== W || Math.round(h * dd) !== H) {
                          d = dd;
                          W = cv.width = Math.round(w * dd);
                          H = cv.height = Math.round(h * dd);
                          costruisci(w, h, stt);
                          fermoFatto = false;
                      }
                      if (fermo && fermoFatto)
                          return;
                      fermoFatto = true;
                      const t = fermo ? 2 : now * 0.001;
                      c.setTransform(d, 0, 0, d, 0, 0);
                      c.clearRect(0, 0, w, h);
                      c.lineWidth = 1;
                      for (const f of fili) {
                          const A = nodi[f.a], B = nodi[f.b];
                          const al = 0.5 * Math.pow(1 - (A.pr + B.pr) / 2, 1.6);
                          if (al < 0.02)
                              continue;
                          const mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2, dx = B.x - A.x, dy = B.y - A.y, l = Math.hypot(dx, dy) || 1;
                          const o = f.am * Math.sin(t * 0.55 + f.ph);
                          c.strokeStyle = rgba(AR, al);
                          c.beginPath();
                          c.moveTo(A.x, A.y);
                          c.quadraticCurveTo(mx - (dy / l) * o, my + (dx / l) * o, B.x, B.y);
                          c.stroke();
                      }
                      for (const q of nodi) {
                          const al = (0.3 + 0.4 * (0.5 + 0.5 * Math.sin(t * 1.25 + q.ph))) * (1 - 0.75 * q.pr);
                          c.fillStyle = rgba(AR, al);
                          c.beginPath();
                          c.arc(q.x, q.y, 1.5 + 1.1 * (1 - q.pr), 0, 6.2832);
                          c.fill();
                      }
                      if (fermo)
                          return;
                      for (let j = imp.length - 1; j >= 0; j--) {
                          const q = imp[j], u = Math.max(0, (now - q.t0) / 760);
                          if (u >= 1) {
                              imp.splice(j, 1);
                              continue;
                          }
                          const pos = facile(u) * (q.ch.length - 1), k = Math.min(q.ch.length - 2, Math.floor(pos)), v = pos - k;
                          const A = nodi[q.ch[k]], B = nodi[q.ch[k + 1]];
                          const x = A.x + (B.x - A.x) * v, y = A.y + (B.y - A.y) * v, al = Math.sin(Math.PI * Math.min(1, u * 1.15));
                          c.fillStyle = rgba(AR, 0.2 * al);
                          c.beginPath();
                          c.arc(x, y, 9, 0, 6.2832);
                          c.fill();
                          c.fillStyle = rgba(AR, 0.9 * al);
                          c.beginPath();
                          c.arc(x, y, 2.6, 0, 6.2832);
                          c.fill();
                      }
                      for (const q of part) {
                          q.u += q.v * 0.016;
                          if (q.u > 1) {
                              q.u = 0;
                              q.s = rnd() * 2 * (w + h);
                          }
                          const b = bordo(q.s, w, h);
                          const tx = w / 2 + (b[0] - w / 2) * q.dev, ty = h / 2 + (b[1] - h / 2) * q.dev;
                          const x = b[0] + (tx - b[0]) * q.u * 0.62 + 6 * Math.sin(t * 0.7 + q.s), y = b[1] + (ty - b[1]) * q.u * 0.62 + 6 * Math.cos(t * 0.6 + q.s);
                          const e = Math.max(Math.abs(x - w / 2) / (w / 2), Math.abs(y - h / 2) / (h / 2));
                          const al = 0.6 * lim((e - 0.58) / 0.36) * Math.min(1, q.u * 8);
                          if (al < 0.01)
                              continue;
                          c.fillStyle = rgba(AR, al);
                          c.beginPath();
                          c.arc(x, y, q.r, 0, 6.2832);
                          c.fill();
                      }
                  }
              };
          };
          const cadenzaRC = (d) => {
              const st = d && DATI_RC.storie[d.id || d.rif];
              if (!st || !d.parole || d.parole.length !== st.n)
                  return d;
              if (d._cadenza)
                  return d._cadenza;
              const parole = [];
              let t = 0;
              st.quadri.forEach((q, k) => {
                  const passo = (TEMPI_RC.parola * (k === 0 ? TEMPI_RC.primaFrase : 1)) / 1000;
                  for (let i = q.i0; i <= q.i1; i++) {
                      parole[i] = [d.parole[i][0], t, t + passo];
                      t += passo;
                  }
                  t += TEMPI_RC.pausaFrase / 1000;
              });
              d._cadenza = Object.assign({}, d, { parole, durata: t - TEMPI_RC.pausaFrase / 1000 + TEMPI_RC.coda / 1000, cadenza: true });
              return d._cadenza;
          };
          const creaRacconto = () => {
              const sez = q1('[data-racconto]');
              if (!sez)
                  return null;
              const S = DATI_RC.storie;
              const D = {
                  stato: q1('[data-b-stato]'), domanda: q1('[data-b-domanda]'), avviso: q1('[data-b-avviso]'), storie: q1('[data-storie]'), interno: q1('[data-interno]'),
                  prova: q1('[data-rc-prova]'), provaRiga: q1('[data-rc-prova-riga]'), scheda: q1('[data-rc-scheda]'), esito: q1('[data-b-esito-testo]'), file: q1('[data-b-file]'),
                  tipo: q1('[data-b-tipo]'), nota: q1('[data-b-esito-nota]'), improntaRiga: q1('[data-rc-impronta-riga]'), impronta: q1('[data-b-impronta-testo]'), copia: q1('[data-rc-copia]'),
                  segui: q1('[data-rc-segui]'), altro: q1('[data-rc-altro]')
              };
              const tastiPausa = qq('[data-racconto] [data-sc-pausa]');
              const storie = {};
              qq('[data-storia]').forEach((el) => { storie[el.getAttribute('data-storia')] = el; });
              let aperta = false, corr = null, storiaEl = null, quadriEl = [], parolaEl = [], Q = [], qCorr = -1, wi = -1, gen = 0;
              let segui = true, interrotta = false, modoCorr = 'chiuso';
              const strato = () => !statico;
              const modo = (m) => { modoCorr = m; sez.setAttribute('data-modo', m); };
              if (strato()) {
                  sez.setAttribute('role', 'dialog');
                  sez.setAttribute('aria-modal', 'true');
              }
              const frase = (k) => (quadriEl[k] ? quadriEl[k].querySelector('.q-corpo') : null);
              let tw = 0;
              const scorri = (y, ms) => {
                  const s = D.storie;
                  if (!s)
                      return;
                  const y1 = Math.max(0, Math.min(y, s.scrollHeight - s.clientHeight)), y0 = s.scrollTop, id = ++tw;
                  if (fermo || !ms || Math.abs(y1 - y0) < 1) {
                      s.scrollTop = y1;
                      return;
                  }
                  const ta = win.performance.now();
                  const passo = (n) => { if (id !== tw)
                      return; const u = lim((n - ta) / ms); s.scrollTop = y0 + (y1 - y0) * facile(u); if (u < 1)
                      win.requestAnimationFrame(passo); };
                  win.requestAnimationFrame(passo);
              };
              const centra = (el, ms) => {
                  const s = D.storie;
                  if (!el || !s || !strato())
                      return;
                  const r = el.getBoundingClientRect(), sr = s.getBoundingClientRect(), top = r.top - sr.top + s.scrollTop;
                  scorri(r.height > sr.height - 32 ? top - 16 : top + r.height / 2 - sr.height / 2, ms);
              };
              const seguiLaVoce = (on) => { segui = on; if (D.segui)
                  D.segui.hidden = on; };
              const smetti = () => { tw++; if (aperta && segui && modoCorr === 'racconto' && D.storie.scrollHeight > D.storie.clientHeight + 1)
                  seguiLaVoce(false); };
              const allinea = () => {
                  if (!storiaEl || !D.storie)
                      return;
                  D.storie.classList.remove('lunga');
                  let righe = 0;
                  storiaEl.querySelectorAll('.q-corpo').forEach((c) => { const t = c.querySelector('.q-testo'); if (!t)
                      return; const lh = parseFloat(win.getComputedStyle(t).lineHeight) || 1; righe += Math.round(t.getBoundingClientRect().height / lh); });
                  D.storie.classList.toggle('lunga', righe > 5);
              };
              const chiudiScheda = () => { if (D.scheda)
                  D.scheda.hidden = true; if (D.provaRiga)
                  D.provaRiga.setAttribute('aria-expanded', 'false'); };
              const scriviProva = (o) => {
                  const f = o.fonte || corr.fonte, esito = storiaEl.getAttribute('data-esito') || '';
                  if (D.prova) {
                      D.prova.setAttribute('data-c', (storiaEl.className.match(/c-[a-z]+/) || [''])[0]);
                      if (f)
                          D.prova.removeAttribute('data-senza-fonte');
                      else
                          D.prova.setAttribute('data-senza-fonte', '');
                  }
                  if (D.esito)
                      D.esito.textContent = esito;
                  if (D.file)
                      D.file.textContent = f ? f.file + (f.riga ? ' · ' + (PR.riga || '') + ' ' + f.riga : '') : '';
                  if (D.provaRiga)
                      D.provaRiga.setAttribute('aria-label', esito + (f ? ' · ' + f.file + (f.riga ? ' · ' + (PR.riga || '') + ' ' + f.riga : '') : ''));
                  if (D.tipo)
                      D.tipo.textContent = corr.classe === 'rifiuto' ? ((PR.esiti || {}).rifiutata || '') : String(o.tipo || corr.tipo || '').toUpperCase();
                  if (D.nota)
                      D.nota.textContent = storiaEl.getAttribute('data-nota') || '';
                  if (D.impronta)
                      D.impronta.textContent = f && f.impronta ? f.impronta : '';
                  if (D.improntaRiga)
                      D.improntaRiga.hidden = !(f && f.impronta);
                  chiudiScheda();
              };
              const selezionaImpronta = () => {
                  try {
                      const r = doc.createRange();
                      r.selectNodeContents(D.impronta);
                      const s = win.getSelection();
                      s.removeAllRanges();
                      s.addRange(r);
                  }
                  catch (e) { }
              };
              const copiaImpronta = () => {
                  const t = D.impronta ? D.impronta.textContent : '';
                  if (!t || !D.copia)
                      return;
                  const detto = (x) => { D.copia.textContent = x; dopo(() => { D.copia.textContent = PR.copia || ''; }, TEMPI_RC.copiata); };
                  const ripiego = () => { selezionaImpronta(); detto(PR.selezionata || ''); };
                  try {
                      win.navigator.clipboard.writeText(t).then(() => detto(PR.copiata || ''), ripiego);
                  }
                  catch (e) {
                      ripiego();
                  }
              };
              const facileR = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : 1 - Math.pow(1 - u, 3));
              const griglia = (cv, n, mostrati) => {
                  const c = cv.getContext('2d');
                  if (!c)
                      return;
                  const col = 50, righe = Math.ceil(n / col), cel = 6, dpr = Math.min(win.devicePixelRatio || 1, 2);
                  const W = col * cel, H = righe * cel;
                  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
                      cv.width = Math.round(W * dpr);
                      cv.height = Math.round(H * dpr);
                  }
                  c.setTransform(dpr, 0, 0, dpr, 0, 0);
                  c.clearRect(0, 0, W, H);
                  c.fillStyle = '#D3D2CB';
                  for (let i = Math.max(0, mostrati); i < n; i++)
                      c.fillRect((i % col) * cel, Math.floor(i / col) * cel, cel - 2, cel - 2);
                  c.fillStyle = '#141517';
                  for (let i = 0; i < Math.min(n, mostrati); i++)
                      c.fillRect((i % col) * cel, Math.floor(i / col) * cel, cel - 2, cel - 2);
              };
              const grafica = (k, tt, fin) => {
                  const q = Q[k], el = quadriEl[k], g = q && q.g;
                  if (!g || !el)
                      return;
                  const box = el.querySelector('[data-g]');
                  if (!box)
                      return;
                  const P = corr.parole;
                  if (!fin && tt < P[g.wv][1] - 0.15)
                      return;
                  box.classList.add('on');
                  if (g.tipo === 'perc') {
                      el.querySelectorAll('[data-gr]').forEach((riga, j) => { const r = g.righe[j]; if (r && (fin || tt >= P[r.w][1] - 0.2))
                          riga.classList.add('gira'); });
                  }
                  else if (g.tipo === 'conta') {
                      const tS = P[g.w][1];
                      if (fin || tt >= tS - 0.1)
                          box.classList.add('gira');
                      const u = fin ? 1 : facileR((tt - tS) / 1.8), m = Math.round(g.n * u);
                      const cv = el.querySelector('[data-g-griglia]');
                      if (cv && cv._m !== m) {
                          cv._m = m;
                          griglia(cv, g.n, m);
                      }
                  }
                  else if (g.tipo === 'elenco') {
                      el.querySelectorAll('[data-gv]').forEach((c, j) => {
                          const vv = g.voci[j];
                          if (!vv)
                              return;
                          const inizio = P[vv.w0][1], prossima = g.voci[j + 1] ? P[g.voci[j + 1].w0][1] : P[vv.w1][2] + 0.5;
                          const detta = fin || tt >= inizio;
                          c.classList.toggle('detta', detta);
                          c.classList.toggle('attiva', !fin && detta && tt < prossima);
                      });
                  }
              };
              const azzera = () => {
                  if (!storiaEl)
                      return;
                  quadriEl.forEach((el) => { el.classList.remove('vivo', 'detto'); const g = el.querySelector('[data-g]'); if (g)
                      g.classList.remove('on', 'gira'); });
                  parolaEl.forEach((w) => { if (w)
                      w.classList.remove('detta'); });
                  storiaEl.classList.remove('prima-fatta', 'fine-vicina');
                  storiaEl.querySelectorAll('[data-gr]').forEach((r) => r.classList.remove('gira'));
                  storiaEl.querySelectorAll('[data-gv]').forEach((c) => c.classList.remove('detta', 'attiva'));
                  storiaEl.querySelectorAll('[data-g-griglia]').forEach((cv) => { const q = Q[+cv.closest('[data-q]').getAttribute('data-q')]; if (q && q.g) {
                      cv._m = 0;
                      griglia(cv, q.g.n, 0);
                  } });
                  sez.classList.remove('intero', 'in-pausa', 'con-domanda');
                  qCorr = -1;
                  wi = -1;
                  interrotta = false;
                  if (D.avviso)
                      D.avviso.textContent = '';
                  if (D.altro)
                      D.altro.open = false;
                  chiudiScheda();
                  tastiPausa.forEach((b) => { b.textContent = PR.pausa || ''; b.setAttribute('aria-pressed', 'false'); });
              };
              const preparaStoria = (id, o, d) => {
                  corr = Object.assign({}, S[id], { parole: (d && d.parole) || [], durata: (d && d.durata) || 0 });
                  Q = corr.quadri;
                  Object.keys(storie).forEach((k) => { storie[k].hidden = k !== id; });
                  storiaEl = storie[id];
                  quadriEl = Array.prototype.slice.call(storiaEl.querySelectorAll('.quadro'));
                  parolaEl = [];
                  storiaEl.querySelectorAll('[data-w]').forEach((w) => { parolaEl[+w.getAttribute('data-w')] = w; });
                  if (D.domanda)
                      D.domanda.textContent = o.domanda || corr.domanda || '—';
                  scriviProva(o);
                  azzera();
              };
              const mostraDomanda = () => sez.classList.add('con-domanda');
              const entraParola = (i) => { const w = parolaEl[i]; if (w)
                  w.classList.add('detta'); };
              const chiudiPrimaFrase = () => { if (storiaEl)
                  storiaEl.classList.add('prima-fatta'); };
              const cominciaFrase = (k) => {
                  qCorr = k;
                  quadriEl.forEach((el, j) => { el.classList.toggle('vivo', j === k); el.classList.toggle('detto', j < k); });
                  for (let j = 0; j < k; j++)
                      grafica(j, 0, true);
                  if (k > 0)
                      chiudiPrimaFrase();
                  if (segui && aperta)
                      centra(frase(k), TEMPI_RC.scorri);
              };
              const completa = () => {
                  if (!corr)
                      return;
                  sez.classList.add('intero', 'con-domanda');
                  parolaEl.forEach((w) => { if (w)
                      w.classList.add('detta'); });
                  quadriEl.forEach((el, j) => grafica(j, 0, true));
                  storiaEl.classList.add('prima-fatta', 'fine-vicina');
              };
              const finisci = () => {
                  if (!corr)
                      return;
                  modo('fine');
                  completa();
                  quadriEl.forEach((el) => { el.classList.remove('vivo'); el.classList.add('detto'); });
                  if (D.stato)          // N1.8: un rifiuto resta «Rifiuto», mai seguito da «Ha risposto»
                      D.stato.textContent = NOME + ' · ' + ((corr.classe === 'rifiuto' ? STATI.rifiuto : STATI.finita) || '');
                  if (interrotta && D.avviso)
                      D.avviso.textContent = PR.interrotta || '';
                  if (D.segui)
                      D.segui.hidden = true;
                  if (segui && aperta)
                      centra(frase(quadriEl.length - 1), TEMPI_RC.scorri);
              };
              ascolta(sez, 'wheel', smetti, { passive: true });
              ascolta(sez, 'touchstart', (ev) => { if (!(ev.target.closest && ev.target.closest('button, summary')))
                  smetti(); }, { passive: true });
              const fuoriTesto = (ev) => strato() && aperta && !(ev.target && ev.target.closest && ev.target.closest('[data-storie]'));
              ascolta(sez, 'wheel', (ev) => { if (fuoriTesto(ev))
                  ev.preventDefault(); }, { passive: false });
              ascolta(sez, 'touchmove', (ev) => { if (fuoriTesto(ev))
                  ev.preventDefault(); }, { passive: false });
              ascolta(sez, 'keydown', (ev) => {
                  if (!D.storie)
                      return;
                  const k = ev.key;
                  if ((k === 'Enter' || k === ' ') && ev.target === D.storie && modoCorr === 'racconto') {
                      ev.preventDefault();
                      completa();
                      return;
                  }
                  if (!fuoriTesto(ev))
                      return;
                  const h = D.storie.clientHeight * 0.85;
                  const dy = k === 'PageDown' ? h : k === 'PageUp' ? -h : k === 'End' ? 1e7 : k === 'Home' ? -1e7 : 0;
                  if (dy) {
                      ev.preventDefault();
                      smetti();
                      D.storie.scrollTop += dy;
                  }
              });
              if (D.storie)
                  ascolta(D.storie, 'click', (ev) => { if (modoCorr === 'racconto' && !(ev.target.closest && ev.target.closest('button, a, summary')))
                      completa(); });
              if (D.segui)
                  ascolta(D.segui, 'click', () => { seguiLaVoce(true); if (D.altro)
                      D.altro.open = false; centra(frase(Math.max(0, qCorr)), TEMPI_RC.scorri); });
              if (D.provaRiga)
                  ascolta(D.provaRiga, 'click', () => { const apre = D.provaRiga.getAttribute('aria-expanded') !== 'true'; D.provaRiga.setAttribute('aria-expanded', String(apre)); if (D.scheda)
                      D.scheda.hidden = !apre; });
              if (D.copia)
                  ascolta(D.copia, 'click', copiaImpronta);
              if (D.altro)
                  ascolta(D.altro, 'click', (ev) => { if (ev.target.closest && ev.target.closest('.rc-voce'))
                      D.altro.open = false; });
              ascolta(win, 'resize', () => { if (aperta)
                  allinea(); });
              if (doc.fonts && doc.fonts.ready)
                  doc.fonts.ready.then(() => { if (aperta)
                      allinea(); });
              let fuori = [];
              const blocca = (on) => {
                  fuori.forEach((x) => x.removeAttribute('inert'));
                  fuori = [];
                  if (!on)
                      return;
                  fuori = [q1('.nav-guscio'), q1('[data-chiedi]'), q1('.piede')].concat(qq('main > *')).filter((x) => x && x !== sez && !x.contains(sez));
                  fuori.forEach((x) => x.setAttribute('inert', ''));
              };
              const cameraPossibile = () => {
                  if (fermo || !finale || !hudEl || !hudEl.classList.contains('attivo'))
                      return false;
                  const r = finale.getBoundingClientRect(), H = altezza();
                  return r.top <= 2 && r.bottom >= H - 2;
              };
              const entra = (g) => {
                  sez.removeAttribute('inert');
                  blocca(true);
                  if (this._lenis) {
                      try {
                          this._lenis.stop();
                      }
                      catch (e) { }
                  }
                  tuffo.avvia(cameraPossibile() ? 'camera' : 'dissolvenza');
                  if (tuffo.modo !== 'camera' && !fermo)
                      suono.evento('tuffo');
                  tuffo.avanza();
                  posaStrato(win.performance.now());
                  if (D.storie)
                      D.storie.scrollTop = 0;
                  if (D.storie) {
                      try {
                          D.storie.focus({ preventScroll: true });
                      }
                      catch (e) { }
                  }
              };
              const esci = () => {
                  blocca(false);
                  sez.setAttribute('inert', '');
                  const a = doc.activeElement;
                  if (alTocco()) {               // N2 (25/11): al tocco il fuoco non torna sul campo; esce solo dalla risposta chiusa
                      if (a && sez.contains(a) && a.blur)
                          a.blur();
                  }
                  else if (!a || a === doc.body || sez.contains(a)) {
                      const t = inputCore;
                      if (t) {
                          try {
                              t.focus({ preventScroll: true });
                          }
                          catch (e) { }
                      }
                  }
              };
              const tessuto = creaTessuto(D.interno);
              const VAR = ['--rc-o', '--au'];
              const visti = {};
              let ultimoSt = 0, fase = 0, calma = 0;
              const metti = (k, v) => { if (visti[k] !== v) {
                  visti[k] = v;
                  sez.style.setProperty(k, v);
              } };
              const posaStrato = (now) => {
                  const f = tuffo.f;
                  if (!strato() || !f) {
                      if (Object.keys(visti).length)
                          VAR.forEach((k) => { sez.style.removeProperty(k); delete visti[k]; });
                      ultimoSt = 0;
                      fase = 0;
                      calma = 0;
                      return;
                  }
                  metti('--rc-o', f.o.toFixed(3));
                  if (f.o < 0.004)
                      return;
                  const dt = ultimoSt ? Math.min(0.1, (now - ultimoSt) / 1000) : 0;
                  ultimoSt = now;
                  calma += ((modoCorr === 'fine' ? 1 : 0) - calma) * (1 - Math.exp(-dt * 1.2));
                  fase += (dt * 6.2832) / (5 + 4 * calma);
                  const au = fermo ? 0.24 : 0.28 - 0.08 * calma + 0.1 * (1 - 0.8 * calma) * Math.sin(fase);
                  metti('--au', au.toFixed(3));
                  if (tessuto)
                      tessuto.disegna(now, stretto());
              };
              return {
                  get aperta() { return aperta; },
                  get forma() { return 'racconto'; },
                  get verso() { return null; },
                  get figura() { return 0; },
                  get dentro() { if (!aperta)
                      return false; if (strato())
                      return tuffo.p > 0.6; const r = sez.getBoundingClientRect(); return r.top < altezza() * 0.6 && r.bottom > 0; },
                  attesa() { return strato() && aperta ? tuffo.attesa() + (fermo ? 0 : TEMPI_RC.domanda + (root.__voceAccesa ? TEMPI_RC.respiroVoce : TEMPI_RC.respiro)) : 700; },
                  didascalia() { },
                  rect() { return sez.getBoundingClientRect(); },
                  apri(d, o) {
                      o = o || {};
                      if (o.presentazione || !d)
                          return;
                      const id = d.id || d.rif;
                      if (!S[id] || !storie[id])
                          return;
                      if (o.subito && strato())
                          return;
                      if (!voceAttiva && !o.subito)
                          d = cadenzaRC(d);
                      if (!d.parole || d.parole.length !== S[id].n)
                          return;
                      const g = ++gen;
                      preparaStoria(id, o, d);
                      aperta = true;
                      root.classList.add('con-racconto');
                      if (percorso)
                          percorso.classList.add('rc-sotto');
                      modo('racconto');
                      if (D.stato)
                          D.stato.textContent = NOME + ' · ' + ((corr.classe === 'rifiuto' ? STATI.rifiuto : STATI.parla) || '');
                      seguiLaVoce(true);
                      allinea();
                      if (o.subito) {
                          mostraDomanda();
                          return;
                      }
                      entra(g);
                      if (fermo) {
                          mostraDomanda();
                          completa();
                      }
                      else
                          dopo(() => { if (g === gen && aperta)
                              mostraDomanda(); }, tuffo.attesa());
                  },
                  parola(k) {
                      if (!aperta || !corr)
                          return;
                      const P = corr.parole, n = P.length, fino = Math.max(0, Math.min(n, k));
                      while (wi + 1 < fino) {
                          wi++;
                          entraParola(wi);
                          if (tessuto && strato())
                              tessuto.impulso(1);
                      }
                      const prossima = Math.min(n - 1, fino);
                      let kq = 0;
                      for (let j = 0; j < Q.length; j++)
                          if (Q[j].i0 <= prossima)
                              kq = j;
                      if (kq !== qCorr)
                          cominciaFrase(kq);
                      if (Q[0] && fino > Q[0].i1)
                          chiudiPrimaFrase();
                      const tt = fino >= n ? corr.durata : P[prossima][1];
                      if (!fermo)
                          grafica(qCorr, tt, false);
                      if (corr.durata - tt <= TEMPI_RC.tracciato / 1000)
                          storiaEl.classList.add('fine-vicina');
                  },
                  tutto() { completa(); },
                  esito() { if (aperta)
                      finisci(); },
                  interrotta() { interrotta = true; },
                  pausa(on) {
                      sez.classList.toggle('in-pausa', !!on);
                      tastiPausa.forEach((b) => { b.textContent = (on ? PR.riprendi : PR.pausa) || ''; b.setAttribute('aria-pressed', on ? 'true' : 'false'); });
                      if (D.stato && modoCorr === 'racconto')
                          D.stato.textContent = NOME + ' · ' + ((on ? PR.pausa : STATI.parla) || '');
                  },
                  chiudi(subito) {
                      if (!aperta)
                          return;
                      aperta = false;
                      const g = ++gen;
                      tw++;
                      const fine = () => { if (g === gen && !aperta) {
                          root.classList.remove('con-racconto');
                          modo('chiuso');
                          azzera();
                          sez.removeAttribute('inert');
                          if (this._lenis) {
                              try {
                                  this._lenis.start();
                              }
                              catch (e) { }
                          }
                      } };
                      if (strato()) {
                          esci();
                          if (subito) {
                              tuffo.subito(fine);     // S1: senza animazione, e la scena chiusa subito (non al fotogramma del tuffo)
                              fine();
                          }
                          else
                              tuffo.esci(fine);
                      }
                      else
                          fine();
                      if (!subito)
                          suono.evento('chiusura');
                  },
                  passo(now) { posaStrato(now); },
                  registra(id, el, dati) { S[id] = dati; storie[id] = el; if (D.storie && !el.parentNode)
                      D.storie.appendChild(el); }
              };
          };
          const scena = creaRacconto();
          const alone = creaAlone();
          const cinema = () => this.props.cinema !== false;
          const PS = PAROLE.suono || {};
          const tastoSuono = q1('[data-suono-tasto]');
          const etiSuono = q1('[data-suono-eti]');
          const volSuono = q1('[data-suono-vol]');
          const gusSuono = q1('.nav-suono-guscio');
          const prefSuono = Object.assign({ on: true, vol: 0.6 }, leggiPref() || {});      // M3: acceso se non l'hai spento
          let timerPannello = 0;
          const mostraSuono = (stato) => {
              if (!tastoSuono)
                  return;
              const on = stato === 'acceso';
              tastoSuono.setAttribute('aria-pressed', on ? 'true' : 'false');
              tastoSuono.classList.toggle('riprendi', stato === 'riprendi');
              tastoSuono.setAttribute('aria-label', String((on ? PS.aria_acceso : stato === 'riprendi' ? PS.aria_riprendi : PS.aria_spento) || ''));
              if (etiSuono)
                  etiSuono.textContent = String((stato === 'riprendi' ? PS.riprendi : PS.eti) || '');
              root.classList.toggle('suono-on', on);
          };
          const mostraPannello = () => {
              if (!gusSuono)
                  return;
              gusSuono.classList.add('mostra');
              if (timerPannello)
                  win.clearTimeout(timerPannello);
              timerPannello = dopo(() => gusSuono.classList.remove('mostra'), 4000);      // N4: 4 s senza tocchi
          };
          // N4 (25/11, telefono): al tocco il pannello si apre solo con .mostra e si chiude con il secondo tocco sul tasto, un tocco fuori,
          // lo scorrimento o 4 s senza tocchi; dopo il tocco il tasto perde il fuoco (niente :focus-within che lo tenga aperto)
          if (gusSuono) {
              let eraAperto = false;
              const chiudiPannello = () => { gusSuono.classList.remove('mostra'); if (timerPannello) { win.clearTimeout(timerPannello); timerPannello = 0; } };
              ascolta(doc, 'pointerdown', (e) => { eraAperto = gusSuono.classList.contains('mostra');
                  if (!eraAperto) return;
                  if (!gusSuono.contains(e.target)) chiudiPannello();
                  else if (!(tastoSuono && tastoSuono.contains(e.target))) mostraPannello(); }, { capture: true, passive: true });
              ascolta(win, 'scroll', () => { if (alTocco() && gusSuono.classList.contains('mostra')) chiudiPannello(); }, { passive: true });
              if (tastoSuono)
                  ascolta(tastoSuono, 'click', () => { if (!alTocco()) return; if (eraAperto) chiudiPannello(); dopo(() => { try { tastoSuono.blur(); } catch (x) { } }, 0); });
          }
          if (volSuono) {
              volSuono.value = String(Math.round(lim(Number(prefSuono.vol), 0, 1) * 100));
              suono.volume(Number(volSuono.value) / 100);
          }
          // N1.5 (notte 25/11): il contesto si riprende dentro il gesto (click e touchend); se dopo il tocco non gira ('suspended' o
          // 'interrupted' su iOS), il tasto torna a «Suono» e una riga dice di toccare di nuovo
          const notaSuono = q1('[data-suono-nonpartito]');
          const riprendiAudio = () => { try {
              if (actx && actx.state !== 'running' && actx.state !== 'closed')
                  actx.resume();
          }
          catch (e) { } };
          const controllaSuono = () => dopo(() => {
              const gira = !!(actx && actx.state === 'running');
              if (notaSuono)
                  notaSuono.hidden = gira || !suono.acceso;
              if (!gira && suono.acceso) {
                  suono.spegni();
                  mostraSuono('spento');
                  if (gusSuono)
                      gusSuono.classList.add('mostra');
                  if (notaSuono)
                      notaSuono.hidden = false;
              }
          }, 600);
          const accendiSuono = () => { if (suono.accendi()) {
              riprendiAudio();
              prefSuono.on = true;
              salvaPref(prefSuono);
              mostraSuono('acceso');
              mostraPannello();
              controllaSuono();
          } };
          if (tastoSuono)
              ascolta(tastoSuono, 'touchend', riprendiAudio, { passive: true });
          ascolta(doc, 'click', riprendiAudio, { passive: true, capture: true });
          const spegniSuono = () => { suono.spegni(); prefSuono.on = false; salvaPref(prefSuono); mostraSuono('spento'); if (gusSuono)
              gusSuono.classList.remove('mostra'); };
          // M3 (mattino 25/11): il suono e' acceso per impostazione predefinita (spento solo se l'hai spento: la scelta si ricorda). Parte
          // al caricamento se il browser lo permette, altrimenti al primo tocco, clic o tasto in qualunque punto, con 3 s di dissolvenza;
          // il tasto mostra subito lo stato acceso e serve a spegnere. Anche i suoni dei tasti sono attivi dal primo gesto
          mostraSuono(prefSuono.on ? 'acceso' : 'spento');
          if (prefSuono.on) {
              try {
                  suono.accendi();
              }
              catch (e) { }
          }
          let primoGesto = true;
          const avviaDalGesto = (e) => {
              if (!prefSuono.on || (e && e.target && e.target.closest && e.target.closest('[data-suono-tasto]') && suono.acceso && actx && actx.state === 'running'))
                  return;
              if (!suono.acceso)
                  suono.accendi();
              riprendiAudio();
              if (primoGesto) {
                  primoGesto = false;
                  controllaSuono();
              }
          };
          ['pointerdown', 'touchend', 'click', 'keydown'].forEach((ev) => ascolta(doc, ev, avviaDalGesto, { capture: true, passive: true }));
          if (volSuono)
              ascolta(volSuono, 'input', () => { const v = Number(volSuono.value) / 100; suono.volume(v); prefSuono.vol = v; salvaPref(prefSuono); mostraPannello(); });
          // la voce del servizio (vera_voce.js) abbassa il suono come la voce preparata
          ascolta(doc, 'vera-voce', (e) => { const t = e.detail && e.detail.tipo;
              if (t === 'voce_inizio')
                  suono.voce(true);
              else if (t === 'voce_fine' || t === 'voce_non_disponibile')
                  suono.voce(false);
              segueVoceViva(e.detail || {}); });
          ascolta(doc, 'visibilitychange', () => suono.nascosto(doc.hidden));
          let ultimoPassato = null;
          ascolta(root, 'pointerover', (e) => {
              const c = e.target && e.target.closest ? e.target.closest('.tasto, .tasto-doppio, .sugg, .invia, .voce, .nav-voce, .chiave, .sc-tasto, .conto-annulla, .avviso-tasto, .nav-suono') : null;
              if (c && c !== ultimoPassato)
                  suono.evento('passa');
              ultimoPassato = c;
          });
          const ATTESA_INVIO = 1500;
          let invio = null;
          let contoFraz = 0;
          const fermaConto = () => {
              if (invio && invio.timer)
                  win.clearInterval(invio.timer);
              invio = null;
              contoFraz = 0;
              if (nodo.domanda)
                  nodo.domanda.classList.remove('da-inviare', 'in-correzione');
          };
          const NOTA_BASE = notaCore ? notaCore.textContent : '';
          const ANELLO_BASE = ANELLO('pronta');
          const VEL_MUTO = 1.7;
          let CATALOGO = null;
          let voceAttiva = !voceSpentaPrima && !!q1('[data-voce-toggle]');
          root.__voceAccesa = voceAttiva;
          let statoC = 'pronta';
          let satAttivo = null;
          let anelloTesto = ANELLO_BASE;
          let genV = 0;
          let clip = null;
          let ampV = 0;
          let filo = null;
          let filoA = 0;
          let actx = null;
          let analizzatore = null;
          let bufA = null;
          let sorgente = null;
          let timerNota = 0;
          const ETI = STATI;
          const impostaStato = (s) => { const prima = statoC; statoC = s; if (statoEl) {
              statoEl.textContent = ETI[s] || s;
              statoEl.setAttribute('data-s', s);
          } suono.stato(s); };
          const avvisa = (msg, simula) => {
              if (annuncio)
                  annuncio.textContent = msg;
              if (!avvisoEl || !avvisoTesto || !percorso)
                  return;
              avvisoTesto.textContent = msg;
              avvisoEl.classList.toggle('con-simula', !!simula);
              percorso.classList.add('con-avviso');
              if (timerNota)
                  win.clearTimeout(timerNota);
              timerNota = dopo(() => { percorso.classList.remove('con-avviso'); avvisoEl.classList.remove('con-simula'); }, simula ? 16000 : 9000);
          };
          const preparaAudio = () => {
              if (actx)
                  return;
              // N1.5 (notte 25/11): su iOS il suono della pagina segue il canale della riproduzione, non quello delle suonerie
              try {
                  if (win.navigator.audioSession)
                      win.navigator.audioSession.type = 'playback';
              }
              catch (e) { }
              try {
                  const AC = win.AudioContext || win.webkitAudioContext;
                  if (!AC)
                      return;
                  actx = new AC();
                  this._actx = actx;
                  root.__actx = actx;      // M3: per la prova dello stato del contesto
                  // N1.5: iOS puo' interrompere il suono (una chiamata, un altro audio): il tasto lo dice e si riprende al tocco
                  actx.addEventListener('statechange', () => {
                      if (!suono.acceso)
                          return;
                      if (actx.state === 'interrupted' || actx.state === 'suspended') {
                          mostraSuono('riprendi');
                          if (notaSuono)
                              notaSuono.hidden = false;
                      }
                      else if (actx.state === 'running') {
                          mostraSuono('acceso');
                          if (notaSuono)
                              notaSuono.hidden = true;
                      }
                  });
                  analizzatore = actx.createAnalyser();
                  analizzatore.fftSize = 1024;
                  analizzatore.smoothingTimeConstant = 0.35;
                  analizzatore.connect(actx.destination);
                  bufA = new Float32Array(analizzatore.fftSize);
              }
              catch (e) {
                  actx = null;
                  analizzatore = null;
              }
          };
          const livello = (an, buf) => {
              if (!an || !buf)
                  return 0;
              an.getFloatTimeDomainData(buf);
              let s = 0;
              for (let i = 0; i < buf.length; i += 2)
                  s += buf[i] * buf[i];
              return Math.min(1, Math.sqrt(s / (buf.length / 2)) * 5.2);
          };
          const tempoClip = (c) => {
              if (c.modo === 'viva') {         // P1: il tempo e' quello della parola che la voce vera sta dicendo
                  const pa = c.d.parole || [], k = c.d.viva.k;
                  return k >= 0 && pa[k] ? pa[k][1] : -1;
              }
              if (c.attesa)
                  return 0;
              if (c.pausa)
                  return c.tPausa || 0;
              if (c.modo === 'buffer' && actx)
                  return Math.max(0, actx.currentTime - c.t0);
              if (c.modo === 'elemento' && voceEl)
                  return voceEl.currentTime || 0;
              return ((win.performance.now() - c.inizio) / 1000) * c.vel;
          };
          const fermaSuono = () => {
              suono.voce(false);
              if (sorgente) {
                  try {
                      sorgente.onended = null;
                      sorgente.stop();
                  }
                  catch (e) { }
                  sorgente = null;
              }
              if (voceEl) {
                  try {
                      voceEl.pause();
                  }
                  catch (e) { }
              }
          };
          this._fermaVoce = fermaSuono;
          const fermaClip = () => { fermaSuono(); clip = null; };
          const suonaElemento = (c) => {
              if (!voceEl || !c.d.url)
                  return;
              voceEl.src = c.d.url;
              c.modo = 'elemento';
              c.inizio = win.performance.now();
              const pr = voceEl.play();
              if (pr && pr.then)
                  pr.then(() => { if (clip === c) {
                      suono.voce(true);
                  } }, () => { if (clip === c) {
                      c.modo = 'tempo';
                      c.vel = 1;
                      c.inizio = win.performance.now();
                  } });
          };
          // N1.7 (notte 25/11): la voce suona da un solo elemento audio (data-voce-vera), sbloccato nel tocco che accende la voce e
          // riusato per ogni risposta (anche per la voce dal vivo di vera_voce.js). Il testo aspetta l'audio fino a 6 s, poi partono
          // insieme; se l'audio non parte, una riga lo dice («tocca per riprovare») e il testo scorre comunque. La sfera segue il tempo.
          const ATTESA_VOCE = 6000;
          const rigaVoce = q1('[data-voce-riprova]');
          const mostraRigaVoce = (si) => { if (rigaVoce)
              rigaVoce.hidden = !si; };
          const precaricaVoce = (url) => {
              if (!voceEl || !url)
                  return;
              const pieno = new URL(url, doc.baseURI).href;
              if (voceEl.src !== pieno) {
                  voceEl.preload = 'auto';
                  voceEl.src = url;
                  try {
                      voceEl.load();
                  }
                  catch (e) { }
              }
          };
          const sbloccaVoce = () => {      // dentro un gesto: un istante di silenzio sblocca l elemento (iOS)
              if (!voceEl || voceEl.dataset.sbloccato)
                  return;
              try {
                  voceEl.src = SILENZIO;
                  const pr = voceEl.play();
                  voceEl.dataset.sbloccato = '1';
                  if (pr && pr.then)
                      pr.then(() => { try {
                          if (voceEl.src === SILENZIO)
                              voceEl.pause();
                      }
                      catch (e) { } }, () => { delete voceEl.dataset.sbloccato; });
              }
              catch (e) { }
          };
          // M4: nel gesto che manda la domanda l'elemento parte muto con l'audio della risposta e si ferma subito: e' sbloccato
          // (iOS) e gia' caricato; la voce poi parte quando la domanda ha finito di comparire, senza altri tocchi
          const sbloccaCon = (url) => {
              if (!voceEl || !url)
                  return;
              try {
                  precaricaVoce(url);
                  voceEl.muted = true;
                  const pr = voceEl.play();
                  voceEl.dataset.sbloccato = '1';
                  const torna = () => { try {
                      if (voceEl.muted) {
                          voceEl.pause();
                          voceEl.currentTime = 0;
                          voceEl.muted = false;
                      }
                  }
                  catch (e) { } };
                  if (pr && pr.then)
                      pr.then(torna, () => { voceEl.muted = false; });
                  else
                      torna();
              }
              catch (e) {
                  voceEl.muted = false;
              }
          };
          const partiVoce = (c) => {
              c.attesa = false;
              c.inizio = win.performance.now();
              if (!voceAttiva) {
                  c.modo = 'tempo';
                  c.vel = VEL_MUTO;
                  return;
              }
              let pr = null;
              try {
                  voceEl.muted = false;
                  voceEl.currentTime = 0;
                  pr = voceEl.play();
              }
              catch (e) { pr = Promise.reject(e); }
              c.modo = 'elemento';
              const no = () => { if (clip === c && c.modo === 'elemento') {
                  c.modo = 'tempo';
                  c.vel = 1;
                  c.inizio = win.performance.now() - (voceEl.currentTime || 0) * 1000;
                  mostraRigaVoce(true);
              } };
              const gv = genV;      // U3: se nel frattempo la risposta e' stata chiusa o cambiata, l'audio si ferma
              if (pr && pr.then)
                  pr.then(() => { if (clip === c && gv === genV) {
                      suono.voce(true);
                      mostraRigaVoce(false);
                  }
                  else {
                      try {
                          voceEl.pause();
                      }
                      catch (x) { }
                  } }, no);
          };
          // P1 (25/11): la risposta dal vivo con la voce in arrivo. rispostaViva.viva = { offs, n, k, finita, nd }: offs e n per frase
          // (dalle parole della risposta), k = ultima parola detta dalla voce vera. Solo con voce_non_disponibile si torna al tempo stimato
          let rispostaViva = null;
          const vivaATempo = (c) => {
              const pa = c.d.parole || [], k = Math.max(0, c.d.viva.k);
              c.modo = 'tempo';
              c.vel = 1;
              c.inizio = win.performance.now() - (pa[k] ? pa[k][1] : 0) * 1000;
          };
          const segueVoceViva = (x) => {
              const e = rispostaViva;
              if (!e || !e.viva)
                  return;
              const v = e.viva, i = Number(x.indice);
              if (x.tipo === 'voce_inizio' && Number.isFinite(i) && v.offs[i] !== undefined)
                  v.k = Math.max(v.k, v.offs[i]);
              else if (x.tipo === 'voce_parola' && Number.isFinite(i) && v.offs[i] !== undefined)
                  v.k = Math.max(v.k, v.offs[i] + Math.min(Math.max(0, Number(x.n) || 0), v.n[i] - 1));
              else if (x.tipo === 'voce_fine') {
                  if (x.interrotta === false) {
                      v.k = (e.parole || []).length - 1;
                      v.finita = true;
                  }
                  else if (clip && clip.d === e && clip.modo === 'viva')
                      vivaATempo(clip);
                  rispostaViva = null;
              }
              else if (x.tipo === 'voce_non_disponibile') {
                  v.nd = true;
                  if (clip && clip.d === e && clip.modo === 'viva')
                      vivaATempo(clip);
              }
          };
          const avviaClip = (d, onParola, fine) => {
              if (d && d.viva) {         // P1 (25/11): la voce del servizio di QUESTA risposta non si mette in pausa
                  if (sorgente) {
                      try {
                          sorgente.onended = null;
                          sorgente.stop();
                      }
                      catch (e) { }
                      sorgente = null;
                  }
                  clip = null;
              }
              else
                  fermaClip();
              mostraRigaVoce(false);
              if (!d) {
                  if (fine)
                      fine();
                  return;
              }
              if (!voceAttiva && cinema() && scena && scena.aperta)
                  d = cadenzaRC(d);
              const c = { d, onParola, fine, k: -1, inizio: win.performance.now(), modo: 'tempo', vel: voceAttiva || d.cadenza ? 1 : VEL_MUTO, finita: false, attesa: false, t0: 0 };
              clip = c;
              impostaStato('parla');
              if (d.viva) {             // P1: le parole seguono la voce vera (voce_inizio, voce_parola, voce_fine del widget)
                  c.modo = 'viva';
                  c.vel = 1;
                  if (d.viva.nd)
                      vivaATempo(c);
                  else
                      d.viva.limite = dopo(() => { if (clip === c && c.modo === 'viva' && d.viva.k < 0) vivaATempo(c); }, 6000);
                  return;
              }
              if (!voceAttiva || !d.url || !voceEl)
                  return;
              precaricaVoce(d.url);
              if (voceEl.readyState >= 3) {        // abbastanza dati: si parte subito
                  partiVoce(c);
                  return;
              }
              c.attesa = true;                     // il testo aspetta l'audio, fino a 6 s
              const pronta = () => { if (clip === c && c.attesa) {
                  win.clearTimeout(limite);
                  partiVoce(c);
              } };
              const limite = dopo(() => { if (clip === c && c.attesa) {
                  voceEl.removeEventListener('canplay', pronta);
                  c.attesa = false;
                  c.modo = 'tempo';
                  c.vel = 1;
                  c.inizio = win.performance.now();
                  mostraRigaVoce(true);
              } }, ATTESA_VOCE);
              voceEl.addEventListener('canplay', pronta, { once: true });
          };
          if (rigaVoce)       // «tocca per riprovare»: dentro il tocco, l'audio riparte dal punto del testo
              ascolta(rigaVoce, 'click', () => {
                  const c = clip;
                  if (!c || !c.d || !c.d.url || !voceEl)
                      return;
                  voceAttiva = true;
                  precaricaVoce(c.d.url);
                  try {
                      voceEl.currentTime = Math.max(0, tempoClip(c));
                  }
                  catch (e) { }
                  const pr = voceEl.play();
                  if (pr && pr.then)
                      pr.then(() => { if (clip === c) {
                          c.modo = 'elemento';
                          c.attesa = false;
                          mostraRigaVoce(false);
                          suono.voce(true);
                      } }, () => { });
              });
          if (voceEl)
              ascolta(voceEl, 'ended', () => { if (clip && clip.modo === 'elemento')
                  clip.finita = true; });
          const passoVera = (dt) => {
              if (clip && clip.pausa)
                  ampV += (0 - ampV) * (1 - Math.exp(-dt * 8));
              else if (clip) {
                  const c = clip;
                  const tc = tempoClip(c);
                  const pa = c.d.parole || [];
                  let k = c.k;
                  while (k + 1 < pa.length && pa[k + 1][1] <= tc)
                      k++;
                  if (k !== c.k) {
                      c.k = k;
                      if (c.onParola)
                          c.onParola(k + 1);
                  }
                  const dur = c.d.durata || 0;
                  const scaduto = !c.attesa && win.performance.now() - c.inizio > (dur / (c.vel || 1) + 4) * 1000;
                  const finito = c.modo === 'tempo' ? tc >= dur : c.modo === 'viva' ? !!c.d.viva.finita : (c.finita || tc >= dur + 0.3 || scaduto);
                  // N1.7: con l'elemento audio la sfera segue il tempo delle parole (nessun analizzatore: su iOS da' problemi)
                  const w = pa[k], inParola = !!(w && tc >= w[1] && tc <= (w[2] || w[1] + 0.3));
                  const ampT = c.attesa ? 0.06 : (c.modo === 'buffer' && analizzatore ? livello(analizzatore, bufA) : c.modo === 'elemento' ? (inParola ? 0.13 : 0.05) : 0.04);
                  ampV += (ampT - ampV) * (1 - Math.exp(-dt * 22));
                  if (finito) {
                      clip = null;
                      suono.voce(false);
                      if (voceAttiva && c.modo !== 'tempo')
                      if (c.onParola)
                          c.onParola(pa.length);
                      if (c.fine)
                          c.fine();
                  }
              }
              else
                  ampV += (0 - ampV) * (1 - Math.exp(-dt * 8));
              filoA += ((filo ? 1 : 0) - filoA) * (1 - Math.exp(-dt * 5));
          };
          const scriviParole = (el, d) => (k) => {
              if (!el)
                  return;
              const pa = d.parole || [];
              const segui = percorso && percorso.scrollHeight - percorso.scrollTop - percorso.clientHeight < 48;
              el.textContent = !pa.length || k >= pa.length ? (k > 0 || !pa.length ? d.testo : '') : pa.slice(0, k).map((p) => p[0]).join(' ');
              if (segui)
                  percorso.scrollTop = percorso.scrollHeight;
              if (el.scrollHeight > el.clientHeight + 2) {
                  el.scrollTop = el.scrollHeight;
                  el.classList.toggle('lunga', el.scrollTop > 2);
              }
              else
                  el.classList.remove('lunga');
          };
          if (nT.risposta)
              ascolta(nT.risposta, 'scroll', () => nT.risposta.classList.toggle('lunga', nT.risposta.scrollTop > 2));
          const posaFilo = (k) => {
              if (!telaFinale || !nodo[k] || !percorso || !nodo[k].classList.contains('visto'))
                  return;
              if (tuffo.f && tuffo.f.modo === 'camera')
                  return;
              const cr = (telaFinale.parentElement || telaFinale).getBoundingClientRect();
              const nr = nodo[k].getBoundingClientRect();
              const pr = percorso.getBoundingClientRect();
              const vis = NODI.map((x) => nodo[x]).filter((x) => x && x.classList.contains('visto') && x.offsetParent !== null);
              const ya = vis.length ? vis[0].getBoundingClientRect().top + 17.5 : nr.top + 17.5, yb = vis.length ? vis[vis.length - 1].getBoundingClientRect().top + 17.5 : ya;
              const y = Math.max(pr.top + 12, Math.min(pr.bottom - 12, (ya + yb) / 2));
              filo = { x: pr.left - cr.left + 7.5, y: y - cr.top, k };
          };
          const aggiornaLinea = () => {
              if (!percorso)
                  return;
              const vis = NODI.map((k) => nodo[k]).filter((x) => x && x.classList.contains('visto') && x.offsetParent !== null);
              if (!vis.length) {
                  percorso.style.setProperty('--lp', '0px');
                  return;
              }
              const att = vis.filter((x) => x.classList.contains('attivo')).pop() || vis[vis.length - 1];
              const t0 = vis[0].offsetTop + 17;
              const t1 = att.offsetTop + 17;
              percorso.style.setProperty('--lt', t0 + 'px');
              percorso.style.setProperty('--lp', Math.max(0, t1 - t0) + 'px');
          };
          const mostraNodo = (k) => {
              const idx = NODI.indexOf(k);
              NODI.forEach((x, i) => {
                  const n = nodo[x];
                  if (!n)
                      return;
                  if (x === k) {
                      n.classList.add('visto', 'attivo');
                      n.classList.remove('passato');
                  }
                  else {
                      n.classList.remove('attivo');
                      if (i < idx && x !== 'risposta' && n.classList.contains('visto'))
                          n.classList.add('passato');
                  }
              });
              if (percorso)
                  percorso.classList.add('pieno');
              aggiornaLinea();
              posaFilo(k);
              win.requestAnimationFrame(() => { aggiornaLinea(); if (percorso) {
                  if (fermo)
                      percorso.scrollTop = percorso.scrollHeight;
                  else
                      percorso.scrollTo({ top: percorso.scrollHeight, behavior: 'smooth' });
              } posaFilo(k); });
          };
          const pulisciPercorso = () => {
              if (percorso)
                  percorso.classList.remove('rc-sotto');
              NODI.forEach((x) => { if (nodo[x])
                  nodo[x].classList.remove('visto', 'attivo', 'passato'); });
              ['domanda', 'presa', 'fonte', 'impronta', 'risposta', 'esito'].forEach((x) => { if (nT[x]) {
                  if (nT[x].__mx) {
                      win.clearInterval(nT[x].__mx);
                      nT[x].__mx = 0;
                  }
                  nT[x].textContent = '';
                  nT[x].removeAttribute('data-testo');
              } });
              if (nT.risposta)
                  nT.risposta.classList.remove('lunga');
              if (nT.domanda)
                  nT.domanda.removeAttribute('title');
              fermaConto();
              if (percorso) {
                  percorso.style.setProperty('--lp', '0px');
                  percorso.classList.remove('pieno', 'con-avviso');
              }
              filo = null;
              rifiutoAttivo = false;
              kParola = 0;
              if (scena && scena.aperta)
                  scena.chiudi(false);
          };
          const satDaTipo = (tipo) => ({ FONTE: 'EVIDENZE', DATO: 'DATI', CALCOLO: 'METODO', INFERENZA: 'METODO', 'NON VERIFICATO': 'VERIFICATORE' })[tipo] || 'EVIDENZE';
          const scriviDomanda = (testo, g, via) => {
              mostraNodo('domanda');
              if (nT.via)
                  nT.via.textContent = via;
              if (!nT.domanda)
                  return;
              nT.domanda.setAttribute('title', testo);
              batti(nT.domanda, testo, 16);
          };
          const chiudi = (testoEsito, tipo, g, testoRisposta) => {
              if (g !== genV)
                  return;
              mostraNodo('esito');
              if (nT.esito)
                  nT.esito.textContent = testoEsito;
              if (nT.tipo)
                  nT.tipo.textContent = tipo;
              if (scena && scena.aperta)
                  scena.esito(testoEsito, tipo);
              suono.evento(tipo === 'Rifiuto' ? 'rifiuto' : 'verificato');
              if (annuncio && testoRisposta)
                  annuncio.textContent = NOME + ': ' + testoRisposta;
              satAttivo = 'VERIFICATORE';
              impostaStato('pronta');
              anelloTesto = ANELLO_BASE;
              dopo(() => { if (g === genV) {
                  satAttivo = null;
                  NODI.forEach((x) => { if (nodo[x])
                      nodo[x].classList.remove('attivo'); });
              } }, 2600);
          };
          // U3 (ultimo giro 25/11): una sola macchina a stati per la risposta, con il numero di generazione genV (aprire e chiudere lo
          // aumentano; ogni seguito asincrono lo controlla). Un'apertura chiesta mentre la risposta si sta chiudendo parte quando la
          // chiusura e' finita (solo l'ultima chiesta)
          let chiusaFino = 0, inCoda = 0;
          // H3: le proposte sotto un rifiuto per mancanza di fatti: lo stesso filtro dell'elenco (sulle parole di almeno 4 lettere),
          // altrimenti le prime tre domande suggerite del sito
          const MANCANO_FATTI = ['nessuna_frase_verificata', 'prove_insufficienti', 'fuori_tema'];
          const togliProposte = () => qq('.rc-proposte').forEach((x) => x.remove());
          const mostraProposte = (dom) => {
              const storie = q1('[data-storie]');
              if (!storie)
                  return;
              const norm = (x) => String(x || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
              const parole = norm(dom).split(' ').filter((w) => w.length >= 4);
              const voci = qq('.elenco-domande [data-chiedi-id]');
              let ids = parole.length ? voci.filter((b) => parole.every((w) => norm(b.textContent).includes(w))).map((b) => b.getAttribute('data-chiedi-id')) : [];
              if (!ids.length) {
                  const sv = doc.querySelector('section.vera');
                  ids = String(sv ? sv.getAttribute('data-suggerite') || '' : '').split(',').filter(Boolean);
              }
              ids = ids.filter((x, i) => ids.indexOf(x) === i && CATALOGO && CATALOGO.per_id && CATALOGO.per_id[x]).slice(0, 3);
              if (!ids.length)
                  return;
              const box = doc.createElement('div');
              box.className = 'rc-proposte';
              const t = doc.createElement('p');
              t.className = 'rc-proposte-titolo';
              t.textContent = String(PR.posso_risponderti || '');
              box.appendChild(t);
              ids.forEach((id) => { const bt = doc.createElement('button'); bt.type = 'button'; bt.className = 'rc-proposta';
                  bt.setAttribute('data-chiedi-id', id); bt.textContent = CATALOGO.per_id[id].domanda; box.appendChild(bt); });
              storie.appendChild(box);
          };
          const chiediVera = (testo, id, via, originale) => {
              togliProposte();
              const resta = chiusaFino - win.performance.now();
              if (resta > 0) {
                  const q = ++inCoda;
                  dopo(() => { if (q === inCoda) {
                      chiusaFino = 0;
                      chiediVera(testo, id, via, originale);
                  } }, resta + 30);
                  return;
              }
              if (id && voceAttiva && AUDIO[id] && AUDIO[id].file)     // N1.7 e M4: l audio si sblocca e si carica gia nel tocco sulla domanda
                  sbloccaCon(AUDIO[id].file);
              else if (voceAttiva)
                  sbloccaVoce();
              if (voceAttiva) {
                  voceServizio(true);
                  preparaAudio();
              }
              if (!CATALOGO) {
                  avvisa((PAROLE.stati_js || {}).caricamento || '');
                  return;
              }
              const g = ++genV;
              fermaClip();
              pulisciPercorso();
              satAttivo = null;
              attesaViva = null;
              if (fusEl)
                  fusEl.textContent = '';
              if (id) {
                  const c = CATALOGO.per_id[id];
                  if (!c)
                      return;
                  fermaVoceServizio();
                  const f = (c.fonti || [])[0] || null;
                  const esito = (PR.esiti || {}).preparata || '';
                  const frasi = c.frasi && c.frasi.length ? c.frasi.map((x) => x.testo) : dividiFrasi(c.risposta);
                  const e = nuovaRisposta({ domanda: originale || c.domanda, frasi, tipo: c.tipo, classe: tipoClasse(c.tipo), fonte: f, esito,
                      nota: [PR.nota_preparata, c.riga_fonti].filter(Boolean).join(' · '), audio: voceAttiva ? AUDIO[id] : null });
                  scriviDomanda(originale || c.domanda, g, via || '');
                  impostaStato('preparata');
                  anelloTesto = ANELLO('risposta');
                  dopo(() => { if (g === genV)
                      mostraFonte(e, f, g, esito); }, 420);
                  return;
              }
              const domanda = String(testo || '').trim();
              const campo = sezVera ? sezVera.querySelector('#vera-domanda') : null;
              const modulo = campo ? campo.form : null;
              if (!domanda || !campo || !modulo)
                  return;
              scriviDomanda(domanda, g, via || '');
              impostaStato('inviata');
              anelloTesto = ANELLO('inviata');
              attesaViva = { g, domanda, fonte: null };
              trattieniVoce(true);       // P2 (25/11): la voce del servizio aspetta che la risposta cominci a essere detta
              campo.value = domanda;
              try {
                  campo.dispatchEvent(new Event('input', { bubbles: true }));
              }
              catch (x) { }
              if (modulo.requestSubmit)
                  modulo.requestSubmit();
              else
                  modulo.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
          };
          // N5 (25/11, telefono): ingresso con il suono (proposte.ingresso_con_suono). Alla fine dell'apertura «Entra» (grande) e «Entra
          // senza suono» (piccolo); la pagina non scorre finche' non si entra. «Entra» sblocca l'audio dentro il tocco e accende suono,
          // effetti e voce; «Entra senza suono» li spegne. Una volta per sessione: tornando da una pagina interna non si ripete
          const giaEntrato = () => { try { return win.sessionStorage.getItem('v32-entrato') === '1'; } catch (e) { return false; } };
          if (PAROLE.ingresso_con_suono && alTocco() && !giaEntrato()) {      // al tocco: e' li' che l'audio aspetta un tocco
              const PI = PAROLE.ingresso || {};
              const porta = doc.createElement('div'); porta.className = 'ingresso'; porta.setAttribute('role', 'group');
              const bE = doc.createElement('button'); bE.type = 'button'; bE.className = 'ingresso-entra'; bE.textContent = PI.entra || '';
              const bM = doc.createElement('button'); bM.type = 'button'; bM.className = 'ingresso-muto'; bM.textContent = PI.senza_suono || '';
              porta.appendChild(bE); porta.appendChild(bM); root.appendChild(porta);
              doc.documentElement.classList.add('ingresso-chiuso');
              const ferma = (e) => { if (e.target && e.target.closest && e.target.closest('.ingresso')) return; e.preventDefault(); e.stopImmediatePropagation(); };
              const tasti = (e) => { if (!(e.target && e.target.closest && e.target.closest('.ingresso')) && [' ', 'PageDown', 'PageUp', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) { e.preventDefault(); e.stopImmediatePropagation(); } };
              win.addEventListener('wheel', ferma, { passive: false, capture: true });
              win.addEventListener('touchmove', ferma, { passive: false, capture: true });
              win.addEventListener('keydown', tasti, { capture: true });
              const entra = (conSuono) => {
                  try { win.sessionStorage.setItem('v32-entrato', '1'); } catch (e) { }
                  win.removeEventListener('wheel', ferma, { capture: true });
                  win.removeEventListener('touchmove', ferma, { capture: true });
                  win.removeEventListener('keydown', tasti, { capture: true });
                  doc.documentElement.classList.remove('ingresso-chiuso');
                  porta.classList.remove('pronto');
                  dopo(() => porta.remove(), 420);
                  if (conSuono) {
                      preparaAudio();
                      try { if (actx && actx.resume) actx.resume(); } catch (e) { }
                      prefSuono.on = true;
                      salvaPref(prefSuono);
                      try { suono.accendi(); } catch (e) { }
                      mostraSuono('acceso');
                      if (!voceAttiva) cambiaVoce();
                  }
                  else {
                      spegniSuono();
                      if (voceAttiva) cambiaVoce();
                  }
              };
              ascolta(bE, 'click', () => entra(true));
              ascolta(bM, 'click', () => entra(false));
              dopo(() => { porta.classList.add('pronto'); try { bE.focus({ preventScroll: true }); } catch (e) { } }, fermo ? 0 : 1800);
              root.__ingresso = porta;
          }
          const cambiaVoce = () => {
              voceAttiva = !voceAttiva;
              root.__voceAccesa = voceAttiva;
              voceServizio(false);
              if (tastoVoce)
                  tastoVoce.setAttribute('aria-pressed', voceAttiva ? 'true' : 'false');
              if (voceEti)
                  voceEti.textContent = ((PC.voce || {})[voceAttiva ? 'accesa' : 'attiva']) || '';
              try {
                  win.localStorage.setItem(PREF_VOCE, voceAttiva ? '1' : '0');      // M4: la scelta si ricorda
              }
              catch (e) { }
              if (voceAttiva) {
                  sbloccaVoce();
                  preparaAudio();
                  try {
                      if (actx && actx.state === 'suspended')
                          actx.resume();
                  }
                  catch (e) { }
              }
              else if (clip) {
                  const tc = tempoClip(clip);
                  fermaSuono();
                  clip.modo = 'tempo';
                  clip.attesa = false;
                  clip.vel = 1;
                  clip.inizio = win.performance.now() - tc * 1000;
              }
          };
          if (inputCore)
              ascolta(inputCore, 'input', () => {
                  const inCorrezione = nodo.domanda && nodo.domanda.classList.contains('in-correzione');
                  if (!invio && !inCorrezione)
                      return;
                  if (invio) {
                      if (invio.timer)
                          win.clearInterval(invio.timer);
                      invio = null;
                      contoFraz = 0;
                      if (nodo.domanda) {
                          nodo.domanda.classList.remove('da-inviare');
                          nodo.domanda.classList.add('in-correzione');
                      }
                      if (contoTesto)
                          contoTesto.textContent = '';
                      if (nT.via)
                          nT.via.textContent = '';
                      anelloTesto = ANELLO_BASE;
                      if (annuncio)
                          annuncio.textContent = '';
                  }
                  if (nT.domanda) {
                      nT.domanda.textContent = inputCore.value;
                      nT.domanda.setAttribute('title', inputCore.value);
                  }
              });
          const ferma = () => {
              if (clip && nodo.risposta && nodo.risposta.classList.contains('attivo')) {
                  const c = clip;
                  fermaSuono();
                  clip = null;
                
                  if (scena && scena.aperta)
                      scena.interrotta();
                  if (c.onParola)
                      c.onParola((c.d.parole || []).length);
                  if (c.fine)
                      c.fine();
                  return true;
              }
              if (statoC !== 'pronta') {
                  genV++;
                  fermaClip();
                  pulisciPercorso();
                  impostaStato('pronta');
                  anelloTesto = ANELLO_BASE;
                  satAttivo = null;
                  avvisa('');
                  return true;
              }
              if (scena && scena.aperta) {
                  scena.chiudi(false);
                  return true;
              }
              return false;
          };
          // M5 (mattino 25/11): «Torna al Neural Core» ed Esc chiudono sempre, in qualunque momento: fermano voce e testo e riportano
          // al campo della domanda («Testo intero» resta solo nel menù)
          // S1 (25/11): chiudiRisposta(true) = uscita subito (sezione fuori schermo, voce del menu', gesto): niente animazione, niente fuoco
          const chiudiRisposta = (subito) => {
              const aperta = !!((scena && scena.aperta) || clip || statoC !== 'pronta');
              genV++;
              if (subito === true && scena && scena.aperta) {     // S1: prima di tutto la scena, senza animazione
                  scena.chiudi(true);
                  chiusaFino = 0;
              }
              if (subito === true && attesaViva) {      // S1: la risposta dal vivo lasciata a meta' non deve piu' parlare (fino alla prossima domanda)
                  const sez = doc.querySelector('section.vera');
                  if (sez && win.VeraVoce && win.VeraVoce.zittisci)
                      win.VeraVoce.zittisci(sez, true);
              }
              attesaViva = null;
              rispostaViva = null;
              try {
                  if (clip && clip.pausa)
                      riprendiClip();
              }
              catch (x) { }
              try {
                  fermaSuono();
                  fermaClip();
              }
              catch (x) { }
              clip = null;
              try {
                  fermaVoceServizio();
                  trattieniVoce(false);      // giro completo: si rilascia la coda solo dopo aver fermato il turno (niente file gia' tolti da caricare)
              }
              catch (x) { }
              try {
                  if (voceEl && !voceEl.paused)
                      voceEl.pause();
              }
              catch (x) { }
              suono.voce(false);
              mostraRigaVoce(false);
              if (statoC !== 'pronta') {
                  pulisciPercorso();
                  impostaStato('pronta');
                  anelloTesto = ANELLO_BASE;
                  satAttivo = null;
                  avvisa('');
              }
              inCoda++;                 // U3: un'apertura in coda viene annullata dalla chiusura
              if (scena && scena.aperta) {
                  scena.chiudi(subito === true);
                  chiusaFino = subito === true ? 0 : win.performance.now() + TEMPI_RC.tuffoUscita * (root.__tuffoScala || 1);
              }
              const rcEl = q1('[data-racconto]');
              if (rcEl)
                  rcEl.classList.remove('in-pausa', 'intero');
              if (subito === true && doc.activeElement === inputCore)
                  inputCore.blur();
              if (inputCore && !alTocco() && subito !== true) {     // N2 (25/11): al tocco il fuoco non torna sul campo (la tastiera non si apre e la pagina restava ferma)
                  try {
                      inputCore.focus({ preventScroll: true });
                  }
                  catch (x) { }
              }
              return aperta;
          };
          // S1 (25/11): si esce subito dal Neural Core che risponde quando la sezione esce dallo schermo (meno del 25% visibile), con una
          // voce del menu', con il tasto di chiusura o con un gesto di scorrimento che non scorre niente dentro la risposta
          const rispostaAttiva = () => !!((scena && scena.aperta) || clip || statoC !== 'pronta');
          root.__s1 = () => ({ aperta: !!(scena && scena.aperta), clip: !!clip, stato: statoC, tuffo: tuffo ? { p: tuffo.p, attivo: tuffo.attivo } : null });
          const sezCoreS1 = doc.getElementById('core');
          ascolta(doc, 'click', (e) => { const a = e.target && e.target.closest ? e.target.closest('.nav-guscio a, [data-vai], [data-va]') : null;
              if (a && rispostaAttiva())
                  chiudiRisposta(true); }, { capture: true });
          let codaS1 = false;
          const fuoriCore = () => { codaS1 = false; if (!sezCoreS1 || !rispostaAttiva())
              return; const r = sezCoreS1.getBoundingClientRect(), H = win.innerHeight;
              if (Math.max(0, Math.min(r.bottom, H) - Math.max(r.top, 0)) / H < 0.25)
                  chiudiRisposta(true); };
          ascolta(win, 'scroll', () => { if (!codaS1) {
              codaS1 = true;
              win.requestAnimationFrame(fuoriCore);
          } }, { passive: true });
          const scorreDentro = (t) => { for (let n = t; n && n !== doc.body && n.nodeType === 1; n = n.parentElement) {
              const o = win.getComputedStyle(n).overflowY;
              if ((o === 'auto' || o === 'scroll') && n.scrollHeight > n.clientHeight + 2)
                  return true;
          } return false; };
          ['wheel', 'touchmove'].forEach((ev) => ascolta(win, ev, (e) => { if (scena && scena.aperta && !scorreDentro(e.target))
              chiudiRisposta(true); }, { passive: true }));
          ascolta(root, 'keydown', (e) => { if (e.key === 'Escape' && !elencoAperto() && chiudiRisposta())
              e.preventDefault(); });
          // U4 e K1-K7 (25/11; decisione del gruppo del 25/11, 09:00): la domanda a voce con il riconoscimento vocale del browser. Il
          // tasto esiste solo se il browser ha il riconoscimento e se proposte.domanda_a_voce e' acceso. Un tocco avvia UN ascolto
          // (it-IT, continuous false, risultati parziali nel campo); mai ascolto continuo, nessuna parola che lo accenda da sola, nessuna
          // registrazione: al servizio va solo il testo. La fine la decidiamo noi (1,8 s senza parole nuove, 7 s senza risultati, 15 s
          // in tutto) e lo stato si azzera sempre (1,5 s dopo stop() anche senza onend); un numero di generazione scarta i seguiti
          // in ritardo. Alla fine, se nel campo c'e' testo riconosciuto (anche solo parziale), la domanda parte dopo 0,8 s.
          const Riconoscitore = PAROLE.microfono_acceso ? (win.SpeechRecognition || win.webkitSpeechRecognition) : null;
          const PM = PC.microfono || {};
          let tastoMic = null, notaMic = null, rigaMic = null, ascoltoMic = null, testoMic = '', genMic = 0, fineMicT = 0;
          let tSilenzio = 0, tNiente = 0, tMax = 0, tFine = 0;
          const PREF_MIC = 'ncb.mic.v1';
          // L1: gli impulsi della sfera vengono solo da eventi veri: parole nuove dal riconoscimento, tasti premuti nel campo (al
          // massimo uno ogni 120 ms)
          let impulsiMic = 0, impulsiTasti = 0, ultimoTasto = 0, attentaFino = 0;
          ascolta(root, 'vera-mic', (e) => { if (e.detail && e.detail.tipo === 'risultato')
              impulsiMic++; });
          if (inputCore)
              ascolta(inputCore, 'keydown', () => { const ora = win.performance.now(); attentaFino = ora + 1200;
                  if (ora - ultimoTasto >= 120) { ultimoTasto = ora; impulsiTasti++; } });
          root.__impulsi = () => ({ mic: impulsiMic, tasti: impulsiTasti });
          const micEvento = (tipo) => { try {
              root.dispatchEvent(new CustomEvent('vera-mic', { detail: { tipo } }));
          }
          catch (x) { } };
          const mostraNotaMic = (si, testo) => { if (notaMic) {
              notaMic.textContent = testo || PM.avviso || '';
              notaMic.hidden = !si;
              notaMic.classList.toggle('errore', !!testo);
          } };
          const mostraRigaMic = (testo) => { if (rigaMic) {
              rigaMic.textContent = testo || '';
              rigaMic.hidden = !testo;
          } };
          const statoMic = (on) => {
              if (!tastoMic)
                  return;
              tastoMic.classList.toggle('ascolta', on);
              tastoMic.setAttribute('aria-pressed', on ? 'true' : 'false');
              tastoMic.setAttribute('aria-label', String((on ? PM.ferma_aria : PM.aria) || ''));
              root.classList.toggle('mic-ascolta', on);
              const nomeEl = q1('.hud-nome');
              if (nomeEl) {
                  let e = nomeEl.querySelector('.mic-stato');
                  if (on && !e) {
                      e = doc.createElement('span');
                      e.className = 'mic-stato';
                      nomeEl.appendChild(e);
                  }
                  if (e)
                      e.textContent = on ? ' · ' + (PM.ascolta || '') : '';
              }
              if (statoEl)
                  statoEl.textContent = on ? NOME + ' · ' + (PM.ascolta || '') : (ETI[statoC] || statoC);
              suono.voce(on);         // il suono d'ambiente si abbassa mentre ascolta
          };
          const togliTimer = () => { [tSilenzio, tNiente, tMax, tFine].forEach((x) => { if (x) win.clearTimeout(x); }); tSilenzio = tNiente = tMax = tFine = 0; };
          // K3: l'unico punto in cui l'ascolto finisce; vale una volta sola per generazione
          const azzeraAscolto = (g) => {
              if (g !== genMic)
                  return;
              genMic++;
              togliTimer();
              const r = ascoltoMic;
              ascoltoMic = null;
              if (r) {
                  r.onresult = null;
                  r.onerror = null;
                  r.onend = null;
              }
              statoMic(false);
              mostraRigaMic('');
              fineMicT = win.performance.now();
              try {
                  win.localStorage.setItem(PREF_MIC, '1');
              }
              catch (x) { }
              if (notaMic && !notaMic.classList.contains('errore'))
                  mostraNotaMic(false);
              riprendiAudio();          // K5: dopo l'ascolto il motore del suono riparte se il contesto e' sospeso o interrotto
              micEvento('fine');
              const t = testoMic.trim();
              testoMic = '';
              if (!t) {                 // K1 e N3: niente testo, niente parte, e lo diciamo
                  mostraNotaMic(true, PM.niente);
                  return;
              }
              const gv = genV;
              // N3 (25/11): parte il testo tenuto (ultimo risultato, finale o provvisorio), non quello riletto dal campo
              dopo(() => { if (gv === genV)
                  inviaDalCampo(t); }, 800);                // K1 e K5: la domanda parte dopo 0,8 s
          };
          const fermaAscolto = (g) => {
              if (g !== genMic || !ascoltoMic || tFine)
                  return;
              const r = ascoltoMic;
              try {
                  r.stop();
              }
              catch (x) { }
              tFine = win.setTimeout(() => {      // K3: se onend non arriva entro 1,5 s, abort() e azzeramento comunque
                  try {
                      if (r.abort)
                          r.abort();
                  }
                  catch (x) { }
                  azzeraAscolto(g);
              }, 1500);
          };
          const provaAscolto = (n) => {
              let r;
              try {
                  r = new Riconoscitore();
              }
              catch (x) {
                  mostraNotaMic(true, PM.errore);
                  if (inputCore)
                      inputCore.focus();
                  return;
              }
              r.lang = 'it-IT';
              r.continuous = false;
              r.interimResults = true;
              r.maxAlternatives = 1;
              const g = ++genMic;
              testoMic = '';
              r.onresult = (ev) => {
                  if (g !== genMic)
                      return;
                  let t = '';
                  for (let i = 0; i < ev.results.length; i++)
                      t += ev.results[i][0].transcript;
                  if (t.trim() && t !== testoMic)
                      micEvento('risultato');
                  if (t.trim()) {          // N3: un risultato vuoto (dopo il finale) non cancella il testo tenuto
                      testoMic = t;
                      if (inputCore) {
                          inputCore.value = t;
                          segnaCampo();
                      }
                  }
                  if (tNiente) {
                      win.clearTimeout(tNiente);
                      tNiente = 0;
                  }
                  if (tSilenzio)
                      win.clearTimeout(tSilenzio);
                  tSilenzio = win.setTimeout(() => fermaAscolto(g), 1800);    // K2a: 1,8 s senza parole nuove
              };
              r.onerror = (ev) => {
                  if (g !== genMic)
                      return;
                  const e = ev && ev.error;
                  if (e && e !== 'no-speech' && e !== 'aborted') {
                      mostraNotaMic(true, PM.errore);
                      if (inputCore)
                          inputCore.focus();
                  }
              };
              r.onend = () => azzeraAscolto(g);
              ascoltoMic = r;
              mostraNotaMic(true);
              mostraRigaMic(PM.ascolto_riga);
              statoMic(true);
              micEvento('inizio');
              try {
                  r.start();
              }
              catch (x) {                           // K4: un solo nuovo tentativo dopo 300 ms, poi la riga di errore
                  genMic++;
                  ascoltoMic = null;
                  statoMic(false);
                  mostraRigaMic('');
                  if (n === 0)
                      dopo(() => provaAscolto(1), 300);
                  else {
                      mostraNotaMic(true, PM.errore);
                      if (inputCore)
                          inputCore.focus();
                  }
                  return;
              }
              tNiente = win.setTimeout(() => { if (g === genMic && !testoMic.trim()) {     // K2b: 7 s senza risultati
                  mostraNotaMic(true, PM.niente);
                  fermaAscolto(g);
              } }, 7000);
              tMax = win.setTimeout(() => fermaAscolto(g), 15000);                         // K2c: 15 s in tutto
          };
          const avviaAscolto = () => {      // l'unico punto in cui parte il riconoscimento: dal tocco sul tasto
              if (!Riconoscitore || ascoltoMic)
                  return;
              chiudiRisposta();                       // la voce di VERA, se parla, si ferma
              chiudiElenco();
              sbloccaVoce();                          // K5: il tocco sblocca anche la voce della risposta che verra'
              provaAscolto(0);
          };
          if (Riconoscitore && formCore && inputCore) {
              tastoMic = doc.createElement('button');
              tastoMic.type = 'button';
              tastoMic.className = 'mic';
              tastoMic.setAttribute('data-mic', '1');
              tastoMic.setAttribute('aria-pressed', 'false');
              tastoMic.setAttribute('aria-label', String(PM.aria || ''));
              tastoMic.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3.5" width="6" height="11" rx="3"></rect><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v2.5"></path></svg>'
                  + '<svg class="mic-anello" viewBox="0 0 52 52" aria-hidden="true"><circle cx="26" cy="26" r="24" pathLength="1"></circle></svg>';
              const inv = formCore.querySelector('.invia');
              formCore.insertBefore(tastoMic, inv || null);
              rigaMic = doc.createElement('p');
              rigaMic.className = 'riga-mic';
              rigaMic.setAttribute('role', 'status');
              rigaMic.hidden = true;
              formCore.insertAdjacentElement('afterend', rigaMic);
              notaMic = doc.createElement('p');
              notaMic.className = 'nota-mic';
              notaMic.setAttribute('role', 'status');
              rigaMic.insertAdjacentElement('afterend', notaMic);
              let prima = true;
              try {
                  prima = !win.localStorage.getItem(PREF_MIC);
              }
              catch (x) { }
              mostraNotaMic(prima);                   // la prima volta l'avviso si vede subito
              ascolta(tastoMic, 'click', (e) => {
                  e.preventDefault();
                  if (ascoltoMic) {                   // K4: un tocco mentre ascolta ferma
                      fermaAscolto(genMic);
                      return;
                  }
                  if (win.performance.now() - fineMicT < 400)   // K4: niente doppio avvio subito dopo la fine
                      return;
                  avviaAscolto();
              });
          }
          const fuocoAiComandi = (el) => { const a = doc.activeElement; if (inputCore && el && (a === el || !a || a === doc.body)) {
              try {
                  inputCore.focus({ preventScroll: true });
              }
              catch (x) { }
          } };
          const sferaFinale = (Rb, H, st) => {
              if (st)
                  return { R: Rb * 1.24, cy: 0.3 };
              const alto = 112;
              if (!(limBasso > alto + 100))
                  return { R: Rb * 1.24, cy: 0.47 };
              return { R: Math.min(Rb * 1.24, (limBasso - alto) / 2.6), cy: (alto + limBasso) / 2 / H };
          };
          const geometriaFinale = (Wv, H, st) => {
              const Rb = st ? Math.min(Wv, H) * 0.2 : Math.min(Wv * 0.5, H) * 0.21;
              const sf = sferaFinale(Rb, H, st);
              return { Rb, sf, zg: zonaGeo(Wv, H, st, sf) };
          };
          const disegnaFinaleFermo = () => {
              if (!cores.finale)
                  return;
              const Wv = larghezza();
              const H = statico ? 900 : altezza();
              const st = stretto();
              const { Rb, sf, zg: zgF } = geometriaFinale(Wv, H, st);
              const lc = statoC === 'parla' ? 0.62 : statoC === 'inviata' || statoC === 'trascrivo' ? 0.5 : statoC === 'da_inviare' ? 0.45 : 0.3;
              const inScena = false;
              const geo = geometriaScena(Wv, H, st, sf, Rb);
              const figM = passoFigura(win.performance.now(), !st && inScena);
              if (inScena)
                  posaScena(geo);
              const fcx = inScena ? geo.cx : zgF.cx;
              const fcy = inScena ? geo.cy : sf.cy;
              const fR = inScena ? geo.R : zgF.R;
              const vivoGL = !!(nucleo && nucleo.vivo && !glSpento);
              if (!(scena && scena.aperta && tuffo.p >= 1))
                  cores.finale.disegna({ anelloMax: zgF.ring, anelloK: 1, cx: fcx, cy: fcy, R: fR, ass: 1, cam: 3.4, zoom: 1, centro: 0, alfa: 1, jv: 1, amp: 0, lc, sat: satAttivo, anello: anelloTesto, distSat: st ? 1.45 : 1.62, filo: st || inScena ? null : filo, filoA: filo ? 1 : 0, attivo: statoC !== 'pronta', subito: true, gl: vivoGL, conto: statoC === 'da_inviare' ? contoFraz : 0, scena: inScena ? { x: geo.sx, y: geo.sy, verticale: geo.verticale, q: 1 } : null, modo: figM, figCorta: figM > 0 }, 4000);
              if (vivoGL && !(scena && scena.aperta && tuffo.p >= 1))
                  nucleo.disegna({ cx: fcx, cy: fcy, R: fR, jv: 1, stato: statoC, rifiuto: rifiutoAttivo && statoC === 'parla', amp: 0, livello: 0, conto: statoC === 'da_inviare' ? contoFraz : 0, parola: kParola, subito: true, larghezza: Wv, altezza: H, figura: figM > 0 }, 4000);
          };
          const dividiFrasi = (testo) => String(testo || '').split(/(?<=[.!?])\s+(?=[A-ZÀ-Ý«"])/).filter(Boolean);
          const tipoClasse = (t) => (/INFERENZA/.test(String(t)) ? 'ipotesi' : /NON VERIFICATO/.test(String(t)) ? 'grigio' : 'verif');
          let nRisposte = 0;
          const nuovaRisposta = (dati) => {
              const id = 'r' + (++nRisposte);
              const frasi = (dati.frasi || []).map((f) => String(f || '').trim()).filter(Boolean);
              const storia = doc.createElement('div');
              storia.className = 'storia c-' + dati.classe;
              storia.setAttribute('data-storia', id);
              storia.setAttribute('data-esito', dati.esito || '');
              storia.setAttribute('data-nota', dati.nota || '');
              storia.hidden = true;
              const parole = [];
              const quadri = [];
              frasi.forEach((f, k) => {
                  const art = doc.createElement('article');
                  art.className = 'quadro';
                  art.setAttribute('data-q', String(k));
                  const sr = doc.createElement('p');
                  sr.className = 'solo-lettori';
                  sr.textContent = f;
                  const corpo = doc.createElement('div');
                  corpo.className = 'q-corpo';
                  corpo.setAttribute('aria-hidden', 'true');
                  const p = doc.createElement('p');
                  p.className = 'q-testo';
                  const i0 = parole.length;
                  f.split(/\s+/).filter(Boolean).forEach((w, j) => {
                      if (j)
                          p.appendChild(doc.createTextNode(' '));
                      const s = doc.createElement('span');
                      s.className = 'rw';
                      s.setAttribute('data-w', String(parole.length));
                      s.textContent = w;
                      p.appendChild(s);
                      parole.push(w);
                  });
                  corpo.appendChild(p);
                  art.appendChild(sr);
                  art.appendChild(corpo);
                  storia.appendChild(art);
                  quadri.push({ i0, i1: parole.length - 1, g: null });
              });
              DATI_RC.storie[id] = { tipo: dati.tipo, classe: dati.classe, fonte: dati.fonte || null, domanda: dati.domanda, n: parole.length, quadri };
              if (scena && scena.registra)
                  scena.registra(id, storia, DATI_RC.storie[id]);
              const au = dati.audio;
              if (au && au.file && au.testo === frasi.join(' ') && Array.isArray(au.parole) && au.parole.length === parole.length
                  && au.parole.every((p, i) => p[0] === parole[i]))
                  return { id, domanda: dati.domanda, testo: frasi.join(' '), tipo: dati.tipo, fonti: dati.fonte ? [dati.fonte] : [],
                      parole: au.parole.map((p) => [p[0], p[1], p[2]]), durata: au.durata, url: au.file };
              return cadenzaRC({ id, domanda: dati.domanda, testo: frasi.join(' '), tipo: dati.tipo, fonti: dati.fonte ? [dati.fonte] : [],
                  parole: parole.map((w) => [w, 0, 0]), durata: 0 });
          };
          const scriviFonte = (f, tipo) => {
              mostraNodo('fonte');
              if (nT.tipofonte)
                  nT.tipofonte.textContent = tipo || '';
              if (nT.fonte) {
                  nT.fonte.setAttribute('data-testo', f.file + (f.riga ? ' · ' + (PR.riga || '') + ' ' + f.riga : ''));
                  mescola(nT.fonte, 28);
              }
              if (nT.impronta)
                  nT.impronta.textContent = f.impronta ? (PR.impronta || '') + ' ' + String(f.impronta).slice(0, 16) + '…' : '';
              anelloTesto = ANELLO('fonte') + String(f.file).toUpperCase() + (f.riga ? ' · ' + String(PR.riga || '').toUpperCase() + ' ' + f.riga : '') + ' · ';
          };
          const parlaRisposta = (e, g, esito) => {
              root.dispatchEvent(new CustomEvent('vera-parla', { bubbles: true }));     // P2 (25/11): per le prove (la scena comincia a dire)
              trattieniVoce(false);
              mostraNodo('risposta');
              if (nT.etirisposta)
                  nT.etirisposta.textContent = (PC.nodi || {}).risposta || '';
              anelloTesto = ANELLO('risposta') + NOME.toUpperCase() + ' · ';
              const p = scriviParole(nT.risposta, e);
              avviaClip(e, (k) => { p(k); kParola = k; if (scena && scena.aperta)
                  scena.parola(k); }, () => chiudi(esito, e.tipo, g, e.testo));
          };
          const mostraFonte = (e, f, g, esito) => {
              if (f && !(nodo.fonte && nodo.fonte.classList.contains('visto')))
                  scriviFonte(f, e.tipo);
              satAttivo = rifiutoAttivo ? 'VERIFICATORE' : satDaTipo(e.tipo);
              if (cinema() && scena)
                  scena.apri(e, { fonte: f, tipo: e.tipo, domanda: e.domanda });
              dopo(() => { if (g === genV)
                  parlaRisposta(e, g, esito); }, scena && scena.aperta && scena.attesa ? scena.attesa() : 700);
          };
          const sezVera = doc.querySelector('section.vera');
          let attesaViva = null;
          if (sezVera) {
              ascolta(sezVera, 'vera-evento', (ev) => {
                  const x = ev.detail || {};
                  if (!attesaViva || attesaViva.g !== genV)
                      return;
                  if (x.tipo === 'presa_in_carico')
                      mostraNodo('presa');
                  else if (x.tipo === 'fonte' && x.file) {
                      attesaViva.fonte = { file: x.file, riga: x.riga, impronta: x.impronta };
                      scriviFonte(attesaViva.fonte, '');
                      satAttivo = 'EVIDENZE';
                  }
                  else if (x.tipo === 'stadio1' || x.tipo === 'stadio2' || x.tipo === 'stadio3' || x.tipo === 'verificatore') {
                      satAttivo = 'VERIFICATORE';
                      if (fusEl && PC.fusione)
                          fusEl.textContent = PC.fusione;
                  }
              });
              ascolta(sezVera, 'vera-mostrata', (ev) => {
                  const d = ev.detail || {};
                  if (!attesaViva || attesaViva.g !== genV || d.domanda !== attesaViva.domanda)
                      return;
                  const g = attesaViva.g, fonte0 = attesaViva.fonte;
                  attesaViva = null;
                  const ok = d.esito === 'verificata' || d.esito === 'preparata';
                  const ES = PR.esiti || {};
                  // N1.8 (notte 25/11): il servizio non ha risposto (ripiego): nessuna risposta di rifiuto. Si torna al Neural Core, lo stato
                  // dice «Senza risposta dal vivo» e si aprono le domande proposte
                  if (!ok && d.ripiego) {
                      rifiutoAttivo = false;
                      if (fusEl)
                          fusEl.textContent = '';
                      if (scena && scena.aperta)
                          scena.chiudi(false);
                      impostaStato('pronta');
                      if (statoEl) {
                          statoEl.textContent = ES.ripiego || '';
                          statoEl.setAttribute('data-s', 'ripiego');
                      }
                      avvisa(d.testo_rifiuto || ES.ripiego || '');
                      apriElenco('');
                      return;
                  }
                  const frasi = ok ? (d.frasi || []).map((f) => f.testo) : [d.testo_rifiuto || ''];
                  const f = ok ? ((((d.frasi || [])[0] || {}).fonti || [])[0] || fonte0) : null;
                  const esito = ok ? (d.esito === 'verificata' ? ES.verificata : ES.preparata) || '' : (d.ripiego ? ES.ripiego : ES.rifiutata) || '';
                  rifiutoAttivo = !ok;
                  togliProposte();
                  const e = nuovaRisposta({ domanda: d.domanda, frasi, tipo: '', classe: ok ? 'verif' : 'rifiuto', fonte: f, esito,
                      nota: ok ? [d.esito === 'verificata' ? PR.nota_verificata : PR.nota_preparata, d.riga_fonti].filter(Boolean).join(' · ') : '' });
                  if (fusEl)
                      fusEl.textContent = '';
                  // P1 (25/11): con la voce del servizio in arrivo la scena seguira' la voce vera
                  rispostaViva = null;
                  if (ok && d.esito === 'verificata' && d.voce && d.voce.stato === 'in_arrivo' && voceAttiva) {
                      const q = ((DATI_RC.storie[e.id] || {}).quadri) || [];
                      if (q.length === frasi.length)
                          e.viva = { offs: q.map((x) => x.i0), n: q.map((x) => x.i1 - x.i0 + 1), k: -1, finita: false, nd: false };
                      else {
                          let o = 0; const offs = [], n = [];
                          frasi.forEach((fr) => { const c = fr.split(/\s+/).filter(Boolean).length; offs.push(o); n.push(c); o += c; });
                          e.viva = { offs, n, k: -1, finita: false, nd: false };
                      }
                      rispostaViva = e;
                  }
                  if (ok)
                      impostaStato('parla');
                  mostraFonte(e, f, g, esito);
                  // H3 (25/11): un rifiuto per mancanza di fatti (non il rifiuto clinico) propone fino a tre domande dell'elenco
                  if (!ok && MANCANO_FATTI.includes(d.motivo))
                      mostraProposte(d.domanda || '');
              });
          }
          if (win.fetch && PAROLE.audio)
              win.fetch(PAROLE.audio).then((r) => (r.ok ? r.json() : {})).then((d) => { AUDIO = d || {}; }).catch(() => { AUDIO = {}; });
          if (win.fetch && PAROLE.catalogo) {
              win.fetch(PAROLE.catalogo).then((r) => { if (!r.ok)
                  throw new Error('catalogo'); return r.json(); }).then((d) => {
                  if (this._fermo)
                      return;
                  const per_id = {};
                  (d.catalogo || []).forEach((c) => { per_id[c.id] = c; });
                  CATALOGO = { catalogo: d.catalogo || [], per_id };
                  if (fermo)
                      disegnaFinaleFermo();
              }).catch(() => { });
          }
          const pausaClip = () => {
              const c = clip;
              if (!c || c.pausa || c.attesa)
                  return;
              c.tPausa = tempoClip(c);
              c.pausa = true;
              c.pausaDa = win.performance.now();
              if (c.modo === 'buffer' && sorgente) {
                  try {
                      sorgente.onended = null;
                      sorgente.stop();
                  }
                  catch (e) { }
                  sorgente = null;
              }
              else if (c.modo === 'elemento' && voceEl) {
                  try {
                      voceEl.pause();
                  }
                  catch (e) { }
              }
              suono.voce(false);
              if (scena)
                  scena.pausa(true);
              if (annuncio)
                  annuncio.textContent = PR.pausa || '';
          };
          const riprendiClip = () => {
              const c = clip;
              if (!c || !c.pausa)
                  return;
              c.pausa = false;
              c.inizio += win.performance.now() - c.pausaDa;
              if (c.modo === 'buffer' && actx && c.buf) {
                  try {
                      const s = actx.createBufferSource();
                      s.buffer = c.buf;
                      s.connect(analizzatore);
                      s.onended = () => { if (clip === c)
                          c.finita = true; };
                      s.start(0, Math.min(c.tPausa, c.buf.duration - 0.01));
                      c.t0 = actx.currentTime - c.tPausa;
                      sorgente = s;
                  }
                  catch (e) {
                      c.modo = 'tempo';
                      c.vel = 1;
                      c.inizio = win.performance.now() - c.tPausa * 1000;
                  }
              }
              else if (c.modo === 'elemento' && voceEl) {
                  const pr = voceEl.play();
                  if (pr && pr.catch)
                      pr.catch(() => { });
              }
              else if (c.modo === 'tempo')
                  c.inizio = win.performance.now() - (c.tPausa / (c.vel || 1)) * 1000;
              if (c.modo !== 'tempo')
                  suono.voce(true);
              if (scena)
                  scena.pausa(false);
              if (annuncio)
                  annuncio.textContent = PR.riprendi || '';
          };
          let scenaQ = 0;
          let ultimaGeo = '';
          const geometriaScena = (Wv, H, st, sf, Rb) => {
              const basso = root.classList.contains('schermo-basso');
              const fondo = comandiEl ? comandiEl.offsetTop - (st ? 12 : 18) : H - 170;
              if (st) {
                  const R = sf.R * 0.72;
                  const cy = 0.235;
                  const sy = cy * H + R * 1.12 + 14;
                  return { cx: 0.5, cy, R, sx: 16, sy, sw: Wv - 32, sh: Math.max(140, fondo - sy), verticale: true, fx: 0, fy: 0, fmw: 0 };
              }
              const CAP = 46;
              const alto = basso ? 100 : 112;
              let R = sf.R * 0.8;
              const spazio = fondo - alto;
              if (2.42 * R + 6 + CAP > spazio)
                  R = Math.max(sf.R * 0.55, (spazio - 6 - CAP) / 2.42);
              let cyp = Math.min(sf.cy * H, fondo - CAP - 6 - 1.3 * R);
              cyp = Math.max(cyp, alto + 1.12 * R);
              const cxp = Math.max(R * 1.75 + 24, Wv * 0.205);
              const sx = cxp + R * 1.33 + 70;
              const sy = basso ? 108 : 128;
              const destra = Wv - Math.max(16, Wv * 0.03) - 64 - 18;
              const fy = cyp + 1.3 * R + 6;
              return { cx: cxp / Wv, cy: cyp / H, R, sx, sy, sw: Math.max(280, destra - sx), sh: Math.max(160, fondo - sy), verticale: false, fx: cxp, fy, fmw: Math.max(120, 2 * Math.min(cxp - 16, sx - cxp - 18)) };
          };
          const posaScena = (g) => {
              if (!scenaEl)
                  return;
              const k = [g.sx, g.sy, g.sw, g.sh, g.fx, g.fy, g.fmw].map((v) => Math.round(v)).join(',');
              if (k === ultimaGeo)
                  return;
              ultimaGeo = k;
              scenaEl.style.setProperty('--sx', Math.round(g.sx) + 'px');
              scenaEl.style.setProperty('--sy', Math.round(g.sy) + 'px');
              scenaEl.style.setProperty('--sw', Math.round(g.sw) + 'px');
              scenaEl.style.setProperty('--sh', Math.round(g.sh) + 'px');
              scenaEl.style.setProperty('--fx', Math.round(g.fx) + 'px');
              scenaEl.style.setProperty('--fy', Math.round(g.fy) + 'px');
              scenaEl.style.setProperty('--fmw', Math.round(g.fmw) + 'px');
          };
          let figModo = 0;
          let tFig = -1e9;
          const passoFigura = (t, ok) => {
              const voluta = ok && scena ? scena.figura : 0;
              if (!voluta) {
                  figModo = 0;
                  tFig = -1e9;
              }
              else if (voluta !== figModo && (t - tFig > 2200 || fermo)) {
                  figModo = voluta;
                  tFig = t;
              }
              if (scena)
                  scena.didascalia(figModo);
              return figModo;
          };
          const versoParola = () => {
              if (!scena || !scena.verso || !telaFinale)
                  return null;
              const v = scena.verso;
              const a = 1 - (win.performance.now() - v.t) / 520;
              if (a <= 0)
                  return null;
              const cr = telaFinale.getBoundingClientRect();
              return { x: v.x - cr.left, y: v.y - cr.top, a };
          };
          let rifiutoAttivo = false;
          let kParola = 0;
          const gpuModo = this.props.gpu === 'sempre' || this.props.gpu === 'mai' ? this.props.gpu : 'auto';
          const nucleo = gpuModo === 'mai' ? null : creaNucleoGL(q1('[data-nucleo="finale"]'));
          let glSpento = false;
          let msNucleo = 0;
          if (nucleo)
              root.classList.add('con-nucleo-gl');
          let coreDentro = false;
          let emaFrame = 16.7;
          let tLento = 0;
          let tVeloce = 0;
          const vaiAlCore = () => {
              if (!finale)
                  return;
              const H = altezza();
              const r = finale.getBoundingClientRect();
              const y = posizione() + r.top + 0.62 * Math.max(0, r.height - H);
              viaggioFino = win.performance.now() + 2600;
              if (this._lenis)
                  this._lenis.scrollTo(y, { duration: 2.2 });
              else if (scorre)
                  scorre.scrollTo({ top: y, behavior: fermo ? 'auto' : 'smooth' });
              else
                  win.scrollTo({ top: y, behavior: fermo ? 'auto' : 'smooth' });
          };
          this._clic = (e) => {
              const tgt = e.target;
              if (!tgt || !tgt.closest)
                  return;
              if (tgt.closest('[data-suono-tasto]')) {
                  if (suono.acceso)
                      spegniSuono();
                  else
                      accendiSuono();
                  return;
              }
              if (tgt.closest('button, a, .sugg, .tacca') && !tgt.closest('[data-voce-toggle]'))
                  suono.evento('clic');
              if (tgt.closest('[data-form-core] .invia')) {
                  e.preventDefault();
                  inviaDalCampo();
                  return;
              }
              const scP = tgt.closest('[data-sc-pausa]');
              if (scP) {
                  if (clip && clip.pausa)
                      riprendiClip();
                  else
                      pausaClip();
                  return;
              }
              if (tgt.closest('[data-sc-tutto]')) {
                  if (scena)
                      scena.tutto();
                  return;
              }
              const scF = tgt.closest('[data-sc-ferma]');
              if (scF) {
                  if (clip && clip.pausa)
                      riprendiClip();
                  ferma();
                  fuocoAiComandi(scF);
                  return;
              }
              const scC = tgt.closest('[data-sc-chiudi]');
              if (scC) {
                  chiudiRisposta(true);      // M5: chiude sempre; S1: subito, senza animazione e senza fuoco sul campo
                  return;
              }
              const scorri = tgt.closest('[data-sugg-scorri]');
              if (scorri && suggR) {
                  const d = Number(scorri.getAttribute('data-sugg-scorri')) || 1;
                  suggR.scrollBy({ left: d * Math.max(140, suggR.clientWidth * 0.7), behavior: fermo ? 'auto' : 'smooth' });
                  return;
              }
              if (tgt.closest('[data-elenco-apri]')) {
                  if (elencoAperto())
                      chiudiElenco();
                  else
                      apriElenco(inputCore ? inputCore.value : '');
                  return;
              }
              const sug = tgt.closest('[data-chiedi-id]');
              if (sug && !sug.hasAttribute('data-esempio')) {
                  if (sug.classList.contains('rc-proposta'))   // H3: dal rifiuto, la risposta si apre dopo la chiusura (U3)
                      chiudiRisposta();
                  chiudiElenco();
                  if (inputCore)
                      inputCore.value = '';
                  segnaCampo();
                  chiediVera(sug.textContent, sug.getAttribute('data-chiedi-id'), VIA.preparata || '');
                  return;
              }
              if (tgt.closest('[data-voce-toggle]')) {
                  cambiaVoce();
                  return;
              }
              const tc = tgt.closest('.tacca');
              if (tc && video) {
                  const t0 = Number(tc.getAttribute('data-t'));
                  if (isFinite(t0)) {
                      video.currentTime = t0;
                      aggiornaVideo();
                      if (video.paused) {
                          utentePausa = false;
                          const pr = video.play();
                          if (pr && pr.catch)
                              pr.catch(() => { });
                      }
                  }
                  return;
              }
              if (tgt.closest('[data-play]')) {
                  if (!video)
                      return;
                  if (video.paused || video.ended) {
                      utentePausa = false;
                      avviato = true;
                      const pr = video.play();
                      if (pr && pr.catch)
                          pr.catch(() => { });
                  }
                  else {
                      utentePausa = true;
                      video.pause();
                  }
                  return;
              }
              const au = tgt.closest('[data-audio]');
              if (au && video) {
                  video.muted = !video.muted;
                  au.setAttribute('aria-pressed', video.muted ? 'false' : 'true');
                  const testo = au.lastChild;
                  if (testo && testo.nodeType === 3)
                      testo.textContent = PV.audio || '';
                  if (!video.muted && video.paused) {
                      utentePausa = false;
                      const pr = video.play();
                      if (pr && pr.catch)
                          pr.catch(() => { });
                  }
                  return;
              }
              const a = tgt.closest('a[href^="#"]');
              if (!a || a.closest('.classico, .leggi-tutto, .pannello-documento'))
                  return;
              const h = a.getAttribute('href');
              if (!h || h.length < 2) {
                  e.preventDefault();
                  return;
              }
              if (h === '#core') {
                  e.preventDefault();
                  vaiAlCore();
                  return;
              }
              const t = root.querySelector(h);
              if (!t)
                  return;
              e.preventDefault();
              if (this._lenis)
                  this._lenis.scrollTo(t, { offset: 0, duration: 1.5 });
              else
                  t.scrollIntoView({ behavior: fermo ? 'auto' : 'smooth', block: 'start' });
          };
          root.addEventListener('click', this._clic);
          // il campo del Neural Core (24/11, parte 1, punto 3): esempio, catalogo, elenco; funziona anche senza servizio
          const normalizza = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
              .replace(/[^a-z0-9]+/g, ' ').trim();
          const nelCatalogo = (t) => {
              if (!CATALOGO)
                  return null;
              const n = normalizza(t);
              return n ? (CATALOGO.catalogo.find((c) => normalizza(c.domanda) === n) || null) : null;
          };
          const dalVivo = !!(formCore && formCore.getAttribute('data-dal-vivo') === '1');
          const vociElenco = elencoEl ? Array.from(elencoEl.querySelectorAll('[data-chiedi-id]')) : [];
          const filtraElenco = (t) => {
              const parole = normalizza(t).split(' ').filter(Boolean);
              let n = 0;
              vociElenco.forEach((b) => { const ok = parole.every((w) => normalizza(b.textContent).includes(w));
                  b.parentNode.hidden = !ok; if (ok) n++; });
              // N1.3: un tema senza voci visibili si nasconde
              if (elencoEl)
                  elencoEl.querySelectorAll('.elenco-gruppo').forEach((g) => { g.hidden = !g.querySelector('li[role="presentation"]:not([hidden]) [data-chiedi-id]'); });
              return n;
          };
          const elencoAperto = () => !!(elencoEl && !elencoEl.hidden);
          const apriElenco = (filtro) => {
              if (!elencoEl)
                  return;
              filtraElenco(filtro || '');
              elencoEl.hidden = false;
              [inputCore, elencoApri].forEach((x) => { if (x) x.setAttribute('aria-expanded', 'true'); });
          };
          const chiudiElenco = () => {
              if (!elencoEl)
                  return;
              elencoEl.hidden = true;
              [inputCore, elencoApri].forEach((x) => { if (x) x.setAttribute('aria-expanded', 'false'); });
          };
          const segnaCampo = () => { if (formCore)
              formCore.classList.toggle('con-testo', !!(inputCore && inputCore.value)); };
          // la voce del servizio (vera_voce.js, A3): la governa il solo tasto della voce di questa pagina; si sblocca solo dentro un
          // gesto vero (questo invio), si zittisce con il tasto spento, si ferma prima di un audio preparato (mai due voci)
          const voceServizio = (sblocca) => {
              const sez = doc.querySelector('section.vera');
              const VV = win.VeraVoce;
              if (!sez || !VV || !VV.zittisci)
                  return;
              VV.zittisci(sez, !voceAttiva);
              if (sblocca && voceAttiva)
                  VV.sblocca(sez);
          };
          voceServizio(false);      // M4: la voce del servizio segue lo stato iniziale del tasto (accesa se non spenta)
          const trattieniVoce = (si) => { const sez = doc.querySelector('section.vera'); if (sez && win.VeraVoce && win.VeraVoce.trattieni)
              win.VeraVoce.trattieni(sez, si); };
          const fermaVoceServizio = () => { const sez = doc.querySelector('section.vera'); if (sez && win.VeraVoce && win.VeraVoce.ferma)
              win.VeraVoce.ferma(sez); };
          // F4 (chiusura 25/11): domande su VERA, sul gruppo e sul progetto vanno subito alla risposta preparata, senza il servizio.
          // Parole chiare: minuscolo, senza accenti ne' punteggiatura, parole intere; vale anche per la domanda detta a voce
          const pulisci = (x) => ' ' + String(x || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
          const ha = (t, frasi) => frasi.some((f) => t.indexOf(' ' + f + ' ') >= 0);
          // H2 (25/11, versione 2): solo per domande di al massimo 9 parole; niente riga di rimando alla domanda instradata
          const LAVORO = ['costruito', 'costruita', 'cosa fanno', 'cosa fate', 'che fate', 'cosa avete fatto', 'cosa hanno fatto', 'di cosa vi occupate',
              'cosa fa questo progetto', 'spiegami il progetto', 'in cosa consiste', 'riassumi', 'in breve'];
          const PROGETTO = ['cos e questo progetto', 'che progetto', 'di cosa parla', 'di che parla'];
          const GRUPPO_CHI = ['siete', 'vi ha', 'ha fatto', 'l ha fatto', 'ha realizzato', 'c e dietro', 'sono i ragazzi', 'sono gli studenti'];
          const GRUPPO = ['presentatevi', 'parlami di voi', 'parlami del gruppo', 'parlami della squadra'];
          const VERA_FRASI = ['chi sei', 'che cosa fai', 'cosa fai', 'che fai', 'cosa sai fare', 'come funzioni', 'a cosa servi', 'presentati', 'chi e vera'];
          const SALUTI = ['ciao', 'ehi', 'buongiorno', 'salve'];
          const nelCat = (id) => !!(CATALOGO && CATALOGO.per_id && CATALOGO.per_id[id]);
          const instrada = (v) => {
              const t = pulisci(v), chi = ha(t, ['chi']);
              if (t.trim().split(' ').filter(Boolean).length > 9)
                  return null;
              if (ha(t, LAVORO))
                  return chi ? 'giuria_56' : (nelCat('giuria_57') ? 'giuria_57' : 'giuria_50');
              if (ha(t, PROGETTO))
                  return 'messaggio_progetto';
              if ((chi && ha(t, GRUPPO_CHI)) || ha(t, GRUPPO))
                  return 'giuria_56';
              if (ha(t, VERA_FRASI))
                  return 'giuria_55';
              const parole = t.trim().split(' ').filter(Boolean);
              if (parole.length && parole.some((p) => SALUTI.includes(p)) && parole.every((p) => SALUTI.includes(p) || p === 'vera'))
                  return 'giuria_55';
              return null;
          };
          root.__instrada = instrada;
          // N3 (25/11): «testo» e' il testo dettato tenuto dal microfono (non riletto dal campo); a campo vuoto non parte niente:
          // un piccolo cenno del campo (l'esempio si apre solo toccando l'esempio)
          const inviaDalCampo = (testo) => {
              const v = (typeof testo === 'string' ? testo : (inputCore ? inputCore.value : '')).trim();
              chiudiElenco();
              if (!v) {
                  if (formCore) {
                      formCore.classList.remove('cenno');
                      void formCore.offsetWidth;
                      formCore.classList.add('cenno');
                  }
                  return;
              }
              voceServizio(true);
              const c = nelCatalogo(v);
              const idI = c ? null : instrada(v);
              if (c)                                    // scritta uguale a una del catalogo: la risposta preparata (N3: titolo con le sue parole)
                  chiediVera(c.domanda, c.id, VIA.preparata || '', v);
              else if (idI && CATALOGO && CATALOGO.per_id && CATALOGO.per_id[idI])
                  chiediVera(CATALOGO.per_id[idI].domanda, idI, VIA.preparata || '', v);      // F4/H2: instradata; N3: titolo = le parole di chi chiede
              else if (dalVivo)
                  chiediVera(v, null, VIA.scritta || '');
              else {                                    // senza servizio: l'elenco, filtrato con le sue parole
                  apriElenco(filtraElenco(v) ? v : '');
                  if (annuncio)
                      annuncio.textContent = PC.nessuna || '';
                  return;
              }
              if (inputCore)
                  inputCore.value = '';
              segnaCampo();
          };
          if (inputCore) {
              // N1.3: il tocco sul campo apre solo la tastiera; l'elenco si apre dal suo tasto o mentre si scrive
              // V2 (25/11): scrivendo l'elenco non si apre piu' da solo (copriva la sfera): si apre solo dal suo tasto; se e' gia'
              // aperto, le parole lo filtrano
              ascolta(inputCore, 'input', () => { segnaCampo(); if (elencoAperto())
                  apriElenco(inputCore.value.trim() ? inputCore.value : ''); });
              ascolta(inputCore, 'focus', () => { if (fermo) return; tast.on = true; tast.y0 = win.scrollY; tast.q = Math.max(qF, 0.62); tast.kb = -1; tast.h0 = win.innerHeight; tast.eraAperta = false; });
              ascolta(inputCore, 'blur', () => { if (!tast.on) return; tast.on = false; tast.kb = -1; tast.tieni = tast.eraAperta ? win.performance.now() + 900 : 0; if (formCore) formCore.style.transform = ''; });
              ['wheel', 'touchstart', 'keydown'].forEach((ev) => ascolta(win, ev, () => { if (!tast.on) tast.tieni = 0; }));      // chi scorre davvero non viene trattenuto
              // N2 (25/11): mai contro un gesto: a un trascinamento o alla rotella il campo perde il fuoco e la pagina scorre
              ['touchmove', 'wheel'].forEach((ev) => ascolta(win, ev, () => { tast.tieni = 0; if (doc.activeElement === inputCore) inputCore.blur(); }, { passive: true }));
              ascolta(inputCore, 'keydown', (e) => {
                  if (e.key === 'Escape' && elencoAperto()) {
                      e.preventDefault();
                      chiudiElenco();
                  }
                  else if (e.key === 'ArrowDown' && elencoAperto()) {
                      const v = vociElenco.find((b) => !b.parentNode.hidden);
                      if (v) {
                          e.preventDefault();
                          v.focus();
                      }
                  }
              });
          }
          if (elencoEl)
              ascolta(elencoEl, 'keydown', (e) => {
                  const vis = vociElenco.filter((b) => !b.parentNode.hidden);
                  const i = vis.indexOf(doc.activeElement);
                  if (e.key === 'Escape') {
                      e.preventDefault();
                      chiudiElenco();
                      if (inputCore)
                          inputCore.focus();
                  }
                  else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                      e.preventDefault();
                      const j = i + (e.key === 'ArrowDown' ? 1 : -1);
                      if (j < 0 && inputCore)
                          inputCore.focus();
                      else if (vis[Math.min(j, vis.length - 1)])
                          vis[Math.min(j, vis.length - 1)].focus();
                  }
              });
          ascolta(doc, 'pointerdown', (e) => { if (elencoAperto() && !(e.target.closest && e.target.closest('[data-elenco], [data-form-core]')))
              chiudiElenco(); });
          // gli esempi nel segnaposto, uno alla volta, con una battitura lenta (ferma con il movimento ridotto)
          const ESEMPI = (() => { try {
              return JSON.parse((formCore && formCore.getAttribute('data-esempi')) || '[]');
          }
          catch (e) {
              return [];
          } })();
          let esempioI = 0;
          const prossimoEsempio = () => {
              if (!esempioBtn || !esempioTesto || ESEMPI.length < 2 || elencoAperto() || (inputCore && (inputCore.value || doc.activeElement === inputCore)))
                  return;
              esempioI = (esempioI + 1) % ESEMPI.length;
              const x = ESEMPI[esempioI];
              esempioBtn.setAttribute('data-esempio-id', x.id);
              if (fermo) {
                  esempioTesto.textContent = x.domanda;
                  return;
              }
              batti(esempioTesto, x.domanda, 45);
          };
          if (!statico && !fermo)
              ogni(prossimoEsempio, 8000);
          if (inputCore)
              ascolta(inputCore, 'keydown', (e) => { if (e.key === 'Enter' && !e.isComposing && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
                  e.preventDefault();
                  inviaDalCampo();
              } });
          this._invio = (e) => {
              const f = e.target && e.target.closest ? e.target.closest('[data-form-core]') : null;
              if (!f)
                  return;
              e.preventDefault();
              inviaDalCampo();
          };
          root.addEventListener('submit', this._invio);
          const statoSugg = () => {
              if (!suggG || !suggR)
                  return;
              const max = suggR.scrollWidth - suggR.clientWidth;
              const sc = max > 2;
              const ind = sc && suggR.scrollLeft > 2;
              const av = sc && suggR.scrollLeft < max - 2;
              suggG.classList.toggle('scorre', sc);
              suggG.classList.toggle('puo-indietro', ind);
              suggG.classList.toggle('puo-avanti', av);
              const att = doc.activeElement;
              const fr = att && att.closest ? att.closest('[data-sugg-scorri]') : null;
              if (fr && !(fr.getAttribute('data-sugg-scorri') === '1' ? av : ind)) {
                  const ch = suggR.querySelectorAll('.sugg');
                  const t = fr.getAttribute('data-sugg-scorri') === '1' ? ch[ch.length - 1] : ch[0];
                  if (t)
                      t.focus({ preventScroll: true });
              }
          };
          this._statoSugg = statoSugg;
          if (suggR)
              ascolta(suggR, 'scroll', statoSugg, { passive: true });
          statoSugg();
          if (doc.fonts && doc.fonts.ready)
              doc.fonts.ready.then(() => { if (!this._fermo)
                  statoSugg(); });
          if (!statico)
              ogni(() => { if (orologio && hudEl && hudEl.classList.contains('attivo')) {
                  const d = new Date();
                  orologio.textContent = [d.getHours(), d.getMinutes(), d.getSeconds()].map((x) => String(x).padStart(2, '0')).join(':');
              } }, 1000);
          // N2.5 (notte 25/11): le sezioni aggiunte («E con due campioni?», «Provalo», il registro di «Verificalo tu», il piede) entrano
          // come quelle del prototipo: titolo e righe salgono di 24 px con una sfocatura che si scioglie, a scalare di 80 ms; l'occhiello
          // si compone (data-scramble). Con il movimento ridotto restano ferme e visibili
          const ENTRATE = [['#due-campioni', '.colonna > *'], ['#provalo', '.provalo-testo > *, .registro-provalo .registro-testa'],
              ['#core', '.finale-testo .registro.fermo, .finale-testo .tasti'], ['footer.piede', '.piede-griglia > div, .piede-fondo']];
          if (!fermo && win.IntersectionObserver)
              ENTRATE.forEach(([sel, figli]) => {
                  const sez = q1(sel);
                  if (!sez)
                      return;
                  const el = Array.prototype.slice.call(sez.querySelectorAll(figli));
                  el.forEach((x, k) => { x.classList.add('entra'); x.style.setProperty('--k', String(Math.min(k, 12))); });
                  const io = new win.IntersectionObserver((vv) => { if (vv.some((v) => v.isIntersecting)) {
                      io.disconnect();
                      sez.classList.add('entrata');
                  } }, { threshold: 0, rootMargin: '0px 0px -18% 0px' });     // anche per le sezioni piu' alte dello schermo
                  io.observe(sez);
              });
          // N2.4 (notte 25/11): le righe del registro di «Provalo» compaiono una alla volta quando la sezione entra; poi la riga accesa
          // passa dall'una all'altra, piano (ferma con il movimento ridotto)
          const provSez = q1('#provalo');
          if (provSez) {
              const righeP = Array.prototype.slice.call(provSez.querySelectorAll('.riga-provalo'));
              // S7 (25/11): la riga accesa segue lo scorrimento da subito (non solo dopo l'entrata della sezione): uguale in su e in giu'
              const seguiRighe = () => {
                  if (fermo || !righeP.length)
                      return;
                  // V3 (25/11): la riga accesa segue lo scorrimento, nessun timer: 01 quando la sezione entra, 02 a meta', 03 verso la
                  // fine; ferma se non si scorre
                  let kP = -1, coda = false;
                  const posa = () => { coda = false; const r = provSez.getBoundingClientRect(), H = win.innerHeight;
                      const q = lim((H - r.top) / Math.max(1, r.height + H));
                      const k = Math.min(righeP.length - 1, Math.floor(lim((q - 0.18) / 0.6) * righeP.length));
                      if (k !== kP) { kP = k; righeP.forEach((x, i) => x.classList.toggle('attiva', i === k)); } };
                  ascolta(win, 'scroll', () => { if (!coda) { coda = true; win.requestAnimationFrame(posa); } }, { passive: true });
                  posa();
              };
              seguiRighe();
              const accendi = () => { provSez.classList.add('in-vista'); };
              if (fermo || !win.IntersectionObserver)
                  provSez.classList.add('in-vista');
              else {
                  const ioP = new win.IntersectionObserver((vv) => { if (vv.some((v) => v.isIntersecting)) {
                      ioP.disconnect();
                      accendi();
                  } }, { threshold: 0.3 });
                  ioP.observe(provSez);
              }
          }
          // N2.3 (notte 25/11): i due numeri di «E con due campioni?» contano fino al valore del file e la barra dell'intervallo si
          // disegna quando la sezione entra; con il movimento ridotto compaiono fermi
          const dueSez = q1('#due-campioni');
          if (dueSez) {
              const conte = Array.prototype.slice.call(dueSez.querySelectorAll('[data-conta]'));
              let partito = false;
              const parti = () => {
                  if (partito)
                      return;
                  partito = true;
                  dueSez.classList.add('in-vista-due');
                  if (fermo)
                      return;
                  conte.forEach((el) => {
                      const fine = Number(el.getAttribute('data-conta')) || 0, t0 = win.performance.now();
                      const passo = (t) => { const k = Math.min(1, (t - t0) / 1200); el.textContent = String(Math.round(fine * (1 - Math.pow(1 - k, 3))));
                          if (k < 1)
                              win.requestAnimationFrame(passo); };
                      el.textContent = '0';
                      win.requestAnimationFrame(passo);
                  });
              };
              root.__dueParti = parti;          // G1: nel movimento parte quando il foglio copre il 35% dello schermo (ciclo unico)
              if (fermo || !win.IntersectionObserver)
                  dueSez.classList.add('in-vista-due');
              else if (false) {
                  const ioDue = new win.IntersectionObserver((vv) => { if (vv.some((v) => v.isIntersecting)) {
                      ioDue.disconnect();
                      parti();
                  } }, { threshold: 0.35 });
                  ioDue.observe(dueSez);
              }
          }
          // U7 (ultimo giro 25/11): da «Il risultato» a «E con due campioni?». I 64 quadrati compaiono in onda quando la sezione entra;
          // il 34% conta fino al valore quando il risultato compare, «0,83» quando si vede (numeri dal testo della pagina, cioe' dal
          // file, e alla fine il testo esatto); il titolo «E con due campioni?» si compone come gli occhielli; la linea tratteggiata e
          // le due barre si disegnano (CSS). Con il movimento ridotto tutto fermo e visibile
          const contaSu = (el) => {
              if (!el || fermo || el.__contato)
                  return;
              el.__contato = true;
              const orig = el.textContent, m = /^(\D*)(\d+)(?:,(\d+))?(.*)$/.exec(orig.trim());
              if (!m)
                  return;
              const dec = m[3] ? m[3].length : 0, fine = Number(m[2] + (dec ? '.' + m[3] : '')), t0 = win.performance.now();
              const passo = (t) => { const k = Math.min(1, (t - t0) / 1100), v = fine * (1 - Math.pow(1 - k, 3));
                  el.textContent = k < 1 ? m[1] + v.toFixed(dec).replace('.', ',') + m[4] : orig;
                  if (k < 1)
                      win.requestAnimationFrame(passo); };
              win.requestAnimationFrame(passo);
          };
          root.__contaSu = contaSu;
          if (risSez && !fermo) {
              celleP.forEach((c, i) => c.style.setProperty('--j', String(i)));
              if (win.IntersectionObserver) {
                  const ioR = new win.IntersectionObserver((vv) => { if (vv.some((v) => v.isIntersecting)) {
                      ioR.disconnect();
                      risSez.classList.add('onda');
                  } }, { threshold: 0.2 });
                  ioR.observe(risSez);
              }
              else
                  risSez.classList.add('onda');
              const cifra = q1('.somiglianza .cifra');
              if (cifra && win.IntersectionObserver) {
                  const ioC = new win.IntersectionObserver((vv) => { if (vv.some((v) => v.isIntersecting && v.intersectionRatio > 0.9)) {
                      ioC.disconnect();
                      contaSu(cifra);
                  } }, { threshold: [0.9, 1] });
                  ioC.observe(cifra);
              }
          }
          // G1: il titolo «E con due campioni?» si compone quando il foglio copre il 35% dello schermo (nel ciclo unico)
          const osservati = qq('[data-scramble]');
          if (!fermo && win.IntersectionObserver) {
              this._io = new win.IntersectionObserver((vv) => {
                  vv.forEach((v) => {
                      if (!v.isIntersecting)
                          return;
                      this._io.unobserve(v.target);
                      mescola(v.target);
                  });
              }, { threshold: 0.2 });
              osservati.forEach((el) => this._io.observe(el));
          }
          // B11 (24/11): la sfera della prima schermata si disegna la prima volta con il suo carattere (gli anelli di scritte non
          // cambiano dopo); se il carattere tarda, dopo 2,5 s si disegna comunque
          let caratterePronto = !doc.fonts || doc.fonts.status === 'loaded';
          if (!caratterePronto) {
              doc.fonts.load('12px "Geist Mono"').then(() => { caratterePronto = true; }, () => { caratterePronto = true; });
              dopo(() => { caratterePronto = true; }, 2500);
          }
          const dimensionaTutto = () => {
              Object.keys(cores).forEach((k) => cores[k].dimensiona());
              if (nucleo)
                  nucleo.dimensiona();
              campi.forEach((c) => c.dimensiona());
              cuciture.forEach((c) => c.dimensiona());
              misura();
              if (filo)
                  posaFilo(filo.k);
          };
          dimensionaTutto();
          if (doc.fonts && doc.fonts.ready)
              doc.fonts.ready.then(() => { if (!this._fermo)
                  misura(); });
          const visibile = (el, H) => { if (!el)
              return false; const r = el.getBoundingClientRect(); return r.bottom > -40 && r.top < H + 40 && r.height > 0; };
          let ultimoSpia = 0;
          let ultimaCuc = 0;
          let ultimoCampo = 0;
          let ultimoT = 0;
          let ultimoFilo = 0;
          let ultimoFermo = 0;
          let qA = 0;
          let stBaseV = 60, stBaseT = -1e9;
          const stBase = () => {          // S2 (25/11): la cima della fascia (in % dello schermo) sotto il secondo tasto dell'apertura, piu' 14 px
              const t = win.performance.now();
              if (t - stBaseT < 500)
                  return stBaseV;
              stBaseT = t;
              const tasti = apertura ? apertura.querySelectorAll('.tasto') : [];
              const ul = tasti.length ? tasti[tasti.length - 1].getBoundingClientRect() : null;
              const r0 = fissoA ? fissoA.getBoundingClientRect() : null;      // il livello fisso dell'apertura, non la sezione che scorre
              if (ul && r0 && ul.height) {
                  const giu = ul.bottom - r0.top + 14, H0 = win.innerHeight || 1;
                  stBaseV = Math.min(80, Math.max(60, (giu / H0) * 100));
              }
              return stBaseV;
          };
          const sicuro = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);      // M1: mai NaN o infinito negli stati
          let qV = 0;
          let qF = 0;
          // V2 (25/11): con il campo del Neural Core a fuoco (tastiera aperta) la scena resta ferma su «core aperto», il modulo si appoggia
          // sopra la tastiera (visualViewport), la pagina non salta e la sfera si riduce nello spazio sopra il modulo
          const tast = { on: false, y0: 0, q: 0, kb: -1, tieni: 0, h0: 0, eraAperta: false };
          const geoN6 = { t: -1e9, W: 0, H: 0, barra: 64, modulo: 0 };
          let distSatF = 1.45;
          // N2 (25/11): la tenuta vale solo con la tastiera davvero aperta (visualViewport ridotto, o finestra accorciata di oltre 100 px)
          const tastAperta = () => { if (!tast.on) return false; const vv = win.visualViewport;
              const kb = vv ? win.innerHeight - vv.height - vv.offsetTop : 0;
              const si = kb > 100 || (tast.h0 - win.innerHeight) > 100; if (si) tast.eraAperta = true; return si; };
          let qR = 0;
          let cameraSu = false;
          const posaCamera = (tf, sr, cx, cy) => {
              if (!stanzaEl)
                  return;
              if (!tf || !sr) {
                  if (cameraSu) {
                      cameraSu = false;
                      stanzaEl.classList.remove('in-tuffo');
                      ['--tz', '--to', '--tz2', '--to2', '--ox', '--oy'].forEach((k) => stanzaEl.style.removeProperty(k));
                  }
                  return;
              }
              cameraSu = true;
              stanzaEl.classList.add('in-tuffo');
              stanzaEl.style.setProperty('--tz', tf.tz.toFixed(4));
              stanzaEl.style.setProperty('--to', tf.to.toFixed(3));
              stanzaEl.style.setProperty('--tz2', tf.tz2.toFixed(4));
              stanzaEl.style.setProperty('--to2', tf.to2.toFixed(3));
              stanzaEl.style.setProperty('--ox', (cx * sr.width).toFixed(1) + 'px');
              stanzaEl.style.setProperty('--oy', (cy * sr.height).toFixed(1) + 'px');
          };
          const zonaGeo = (Wv, H, st, sf) => {
              if (st || !zonaR)
                  return { cx: st ? 0.5 : 0.28, R: sf.R * 0.6, ring: st ? Math.max(60, Wv / 2 - 20) : 1e6 };
              const hv = limBasso > 220 ? (limBasso - 112) / 2 : H * 0.3;
              const ring = Math.max(80, Math.min(zonaR.w / 2, hv));
              return { cx: (zonaR.x + zonaR.w / 2) / zonaR.sw, R: ring / 2.28, ring };
          };
          let fus = null;
          const passoFusione = (tf, sr, cx, cy, R) => {
              if (!tf || !sr || !hudEl || !percorso) {
                  if (fus) {
                      fus.nodi.forEach((q) => q.el.style.removeProperty('--nk'));
                      percorso.style.removeProperty('--px');
                      percorso.style.removeProperty('--py');
                      hudEl.classList.remove('in-fusione');
                      hudEl.style.removeProperty('--hc');
                      if (fusEl) {
                          fusEl.style.removeProperty('--ft');
                          fusEl.style.removeProperty('--fr');
                      }
                      fus = null;
                  }
                  return;
              }
              if (!fus) {
                  const pr = percorso.getBoundingClientRect();
                  const vis = NODI.map((k) => nodo[k]).filter((x) => x && x.classList.contains('visto') && x.offsetParent !== null);
                  const nodi = vis.map((el, i) => { const r = el.getBoundingClientRect(); return { el, x: r.left - 24.5 - sr.left, y: Math.max(pr.top, Math.min(pr.bottom, r.top + 17.5)) - sr.top, lato: i % 2 ? 1 : -1 }; });
                  const conFilo = !!filo && !stretto();
                  const ax = conFilo ? filo.x : pr.left + pr.width / 2 - sr.left;
                  const ay = conFilo ? filo.y : (nodi.length ? nodi[0].y : pr.top - sr.top);
                  fus = { nodi, ax, ay, dx: sr.width / 2 - ax, dy: sr.height / 2 - ay };
                  hudEl.classList.add('in-fusione');
              }
              const n = fus.nodi.length || 1;
              const parti = [];
              let colpi = 0;
              fus.nodi.forEach((q, i) => {
                  const ti = 150 + (i * 880) / n;
                  q.el.style.setProperty('--nk', lim((tf.m - ti) / 240).toFixed(3));
                  const u = (tf.m - ti - 60) / 430;
                  if (u >= 1)
                      colpi++;
                  else if (u > 0 && tf.verso >= 0) {
                      const c0 = tuffo.curva(ti / 1400);
                      parti.push({ x: q.x + fus.dx * c0, y: q.y + fus.dy * c0, u, lato: q.lato });
                  }
              });
              tf.colpi = colpi;
              tf.parti = parti;
              tf.im = Math.max(tf.im, (0.55 * colpi) / n);
              percorso.style.setProperty('--px', (fus.dx * tf.cv).toFixed(1) + 'px');
              percorso.style.setProperty('--py', (fus.dy * tf.cv).toFixed(1) + 'px');
              hudEl.style.setProperty('--hc', tf.hc.toFixed(3));
              if (fusEl) {
                  fusEl.style.setProperty('--ft', tf.ft.toFixed(3));
                  fusEl.style.setProperty('--fr', Math.round(R * 1.6) + 'px');
              }
          };
          let luceSu = false;
          const posaLuce = (tf) => {
              if (!luceEl || !lampoEl)
                  return;
              if (!tf || (tf.lo < 0.002 && tf.lf < 0.002)) {
                  if (luceSu) {
                      luceSu = false;
                      luceEl.classList.remove('on');
                      lampoEl.classList.remove('on');
                      luceEl.style.removeProperty('--ls');
                      luceEl.style.removeProperty('--lo');
                      luceEl.style.removeProperty('--lk');
                      if (stanzaEl) {
                          stanzaEl.style.removeProperty('--als');
                          stanzaEl.style.removeProperty('--alo');
                      }
                      lampoEl.style.removeProperty('--lf');
                  }
                  return;
              }
              if (!luceSu) {
                  luceSu = true;
                  luceEl.classList.add('on');
                  lampoEl.classList.add('on');
              }
              luceEl.style.setProperty('--ls', (tf.ls * 2).toFixed(4));
              luceEl.style.setProperty('--lo', tf.lo.toFixed(3));
              luceEl.style.setProperty('--lk', (tf.lk || 0).toFixed(3));
              if (stanzaEl) {
                  stanzaEl.style.setProperty('--als', (tf.ls * 3.8).toFixed(4));
                  stanzaEl.style.setProperty('--alo', tf.lo.toFixed(3));
              }
              lampoEl.style.setProperty('--lf', tf.lf.toFixed(3));
          };
          // B3 (24/11): un solo ciclo, che dorme quando non c'e' niente da disegnare (nessun canvas visibile, niente in corso) o quando la
          // scheda e' nascosta, e si sveglia allo scorrimento, al ridimensionamento, a un tocco o a un tasto. Il movimento non cambia.
          const tutteTele = qq('canvas');
          let dorme = false;
          let quiete = 0;
          const daDisegnare = (H) => !!((scena && scena.aperta) || clip || filo || (video && !video.paused)
              || tutteTele.some((c) => { const r = c.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < H; }));
          let ultimoGiro = 0;
          // N1.1 (notte 25/11): nei primi 3 s il ciclo non dorme mai (una pagina che nasce nascosta o con le misure a zero, su un
          // telefono, non deve restare ferma finche' non si scorre)
          const nascita = win.performance.now();
          const giovane = () => win.performance.now() - nascita < 3000;
          const continua = (fn, H) => {
              if (doc.hidden && !giovane()) {
                  dorme = fn;
                  return;
              }
              if (daDisegnare(H) || giovane())
                  quiete = 0;
              else if (++quiete > 30) {          // mezzo secondo fermo, poi dorme
                  dorme = fn;
                  return;
              }
              // al massimo circa 60 giri al secondo anche sugli schermi a 120 Hz: il prossimo giro non prima di ~16 ms dal precedente
              const ora = win.performance.now(), resta = 16 - (ora - ultimoGiro);
              ultimoGiro = Math.max(ora, ultimoGiro + 16);
              if (resta > 3)
                  win.setTimeout(() => win.requestAnimationFrame(fn), resta - 2);
              else
                  win.requestAnimationFrame(fn);
          };
          // al risveglio: se la larghezza e' cambiata o le misure erano a zero, si rifanno (la sola altezza che cambia, la barra del
          // browser, resta come in B2)
          const rimisura = () => {
              if (this._ridim && (larghezza() !== wStabile || !wStabile || !hStabile || hStabile < 100))
                  this._ridim(true);
          };
          const sveglia = () => {
              rimisura();
              if (!dorme || this._fermo || statico || doc.hidden)
                  return;
              const fn = dorme;
              dorme = false;
              quiete = 0;
              win.requestAnimationFrame(fn);
          };
          ['scroll', 'resize', 'pageshow', 'focus', 'load'].forEach((ev) => ascolta(win, ev, sveglia, { passive: true }));
          ['pointerdown', 'touchstart', 'wheel', 'keydown', 'click'].forEach((ev) => ascolta(doc, ev, sveglia, { passive: true }));
          ascolta(doc, 'visibilitychange', sveglia);
          if (win.visualViewport)
              ascolta(win.visualViewport, 'resize', sveglia, { passive: true });
          // un controllo ogni secondo: se dorme e c'e' qualcosa da disegnare, riparte; se le misure erano a zero, si rifanno
          ogni(() => { rimisura(); if (dorme && !doc.hidden && daDisegnare(altezza()))
              sveglia(); }, 1000);
          this._sveglia = sveglia;
          // U5 (ultimo giro 25/11): il segno arancione degli intervalli (34% del risultato, i due di «E con due campioni?») si trascina in
          // orizzontale lungo 0-100%; al rilascio torna da solo sul valore del file con una molla (circa 0,6 s) e un clic leggero quando
          // si aggancia. Numero, intervallo ed etichette non cambiano mai; mentre si trascina c'e' solo la riga «valore misurato: …»
          // (dal file). Presa di almeno 44 px, scorrimento verticale libero (touch-action: pan-y); con il movimento ridotto, niente.
          const PT = PAROLE.trascina || {};
          const segniIC = [];
          if (!fermo) {
              const rs = q1('svg.righello'), es = rs ? rs.closest('.esito') : null;
              if (rs && rs.querySelector('circle.stima'))
                  segniIC.push({ svg: rs, el: rs.querySelector('circle.stima'), x0: 10, x1: 510, attr: ['cx'],
                      valore: es && es.querySelector('.grande') ? es.querySelector('.grande').textContent.trim() : '' });
              qq('svg.barra-ic').forEach((sv) => { const g = sv.closest('.due-grande'), st = sv.querySelector('line.stima');
                  if (!st || !g)
                      return;
                  const n = g.querySelector('.conta'), su = g.querySelector('.su');
                  segniIC.push({ svg: sv, el: st, x0: 2, x1: 398, attr: ['x1', 'x2'],
                      valore: ((n ? n.getAttribute('data-conta') : '') + (su ? su.textContent : '')).trim() }); });
          }
          segniIC.forEach((s) => {
              const casa = Number(s.el.getAttribute(s.attr[0]));
              s.casa = casa;
              s.svg.classList.add('trascinabile');
              const riga = doc.createElement('p');
              riga.className = 'riga-misurata';
              riga.hidden = true;
              riga.textContent = String(PT.riga || '').replace('{valore}', s.valore);
              s.svg.insertAdjacentElement('afterend', riga);
              const posa = (x) => s.attr.forEach((a) => s.el.setAttribute(a, x.toFixed(1)));
              const daSchermo = (cx) => { const r = s.svg.getBoundingClientRect(), vb = s.svg.viewBox.baseVal;
                  return lim(vb.x + (cx - r.left) / Math.max(1, r.width) * vb.width, s.x0, s.x1); };
              let presa = null, molla = 0;
              ascolta(s.svg, 'pointerdown', (e) => {
                  const r = s.svg.getBoundingClientRect(), vb = s.svg.viewBox.baseVal;
                  const xs = r.left + (Number(s.el.getAttribute(s.attr[0])) - vb.x) / vb.width * r.width;
                  if (Math.abs(e.clientX - xs) > 22)             // presa di 44 px attorno al segno
                      return;
                  presa = { id: e.pointerId, x: e.clientX, y: e.clientY, via: false };
                  molla++;
                  try {
                      s.svg.setPointerCapture(e.pointerId);
                  }
                  catch (x) { }
              });
              ascolta(s.svg, 'pointermove', (e) => {
                  if (!presa || e.pointerId !== presa.id)
                      return;
                  if (!presa.via && Math.abs(e.clientY - presa.y) > Math.abs(e.clientX - presa.x) + 4) {
                      presa = null;                              // gesto verticale: e' uno scorrimento della pagina
                      return;
                  }
                  presa.via = true;
                  riga.hidden = false;
                  s.svg.classList.add('trascina');
                  posa(daSchermo(e.clientX));
              });
              const lascia = (e) => {
                  if (!presa || (e && e.pointerId !== presa.id))
                      return;
                  presa = null;
                  s.svg.classList.remove('trascina');
                  const m = ++molla;
                  let x = Number(s.el.getAttribute(s.attr[0])), v = 0, t0 = 0, scattato = false;
                  const passo = (t) => {
                      if (m !== molla)
                          return;
                      const dt = t0 ? Math.min(0.05, (t - t0) / 1000) : 0.016;
                      t0 = t;
                      v += (-170 * (x - s.casa) - 26 * v) * dt;     // molla smorzata: circa 0,6 s
                      x += v * dt;
                      if (Math.abs(x - s.casa) < 0.4 && Math.abs(v) < 8) {
                          posa(s.casa);
                          riga.hidden = true;
                          if (!scattato)
                              suono.evento('passa');               // il clic leggero dell'aggancio
                          return;
                      }
                      posa(x);
                      win.requestAnimationFrame(passo);
                  };
                  win.requestAnimationFrame(passo);
              };
              ascolta(s.svg, 'pointerup', lascia);
              ascolta(s.svg, 'pointercancel', lascia);
          });
          // U2 (ultimo giro 25/11): la fascia sotto i livelli fissi (classe «sporge»), con il colore del fondo della loro sezione
          const sporgenti = [q1('.finale .tuffo-fisso'), q1('.ris-fisso'), q1('.video-fisso'), q1('.passi-pista .passi')].filter(Boolean);
          const fondoDi = (el) => { let n = el; while (n && n !== doc.documentElement) { const c = win.getComputedStyle(n).backgroundColor;
              if (c && c !== 'transparent' && !/rgba\([^)]*,\s*0\)$/.test(c)) return c; n = n.parentElement; } return ''; };
          sporgenti.forEach((el) => { const c = fondoDi(el); if (c) el.style.setProperty('--fondo-sporge', c); });
          const segnaSporge = (H) => {
              for (const el of sporgenti) {
                  const r = el.getBoundingClientRect();
                  let si = false;
                  if (r.height > 0 && r.bottom > -10 && r.top < H + 10 && win.getComputedStyle(el).position === 'sticky') {
                      const pr = el.parentElement.getBoundingClientRect();
                      si = pr.bottom > r.bottom + 0.5;
                  }
                  if (el.__sporge !== si) {
                      el.__sporge = si;
                      if (si) {           // il colore del fondo che il livello mostra in basso, e la fascia larga tutto lo schermo
                          const e = doc.elementFromPoint(Math.max(1, Math.min(larghezza() - 2, r.left + r.width / 2)), Math.max(0, Math.min(H - 1, r.bottom - 2)));
                          const c = fondoDi(e && el.contains(e) ? e : el);
                          if (c)
                              el.style.setProperty('--fondo-sporge', c);
                          el.style.setProperty('--sporge-sx', Math.round(-r.left) + 'px');
                      }
                      el.classList.toggle('sporge', si);
                  }
              }
          };
          this._segnaSporge = segnaSporge;
          // U1 (ultimo giro 25/11): il riquadro di «Fonti» si apre dalla parte dello schermo dove c'e' piu' spazio, alto al massimo lo
          // spazio libero e dentro i margini laterali; si ricalcola a ogni apertura
          const posaFonti = (d) => {
              const s = d.querySelector('summary');
              if (!s || !d.open)
                  return;
              const q = s.getBoundingClientRect(), Hv = win.visualViewport ? win.visualViewport.height : win.innerHeight, Wv = larghezza();
              const sopra = q.top - 72, sotto = Hv - q.bottom - 16;
              const su = sopra > sotto;
              d.classList.toggle('su', su);
              d.style.setProperty('--fmax', Math.max(120, Math.round((su ? sopra : sotto) - 8)) + 'px');
              const largo = Math.min(544, Wv - 32);
              const sx = Math.min(0, Wv - 16 - largo - q.left) + Math.max(0, 16 - q.left);
              d.style.setProperty('--fsx', Math.round(sx) + 'px');
          };
          qq('details.fonti-32').forEach((d) => ascolta(d, 'toggle', () => posaFonti(d)));
          // M1 (mattino 25/11): controllo della prima schermata a 1 s e a 3 s, a ogni pageshow e al ritorno visibile: in cima alla
          // pagina il testo deve vedersi, il livello fisso non e' nascosto e la sfera e' disegnata; altrimenti misure, stato e disegno
          // si rifanno
          const testoA = apertura ? apertura.querySelector('.tuffo-testo') : null;
          const statoCima = (conSfera) => {
              if (!apertura || !fissoA || statico || posizione() > 2)
                  return true;
              const op = testoA ? parseFloat(win.getComputedStyle(testoA).opacity) : 1;
              const via = fissoA.classList.contains('via') || win.getComputedStyle(fissoA).visibility === 'hidden';
              return !(sicuro(op, 0) < 0.9 || via || (conSfera && !apertura.classList.contains('sfera-disegnata')));
          };
          const rifaiCima = (conSfera) => {
              if (statoCima(conSfera))
                  return;
              if (this._ridim)
                  this._ridim(true);
              qA = 0;
              apertura.style.setProperty('--a', '0');
              apertura.style.setProperty('--z', '0');
              fissoA.style.setProperty('--buco', '0px');
              fissoA.classList.remove('passa', 'via', 'buco-aperto');
              if (cores.apertura && caratterePronto)
                  apertura.classList.add('sfera-disegnata');
              const fn = dorme || null;
              dorme = false;
              quiete = 0;
              if (fn)
                  win.requestAnimationFrame(fn);
          };
          win.setTimeout(() => rifaiCima(false), 1000);
          win.setTimeout(() => rifaiCima(true), 3000);
          ascolta(win, 'pageshow', () => rifaiCima(false));
          ascolta(doc, 'visibilitychange', () => { if (!doc.hidden)
              rifaiCima(false); });
          // ?diag=1: tre letture (0,1 s, 1 s, 3 s) in un riquadro piccolo in basso, solo a schermo (niente inviato)
          if (/[?&]diag=1(&|$)/.test(win.location.search || '')) {
              const box = doc.createElement('pre');
              box.setAttribute('aria-hidden', 'true');
              box.style.cssText = 'position:fixed;left:6px;right:6px;bottom:6px;z-index:2147483647;margin:0;padding:6px 8px;max-height:46vh;overflow:auto;font:10px/1.35 monospace;white-space:pre-wrap;background:rgba(20,21,23,.88);color:#ECEDE8;border-radius:6px;pointer-events:none';
              doc.body.appendChild(box);
              const leggi = (eti) => {
                  const vv = win.visualViewport;
                  const op = testoA ? win.getComputedStyle(testoA).opacity : '-';
                  box.textContent += eti + ' · ' + win.innerWidth + '×' + win.innerHeight + ' · vv ' + (vv ? Math.round(vv.height) : '-')
                      + ' · stabile ' + hStabile + ' · --vh ' + root.style.getPropertyValue('--vh') + ' · scorr ' + Math.round(posizione())
                      + ' · ' + doc.visibilityState + ' · q ' + sicuro(qA, NaN).toFixed(3) + ' · a ' + (apertura ? apertura.style.getPropertyValue('--a') : '-')
                      + ' · buco ' + (fissoA ? fissoA.style.getPropertyValue('--buco') : '-') + ' · pagina [' + root.className + '] · fisso ['
                      + (fissoA ? fissoA.className : '-') + '] · testo ' + op + '\n';
              };
              win.setTimeout(() => leggi('0,1 s'), 100);
              win.setTimeout(() => leggi('1 s'), 1000);
              win.setTimeout(() => leggi('3 s'), 3000);
          }
          const ciclo = (t) => {
              if (this._fermo)
                  return;
              if (statico)
                  return;
              if (altezza() > SOGLIA_STATICA) {
                  passaAStatico();
                  return;
              }
              if (this._lenis) {
                  try {
                      this._lenis.raf(t);
                  }
                  catch (e) { }
              }
              const H = altezza();
              const Wv = larghezza();
              const diag = Math.hypot(Wv, H);
              const st = stretto();
              // M1 (mattino 25/11): ogni numero passa da un controllo; dt sempre tra 0,001 e 0,05
              if (this._segnaSporge)
                  this._segnaSporge(H);
              const dtG = ultimoT ? (t - ultimoT) / 1000 : 0.016;
              const dt = Math.min(0.05, Math.max(0.001, isFinite(dtG) ? dtG : 0.016));
              ultimoT = t;
              const morbido = (cur, target) => (this._lenis || saltaMorbido ? target : cur + (target - cur) * (1 - Math.exp(-dt * 16)));
              let nascondi = false;
              let ritira = false;
              if (apertura && fissoA) {
                  const r = apertura.getBoundingClientRect();
                  if (r.bottom > -10 && r.top < H + 10) {
                      const corsa = Math.max(1, r.height - H);
                      // M1 (mattino 25/11): in cima alla pagina (scorrimento <= 2 px) la prima schermata e' per forza nello stato
                      // iniziale; un valore non finito lascia l'ultimo valido
                      const qN = posizione() <= 2 ? 0 : morbido(qA, lim(-r.top / corsa));
                      qA = sicuro(qN, sicuro(qA, 0));
                      const q = qA;
                      const a = sicuro(facile(lim(q / 0.3)), 0);
                      const z = sicuro(facile(lim((q - 0.24) / 0.56)), 0);
                      const hb = sicuro(lim((q - 0.5) / 0.38), 0);
                      apertura.style.setProperty('--a', a.toFixed(4));
                      apertura.style.setProperty('--z', z.toFixed(4));
                      if (st)       // S2: a riposo la fascia scura comincia sotto i due tasti dell'apertura (mai sopra il secondo)
                          apertura.style.setProperty('--st', (stBase() * (1 - a)).toFixed(2) + '%');
                      else
                          apertura.style.setProperty('--sx', (50 * (1 - a)).toFixed(2) + '%');
                      const buco = sicuro(Math.pow(hb, 1.7) * (diag / 2 + 60), 0);
                      fissoA.style.setProperty('--buco', buco.toFixed(1) + 'px');
                      fissoA.classList.toggle('buco-aperto', buco > 0);     // la maschera circolare solo mentre il buco si apre
                      fissoA.classList.toggle('passa', q > 0.62);
                      fissoA.classList.toggle('via', hb >= 1);
                      if (hb < 1 && caratterePronto) {
                          const R0 = sicuro(st ? Math.min(Wv, H) * 0.19 : Math.min(Wv * 0.5, H) * 0.2, 120);
                          const rS = String(Math.round(R0 * (1 + 0.25 * a)));
                          if (apertura.dataset.sfera !== rS)
                              apertura.dataset.sfera = rS;      // il raggio disegnato della sfera (per le misure di B2)
                          if (cores.apertura && !apertura.classList.contains('sfera-disegnata'))
                              apertura.classList.add('sfera-disegnata');      // B11: il fotogramma fermo sfuma
                          if (cores.apertura)
                              cores.apertura.disegna({ cx: st ? 0.5 : 0.75 - 0.25 * a, cy: st ? 0.8 - 0.3 * a : 0.53 - 0.03 * a, R: R0 * (1 + 0.25 * a), cam: 3.4 - 3.12 * z, zoom: 1 + 2.5 * Math.pow(z, 1.5), centro: 1 - hb, alfa: 1 }, t);
                      }
                  }
              }
              if (righe.length && registroBox && scansione) {
                  const rb = registroBox.getBoundingClientRect();
                  if (rb.bottom > -100 && rb.top < H + 100) {
                      const yS = scansione.getBoundingClientRect().top;
                      let k = -1;
                      for (let i = 0; i < offRighe.length; i++) {
                          if (rb.top + offRighe[i] < yS - 6)
                              k = i;
                      }
                      segnaRiga(k);
                  }
              }
              if (t - ultimaCuc > 33) {
                  ultimaCuc = t;
                  cuciture.forEach((c) => {
                      const r = c.tela.getBoundingClientRect();
                      if (r.bottom < 0 || r.top > H)
                          return;
                      c.disegna(lim((H - r.top) / (H + r.height)), t);
                  });
              }
              if (t - ultimoCampo > 90) {
                  ultimoCampo = t;
                  campi.forEach((c) => { if (visibile(c.tela, H))
                      c.sfarfalla(); });
              }
              if (metodo) {
                  const rm = metodo.getBoundingClientRect();
                  if (rm.bottom > 0 && rm.top < H) {
                      // N2.1 (notte 25/11, bozza 2): i passi sono fermi uno sull'altro; quale e' attivo lo dice la corsa della pista
                      // (stessa lunghezza di prima, quindi lo scorrimento non cambia); si vede solo il passo attivo
                      // M6 (mattino 25/11): la corsa della lista fissa (da quando si ferma a quando riparte) e' divisa in sei parti uguali;
                      // ogni passo e' pieno nella sua parte, il cambio e' una dissolvenza incrociata in una fascia del 10% attorno al confine
                      // (chi entra sale nel primo 60% della fascia, chi esce scende nell'ultimo 60%: mai un momento senza testo)
                      let att = 0;
                      if (pistaPassi && olPassi && passi.length) {
                          const rp = pistaPassi.getBoundingClientRect(), ro = olPassi.getBoundingClientRect();
                          const fermoDa = parseFloat(win.getComputedStyle(olPassi).top) || 0;      // dove la lista si ferma (0 o 56% dello schermo)
                          const corsaP = Math.max(1, rp.height - ro.height);
                          const u = sicuro(lim((fermoDa - rp.top) / corsaP), 0) * passi.length;
                          const B = 0.1;
                          const liscio = (x) => { const y = lim(x); return y * y * (3 - 2 * y); };
                          let piuAlta = -1;
                          passi.forEach((p, i) => {
                              const entra = i === 0 ? 1 : liscio((u - (i - B / 2)) / (B * 0.6));
                              const esce = i === passi.length - 1 ? 1 : 1 - liscio((u - (i + 1 - B / 2 + B * 0.4)) / (B * 0.6));
                              const o = sicuro(Math.min(entra, esce), 0);
                              const oS = o.toFixed(2), avS = lim(u - i).toFixed(2);
                              if (righeMov.on) {
                                  if (o > piuAlta) { piuAlta = o; att = i; }
                                  return;
                              }
                              if (p.__o !== oS) {          // si scrive solo quando cambia (niente ricalcolo degli stili a ogni giro)
                                  p.__o = oS;
                                  p.style.opacity = oS;
                                  p.style.filter = o > 0.995 || o < 0.005 ? 'none' : 'blur(' + ((1 - o) * 8).toFixed(1) + 'px)';
                                  p.style.transform = o > 0.995 ? 'none' : 'translateY(' + ((1 - o) * 8).toFixed(1) + 'px)';
                                  p.style.visibility = o < 0.005 ? 'hidden' : '';
                              }
                              if (p.__av !== avS && o > 0.005) {
                                  p.__av = avS;
                                  p.style.setProperty('--av', avS);
                              }
                              if (o > piuAlta) {
                                  piuAlta = o;
                                  att = i;
                              }
                          });
                      }
                      if (righeMov.on && pistaPassi && olPassi) {
                          const rp = pistaPassi.getBoundingClientRect(), ro = olPassi.getBoundingClientRect();
                          const fermoDa = parseFloat(win.getComputedStyle(olPassi).top) || 0;
                          const uT = sicuro(lim((fermoDa - rp.top) / Math.max(1, rp.height - ro.height)), 0) * passi.length;
                          const tS = uT.toFixed(3);
                          if (tS !== righeMov.tS) { righeMov.tS = tS; olPassi.style.setProperty('--t', tS); }
                          const f = uT - Math.floor(uT), nel = f > 0.86 || f < 0.14;
                          if (righeMov.cambi < 2 && nel && dt > 0) righeMov.campioni.push(dt * 1000);
                          const b = Math.round(uT);
                          if (righeMov.ultimo >= 0 && b !== righeMov.ultimo && !nel) {
                              righeMov.cambi++;
                              if (righeMov.cambi === 2 && righeMov.campioni.length >= 4) {
                                  const media = righeMov.campioni.reduce((x, y) => x + y, 0) / righeMov.campioni.length;
                                  root.__righeMedia = media;
                                  if (media > 28) { righeMov.on = false; root.classList.remove('righe-mov'); passi.forEach((p) => { p.__o = null; }); }
                              }
                          }
                          if (!nel) righeMov.ultimo = b;
                      }
                      passi.forEach((p, i) => { p.classList.toggle('attivo', i === att); p.classList.toggle('spento', i !== att); });
                      const modo = att >= 0 && passi[att] ? Number(passi[att].getAttribute('data-modo')) : 0;
                      if (cores.metodo && visibile(cores.metodo.tela, H)) {
                          const cw = cores.metodo.tela.clientWidth;
                          const chh = cores.metodo.tela.clientHeight;
                          cores.metodo.disegna({ cx: 0.5, cy: 0.5, R: Math.min(cw, chh) * (st ? 0.27 : 0.29), modo, cam: 3.4, zoom: 1, alfa: 1 }, t);
                      }
                  }
              }
              // G1 (25/11): «E con due campioni?» e' un foglio che sale sopra «Il risultato»: una sola variabile --p (0-1), scritta solo
              // dentro quel tratto e solo quando cambia; al 35% dello schermo coperto partono titolo, etichetta, numeri e barre
              if (foglioEl && risSez && !fermo) {
                  const rd = foglioEl.getBoundingClientRect();
                  if (rd.top < H + 200 && rd.bottom > 0) {
                      const pS = lim((H - rd.top) / ((st ? 0.5 : 0.7) * H)).toFixed(3);
                      if (pS !== pFoglio) {
                          pFoglio = pS;
                          if (!st)          // sotto i 900 px il risultato non e' fisso: si muove solo il foglio (fotogrammi)
                              risSez.style.setProperty('--p', pS);
                          if (lineaFoglio)  // la variabile solo sulla linea (un elemento piccolo), non su tutto il foglio
                              lineaFoglio.style.setProperty('--p', pS);
                      }
                      if (!foglioSu && H - rd.top >= 0.35 * H) {
                          foglioSu = true;
                          foglioEl.classList.add('foglio-su');
                          if (root.__dueParti)
                              root.__dueParti();
                          const tD = q1('#t-due-campioni');
                          if (tD)
                              mescola(tD);
                      }
                  }
              }
              if (risSez && celleP.length) {
                  const r = risSez.getBoundingClientRect();
                  if (r.bottom > 0 && r.top < H) {
                      if (!st) {
                          // G1 (25/11): con il movimento l'ultimo tratto di 0,7 schermi della pista e' quello del foglio che sale
                          const corsa = Math.max(1, r.height - H - (fermo ? 0 : 0.7 * H));
                          qR = morbido(qR, lim(-r.top / corsa));
                          segnaPazienti(Math.floor(lim(qR / 0.8) * celleP.length + 0.0001));
                      }
                      else {
                          const pr = lim((H * 0.85 - r.top) / (r.height * 0.9));
                          segnaPazienti(Math.floor(lim(pr / 0.85) * celleP.length + 0.0001));
                      }
                  }
              }
              if (pista && portale && videoSez) {
                  const r = pista.getBoundingClientRect();
                  const visV = r.bottom > 0 && r.top < H;
                  if (visV || (video && !video.paused)) {
                      const corsa = Math.max(1, r.height - H);
                      qV = morbido(qV, lim(-r.top / corsa));
                      const p = qV;
                      const r0 = Math.min(Wv, H) * (st ? 0.3 : 0.16);
                      const piena = Math.hypot(Wv / 2, H * 0.64) + 30;
                      const g = p < 0.04 ? 0 : facile(lim((p - 0.04) / 0.26));
                      let rv = r0 + (piena - r0) * g;
                      if (!visV)
                          rv = 0;
                      const vo = 1 - facile(lim((p - 0.86) / 0.12));
                      videoSez.style.setProperty('--rv', rv.toFixed(1) + 'px');
                      const cyP = 64 + (cyVideo - 64) * g;
                      videoSez.style.setProperty('--cy', cyP.toFixed(2) + '%');
                      videoSez.style.setProperty('--vy', (H * cyP / 100 - (vtPx + (H - vtPx - vbPx) / 2)).toFixed(1) + 'px');
                      videoSez.style.setProperty('--pbg', 'rgb(' + Math.round(14 * (1 - vo)) + ',' + Math.round(16 * (1 - vo)) + ',' + Math.round(18 * (1 - vo)) + ')');
                      videoSez.style.setProperty('--ao', (1 - lim((p - 0.03) / 0.1)).toFixed(3));
                      videoSez.style.setProperty('--vo', vo.toFixed(3));
                      videoSez.style.setProperty('--vp', lim(p / 0.22).toFixed(3));
                      const hudV = lim((p - 0.25) / 0.06) * (1 - lim((p - 0.8) / 0.04));
                      videoSez.style.setProperty('--vhud', hudV.toFixed(3));
                      if (videoHud)
                          videoHud.classList.toggle('attivo', hudV > 0.6);
                      const pieno = visV && g >= 0.995;
                      portale.classList.toggle('pieno', pieno);
                      if (pieno) {
                          nascondi = true;
                          ritira = !st;
                      }
                      if (video) {
                          const dentroV = visV && rv > 6 && vo > 0.04;
                          if (dentroV && !videoTelefono && !utentePausa && video.paused && !video.ended && !avviato && win.performance.now() > viaggioFino) {
                              avviato = true;
                              const pr = video.play();
                              if (pr && pr.catch)
                                  pr.catch(() => { avviato = false; statoPlay(); });
                          }
                          if (!dentroV && !video.paused) {
                              video.pause();
                              avviato = false;
                          }
                      }
                  }
              }
              passoVera(dt);
              tuffo.avanza();
              if (filo && t - ultimoFilo > 160) {
                  ultimoFilo = t;
                  posaFilo(filo.k);
                  aggiornaLinea();
              }
              if (finale) {
                  const r = finale.getBoundingClientRect();
                  const vis = r.bottom > 0 && r.top < H;
                  if (vis) {
                      const corsa = Math.max(1, r.height - H);
                      qF = tastAperta() ? tast.q : morbido(qF, lim(-r.top / corsa));
                      const q = qF;
                      const ass = facile(lim(q / 0.34));
                      const sp = facile(lim((q - 0.26) / 0.22));
                      const jv = facile(lim((q - 0.32) / 0.2));
                      const hudO = lim((q - 0.42) / 0.14);
                      finale.style.setProperty('--s', sp.toFixed(4));
                      finale.style.setProperty('--m', ass.toFixed(4));
                      finale.style.setProperty('--cf', lim(q / 0.1).toFixed(3));
                      const tfH = tuffo.f && tuffo.f.modo === 'camera' ? tuffo.f : null;
                      if (hudEl) {
                          hudEl.style.opacity = (hudO * (tfH ? tfH.pm : 1)).toFixed(3);
                          hudEl.classList.toggle('attivo', hudO > 0.6 && !tfH);
                      }
                      if (q > 0.3)
                          nascondi = true;
                      const t1 = t * 0.001;
                      let lc = 0.24 + 0.07 * Math.sin(t1 * 1.6);
                      let luce = 0;
                      let scanY;
                      if (statoC === 'inviata' || statoC === 'trascrivo') {
                          lc = 0.38 + 0.16 * Math.sin(t1 * 13);
                          luce = 1;
                          scanY = Math.sin(t1 * 2.6) * 0.95;
                      }
                      else if (statoC === 'parla') {
                          lc = 0.26 + ampV * 0.95;
                          luce = 0.3;
                      }
                      else if (statoC === 'da_inviare') {
                          lc = 0.3 + 0.24 * contoFraz;
                          luce = 0.4 * contoFraz;
                      }
                      const { Rb, sf, zg } = geometriaFinale(Wv, H, st);
                      let ccx = st ? 0.5 : 0.68 + (zg.cx - 0.68) * sp;
                      let ccy = st ? 0.62 - 0.32 * sp : 0.52 + (sf.cy - 0.52) * sp;
                      let cR = st ? (Rb + (sf.R - Rb) * sp) * (1 - 0.4 * sp) : Rb + (zg.R - Rb) * sp;
                      // L1 (25/11): mentre il microfono ascolta la sfera respira piano e si raccoglie verso il nucleo; con il campo non vuoto
                      // e un tasto da meno di 1,2 s resta «attenta» (un po' piu' luminosa). Solo eventi veri, nessuna ampiezza simulata
                      const micOn = !fermo && root.classList.contains('mic-ascolta');
                      if (micOn) {
                          lc = 0.3 + 0.08 * Math.sin(t1 * 1.3);
                          cR *= 0.955 + 0.015 * Math.sin(t1 * 1.3);
                      }
                      else if (!fermo && win.performance.now() < attentaFino && inputCore && inputCore.value)
                          lc += 0.06;
                      if (!tast.on && tast.tieni && (win.performance.now() < tast.tieni ? Math.abs(win.scrollY - tast.y0) > 2 && (win.scrollTo({ top: tast.y0, behavior: 'instant' }), true) : (tast.tieni = 0, false))) qF = tast.q;
                      // N6 (25/11, telefono): sotto i 900 px, a core aperto, la sfera al centro dello spazio fra la barra e il modulo, con il
                      // diametro minore fra il 78% della larghezza e il 70% di quello spazio, e le etichette dei satelliti dentro lo schermo
                      distSatF = st ? 1.45 : 1.62;
                      if (st && formCore && !tastAperta()) {
                          const kN = facile(lim((sp - 0.5) / 0.5));
                          if (kN > 0) {
                              if (t - geoN6.t > 300 || geoN6.W !== Wv || geoN6.H !== H) {
                                  const gb = q1('.nav-guscio'); geoN6.barra = gb ? gb.getBoundingClientRect().bottom : 64;
                                  geoN6.modulo = formCore.getBoundingClientRect().top; geoN6.t = t; geoN6.W = Wv; geoN6.H = H;
                              }
                              const spazio = Math.max(120, geoN6.modulo - geoN6.barra - 8);
                              const mezzaEti = 44, dentro = (Wv / 2 - mezzaEti - 8) / 0.82;      // 0,82 = coseno degli angoli dei satelliti
                              const D = Math.min(0.78 * Wv, 0.70 * spazio, 2 * dentro / 1.22);
                              ccx += (0.5 - ccx) * kN;
                              ccy += ((geoN6.barra + 4 + spazio / 2) / H - ccy) * kN;
                              cR += (D / 2 - cR) * kN;
                              distSatF = 1.45 + (Math.min(1.45, Math.max(1.22, dentro / Math.max(1, cR))) - 1.45) * kN;
                          }
                      }
                      if (!tastAperta() && tast.kb > 0 && formCore) { tast.kb = -1; formCore.style.transform = ''; }
                      if (tastAperta() && formCore) {
                          const vv = win.visualViewport;
                          const kb = vv ? Math.max(0, Math.round(win.innerHeight - vv.height - vv.offsetTop)) : 0;
                          if (kb !== tast.kb) { tast.kb = kb; formCore.style.transform = kb ? 'translateY(' + (-kb) + 'px)' : ''; }
                          if (Math.abs(win.scrollY - tast.y0) > 2) win.scrollTo({ top: tast.y0, behavior: 'instant' });
                          const vH = vv ? vv.height : H, alto = 64, basso = Math.min(formCore.getBoundingClientRect().top, (vv ? vv.offsetTop : 0) + vH) - 12;
                          const spazio = Math.max(80, basso - alto);
                          ccy = (alto + spazio / 2) / H;
                          cR = Math.min(cR, spazio * 0.36, Wv * 0.36);
                      }
                      scenaQ += (0 - scenaQ) * (1 - Math.exp(-dt * 3.6));
                      const qS = facile(lim(scenaQ));
                      const geo = geometriaScena(Wv, H, st, sf, Rb);
                      const figM = passoFigura(t, !st && qS > 0.6);
                      if (qS > 0.001) {
                          ccx += (geo.cx - ccx) * qS;
                          ccy += (geo.cy - ccy) * qS;
                          cR += (geo.R - cR) * qS;
                      }
                      if (scena && (scena.aperta || qS > 0.001))
                          posaScena(geo);
                      const tf = tuffo.f && tuffo.f.modo === 'camera' ? tuffo.f : null;
                      const sr0 = tf && stanzaEl ? stanzaEl.getBoundingClientRect() : null;
                      if (tf) {
                          ccx += (0.5 - ccx) * tf.cv;
                          ccy += (0.5 - ccy) * tf.cv;
                      }
                      passoFusione(tf, sr0, ccx, ccy, cR);
                      root.__nc = { cx: ccx * Wv, cy: ccy * H, R: cR, anello: zg.ring, sp };
                      posaLuce(tf);
                      if (sr0) {
                          tuffo.geo.x = sr0.left + ccx * sr0.width;
                          tuffo.geo.y = sr0.top + ccy * sr0.height;
                          tuffo.geo.R = cR;
                      }
                      posaCamera(tf, sr0, ccx, ccy);
                      const dentroNucleo = !!(scena && scena.aperta && tuffo.f && tuffo.p >= 1);
                      const livIn = 0;
                      suono.livello(livIn);
                      const vivoGL = !!(nucleo && nucleo.vivo && !glSpento);
                      if (cores.finale && !dentroNucleo)
                          cores.finale.disegna({
                              cx: ccx, cy: ccy, R: cR,
                              ass, cam: 3.4, zoom: 1, centro: ass * (1 - jv), alfa: 1,
                              jv, amp: ampV, lc, luce, scanY, vibra: 0,
                              sat: satAttivo, anello: anelloTesto, filo: st || qS > 0.05 ? null : (tf && fus && filo ? { x: fus.ax + fus.dx * tf.cv, y: fus.ay + fus.dy * tf.cv, k: filo.k } : filo), filoA, attivo: statoC !== 'pronta',
                              anelloMax: zg.ring, anelloK: sp,
                              ascolto: micOn, impulsi: impulsiMic, impulsiP: impulsiTasti, distSat: distSatF,
                              gl: vivoGL, conto: statoC === 'da_inviare' ? contoFraz : 0, scena: qS > 0.01 ? { x: geo.sx, y: geo.sy, verticale: geo.verticale, q: qS } : null, verso: versoParola(), modo: figM, figCorta: figM > 0, tuffo: tf
                          }, t);
                      if (vivoGL && !dentroNucleo) {
                          const tm0 = win.performance.now();
                          nucleo.disegna({ cx: ccx, cy: ccy, R: cR, jv, stato: statoC, rifiuto: rifiutoAttivo && statoC === 'parla', amp: ampV, livello: livIn, conto: statoC === 'da_inviare' ? contoFraz : 0, parola: kParola, larghezza: Wv, altezza: H, figura: figM > 0, tuffo: tf }, t);
                          msNucleo += (win.performance.now() - tm0 - msNucleo) * 0.05;
                          root.__msNucleo = msNucleo;
                          emaFrame += (dt * 1000 - emaFrame) * 0.05;
                          if (emaFrame > 24) {
                              tLento += dt;
                              tVeloce = 0;
                              if (tLento > 1.5 && nucleo.qualita > 0) {
                                  nucleo.qualita = nucleo.qualita - 1;
                                  tLento = 0;
                              }
                              else if (tLento > 3 && nucleo.qualita === 0 && gpuModo === 'auto') {
                                  glSpento = true;
                                  nucleo.pulisci();
                                  root.classList.remove('con-nucleo-gl');
                              }
                          }
                          else if (emaFrame < 15) {
                              tVeloce += dt;
                              tLento = 0;
                              if (tVeloce > 8 && nucleo.qualita < 2) {
                                  nucleo.qualita = nucleo.qualita + 1;
                                  tVeloce = 0;
                              }
                          }
                          else {
                              tLento = 0;
                              tVeloce = 0;
                          }
                      }
                      suono.presenza(hudO);
                      if (hudO > 0.6 && !coreDentro) {
                          coreDentro = true;
                          suono.evento('core_on');
                      }
                      else if (hudO < 0.3 && coreDentro) {
                          coreDentro = false;
                          suono.evento('core_off');
                      }
                  }
              }
              if (scena && scena.passo)
                  scena.passo(t);
              if (finale) {
                  const rr = finale.getBoundingClientRect();
                  if (!(rr.bottom > 0 && rr.top < H)) {
                      suono.presenza(0);
                      if (nucleo && nucleo.vivo && !this._glPulito) {
                          nucleo.pulisci();
                          this._glPulito = true;
                      }
                  }
                  else
                      this._glPulito = false;
              }
              // S4 (25/11): sicurezza a tempo: se nei primi 3 s la media dei fotogrammi supera 34 ms, modo leggero per tutta la visita
              if (!leggeroVisita && misuraLeggero.fine === 0)
                  misuraLeggero.fine = t + 3000;
              if (!leggeroVisita && misuraLeggero.fine > 0 && dt > 0) {
                  if (t < misuraLeggero.fine) {
                      misuraLeggero.s += dt * 1000;
                      misuraLeggero.n++;
                  }
                  else if (misuraLeggero.n > 10) {
                      if (misuraLeggero.s / misuraLeggero.n > 34) {
                          leggeroVisita = true;
                          root.classList.add('leggero-visita');
                          Object.keys(cores).forEach((k) => cores[k].dimensiona());
                          if (nucleo)
                              nucleo.qualita = 0;
                      }
                      misuraLeggero.fine = -1;
                  }
              }
              if (alone)
                  alone.passo(dt, t);
              if (chiedi)
                  chiedi.classList.toggle('nascosto', nascondi || chiediCopre(t) || !!(scena && scena.aperta));
              if (navG)
                  navG.classList.toggle('ritirata', ritira || !!(scena && scena.dentro));
              if (t - ultimoSpia > 140) {
                  ultimoSpia = t;
                  let cur = 'apertura';
                  sezioni.forEach((s) => { if (s.getBoundingClientRect().top < H * 0.45)
                      cur = s.getAttribute('data-sezione'); });
                  voci.forEach((v) => v.classList.toggle('corrente', v.getAttribute('data-vai') === cur));
              }
              continua(ciclo, H);
          };
          const fermoFinale = () => {
              dimensionaTutto();
              const t = 4000;
              const Wv = larghezza();
              const H = statico ? 900 : altezza();
              const st = stretto();
              if (cores.apertura && apertura && !apertura.classList.contains('sfera-disegnata'))
                  apertura.classList.add('sfera-disegnata');      // B11: anche fermo, il fotogramma fermo lascia il posto al disegno
              if (cores.apertura)
                  cores.apertura.disegna({ cx: st ? 0.5 : 0.75, cy: st ? 0.8 : 0.53, R: st ? Math.min(Wv, H) * 0.19 : Math.min(Wv * 0.5, H) * 0.2, cam: 3.4, zoom: 1, centro: 1, alfa: 1, subito: true }, t);
              if (cores.metodo) {
                  const c = cores.metodo.tela;
                  cores.metodo.disegna({ cx: 0.5, cy: 0.5, R: Math.min(c.clientWidth, c.clientHeight) * 0.25, modo: 3, cam: 3.4, zoom: 1, alfa: 1, subito: true }, t);
              }
              cuciture.forEach((c) => c.disegna(0.5, t));
              campi.forEach((c) => c.tutto());
              segnaPazienti(celleP.length);
              if (finale) {
                  finale.style.setProperty('--s', '1');
                  finale.style.setProperty('--m', '1');
              }
              if (hudEl) {
                  hudEl.style.opacity = '1';
                  hudEl.classList.add('attivo');
              }
              if (videoSez) {
                  videoSez.style.setProperty('--vhud', '1');
                  videoSez.style.setProperty('--vp', '1');
              }
              if (!clip && statoC === 'pronta' && !filo)
              disegnaFinaleFermo();
          };
          const cicloFermo = (t) => {
              if (this._fermo || statico)
                  return;
              const dt = ultimoT ? Math.min(0.05, (t - ultimoT) / 1000) : 0.016;
              ultimoT = t;
              passoVera(dt);
              tuffo.avanza();
              if (scena && scena.passo)
                  scena.passo(t);
              if (alone)
                  alone.passo(dt, t);
              if (t - ultimoFermo > 160) {
                  ultimoFermo = t;
                  if (filo) {
                      posaFilo(filo.k);
                      aggiornaLinea();
                  }
                  disegnaFinaleFermo();
                  if (chiedi && finale) {
                      const r = finale.getBoundingClientRect();
                      chiedi.classList.toggle('nascosto', (r.top < altezza() * 0.5 && r.bottom > altezza() * 0.5) || !!(scena && scena.aperta));
                  }
                  if (navG)
                      navG.classList.toggle('ritirata', !!(scena && scena.dentro));
              }
              continua(cicloFermo, altezza());
          };
          const passaAStatico = () => {
              if (statico)
                  return;
              statico = true;
              fermo = true;
              if (this._lenis) {
                  try {
                      this._lenis.destroy();
                  }
                  catch (e) { }
                  this._lenis = null;
              }
              (this._intervalli || []).forEach((x) => win.clearInterval(x));
              (this._timer || []).forEach((x) => win.clearTimeout(x));
              genV++;
              fermaClip();
              root.classList.remove('modo-movimento', 'schermo-basso');
              root.classList.add('modo-fermo', 'modo-statico');
              root.style.setProperty('--vh', '900px');
              root.querySelectorAll('[data-testo]').forEach((el) => { el.textContent = el.getAttribute('data-testo'); });
              if (apertura) {
                  apertura.style.setProperty('--a', '0');
                  apertura.style.setProperty('--z', '0');
                  apertura.style.removeProperty('--sx');
                  apertura.style.removeProperty('--st');
              }
              if (fissoA) {
                  fissoA.style.setProperty('--buco', '0px');
                  fissoA.classList.remove('passa', 'via');
              }
              if (video) {
                  try {
                      video.pause();
                  }
                  catch (e) { }
              }
              if (videoSez)
                  ['--rv', '--cy', '--ao', '--vo', '--vy', '--pbg'].forEach((v) => videoSez.style.removeProperty(v));
              rigaAtt = -2;
              segnaRiga(-1);
              fermoFinale();
          };
          if (fermo) {
              fermoFinale();
              if (doc.fonts && doc.fonts.ready)
                  doc.fonts.ready.then(() => { if (!this._fermo)
                      fermoFinale(); });
              if (!statico)
                  win.requestAnimationFrame(cicloFermo);
          }
          else {
              win.requestAnimationFrame(ciclo);
          }
          this._ridim = (forza) => {
              const w = larghezza(), o = orientamento();
              if (forza !== true && w === wStabile && o === oStabile)
                  return;          // cambia solo l'altezza (la barra del browser): niente da ricalcolare
              wStabile = w;
              oStabile = o;
              hStabile = altezzaVera();
              if (!statico && altezza() > SOGLIA_STATICA) {
                  passaAStatico();
                  return;
              }
              if (!statico)
                  root.style.setProperty('--vh', Math.round(lim(altezza(), 560, SOGLIA_STATICA)) + 'px');
              segnaBasso();
              dimensionaTutto();
              statoSugg();
              if (fermo)
                  fermoFinale();
          };
          win.addEventListener('resize', this._ridim);
          if (doc.fonts && doc.fonts.ready)        // un ricalcolo dopo i caratteri, con le misure vere
              doc.fonts.ready.then(() => { if (this._ridim) this._ridim(true); });
          // M2 (mattino 25/11): l'altezza stabile si rilegge a load, pageshow e ritorno visibile (oltre che ai caratteri pronti e al
          // cambio di larghezza); mai durante lo scorrimento
          const rileggi = () => { if (this._ridim && !doc.hidden) this._ridim(true); };
          if (doc.readyState === 'complete') rileggi(); else win.addEventListener('load', rileggi, { once: true });
          win.addEventListener('pageshow', rileggi);
          doc.addEventListener('visibilitychange', rileggi);
      }
  }

  const c = new Component();
  c.props = { carta: "#F2F1EC", segnale: "#FF7A1A", movimento: true, bagliore: true, cinema: true };
  c.radice = pagina;
  c.componentDidMount();
})();
