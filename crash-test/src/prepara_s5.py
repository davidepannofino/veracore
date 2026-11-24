"""Preparazione di Data S5 (formato largo) per l'analisi primaria.

Preregistrazione v0.3.4: sezioni 1, 3, 4, 5; decisioni D10, D12, D13, D15. Convenzione dei nomi:
docs/CONVENZIONE_NOMI.md. Istruzioni in parole semplici: docs/ESEGUIRE_ANALISI_REALE.md.

COSA FA
  1. Decide se gli ingressi sono sintetici o veri. Con dati veri controlla la preregistrazione firmata
     (tag git, antenato di HEAD, albero pulito) PRIMA di aprire qualsiasi file di dati.
  2. Confronta le intestazioni di Data S5 con config/schema.yaml (sezione s5): se non coincidono
     esattamente si ferma e dice cosa differisce.
  3. Ricava paziente, intervento e lesione dal sample_id con interpreta_sample_id di src/data_audit.py
     (una sola implementazione). Un sample_id non valido e' escluso e contato, mai indovinato.
  4. Controlla il paziente con Data S1 (solo le colonne sample_id e patient): paziente diverso =
     conflitto, tutti i pazienti coinvolti sono esclusi (D13).
  5. Legge l'esito del test dei dati (DATA_AUDIT.csv, sezione 1): con FAIL si ferma; la modalita'
     "lesione verificata" / "lesione NON VERIFICATA" viene da li', non da una scelta di chi lancia.
  6. Regola v0.3.3: per ogni paziente un solo intervento, il primo in ordinamento di stringa con almeno
     due lesioni diverse con DSS nel pannello primario D15 (conta solo la PRESENZA della cella).
  7. Scrive le tabelle lunghe (una riga per campione e farmaco con DSS presente) e un rapporto di soli
     conteggi.

COSA NON FA (VIETATO)
  Nessun valore di DSS viene trasformato, troncato, arrotondato, confrontato, stampato o riassunto.
  Una cella vuota e' una misura assente (nessuna riga). I DSS negativi restano come sono: si ferma da
  solo src/endpoint.py (sezione 5). Il rapporto e la stampa contengono solo conteggi e identificativi.

Dati sintetici: nome del file con SINTETICO e colonna origine = SINTETICO in ogni riga; le uscite portano
SINTETICO nel nome e in ogni riga.

Uso (di norma si lancia src/esegui_analisi_reale.py, che chiama questo modulo):
    python -m src.prepara_s5 --s5 <Data S5.xlsx> --s1 <Data S1.xlsx> --audit <DATA_AUDIT.csv> --out results
"""
from __future__ import annotations

import argparse
import json
import math
import shlex
import sys
from dataclasses import dataclass, field
from pathlib import Path

import openpyxl
import pandas as pd
import yaml

from src import descriptive as ds
from src.data_audit import LESIONE_NON_VERIFICATA, LESIONE_VERIFICATA, interpreta_sample_id
from src.ingest import DEFAULT_SCHEMA, ORIGIN_COLUMN, SYNTHETIC_MARKER, SchemaError
from src.provenance import REPO_ROOT, SYNTHETIC_TAG, git_state, save_result, sha256_file

# --------------------------------------------------------------------------- nomi fissi
LIB1, LIB2, ENTRAMBE, NESSUNA = "lib1", "lib2", "entrambe", "nessuna"
HARMONIZE = "harmonize"
SINGOLO, COMBINAZIONE = "singolo", "combinazione"
MODALITA = (LESIONE_VERIFICATA, LESIONE_NON_VERIFICATA)
AUDIT_PASS = "PASS"

DEST_RIFERIMENTO = "intervento di riferimento"
DEST_ESPLORATIVA = "altro intervento (esplorativa)"
DEST_ESCLUSO = "escluso"
M_VUOTO = "sample_id vuoto"
M_NON_VALIDO = "sample_id non valido per la convenzione dei nomi"
M_CONFLITTO = "paziente coinvolto in un conflitto con Data S1 (D13)"
M_ALTRO_INTERVENTO = "intervento diverso da quello scelto (v0.3.3)"
M_NON_IDONEO = "nessun intervento idoneo: resta il primo intervento, l'analisi esclude il paziente con il suo motivo"
MOTIVI_ESCLUSIONE = {"campioni_esclusi_sample_id_vuoto": M_VUOTO, "campioni_esclusi_sample_id_non_valido": M_NON_VALIDO,
                     "campioni_esclusi_conflitto_S1": M_CONFLITTO}

T_PRIMARIA, T_ESTESA, T_COMBINAZIONI, T_RIRESEZIONI = "primaria", "estesa", "combinazioni", "riresezioni"
TABELLE = (T_PRIMARIA, T_ESTESA, T_COMBINAZIONI, T_RIRESEZIONI)
COLONNE_TABELLA = ["paziente", "intervento", "lesione", "regione", "sample_id", "librerie", "farmaco",
                   "libreria_farmaco", "tipo_voce", "farmaco_base", "stesso_farmaco_in_piu_voci", "dss"]
COLONNE_CAMPIONI = ["dataset", "riga_foglio", "sample_id", "paziente", "intervento", "lesione", "regione", "librerie",
                    "n_voci_primarie_con_dss", "n_voci_estese_singole_con_dss", "n_combinazioni_con_dss",
                    "destinazione", "motivo"]
COLONNE_RAPPORTO = ["dataset", "sezione", "metrica", "valore", "dettaglio"]


class PreparaError(RuntimeError):
    """Dati, schema o audit non utilizzabili: il messaggio dice cosa correggere."""


