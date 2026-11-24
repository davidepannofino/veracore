"""Crash test aperto: il "Rapporto di rappresentativita'" per chiunque abbia piu' lesioni dello stesso paziente con un
punteggio di risposta ai farmaci. Formato e regole in docs/CRASH_TEST.md.

    python -m strumenti.crash_test --dati <file.csv> --uscita <cartella> [--k 1 3]

STESSO CODICE, NON UNA COPIA. Il calcolo e' quello dell'analisi firmata, importato da src/ e non riscritto:
  - inclusione, campione indice (D4), secondo campione, pannello comune: src/descriptive.stage_inclusion
    (src/endpoint.canonicalize, build_inclusion);
  - rumore (D11 o D2), endpoint (sezione 5), Wilson e bootstrap per paziente, discordanza per farmaco con
    Benjamini-Hochberg, Spearman, coppie ordinate: src/descriptive.stage_outcomes;
  - un intervento per paziente (v0.3.3): src/prepara_s5.scegli_interventi;
  - sensibilita' per libreria (D15): src/esegui_analisi_reale.inclusione_per_libreria;
  - politiche a budget fisso (ESPLORATIVE): src/previsione_esplorativa (costruisci_dati, politiche,
    estrazioni_casuali, chiave_spareggio, metriche) e src/power_simulation.budget_size.
Questo modulo fa solo tre cose sue: legge e valida il formato aperto, orienta il punteggio (verso), scrive il Rapporto.

NIENTE PORTA SUL RETRO. Se il file deriva dai dati veri di Kryeziu et al. 2026 (impronta uguale a Data S1/S4/S5 o
mmc8; .meta.json accanto che li cita o che dichiara dati non sintetici; oppure nome senza SINTETICO con le colonne o i
farmaci di Data S5), si applica lo stesso controllo della firma dell'analisi principale
(src/descriptive.check_prereg_signed) PRIMA di leggere i punteggi: senza tag il comando si ferma. Nessun flag lo salta.

Dati SINTETICI: nome con SINTETICO e colonna origine = SINTETICO in ogni riga (src/descriptive.classify_origin); le
uscite portano SINTETICO nel nome e in ogni riga.
"""
from __future__ import annotations

import argparse
import json
import math
import re
import shlex
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from src import descriptive as ds
from src import endpoint as ep
from src import esegui_analisi_reale as ear
from src import metrics
from src import power_simulation as pws
from src import prepara_s5 as ps
from src import previsione_esplorativa as pe
from src.data_audit import interpreta_sample_id
from src.endpoint import NA, NC
from src.ingest import ORIGIN_COLUMN, SYNTHETIC_MARKER, SchemaError, _clean_text, _read_text_table
from src.provenance import REPO_ROOT, SYNTHETIC_TAG, git_state, nome_ingresso, save_result, sha256_file
from strumenti import crash_test_rapporto as crp

# --------------------------------------------------------------------------- formato aperto
OBBLIGATORIE = ("paziente", "lesione", "campione", "farmaco", "punteggio", "verso")
FACOLTATIVE = ("intervento", "libreria")
AMMESSE = OBBLIGATORIE + FACOLTATIVE + (ORIGIN_COLUMN,)
PIU_ALTO, PIU_BASSO = "piu_alto_piu_sensibile", "piu_basso_piu_sensibile"
VERSI = (PIU_ALTO, PIU_BASSO)
SEP_LIBRERIE = ";"

BASE = "crash_test"
MARCATURA_POLITICHE = "ESPLORATIVA: curva delle politiche a budget fisso, non e' una regola da usare in laboratorio"
MOTIVO_LIBRERIA_NON_ESEGUITA = "colonna libreria assente o vuota"
MOTIVO_TROPPE_LIBRERIE = "piu' di due librerie: la sensibilita' D15 e' definita per due librerie"
POLITICHE = (pe.P_NESSUNO, pe.P_TUTTI, pe.P_CASUALE, pe.P_MARGINE)
QUOTA_PANNELLO = 0.8  # oltre l'80% del pannello primario o degli identificativi nella convenzione di Data S5
FONTI_IMPRONTE = ("docs/PREREGISTRATION.md", "evidence/replica_sessione/LEGGIMI.md")
IMPRONTE_DERIVATE = "strumenti/crash_test_browser/impronte_kryeziu.json"   # solo le impronte, senza il resto dei documenti


class FormatoError(ValueError):
    """Il file non rispetta il formato aperto (docs/CRASH_TEST.md)."""


