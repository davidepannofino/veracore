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
    // 24/11 (design 32, A3): la pagina che ha il suo unico tasto della voce governa questo modulo. sblocca() va chiamata SOLO dentro
    // un gesto vero della persona (clic o Invio sul campo della pagina); zittisci() segue il tasto; ferma() tronca la voce in corso
    // (per esempio prima di un audio preparato: mai due voci insieme)
    sblocca: (radice) => { if (radice && radice.veraVoceComandi) radice.veraVoceComandi.sblocca(); },
    zittisci: (radice, si) => { if (radice && radice.veraVoceComandi) radice.veraVoceComandi.zittisci(si); },
    ferma: (radice) => { if (radice && radice.veraVoceComandi) radice.veraVoceComandi.ferma(); },
    // P2 (25/11): trattieni(radice, true): le frasi in arrivo si mettono in coda senza suonare (il tempo massimo del primo audio conta
    // l'arrivo, non la riproduzione); trattieni(radice, false): parte la coda. La pagina trattiene all'invio e rilascia quando la
    // risposta comincia a essere detta sullo schermo
    trattieni: (radice, si) => { if (radice && radice.veraVoceComandi) radice.veraVoceComandi.trattieni(si); } };

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
    let trattenuto = false;   // P2: la pagina tiene ferma la coda finche' la risposta non comincia a essere detta

    const emetti = (tipo, dati = {}) => radice.dispatchEvent(new CustomEvent("vera-voce", { detail: { tipo, ...dati }, bubbles: true }));
    // N1.7 (notte 25/11): la voce esce da un solo elemento audio, quello della pagina (audio[data-voce-vera], lo stesso della voce
    // preparata) o, se la pagina non lo ha, uno suo; si sblocca nel gesto con un istante di silenzio (iOS)
    const elemento = () => document.querySelector("audio[data-voce-vera]") || ctx || (ctx = new Audio());
    const SILENZIO = (() => { const n = 800, b = new Uint8Array(44 + n * 2), v = new DataView(b.buffer), w = (o, t) => { for (let i = 0; i < t.length; i++) b[o + i] = t.charCodeAt(i); };
      w(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); w(8, "WAVEfmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
      v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, "data"); v.setUint32(40, n * 2, true);
      let x = ""; for (let i = 0; i < b.length; i++) x += String.fromCharCode(b[i]); return "data:audio/wav;base64," + btoa(x); })();

    // ---- il gesto: solo dentro un clic (o l'invio del modulo) si sblocca l'elemento audio
    function sblocca() {
      try {
        const el = elemento();
        if (!el.dataset.sbloccato) {
          el.src = SILENZIO;
          const pr = el.play();
          el.dataset.sbloccato = "1";
          if (pr && pr.then) pr.then(() => { if (el.src === SILENZIO) el.pause(); }, () => { delete el.dataset.sbloccato; });
        }
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
      trattieni: (si) => { trattenuto = Boolean(si); if (!trattenuto && turno) avanti(turno); },
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
      if (t.suona) { try { elemento().pause(); } catch { /* gia' ferma */ } }
      t.suona = false;
      for (const u of t.fonti) { try { URL.revokeObjectURL(u); } catch { /* gia' tolto */ } }
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
      t.timer = setTimeout(() => { if (t.primo_ms === null && !(trattenuto && t.audio.size)) rinuncia(t, "tempo_scaduto"); }, attesaMs);
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
      if (t.finisci) return;   // P3: dopo una frase senza voce non si aggiunge niente
      if (v.stato !== "pronta" || !v.audio_base64) {
        // P3 (25/11): se la voce e' gia' cominciata (o ci sono frasi arrivate), le frasi arrivate prima si dicono fino in fondo, poi la voce
        // si ferma (mai a meta' parola), il testo resta e compare «voce non disponibile: solo testo»
        if (t.primo_ms === null && !t.audio.size) return rinuncia(t, v.motivo || "non_disponibile");
        t.finisci = v.motivo || "non_disponibile";
        t.taglio = Number.isFinite(Number(v.indice)) ? Number(v.indice) : Infinity;
        return avanti(t);
      }
      let url;
      try { url = indirizzo(v); } catch { return rinuncia(t, "audio_non_leggibile"); }
      t.fonti.push(url);
      t.audio.set(v.indice, { url, parole: v.parole || [] });
      if (!t.ordine.includes(v.indice)) t.ordine.push(v.indice);
      t.ordine.sort((a, b) => a - b);
      avanti(t);
    }
    function indirizzo(v) {       // l'audio della frase come file in memoria (wav o mp3, dal formato che dice il servizio)
      const b = Uint8Array.from(atob(v.audio_base64), (c) => c.charCodeAt(0));
      const tipo = String(v.formato || "").startsWith("wav") ? "audio/wav" : "audio/mpeg";
      return URL.createObjectURL(new Blob([b], { type: tipo }));
    }
    function concludi(t) {   // P3: fine delle frasi arrivate prima della frase senza voce
      if (t.giu || t.chiuso) return;
      t.giu = t.finisci;
      statoVoce.textContent = `${SOLO_TESTO[0].toUpperCase()}${SOLO_TESTO.slice(1)}.`;
      st.misure.push({ turno: t.n, primo_audio_ms: t.primo_ms, fallita: t.finisci, dopo_frasi: t.prossimo });
      emetti("voce_non_disponibile", { turno: t.n, motivo: t.finisci, testo: SOLO_TESTO, dopo_frasi: t.prossimo });
      radice.dispatchEvent(new CustomEvent("vera-registro", { detail: { fonte: "voce", testo: SOLO_TESTO, motivo: t.finisci }, bubbles: true }));
      ferma(t, t.finisci);
    }
    function avanti(t) {
      if (t.suona || t.giu || t.chiuso || trattenuto) return;
      const indice = t.ordine[t.prossimo];
      if (t.finisci && (indice === undefined || indice >= t.taglio || !t.audio.has(indice))) return concludi(t);
      if (indice === undefined || !t.audio.has(indice)) return;
      const { url, parole } = t.audio.get(indice);
      const el = elemento();
      t.suona = true;
      el.src = url;
      let k = 0, partita = false;
      const segui = () => {
        if (t.chiuso || !t.suona) return;
        const pos = el.currentTime || 0;
        while (k < parole.length && (parole[k].inizio_s || 0) <= pos) { emetti("voce_parola", { turno: t.n, indice, parola: parole[k].parola, n: k }); k++; }
        if (k < parole.length) requestAnimationFrame(segui);
      };
      const fine = () => {
        el.removeEventListener("ended", fine);
        if (t.chiuso) return;
        t.suona = false;
        t.prossimo++;
        if (t.finisci) avanti(t);
        else if (t.prossimo >= t.ordine.length && !t.giu) ferma(t, "fine");
        else avanti(t);
      };
      el.addEventListener("ended", fine);
      const pr = el.play();
      const parti = () => {
        if (partita || t.chiuso) return;
        partita = true;
        if (t.primo_ms === null) {
          t.primo_ms = performance.now() - t.t_testo;
          clearTimeout(t.timer);
          st.misure.push({ turno: t.n, primo_audio_ms: t.primo_ms, fallita: null });
        }
        emetti("voce_inizio", { turno: t.n, indice, durata_s: Number.isFinite(el.duration) ? el.duration : null });
        requestAnimationFrame(segui);
      };
      if (pr && pr.then) pr.then(parti, () => { el.removeEventListener("ended", fine); t.suona = false; rinuncia(t, "riproduzione_bloccata"); });
      else parti();
    }
  }

  const avviaTutti = () => document.querySelectorAll("section.vera[data-voce]").forEach(avvia);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", avviaTutti);
  else avviaTutti();
})();