# --------------------------------------------------------------------------- schema di Data S5
@dataclass(frozen=True)
class Blocco:
    """Blocco di colonne di una libreria: suffisso obbligatorio e nomi esatti delle colonne, nell'ordine del file."""

    suffisso: str
    colonne: tuple[str, ...]

    @property
    def n_colonne(self) -> int:
        return len(self.colonne)


@dataclass(frozen=True)
class SchemaS5:
    percorso: str
    foglio: str
    sample_id: str
    run_id: dict[str, str]  # harmonize, lib1, lib2 -> nome della colonna
    primari: tuple[str, ...]
    blocchi: dict[str, Blocco]  # lib1, lib2
    combinazioni: tuple[str, ...]
    s1_foglio: str | None
    s1_sample_id: str
    s1_patient: str

    @property
    def n_colonne(self) -> int:
        return 2 + len(self.primari) + sum(1 + b.n_colonne for b in self.blocchi.values())

    def libreria_di(self, colonna: str) -> str | None:
        """Libreria (lib1/lib2) indicata dal suffisso della colonna, oppure None."""
        for lib, blocco in self.blocchi.items():
            if colonna.endswith(blocco.suffisso) and colonna != blocco.suffisso:
                return lib
        return None


def _testo_schema(valore, dove: str) -> str:
    if not isinstance(valore, str) or not valore:
        raise SchemaError(f"Schema: '{dove}' deve essere un testo non vuoto")
    return valore


def _elenco_schema(valore, dove: str) -> tuple[str, ...]:
    if not isinstance(valore, list) or not valore:
        raise SchemaError(f"Schema: '{dove}' deve essere un elenco non vuoto")
    out = tuple(_testo_schema(v, f"{dove}[]") for v in valore)
    if len(set(out)) != len(out):
        raise SchemaError(f"Schema: '{dove}' contiene nomi ripetuti")
    return out


def carica_schema_s5(schema_path: str | Path = DEFAULT_SCHEMA) -> SchemaS5:
    """Legge le sezioni s5 e s1 di config/schema.yaml e ne controlla la coerenza interna."""
    path = Path(schema_path)
    if not path.is_file():
        raise SchemaError(f"Schema non trovato: {path}")
    try:
        content = yaml.safe_load(path.read_text(encoding="utf-8"))
    except yaml.YAMLError as exc:
        raise SchemaError(f"Schema {path}: file YAML non leggibile ({exc})") from exc
    s5 = content.get("s5") if isinstance(content, dict) else None
    s1 = content.get("s1") if isinstance(content, dict) else None
    if not isinstance(s5, dict) or not isinstance(s1, dict):
        raise SchemaError(f"Schema {path}: mancano le sezioni 's5' e 's1'")
    run = s5.get("run_id")
    if not isinstance(run, dict):
        raise SchemaError(f"Schema {path}: manca 's5.run_id'")
    run_id = {k: _testo_schema(run.get(k), f"s5.run_id.{k}") for k in (HARMONIZE, LIB1, LIB2)}
    blocchi: dict[str, Blocco] = {}
    for lib in (LIB1, LIB2):
        b = s5.get(lib)
        if not isinstance(b, dict):
            raise SchemaError(f"Schema {path}: manca 's5.{lib}'")
        n = b.get("n_colonne")
        if not isinstance(n, int) or isinstance(n, bool) or n < 1:
            raise SchemaError(f"Schema {path}: 's5.{lib}.n_colonne' deve essere un intero positivo")
        suffisso = _testo_schema(b.get("suffisso"), f"s5.{lib}.suffisso")
        colonne = _elenco_schema(b.get("colonne"), f"s5.{lib}.colonne")
        if len(colonne) != n or any(not c.endswith(suffisso) or c == suffisso for c in colonne):
            raise SchemaError(f"Schema {path}: 's5.{lib}.colonne' deve avere {n} nomi che finiscono con '{suffisso}'")
        blocchi[lib] = Blocco(suffisso, colonne)
    schema = SchemaS5(
        percorso=str(path), foglio=_testo_schema(s5.get("foglio"), "s5.foglio"),
        sample_id=_testo_schema(s5.get("sample_id"), "s5.sample_id"), run_id=run_id,
        primari=_elenco_schema(s5.get("farmaci_primari"), "s5.farmaci_primari"), blocchi=blocchi,
        combinazioni=_elenco_schema(s5.get("combinazioni"), "s5.combinazioni"),
        s1_foglio=None if s1.get("foglio") in (None, "") else str(s1["foglio"]),
        s1_sample_id=_testo_schema(s1.get("sample_id"), "s1.sample_id"),
        s1_patient=_testo_schema(s1.get("patient"), "s1.patient"),
    )
    for combo in schema.combinazioni:
        lib = schema.libreria_di(combo)
        if lib is None or combo not in blocchi[lib].colonne:
            raise SchemaError(f"Schema {path}: la combinazione '{combo}' non e' nell'elenco delle colonne di una libreria")
    attese = intestazioni_attese(schema, sintetico=False)
    if len(set(attese)) != len(attese):
        raise SchemaError(f"Schema {path}: lo stesso nome di colonna compare piu' volte nella sezione s5")
    return schema


def intestazioni_attese(schema: SchemaS5, sintetico: bool) -> list[str]:
    """Le intestazioni di Data S5 secondo lo schema, nell'ordine del file."""
    attese = [schema.sample_id, schema.run_id[HARMONIZE], *schema.primari]
    for lib in (LIB1, LIB2):
        attese += [schema.run_id[lib], *schema.blocchi[lib].colonne]
    if sintetico:
        attese.append(ORIGIN_COLUMN)  # solo nei file SINTETICI: marcatore dentro i dati
    return attese