@dataclass
class DatiAperti:
    tabella: pd.DataFrame  # nomi logici: patient, lesion, sample_id, drug, dss (come src/ingest.ingest_samples)
    verso: str
    librerie: dict[str, set[str]] | None  # campione -> librerie; None senza colonna libreria
    interventi: dict = field(default_factory=dict)  # paziente -> (intervento scelto, idoneo); vuoto senza colonna
    campioni_altri_interventi: int = 0
    righe: int = 0


# --------------------------------------------------------------------------- lettura e validazione rigida
def _errore(percorso, testo: str) -> FormatoError:
    return FormatoError(f"STOP: {Path(percorso).name}: {testo} (formato in docs/CRASH_TEST.md)")


def _righe(mask: pd.Series) -> str:
    righe = [str(i + 2) for i in np.flatnonzero(mask.to_numpy())[:5]]
    return ", ".join(righe) + (" ..." if int(mask.sum()) > 5 else "")


def leggi_formato_aperto(percorso: str | Path) -> DatiAperti:
    """Legge il CSV lungo e lo valida. Qualunque deviazione dal formato ferma il comando con il numero di riga."""
    p = Path(percorso)
    if p.suffix.lower() != ".csv":
        raise _errore(p, f"serve un file .csv (trovato '{p.suffix}')")
    try:
        raw = _read_text_table(p)
    except SchemaError as exc:
        raise _errore(p, str(exc)) from exc
    colonne = [str(c).strip() for c in raw.columns]
    raw.columns = colonne
    mancano = [c for c in OBBLIGATORIE if c not in colonne]
    if mancano:
        raise _errore(p, f"colonne obbligatorie mancanti: {mancano}. Colonne presenti: {colonne}")
    estranee = [c for c in colonne if c not in AMMESSE]
    if estranee:
        raise _errore(p, f"colonne non previste dal formato: {estranee}. Ammesse: {list(AMMESSE)}")
    if len(set(colonne)) != len(colonne):
        raise _errore(p, "colonne ripetute")
    if raw.empty:
        raise _errore(p, "il file non ha righe di dati")
    t = {c: pd.Series(_clean_text(raw[c]), dtype=object) for c in colonne}
    for c in ("paziente", "campione", "farmaco", "verso") + (("intervento",) if "intervento" in t else ()):
        vuote = t[c].isna()
        if vuote.any():
            raise _errore(p, f"'{c}' vuoto alle righe {_righe(vuote)}")
    versi = sorted(set(t["verso"]))
    if len(versi) != 1 or versi[0] not in VERSI:
        raise _errore(p, f"'verso' deve valere in tutte le righe {PIU_ALTO} oppure {PIU_BASSO}; trovato {versi}")
    verso = versi[0]
    lesione_vuota = t["lesione"].isna()
    if lesione_vuota.any() and not lesione_vuota.all():
        raise _errore(p, f"'lesione' vuota solo in alcune righe ({_righe(lesione_vuota)}): o tutte piene (lesione "
                         "verificata) o tutte vuote (lesione NON VERIFICATA)")
    punteggi = []
    for i, v in enumerate(t["punteggio"]):
        if v is None:
            punteggi.append(float("nan"))  # misura assente
            continue
        try:
            x = float(v)
        except ValueError:
            raise _errore(p, f"'punteggio' non numerico alla riga {i + 2}: '{v}' (separatore decimale: il punto)") from None
        if not math.isfinite(x):
            raise _errore(p, f"'punteggio' non finito alla riga {i + 2}: '{v}'; una misura mancante va lasciata vuota")
        punteggi.append(x)
    punteggi = np.array(punteggi, dtype=float)
    if verso == PIU_ALTO and np.nanmin(np.r_[punteggi, np.inf]) < 0:
        neg = pd.Series(punteggi < 0)
        raise _errore(p, f"punteggio negativo alle righe {_righe(neg)} con verso {PIU_ALTO}: come per il DSS, 0 vuol "
                         "dire nessuna attivita' e i valori negativi non si troncano. Usa una scala >= 0 oppure "
                         f"{PIU_BASSO}")
    # un campione appartiene a un solo paziente, una sola lesione, un solo intervento (D13: nessuna congettura)
    for c in ("paziente", "lesione") + (("intervento",) if "intervento" in t else ()):
        n = pd.DataFrame({"campione": t["campione"], c: t[c].fillna("")}).groupby("campione")[c].nunique()
        if (n > 1).any():
            raise _errore(p, f"campioni con piu' di un valore di '{c}': {sorted(n[n > 1].index)[:5]}")
    dup = pd.DataFrame({"c": t["campione"], "f": t["farmaco"]}).duplicated(keep=False)
    if dup.any():
        raise _errore(p, f"la coppia (campione, farmaco) si ripete alle righe {_righe(dup)}: nessuna media tra righe")
    if not np.isfinite(punteggi).any():
        raise _errore(p, "nessun punteggio presente")
    # verso: lo stesso ordine dei farmaci e le stesse differenze, su una scala dove piu' alto = piu' sensibile
    dss = punteggi if verso == PIU_ALTO else float(np.nanmax(punteggi)) - punteggi
    tab = pd.DataFrame({"patient": t["paziente"], "lesion": t["lesione"], "sample_id": t["campione"],
                        "drug": t["farmaco"], "dss": dss})
    dati = DatiAperti(tab, verso, None, righe=len(tab))
    if "libreria" in t and t["libreria"].notna().any():
        dati.librerie = {}
        for s, v in zip(t["campione"], t["libreria"]):
            libs = {x.strip() for x in (v or "").split(SEP_LIBRERIE) if x.strip()}
            dati.librerie.setdefault(s, set()).update(libs)
    if "intervento" in t:
        _scegli_intervento(dati, t["intervento"])
    return dati


