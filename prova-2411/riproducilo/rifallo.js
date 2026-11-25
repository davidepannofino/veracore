// «Rifallo tu, qui» (sessione 06, punto 4): nessun file da scaricare e nessun file di dati in piu' nel sito. Il browser legge l'esito
// di ogni paziente gia' pubblicato nella sfera (../dati/sfera.json), conta i pazienti con il cambio e quelli valutabili, ricalcola
// la quota e l'intervallo di Wilson con la stessa formula del codice (src/power_simulation.wilson_interval; z letto dal codice in
// rifallo/regola.json) e confronta, cifra per cifra, con il risultato registrato (sfera.json: «numero» e «intervalli»).
// L'esito resta in questa scheda (sessionStorage) e il Neural Core lo mostra nella scena S15. Nessun numero scritto qui.
const $ = (id) => document.getElementById(id);
const sezione = $("rifallo");
const esito = $("rifallo-esito");

// la stessa formula, nello stesso ordine di operazioni, di src/power_simulation.wilson_interval
export function wilson(successi, n, z) {
  if (n <= 0) return [NaN, NaN];
  const p = successi / n;
  const denom = 1.0 + z ** 2 / n;
  const centro = (p + z ** 2 / (2 * n)) / denom;
  const meta = z * Math.sqrt(p * (1 - p) / n + z ** 2 / (4 * n ** 2)) / denom;
  return [Math.max(0.0, centro - meta), Math.min(1.0, centro + meta)];
}

export function ricalcola(sfera, regola) {
  const nodi = (sfera.pazienti && sfera.pazienti.nodi) || [];
  const eventi = nodi.filter((x) => x.esito === regola.esiti.evento).length;
  const denominatore = nodi.filter((x) => regola.esiti.valutabile.includes(x.esito)).length;
  const [lo, hi] = wilson(eventi, denominatore, regola.z);
  return { eventi, denominatore, quota: eventi / denominatore, ic_lo: lo, ic_hi: hi };
}

export function registrato(sfera) {
  const n = sfera.numero || {}, w = (sfera.intervalli && sfera.intervalli.wilson) || {};
  return { eventi: Number(n.eventi), denominatore: Number(n.denominatore), quota: Number(n.valore_grezzo), ic_lo: Number(w.lo), ic_hi: Number(w.hi) };
}

function riga(etichetta, tuo, reg) {
  const tr = document.createElement("tr");
  tr.className = tuo === reg ? "uguale" : "diversa";
  // N1.10 (notte 25/11): a schermo i decimali con la virgola e al massimo 3 cifre; il confronto resta sui valori interi del file
  const mostra = (x) => (typeof x === "number" && Number.isFinite(x) && !Number.isInteger(x) ? x.toLocaleString("it-IT", { maximumFractionDigits: 3 }) : String(x));
  for (const [tag, testo] of [["th", etichetta], ["td", mostra(tuo)], ["td", mostra(reg)]]) {
    const c = document.createElement(tag); c.textContent = testo; if (tag === "th") c.scope = "row"; tr.append(c);
  }
  return tr;
}

async function rifai() {
  const pulsante = $("rifallo-avvia");
  pulsante.disabled = true;
  sezione.dataset.esito = "calcolo";
  const corpo = $("rifallo-confronto").querySelector("tbody");
  corpo.replaceChildren();
  try {
    const [sfera, regola] = await Promise.all(["../dati/sfera.json?v=9134bf2e", "rifallo/regola.json?v=231f50ae"].map(async (u) => {
      const r = await fetch(u, { cache: "no-store" });
      if (!r.ok) throw new Error(u + ": " + r.status);
      return r.json();
    }));
    const tuo = ricalcola(sfera, regola), reg = registrato(sfera);
    const etichette = JSON.parse(corpo.dataset.righe);
    let uguali = 0;
    for (const k of ["eventi", "denominatore", "quota", "ic_lo", "ic_hi"]) {
      if (tuo[k] === reg[k]) uguali += 1;
      corpo.append(riga(etichette[k], tuo[k], reg[k]));
    }
    const identico = uguali === 5 && Number.isFinite(reg.quota);
    sezione.dataset.esito = identico ? "identico" : "diverso";
    esito.textContent = identico ? esito.dataset.identico : esito.dataset.diverso;
    $("rifallo-confronto").hidden = false;
    const did = $("rifallo-didascalia");
    did.textContent = (sfera.numero && sfera.numero.didascalia) || ""; did.hidden = !did.textContent;   // vincolo 1: la didascalia accanto
    try {
      sessionStorage.setItem("rifallo_tu", JSON.stringify({ esito: identico ? "impronte_uguali" : "impronte_diverse", quando: new Date().toISOString() }));
    } catch (_) { /* senza sessionStorage l'esito resta solo qui */ }
    $("rifallo-core").hidden = false;
    window.rifallo = { esito: sezione.dataset.esito, uguali, confronti: 5, tuo, registrato: reg };
  } catch (e) {
    sezione.dataset.esito = "errore";
    esito.textContent = esito.dataset.errore;
    window.rifallo = { esito: "errore", messaggio: String(e) };
  } finally {
    pulsante.disabled = false;
  }
}

if (sezione) $("rifallo-avvia").addEventListener("click", rifai);