def confronta_intestazioni(intestazioni: list, schema: SchemaS5, sintetico: bool) -> list[str]:
    """Differenze tra le intestazioni del file e lo schema. Elenco vuoto = coincidono esattamente.

    Confronto ESATTO, nome per nome: maiuscole, spazi e simboli contano; nessuna somiglianza. L'ordine conta.
    """
    attese = intestazioni_attese(schema, sintetico)
    diff: list[str] = []
    for i, h in enumerate(intestazioni, start=1):
        if not isinstance(h, str):
            diff.append(f"colonna {i}: intestazione non testuale ({h!r})")
    testi = [h for h in intestazioni if isinstance(h, str)]
    ripetute = sorted({h for h in testi if testi.count(h) > 1})
    if ripetute:
        diff.append(f"intestazioni ripetute: {ripetute}")
    if len(intestazioni) != len(attese):
        diff.append(f"numero di colonne: attese {len(attese)}, trovate {len(intestazioni)}")
    mancanti = [n for n in attese if n not in intestazioni]
    if mancanti:
        diff.append(f"colonne attese e non trovate: {mancanti}")
    in_piu = [h for h in testi if h not in attese]
    if in_piu:
        diff.append(f"colonne non previste dallo schema: {in_piu}")
    for i, (atteso, h) in enumerate(zip(attese, intestazioni), start=1):
        if h != atteso:
            diff.append(f"colonna {i}: attesa '{atteso}', trovata {h!r}")
    return diff


# --------------------------------------------------------------------------- lettura
def _vuota(valore) -> bool:
    return valore is None or (isinstance(valore, str) and not valore.strip())


def _testo(valore) -> str | None:
    """Identificativo come testo esatto, spazi ai bordi tolti (A2); vuoto -> None."""
    if _vuota(valore):
        return None
    return str(valore).strip()


def leggi_foglio(percorso: str | Path, foglio: str) -> tuple[list, list[tuple[int, tuple]]]:
    """Intestazioni grezze e righe di dati (numero di riga del foglio, celle) di un foglio xlsx.

    Le colonne vuote in fondo (senza intestazione e senza dati) e le righe del tutto vuote non contano.
    """
    p = Path(percorso)
    if not p.is_file():
        raise PreparaError(f"STOP: file non trovato: {p}")
    if p.suffix.lower() not in (".xlsx", ".xlsm"):
        raise PreparaError(f"STOP: {p.name}: formato non supportato (serve .xlsx)")
    try:
        wb = openpyxl.load_workbook(p, data_only=True)
    except Exception as exc:  # file corrotto o non xlsx
        raise PreparaError(f"STOP: non riesco ad aprire {p.name} come xlsx: {exc}") from exc
    if foglio not in wb.sheetnames:
        raise PreparaError(f"STOP: {p.name}: foglio '{foglio}' non trovato. Fogli presenti: {wb.sheetnames}")
    righe = list(wb[foglio].iter_rows(values_only=True))
    if not righe:
        raise PreparaError(f"STOP: {p.name}: il foglio '{foglio}' e' vuoto")
    intestazioni = list(righe[0])
    while intestazioni and _vuota(intestazioni[-1]):
        intestazioni.pop()
    n = len(intestazioni)
    dati: list[tuple[int, tuple]] = []
    for numero, riga in enumerate(righe[1:], start=2):
        if any(not _vuota(v) for v in riga[n:]):
            raise PreparaError(f"STOP: {p.name}, riga {numero}: celle piene oltre l'ultima intestazione")
        celle = tuple(riga[:n]) + (None,) * (n - len(riga))
        if all(_vuota(v) for v in celle):
            continue
        dati.append((numero, celle))
    return intestazioni, dati


def _dss(valore, riga: int, colonna: str) -> float | None:
    """Valore di una cella DSS: None se vuota, altrimenti il numero cosi' com'e' (mai trasformato).

    Un valore non numerico o non finito ferma tutto (A2). Il messaggio non riporta mai il contenuto della cella.
    """
    if _vuota(valore):
        return None
    problema = None
    if isinstance(valore, bool):
        problema = "non numerico"
    elif isinstance(valore, (int, float)):
        numero = float(valore)
    elif isinstance(valore, str):
        try:
            numero = float(valore.strip())
        except ValueError:
            problema = "non numerico"
    else:
        problema = "non numerico"
    if problema is None and not math.isfinite(numero):
        problema = "non finito"
    if problema is not None:
        raise PreparaError(
            f"STOP: Data S5, riga {riga}, colonna '{colonna}': valore DSS {problema}. Una misura mancante deve essere "
            "una cella vuota; nessuna correzione automatica: serve una decisione scritta in docs/DEVIATIONS.md.")
    return numero


@dataclass(frozen=True)
class Voce:
    """Una colonna di risposta di Data S5."""

    colonna: str
    libreria: str  # harmonize / lib1 / lib2
    tipo: str  # singolo / combinazione
    base: str  # nome senza il suffisso della libreria


def voci_da_intestazioni(intestazioni: list[str], schema: SchemaS5) -> list[Voce]:
    """Colonne di risposta nell'ordine del file. Si chiama solo dopo che le intestazioni coincidono con lo schema."""
    speciali = {schema.sample_id, *schema.run_id.values(), ORIGIN_COLUMN}
    voci: list[Voce] = []
    for h in intestazioni:
        if h in speciali:
            continue
        if h in schema.primari:
            voci.append(Voce(h, HARMONIZE, SINGOLO, h))
            continue
        lib = schema.libreria_di(h)
        tipo = COMBINAZIONE if h in schema.combinazioni else SINGOLO
        voci.append(Voce(h, lib, tipo, h[: -len(schema.blocchi[lib].suffisso)]))
    return voci