def _scegli_intervento(dati: DatiAperti, intervento: pd.Series) -> None:
    """Un intervento per paziente (v0.3.3) con src/prepara_s5.scegli_interventi; gli altri campioni escono."""
    tab = dati.tabella.assign(_int=intervento.to_numpy())
    verificata = tab["lesion"].notna().any()
    campioni = []
    for sid, g in tab.groupby("sample_id", sort=True):
        piene = g[g["dss"].notna()]
        campioni.append(ps.Campione(riga=0, sample_id=str(sid), librerie="",
                                    parti={"paziente": g["patient"].iloc[0], "intervento": g["_int"].iloc[0],
                                           "lesione": g["lesion"].iloc[0]},
                                    dss={str(d): float(v) for d, v in zip(piene["drug"], piene["dss"])}))
    scelti = ps.scegli_interventi(campioni, set(tab["drug"]), verificata)
    tieni = [scelti[pz][0] == it for pz, it in zip(tab["patient"], tab["_int"])]
    dati.interventi = scelti
    dati.campioni_altri_interventi = int(tab.loc[~np.array(tieni), "sample_id"].nunique())
    dati.tabella = tab[tieni].drop(columns="_int").reset_index(drop=True)


# --------------------------------------------------------------------------- niente porta sul retro
def impronte_dai_documenti(repo_root: str | Path = REPO_ROOT) -> set[str]:
    """Impronte SHA256 dei file veri, lette dai documenti del repository (nessuna impronta scritta nel codice)."""
    out: set[str] = set()
    for rel in FONTI_IMPRONTE:
        f = Path(repo_root) / rel
        if f.is_file():
            out |= set(re.findall(r"`([0-9a-f]{64})`", f.read_text(encoding="utf-8")))
    return out


def impronte_kryeziu(repo_root: str | Path = REPO_ROOT) -> set[str]:
    """Le impronte dei documenti piu' quelle della copia derivata IMPRONTE_DERIVATE (scritta da
    strumenti/crash_test_browser/prepara.py dagli stessi documenti): nel browser i documenti non ci sono, la copia si'."""
    out = impronte_dai_documenti(repo_root)
    f = Path(repo_root) / IMPRONTE_DERIVATE
    if f.is_file():
        out |= set(json.loads(f.read_text(encoding="utf-8"))["impronte"])
    return out


def nomi_colonne_s5() -> set[str]:
    schema = ps.carica_schema_s5()
    return set(ps.intestazioni_attese(schema, sintetico=False)) | set(schema.combinazioni)


