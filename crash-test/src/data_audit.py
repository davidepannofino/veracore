"""Audit STRUTTURALE dei dati reali (Data S1, S4, S5) - da eseguire in Google Colab.

Questo script e' autonomo: serve solo Python 3.10+ con pandas, openpyxl e pyyaml
(gia' presenti in Colab). Non importa nulla dal resto del repository.

COSA FA
  Fase 1: per ogni file xlsx stampa e salva SHA256, fogli, colonne, righe, tipi, e
          propone colonne "candidate" (solo dal nome, senza decidere) per sample_id,
          paziente, lesione, farmaco, DSS. Scrive anche audit_config.yaml da compilare.
  Esplora_id: per ogni file mostra la STRUTTURA TESTUALE dei sample_id (lunghezze,
          separatori _ - ., numero di parti, 10 esempi). Solo mostra: paziente e lesione
          non vengono mai dedotti dall'identificativo.
  Fase 2: con i nomi di colonna scelti dall'utente in audit_config.yaml (sample_id,
          paziente, lesione per ogni file) collega i campioni di S4 a paziente e lesione
          usando le fonti in ordine di priorita' (fonti_collegamento), SOLO con
          corrispondenza esatta dopo trim. Riporta collegati per fonte, scollegati e
          conflitti (segnalati, mai risolti). Poi conta pazienti, lesioni (se la colonna
          lesione esiste; altrimenti "lesione non identificata" e solo campioni distinti),
          farmaci comuni, repliche. Salva DATA_AUDIT.csv (+ .meta.json), synthetic=false.
          Dalla v1.2 (preregistrazione v0.3.3): fonte "CONVENZIONE" (paziente, intervento,
          lesione e regione dal sample_id, solo con l'espressione documentata dagli autori),
          controllo del paziente con Data S1, controllo dei codici con la Table S2
          (mmc8.xlsx, SOLO la colonna sample_id), conteggi per intervento (v0.3.3), D11 e
          verdetto PASS/FAIL del test dei dati del 19/11 con la modalita' lesione.

COSA NON FA (VIETATO)
  Nessuna differenza di DSS, distribuzione, correlazione o altra analisi dei valori di
  risposta. La colonna DSS serve solo per sapere se una misura e' presente (cella non
  vuota); il suo valore non viene mai usato, stampato o salvato.
  Della Table S2 (mmc8.xlsx) si legge solo la colonna sample_id (usecols): le altre colonne
  contengono riassunti di risposta (cDSS) e non entrano mai nel programma.

Dati sintetici: se un file ha SINTETICO nel nome, ogni output lo dichiara
(nome file, intestazione, colonna synthetic=true). Per i dati reali synthetic=false.

Uso da riga di comando (in Colab con il punto esclamativo davanti):
  python data_audit.py fase1 --S1 S1.xlsx --S4 S4.xlsx --S5 S5.xlsx
  python data_audit.py esplora_id --config audit_config.yaml
  python data_audit.py fase2 --config audit_config.yaml
"""
from __future__ import annotations

import argparse
import difflib
import hashlib
import json
import re
import statistics
import sys
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
import yaml

VERSIONE = "1.2"
SYNTHETIC_TAG = "SINTETICO"
ETICHETTE_FILE = ("S1", "S4", "S5")
RUOLI = ("sample_id", "paziente", "lesione", "farmaco", "dss")
RUOLI_EXTRA = ("replica", "dose")  # opzionali, usati solo in fase 2

# Convenzione dei nomi dei campioni descritta dagli autori (docs/CONVENZIONE_NOMI.md).
# Esempi: Pt6_t1 (paziente Pt6, primo intervento, lesione t1), Pt6.2_t4.1 (paziente Pt6,
# intervento Pt6.2 = ri-resezione, lesione Pt6.2_t4, regione 1 = organoide multiregionale).
CONVENZIONE = "CONVENZIONE"
REGEX_CONVENZIONE = re.compile(
    r"^(?P<paziente>Pt\d+)(?:\.(?P<intervento>\d+))?_(?P<lesione>t\d+)(?:\.(?P<regione>\d+))?$")
SOGLIA_PAZIENTI = 10      # test dei dati del 19/11: almeno 10 pazienti valutabili
SOGLIA_LESIONI_D11 = 5    # D11: sigma_rep stimabile solo con almeno 5 lesioni con >=2 organoidi
LESIONE_VERIFICATA = "lesione verificata"
LESIONE_NON_VERIFICATA = "tra campioni dello stesso paziente, lesione NON VERIFICATA"

# Parole chiave per proporre candidati dal NOME della colonna. Le parole corte (<=5
# lettere) devono coincidere con un'intera parola del nome; le lunghe possono comparire
# dentro il nome. Sono solo suggerimenti: la scelta e' sempre dell'utente.
PAROLE_CHIAVE = {
    "sample_id": ["sample", "campione", "organoid", "organoide", "pdo", "culture", "model",
                  "line", "clone", "specimen"],
    "paziente": ["patient", "paziente", "pazient", "subject", "donor", "case", "pt", "pz", "pat"],
    "lesione": ["lesion", "lesione", "metast", "site", "sede", "biops", "tumor", "tumour",
                "location"],
    "farmaco": ["drug", "farmaco", "compound", "agent", "treatment", "trattamento",
                "inhibitor", "molecol", "therapy", "terapia"],
    "dss": ["dss", "sensitiv", "sensibil", "response", "risposta"],
}


class AuditError(Exception):
    """Errore comprensibile per chi non programma: il messaggio dice cosa correggere."""