def basi_in_piu_voci(voci: list[Voce]) -> list[str]:
    """Farmaci singoli che compaiono in piu' colonne (es. Oxaliplatin_lib1 e Oxaliplatin_lib2): segnalati, mai uniti."""
    basi = [v.base for v in voci if v.tipo == SINGOLO]
    return sorted({b for b in basi if basi.count(b) > 1})


@dataclass
class Campione:
    riga: int
    sample_id: str | None
    parti: dict | None  # paziente, intervento, lesione, regione (None se il sample_id non e' valido)
    librerie: str
    dss: dict[str, float]  # colonna -> valore, solo celle piene
    destinazione: str = ""
    motivo: str = ""


def _librerie(lib1: bool, lib2: bool) -> str:
    """Librerie del campione, ricavate SOLO dalla presenza dei run_id."""
    if lib1 and lib2:
        return ENTRAMBE
    return LIB1 if lib1 else LIB2 if lib2 else NESSUNA


def leggi_campioni(intestazioni: list[str], dati: list[tuple[int, tuple]], schema: SchemaS5,
                   voci: list[Voce]) -> list[Campione]:
    pos = {h: i for i, h in enumerate(intestazioni)}
    campioni: list[Campione] = []
    for numero, celle in dati:
        sid = _testo(celle[pos[schema.sample_id]])
        dss = {}
        for voce in voci:
            valore = _dss(celle[pos[voce.colonna]], numero, voce.colonna)
            if valore is not None:
                dss[voce.colonna] = valore
        campioni.append(Campione(
            riga=numero, sample_id=sid, parti=interpreta_sample_id(sid),
            librerie=_librerie(not _vuota(celle[pos[schema.run_id[LIB1]]]), not _vuota(celle[pos[schema.run_id[LIB2]]])),
            dss=dss))
    visti: dict[str, int] = {}
    for c in campioni:
        if c.sample_id is None:
            continue
        if c.sample_id in visti:
            raise PreparaError(
                f"STOP: Data S5: il sample_id '{c.sample_id}' compare in piu' righe ({visti[c.sample_id]} e {c.riga}). "
                "Nessuna media e nessuna scelta tra righe: serve una decisione scritta in docs/DEVIATIONS.md.")
        visti[c.sample_id] = c.riga
    return campioni


# --------------------------------------------------------------------------- controllo con Data S1 (D13)
def leggi_s1(percorso: str | Path, schema: SchemaS5) -> pd.DataFrame:
    """Solo le colonne sample_id e patient di Data S1, come testo esatto senza spazi ai bordi."""
    p = Path(percorso)
    if not p.is_file():
        raise PreparaError(f"STOP: file Data S1 non trovato: {p}")
    foglio = 0 if schema.s1_foglio is None else schema.s1_foglio
    servono = [schema.s1_sample_id, schema.s1_patient]
    try:
        presenti = list(pd.read_excel(p, sheet_name=foglio, nrows=0).columns)
    except ValueError as exc:
        raise PreparaError(f"STOP: {p.name}: foglio '{foglio}' non trovato") from exc
    mancanti = [c for c in servono if c not in presenti]
    if mancanti:
        raise PreparaError(f"STOP: {p.name}: colonne mancanti rispetto allo schema (sezione s1): {mancanti}. "
                           f"Colonne presenti: {[str(c) for c in presenti]}")
    raw = pd.read_excel(p, sheet_name=foglio, usecols=servono, dtype=str, keep_default_na=False)
    out = pd.DataFrame({"sample_id": [_testo(v) for v in raw[schema.s1_sample_id]],
                        "patient": [_testo(v) for v in raw[schema.s1_patient]]}, dtype=object)
    return out.dropna().drop_duplicates().reset_index(drop=True)


def controllo_s1(campioni: list[Campione], s1: pd.DataFrame) -> tuple[dict, set[str]]:
    """Confronta il paziente della convenzione con quello di Data S1, solo con chiavi identiche.

    Restituisce i conteggi e l'insieme dei pazienti COINVOLTI in un conflitto (quello della convenzione e
    quelli indicati da Data S1): vanno esclusi tutti, senza congetture (D13).
    """
    per_campione = {sid: sorted(set(g["patient"])) for sid, g in s1.groupby("sample_id", sort=True)}
    presenti = concordi = 0
    conflitti: dict[str, list[str]] = {}
    coinvolti: set[str] = set()
    for c in campioni:
        if c.parti is None or c.sample_id not in per_campione:
            continue
        presenti += 1
        pazienti_s1 = per_campione[c.sample_id]
        if pazienti_s1 == [c.parti["paziente"]]:
            concordi += 1
        else:
            conflitti[c.sample_id] = pazienti_s1
            coinvolti |= {c.parti["paziente"], *pazienti_s1}
    return {"presenti": presenti, "concordi": concordi, "conflitti": conflitti}, coinvolti