def motivo_kryeziu(percorso: str | Path, repo_root: str | Path = REPO_ROOT) -> str | None:
    """Perche' il file va trattato come derivato dai dati veri di Kryeziu, oppure None. Non legge i punteggi."""
    p = Path(percorso)
    impronte = impronte_kryeziu(repo_root)
    if sha256_file(p) in impronte:
        return "impronta SHA256 uguale a un file di Kryeziu et al. 2026"
    meta = p.with_name(p.stem + ".meta.json")
    if meta.is_file():
        try:
            info = json.loads(meta.read_text(encoding="utf-8"))
        except ValueError:
            info = {}
        if set((info.get("input_sha256") or {}).values()) & impronte:
            return f"{meta.name}: deriva da un file di Kryeziu et al. 2026"
        if info.get("synthetic") is False:
            return f"{meta.name}: dichiara dati non sintetici prodotti da questa pipeline"
    if ds.is_synthetic_name(p):
        return None
    intest = set(pd.read_csv(p, nrows=0).columns.str.strip()) if p.suffix.lower() == ".csv" else set()
    s5 = nomi_colonne_s5()
    if len(intest & s5) >= 2 or {"run_id_lib1", "run_id_lib2", "run_id_harmonize"} & intest:
        return "nome senza SINTETICO con le colonne di Data S5"
    if set(ps.COLONNE_TABELLA) <= intest:
        return "nome senza SINTETICO con le colonne delle tabelle preparate da Data S5"
    if {"farmaco", "campione"} <= intest:  # derivati gia' convertiti: le voci e gli identificativi propri di Data S5
        tab = pd.read_csv(p, usecols=["farmaco", "campione"], dtype=str, keep_default_na=False)
        farmaci = {f.strip() for f in tab["farmaco"] if f.strip()}
        schema = ps.carica_schema_s5()
        proprie = s5 - set(schema.primari) - {schema.sample_id, *schema.run_id.values()}
        if farmaci & proprie:
            return "nome senza SINTETICO con voci proprie di Data S5 (colonne _lib1, _lib2 o combinazioni)"
        if len(set(schema.primari) & farmaci) >= QUOTA_PANNELLO * len(schema.primari):
            return "nome senza SINTETICO con il pannello primario di Data S5"
        ids = {c.strip() for c in tab["campione"] if c.strip()}
        if ids and sum(interpreta_sample_id(c) is not None for c in ids) >= QUOTA_PANNELLO * len(ids):
            return "nome senza SINTETICO con gli identificativi dei campioni di Data S5"
    return None


def origine(percorso: str | Path, repo_root: str | Path = REPO_ROOT) -> str:
    """SINTETICO, KRYEZIU (dopo il controllo della firma) oppure LABORATORIO. Prima di qualsiasi punteggio."""
    motivo = motivo_kryeziu(percorso, repo_root)
    if motivo is not None:
        try:
            ds.check_prereg_signed(repo_root)
        except ds.PreregError as exc:
            raise ds.PreregError(f"{exc} Motivo del controllo: {motivo}.") from None
        return "KRYEZIU"
    return SYNTHETIC_TAG if ds.classify_origin(percorso) else "LABORATORIO"


# --------------------------------------------------------------------------- calcolo (funzioni firmate)
def sensibilita_libreria(inc: ep.Inclusion, librerie: dict[str, set[str]] | None) -> tuple[ep.Inclusion | None, str]:
    """D15 con src/esegui_analisi_reale.inclusione_per_libreria: le (al massimo due) librerie del file diventano
    lib1/lib2 in ordine di nome, e ogni campione prende la sua etichetta (lib1, lib2, entrambe, nessuna)."""
    if not librerie or not any(librerie.values()):
        return None, MOTIVO_LIBRERIA_NON_ESEGUITA
    nomi = sorted(set().union(*librerie.values()))
    if len(nomi) > 2:
        return None, MOTIVO_TROPPE_LIBRERIE
    mappa = dict(zip(nomi, (ps.LIB1, ps.LIB2)))
    etichette = {s: ps._librerie(ps.LIB1 in {mappa[x] for x in v}, ps.LIB2 in {mappa[x] for x in v})
                 for s, v in librerie.items()}
    return ear.inclusione_per_libreria(inc, etichette), "; ".join(f"{a} = {b}" for a, b in mappa.items())


