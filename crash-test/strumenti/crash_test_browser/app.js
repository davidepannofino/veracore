// Crash test nel browser: interfaccia. Il calcolo gira in worker.js.
// Catena delle impronte: index.html verifica questo file (SRI); questo file verifica worker.js, il manifesto di Pyodide
// (strumenti/browser_pyodide/impronte_pyodide.json) e il manifesto del codice (impronte_codice.json) con le impronte
// qui sotto, scritte da prepara.py. Nessuna richiesta parte prima del clic su «Avvia», nessuna dopo «pronto».
"use strict";
const IMPRONTA_WORKER = "bf4e380e7611633fb1a08f94c53f5526a993bebdbd84e2184685acf832916d18";
const IMPRONTA_PYODIDE = "624ee4167fe87271d2e871c7dd31cc00dd5e2e2ba147a672e98ba0d0d84f2032";
const IMPRONTA_CODICE = "c69c223f21935bc1b38fce45efaa3b00ba11650912ec87bd98332f055d09040d";
const ESEMPIO = "data/SINTETICO_crash_test/SINTETICO_esempio.csv";
const CARTELLA = new URL(".", location.href).href;
const PYODIDE_DIR = new URL("../browser_pyodide/", location.href).href;
const RADICE = new URL("../../", location.href).href;   // radice del repository pubblicato
// rimandi a pagine del sito, mai a file (sessione 06): nel sito la pagina sta in crash-test/strumenti/crash_test_browser/
const SITO = new URL("../../../", location.href).href;
const UFFICIALI = SITO + "#risultato";
const RIPRODUCILO = SITO + "riproducilo/";

const $ = (id) => document.getElementById(id);
const esadecimale = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const stato = { fase: "iniziale", esito: null };
window.crashTest = stato;   // letto dai test
let worker = null, urlZip = null;

async function scaricaVerificato(url, atteso) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  const buf = await r.arrayBuffer();
  if (esadecimale(await crypto.subtle.digest("SHA-256", buf)) !== atteso) throw new Error(`impronta diversa da quella attesa, rifiutato: ${url}`);
  return buf;
}
const testo = (buf) => new TextDecoder().decode(buf);

function messaggio(html, classe) {
  const m = $("messaggio");
  m.className = classe || "";
  m.innerHTML = html;
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

async function avvia() {
  $("avvia").disabled = true;
  stato.fase = "caricamento";
  $("fase").textContent = "Verifica dei file in corso…";
  try {
    const [pyo, codice, sorgente] = await Promise.all([
      scaricaVerificato(PYODIDE_DIR + "impronte_pyodide.json", IMPRONTA_PYODIDE),
      scaricaVerificato(CARTELLA + "impronte_codice.json", IMPRONTA_CODICE),
      scaricaVerificato(CARTELLA + "worker.js", IMPRONTA_WORKER)]);
    worker = new Worker(URL.createObjectURL(new Blob([sorgente], { type: "text/javascript" })));
    worker.onmessage = ricevi;
    worker.postMessage({ tipo: "avvia", pyodide_dir: PYODIDE_DIR, radice: RADICE, manifesto_pyodide: JSON.parse(testo(pyo)),
      manifesto_codice: JSON.parse(testo(codice)), impronta_codice: IMPRONTA_CODICE, esempio: ESEMPIO });
  } catch (e) { fermo(e.message || String(e)); }
}

function fermo(t) {
  stato.fase = "errore";
  $("fase").textContent = "FERMATO: " + t;
}

function ricevi(e) {
  const m = e.data;
  if (m.tipo === "avanzamento") { $("barra").value = m.fatti / m.totale; $("fase").textContent = m.testo; }
  if (m.tipo === "pronto") {
    stato.fase = "pronto"; stato.tempi = m.tempi;
    $("barra").value = 1;
    $("fase").textContent = `Pronto in ${m.tempi.secondi.toFixed(1).replace(".", ",")} s. Da ora la pagina non usa più la rete.`;
    $("file").disabled = false; $("esempio").disabled = false;
    $("passo1").classList.remove("attivo"); $("passo2").classList.add("attivo");
  }
  if (m.tipo === "esito") mostra(m.esito);
  if (m.tipo === "errore") { stato.esito = { errore_js: m.testo }; stato.fase = "errore"; messaggio(esc("FERMATO: " + m.testo), "errore"); }
}

function mostra(esito) {
  stato.esito = esito; stato.fase = "fatto";
  $("passo3").classList.add("attivo");
  $("rapporto").hidden = true; $("scarica-blocco").hidden = true;
  if (esito.rifiutato) {
    messaggio(`<strong>Questo file non si analizza qui.</strong> Sembra derivato dai dati di Kryeziu et al. 2026
      (${esc(esito.rifiutato)}). Quei dati si analizzano solo con la preregistrazione firmata: guarda i
      <a href="${UFFICIALI}">risultati ufficiali</a> oppure rifai tu l'analisi con
      <a href="${RIPRODUCILO}">«Riproducilo tu»</a>.`, "rifiuto");
    return;
  }
  if (esito.codice_uscita !== 0) { messaggio(esc(esito.errore || "calcolo non riuscito"), "errore"); return; }
  const secondi = esito.secondi_totali.toFixed(1).replace(".", ",");
  messaggio(`Rapporto pronto per <span class="mono">${esc(esito.nome)}</span>, calcolato in ${secondi} s nel tuo
    browser${esito.nome.includes("SINTETICO") ? ' · <span class="sintetico">SINTETICO</span>' : ""}.`);
  if (urlZip) URL.revokeObjectURL(urlZip);
  urlZip = URL.createObjectURL(new Blob([esito.zip_byte], { type: "application/zip" }));
  $("scarica").href = urlZip;
  $("scarica").download = esito.zip;
  $("scarica-blocco").hidden = false;
  $("rapporto").srcdoc = esito.html;
  $("rapporto").hidden = false;
}

function calcola(nome, dati) {
  stato.fase = "calcolo"; stato.esito = null;
  messaggio(`Calcolo in corso su <span class="mono">${esc(nome)}</span>…`, "tenue");
  worker.postMessage({ tipo: "calcola", nome, dati }, [dati]);
}
async function scegli(file) {
  if (!file || stato.fase === "iniziale" || stato.fase === "caricamento") return;
  calcola(file.name, await file.arrayBuffer());
}

$("avvia").addEventListener("click", avvia);
$("file").addEventListener("change", () => scegli($("file").files[0]));
$("esempio").addEventListener("click", () => {
  stato.fase = "calcolo"; stato.esito = null;
  messaggio("Calcolo in corso sui dati di esempio…", "tenue");
  worker.postMessage({ tipo: "esempio", nome: ESEMPIO.split("/").pop() });
});
const zona = $("zona");
zona.addEventListener("dragover", (e) => { e.preventDefault(); zona.classList.add("sopra"); });
zona.addEventListener("dragleave", () => zona.classList.remove("sopra"));
zona.addEventListener("drop", (e) => { e.preventDefault(); zona.classList.remove("sopra"); scegli(e.dataTransfer.files[0]); });