# --------------------------------------------------------------------------- esito del test dei dati (sezione 1)
def leggi_verdetto_audit(percorso: str | Path, *, sintetico: bool, sha: dict[str, str]) -> str:
    """Modalita' lesione dal DATA_AUDIT.csv di src/data_audit.py. Si ferma se il test dei dati non e' PASS,
    se l'audit riguarda altri file (SHA256 diversi) o se mescola dati sintetici e veri."""
    p = Path(percorso)
    if not p.is_file():
        raise PreparaError(f"STOP: file dell'audit non trovato: {p}. Serve il DATA_AUDIT.csv del test dei dati "
                           "(preregistrazione, sezione 1): l'esito va registrato prima di qualsiasi outcome.")
    tab = pd.read_csv(p, dtype=str, keep_default_na=False)
    mancanti = [c for c in ("sezione", "metrica", "valore", "synthetic", "input_sha256") if c not in tab.columns]
    if mancanti:
        raise PreparaError(f"STOP: {p.name} non sembra un DATA_AUDIT.csv: mancano le colonne {mancanti}")
    marcati = {v.strip().lower() for v in tab["synthetic"]}
    if marcati != {"true" if sintetico else "false"}:
        raise PreparaError(f"STOP: {p.name}: colonna synthetic = {sorted(marcati)}, ma i dati in ingresso sono "
                           f"{'sintetici' if sintetico else 'veri'}: audit e dati non vanno mescolati.")
    verdetto = tab[tab["sezione"] == "verdetto"]
    valori = {m: list(g["valore"]) for m, g in verdetto.groupby("metrica")}
    for metrica in ("test_dati_19_11", "modalita_lesione"):
        if len(valori.get(metrica, [])) != 1:
            raise PreparaError(f"STOP: {p.name}: manca la riga di verdetto '{metrica}' (serve l'audit versione 1.2).")
    impronte = set(tab["input_sha256"])
    if len(impronte) != 1:
        raise PreparaError(f"STOP: {p.name}: colonna input_sha256 non uniforme")
    try:
        sha_audit = json.loads(next(iter(impronte)))
    except json.JSONDecodeError as exc:
        raise PreparaError(f"STOP: {p.name}: colonna input_sha256 non leggibile") from exc
    if "S5" not in sha_audit:
        raise PreparaError(f"STOP: {p.name}: l'audit non registra l'SHA256 di S5")
    for etichetta in ("S5", "S1"):
        if etichetta in sha_audit and sha_audit[etichetta] != sha[etichetta]:
            raise PreparaError(f"STOP: {p.name}: l'audit e' stato fatto su un altro file Data {etichetta} "
                               f"(SHA256 dell'audit {sha_audit[etichetta]}, del file in ingresso {sha[etichetta]}).")
    esito, modalita = valori["test_dati_19_11"][0], valori["modalita_lesione"][0]
    if esito != AUDIT_PASS:
        raise PreparaError(f"STOP: il test dei dati registrato in {p.name} e' '{esito}', non {AUDIT_PASS}: esito STOP "
                           "(preregistrazione, sezioni 1 e 14). Nessuna analisi degli outcome.")
    if modalita not in MODALITA:
        raise PreparaError(f"STOP: {p.name}: modalita' lesione non riconosciuta: '{modalita}'")
    return modalita


# --------------------------------------------------------------------------- un intervento per paziente (v0.3.3)
def scegli_interventi(campioni: list[Campione], primari: set[str], verificata: bool) -> dict[str, tuple[str, bool]]:
    """Per ogni paziente: (intervento di riferimento, idoneo).

    Idoneo = il primo intervento, in ordinamento di stringa, con almeno due unita' diverse (lesioni; campioni se la
    lesione NON e' verificata) con almeno una cella DSS piena nel pannello primario. Conta solo la presenza.
    Senza nessun intervento idoneo resta il primo in ordinamento di stringa: il paziente compare nella tabella,
    l'analisi lo esclude con il suo motivo e i suoi organoidi replicati servono al rumore (A10).
    """
    per_paziente: dict[str, dict[str, set[str]]] = {}
    for c in campioni:
        unita = per_paziente.setdefault(c.parti["paziente"], {}).setdefault(c.parti["intervento"], set())
        if primari & set(c.dss):
            unita.add(c.parti["lesione"] if verificata else c.sample_id)
    scelti: dict[str, tuple[str, bool]] = {}
    for paziente, interventi in per_paziente.items():
        ordinati = sorted(interventi)  # ordinamento di stringa esatto, senza interpretare i numeri
        idonei = [i for i in ordinati if len(interventi[i]) >= 2]
        scelti[paziente] = (idonei[0], True) if idonei else (ordinati[0], False)
    return scelti


# --------------------------------------------------------------------------- tabelle e rapporto
def _righe_tabella(campioni: list[Campione], voci: list[Voce], piu_voci: set[str], verificata: bool) -> pd.DataFrame:
    righe = []
    for c in campioni:
        for v in voci:
            if v.colonna not in c.dss:
                continue  # cella vuota = misura assente: nessuna riga
            righe.append({
                "paziente": c.parti["paziente"], "intervento": c.parti["intervento"],
                "lesione": c.parti["lesione"] if verificata else "", "regione": c.parti["regione"] or "",
                "sample_id": c.sample_id, "librerie": c.librerie, "farmaco": v.colonna, "libreria_farmaco": v.libreria,
                "tipo_voce": v.tipo, "farmaco_base": v.base,
                "stesso_farmaco_in_piu_voci": "si" if (v.tipo == SINGOLO and v.base in piu_voci) else "no",
                "dss": c.dss[v.colonna],
            })
    return pd.DataFrame(righe, columns=COLONNE_TABELLA)


def _conta_tabella(tab: pd.DataFrame) -> dict[str, int]:
    return {
        "righe": len(tab), "pazienti": tab["paziente"].nunique(), "interventi": tab["intervento"].nunique(),
        "lesioni": tab.loc[tab["lesione"] != "", "lesione"].nunique(), "campioni": tab["sample_id"].nunique(),
        "voci": tab["farmaco"].nunique(),
    }