def curva_politiche(inc: ep.Inclusion, pazienti: pd.DataFrame, ks, dataset: str) -> pd.DataFrame:
    """Politiche a budget fisso (sezione 7), ESPLORATIVE: nessuno, tutti, casuale, regola del margine (P1 piu' basso).
    Stessi semi, budget e spareggi di src/previsione_esplorativa."""
    sigma = ep.estimate_sigma(inc.canon, inc)
    righe = []
    for k in ks:
        d = pe.costruisci_dati(inc, sigma, pazienti, k)
        base = dict(dataset=dataset, analisi_preregistrata=MARCATURA_POLITICHE, k=k)
        if d.n < pe.MIN_PAZIENTI:
            righe.append(dict(base, budget_frazione="", budget="", politica="", misura="non_eseguita", n=d.n,
                              denominatore="", valore=NC, ic_lo="", ic_hi="", metodo="",
                              nota=f"meno di {pe.MIN_PAZIENTI} pazienti valutabili a k = {k}"))
            continue
        tie = pe.chiave_spareggio(k, d.n)
        zeri = np.zeros(d.n)
        varia_p1, motivo_p1 = pe.variabilita(d.x[:, 0])   # stessa guardia di src/previsione_esplorativa (docs/DEVIATIONS.md)
        for frac in pe.BUDGETS:
            b = pws.budget_size(d.n, frac)
            fl = pe.politiche(d, zeri, zeri, b, tie)
            rnd = pe.estrazioni_casuali(d.n, b, pe.N_CASUALE,
                                        np.random.SeedSequence([pe.SEED, k, pe.T_CASUALE, int(round(frac * 100))]))
            c_rnd = pe._conteggi_b(np.broadcast_to(d.y, rnd.shape), rnd)
            m_rnd = pe.metriche_vettore(np.broadcast_to(d.y, rnd.shape), rnd)
            for pol in POLITICHE:
                banda = ("", "")
                if pol == pe.P_MARGINE and not varia_p1:
                    righe.append(dict(base, budget_frazione=frac, budget=b, politica=pol, misura="non_calcolabile", n="",
                                      denominatore="", valore=NC, ic_lo="", ic_hi="", metodo="",
                                      nota=f"{pe.NC_PREDITTORI}: P1_margine, {motivo_p1}"))
                    continue
                if pol == pe.P_CASUALE:
                    cnt = {c: float(c_rnd[c].mean()) for c in ("tp", "fn")}
                    resa = float(np.nanmean(m_rnd["resa"]))
                    banda = pe.percentili(c_rnd["tp"])  # banda 2,5-97,5 degli eventi trovati a caso
                    metodo, budget = f"media e percentili 2,5-97,5 di {pe.N_CASUALE} estrazioni casuali", b
                else:
                    f = fl[pol]
                    cnt = metrics.confusion_counts(d.y, f)
                    resa = pe.metriche_vettore(d.y, f)["resa"]
                    metodo, budget = "", int(f.sum())
                for misura, n_, valore in (("eventi_trovati", cnt["tp"], ""), ("eventi_persi", cnt["fn"], ""),
                                           ("resa", "", pe._num(float(resa)))):
                    righe.append(dict(base, budget_frazione=frac, budget=budget, politica=pol, misura=misura, n=n_,
                                      denominatore=d.n_eventi if misura != "resa" else budget, valore=valore,
                                      ic_lo=banda[0] if misura == "eventi_trovati" else "",
                                      ic_hi=banda[1] if misura == "eventi_trovati" else "", metodo=metodo, nota="primario (D3)" if math.isclose(frac, pe.BUDGET_PRIMARIO)
                                      else "secondario (D3)"))
    return pd.DataFrame(righe, columns=["dataset", "analisi_preregistrata", "k", "budget_frazione", "budget", "politica",
                                        "misura", "n", "denominatore", "valore", "ic_lo", "ic_hi", "metodo", "nota"]).astype(object)


@dataclass
class Rapporto:
    dataset: str
    dati: DatiAperti
    inclusione: ep.Inclusion
    esiti: dict[str, pd.DataFrame]
    libreria: dict[str, pd.DataFrame] | None
    nota_libreria: str
    politiche: pd.DataFrame
    ks: tuple[int, ...]


def calcola(dati: DatiAperti, dataset: str, ks=ep.KS) -> Rapporto:
    inc = ds.stage_inclusion(dati.tabella)  # inclusione PRIMA di qualsiasi esito, sui soli punteggi presenti
    esiti = ds.stage_outcomes(inc, dataset=dataset)
    inc_lib, nota = sensibilita_libreria(inc, dati.librerie)
    lib = ds.stage_outcomes(inc_lib, dataset=dataset) if inc_lib is not None else None
    if lib is not None:
        lib["inclusione"] = inc_lib.table
    pol = curva_politiche(inc, esiti["pazienti"], ks, dataset)
    return Rapporto(dataset, dati, inc, esiti, lib, nota, pol, tuple(ks))


