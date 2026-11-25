// VERA viva: widget «Chiedi a VERA» per il sito. Nessuna libreria, nessuna risorsa esterna.
//
// Uso:
//   <section class="vera" data-api="https://vera-viva.<account>.workers.dev" data-catalogo="catalogo.json?v=951af781"
//            data-repo="https://github.com/<proprietario>/<repository>/blob/main/"></section>
//   <link rel="stylesheet" href="vera.css"> <script src="vera.js" defer></script>
//
// Domande suggerite = risposte preparate (decisione del revisore, 22/11/2026): il bottone mostra la risposta del catalogo
// (file statico, gia' verificato in anticipo: stadi 1, 2 e 3) con la scritta «risposta preparata e verificata in anticipo» e
// le sue fonti, SENZA chiamare il Worker ne' il modello. Solo le domande scritte dal visitatore vanno al Worker. Se il Worker
// non risponde entro 8 secondi, o se e' al limite o al tetto di spesa, il widget offre le domande preparate del catalogo con
// la loro risposta pronta. Il nome dell'assistente viene dal catalogo (config/brand.yaml).
//
// Spento (data-spento sulla sezione, finche' il Worker non esiste): nessuna richiesta di rete oltre al catalogo, una scritta dice che
// le risposte dal vivo non sono attive in questa versione e le domande suggerite mostrano subito la risposta preparata e gia' verificata.
// Memoria della sessione: le ultime 3 domande con la risposta verificata restano SOLO in questa pagina (una variabile,
// mai localStorage, mai cookie) e vanno al Worker con la domanda nuova, come dato; «Dimentica» le cancella.
// Eventi in diretta: il widget chiede lo streaming NDJSON; ogni evento vero (strumento, fonte, stadio 1, stadio 2,
// scettico, esito) diventa un evento DOM "vera-evento" sulla sezione, che la sfera puo' ascoltare.
// «Come ha risposto» (interruttore proposte.registro_vera di web/sito/sito.yaml, attributo data-registro con i testi di
// web/sito/testi.yaml): sotto la risposta, una riga per ogni evento vero ricevuto, con numero, tempo e descrizione. Una risposta
// preparata del catalogo non ha eventi: lo dice. righeRegistro(eventi, parole) e' una funzione pura (VeraRegistro, per le prove).
// «Prova a ingannarmi» (interruttore proposte.prova_a_ingannarmi, attributo data-trappole): bottoni con domande-trappola che vanno
// al Worker come le altre; spento o al limite, mostrano la risposta preparata di rifiuto indicata per ognuna.
// Sveglia: quando la pagina apre il riquadro (diventa visibile, riceve il fuoco o il puntatore, oppure la pagina manda
// l'evento "vera-apri" sulla sezione) il widget fa una chiamata leggera a /api/stato, che sveglia il Worker e i suoi
// contatori prima della prima domanda. Al massimo una sveglia ogni 30 secondi (data-sveglia-ms per cambiarlo).
(() => {
  "use strict";
  const ATTESA_MS = 8000;
  const MAX_CARATTERI = 300;
  const MAX_MEMORIA = 3;
  const ATTESA_SCETTICO_MS = 4000;   // dopo l'anteprima, il tempo dichiarato dello Scettico (con margine)
  const SVEGLIA_OGNI_MS = 30000;     // al massimo una sveglia del Worker ogni 30 secondi
  const PREPARATA = "risposta preparata e verificata in anticipo";   // la scritta di ogni risposta del catalogo (anche le suggerite)

  const el = (tag, attr = {}, ...figli) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attr)) {
      if (k === "testo") n.textContent = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v === true ? "" : v);
    }
    for (const f of figli.flat()) if (f !== null && f !== undefined) n.append(f);
    return n;
  };

  // Le parole delle fasi, una per tipo di evento (docs/VERA_EVENTI.md). I codici del verificatore e i motivi degli esiti NON si
  // scrivono qui: arrivano tradotti in parole.codici e parole.motivi (web/sito/testi.yaml, vera.registro).
  const FASI = { domanda_ricevuta: "riceve la domanda", memoria: "rilegge la memoria della pagina",
    presa_in_carico: "prende in carico la domanda", strumento: "legge i risultati", strumento_rifiutato: "non usa uno strumento",
    fonte: "apre una fonte", frase_proposta: "propone le frasi", stadio1: "controlla i numeri", stadio3: "controlla il metodo",
    stadio2: "controlla le fonti con un secondo modello", verificatore: "decide le frasi", frase_verificata: "dice una frase",
    scettico: "lo Scettico obietta", esito: "ha finito" };
  const PAROLE_REGISTRO = { frase: "frase", passa: "passa", tolta: "tolta", spento: "spento dal vivo", non_eseguito: "non eseguito",
    riga: "riga", ms: "ms" };

  function righeRegistro(eventi, parole = {}) {
    const codici = parole.codici || {}, motivi = parole.motivi || {}, esiti = parole.esiti || {};
    const P = { ...PAROLE_REGISTRO, ...(parole.parole || {}) };
    const codice = (c) => codici[c] || c;
    const regole = (l) => (l && l.length ? ` · ${l.map(codice).join(", ")}` : "");
    const frase = (i) => `${P.frase} ${Number(i) + 1}`;
    const descrivi = (e) => {
      const fase = FASI[e.tipo] || e.tipo;
      switch (e.tipo) {
        case "strumento": return `${fase}: ${e.strumento}${e.ok ? "" : ` · ${codice(e.codice)}`}`;
        case "strumento_rifiutato": return `${fase}: ${e.strumento} · ${codice(e.codice)}`;
        case "fonte": return `${fase}: ${e.file}, ${P.riga} ${e.riga}`;
        case "frase_proposta": return `${fase}: ${frase(e.frase)}`;
        case "stadio1": case "stadio3":
          return `${fase}: ${frase(e.frase)}: ${e.esito === "tolta" ? P.tolta : P.passa}${e.esito === "tolta" ? regole(e.motivi) : ""}`;
        case "stadio2": return e.stato ? `${fase}: ${P[e.stato] || e.stato}` : `${fase}: ${frase(e.frase)}: ${codice(e.esito)}`;
        case "verificatore": return e.esito === "bloccata" ? `${frase(e.frase)}: ${P.tolta}${regole(e.regole)}` : `${frase(e.frase)}: ${P.passa}`;
        case "frase_verificata": return `${fase}: ${frase(e.indice)}`;
        case "scettico": return `${fase}: ${e.fase}`;
        case "esito": return `${fase}: ${esiti[e.esito] || e.esito}${e.motivo ? ` · ${motivi[e.motivo] || e.motivo}` : ""}`;
        default: return fase;
      }
    };
    return (eventi || []).map((e) => ({ n: e.n, t_ms: e.t_ms, tempo: `${e.t_ms} ${P.ms}`, descrizione: descrivi(e) }));
  }
  globalThis.VeraRegistro = { righeRegistro, FASI };   // per le prove: la stessa funzione del widget

  async function conAttesa(url, opz, ms) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try { return await fetch(url, { ...opz, signal: ctrl.signal }); } finally { clearTimeout(t); }
  }

  function avvia(radice) {
    const api = (radice.dataset.api || "").replace(/\/$/, "");
    const repo = radice.dataset.repo || "";
    const attesaMs = Number(radice.dataset.attesaMs || ATTESA_MS);
    const spento = radice.dataset.spento !== undefined;
    const leggiJson = (x) => { try { return x ? JSON.parse(x) : null; } catch { return null; } };
    const registro = leggiJson(radice.dataset.registro);    // null: interruttore spento, nessun riquadro
    const trappole = leggiJson(radice.dataset.trappole);    // null: interruttore spento, nessun bottone
    // PARTE C (sessione 06, spenta): le parole nuove (data-testi), solo con la storia accesa; senza, quelle di sempre
    const testiNuovi = leggiJson(radice.dataset.testi) || {};
    let catalogo = { catalogo: [], nome_assistente: "", marcatura: null };
    const stato = { ultimo: null, eventi: [], memoria: 0, sveglie: 0 };
    let memoria = [];   // SOLO qui, nella pagina
    window.veraStato = stato;   // letto dalle prove

    const titolo = el("h2", { id: "vera-titolo", class: "vera-titolo" });
    const nota = el("p", { class: "vera-nota" });
    const suggerite = el("div", { class: "vera-suggerite", role: "group", "aria-labelledby": "vera-sugg-titolo" });
    const gruppoTrappole = trappole ? el("div", { class: "vera-trappole", role: "group", "aria-label": trappole.titolo }) : null;
    const campo = el("textarea", { id: "vera-domanda", class: "vera-campo", rows: "2", maxlength: String(MAX_CARATTERI),
      "aria-describedby": "vera-conta vera-regole", oninput: () => aggiornaConta() });
    const conta = el("span", { id: "vera-conta", class: "vera-conta", testo: `0/${MAX_CARATTERI}` });
    const bottone = el("button", { type: "submit", class: "vera-chiedi", testo: "Chiedi" });
    const modulo = el("form", { class: "vera-modulo", onsubmit: (e) => { e.preventDefault(); chiedi(campo.value); } },
      el("label", { for: "vera-domanda", class: "vera-etichetta", testo: "La tua domanda" }), campo,
      el("div", { class: "vera-riga" }, conta, bottone));
    const risposta = el("div", { id: "vera-risposta", class: "vera-risposta", "aria-live": "polite", "aria-atomic": "true" });
    const contatore = el("p", { id: "vera-contatore", class: "vera-contatore", "aria-live": "off" });
    const progresso = el("p", { id: "vera-progresso", class: "vera-progresso", "aria-live": "off" });
    const testoMemoria = el("span", { id: "vera-memoria-testo" });
    const dimentica = el("button", { type: "button", class: "vera-dimentica", testo: "Dimentica", disabled: true,
      onclick: () => { memoria = []; aggiornaMemoria(true); } });
    const rigaMemoria = el("p", { id: "vera-memoria", class: "vera-memoria" }, testoMemoria, " ", dimentica);
    const avviso = el("div", { id: "vera-avviso", class: "vera-avviso", role: "status", hidden: true });
    const chiE = el("button", { type: "button", class: "vera-chi", "aria-haspopup": "dialog", "aria-controls": "vera-passaporto",
      onclick: () => apriPassaporto() });
    const scheda = el("dialog", { id: "vera-passaporto", class: "vera-scheda", "aria-labelledby": "vera-pass-titolo",
      onclose: () => chiE.focus() });
    radice.setAttribute("aria-labelledby", "vera-titolo");
    const presto = el("p", { class: "vera-presto", role: "note" });
    radice.append(titolo, nota, ...(spento ? [presto] : []), chiE, avviso, scheda,
      el("h3", { id: "vera-sugg-titolo", class: "vera-sotto", testo: spento ? "Domande preparate, con la risposta già verificata" : "Domande suggerite" }), suggerite,
      ...(gruppoTrappole ? [gruppoTrappole] : []),   // append(null) scriverebbe «null» a schermo (B5, sessione 06)
      ...(spento ? [] : [modulo]), el("p", { id: "vera-regole", class: "vera-regole",
        testo: "Risponde in al massimo tre frasi, solo con prove verificate del progetto, con la fonte di ogni frase. Nessun consiglio clinico. Le domande non vengono salvate: si contano soltanto." }),
      ...(spento ? [] : [rigaMemoria, progresso]), risposta, ...(spento ? [] : [contatore]));   // spento: niente memoria ne' progresso dal vivo

    function aggiornaMemoria(annuncia = false) {
      stato.memoria = memoria.length;
      testoMemoria.textContent = memoria.length
        ? `Ricordo le ultime ${memoria.length} domande, solo in questa pagina: servono a capire la prossima, mai come prova.`
        : "Nessuna domanda ricordata.";
      dimentica.disabled = !memoria.length;
      if (annuncia) progresso.textContent = "Memoria cancellata.";
    }
    aggiornaMemoria();

    function aggiornaConta() { conta.textContent = `${[...campo.value].length}/${MAX_CARATTERI}`; }

    function badge(testo, classe) { return el("span", { class: `vera-badge ${classe}`, testo }); }

    // B8 (sessione 06): la riga del tipo di fonte, in parole normali. Per le risposte preparate la scrive il generatore del catalogo
    // (strumenti/vera_viva/prepara_fatti.py, da strumenti.tipi_fonte); per quelle dal vivo si compone qui con la stessa tabella
    // (catalogo.tipi_fonte, da config/tipi_fonte.yaml). Un percorso che la tabella non conosce: nessuna riga, mai un tipo indovinato.
    function globRegex(g) {
      let s = "";
      for (let i = 0; i < g.length; i++) {
        if (g.startsWith("**", i)) { s += ".*"; i++; } else if (g[i] === "*") s += "[^/]*"; else if (g[i] === "?") s += "[^/]";
        else s += g[i].replace(/[.+^${}()|[\]\\]/g, "\\$&");
      }
      return new RegExp(`^${s}$`);
    }
    function rigaDaPercorsi(percorsi) {
      const tf = catalogo.tipi_fonte;
      if (!tf || !percorsi.length) return "";
      const chiavi = [];
      for (const p of percorsi) {
        const r = tf.regole.find((x) => globRegex(x.percorso).test(p));
        if (!r) return "";
        if (!chiavi.includes(r.tipo)) chiavi.push(r.tipo);
      }
      const altre = chiavi.filter((k) => !tf.solo_se_unico.includes(k));
      return [...(altre.length ? altre : chiavi).slice(0, tf.massimo_tipi).map((k) => tf.tipi[k]), tf.accanto].join(tf.separatore);
    }
    globalThis.VeraTipiFonte = { rigaDaPercorsi: (p, tf) => { const prima = catalogo; catalogo = { tipi_fonte: tf }; try { return rigaDaPercorsi(p); } finally { catalogo = prima; } } };

    let marcaturaRisposta = null;
    function blocchiFonti(frasi, prefisso = "vera-fonte", rigaFonti = "") {
      const fonti = [], indice = new Map();
      for (const f of frasi) for (const s of f.fonti) if (!indice.has(s.id)) { indice.set(s.id, fonti.length + 1); fonti.push(s); }
      const paragrafi = frasi.map((f) => el("p", { class: "vera-frase" }, f.testo, " ",
        ...f.fonti.map((s) => el("a", { href: `#${prefisso}-${s.id}`, class: "vera-rif", onclick: apriDettagli,
          "aria-label": `fonte ${indice.get(s.id)}`, testo: `[${indice.get(s.id)}]` }))));
      const lista = el("ol", { class: "vera-fonti", "aria-label": "Fonti" }, fonti.map((s) => el("li", { id: `${prefisso}-${s.id}` },
        el("span", { class: "vera-id", testo: s.id }), " · ",
        // sessione 06: senza data-repo (codice non pubblico) la fonte e' testo, mai un collegamento a un file
        repo ? el("a", { href: `${repo}${s.file}#L${s.riga}`, target: "_blank", rel: "noopener", testo: `${s.file}, riga ${s.riga}` })
          : el("span", { class: "vera-file", testo: `${s.file}, riga ${s.riga}` }), " · ",
        el("span", { class: "vera-impronta", title: `SHA256 ${s.impronta}`, testo: `impronta ${s.impronta.slice(0, 12)}…` }),
        s.marcatura && !marcaturaRisposta ? [" · ", badge(s.marcatura, "vera-sintetico")] : null)));
      // la riga corta sotto la risposta; percorsi, righe e impronte solo dentro «dettagli», chiuso in partenza
      const tipi = rigaFonti || rigaDaPercorsi(fonti.map((s) => s.file));
      return [el("div", { class: "vera-frasi" }, paragrafi), ...(tipi ? [el("p", { class: "vera-tipi-fonte", testo: tipi })] : []),
        el("details", { class: "vera-dettagli-fonti" }, el("summary", { class: "vera-sotto", testo: "Fonti: file, righe e impronte" }), lista)];
    }
    function apriDettagli() { const d = risposta.querySelector(".vera-dettagli-fonti"); if (d) d.open = true; }

    function mostra(domanda, r) {
      stato.ultimo = { ...r, domanda, numero: (stato.ultimo?.numero || 0) + 1 };
      risposta.replaceChildren();
      risposta.removeAttribute("aria-busy");
      const testa = el("div", { class: "vera-testa" }, el("p", { class: "vera-q", testo: domanda }));
      if (r.esito === "verificata") testa.append(badge("verificata", "vera-ok"));
      else if (r.esito === "preparata") testa.append(badge(PREPARATA, "vera-ok"));
      else if (r.ripiego) testa.append(badge("senza risposta dal vivo", "vera-no"));
      else testa.append(badge("rifiutata", "vera-no"));
      if (r.marcatura) testa.append(badge(r.marcatura, "vera-sintetico"));
      marcaturaRisposta = r.marcatura || null;
      risposta.append(testa);
      if (r.esito === "verificata" || r.esito === "preparata") risposta.append(...blocchiFonti(r.frasi, "vera-fonte", r.riga_fonti));
      else risposta.append(el("p", { class: "vera-rifiuto", testo: (!r.ripiego && testiNuovi.rifiuto) || r.testo_rifiuto }));
      if (r.tolte_stadio2 && r.tolte_stadio2.length) {   // lo stadio 2 ha tolto delle frasi: lo si dice
        const motivi = { non_sostenuta: "non sostenuta dalle fonti", incerta: "incerta", tempo_scaduto: "controllo non finito in tempo",
          errore: "controllo non riuscito" };
        risposta.append(el("p", { class: "vera-nota-stadio2", testo: `Frasi tolte dal controllo delle fonti: ${r.tolte_stadio2.length} (` +
          [...new Set(r.tolte_stadio2.map((x) => motivi[x.motivo] || x.motivo))].join(", ") + ")." }));
      }
      if (r.esito === "verificata" && r.obiezione) risposta.append(bloccoScettico(r.obiezione));
      else if (r.esito === "verificata" && r.in_attesa_scettico) risposta.append(el("p", { class: "vera-attesa", testo: "Lo Scettico cerca l'obiezione più forte…" }));
      if (r.ripiego) risposta.append(ripiego());
      if (registro) risposta.append(bloccoRegistro(r));
      aggiornaContatore();
      // per vera_voce.js; per la pagina del design 32 (web/sito/v32) anche la risposta come mostrata qui: domanda, frasi con le fonti, esito
      radice.dispatchEvent(new CustomEvent("vera-mostrata", { detail: { esito: r.esito, voce: r.voce || null, domanda, frasi: r.frasi || [],
        marcatura: r.marcatura || null, riga_fonti: r.riga_fonti || "", testo_rifiuto: r.testo_rifiuto || "", ripiego: Boolean(r.ripiego),
        motivo: r.motivo || null } }));
    }

    // ---- voce dal vivo (codice in vera_voce.js): qui solo il passaggio delle righe {"voce"} della diretta, che arrivano
    // anche DOPO la risposta scritta; la risposta non le aspetta mai. Con data-voce e vera_voce.js caricato si chiede la voce.
    function voceDalVivo() { return "voce" in radice.dataset && Boolean(window.VeraVoce && window.VeraVoce.vuole(radice)); }
    function inoltraVoce(x) { radice.dispatchEvent(new CustomEvent("vera-voce-riga", { detail: x })); }
    async function seguiVoce(lettore, dec, resto) {
      try {
        for (;;) {
          let i;
          while ((i = resto.indexOf("\n")) >= 0) {
            const riga = resto.slice(0, i).trim();
            resto = resto.slice(i + 1);
            if (!riga) continue;
            const x = JSON.parse(riga);
            if (x.voce || x.voce_fine) inoltraVoce(x);
          }
          const { done, value } = await lettore.read();
          if (done) break;
          resto += dec.decode(value, { stream: true });
        }
      } catch { inoltraVoce({ voce_fine: { stato: "non_disponibile", motivo: "rete" } }); }
    }

    // «Come ha risposto»: solo gli eventi veri di questa domanda; una risposta preparata non ne ha
    function bloccoRegistro(r) {
      const eventi = stato.eventi.length ? stato.eventi : (r.eventi || []);     // in diretta, oppure tutti insieme nella risposta
      const righe = r.esito === "preparata" ? [] : righeRegistro(eventi, registro);
      return el("details", { class: "vera-registro" }, el("summary", { testo: registro.titolo }),
        righe.length
          ? el("ol", { class: "vera-registro-righe" }, righe.map((x) => el("li", { "data-n": String(x.n) },
            el("span", { class: "vera-mono", testo: `${x.n}` }), " · ", el("span", { class: "vera-mono", testo: x.tempo }), " · ", x.descrizione)))
          : el("p", { class: "vera-registro-preparata", testo: r.esito === "preparata" ? registro.preparata : registro.nessun_evento }));
    }

    // lo Scettico: l'obiezione (da un elenco chiuso) e la risposta solo con fatti verificati, oppure «non dimostrato»
    function bloccoScettico(o) {
      const b = el("section", { class: "vera-scettico", "aria-label": "Lo Scettico" },
        el("h4", { class: "vera-sotto", testo: "Lo Scettico obietta" }), el("p", { class: "vera-obiezione", testo: o.obiezione }));
      if (o.risposta.tipo === "fatti") b.append(...blocchiFonti(o.risposta.frasi, "vera-fonte-scettico"));
      else b.append(el("p", { class: "vera-non-dimostrato", testo: o.risposta.testo }));
      return b;
    }

    function eventoVero(e) {
      stato.eventi.push(e);
      radice.dispatchEvent(new CustomEvent("vera-evento", { detail: e }));   // per la sfera: solo eventi veri
      progresso.textContent = `${catalogo.nome_assistente} ${FASI[e.tipo] || e.tipo}…`;
    }

    // la domanda in diretta (NDJSON). Restituisce la risposta finale, oppure l'anteprima se lo Scettico non finisce in tempo.
    async function inDiretta(corpo) {
      inoltraVoce({ nuova_domanda: true });   // per vera_voce.js: l'audio della domanda prima si ferma
      const ctrl = new AbortController();
      let timer = setTimeout(() => ctrl.abort(), attesaMs);
      let anteprima = null;
      try {
        const res = await fetch(`${api}/api/domanda`, { method: "POST", signal: ctrl.signal,
          headers: { "Content-Type": "application/json", "Accept": "application/x-ndjson" },
          body: JSON.stringify(voceDalVivo() ? { ...corpo, voce: true } : corpo) });
        if (!(res.headers.get("Content-Type") || "").includes("ndjson") || !res.body) { clearTimeout(timer); return await res.json(); }
        const lettore = res.body.getReader();
        const dec = new TextDecoder();
        let resto = "";
        for (;;) {
          const { done, value } = await lettore.read();
          resto += dec.decode(value || new Uint8Array(), { stream: !done });
          let i;
          while ((i = resto.indexOf("\n")) >= 0) {
            const riga = resto.slice(0, i).trim();
            resto = resto.slice(i + 1);
            if (!riga) continue;
            const x = JSON.parse(riga);
            if (x.evento) eventoVero(x.evento);
            else if (x.voce || x.voce_fine) inoltraVoce(x);
            else if (x.anteprima) {
              anteprima = x.anteprima;
              clearTimeout(timer);
              timer = setTimeout(() => ctrl.abort(), ATTESA_SCETTICO_MS);
              mostra(corpo.domanda, { ...anteprima, in_attesa_scettico: true });
            } else if (x.risposta) { seguiVoce(lettore, dec, resto); return x.risposta; }
          }
          if (done) break;
        }
        if (anteprima) return anteprima;
        throw new Error("risposta incompleta");
      } catch (e) {
        if (anteprima) return anteprima;   // lo Scettico non ha finito in tempo: resta la risposta verificata
        throw e;
      } finally { clearTimeout(timer); }
    }

    function ripiego(livello = "h4") {
      const voci = catalogo.catalogo.map((c) => el("li", {}, el("button", { type: "button", class: "vera-preparata",
        onclick: () => mostra(c.domanda, { esito: "preparata", marcatura: c.marcatura,
          riga_fonti: c.riga_fonti, frasi: [{ testo: c.risposta, fonti: c.fonti }] }), testo: c.domanda })));
      return el("div", { class: "vera-ripiego" },
        el(livello, { class: "vera-sotto", testo: "Domande preparate, con la risposta già verificata" }),
        el("ul", { class: "vera-lista" }, voci));
    }

    // la risposta preparata di rifiuto di una trappola: quella del catalogo, con la sua domanda
    function rifiutoPreparato(id) {
      const c = catalogo.catalogo.find((x) => x.id === id);
      if (c) mostra(c.domanda, { esito: "preparata", marcatura: c.marcatura, riga_fonti: c.riga_fonti, frasi: [{ testo: c.risposta, fonti: c.fonti }] });
      return Boolean(c);
    }

    async function chiedi(testo, opzioni = {}) {
      const domanda = String(testo || "").trim();
      if (!domanda) { campo.focus(); return; }
      risposta.setAttribute("aria-busy", "true");
      risposta.replaceChildren(el("p", { class: "vera-attesa", testo: `${catalogo.nome_assistente} cerca le prove…` }));
      bottone.disabled = true;
      stato.eventi = [];
      let r;
      try {
        r = await inDiretta(memoria.length ? { domanda, memoria } : { domanda });
        if (r.esito === "limite" || r.esito === "errore") r.ripiego = true;
        if (r.esito === "verificata") {   // in memoria solo le risposte verificate dal vivo
          memoria = [...memoria, { domanda, risposta: r.frasi.map((f) => f.testo) }].slice(-MAX_MEMORIA);
          aggiornaMemoria();
        }
      } catch (e) {
        r = { esito: "rifiutata", ripiego: true, marcatura: catalogo.marcatura,
          testo_rifiuto: `${catalogo.nome_assistente} non risponde in tempo: ecco le domande preparate, con la risposta già verificata.` };
      } finally { bottone.disabled = false; }
      if (opzioni.rifiuto && r.ripiego && rifiutoPreparato(opzioni.rifiuto)) return;   // trappola al limite: il rifiuto preparato
      mostra(domanda, r);
    }

    async function aggiornaContatore() {
      if (spento) return;
      try {
        const s = await (await conAttesa(`${api}/api/stato`, {}, attesaMs)).json();
        contatore.textContent = `Oggi: domande ${s.domande} · verificate ${s.risposte} · rifiutate ${s.rifiuti}`;
        // budget finito (giorno o mese): lo dice in chiaro e offre subito le risposte preparate
        avviso.hidden = !s.tetto_raggiunto;
        if (s.tetto_raggiunto) avviso.replaceChildren(el("p", { testo: testiNuovi.tetto || s.testo_tetto }), ripiego("h3"));
      } catch { contatore.textContent = ""; }
    }

    // ---- sveglia: una chiamata leggera a /api/stato quando il riquadro si apre (aggiorna anche il contatore)
    const svegliaOgniMs = Number(radice.dataset.svegliaMs || SVEGLIA_OGNI_MS);
    let ultimaSveglia = -Infinity;
    function sveglia() {
      const ora = Date.now();
      if (ora - ultimaSveglia < svegliaOgniMs) return;
      ultimaSveglia = ora;
      stato.sveglie++;
      aggiornaContatore();
    }
    function preparaSveglia() {
      if ("IntersectionObserver" in window) {
        new IntersectionObserver((voci) => { if (voci.some((v) => v.isIntersecting)) sveglia(); }).observe(radice);
      } else sveglia();
      for (const tipo of ["focusin", "pointerenter", "vera-apri"]) radice.addEventListener(tipo, sveglia);
    }

    // ---- passaporto: chi e' l'assistente. Ogni valore viene dal Worker (configurazione) o dal catalogo, mai a mano.
    async function apriPassaporto() {
      let p = null;
      if (!spento) { try { p = await (await conAttesa(`${api}/api/passaporto`, {}, attesaMs)).json(); } catch { p = null; } }
      const nome = catalogo.nome_assistente;
      const mono = (t) => el("span", { class: "vera-mono", testo: String(t) });
      const voce = (titolo, ...contenuto) => el("section", { class: "vera-pass-voce" }, el("h3", { class: "vera-sotto", testo: titolo }), ...contenuto);
      const impronta = p ? p.fatti.impronta : catalogo.impronta_fatti;
      const marcatura = p ? p.fatti.marcatura : catalogo.marcatura;
      const modello = p
        ? el("p", {}, "Modello ", mono(p.modello), " del fornitore ", mono(p.fornitore), ", con sforzo ", mono(p.sforzo),
          ". Sono le impostazioni del server in questo momento.")
        : el("p", { testo: spento ? "Le risposte dal vivo non sono ancora attive: modello e fornitore compariranno qui. Intanto ci sono le risposte preparate."
          : "Il server non risponde ora: modello e fornitore non si possono leggere. Restano disponibili le risposte preparate." });
      const lim = p && p.limiti;
      scheda.replaceChildren(
        el("div", { class: "vera-pass-testa" },
          el("h2", { id: "vera-pass-titolo", class: "vera-titolo", testo: testiNuovi.chi_titolo || `Chi è ${nome}?` }),
          el("button", { type: "button", class: "vera-chiudi", onclick: () => scheda.close(), testo: "Chiudi" })),
        ...(testiNuovi.chi_e ? [el("p", { class: "vera-chi-e", testo: testiNuovi.chi_e })] : []),
        voce("Modello e fornitore", modello),
        voce("Che cosa fa", el("p", { testo: `${nome} risponde alle domande sul progetto solo con i fatti verificati, ` +
          "e per ogni frase mostra le fonti: il file, la riga e l'impronta." })),
        voce("Da dove prende i dati",
          el("p", {}, "Dal file ", mono("fatti_verificati.json"),
            p ? [", con ", mono(p.fatti.n_fatti), " fatti presi dai risultati e dalle evidenze con il loro .meta.json, e ",
              mono(p.fatti.n_domande_preparate), " domande preparate."] : ", generato dai risultati e dalle evidenze con il loro .meta.json."),
          el("p", {}, "Impronta SHA256 del file: ", el("span", { class: "vera-mono vera-impronta-intera", testo: impronta || "non disponibile" })),
          marcatura ? el("p", {}, badge(`dati ${marcatura}`, "vera-sintetico"), " i risultati sono di prova, non dati veri.") : null),
        voce("Memoria della pagina", el("p", { testo: p && p.memoria ? `Ricorda al massimo ${p.memoria.max_voci} domande con la risposta ` +
          `verificata, ${p.memoria.dove}. Le usa ${p.memoria.uso}.` : "Ricorda le ultime domande solo in questa pagina; «Dimentica» le cancella." })),
        p && p.scettico && p.scettico.stato === "attivo" ? voce("Lo Scettico", el("p", {}, "Modello ", mono(p.scettico.modello), ": ",
          p.scettico.compito, ". Non può: ", p.scettico.non_puo.join(", "), ".")) : null,
        voce("Che cosa NON può fare", el("ul", { class: "vera-pass-lista" },
          el("li", { testo: "Dare consigli clinici o indicare farmaci e terapie per una persona." }),
          el("li", { testo: "Fare nuove analisi o nuovi calcoli: usa solo i risultati già calcolati e verificati." }),
          el("li", { testo: "Rispondere senza prove: una frase senza fonte viene tolta." }))),
        voce("Il verificatore deterministico", el("p", { testo: "Prima di arrivare qui ogni frase passa un controllo automatico, " +
          "le stesse regole del palco: ogni numero deve comparire nel fatto citato, ogni frase deve citare un fatto esistente, " +
          "nessuna affermazione vietata; poi le regole di metodo: una previsione con il confronto con le baseline e lo split per " +
          "paziente, una stima con il suo intervallo, un risultato sintetico detto tale. Una frase che non passa si toglie; se non " +
          "resta niente, la risposta è un rifiuto." })),
        voce("Limiti e budget", lim
          ? el("ul", { class: "vera-pass-lista" },
            el("li", {}, "Per ogni visitatore: al massimo ", mono(lim.per_visitatore_minuto), " domande al minuto."),
            el("li", {}, "Per tutto il sito: ", mono(lim.per_minuto), " domande al minuto e ", mono(lim.per_giorno), " al giorno."),
            el("li", {}, "Budget: ", mono(lim.tetto_usd), " USD al giorno e ", mono(lim.tetto_mese_usd),
              " USD al mese; quando finisce, restano le risposte preparate."))
          : el("p", { testo: spento ? "Si leggeranno qui quando le risposte dal vivo saranno attive." : "Non leggibili ora: il server non risponde." })),
        voce("Nessun dato personale", el("p", { testo: "Le domande non vengono salvate: si contano soltanto. Il limite per visitatore " +
          "usa l'impronta dell'indirizzo di rete solo per contare, nel servizio di Cloudflare; il progetto non la salva." })));
      scheda.showModal();
      scheda.querySelector(".vera-chiudi").focus();
    }

    (async () => {
      try { catalogo = await (await fetch(radice.dataset.catalogo || "catalogo.json?v=951af781")).json(); } catch { /* resta vuoto */ }
      const nome = catalogo.nome_assistente || "";
      titolo.textContent = testiNuovi.titolo || `Chiedi a ${nome}`;
      chiE.textContent = testiNuovi.chi_titolo || `Chi è ${nome}?`;
      if (testiNuovi.nota) nota.replaceChildren(testiNuovi.nota, ...(catalogo.marcatura ? [" ", badge(`dati ${catalogo.marcatura}`, "vera-sintetico")] : []));
      else nota.replaceChildren(`${nome} risponde alle domande sul progetto solo con le prove: ogni frase ha la sua fonte, `,
        "con il file, la riga e l'impronta.", ...(catalogo.marcatura ? [" ", badge(`dati ${catalogo.marcatura}`, "vera-sintetico")] : []));
      if (spento) presto.textContent = `Le risposte dal vivo di ${nome} non sono attive in questa versione. Intanto ecco le domande preparate: ogni risposta è già verificata, con le sue fonti.`;
      const ids = (radice.dataset.suggerite || "").split(",").map((s) => s.trim()).filter(Boolean);
      const scelte = ids.length ? catalogo.catalogo.filter((c) => ids.includes(c.id)) : catalogo.catalogo.slice(0, 5);
      const preparata = (c) => mostra(c.domanda, { esito: "preparata", marcatura: c.marcatura, riga_fonti: c.riga_fonti, frasi: [{ testo: c.risposta, fonti: c.fonti }] });
      suggerite.replaceChildren(...scelte.map((c) => el("button", { type: "button", class: "vera-suggerita",
        onclick: () => preparata(c), testo: c.domanda })));   // sempre la risposta preparata: nessuna richiesta al Worker
      if (gruppoTrappole) {   // «Prova a ingannarmi»: solo le trappole con il loro rifiuto preparato nel catalogo
        gruppoTrappole.replaceChildren(el("span", { class: "vera-sotto", testo: trappole.titolo }),
          ...(trappole.riga ? [el("p", { class: "vera-trappole-riga", testo: trappole.riga })] : []),
          ...(trappole.domande || []).filter((d) => catalogo.catalogo.some((c) => c.id === d.rifiuto)).map((d) => el("button", {
            type: "button", class: "vera-trappola", testo: d.etichetta || d.testo,
            onclick: () => { if (spento) { rifiutoPreparato(d.rifiuto); return; } campo.value = d.testo; aggiornaConta(); chiedi(d.testo, { rifiuto: d.rifiuto }); } })));
      }
      radice.querySelectorAll(".vera-caricamento").forEach((x) => x.remove());   // «Sto aprendo le prove…» (PARTE C), se c'era
      radice.dataset.pronto = "1";
      preparaSveglia();   // il contatore si legge quando il riquadro si apre, e intanto il Worker si sveglia
    })();
  }

  const avviaTutti = () => document.querySelectorAll("section.vera").forEach(avvia);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", avviaTutti);
  else avviaTutti();
})();