@dataclass
class Preparazione:
    sintetico: bool
    modalita: str
    tabelle: dict[str, pd.DataFrame]
    campioni: pd.DataFrame
    rapporto: pd.DataFrame
    librerie: dict[str, str]  # sample_id -> lib1 / lib2 / entrambe / nessuna
    sha: dict[str, str]
    ingressi: dict[str, str]
    percorsi: dict[str, Path] = field(default_factory=dict)  # compilato da salva_preparazione
    git_info: dict = field(default_factory=dict)  # fotografia git presa prima di scrivere

    @property
    def dataset(self) -> str:
        return SYNTHETIC_TAG if self.sintetico else "REALE"

    @property
    def prefisso(self) -> str:
        return f"{SYNTHETIC_TAG}_" if self.sintetico else ""


def controlla_origine_e_firma(percorsi: dict[str, str | Path], repo_root: str | Path = REPO_ROOT) -> bool:
    """True = ingressi sintetici, False = veri. Con dati veri il controllo sulla preregistrazione firmata viene
    PRIMA di aprire qualsiasi file di dati; non esiste nessun modo per saltarlo.

    Un nome senza SINTETICO e' trattato come dato vero senza aprire il file. Ingressi misti: errore.
    Dopo il controllo git si legge solo la colonna `origine` (src/descriptive.classify_origin).
    """
    nomi = {et: ds.is_synthetic_name(p) for et, p in percorsi.items()}
    if len(set(nomi.values())) > 1:
        raise ds.OriginError(f"STOP: ingressi misti, alcuni con {SYNTHETIC_TAG} nel nome e altri no: {nomi}. "
                             "Dati sintetici e dati veri non si mescolano.")
    sintetico = all(nomi.values())
    if not sintetico:
        ds.check_prereg_signed(repo_root)  # tag, antenato di HEAD, albero pulito: PRIMA di aprire i dati
    for etichetta in ("S5", "S1"):
        ds.classify_origin(percorsi[etichetta])  # nome e marcatore `origine` incoerenti: errore
    return sintetico