# --------------------------------------------------------------------------- dati descrittivi del file
def tabella_dati(r: Rapporto, ingresso: str | Path) -> pd.DataFrame:
    """Cio' che il Rapporto dice del file e delle scelte (chiave, valore): nessun punteggio."""
    righe = [("dataset", r.dataset), ("file", Path(ingresso).name), ("righe", r.dati.righe), ("verso", r.dati.verso),
             ("colonna_intervento", "si" if r.dati.interventi else "no"),
             ("campioni_altri_interventi", r.dati.campioni_altri_interventi),
             ("libreria", "eseguita" if r.libreria is not None else "non eseguita"), ("nota_libreria", r.nota_libreria),
             ("k", ";".join(str(k) for k in r.ks))]
    if r.libreria is not None:
        righe.append(("esclusi_per_libreria", int((r.libreria["inclusione"]["motivo"] == ear.R_LIBRERIA).sum())))
    return pd.DataFrame(righe, columns=["chiave", "valore"]).astype(object)


# --------------------------------------------------------------------------- riga di comando
def salva(r: Rapporto, uscita: str | Path, *, ingresso: str | Path, command: str, git_info: dict,
          lingua: str = "it") -> dict[str, Path]:
    sint = r.dataset == SYNTHETIC_TAG
    nome = f"{SYNTHETIC_TAG}_{BASE}" if sint else BASE
    common = dict(seed=ds.SEED, synthetic=sint, input_files=[str(ingresso)], command=command, results_dir=uscita,
                  git_info=git_info)
    out = {"inclusione": save_result(r.inclusione.table, f"{nome}_inclusione", **common)}
    for chiave in ("riepilogo", "pazienti", "farmaci", "coppie"):
        out[chiave] = save_result(r.esiti[chiave], f"{nome}_{chiave}", **common)
    if r.libreria is not None:
        riep = r.libreria["riepilogo"].copy()
        riep.insert(0, ear.COLONNA_ETICHETTA, ear.ETICHETTE[ear.SEC_LIBRERIA])
        out["libreria"] = save_result(riep, f"{nome}_libreria", **common)
    out["politiche"] = save_result(r.politiche, f"{nome}_politiche", **common)
    out["dati"] = save_result(tabella_dati(r, ingresso), f"{nome}_dati", **common)
    pagina = Path(uscita) / f"{nome}_rapporto{'' if lingua == 'it' else '_' + lingua}.html"
    pagina.write_text(crp.pagina(uscita, nome, lingua), encoding="utf-8")  # SOLO dai CSV appena scritti, con i .meta.json
    meta = {"result_file": pagina.name, **git_info, "timestamp_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "seed": ds.SEED, "input_sha256": {nome_ingresso(ingresso): sha256_file(ingresso)}, "command": command,
            "synthetic": sint, "lingua": lingua}
    pagina.with_name(pagina.stem + ".meta.json").write_text(json.dumps(meta, indent=2, ensure_ascii=False), encoding="utf-8")
    out["rapporto"] = pagina
    return out


def main(argv: list[str] | None = None, repo_root: str | Path = REPO_ROOT) -> int:
    ap = argparse.ArgumentParser(description="Crash test aperto: Rapporto di rappresentativita' (docs/CRASH_TEST.md)")
    ap.add_argument("--dati", required=True, help="CSV lungo nel formato aperto")
    ap.add_argument("--uscita", required=True, help="cartella del Rapporto")
    ap.add_argument("--k", type=int, nargs="+", default=list(ep.KS), choices=list(ep.KS),
                    help="k da riportare (1 primario, 3 secondario)")
    ap.add_argument("--lingua", choices=crp.LINGUE, default="it",
                    help="lingua del Rapporto: it (predefinita) oppure en; i CSV sono gli stessi")
    a = ap.parse_args(argv)
    command = shlex.join(["python", "-m", "strumenti.crash_test", *(argv if argv is not None else sys.argv[1:])])
    git_info = git_state()
    try:
        if not Path(a.dati).is_file():
            raise _errore(a.dati, "file non trovato")
        dataset = origine(a.dati, repo_root)  # firma e origine PRIMA di leggere i punteggi
        dati = leggi_formato_aperto(a.dati)
        r = calcola(dati, dataset, ks=tuple(sorted(set(a.k))))
    except (FormatoError, ds.PreregError, ds.OriginError, SchemaError, ep.EndpointError) as exc:
        print(str(exc), file=sys.stderr)
        return 2
    if dataset == SYNTHETIC_TAG:
        print(f"*** DATI SINTETICI ({SYNTHETIC_TAG}): nessun dato di risposta reale e' usato ***")
    out = salva(r, a.uscita, ingresso=a.dati, command=command, git_info=git_info, lingua=a.lingua)
    print(f"Rapporto: {out['rapporto']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
