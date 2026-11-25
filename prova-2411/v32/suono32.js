// Suono dell'ambiente nelle pagine interne (M3, mattino 25/11): lo stesso motore della home (creaSuono, da design32.js),
// lo stesso tasto e la stessa preferenza. Generato da strumenti/sito_design32.py.
(() => {
  'use strict';
  const win = window, doc = document;
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

  let actx = null;
  const prendi = () => {
      if (actx) return actx;
      try { if (win.navigator.audioSession) win.navigator.audioSession.type = 'playback'; } catch (e) { }
      try { const AC = win.AudioContext || win.webkitAudioContext; if (AC) actx = new AC(); } catch (e) { actx = null; }
      return actx;
  };
  const suono = creaSuono(prendi);
  win.__suono32 = { suono, get ctx() { return actx; } };
  const PREF = 'ncb.suono.v1';
  const pref = { on: true, vol: 0.6 };
  try { Object.assign(pref, JSON.parse(win.localStorage.getItem(PREF) || 'null') || {}); } catch (e) { }
  const salva = () => { try { win.localStorage.setItem(PREF, JSON.stringify(pref)); } catch (e) { } };
  const avvia = () => {
      const tasto = doc.querySelector('[data-suono-tasto]'), vol = doc.querySelector('[data-suono-vol]');
      const guscio = doc.querySelector('.nav-suono-guscio'), barra = doc.querySelector('.pagina-barra');
      const mostra = (on) => { if (tasto) tasto.setAttribute('aria-pressed', on ? 'true' : 'false'); if (barra) barra.classList.toggle('suono-on', on); };
      const riprendi = () => { try { if (actx && actx.state !== 'running' && actx.state !== 'closed') actx.resume(); } catch (e) { } };
      suono.volume(Math.max(0, Math.min(1, Number(pref.vol) || 0)));
      if (vol) vol.value = String(Math.round(Math.max(0, Math.min(1, Number(pref.vol) || 0)) * 100));
      mostra(!!pref.on);
      if (pref.on) suono.accendi();
      const gesto = () => { if (!pref.on) return; if (!suono.acceso) suono.accendi(); riprendi(); };
      ['pointerdown', 'touchend', 'click', 'keydown'].forEach((ev) => doc.addEventListener(ev, gesto, { capture: true, passive: true }));
      doc.addEventListener('click', (e) => {
          const t = e.target;
          if (!t || !t.closest) return;
          if (t.closest('[data-suono-tasto]')) {
              pref.on = !pref.on; salva();
              if (pref.on) { suono.accendi(); riprendi(); } else suono.spegni();
              mostra(pref.on);
              if (guscio) guscio.classList.toggle('mostra', pref.on);
              return;
          }
          if (t.closest('button, a, summary')) suono.evento('clic');
      });
      if (vol) vol.addEventListener('input', () => { pref.vol = Number(vol.value) / 100; suono.volume(pref.vol); salva(); });
      doc.addEventListener('visibilitychange', () => suono.nascosto(doc.hidden));
  };
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', avvia, { once: true }); else avvia();
})();