def prepara(s5: str | Path, s1: str | Path, audit: str | Path, config: str | Path = DEFAULT_SCHEMA,
            repo_root: str | Path = REPO_ROOT) -> Preparazione:
    """Dalla matrice larga di Data S5 alle tabelle lunghe, con il rapporto di soli conteggi. Non scrive file."""
    sintetico = controlla_origine_e_firma({"S5": s5, "S1": s1, "audit": audit}, repo_root)
    for etichetta, percorso in (("Data S5", s5), ("Data S1", s1), ("audit", audit)):
        if not Path(percorso).is_file():
            raise PreparaError(f"STOP: file {etichetta} non trovato: {percorso}")
    schema = carica_schema_s5(config)
    intestazioni, dati = leggi_foglio(s5, schema.foglio)
    diff = confronta_intestazioni(intestazioni, schema, sintetico)
    if diff:
        raise PreparaError(f"STOP: le intestazioni di {Path(s5).name} (foglio '{schema.foglio}') non coincidono "
                           f"ESATTAMENTE con lo schema {schema.percorso} (sezione s5):\n  - " + "\n  - ".join(diff))
    if sintetico:
        pos = intestazioni.index(ORIGIN_COLUMN)
        if any(_testo(celle[pos]) != SYNTHETIC_MARKER for _, celle in dati):
            raise ds.OriginError(f"STOP: {Path(s5).name}: non tutte le righe del foglio '{schema.foglio}' hanno "
                                 f"{ORIGIN_COLUMN} = {SYNTHETIC_MARKER}: marcatore incompleto.")
    sha = {"S5": sha256_file(s5), "S1": sha256_file(s1), "audit": sha256_file(audit)}
    modalita = leggi_verdetto_audit(audit, sintetico=sintetico, sha=sha)
    verificata = modalita == LESIONE_VERIFICATA
    voci = voci_da_intestazioni(intestazioni, schema)
    piu_voci = basi_in_piu_voci(voci)
    campioni = leggi_campioni(intestazioni, dati, schema, voci)

    # esclusioni, nell'ordine: sample_id vuoto, convenzione non valida, conflitto con Data S1 (D13)
    validi = [c for c in campioni if c.parti is not None]
    esito_s1, coinvolti = controllo_s1(validi, leggi_s1(s1, schema))
    for c in campioni:
        if c.sample_id is None:
            c.destinazione, c.motivo = DEST_ESCLUSO, M_VUOTO
        elif c.parti is None:
            c.destinazione, c.motivo = DEST_ESCLUSO, M_NON_VALIDO
        elif c.parti["paziente"] in coinvolti:
            c.destinazione, c.motivo = DEST_ESCLUSO, M_CONFLITTO
    ammessi = [c for c in campioni if not c.destinazione]

    # un intervento per paziente (v0.3.3), solo dalla presenza delle celle del pannello primario
    primari = set(schema.primari)
    scelti = scegli_interventi(ammessi, primari, verificata)
    for c in ammessi:
        intervento, idoneo = scelti[c.parti["paziente"]]
        if c.parti["intervento"] != intervento:
            c.destinazione, c.motivo = DEST_ESPLORATIVA, M_ALTRO_INTERVENTO
        else:
            c.destinazione, c.motivo = DEST_RIFERIMENTO, "" if idoneo else M_NON_IDONEO
    riferimento = [c for c in ammessi if c.destinazione == DEST_RIFERIMENTO]
    altri = [c for c in ammessi if c.destinazione == DEST_ESPLORATIVA]

    piu = set(piu_voci)
    tabelle = {
        T_PRIMARIA: _righe_tabella(riferimento, [v for v in voci if v.libreria == HARMONIZE], piu, verificata),
        T_ESTESA: _righe_tabella(riferimento, [v for v in voci if v.tipo == SINGOLO], piu, verificata),
        T_COMBINAZIONI: _righe_tabella(riferimento, [v for v in voci if v.tipo == COMBINAZIONE], piu, verificata),
        T_RIRESEZIONI: _righe_tabella(altri, voci, piu, verificata),  # solo righe, nessun calcolo
    }
    dataset = SYNTHETIC_TAG if sintetico else "REALE"
    if sintetico:
        for tab in tabelle.values():
            tab[ORIGIN_COLUMN] = SYNTHETIC_MARKER  # marcatore dentro i dati: ogni riga dichiara di essere sintetica

    estese = {v.colonna for v in voci if v.tipo == SINGOLO}
    combinazioni = {v.colonna for v in voci if v.tipo == COMBINAZIONE}
    tab_campioni = pd.DataFrame([{
        "dataset": dataset, "riga_foglio": c.riga, "sample_id": c.sample_id or "",
        "paziente": c.parti["paziente"] if c.parti else "", "intervento": c.parti["intervento"] if c.parti else "",
        "lesione": c.parti["lesione"] if (c.parti and verificata) else "",
        "regione": (c.parti["regione"] or "") if c.parti else "", "librerie": c.librerie,
        "n_voci_primarie_con_dss": len(primari & set(c.dss)), "n_voci_estese_singole_con_dss": len(estese & set(c.dss)),
        "n_combinazioni_con_dss": len(combinazioni & set(c.dss)), "destinazione": c.destinazione, "motivo": c.motivo,
    } for c in campioni], columns=COLONNE_CAMPIONI)

    righe: list[dict] = []

    def r(sezione, metrica, valore, dettaglio=""):
        righe.append({"dataset": dataset, "sezione": sezione, "metrica": metrica, "valore": valore, "dettaglio": dettaglio})

    unita = "lesioni" if verificata else "campioni"
    r("ingresso", "S5_file", Path(s5).name, f"SHA256 {sha['S5']}; foglio '{schema.foglio}'")
    r("ingresso", "S1_file", Path(s1).name, f"SHA256 {sha['S1']}; lette solo le colonne "
      f"'{schema.s1_sample_id}' e '{schema.s1_patient}'")
    r("ingresso", "audit_file", Path(audit).name, f"SHA256 {sha['audit']}")
    r("ingresso", "test_dei_dati", AUDIT_PASS, "dal file dell'audit (preregistrazione, sezione 1)")
    r("ingresso", "modalita_lesione", modalita, "dal file dell'audit, non da una scelta di chi lancia il comando")
    r("schema", "colonne_S5", len(intestazioni), "intestazioni identiche allo schema (sezione s5)"
      + (f", piu' la colonna {ORIGIN_COLUMN} dei dati sintetici" if sintetico else ""))
    r("schema", "voci_pannello_primario", len(primari), "D15: colonne tra run_id_harmonize e run_id_lib1")
    r("schema", "voci_pannello_esteso_singoli", len(estese), "D15: tutti i farmaci singoli (primari, lib1, lib2)")
    r("schema", "voci_combinazioni", len(combinazioni), "D12, D15: solo analisi secondaria")
    r("schema", "farmaci_singoli_in_piu_voci", len(piu_voci),
      "stesso nome in colonne diverse: voci distinte, mai unite; " + " | ".join(piu_voci))
    r("campioni", "righe_di_S5", len(campioni), "una riga per campione")
    for lib in (LIB1, LIB2, ENTRAMBE, NESSUNA):
        r("campioni", f"campioni_librerie_{lib}", sum(c.librerie == lib for c in campioni),
          "dalla sola presenza di run_id_lib1 e run_id_lib2")
    r("controllo_S1", "campioni_presenti_in_S1", esito_s1["presenti"],
      "campioni con sample_id valido presenti anche in Data S1 (gli altri non sono verificabili)")
    r("controllo_S1", "paziente_concorde", esito_s1["concordi"], "paziente di Data S1 identico a quello del sample_id")
    r("controllo_S1", "campioni_in_conflitto", len(esito_s1["conflitti"]),
      " | ".join(f"{sid} [S1: {', '.join(p)}]" for sid, p in sorted(esito_s1["conflitti"].items())))
    r("controllo_S1", "pazienti_coinvolti_esclusi", len(coinvolti), "D13: " + " | ".join(sorted(coinvolti)))
    for metrica, motivo in MOTIVI_ESCLUSIONE.items():
        ids = [c.sample_id or f"(riga {c.riga})" for c in campioni if c.motivo == motivo]
        r("esclusi", metrica, len(ids), f"{motivo}: " + " | ".join(ids))
    r("struttura", "campioni_ammessi", len(ammessi), "sample_id valido e nessun conflitto")
    r("struttura", "pazienti", len(scelti), "")
    r("struttura", "interventi", len({c.parti["intervento"] for c in ammessi}),
      "codici distinti prima di '_' (es. Pt6 e Pt6.2 sono due interventi dello stesso paziente)")
    r("struttura", "lesioni", len({c.parti["lesione"] for c in ammessi}) if verificata else "n/d",
      "lesione = intervento + '_' + t<n>" if verificata else "lesione NON VERIFICATA: nessun conteggio per lesione")
    r("struttura", "campioni_senza_dss_nel_pannello_primario", sum(not (primari & set(c.dss)) for c in ammessi),
      "nessuna cella piena tra le voci primarie: nessuna riga nella tabella primaria")
    r("intervento", "pazienti_con_intervento_idoneo", sum(ok for _, ok in scelti.values()),
      f"primo intervento in ordinamento di stringa con almeno 2 {unita} con DSS nel pannello primario (v0.3.3)")
    r("intervento", "interventi_scelti_non_primi",
      sum(ok and inv != min(c.parti["intervento"] for c in ammessi if c.parti["paziente"] == p)
          for p, (inv, ok) in scelti.items()),
      f"pazienti il cui primo intervento ha meno di 2 {unita} con DSS")
    senza = sorted(p for p, (_, ok) in scelti.items() if not ok)
    r("intervento", "pazienti_senza_intervento_idoneo", len(senza), f"{M_NON_IDONEO}; " + " | ".join(senza))
    r("intervento", "campioni_di_altri_interventi", len(altri), "tabella esplorativa delle ri-resezioni, senza calcoli")
    r("intervento", "altri_interventi", len({c.parti["intervento"] for c in altri}), "")
    r("intervento", "pazienti_con_altri_interventi", len({c.parti["paziente"] for c in altri}), "")
    for nome in TABELLE:
        for metrica, valore in _conta_tabella(tabelle[nome]).items():
            r(f"tabella_{nome}", metrica, valore, "una riga per campione e voce con DSS presente" if metrica == "righe" else "")
    rapporto = pd.DataFrame(righe, columns=COLONNE_RAPPORTO)
    return Preparazione(
        sintetico=sintetico, modalita=modalita, tabelle=tabelle, campioni=tab_campioni, rapporto=rapporto,
        librerie={c.sample_id: c.librerie for c in campioni if c.sample_id is not None}, sha=sha,
        ingressi={"S5": str(s5), "S1": str(s1), "audit": str(audit), "config": str(config)})


