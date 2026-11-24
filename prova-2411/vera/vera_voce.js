// VERA viva: la VOCE DAL VIVO nel widget «Chiedi a VERA». Codice separato da vera.js (che passa solo le righe {"voce"}).
// Interruttore del sito: proposte.voce_dal_vivo (web/sito/sito.yaml), SPENTO. Con l'interruttore acceso il sito carica
// questo file e mette data-voce sulla sezione; il Worker legge con la voce scelta (Cartesia) SOLO le frasi passate dal
// verificatore, nell'ordine, e niente altro (strumenti/vera_viva/worker/src/index.js, «parla»).
//
// Regole:
//   - l'audio parte solo dopo un gesto della persona (il clic su «Chiedi» o su una domanda suggerita, anche da tastiera):
//     solo allora si apre l'AudioContext; un clic simulato da uno script non vale;
//   - c'e' sempre il tasto per zittire la voce; zittita, la risposta resta solo testo;
//   - la risposta scritta non aspetta mai la voce: se l'audio non parte entro 2 secondi dal testo a schermo, oppure il
//     servizio da' errore o il tetto giornaliero della voce e' finito, resta il testo e si scrive «voce non disponibile:
//     solo testo» (anche come evento "vera-registro" per il registro della risposta);
//   - eventi per la sfera e la console, come la conversazione a voce: evento DOM "vera-voce" con tipo voce_inizio,
//     voce_parola, voce_fine, voce_non_disponibile (docs/EVENTI_VERA.md).
// Le misure (tempo dal testo al primo audio, fallimenti) restano nella pagina: window.veraVoceStato, per le prove.
(() => {
  "use strict";
  const ATTESA_AUDIO_MS = 2000;
  const SOLO_TESTO = "voce non disponibile: solo testo";
  // vera.js chiede la voce al Worker solo se serve: dopo un gesto e con la voce non zittita (nessun carattere sprecato)
  window.VeraVoce = { versione: 1, attesa_audio_ms: ATTESA_AUDIO_MS, solo_testo: SOLO_TESTO,
    vuole: (radice) => Boolean(radice.veraVoce && radice.veraVoce.sbloccata && !radice.veraVoce.zittita),
    // 25/11 (design 32, A3): la pagina che ha il suo unico tasto della voce governa questo modulo. sblocca() va chiamata SOLO dentro
    // un gesto vero della persona (clic o Invio sul campo della pagina); zittisci() segue il tasto; ferma() tronca la voce in corso
    // (per esempio prima di un audio preparato: mai due voci insieme)
    sblocca: (radice) => { if (radice && radice.veraVoceComandi) radice.veraVoceComandi.sblocca(); },
    zittisci: (radice, si) => { if (radice && radice.veraVoceComandi) radice.veraVoceComandi.zittisci(si); },
    ferma: (radice) => { if (radice && radice.veraVoceComandi) radice.veraVoceComandi.ferma(); } };

  function avvia(radice) {
    if (!("voce" in radice.dataset) || radice.veraVoce) return;
    const attesaMs = Number(radice.dataset.voceAttesaMs || ATTESA_AUDIO_MS);
    const st = { zittita: false, sbloccata: false, misure: [], turni: 0 };
    radice.veraVoce = st;
    window.veraVoceStato = st;
    let ctx = null;
    let turno = null;
    let domandaN = 0;    // una domanda nuova (riga nuova_domanda da vera.js) chiude il turno di quella prima
    let pendenti = [];   // righe {"voce"} arrivate prima del testo a schermo (si suonano solo dopo)

    const emetti = (tipo, dati = {}) => radice.dispatchEvent(new CustomEvent("vera-voce", { detail: { tipo, ...dati }, bubbles: true }));
    const audioCtx = () => ctx || (ctx = new (window.AudioContext || window.webkitAudioContext)());

    // ---- il gesto: solo dentro un clic (o l'invio del modulo) si apre e si riprende l'audio
    function sblocca() {
      try {
        const c = audioCtx();
        if (c.state === "suspended") c.resume();
        st.sbloccata = true;
      } catch { st.sbloccata = false; }
    }
    radice.addEventListener("click", (e) => {
      if (e.isTrusted && e.target.closest && e.target.closest(".vera-chiedi, .vera-suggerita")) sblocca();   // solo un gesto vero
    }, true);

    // ---- il tasto per zittire, sempre presente, e lo stato della voce (letto dai lettori di schermo)
    const tasto = document.createElement("button");
    tasto.type = "button";
    tasto.className = "vera-zitto";
    tasto.setAttribute("aria-pressed", "false");
    tasto.textContent = "Zittisci la voce";
    const statoVoce = document.createElement("p");
    statoVoce.className = "vera-voce-stato";
    statoVoce.setAttribute("aria-live", "polite");
    const blocco = document.createElement("div");
    blocco.className = "vera-voce";
    blocco.append(tasto, statoVoce);
    radice.veraVoceComandi = {
      sblocca,
      zittisci: (si) => { st.zittita = Boolean(si); tasto.setAttribute("aria-pressed", String(st.zittita)); if (st.zittita && turno) ferma(turno, "zittita"); },
      ferma: () => { if (turno) ferma(turno, "nuova_domanda"); },
    };
    tasto.addEventListener("click", () => {
      st.zittita = !st.zittita;
      tasto.setAttribute("aria-pressed", String(st.zittita));
      tasto.textContent = st.zittita ? "Riattiva la voce" : "Zittisci la voce";
      if (st.zittita && turno) ferma(turno, "zittita");
      statoVoce.textContent = st.zittita ? "Voce zittita: solo testo." : "";
    });
    const colloca = () => {
      if (blocco.isConnected) return;
      const modulo = radice.querySelector(".vera-modulo");
      if (modulo) modulo.after(blocco); else radice.append(blocco);
    };
    if (radice.dataset.pronto === "1") colloca();
    else new MutationObserver((_, o) => { if (radice.dataset.pronto === "1") { colloca(); o.disconnect(); } })
      .observe(radice, { attributes: true, attributeFilter: ["data-pronto"] });

    // ---- un turno: una risposta verificata con la voce in arrivo
    function nuovoTurno() {
      if (turno) ferma(turno, "nuova_domanda");
      st.turni++;
      return { n: st.turni, domanda: domandaN, t_testo: performance.now(), primo_ms: null, giu: null, ordine: [], audio: new Map(), fonti: [],
        prossimo: 0, suona: false, timer: null, chiuso: false };
    }
    function ferma(t, motivo) {
      clearTimeout(t.timer);
      for (const s of t.fonti) { try { s.stop(); } catch { /* gia' ferma */ } }
      t.fonti = [];
      if (!t.chiuso) { t.chiuso = true; if (t.primo_ms !== null) emetti("voce_fine", { turno: t.n, interrotta: motivo !== "fine" }); }
    }
    function rinuncia(t, motivo) {
      if (t.giu || t.chiuso) return;
      t.giu = motivo;
      ferma(t, motivo);
      statoVoce.textContent = `${SOLO_TESTO[0].toUpperCase()}${SOLO_TESTO.slice(1)}.`;
      st.misure.push({ turno: t.n, primo_audio_ms: t.primo_ms, fallita: motivo });
      emetti("voce_non_disponibile", { turno: t.n, motivo, testo: SOLO_TESTO });
      radice.dispatchEvent(new CustomEvent("vera-registro", { detail: { fonte: "voce", testo: SOLO_TESTO, motivo }, bubbles: true }));
    }

    radice.addEventListener("vera-voce-riga", (e) => {
      const x = e.detail || {};
      if (x.nuova_domanda) {   // una domanda nuova (da vera.js): si ferma l'audio della domanda prima
        domandaN++;
        if (turno) ferma(turno, "nuova_domanda");
        turno = null;
        pendenti = [];
        return;
      }
      if (!turno) { pendenti.push(x); return; }
      riga(turno, x);
    });
    radice.addEventListener("vera-mostrata", (e) => {
      const r = e.detail || {};
      if (turno && turno.domanda === domandaN) return;   // la stessa domanda mostrata di nuovo (anteprima, poi finale)
      const vecchie = pendenti;
      pendenti = [];
      if (r.esito !== "verificata") { if (turno) ferma(turno, "nuova_domanda"); turno = null; return; }
      const t = nuovoTurno();
      turno = t;
      t.ordine = r.voce && Array.isArray(r.voce.indici) ? [...r.voce.indici] : [];   // l'ordine delle frasi, dal Worker
      if (st.zittita) { ferma(t, "zittita"); return; }
      if (!st.sbloccata) return rinuncia(t, "senza_gesto");
      if (!r.voce || r.voce.stato !== "in_arrivo") return rinuncia(t, r.voce ? r.voce.stato : "voce_spenta_sul_server");
      statoVoce.textContent = "";
      t.timer = setTimeout(() => { if (t.primo_ms === null) rinuncia(t, "tempo_scaduto"); }, attesaMs);
      for (const x of vecchie) riga(t, x);
    });

    function riga(t, x) {
      if (t.giu || t.chiuso) return;
      if (x.voce_fine) {
        if (x.voce_fine.stato !== "pronta" && t.primo_ms === null) rinuncia(t, x.voce_fine.motivo || "non_disponibile");
        return;
      }
      const v = x.voce;
      if (!v) return;
      if (v.stato !== "pronta" || !v.audio_base64) return rinuncia(t, v.motivo || "non_disponibile");
      decodifica(v).then((buf) => {
        if (t.giu || t.chiuso) return;
        t.audio.set(v.indice, { buf, parole: v.parole || [] });
        if (!t.ordine.includes(v.indice)) t.ordine.push(v.indice);
        t.ordine.sort((a, b) => a - b);
        avanti(t);
      }).catch(() => rinuncia(t, "audio_non_leggibile"));
    }
    function decodifica(v) {
      const b = Uint8Array.from(atob(v.audio_base64), (c) => c.charCodeAt(0));
      return audioCtx().decodeAudioData(b.buffer);
    }
    function avanti(t) {
      if (t.suona || t.giu || t.chiuso) return;
      const indice = t.ordine[t.prossimo];
      if (indice === undefined || !t.audio.has(indice)) return;
      const { buf, parole } = t.audio.get(indice);
      const c = audioCtx();
      const src = c.createBufferSource();
      src.buffer = buf;
      src.connect(c.destination);
      t.fonti.push(src);
      t.suona = true;
      const inizio = c.currentTime;
      src.start(inizio);
      if (t.primo_ms === null) {
        t.primo_ms = performance.now() - t.t_testo;
        clearTimeout(t.timer);
        st.misure.push({ turno: t.n, primo_audio_ms: t.primo_ms, fallita: null });
      }
      emetti("voce_inizio", { turno: t.n, indice, durata_s: buf.duration });
      let k = 0;
      const segui = () => {
        if (t.chiuso || !t.suona) return;
        const pos = c.currentTime - inizio;
        while (k < parole.length && (parole[k].inizio_s || 0) <= pos) { emetti("voce_parola", { turno: t.n, indice, parola: parole[k].parola, n: k }); k++; }
        if (k < parole.length) requestAnimationFrame(segui);
      };
      requestAnimationFrame(segui);
      src.onended = () => {
        t.suona = false;
        t.fonti = t.fonti.filter((s) => s !== src);
        t.prossimo++;
        if (t.prossimo >= t.ordine.length && !t.giu) ferma(t, "fine");
        else avanti(t);
      };
    }
  }

  const avviaTutti = () => document.querySelectorAll("section.vera[data-voce]").forEach(avvia);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", avviaTutti);
  else avviaTutti();
})();