# ----------------------------------------------------------------------------- utilita'
def sha256_file(path: str | Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for blocco in iter(lambda: fh.read(1 << 20), b""):
            h.update(blocco)
    return h.hexdigest()


def is_synthetic(paths) -> bool:
    return any(SYNTHETIC_TAG in Path(p).name.upper() for p in paths)


def _suffisso(synthetic: bool) -> str:
    return f"_{SYNTHETIC_TAG}" if synthetic else ""


def _banner(titolo: str, synthetic: bool) -> None:
    print("=" * 70)
    if synthetic:
        print(f"*** {SYNTHETIC_TAG}: dati finti di prova, NON sono dati reali ***")
    print(titolo)
    print("=" * 70)


def _s(valore) -> str:
    """Nome di colonna dalla config: None/vuoto -> ''."""
    return "" if valore is None else str(valore).strip()


def _normalizza(nome) -> str:
    """'DrugName_ID' -> 'drug name id' (minuscolo, separa camelCase e simboli)."""
    testo = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", str(nome))
    return " ".join(re.findall(r"[a-z0-9]+", testo.lower()))


def proponi_candidati(colonne) -> dict[str, list[str]]:
    """Per ogni ruolo, le colonne il cui NOME somiglia al ruolo. Non decide nulla."""
    risultato: dict[str, list[str]] = {r: [] for r in RUOLI}
    for col in colonne:
        norm = _normalizza(col)
        parole = norm.split()
        compatto = norm.replace(" ", "")
        for ruolo, chiavi in PAROLE_CHIAVE.items():
            for k in chiavi:
                trovato = k in parole if len(k) <= 5 else k in compatto
                if trovato:
                    risultato[ruolo].append(str(col))
                    break
    return risultato


def _tipo(serie: pd.Series) -> str:
    """Tipo della colonna in parole semplici (non mostra mai valori)."""
    etichetta = pd.api.types.infer_dtype(serie, skipna=True)
    nomi = {
        "string": "testo", "integer": "intero", "floating": "decimale",
        "mixed-integer-float": "numero", "boolean": "si/no", "datetime64": "data",
        "datetime": "data", "date": "data", "empty": "vuota",
        "mixed": "misto (testo e numeri)", "mixed-integer": "misto (testo e numeri)",
    }
    return nomi.get(etichetta, etichetta)


# ----------------------------------------------------------------------------- fase 1
def descrivi_file(path: str | Path) -> dict:
    path = Path(path)
    if not path.exists():
        raise AuditError(f"File non trovato: {path}. Controlla di averlo caricato e il nome.")
    try:
        fogli = pd.read_excel(path, sheet_name=None)
    except Exception as exc:  # file corrotto, non xlsx, ecc.
        raise AuditError(f"Non riesco ad aprire {path.name} come xlsx: {exc}") from exc
    descrizione = {"file": path.name, "percorso": str(path), "sha256": sha256_file(path), "fogli": []}
    for nome, df in fogli.items():
        colonne = [
            {"nome": str(c), "tipo": _tipo(df[c]), "non_vuote": int(df[c].notna().sum())}
            for c in df.columns
        ]
        descrizione["fogli"].append({
            "nome": str(nome), "righe": int(len(df)), "colonne": colonne,
            "candidati": proponi_candidati(df.columns),
        })
    return descrizione


def _stampa_file(etichetta: str, d: dict) -> None:
    print(f"\n--- {etichetta}: {d['file']}")
    print(f"SHA256: {d['sha256']}")
    print(f"Fogli: {len(d['fogli'])}")
    for f in d["fogli"]:
        print(f"\n  Foglio '{f['nome']}': {f['righe']} righe, {len(f['colonne'])} colonne")
        for c in f["colonne"]:
            print(f"    - {c['nome']}  [{c['tipo']}, {c['non_vuote']} celle non vuote]")
        print("  Candidati dal nome (solo suggerimenti, decidi tu):")
        for ruolo in RUOLI:
            elenco = ", ".join(f["candidati"][ruolo]) or "(nessuno)"
            print(f"    {ruolo:10s}: {elenco}")


def _modello_config(descrizioni: dict[str, dict]) -> str:
    righe = [
        "# audit_config.yaml - COMPILA scrivendo tra virgolette il nome ESATTO della colonna.",
        "# Lascia \"\" dove una colonna non esiste in quel file. Le righe con # sono commenti.",
        "# I nomi si copiano dall'elenco stampato dalla Fase 1 (maiuscole e spazi contano).",
        "",
        "# Quale file contiene le misure per farmaco (deve avere la colonna farmaco):",
        'file_misure: "S4"',
        "",
        "# Fonti per collegare ogni sample_id di S4 a paziente e lesione, in ORDINE DI PRIORITA'",
        '# (la prima che contiene il campione vince). Esempio: ["S5", "S1"]. Ogni fonte deve avere',
        "# le colonne sample_id e paziente (lesione facoltativa). Solo corrispondenza esatta (trim).",
        "# Per la preregistrazione v0.3.3: [\"CONVENZIONE\"] = paziente, intervento e lesione dal",
        "# sample_id secondo la convenzione degli autori (docs/CONVENZIONE_NOMI.md).",
        "fonti_collegamento: []",
        "",
        "# File usati SOLO come controllo del paziente (stesso sample_id, paziente identico),",
        '# es. ["S1"]. Se il paziente e\' diverso il campione e\' in conflitto ed escluso (D13).',
        "controlli_paziente: []",
        "",
        "# Table S2 dell'articolo (mmc8.xlsx): si legge SOLO la colonna sample_id.",
        "table_s2:",
        '  percorso: ""',
        '  foglio: "Table S2"',
        "  riga_intestazione: 4",
        '  sample_id: "sample_id"',
        "",
        "file:",
    ]
    for etichetta, d in descrizioni.items():
        primo = d["fogli"][0] if d["fogli"] else None
        righe.append(f"  {etichetta}:")
        righe.append(f"    percorso: {json.dumps(d['percorso'])}")
        righe.append(f"    foglio: {json.dumps(primo['nome'] if primo else '')}"
                     "   # nome del foglio da usare")
        if len(d["fogli"]) > 1:
            righe.append("    # fogli disponibili: " + ", ".join(f["nome"] for f in d["fogli"]))
        for ruolo in RUOLI + RUOLI_EXTRA:
            suggeriti = ", ".join(primo["candidati"].get(ruolo, [])) if primo else ""
            commento = f"   # candidati dal nome: {suggeriti}" if suggeriti else ""
            righe.append(f'    {ruolo}: ""{commento}')
        righe.append("")
    righe += [
        "# sample_id = identificativo del campione      paziente = identificativo del paziente",
        "# lesione   = lesione/sede di prelievo         farmaco  = nome del farmaco",
        "# dss       = colonna della risposta: serve SOLO a sapere se la misura c'e' (cella piena)",
        "# replica   = (facoltativa) colonna che numera le repliche, di solito solo in S4",
        "# dose      = (facoltativa) colonna della dose/concentrazione, se esiste",
    ]
    return "\n".join(righe) + "\n"


def fase1(percorsi: dict[str, str | Path], cartella_output: str | Path = ".") -> dict:
    """Fase 1: struttura dei file. `percorsi` = {'S1': ..., 'S4': ..., 'S5': ...}."""
    out = Path(cartella_output)
    out.mkdir(parents=True, exist_ok=True)
    synthetic = is_synthetic(percorsi.values())
    _banner(f"AUDIT FASE 1 - struttura dei file (versione {VERSIONE})", synthetic)
    descrizioni = {et: descrivi_file(p) for et, p in percorsi.items()}
    for et, d in descrizioni.items():
        _stampa_file(et, d)

    suf = _suffisso(synthetic)
    adesso = datetime.now(timezone.utc).isoformat(timespec="seconds")
    rapporto = {"synthetic": synthetic, "script": f"data_audit.py {VERSIONE}",
                "creato_utc": adesso, "file": descrizioni}
    json_path = out / f"AUDIT_FASE1{suf}.json"
    json_path.write_text(json.dumps(rapporto, indent=2, ensure_ascii=False), encoding="utf-8")
    righe_csv = [
        {"etichetta": et, "file": d["file"], "sha256": d["sha256"], "foglio": f["nome"],
         "righe_foglio": f["righe"], "colonna": c["nome"], "tipo": c["tipo"],
         "non_vuote": c["non_vuote"], "synthetic": synthetic}
        for et, d in descrizioni.items() for f in d["fogli"] for c in f["colonne"]
    ]
    csv_path = out / f"AUDIT_FASE1_colonne{suf}.csv"
    pd.DataFrame(righe_csv).to_csv(csv_path, index=False)

    cfg_path = out / "audit_config.yaml"
    if cfg_path.exists():
        print(f"\nNOTA: {cfg_path} esiste gia' e NON e' stato toccato (non cancello le tue scelte).")
    else:
        cfg_path.write_text(_modello_config(descrizioni), encoding="utf-8")
        print(f"\nCreato il modello da compilare: {cfg_path}")
    print(f"Salvati: {json_path}, {csv_path}")
    print("PROSSIMO PASSO: apri audit_config.yaml, scrivi i nomi delle colonne, poi lancia la Fase 2.")
    return rapporto


# ----------------------------------------------------------------------------- fase 2
def _pulisci(serie: pd.Series) -> pd.Series:
    s = serie.astype("string").str.strip()
    return s.mask(s == "", pd.NA)


def _leggi_tabella(spec: dict, etichetta: str, solo: tuple[str, ...] | None = None) -> pd.DataFrame:
    """Legge solo le colonne scelte, le rinomina col nome del ruolo.
    La colonna DSS diventa un si/no 'misura presente': il valore viene scartato subito.
    Con `solo` legge unicamente quei ruoli (es. solo sample_id)."""
    percorso = _s(spec.get("percorso"))
    if not percorso or not Path(percorso).exists():
        raise AuditError(f"[{etichetta}] file non trovato: '{percorso}'. Controlla 'percorso'.")
    scelte = {r: _s(spec.get(r)) for r in RUOLI + RUOLI_EXTRA
              if _s(spec.get(r)) and (solo is None or r in solo)}
    foglio = spec.get("foglio")
    foglio = 0 if foglio in (None, "") else foglio
    try:
        intestazione = pd.read_excel(percorso, sheet_name=foglio, nrows=0)
    except ValueError as exc:
        fogli = ", ".join(pd.ExcelFile(percorso).sheet_names)
        raise AuditError(f"[{etichetta}] foglio '{foglio}' non trovato. Fogli: {fogli}") from exc
    for ruolo, col in scelte.items():
        if col not in intestazione.columns:
            vicini = difflib.get_close_matches(col, [str(c) for c in intestazione.columns], n=3)
            aiuto = f" Forse intendevi: {', '.join(vicini)}." if vicini else ""
            raise AuditError(f"[{etichetta}] colonna '{col}' (ruolo {ruolo}) non esiste.{aiuto} "
                             "Copia il nome esatto dall'elenco della Fase 1.")
    df = pd.read_excel(percorso, sheet_name=foglio, usecols=sorted(set(scelte.values())), dtype=str)
    out = pd.DataFrame(index=df.index)
    for ruolo, col in scelte.items():
        out[ruolo] = _pulisci(df[col])
    if "dss" in out:
        out["dss"] = out["dss"].notna()  # solo presenza, mai il valore
    return out


def interpreta_sample_id(sample_id) -> dict | None:
    """Paziente, intervento, lesione e regione dal sample_id, SOLO con REGEX_CONVENZIONE.
    Un identificativo che non rispetta l'espressione restituisce None: mai indovinato."""
    if sample_id is None or pd.isna(sample_id):
        return None
    m = REGEX_CONVENZIONE.fullmatch(str(sample_id))
    if m is None:
        return None
    intervento = m["paziente"] + (f".{m['intervento']}" if m["intervento"] is not None else "")
    return {"paziente": m["paziente"], "intervento": intervento,
            "lesione": f"{intervento}_{m['lesione']}", "regione": m["regione"],
            "ri_resezione": m["intervento"] is not None}


def tabella_convenzione(ids) -> tuple[pd.DataFrame, list[str]]:
    """Fonte CONVENZIONE: una riga per sample_id valido; restituisce anche i non validi."""
    distinti = list(pd.Series(ids, dtype="string").dropna().drop_duplicates())
    righe, non_validi = [], []
    for sid in distinti:
        d = interpreta_sample_id(sid)
        if d is None:
            non_validi.append(sid)
        else:
            righe.append({"sample_id": sid, **{k: d[k] for k in ("paziente", "intervento",
                                                                 "lesione", "regione")}})
    tab = pd.DataFrame(righe, columns=["sample_id", "paziente", "intervento", "lesione", "regione"],
                       dtype="string")
    return tab, non_validi


def collega_campioni(tabelle: dict[str, pd.DataFrame], fonti: list[str], etichetta_misure: str,
                     lesione_disponibile: bool, massimo: int = 10, controlli: list[str] | None = None,
                     non_validi: list[str] | None = None) -> tuple[pd.DataFrame, list[dict]]:
    """Collega ogni sample_id del file misure a paziente (e lesione, intervento) usando le
    `fonti` in ordine di priorita'. Solo corrispondenza ESATTA (valori gia' senza spazi ai bordi).

    Conflitto = stesso sample_id con paziente o lesione DIVERSI (tra fonti o dentro una fonte),
    oppure, per le fonti di `controlli` (es. S1), paziente diverso da quello collegato.
    I conflitti non si risolvono: il campione resta fuori dai conteggi e viene segnalato (D13).
    Un valore vuoto non e' un valore diverso. `non_validi` = sample_id che non rispettano la
    convenzione: esclusi e contati a parte, mai collegati.
    """
    controlli = list(controlli or [])
    non_validi = list(non_validi or [])
    esclusi = set(non_validi)
    mis = tabelle[etichetta_misure]
    tutti = list(mis["sample_id"].dropna().drop_duplicates())
    campioni = [c for c in tutti if c not in esclusi]
    pezzi = []
    for ordine, f in enumerate(fonti):
        t = tabelle[f]
        vuoto = pd.Series(pd.NA, index=t.index, dtype="string")
        pezzi.append(pd.DataFrame({
            "sample_id": t["sample_id"],
            "paziente": t["paziente"] if "paziente" in t else vuoto,
            "lesione": t["lesione"] if "lesione" in t else vuoto,
            "intervento": t["intervento"] if "intervento" in t else vuoto,
            "regione": t["regione"] if "regione" in t else vuoto,
            "fonte": f, "ordine": ordine}))
    rec = pd.concat(pezzi, ignore_index=True)
    rec = rec[rec["sample_id"].isin(set(campioni))]

    conflitti: dict[str, list[str]] = {}
    for campo in ("paziente", "lesione"):
        piene = rec.dropna(subset=[campo])
        for sid, g in piene.groupby("sample_id"):
            if g[campo].nunique() > 1:
                voci = ", ".join(f"{v} ({fo})" for v, fo in zip(g[campo], g["fonte"]))
                conflitti.setdefault(sid, []).append(f"{campo}: {voci}")

    # paziente collegato (prima fonte) per il confronto con le fonti di controllo
    primo = (rec.dropna(subset=["paziente"]).sort_values("ordine", kind="stable")
             .drop_duplicates("sample_id").set_index("sample_id")["paziente"])
    esito_controlli: dict[str, dict[str, int]] = {}
    for c in controlli:
        t = tabelle[c].dropna(subset=["sample_id", "paziente"])
        t = t[t["sample_id"].isin(set(primo.index))]
        presenti = concordi = 0
        for sid, g in t.groupby("sample_id"):
            presenti += 1
            pazienti_c = sorted(set(g["paziente"]))
            if pazienti_c == [primo[sid]]:
                concordi += 1
            else:
                conflitti.setdefault(sid, []).append(
                    f"paziente (controllo {c}): {primo[sid]} (collegamento), "
                    + ", ".join(f"{v} ({c})" for v in pazienti_c))
        esito_controlli[c] = {"presenti": presenti, "concordi": concordi,
                              "conflitto": presenti - concordi}
    in_conflitto = [c for c in campioni if c in conflitti]

    valide = rec[~rec["sample_id"].isin(set(in_conflitto))].sort_values("ordine", kind="stable")
    paz = valide.dropna(subset=["paziente"]).drop_duplicates("sample_id").set_index("sample_id")
    les = valide.dropna(subset=["lesione"]).drop_duplicates("sample_id").set_index("sample_id")
    inv = valide.dropna(subset=["intervento"]).drop_duplicates("sample_id").set_index("sample_id")
    reg = valide.dropna(subset=["regione"]).drop_duplicates("sample_id").set_index("sample_id")
    scollegati = [c for c in campioni if c not in paz.index and c not in conflitti]

    out = mis.drop(columns=[c for c in ("paziente", "lesione", "intervento", "regione")
                            if c in mis]).copy()
    out["paziente"] = out["sample_id"].map(paz["paziente"]).astype("string")
    out["lesione"] = out["sample_id"].map(les["lesione"]).astype("string")
    # senza una fonte che indica l'intervento, ogni paziente ha un solo intervento
    out["intervento"] = out["sample_id"].map(inv["intervento"]).astype("string").fillna(out["paziente"])
    out["regione"] = out["sample_id"].map(reg["regione"]).astype("string")

    righe = []

    def r(metrica, valore, dettaglio=""):
        righe.append({"sezione": "collegamento", "metrica": metrica, "valore": valore,
                      "dettaglio": dettaglio})

    r("campioni_S4_distinti", len(tutti), f"sample_id distinti in {etichetta_misure}")
    r("fonti_collegamento_ordine", " > ".join(fonti),
      "priorita': il paziente viene dalla prima fonte che contiene il campione; "
      "solo corrispondenza esatta dopo trim (O1a != o1a)")
    if CONVENZIONE in fonti:
        r("campioni_convenzione_non_valida", len(non_validi),
          f"sample_id che non rispettano {REGEX_CONVENZIONE.pattern}: esclusi, mai indovinati; "
          f"primi {massimo}: " + " | ".join(non_validi[:massimo]))
    for f in fonti:
        r(f"campioni_collegati_da_{f}", int((paz["fonte"] == f).sum()),
          "campioni con paziente preso da questa fonte (non da una fonte precedente)")
    r("campioni_collegati_totale", len(paz), "campioni con un paziente")
    r("campioni_scollegati", len(scollegati),
      f"nessuna fonte contiene il campione con un paziente; primi {massimo}: "
      + " | ".join(scollegati[:massimo]))
    for c, e in esito_controlli.items():
        r(f"controllo_{c}_campioni_presenti", e["presenti"],
          f"campioni collegati presenti anche in {c} con un paziente (gli altri non sono verificabili)")
        r(f"controllo_{c}_paziente_concorde", e["concordi"],
          f"paziente di {c} identico a quello del collegamento")
        r(f"controllo_{c}_paziente_in_conflitto", e["conflitto"],
          f"paziente di {c} diverso: campione escluso (D13)")
    r("campioni_in_conflitto", len(in_conflitto),
      "stesso sample_id con paziente o lesione diversi: NON risolti, esclusi dai conteggi (D13); "
      f"primi {massimo}: " + " | ".join(f"{c} [{'; '.join(conflitti[c])}]"
                                        for c in in_conflitto[:massimo]))
    righe_non = int(out["paziente"].isna().sum())
    r("righe_S4_con_campione_non_collegato", righe_non,
      "righe del file misure senza paziente (scollegato, in conflitto, convenzione non valida "
      "o sample_id vuoto)")
    if lesione_disponibile:
        for f in fonti:
            r(f"campioni_con_lesione_da_{f}", int((les["fonte"] == f).sum()),
              "campioni con lesione presa da questa fonte (prima in ordine di priorita')")
        senza = [c for c in paz.index if c not in les.index]
        r("campioni_collegati_senza_lesione", len(senza),
          "collegati a un paziente ma nessuna fonte indica la lesione")
    return out, righe


def _conteggi_lesione(mis: pd.DataFrame, nota_dss: str) -> list[dict]:
    """Solo con colonna lesione: pazienti con >=2 lesioni e farmaci in comune tra lesioni."""
    righe: list[dict] = []

    def r(metrica, valore, dettaglio=""):
        righe.append({"sezione": "lesione_identificata", "metrica": metrica, "valore": valore,
                      "dettaglio": dettaglio})

    r("lesione_stato", "identificata", "colonna lesione indicata: conteggi per lesione")
    coppie = mis[["paziente", "lesione"]].dropna().drop_duplicates()
    n_les = coppie.groupby("paziente")["lesione"].nunique()
    r("pazienti_con_almeno_2_lesioni", int((n_les >= 2).sum()),
      "pazienti con campioni S4 collegati a >=2 lesioni diverse")

    misurate = mis[mis["dss"]] if "dss" in mis else mis
    scarto = int(misurate[["paziente", "lesione", "farmaco"]].isna().any(axis=1).sum())
    base = misurate.dropna(subset=["paziente", "lesione", "farmaco"])
    n = base.groupby(["paziente", "farmaco"])["lesione"].nunique()
    per_paz = {p: set(g.index.get_level_values(1)) for p, g in n[n >= 2].groupby(level=0)}
    comuni = sorted(set().union(*per_paz.values())) if per_paz else []
    r("pazienti_con_farmaco_in_2_lesioni", len(per_paz),
      f"pazienti INCLUSI: almeno un farmaco misurato in >=2 lesioni diverse; {nota_dss}")
    r("farmaci_comuni_n", len(comuni),
      "farmaci misurati in >=2 lesioni dello stesso paziente (in almeno un paziente incluso); "
      "nomi confrontati solo se identici dopo aver tolto gli spazi ai bordi")
    r("farmaci_comuni_nomi", " | ".join(comuni), "")
    conteggi = sorted(len(v) for v in per_paz.values())
    det = f"per ciascuno dei {len(conteggi)} pazienti inclusi: n. farmaci misurati in >=2 lesioni"
    for nome, funz in (("min", min), ("mediana", statistics.median), ("max", max)):
        r(f"farmaci_per_paziente_{nome}", funz(conteggi) if conteggi else "n/d", det)
    a_tutti = sorted(set.intersection(*per_paz.values())) if per_paz else []
    r("farmaci_comuni_a_tutti_i_pazienti_inclusi_n", len(a_tutti) if per_paz else "n/d",
      "farmaci presenti (>=2 lesioni) in ogni paziente incluso")
    r("farmaci_comuni_a_tutti_i_pazienti_inclusi_nomi", " | ".join(a_tutti), "")
    r("pazienti_inclusi_con_piu_di_2_lesioni", int(sum(n_les.get(p, 0) > 2 for p in per_paz)),
      "con >2 lesioni 'in entrambi' e' ambiguo: qui basta il farmaco in >=2 lesioni")
    r("righe_misure_scartate_senza_paziente_lesione_farmaco", scarto, "")
    return righe


def _conteggi_senza_lesione(mis: pd.DataFrame) -> list[dict]:
    """Senza colonna lesione: SOLO campioni distinti. Nessun conteggio per lesione."""
    righe: list[dict] = []

    def r(metrica, valore, dettaglio=""):
        righe.append({"sezione": "lesione_NON_identificata", "metrica": metrica, "valore": valore,
                      "dettaglio": dettaglio})

    r("lesione_stato", "lesione non identificata",
      "nessuna colonna lesione indicata nelle fonti: la lesione NON e' dedotta dall'identificativo; "
      "sotto, solo conteggi di campioni distinti")
    coppie = mis[["paziente", "sample_id"]].dropna().drop_duplicates()
    per_paz = coppie.groupby("paziente")["sample_id"].nunique()
    r("campioni_distinti_collegati", int(coppie["sample_id"].nunique()),
      "sample_id distinti di S4 collegati a un paziente")
    r("pazienti_con_almeno_2_campioni_distinti", int((per_paz >= 2).sum()),
      "campioni distinti, NON lesioni: due campioni possono venire dalla stessa lesione")
    return righe


def _distribuzione(valori) -> str:
    """'1:4 | 2:3' = quanti elementi hanno 1, 2, ... (solo conteggi)."""
    serie = pd.Series(list(valori), dtype="int64")
    return " | ".join(f"{k}:{v}" for k, v in serie.value_counts().sort_index().items())


def _riassunto(valori) -> tuple:
    valori = sorted(valori)
    if not valori:
        return ("n/d", "n/d", "n/d")
    return (min(valori), statistics.median(valori), max(valori))


def _conteggi_struttura(mis: pd.DataFrame, misurate: pd.DataFrame) -> list[dict]:
    """Pazienti, interventi, lesioni, campioni per lesione, ri-resezioni, multiregionali e D11."""
    righe: list[dict] = []

    def r(metrica, valore, dettaglio=""):
        righe.append({"sezione": "struttura", "metrica": metrica, "valore": valore,
                      "dettaglio": dettaglio})

    col = mis.dropna(subset=["paziente"]).drop_duplicates("sample_id")
    r("pazienti_collegati", int(col["paziente"].nunique()), "pazienti con almeno un campione collegato")
    r("interventi", int(col["intervento"].nunique()),
      "codici distinti prima di '_' (es. Pt6 e Pt6.2 sono due interventi dello stesso paziente)")
    per_paz = col.groupby("paziente")["intervento"].nunique()
    r("pazienti_con_piu_interventi", int((per_paz >= 2).sum()), "")
    rires = col[col["intervento"] != col["paziente"]]
    r("ri_resezioni_campioni", int(len(rires)),
      "campioni di interventi successivi (codice con suffisso, es. Pt6.2): solo analisi esplorativa")
    r("ri_resezioni_interventi", int(rires["intervento"].nunique()), "")
    r("ri_resezioni_pazienti", int(rires["paziente"].nunique()), "")
    if col["lesione"].notna().any():
        lc = col.dropna(subset=["lesione"])
        per_les = lc.groupby("lesione")["sample_id"].nunique()
        r("lesioni", int(len(per_les)), "lesione = intervento + '_' + t<n>")
        r("campioni_per_lesione", _distribuzione(per_les), "n. campioni : n. lesioni")
        r("campioni_multiregionali", int(lc["regione"].notna().sum()),
          "campioni con suffisso di regione (es. Pt6_t1.2): organoidi della stessa lesione")
        ml = misurate.dropna(subset=["lesione", "farmaco"])
        org = ml.groupby("lesione")["sample_id"].nunique()
        n2 = int((org >= 2).sum())
        r("lesioni_con_almeno_2_organoidi", n2, "D11: organoidi distinti con almeno una misura")
        coppie = ml.drop_duplicates(["lesione", "farmaco", "sample_id"])
        n_f = coppie.groupby(["lesione", "farmaco"])["sample_id"].nunique()
        les_comuni = n_f[n_f >= 2].index.get_level_values(0).unique()
        nc = int(len(les_comuni))
        r("lesioni_con_almeno_2_organoidi_e_farmaco_comune", nc,
          "come sopra, con almeno un farmaco misurato su due organoidi della lesione")
        stimabile = nc >= SOGLIA_LESIONI_D11
        r("sigma_rep_D11", "stimabile" if stimabile else "non stimabile: si applica D2",
          f"stimabile solo con almeno {SOGLIA_LESIONI_D11} lesioni con >=2 organoidi e un farmaco "
          f"in comune (qui {nc}); nessun valore DSS usato")
    else:
        r("lesioni", "n/d", "nessuna lesione indicata")
        r("sigma_rep_D11", "non stimabile: si applica D2", "lesione non identificata")
    return righe


def conteggi_intervento(misurate: pd.DataFrame, unita: str, sezione: str) -> tuple[list[dict], int]:
    """Regola v0.3.3: per ogni paziente l'intervento scelto e' il primo (ordinamento di stringa)
    con almeno due `unita` diverse (lesioni o campioni) con misura. Restituisce le righe e il
    numero di pazienti valutabili (intervento scelto con almeno un farmaco misurato in due unita')."""
    nome = "lesioni" if unita == "lesione" else "campioni"
    distinti = "distinte" if unita == "lesione" else "distinti"
    righe: list[dict] = []

    def r(metrica, valore, dettaglio=""):
        if nome not in metrica:  # nomi unici tra le sezioni per lesioni e per campioni
            metrica = f"{metrica}_tra_{nome}"
        righe.append({"sezione": sezione, "metrica": metrica, "valore": valore, "dettaglio": dettaglio})

    base = misurate.dropna(subset=["paziente", "intervento", unita, "farmaco"])
    scelti: dict[str, str] = {}
    for paz, g in base.groupby("paziente"):
        for inv in sorted(g["intervento"].unique()):
            if g.loc[g["intervento"] == inv, unita].nunique() >= 2:
                scelti[paz] = inv
                break
    n_unita, comuni, non_primo = [], {}, 0
    for paz, inv in scelti.items():
        g = base[(base["paziente"] == paz) & (base["intervento"] == inv)]
        n_unita.append(int(g[unita].nunique()))
        per_f = g.groupby("farmaco")[unita].nunique()
        comuni[paz] = set(per_f[per_f >= 2].index)
        non_primo += inv != sorted(base.loc[base["paziente"] == paz, "intervento"].unique())[0]
    valutabili = {p: f for p, f in comuni.items() if f}
    r(f"pazienti_con_intervento_con_almeno_2_{nome}", len(scelti),
      f"intervento scelto = il primo in ordinamento di stringa con >=2 {nome} diversi con misura "
      "(regola v0.3.3, solo presenza delle misure)")
    r("interventi_scelti_non_primi", non_primo,
      "pazienti il cui intervento scelto non e' il primo in ordinamento (il primo ha <2 " + nome + ")")
    r(f"{nome}_{distinti}_intervento_scelto_totale", sum(n_unita), "")
    mn, md, mx = _riassunto(n_unita)
    r(f"{nome}_{distinti}_intervento_scelto_min_mediana_max", f"{mn} / {md} / {mx}", "per paziente")
    scelti_set = {(p, i) for p, i in scelti.items()}
    fuori = base[[(p, i) not in scelti_set for p, i in zip(base["paziente"], base["intervento"])]]
    r("campioni_fuori_intervento_scelto", int(fuori["sample_id"].nunique()),
      "altri interventi (ri-resezioni o interventi non scelti): solo analisi esplorativa")
    r("pazienti_valutabili", len(valutabili),
      f"intervento scelto con almeno un farmaco misurato in >=2 {nome} diversi (pannello comune)")
    mn, md, mx = _riassunto(len(f) for f in valutabili.values())
    r("farmaci_in_comune_intervento_scelto_min_mediana_max", f"{mn} / {md} / {mx}",
      f"per paziente valutabile: farmaci misurati in >=2 {nome} dell'intervento scelto")
    unione = sorted(set().union(*valutabili.values())) if valutabili else []
    r("farmaci_in_comune_intervento_scelto_unione_n", len(unione), " | ".join(unione))
    tutti = sorted(set.intersection(*valutabili.values())) if valutabili else []
    r("farmaci_in_comune_a_tutti_i_pazienti_valutabili_n", len(tutti) if valutabili else "n/d",
      " | ".join(tutti))
    return righe, len(valutabili)


def leggi_table_s2(spec: dict) -> pd.Series:
    """Table S2 dell'articolo (mmc8.xlsx): legge SOLO la colonna sample_id (usecols).
    Le altre colonne contengono riassunti di risposta (cDSS) e non vengono mai caricate."""
    percorso = _s(spec.get("percorso"))
    if not percorso or not Path(percorso).exists():
        raise AuditError(f"[table_s2] file non trovato: '{percorso}'. Carica mmc8.xlsx e controlla 'percorso'.")
    foglio = _s(spec.get("foglio")) or "Table S2"
    colonna = _s(spec.get("sample_id")) or "sample_id"
    riga = int(spec.get("riga_intestazione") or 4)
    fogli = pd.ExcelFile(percorso).sheet_names  # solo i nomi dei fogli
    if foglio not in fogli:
        raise AuditError(f"[table_s2] foglio '{foglio}' non trovato. Fogli: {', '.join(fogli)}")
    try:
        df = pd.read_excel(percorso, sheet_name=foglio, header=riga - 1, usecols=[colonna], dtype=str)
    except ValueError as exc:
        raise AuditError(f"[table_s2] colonna '{colonna}' non trovata alla riga {riga}: controlla "
                         "'sample_id' e 'riga_intestazione' (le intestazioni sono alla quarta riga).") from exc
    if list(df.columns) != [colonna]:
        raise AuditError(f"[table_s2] letta una colonna inattesa: {list(df.columns)}")
    return _pulisci(df[colonna])


def _controllo_table_s2(ids_s2: pd.Series, ids: dict[str, set], massimo: int = 10) -> tuple[list[dict], bool]:
    righe: list[dict] = []

    def r(metrica, valore, dettaglio=""):
        righe.append({"sezione": "table_S2", "metrica": metrica, "valore": valore, "dettaglio": dettaglio})

    s2 = set(ids_s2.dropna())
    r("table_S2_sample_id_distinti", len(s2), "letta SOLO la colonna sample_id (usecols)")
    tutti_presenti = True
    for et, insieme in ids.items():
        manca = sorted(insieme - s2)
        tutti_presenti &= not manca
        r(f"{et}_sample_id_in_table_S2", len(insieme & s2), f"su {len(insieme)} sample_id distinti di {et}")
        r(f"{et}_sample_id_non_in_table_S2", len(manca), f"primi {massimo}: " + " | ".join(manca[:massimo]))
    unione = set().union(*ids.values()) if ids else set()
    extra = sorted(s2 - unione)
    r("table_S2_sample_id_non_in_" + "_".join(ids), len(extra), f"primi {massimo}: " + " | ".join(extra[:massimo]))
    return righe, tutti_presenti and bool(ids)


def verdetto(coincidono: bool | None, conflitti: int, valutabili: int, modalita: str,
             motivo_modalita: str = "") -> list[dict]:
    """Test dei dati del 19/11 (preregistrazione v0.3.3, sezione 1): PASS o FAIL con i motivi."""
    motivi = []
    if coincidono is None:
        motivi.append("coincidenza dei sample_id di S4 e S5 non verificabile (sample_id di S5 non indicato)")
    elif not coincidono:
        motivi.append("i sample_id di S4 e S5 non coincidono")
    if conflitti:
        motivi.append(f"{conflitti} campioni con conflitto di collegamento (D13)")
    if valutabili < SOGLIA_PAZIENTI:
        motivi.append(f"pazienti valutabili {valutabili} < {SOGLIA_PAZIENTI}")
    esito = "FAIL" if motivi else "PASS"
    sez = "verdetto"
    return [
        {"sezione": sez, "metrica": "test_dati_19_11", "valore": esito,
         "dettaglio": ("; ".join(motivi) + ": esito STOP (sezione 14)") if motivi else
         "sample_id di S4 e S5 coincidenti; collegamento con chiavi identiche senza conflitti; "
         f"almeno {SOGLIA_PAZIENTI} pazienti valutabili"},
        {"sezione": sez, "metrica": "modalita_lesione", "valore": modalita,
         "dettaglio": f"sezioni 1 e 3 della preregistrazione: {motivo_modalita}".rstrip(": ")},
        {"sezione": sez, "metrica": "pazienti_valutabili_per_il_verdetto", "valore": valutabili,
         "dettaglio": "stesso intervento (v0.3.3); unita' = lesione se verificata, altrimenti campione"},
    ]


def calcola_audit(tabelle: dict[str, pd.DataFrame], etichetta_misure: str,
                  fonti: list[str] | None = None, controlli: list[str] | None = None,
                  table_s2: pd.Series | None = None) -> list[dict]:
    """Conteggi strutturali. Non tocca nessun valore di risposta."""
    fonti = list(fonti) if fonti is not None else []
    controlli = list(controlli or [])
    if etichetta_misure not in tabelle:
        raise AuditError(f"file_misure '{etichetta_misure}' non e' tra i file della config.")
    if "farmaco" not in tabelle[etichetta_misure] or "sample_id" not in tabelle[etichetta_misure]:
        raise AuditError(f"[{etichetta_misure}] servono le colonne 'sample_id' e 'farmaco': "
                         "e' il file delle misure.")
    if not fonti:
        raise AuditError("Config: indica 'fonti_collegamento' (es. [\"CONVENZIONE\"]), le fonti in ordine "
                         "di priorita' per collegare i campioni a paziente e lesione.")
    tabelle = dict(tabelle)
    non_validi: list[str] = []
    if CONVENZIONE in fonti:
        tabelle[CONVENZIONE], non_validi = tabella_convenzione(tabelle[etichetta_misure]["sample_id"])
    for f in fonti + controlli:
        if f not in tabelle:
            raise AuditError(f"fonti_collegamento/controlli_paziente: '{f}' non e' tra i file della config.")
        mancanti = [c for c in ("sample_id", "paziente") if c not in tabelle[f]]
        if mancanti:
            raise AuditError(f"[{f}] e' una fonte di collegamento o di controllo: indica le colonne "
                             f"{', '.join(mancanti)}.")
    lesione_disp = any("lesione" in tabelle[f] for f in fonti)
    mis, righe = collega_campioni(tabelle, fonti, etichetta_misure, lesione_disp,
                                  controlli=controlli, non_validi=non_validi)
    n_conflitti = next(x["valore"] for x in righe if x["metrica"] == "campioni_in_conflitto")
    tabelle.pop(CONVENZIONE, None)

    def r(sezione, metrica, valore, dettaglio=""):
        righe.append({"sezione": sezione, "metrica": metrica, "valore": valore, "dettaglio": dettaglio})

    per_file = {et: set(t["paziente"].dropna()) for et, t in tabelle.items() if "paziente" in t}
    per_file[f"{etichetta_misure}(collegati)"] = set(mis["paziente"].dropna())
    r("pazienti", "pazienti_totali", len(set().union(*per_file.values())),
      "; ".join(f"{k}={len(v)}" for k, v in per_file.items()))

    nota_dss = "misura = cella DSS non vuota" if "dss" in mis else "colonna DSS non indicata: ogni riga = una misura"
    righe.extend(_conteggi_lesione(mis, nota_dss) if lesione_disp else _conteggi_senza_lesione(mis))

    misurate = mis[mis["dss"]] if "dss" in mis else mis
    dup = trova_possibili_duplicati(misurate["farmaco"].dropna().unique())
    r("farmaci", "possibili_duplicati_farmaci_n", len(dup),
      "possibili duplicati da verificare: nomi di farmaco uguali ignorando maiuscole, spazi e trattini; "
      "NON uniti, solo segnalati")
    r("farmaci", "possibili_duplicati_farmaci_nomi", " ; ".join(" | ".join(g) for g in dup),
      "un gruppo per ';'")

    righe.extend(conta_senza_corrispondenza(tabelle))
    righe.extend(_conta_repliche(misurate, etichetta_misure, lesione_disp))

    # ---- v1.2: coincidenza S4/S5, Table S2, struttura, intervento (v0.3.3), verdetto
    ids = {et: set(tabelle[et]["sample_id"].dropna()) for et in ("S4", "S5")
           if et in tabelle and "sample_id" in tabelle[et]}
    coincidono = (ids["S4"] == ids["S5"]) if {"S4", "S5"} <= set(ids) else None
    if coincidono is None:
        r("coincidenza_S4_S5", "sample_id_S4_S5_coincidono", "n/d", "sample_id di S4 o S5 non indicato")
    else:
        r("coincidenza_S4_S5", "sample_id_S4_S5_coincidono", coincidono,
          f"S4={len(ids['S4'])}, S5={len(ids['S5'])}, in comune={len(ids['S4'] & ids['S5'])}; "
          "solo corrispondenza esatta")
    s2_tutti = False
    if table_s2 is not None:
        righe_s2, s2_tutti = _controllo_table_s2(table_s2, ids)
        righe.extend(righe_s2)

    if CONVENZIONE in fonti:
        # "coincide per tutti i campioni": servono tutti i sample_id nella Table S2 E nessun
        # sample_id con convenzione non valida
        verificata = s2_tutti and not non_validi
        problemi = []
        if not s2_tutti:
            problemi.append("Table S2 non indicata o sample_id di S4/S5 assenti dalla Table S2")
        if non_validi:
            problemi.append(f"{len(non_validi)} sample_id con convenzione non valida "
                            f"(primi 10: {' | '.join(non_validi[:10])})")
        motivo = ("convenzione documentata dagli autori (docs/CONVENZIONE_NOMI.md), tutti i sample_id "
                  "di S4 e S5 presenti nella Table S2 e nessuno con convenzione non valida" if verificata else
                  "convenzione non confermata per tutti i campioni: " + "; ".join(problemi))
    else:
        verificata = lesione_disp
        motivo = ("lesione da una colonna dei file con chiavi identiche" if verificata
                  else "nessuna colonna lesione e nessuna convenzione")
    modalita = LESIONE_VERIFICATA if verificata else LESIONE_NON_VERIFICATA
    righe.extend(_conteggi_struttura(mis, misurate))
    if lesione_disp:
        righe_l, val_l = conteggi_intervento(misurate, "lesione", "intervento_lesioni")
        righe.extend(righe_l)
    righe_c, val_c = conteggi_intervento(misurate, "sample_id", "intervento_campioni")
    righe.extend(righe_c)
    valutabili = val_l if verificata else val_c
    righe.extend(verdetto(coincidono, int(n_conflitti), valutabili, modalita, motivo))
    return righe


def _chiave_farmaco(nome: str) -> str:
    """Chiave di confronto: senza maiuscole, spazi e trattini. Serve solo a segnalare."""
    return re.sub(r"[\s\-]+", "", str(nome)).lower()


def trova_possibili_duplicati(nomi) -> list[list[str]]:
    """Gruppi di nomi diversi che diventano uguali ignorando maiuscole, spazi e trattini.

    Solo segnalazione: i nomi NON vengono mai uniti.
    """
    gruppi: dict[str, set[str]] = {}
    for nome in nomi:
        if pd.isna(nome):
            continue
        gruppi.setdefault(_chiave_farmaco(nome), set()).add(str(nome))
    return sorted(sorted(g) for g in gruppi.values() if len(g) > 1)


def conta_senza_corrispondenza(tabelle: dict[str, pd.DataFrame], massimo: int = 10) -> list[dict]:
    """Righe di ogni file la cui chiave (sample_id, paziente) non compare, IDENTICA dopo il
    trim, in nessun altro file che ha quella colonna. Mai somiglianza: 'O1a' != 'o1a'."""
    righe = []
    for ruolo in ("sample_id", "paziente"):
        con = {et: t for et, t in tabelle.items() if ruolo in t}
        for et, t in con.items():
            metrica = f"{et}_senza_corrispondenza_{ruolo}"
            altri = [set(o[ruolo].dropna()) for e, o in con.items() if e != et]
            if not altri:
                righe.append({"sezione": "senza_corrispondenza", "metrica": metrica, "valore": "n/d",
                              "dettaglio": f"nessun altro file con la colonna {ruolo}"})
                continue
            chiavi = t[ruolo]
            manca = chiavi.isna() | ~chiavi.isin(set().union(*altri))
            ids = chiavi[manca].dropna().drop_duplicates().tolist()
            righe.append({
                "sezione": "senza_corrispondenza", "metrica": metrica, "valore": int(manca.sum()),
                "dettaglio": (f"righe del file: {len(t)}; identificativi distinti non abbinati: "
                              f"{len(ids)}; righe con chiave vuota: {int(chiavi.isna().sum())}; "
                              f"primi {massimo}: {' | '.join(ids[:massimo])}")})
    return righe


def _conta_repliche(misurate: pd.DataFrame, etichetta: str, lesione_disponibile: bool) -> list[dict]:
    chiavi_obbl = ["paziente", "farmaco"] + (["lesione"] if lesione_disponibile else [])
    base = misurate.dropna(subset=chiavi_obbl + ["sample_id"])
    chiave = chiavi_obbl + (["dose"] if "dose" in base else [])
    tipi = []
    livello_misura = int((base.groupby(chiave + ["sample_id"]).size() > 1).sum())
    if livello_misura:
        tipi.append(f"ripetizioni della stessa misura ({livello_misura} combinazioni)")
    nota = "combinazioni = gruppi " + "+".join(chiave)
    if lesione_disponibile:
        livello_camp = int((base.groupby(chiave)["sample_id"].nunique() > 1).sum())
        if livello_camp:
            tipi.append(f"piu' campioni per stessa lesione e farmaco ({livello_camp} combinazioni)")
    else:
        nota += "; lesione non identificata: piu' campioni per paziente e farmaco non contati come repliche"
    if "replica" in base:
        tipi.append(f"colonna replica con {int(base['replica'].nunique())} valori distinti")
    return [
        {"sezione": "repliche", "metrica": f"{etichetta}_repliche_presenti", "valore": bool(tipi),
         "dettaglio": "dedotto dalla struttura delle righe; la natura (tecnica/biologica) "
                      "va confermata da chi conosce l'esperimento"},
        {"sezione": "repliche", "metrica": f"{etichetta}_repliche_tipo",
         "valore": " | ".join(tipi) if tipi else "nessuna", "dettaglio": nota},
    ]


def carica_config(path: str | Path) -> dict:
    path = Path(path)
    if not path.exists():
        raise AuditError(f"Config non trovata: {path}. Lancia prima la Fase 1 e compila il file.")
    try:
        cfg = yaml.safe_load(path.read_text(encoding="utf-8"))
    except yaml.YAMLError as exc:
        raise AuditError(f"audit_config.yaml non e' scritto bene (virgolette o rientri?): {exc}") from exc
    if not isinstance(cfg, dict) or not isinstance(cfg.get("file"), dict) or not cfg["file"]:
        raise AuditError("audit_config.yaml: manca la sezione 'file:' con S1, S4, S5.")
    return cfg


def _scrivi_meta(out: Path, nome: str, suf: str, percorsi: dict, sha: dict, adesso: str,
                 synthetic: bool, percorso_config) -> Path:
    meta = {
        "script": f"data_audit.py {VERSIONE}", "creato_utc": adesso, "synthetic": synthetic,
        "seed": None, "nota_seed": "nessuna componente casuale",
        "comando": " ".join(sys.argv), "python": sys.version.split()[0],
        "input_files": {et: {"file": Path(p).name, "sha256": sha[et]} for et, p in percorsi.items()},
        "config_sha256": sha256_file(percorso_config),
        "git_commit": None, "nota_git": "non disponibile (esecuzione fuori dal repository)",
    }
    meta_path = out / f"{nome}{suf}.meta.json"
    meta_path.write_text(json.dumps(meta, indent=2, ensure_ascii=False), encoding="utf-8")
    return meta_path


def fase2(percorso_config: str | Path, cartella_output: str | Path = ".") -> pd.DataFrame:
    """Fase 2: conteggi strutturali da audit_config.yaml -> DATA_AUDIT.csv."""
    out = Path(cartella_output)
    out.mkdir(parents=True, exist_ok=True)
    cfg = carica_config(percorso_config)
    percorsi = {et: _s(spec.get("percorso")) for et, spec in cfg["file"].items()}
    synthetic = is_synthetic(percorsi.values())
    _banner(f"AUDIT FASE 2 - conteggi strutturali (versione {VERSIONE})", synthetic)
    tabelle = {et: _leggi_tabella(spec or {}, et) for et, spec in cfg["file"].items()}
    etichetta_misure = _s(cfg.get("file_misure")) or "S4"
    fonti = [_s(f) for f in (cfg.get("fonti_collegamento") or [])]
    controlli = [_s(f) for f in (cfg.get("controlli_paziente") or [])]
    spec_s2 = cfg.get("table_s2") or {}
    table_s2 = None
    if _s(spec_s2.get("percorso")):
        table_s2 = leggi_table_s2(spec_s2)
        percorsi["TableS2"] = _s(spec_s2.get("percorso"))
    righe = calcola_audit(tabelle, etichetta_misure, fonti, controlli, table_s2)

    sha = {et: sha256_file(p) for et, p in percorsi.items()}  # tutti i file letti, anche mmc8.xlsx
    adesso = datetime.now(timezone.utc).isoformat(timespec="seconds")
    df = pd.DataFrame(righe, columns=["sezione", "metrica", "valore", "dettaglio"])
    df["synthetic"] = synthetic
    df["creato_utc"] = adesso
    df["script"] = f"data_audit.py {VERSIONE}"
    df["input_sha256"] = json.dumps(sha, sort_keys=True)

    suf = _suffisso(synthetic)
    csv_path = out / f"DATA_AUDIT{suf}.csv"
    df.to_csv(csv_path, index=False)
    meta_path = _scrivi_meta(out, "DATA_AUDIT", suf, percorsi, sha, adesso, synthetic, percorso_config)

    print("\nRISULTATI")
    sezione = None
    for _, riga in df.iterrows():
        if riga["sezione"] != sezione:
            sezione = riga["sezione"]
            print(f"\n  [{sezione}]")
        print(f"    {riga['metrica']}: {riga['valore']}")
    print(f"\nSalvati: {csv_path} e {meta_path}")
    return df


# ----------------------------------------------------------------------------- esplora_id
SEPARATORI = ("_", "-", ".")


def struttura_id(serie: pd.Series, esempi: int = 10) -> dict:
    """Struttura testuale dei sample_id: SOLO descrizione, nessuna deduzione di paziente o lesione."""
    distinti = list(serie.dropna().astype(str).drop_duplicates())
    lunghezze = pd.Series([len(v) for v in distinti], dtype="int64").value_counts().sort_index()
    parti = pd.Series([len([x for x in re.split(r"[_\-.]", v)]) for v in distinti],
                      dtype="int64").value_counts().sort_index()
    return {
        "non_vuoti": int(serie.notna().sum()),
        "distinti": len(distinti),
        "lunghezza_min": int(lunghezze.index.min()) if len(distinti) else "n/d",
        "lunghezza_max": int(lunghezze.index.max()) if len(distinti) else "n/d",
        "lunghezze": " | ".join(f"{k}:{v}" for k, v in lunghezze.items()),
        **{f"con_separatore_{sep}": sum(sep in v for v in distinti) for sep in SEPARATORI},
        "numero_parti": " | ".join(f"{k}:{v}" for k, v in parti.items()),
        "esempi": " | ".join(distinti[:esempi]),
    }


def esplora_id(percorso_config: str | Path, cartella_output: str | Path = ".") -> pd.DataFrame:
    """Mostra la struttura testuale dei sample_id di ogni file (colonna sample_id della config)."""
    out = Path(cartella_output)
    out.mkdir(parents=True, exist_ok=True)
    cfg = carica_config(percorso_config)
    percorsi = {et: _s(spec.get("percorso")) for et, spec in cfg["file"].items()}
    synthetic = is_synthetic(percorsi.values())
    _banner(f"AUDIT ESPLORA_ID - struttura dei sample_id (versione {VERSIONE})", synthetic)
    print("Solo descrizione del testo. Paziente e lesione NON vengono mai dedotti dall'identificativo.")
    righe = []
    for et, spec in cfg["file"].items():
        spec = spec or {}
        if not _s(spec.get("sample_id")):
            print(f"\n--- {et}: colonna sample_id non indicata nella config, salto.")
            continue
        t = _leggi_tabella(spec, et, solo=("sample_id",))
        d = struttura_id(t["sample_id"])
        righe.append({"file": et, "colonna": _s(spec.get("sample_id")), **d})
        print(f"\n--- {et}  (colonna '{_s(spec.get('sample_id'))}')")
        print(f"  valori non vuoti: {d['non_vuoti']}, distinti: {d['distinti']}")
        print(f"  lunghezze (lunghezza:quanti): {d['lunghezze']}")
        print("  contengono il separatore: " + ", ".join(f"'{s}'={d[f'con_separatore_{s}']}" for s in SEPARATORI))
        print(f"  numero di parti (spezzando su _ - .): {d['numero_parti']}")
        print(f"  primi {min(10, d['distinti'])} esempi distinti: {d['esempi']}")
    df = pd.DataFrame(righe)
    sha = {et: sha256_file(p) for et, p in percorsi.items()}
    adesso = datetime.now(timezone.utc).isoformat(timespec="seconds")
    df["synthetic"] = synthetic
    df["creato_utc"] = adesso
    df["script"] = f"data_audit.py {VERSIONE}"
    suf = _suffisso(synthetic)
    csv_path = out / f"ESPLORA_ID{suf}.csv"
    df.to_csv(csv_path, index=False)
    meta_path = _scrivi_meta(out, "ESPLORA_ID", suf, percorsi, sha, adesso, synthetic, percorso_config)
    print(f"\nSalvati: {csv_path} e {meta_path}")
    return df


# ----------------------------------------------------------------------------- CLI
def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Audit strutturale Data S1/S4/S5 (nessuna analisi dei valori).")
    sub = ap.add_subparsers(dest="comando", required=True)
    p1 = sub.add_parser("fase1", help="struttura dei file e modello di config")
    for et in ETICHETTE_FILE:
        p1.add_argument(f"--{et}", required=True, help=f"percorso del file Data {et} (xlsx)")
    p2 = sub.add_parser("fase2", help="conteggi con i nomi di colonna scelti")
    p2.add_argument("--config", default="audit_config.yaml")
    p3 = sub.add_parser("esplora_id", help="struttura testuale dei sample_id (solo mostra)")
    p3.add_argument("--config", default="audit_config.yaml")
    for p in (p1, p2, p3):
        p.add_argument("--out", default=".", help="cartella dove salvare i risultati")
    a = ap.parse_args(argv)
    try:
        if a.comando == "fase1":
            fase1({et: getattr(a, et) for et in ETICHETTE_FILE}, a.out)
        elif a.comando == "esplora_id":
            esplora_id(a.config, a.out)
        else:
            fase2(a.config, a.out)
    except AuditError as exc:
        print(f"\nERRORE: {exc}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
