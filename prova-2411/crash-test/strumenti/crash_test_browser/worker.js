// Crash test nel browser: il calcolo gira qui, in un Web Worker, cosi' la pagina resta reattiva.
// Carica SOLO byte verificati: Pyodide e le ruote con il manifesto di strumenti/browser_pyodide (stesse versioni, stesse
// impronte, SRI nella richiesta), il codice del progetto con impronte_codice.json. Dopo "pronto" questo worker non fa
// piu' nessuna richiesta di rete: fetch e' sostituita e rifiuta tutto cio' che non e' gia' in memoria.
"use strict";
const PACCHETTI = ["numpy", "pandas", "scipy", "pyyaml"];
const RUOTE = ["ruote/et_xmlfile-2.0.0-py3-none-any.whl", "ruote/openpyxl-3.1.5-py2.py3-none-any.whl"];
const REPO = "/home/pyodide/repo/";
const LAVORO = "/home/pyodide/lavoro/";
let PYODIDE_DIR, RADICE, pyodide, avvio, ESEMPIO;
let pronto = false;
const fetchOriginale = self.fetch.bind(self);
const esadecimale = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const base64 = (hex) => btoa(String.fromCharCode(...hex.match(/../g).map((h) => parseInt(h, 16))));
const invia = (tipo, dati, trasferisci) => self.postMessage({ tipo, ...dati }, trasferisci || []);

async function verificato(url, atteso, etichetta) {
  if (pronto) throw new Error(`nessuna richiesta di rete dopo il caricamento: ${etichetta}`);
  if (new URL(url).origin !== self.location.origin) throw new Error(`richiesta a un sito esterno bloccata: ${url}`);
  if (!atteso) throw new Error(`file non elencato nel manifesto, rifiutato: ${etichetta}`);
  let r;
  try { r = await fetchOriginale(url, { integrity: "sha256-" + base64(atteso) }); }
  catch (e) { throw new Error(`impronta diversa da quella del manifesto (SRI), rifiutato: ${etichetta}`); }
  if (!r.ok) throw new Error(`${etichetta}: HTTP ${r.status}`);
  const buf = await r.arrayBuffer();
  if (esadecimale(await crypto.subtle.digest("SHA-256", buf)) !== atteso) throw new Error(`impronta diversa, rifiutato: ${etichetta}`);
  return buf;
}

// Pyodide fa da solo le sue richieste (wasm, libreria standard, pacchetti): ricevono solo byte gia' verificati
const verificati = new Map();
self.fetch = async (input) => {
  const url = new URL(input instanceof Request ? input.url : String(input), PYODIDE_DIR).href;
  if (!verificati.has(url)) throw new Error(`richiesta non verificata, rifiutata: ${url}`);
  const tipo = url.endsWith(".wasm") ? "application/wasm" : "application/octet-stream";
  return new Response(verificati.get(url).slice(0), { status: 200, headers: { "Content-Type": tipo } });
};
const blocco = (rel, tipo) => URL.createObjectURL(new Blob([verificati.get(PYODIDE_DIR + rel)], { type: tipo }));

async function prepara(m) {
  const t0 = performance.now();
  const voci = Object.entries(m.manifesto_pyodide.file).filter(([rel]) => rel.startsWith("pyodide/") || rel.startsWith("ruote/"));
  const codice = Object.entries(m.manifesto_codice.file);
  const totale = voci.length + codice.length;
  let fatti = 0;
  for (const [rel, v] of voci) {
    verificati.set(PYODIDE_DIR + rel, await verificato(PYODIDE_DIR + rel, v.sha256, rel));
    invia("avanzamento", { fatti: ++fatti, totale, testo: `Verifica dei file: ${fatti} di ${totale}` });
  }
  const file_codice = new Map();
  for (const [percorso, v] of codice) {
    file_codice.set(percorso, await verificato(RADICE + percorso, v.sha256, percorso));
    invia("avanzamento", { fatti: ++fatti, totale, testo: `Verifica dei file: ${fatti} di ${totale}` });
  }
  importScripts(blocco("pyodide/pyodide.js", "text/javascript"));
  const asm = await import(blocco("pyodide/pyodide.asm.mjs", "text/javascript"));
  const lock = new TextDecoder().decode(verificati.get(PYODIDE_DIR + "pyodide/pyodide-lock.json"));
  invia("avanzamento", { fatti, totale, testo: "Avvio di Python nel browser…" });
  pyodide = await loadPyodide({ indexURL: PYODIDE_DIR + "pyodide/", createPyodideModule: asm.default, lockFileContents: lock,
    packageBaseUrl: PYODIDE_DIR + "pyodide/", checkAPIVersion: true });
  const errori = [];
  await pyodide.loadPackage([...PACCHETTI, ...RUOTE.map((r) => PYODIDE_DIR + r)], { messageCallback: () => {}, errorCallback: (x) => errori.push(x) });
  if (errori.length) throw new Error("pacchetti non caricati: " + errori.join(" | ").slice(0, 300));
  for (const [percorso, buf] of file_codice) {
    pyodide.FS.mkdirTree(REPO + percorso.split("/").slice(0, -1).join("/"));
    pyodide.FS.writeFile(REPO + percorso, new Uint8Array(buf));
  }
  ESEMPIO = file_codice.get(m.esempio);
  pyodide.runPython(`import sys; sys.path.insert(0, "${REPO}strumenti/crash_test_browser")`);
  avvio = pyodide.pyimport("avvio_crash");
  avvio.installa(m.impronta_codice);
  pronto = true;   // da qui in poi nessuna richiesta di rete: verificato() e fetch rifiutano
  return { secondi: (performance.now() - t0) / 1000, versione: pyodide.version };
}

function calcola(nome, dati) {
  const sicuro = avvio.prepara_file(nome);
  pyodide.FS.writeFile(LAVORO + sicuro, new Uint8Array(dati));
  const t0 = performance.now();
  const esito = JSON.parse(avvio.esegui(sicuro));
  esito.secondi_totali = (performance.now() - t0) / 1000;
  const trasferisci = [];
  if (esito.codice_uscita === 0) {
    esito.html = pyodide.FS.readFile(LAVORO + "rapporto/" + esito.rapporto, { encoding: "utf8" });
    const zip = pyodide.FS.readFile(LAVORO + esito.zip);
    esito.zip_byte = zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength);
    trasferisci.push(esito.zip_byte);
  }
  invia("esito", { esito }, trasferisci);
}

self.addEventListener("unhandledrejection", (e) => invia("errore", { testo: String(e.reason && e.reason.message || e.reason) }));
self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.tipo === "avvia") {
      PYODIDE_DIR = m.pyodide_dir; RADICE = m.radice;
      invia("pronto", { tempi: await prepara(m) });
    } else if (m.tipo === "calcola") {
      calcola(m.nome, m.dati);
    } else if (m.tipo === "esempio") {
      calcola(m.nome, ESEMPIO.slice(0));
    }
  } catch (err) { invia("errore", { testo: String(err && err.message || err) }); }
};