def salva_preparazione(prep: Preparazione, out: str | Path, *, command: str, git_info: dict) -> dict[str, Path]:
    """Scrive in `out` il rapporto di conteggi, l'elenco dei campioni e le quattro tabelle, ognuno con .meta.json."""
    common = dict(seed=None, synthetic=prep.sintetico, input_files=list(prep.ingressi.values()), command=command,
                  results_dir=out, git_info=git_info)
    percorsi = {
        "rapporto": save_result(prep.rapporto, f"{prep.prefisso}s5_rapporto_conteggi", **common),
        "campioni": save_result(prep.campioni, f"{prep.prefisso}s5_campioni", **common),
    }
    for nome in TABELLE:
        percorsi[nome] = save_result(prep.tabelle[nome], f"{prep.prefisso}s5_tabella_{nome}", **common)
    prep.percorsi = percorsi
    return percorsi


def stampa_rapporto(prep: Preparazione) -> None:
    """Solo conteggi e nomi di file: mai un valore di risposta."""
    if prep.sintetico:
        print(f"*** DATI SINTETICI ({SYNTHETIC_TAG}): nessun dato di risposta reale e' usato ***")
    print("PREPARAZIONE DI DATA S5 - rapporto di soli conteggi")
    sezione = None
    for riga in prep.rapporto.itertuples(index=False):
        if riga.sezione != sezione:
            sezione = riga.sezione
            print(f"  [{sezione}]")
        print(f"    {riga.metrica}: {riga.valore}")
    for nome, percorso in prep.percorsi.items():
        print(f"Salvato ({nome}): {percorso}")


ERRORI = (ds.OriginError, ds.PreregError, SchemaError, PreparaError)


def esegui_preparazione(s5, s1, audit, config, out, *, command: str, repo_root: str | Path = REPO_ROOT) -> Preparazione:
    """Controlli, preparazione e salvataggio. Solleva una delle eccezioni di ERRORI senza scrivere nulla."""
    prep = prepara(s5, s1, audit, config, repo_root)
    prep.git_info = git_state()  # una sola fotografia: i file scritti in results/ non sporcano i successivi
    salva_preparazione(prep, out, command=command, git_info=prep.git_info)
    stampa_rapporto(prep)
    return prep


def aggiungi_argomenti(ap: argparse.ArgumentParser) -> None:
    ap.add_argument("--s5", required=True, help="Data S5 (.xlsx, matrice DSS in formato largo)")
    ap.add_argument("--s1", required=True, help="Data S1 (.xlsx): si leggono solo sample_id e patient")
    ap.add_argument("--audit", required=True, help="DATA_AUDIT.csv del test dei dati (src/data_audit.py, versione 1.2)")
    ap.add_argument("--config", default=str(DEFAULT_SCHEMA), help="schema (config/schema.yaml)")
    ap.add_argument("--out", default=str(REPO_ROOT / "results"), help="cartella dei risultati")


def main(argv: list[str] | None = None, repo_root: str | Path = REPO_ROOT) -> int:
    ap = argparse.ArgumentParser(description="Prepara Data S5 per l'analisi primaria (solo conteggi in stampa)")
    aggiungi_argomenti(ap)
    args = ap.parse_args(argv)
    command = shlex.join(["python", "-m", "src.prepara_s5", *(argv if argv is not None else sys.argv[1:])])
    try:
        esegui_preparazione(args.s5, args.s1, args.audit, args.config, args.out, command=command, repo_root=repo_root)
    except ERRORI as exc:
        print(str(exc), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
