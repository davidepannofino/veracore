"""Previsione ESPLORATIVA del cambio di priorita' (preregistrazione, sezioni 2, 6-12; D3, D5, D9, D14, D15).

GO RIDOTTO (sezione 11): la simulazione SINTETICA non raggiunge la potenza di 0,80, quindi la previsione e'
ESPLORATIVA e resta un'ipotesi. Ogni riga e ogni .meta.json di questo modulo lo dichiarano (colonna
`analisi_preregistrata`, campo `marcatura`). Non sostituisce mai il risultato primario.

Cosa fa, alla lettera della preregistrazione
  - Endpoint (sezione 5): quello dell'analisi primaria, ricalcolato con le funzioni firmate (src/descriptive.py,
    src/endpoint.py) e confrontato paziente per paziente con <primaria>/analisi_primaria_pazienti.csv. Pazienti =
    i valutabili a k (k = 1 primario, k = 3 secondario, D1).
  - Predittori (sezione 6), SOLO dal campione indice sul pannello comune: P1 margine (DSS di F1 meno DSS in
    posizione k+1, diviso sigma_rep; con D2 la differenza grezza), P2 deviazione standard, P3 DSS di F1
    (src/power_simulation.compute_predictors). P4-P5 (D5) e la mutazione (D14) solo se dichiarati in
    config/previsione_esplorativa.yaml, committato PRIMA dell'esecuzione; altrimenti "non eseguito", dichiarato.
  - Politiche a pari budget B (sezione 7): nessuno, tutti, casuale (10.000 estrazioni), regola del livello (P3 piu'
    alto), regola del margine (P1 piu' basso, esplorativa), modello (logistica L2). B primario 30% (D3); 10%, 20%,
    50% secondari. Spareggio dei valori uguali: un numero casuale per paziente da seme fisso.
  - Validazione (sezione 8): 5 fold PER PAZIENTE stratificati per evento, ripetuti 20 volte con seed fissi; punteggio
    = predittore lineare senza intercetta, medio delle ripetizioni in cui il paziente e' nel test; lambda scelto
    con 5 fold annidati sul solo training; standardizzazione e imputazione sul solo training
    (src/power_simulation.cv_fold_weights, cv_scores_given_folds).
  - Metriche (sezione 9) con TP, FP, FN, TN assoluti; denominatore zero = "non calcolabile"; AUC solo con almeno
    10 eventi; intervalli bootstrap per paziente con 2.000 ricampionamenti (stesso schema di src/metrics.py).
  - Test (sezione 10): permutazione delle etichette con l'INTERA pipeline (fold, lambda, fit, selezione) 1.000 volte;
    p = (1 + permutazioni con resa >= osservata) / 1001, unilaterale, alfa 0,05; differenza di resa contro il
    casuale con intervallo.
  - Controlli negativi (sezione 12): media delle etichette permutate e modello con predittori di rumore al posto di
    P1-P3, entrambi da confrontare con il livello del casuale.

Dati veri: il comando gira solo con la preregistrazione firmata (src/descriptive.check_prereg_signed) e solo se i
risultati dell'analisi primaria esistono gia', calcolati sulla stessa tabella (impronta SHA256 nel .meta.json).
Se l'analisi primaria e' stata fatta con la regola DSS negativi v0.3.4, la stessa regola si applica qui (con lo
stesso controllo di docs/DEVIATIONS.md). Nessun flag scavalca i controlli. A schermo solo conteggi e nomi di file.

Uso (dopo l'analisi primaria; istruzioni in docs/PREVISIONE_ESPLORATIVA.md):
    python -m src.previsione_esplorativa --data results/s5_tabella_primaria.csv --config config/schema.yaml \
        --primaria results --out results
Prova SINTETICA (set realistico di results/, da strumenti/genera_risultati_sintetici.py):
    python -m src.previsione_esplorativa --data results/SINTETICO_s5_tabella_primaria.csv \
        --config config/schema.yaml --primaria results --out results
"""
from __future__ import annotations

import argparse
import json
import math
import shlex
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd
import yaml

from src import descriptive as ds
from src import endpoint as ep
from src import metrics
from src import power_simulation as ps
from src.endpoint import NA, NC
from src.ingest import SchemaError, ingest_samples
from src.provenance import REPO_ROOT, SYNTHETIC_TAG, git_state, save_result, sha256_file

# --------------------------------------------------------------------------- marcatura (sezione 11)
MARCATURA = "ESPLORATIVA - GO RIDOTTO (preregistrazione, sezione 11): la previsione resta un'ipotesi"
COLONNA_MARCATURA = "analisi_preregistrata"
CAMPO_META = "marcatura"
BASE_NAME = "previsione_esplorativa"

# --------------------------------------------------------------------------- parametri di protocollo
BUDGET_PRIMARIO = 0.30  # D3
BUDGETS = (0.10, 0.20, 0.30, 0.50)  # D3: 30% primario, gli altri secondari
N_CASUALE = 10_000  # sezione 7
N_FOLDS, N_REPEATS, INNER_FOLDS = 5, 20, 5  # sezione 8
LAMBDA_GRID = (0.01, 0.1, 1.0, 10.0, 100.0)  # penalita' L2 (lambda = 1/C), la stessa griglia della simulazione
N_PERM = 1000  # sezione 10
ALPHA = 0.05  # sezione 10, unilaterale
N_BOOT = 2000  # sezione 9
MIN_EVENTI_AUC = 10  # sezione 9
MIN_PAZIENTI = 10  # sotto questo numero di valutabili la previsione non si esegue (come il criterio (c) del successo)
PT_GRID = (0.10, 0.20, 0.30, 0.40, 0.50)  # sezione 9: soglie pt del beneficio netto, dichiarate qui prima dei dati
N_RUMORE = 3  # sezione 12: rumore al posto di P1-P3
# Guardia sulla variabilita' dei predittori (correzione di implementazione, docs/DEVIATIONS.md, 20/11/2026): un predittore
# serve solo se distingue i pazienti. Senza variabilita' si esclude dal modello; se nessuno varia, modello, test di
# permutazione e controlli negativi sono "non calcolabile", mai un p-value. Lo stesso per una regola semplice.
ARROTONDA_DECIMALI = 9   # due valori uguali fino alla nona cifra decimale contano come uguali
SOGLIA_MODA = 0.95       # se un solo valore copre almeno il 95% dei pazienti (meno di uno su venti differisce), non varia abbastanza
NC_PREDITTORI = "non calcolabile: predittori senza variabilita'"
MAX_PREDITTORI = 5  # sezione 6
MAX_METADATI = 2  # D5
SOGLIA_COMPLETEZZA = 0.80  # D5, D14
SEED = 20261120  # seme fisso; ogni uso ha il suo seme derivato SeedSequence([SEED, k, etichetta])
CV_SEED = 20261121  # seme dei fold: lo stesso per l'osservato e per ogni permutazione
T_CASUALE, T_PERM, T_BOOT, T_SPAREGGIO, T_RUMORE = 1, 2, 3, 4, 5

DICHIARAZIONI = REPO_ROOT / "config" / "previsione_esplorativa.yaml"
DIREZIONI = {"piu_rischio": 1.0, "meno_rischio": -1.0}

P_LIVELLO, P_MARGINE, P_MODELLO, P_RUMORE = "livello", "margine", "modello", "controllo_rumore"
P_NESSUNO, P_TUTTI, P_CASUALE, P_MUTAZIONE = "nessuno", "tutti", "casuale", "mutazione"
POLITICHE_TESTATE = (P_MODELLO, P_LIVELLO, P_MARGINE, P_RUMORE, P_MUTAZIONE)
NOMI_P = ("P1_margine", "P2_dispersione", "P3_livello")

COLONNE_RIEPILOGO = ["dataset", COLONNA_MARCATURA, "modalita_lesione", "rumore", "analisi", "k", "budget_frazione",
                     "budget", "politica", "misura", "n", "denominatore", "valore", "ic_lo", "ic_hi", "metodo", "nota"]
METODO_BOOT = f"bootstrap per paziente ({N_BOOT} ricampionamenti)"


class PrevisioneError(RuntimeError):
    """Mancano le condizioni per eseguire la previsione (analisi primaria assente o diversa)."""


# --------------------------------------------------------------------------- dichiarazioni D5 e D14
@dataclass
class Dichiarazioni:
    metadati: list[str] = field(default_factory=list)  # colonne di Data S1 (D5)
    colonna_gene: str | None = None
    gene: str | None = None
    direzione: str | None = None
    committate: bool = False
    motivo: str = ""

    @property
    def d14(self) -> bool:
        return bool(self.colonna_gene and self.gene and self.direzione)


def _git(repo: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=repo, capture_output=True, text=True)


def file_committato(path: str | Path, repo_root: str | Path = REPO_ROOT) -> tuple[bool, str]:
    """Vero solo se il file e' nel repository, identico alla versione di HEAD e senza modifiche in sospeso."""
    repo, p = Path(repo_root).resolve(), Path(path).resolve()
    try:
        rel = p.relative_to(repo).as_posix()
    except ValueError:
        return False, f"{p.name} e' fuori dal repository"
    head = _git(repo, "show", f"HEAD:{rel}")
    if head.returncode != 0:
        return False, f"{rel} non e' committato"
    if not p.is_file() or head.stdout != p.read_text(encoding="utf-8"):
        return False, f"{rel} e' diverso dalla versione committata"
    stato = _git(repo, "status", "--porcelain", "--", rel)
    if stato.returncode != 0 or stato.stdout.strip():
        return False, f"{rel} ha modifiche non committate"
    return True, ""


def leggi_dichiarazioni(path: str | Path = DICHIARAZIONI, repo_root: str | Path = REPO_ROOT) -> Dichiarazioni:
    """D5 e D14 dal file di dichiarazioni. Valgono solo se il file e' committato (prima dell'esecuzione)."""
    p = Path(path)
    if not p.is_file():
        return Dichiarazioni(motivo=f"file di dichiarazioni assente: {p.name}")
    cfg = yaml.safe_load(p.read_text(encoding="utf-8")) or {}
    meta = [str(v["colonna"]) for v in (cfg.get("d5_metadati") or [])]
    if len(meta) > MAX_METADATI:
        raise PrevisioneError(f"STOP: D5 ammette al massimo {MAX_METADATI} metadati, dichiarati {len(meta)}")
    if len(set(meta)) != len(meta):
        raise PrevisioneError("STOP: D5: colonne ripetute nelle dichiarazioni")
    m = cfg.get("d14_mutazione") or {}
    d = Dichiarazioni(meta, m.get("colonna_gene"), m.get("gene"), m.get("direzione"))
    if d.direzione is not None and d.direzione not in DIREZIONI:
        raise PrevisioneError(f"STOP: D14: direzione {d.direzione!r} non valida, ammesse {sorted(DIREZIONI)}")
    if 3 + len(meta) + int(d.d14) > MAX_PREDITTORI:
        raise PrevisioneError(f"STOP: al massimo {MAX_PREDITTORI} predittori (sezione 6): P1-P3, D5 e D14 insieme sono troppi")
    d.committate, d.motivo = file_committato(p, repo_root)
    return d


def leggi_s1_colonne(path: str | Path, colonne: list[str], schema_path: str | Path) -> pd.DataFrame | None:
    """Da Data S1 si leggono SOLO sample_id e le colonne dichiarate (D5, D14). None se una colonna manca."""
    sch = yaml.safe_load(Path(schema_path).read_text(encoding="utf-8")) or {}
    s1 = sch.get("s1") or {}
    sid = s1.get("sample_id", "sample_id")
    p = Path(path)
    if p.suffix.lower() == ".csv":
        presenti = list(pd.read_csv(p, nrows=0).columns)
    else:
        presenti = list(pd.read_excel(p, sheet_name=s1.get("foglio", 0), nrows=0).columns)
    servono = [sid, *colonne]
    if any(c not in presenti for c in servono):
        return None
    if p.suffix.lower() == ".csv":
        raw = pd.read_csv(p, usecols=servono, dtype=str, keep_default_na=False)
    else:
        raw = pd.read_excel(p, sheet_name=s1.get("foglio", 0), usecols=servono, dtype=str, keep_default_na=False)
    raw = raw.apply(lambda col: col.str.strip())
    return raw.rename(columns={sid: "sample_id"})


def valore_metadato(s1: pd.DataFrame, colonna: str, campione: str) -> float:
    """Valore numerico del campione (uguale in tutte le sue righe di Data S1); NaN se assente o vuoto."""
    v = {x for x in s1.loc[s1["sample_id"] == campione, colonna] if x != ""}
    if not v:
        return float("nan")
    if len(v) > 1:
        raise PrevisioneError(f"STOP: D5: la colonna {colonna!r} ha valori diversi per lo stesso campione")
    try:
        return float(v.pop())
    except ValueError as exc:
        raise PrevisioneError(f"STOP: D5: la colonna {colonna!r} non e' numerica") from exc


def stato_mutazione(s1: pd.DataFrame, colonna_gene: str, gene: str, campione: str) -> float:
    righe = s1[s1["sample_id"] == campione]
    if righe.empty:
        return float("nan")
    return float((righe[colonna_gene] == gene).any())


# --------------------------------------------------------------------------- dati per un k
@dataclass
class DatiK:
    """Pazienti valutabili a k (una riga per paziente, in ordine di nome), evento e predittori del solo indice."""

    k: int
    pazienti: list[str]
    indici: list[str]
    y: np.ndarray
    x: np.ndarray  # P1, P2, P3 e gli eventuali P4-P5 (D5, D14)
    nomi: list[str]
    rumore: np.ndarray  # controllo negativo: rumore al posto di P1-P3
    mutazione: np.ndarray | None = None  # D14 orientata: valore alto = rischio alto
    stato_predittori: list[tuple[str, str]] = field(default_factory=list)

    @property
    def n(self) -> int:
        return len(self.pazienti)

    @property
    def n_eventi(self) -> int:
        return int(self.y.sum())


def predittori_indice(dss_indice: np.ndarray, k: int, sigma: ep.SigmaResult) -> np.ndarray:
    """P1-P3 (sezione 6) dal profilo dell'indice sul pannello comune, in ordine alfabetico dei farmaci.

    Riuso di src/power_simulation.compute_predictors; senza sigma_rep (D2) P1 e' la differenza grezza.
    """
    s = 1.0 if sigma.sigma_rep is None else sigma.sigma_rep
    return ps.compute_predictors(np.asarray(dss_indice, dtype=float)[None, :], k, s)[0]


def costruisci_dati(inc: ep.Inclusion, sigma: ep.SigmaResult, pazienti: pd.DataFrame, k: int,
                    dich: Dichiarazioni | None = None, s1: pd.DataFrame | None = None) -> DatiK:
    """Pazienti valutabili a k, evento e predittori. Il secondo campione entra SOLO nell'evento, mai nei predittori."""
    tab = pazienti[pazienti[f"stato_k{k}"] == ep.ST_OK].sort_values("patient", kind="stable")
    if tab["patient"].duplicated().any():
        raise PrevisioneError("STOP: un paziente compare piu' volte (sezione 12: nessuna riga duplicata)")
    nomi_paz = [str(p) for p in tab["patient"]]
    righe, indici = [], []
    for p in nomi_paz:
        d = inc.data[p]
        righe.append(predittori_indice([d.samples[d.index][f] for f in d.panel], k, sigma))
        indici.append(d.index)
    x = np.array(righe, dtype=float).reshape(len(nomi_paz), 3)
    y = tab[f"evento_k{k}"].astype(int).to_numpy()
    nomi = list(NOMI_P)
    stato = [(n, "eseguito") for n in NOMI_P]
    mut = None
    dich = dich or Dichiarazioni(motivo="nessuna dichiarazione")
    extra = []
    for col in dich.metadati:
        motivo = _motivo_non_eseguito(dich, s1, [col])
        if motivo is None:
            v = np.array([valore_metadato(s1, col, i) for i in indici])
            motivo = _completezza(v)
            if motivo is None:
                extra.append(v)
                nomi.append(f"P{len(nomi) + 1}_{col}")
                stato.append((nomi[-1], "eseguito (D5)"))
                continue
        stato.append((f"D5_{col}", f"non eseguito: {motivo}"))
    if not dich.metadati:
        stato.append(("P4-P5 (D5)", "non eseguito: nessun metadato di Data S1 dichiarato in un file committato"))
    if dich.d14:
        motivo = _motivo_non_eseguito(dich, s1, [dich.colonna_gene])
        if motivo is None:
            v = np.array([stato_mutazione(s1, dich.colonna_gene, dich.gene, i) for i in indici])
            motivo = _completezza(v)
            if motivo is None:
                orient = DIREZIONI[dich.direzione] * v
                extra.append(orient)
                mut = orient
                nomi.append(f"P{len(nomi) + 1}_mutazione_{dich.gene}")
                stato.append((nomi[-1], f"eseguito (D14, direzione {dich.direzione})"))
        if mut is None:
            stato.append(("D14", f"non eseguito: {motivo}"))
    else:
        stato.append(("D14", "non eseguito: nessuna direzione dichiarata in un file committato prima dell'esecuzione"))
    if extra:
        x = np.column_stack([x, *extra])
    rumore = np.random.default_rng(np.random.SeedSequence([SEED, k, T_RUMORE])).standard_normal((len(nomi_paz), N_RUMORE))
    return DatiK(k, nomi_paz, indici, y, x, nomi, rumore, mut, stato)


def _motivo_non_eseguito(dich: Dichiarazioni, s1: pd.DataFrame | None, colonne: list[str]) -> str | None:
    if not dich.committate:
        return f"dichiarazione non valida prima dell'esecuzione ({dich.motivo})"
    if s1 is None:
        return "Data S1 non fornito (--s1) oppure colonna dichiarata assente in Data S1"
    if any(c not in s1.columns for c in colonne):
        return "colonna dichiarata assente in Data S1"
    return None


def _completezza(v: np.ndarray) -> str | None:
    quota = float(np.mean(~np.isnan(v))) if v.size else 0.0
    if quota < SOGLIA_COMPLETEZZA:
        return f"disponibile per {int((~np.isnan(v)).sum())} pazienti valutabili su {v.size}, meno dell'80%"
    return None


# --------------------------------------------------------------------------- modello (sezione 8)
def imputa_training(x: np.ndarray, w: np.ndarray) -> np.ndarray:
    """Valori mancanti sostituiti con la media delle sole righe di training (w = 1). Colonna senza valori: 0."""
    x = np.asarray(x, dtype=float)
    if not np.isnan(x).any():
        return x
    tr = x[np.asarray(w) > 0]
    oss = ~np.isnan(tr)
    somma, quanti = np.where(oss, tr, 0.0).sum(axis=0), oss.sum(axis=0)
    mu = np.where(quanti > 0, somma / np.maximum(quanti, 1), 0.0)
    return np.where(np.isnan(x), mu[None, :], x)


def fold(y: np.ndarray) -> ps.CVFolds:
    """5 fold per paziente, stratificati per evento, 20 ripetizioni, 5 fold annidati sul training (seed fissi)."""
    return ps.cv_fold_weights(np.asarray(y), N_FOLDS, N_REPEATS, INNER_FOLDS, CV_SEED)


def _un_fold(folds: ps.CVFolds, c: int) -> ps.CVFolds:
    return ps.CVFolds(folds.outer_train[c:c + 1], folds.outer_test[c:c + 1], folds.inner_train[c:c + 1],
                      folds.inner_test[c:c + 1], 1)


def punteggi(x: np.ndarray, y: np.ndarray, folds: ps.CVFolds | None = None) -> np.ndarray:
    """Punteggio del modello per paziente (sezione 8): predittore lineare senza intercetta, medio sulle ripetizioni.

    Riuso di src/power_simulation.cv_scores_given_folds. Con valori mancanti: per ogni fold esterno l'imputazione
    usa la media del solo training di quel fold. Evento assente o in tutti: punteggi uguali (nessuna informazione).
    """
    y = np.asarray(y, dtype=float)
    if y.sum() in (0, len(y)):
        return np.zeros(len(y))
    folds = fold(y) if folds is None else folds
    x = np.asarray(x, dtype=float)
    if not np.isnan(x).any():
        return ps.cv_scores_given_folds(x, y, folds, LAMBDA_GRID)[0]
    out = np.zeros(len(y))
    for c in range(folds.outer_train.shape[0]):
        out += ps.cv_scores_given_folds(imputa_training(x, folds.outer_train[c]), y, _un_fold(folds, c), LAMBDA_GRID)[0]
    return out / folds.n_repeats


@dataclass
class DettaglioModello:
    punteggi: np.ndarray
    probabilita: np.ndarray  # fuori fold, con intercetta: solo per la calibrazione (Brier, pendenza)
    lambda_scelti: np.ndarray
    coef_std_medi: np.ndarray  # coefficienti sui predittori standardizzati, medi sui fold


def dettaglio_modello(x: np.ndarray, y: np.ndarray) -> DettaglioModello:
    """Punteggi (come `punteggi`) piu' probabilita' fuori fold per la calibrazione, rifacendo ogni fit esterno con il
    lambda scelto dai fold annidati. Standardizzazione e imputazione sul solo training di ogni fold."""
    y = np.asarray(y, dtype=float)
    n, p = np.asarray(x).shape
    if y.sum() in (0, n):
        return DettaglioModello(np.zeros(n), np.full(n, float(y.mean()) if n else np.nan), np.array([]), np.zeros(p))
    folds = fold(y)
    sc = punteggi(x, y, folds)
    prob = np.zeros(n)
    lams, coefs = [], []
    for c in range(folds.outer_train.shape[0]):
        w = folds.outer_train[c]
        xc = imputa_training(x, w)
        best = ps.cv_scores_given_folds(xc, y, _un_fold(folds, c), LAMBDA_GRID)[1][0]
        lam = sorted(LAMBDA_GRID)[best]
        _, sd, centered = ps._weighted_mean_sd(xc, w[None, :])
        xa = ps._with_intercept(centered / sd[:, None, :])
        beta = ps._newton_l2(xa, y, w[None, :], ps._penalty(lam, p))
        prob += ps._sigmoid(xa[0] @ beta[0]) * folds.outer_test[c]
        lams.append(lam)
        coefs.append(beta[0, 1:])
    return DettaglioModello(sc, prob / folds.n_repeats, np.array(lams), np.mean(coefs, axis=0))


# --------------------------------------------------------------------------- guardia sulla variabilita'
def variabilita(v: np.ndarray) -> tuple[bool, str]:
    """(varia, motivo). Non varia se: tutti i valori mancano; la varianza e' nulla; oppure un solo valore copre almeno
    SOGLIA_MODA dei pazienti (arrotondando a ARROTONDA_DECIMALI cifre: le differenze di calcolo non contano)."""
    v = np.asarray(v, dtype=float)
    v = np.round(v[~np.isnan(v)], ARROTONDA_DECIMALI)
    if v.size == 0:
        return False, "nessun valore"
    _, conteggi = np.unique(v, return_counts=True)
    if conteggi.size == 1:
        return False, f"varianza nulla: lo stesso valore per tutti i {v.size} pazienti"
    quota = conteggi.max() / v.size
    if quota >= SOGLIA_MODA:
        return False, (f"troppo pochi valori distinti: un solo valore per {int(conteggi.max())} pazienti su {v.size} "
                       f"(soglia {SOGLIA_MODA:.0%})")
    return True, f"{conteggi.size} valori distinti"


# --------------------------------------------------------------------------- politiche (sezione 7)
def chiave_spareggio(k: int, n: int) -> np.ndarray:
    return np.random.default_rng(np.random.SeedSequence([SEED, k, T_SPAREGGIO])).random(n)


def politiche(d: DatiK, punt_modello: np.ndarray, punt_rumore: np.ndarray, budget: int, tie: np.ndarray) -> dict:
    """Pazienti "rossi" (secondo campione) per politica a budget B. Il casuale e' a parte (distribuzione)."""
    out = {
        P_NESSUNO: np.zeros(d.n, dtype=int),
        P_TUTTI: np.ones(d.n, dtype=int),
        P_LIVELLO: ps.flag_highest(d.x[:, 2], budget, tie),
        P_MARGINE: ps.flag_lowest(d.x[:, 0], budget, tie),
        P_MODELLO: ps.flag_highest(punt_modello, budget, tie),
        P_RUMORE: ps.flag_highest(punt_rumore, budget, tie),
    }
    if d.mutazione is not None:
        out[P_MUTAZIONE] = ps.flag_highest(np.nan_to_num(d.mutazione, nan=-np.inf), budget, tie)
    return out


def estrazioni_casuali(n: int, budget: int, n_estr: int, seed) -> np.ndarray:
    """(n_estr, n) bandierine 0/1: ogni riga sceglie B pazienti a caso senza ripetizione."""
    rng = np.random.default_rng(seed)
    scelta = np.argsort(rng.random((n_estr, n)), axis=1)[:, :budget]
    flags = np.zeros((n_estr, n), dtype=int)
    np.put_along_axis(flags, scelta, 1, axis=1)
    return flags


# --------------------------------------------------------------------------- metriche e bootstrap (sezione 9)
def indici_bootstrap(n: int, n_boot: int, seed) -> np.ndarray:
    """Pazienti ricampionati, (n_boot, n). Stessa sequenza di src/metrics.bootstrap_replicates con una riga per
    paziente in ordine di nome: rng = default_rng(seed); per ogni replica rng.integers(0, n, n)."""
    rng = np.random.default_rng(seed)
    out = np.empty((n_boot, n), dtype=int)
    for b in range(n_boot):
        out[b] = rng.integers(0, n, n)
    return out


def _conteggi_b(y: np.ndarray, f: np.ndarray) -> dict[str, np.ndarray]:
    y, f = y.astype(bool), f.astype(bool)
    ax = y.ndim - 1
    return {"tp": (y & f).sum(ax), "fp": (~y & f).sum(ax), "fn": (y & ~f).sum(ax), "tn": (~y & ~f).sum(ax)}


def _rapporto(a, b):
    a, b = np.asarray(a, dtype=float), np.asarray(b, dtype=float)
    with np.errstate(divide="ignore", invalid="ignore"):
        return np.where(b > 0, a / np.where(b > 0, b, 1.0), np.nan)


def metriche_vettore(y: np.ndarray, f: np.ndarray) -> dict[str, np.ndarray]:
    """Le metriche della sezione 9 su una o piu' righe (bootstrap): NaN quando il denominatore e' zero."""
    c = _conteggi_b(y, f)
    return {
        "resa": _rapporto(c["tp"], c["tp"] + c["fp"]),
        "falsa_rassicurazione": _rapporto(c["fn"], c["fn"] + c["tn"]),
        "eventi_persi": _rapporto(c["fn"], c["tp"] + c["fn"]),
        "falsi_allarmi": _rapporto(c["fp"], c["fp"] + c["tn"]),
    }


def percentili(reps: np.ndarray) -> tuple[float, float]:
    """Intervallo percentile al 95% sulle repliche valide (come src/metrics.bootstrap_ci)."""
    reps = np.asarray(reps, dtype=float)
    v = reps[~np.isnan(reps)]
    if not v.size:
        return float("nan"), float("nan")
    lo, hi = np.percentile(v, [2.5, 97.5])
    return float(lo), float(hi)


def _num(v) -> object:
    """Numero oppure "non calcolabile" (sezione 9: mai 0 al posto di un denominatore zero)."""
    return NC if v is None or (isinstance(v, float) and math.isnan(v)) else v


def auc(y: np.ndarray, s: np.ndarray) -> float:
    return ps.auc_score(y, s)


def brier(y: np.ndarray, p: np.ndarray) -> float:
    return float(np.mean((np.asarray(p) - np.asarray(y)) ** 2)) if len(y) else float("nan")


def pendenze_calibrazione(y: np.ndarray, p: np.ndarray, pesi: np.ndarray) -> np.ndarray:
    """Pendenza di calibrazione: coefficiente di logit(p) nella logistica di y su logit(p), senza penalita'.
    `pesi` (R, n): una riga per ricampionamento (conteggi del bootstrap) o una riga di uni. NaN se una sola classe."""
    eps = 1e-12
    lp = np.log(np.clip(p, eps, 1 - eps) / np.clip(1 - p, eps, 1 - eps))
    xa = np.broadcast_to(np.column_stack([np.ones(len(y)), lp])[None], (pesi.shape[0], len(y), 2)).copy()
    beta = ps._newton_l2(xa, np.asarray(y, dtype=float), pesi.astype(float), np.zeros(2), max_iter=100)
    n_pos, n_tot = (pesi * y).sum(1), pesi.sum(1)
    out = beta[:, 1].copy()
    out[(n_pos <= 0) | (n_pos >= n_tot)] = np.nan
    return out


# --------------------------------------------------------------------------- una analisi per k
@dataclass
class EsitoK:
    righe: list[dict]
    pazienti: pd.DataFrame
    permutazioni: pd.DataFrame
    rischio_copertura: pd.DataFrame


def analizza_k(d: DatiK, *, n_perm: int | None = None, n_boot: int | None = None, n_casuale: int | None = None) -> EsitoK:
    """Politiche, metriche, test di permutazione e controlli negativi per un k (valori di protocollo se None)."""
    n_perm = N_PERM if n_perm is None else n_perm
    n_boot = N_BOOT if n_boot is None else n_boot
    n_casuale = N_CASUALE if n_casuale is None else n_casuale
    k, n, K = d.k, d.n, d.n_eventi
    righe: list[dict] = []

    def add(analisi, misura, *, frac="", budget="", politica="", n_="", den="", valore="", lo="", hi="", metodo="", nota=""):
        righe.append(dict(analisi=analisi, k=k, budget_frazione=frac, budget=budget, politica=politica, misura=misura,
                          n=n_, denominatore=den, valore=valore, ic_lo=lo, ic_hi=hi, metodo=metodo, nota=nota))

    add("conteggi", "pazienti_valutabili", n_=n)
    add("conteggi", "pazienti_con_evento", n_=K, den=n)
    # guardia: lo stato di un predittore senza variabilita' dice che e' escluso dal modello, con il motivo
    guardia = {nome: variabilita(d.x[:, j]) for j, nome in enumerate(d.nomi)} if n else {}
    for nome, stato in d.stato_predittori:
        ok, motivo = guardia.get(nome, (True, ""))
        if ok:
            add("predittori", nome, valore=stato, nota="calcolati solo dal campione indice (sezione 6)")
        else:
            add("predittori", nome, valore=f"escluso dal modello: {motivo}",
                nota="calcolato dal campione indice; guardia sulla variabilita' (docs/DEVIATIONS.md)")
    dichiarati = {nome for nome, _ in d.stato_predittori}
    for nome, (ok, motivo) in guardia.items():
        if not ok and nome not in dichiarati:
            add("predittori", nome, valore=f"escluso dal modello: {motivo}", nota="guardia sulla variabilita' (docs/DEVIATIONS.md)")
    vuoto_p = pd.DataFrame()
    if n < MIN_PAZIENTI:
        add("previsione", "non_eseguita", n_=n, valore=NC, nota=f"meno di {MIN_PAZIENTI} pazienti valutabili a k = {k}")
        return EsitoK(righe, vuoto_p, vuoto_p, vuoto_p)
    degenere = K in (0, n)
    # --- guardia: predittori senza variabilita' esclusi dal modello; politiche senza un predittore utile = NC
    variabili = []
    for j, nome in enumerate(d.nomi):
        if guardia[nome][0]:
            variabili.append(j)
    nc: dict[str, str] = {}
    if not variabili:
        nc[P_MODELLO] = nc[P_RUMORE] = NC_PREDITTORI
    for pol, col in ((P_LIVELLO, 2), (P_MARGINE, 0)):
        ok, motivo = variabilita(d.x[:, col])
        if not ok:
            nc[pol] = f"{NC_PREDITTORI} ({NOMI_P[col]}: {motivo})"
    if d.mutazione is not None and not variabilita(d.mutazione)[0]:
        nc[P_MUTAZIONE] = f"{NC_PREDITTORI} (mutazione: {variabilita(d.mutazione)[1]})"
    x_mod = d.x[:, variabili]
    nomi_mod = [d.nomi[j] for j in variabili]
    for pol, motivo in nc.items():
        add("guardia", "non_calcolabile", politica=pol, valore=NC, nota=motivo)
    det = dettaglio_modello(x_mod, d.y) if P_MODELLO not in nc else None
    s_mod = det.punteggi if det is not None else np.zeros(n)
    s_rum = punteggi(d.rumore, d.y) if P_RUMORE not in nc else np.zeros(n)
    tie = chiave_spareggio(k, n)
    boot = indici_bootstrap(n, n_boot, np.random.SeedSequence([SEED, k, T_BOOT]))
    yb = d.y[boot]
    pesi_boot = np.stack([np.bincount(r, minlength=n) for r in boot])
    metodo_boot = f"{METODO_BOOT}, seme SeedSequence([{SEED}, {k}, {T_BOOT}])"

    if not degenere and det is not None:
        for j, nome in enumerate(nomi_mod):
            add("modello", "coefficiente_standardizzato_medio", politica=P_MODELLO, valore=float(det.coef_std_medi[j]),
                nota=f"{nome}; media sui {N_FOLDS * N_REPEATS} fit esterni (esplorativo)")
        for lam in sorted(LAMBDA_GRID):
            add("modello", "lambda_scelto", politica=P_MODELLO, valore=lam, n_=int(np.sum(det.lambda_scelti == lam)),
                den=len(det.lambda_scelti), nota="fold esterni in cui i 5 fold annidati scelgono questo lambda")

    # --- politiche e metriche, per ogni budget
    flags_per_b: dict[float, dict] = {}
    tp_obs: dict[tuple[float, str], int] = {}
    for frac in BUDGETS:
        b = ps.budget_size(n, frac)
        etichetta = "primario (D3)" if math.isclose(frac, BUDGET_PRIMARIO) else "secondario (D3)"
        fl = {p: f for p, f in politiche(d, s_mod, s_rum, b, tie).items() if p not in nc}
        flags_per_b[frac] = fl
        for pol, motivo in nc.items():
            add("politica", "non_calcolabile", frac=frac, budget=b, politica=pol, valore=NC, nota=motivo)
        rnd = estrazioni_casuali(n, b, n_casuale, np.random.SeedSequence([SEED, k, T_CASUALE, int(round(frac * 100))]))
        m_rnd = metriche_vettore(np.broadcast_to(d.y, rnd.shape), rnd)
        c_rnd = _conteggi_b(np.broadcast_to(d.y, rnd.shape), rnd)
        for c in ("tp", "fp", "fn", "tn"):
            add("politica", c, frac=frac, budget=b, politica=P_CASUALE, valore=float(c_rnd[c].mean()),
                metodo=f"media di {n_casuale} estrazioni casuali", nota=etichetta)
        for nome_m, reps in m_rnd.items():
            lo, hi = percentili(reps)
            add("politica", nome_m, frac=frac, budget=b, politica=P_CASUALE, valore=_num(float(np.nanmean(reps)) if np.isfinite(reps).any() else float("nan")),
                lo=_num(lo), hi=_num(hi), metodo=f"media e percentili 2,5-97,5 di {n_casuale} estrazioni casuali",
                nota=f"{etichetta}; valore atteso esatto della resa = eventi / pazienti")
        rif_b = _rapporto(yb.sum(1), n)  # resa attesa del casuale in ogni ricampionamento: K_b / N
        for pol, f in fl.items():
            cnt = metrics.confusion_counts(d.y, f)
            summ = metrics.summary(d.y, f)
            for c in ("tp", "fp", "fn", "tn"):
                add("politica", c, frac=frac, budget=int(f.sum()), politica=pol, n_=cnt[c], nota=etichetta)
            mb = metriche_vettore(yb, f[boot])
            dens = {"resa": cnt["tp"] + cnt["fp"], "falsa_rassicurazione": cnt["fn"] + cnt["tn"],
                    "eventi_persi": cnt["tp"] + cnt["fn"], "falsi_allarmi": cnt["fp"] + cnt["tn"]}
            nums = {"resa": cnt["tp"], "falsa_rassicurazione": cnt["fn"], "eventi_persi": cnt["fn"], "falsi_allarmi": cnt["fp"]}
            for nome_m in dens:
                lo, hi = percentili(mb[nome_m])
                val = summ[nome_m]
                add("politica", nome_m, frac=frac, budget=int(f.sum()), politica=pol, n_=nums[nome_m], den=dens[nome_m],
                    valore=_num(val), lo=_num(lo) if not math.isnan(val) else NC, hi=_num(hi) if not math.isnan(val) else NC,
                    metodo=metodo_boot if not math.isnan(val) else "", nota=etichetta)
            fb = f[boot]
            cb = _conteggi_b(yb, fb)
            for pt in PT_GRID:
                nb = metrics.net_benefit(d.y, f, pt)
                rep = cb["tp"] / n - cb["fp"] / n * pt / (1 - pt)
                lo, hi = percentili(rep)
                add("politica", "beneficio_netto", frac=frac, budget=int(f.sum()), politica=pol, valore=nb, lo=lo, hi=hi,
                    metodo=metodo_boot, nota=f"{etichetta}; pt = {pt}")
            if pol in (P_NESSUNO, P_TUTTI):
                continue
            tp_obs[(frac, pol)] = cnt["tp"]
            resa_b = mb["resa"]
            diff = summ["resa"] - K / n
            lo, hi = percentili(resa_b - rif_b)
            add("confronto", "differenza_resa_vs_casuale", frac=frac, budget=b, politica=pol, n_=cnt["tp"], den=b,
                valore=diff, lo=lo, hi=hi, metodo=metodo_boot,
                nota=f"{etichetta}; resa della politica meno resa attesa del casuale (eventi / pazienti)")
            add("confronto", "pareggio_al_confine_del_budget", frac=frac, budget=b, politica=pol,
                n_=ps.boundary_tie_size({P_LIVELLO: d.x[:, 2], P_MARGINE: -d.x[:, 0], P_MODELLO: s_mod, P_RUMORE: s_rum,
                                         P_MUTAZIONE: np.nan_to_num(d.mutazione if d.mutazione is not None else np.zeros(n), nan=-np.inf)}[pol], b),
                nota="pazienti con il valore della soglia quando il pareggio attraversa il confine: decide lo spareggio da seme fisso")
        # D9: il modello deve almeno eguagliare la regola del livello
        if P_MODELLO in nc or P_LIVELLO in nc:
            add("confronto", "differenza_resa_modello_vs_livello", frac=frac, budget=b, politica=P_MODELLO, valore=NC,
                nota=f"{etichetta}; {nc.get(P_MODELLO) or nc.get(P_LIVELLO)}")
            continue
        f_m, f_l = fl[P_MODELLO], fl[P_LIVELLO]
        tm, tl = int(d.y[f_m == 1].sum()), int(d.y[f_l == 1].sum())
        lo, hi = percentili(metriche_vettore(yb, f_m[boot])["resa"] - metriche_vettore(yb, f_l[boot])["resa"])
        add("confronto", "differenza_resa_modello_vs_livello", frac=frac, budget=b, politica=P_MODELLO,
            n_=tm - tl, valore=(tm - tl) / b, lo=lo, hi=hi, metodo=metodo_boot,
            nota=f"{etichetta}; D9: per parlare di valore aggiunto il modello deve almeno eguagliare P3 "
                 f"({'almeno pari' if tm >= tl else 'sotto'} la regola del livello: TP {tm} contro {tl})")

    # --- calibrazione e discriminazione (sezione 9)
    if degenere or det is None:
        motivo = "evento assente o presente in tutti" if degenere else NC_PREDITTORI
        add("calibrazione", "brier", politica=P_MODELLO, valore=NC, nota=motivo)
        add("calibrazione", "pendenza_calibrazione", politica=P_MODELLO, valore=NC, nota=motivo)
    else:
        br_b = ((det.probabilita[boot] - yb) ** 2).mean(1)
        lo, hi = percentili(br_b)
        add("calibrazione", "brier", politica=P_MODELLO, n_=K, den=n, valore=brier(d.y, det.probabilita), lo=lo, hi=hi,
            metodo=metodo_boot, nota="probabilita' fuori fold con intercetta, medie sulle ripetizioni")
        sl = pendenze_calibrazione(d.y, det.probabilita, np.ones((1, n)))[0]
        lo, hi = percentili(pendenze_calibrazione(d.y, det.probabilita, pesi_boot))
        add("calibrazione", "pendenza_calibrazione", politica=P_MODELLO, n_=K, den=n, valore=_num(float(sl)),
            lo=_num(lo), hi=_num(hi), metodo=metodo_boot, nota="1 = calibrazione perfetta")
    score_auc = {P_MODELLO: s_mod, P_LIVELLO: d.x[:, 2], P_MARGINE: -d.x[:, 0], P_RUMORE: s_rum}
    if d.mutazione is not None:
        score_auc[P_MUTAZIONE] = np.nan_to_num(d.mutazione, nan=0.0)
    for pol in nc:
        if pol in score_auc:
            add("discriminazione", "auc", politica=pol, n_=K, den=n, valore=NC, lo=NC, hi=NC, nota=nc[pol])
    score_auc = {p: v for p, v in score_auc.items() if p not in nc}
    for pol, s in score_auc.items():
        if K < MIN_EVENTI_AUC or degenere:
            add("discriminazione", "auc", politica=pol, n_=K, den=n, valore=NC, lo=NC, hi=NC,
                nota=f"AUC solo con almeno {MIN_EVENTI_AUC} eventi (sezione 9)")
            continue
        reps = np.array([auc(yb[i], s[boot[i]]) for i in range(len(boot))])
        lo, hi = percentili(reps)
        add("discriminazione", "auc", politica=pol, n_=K, den=n, valore=auc(d.y, s), lo=lo, hi=hi, metodo=metodo_boot)

    # --- test di permutazione (sezione 10) e controlli negativi (sezione 12)
    testate = [p for p in POLITICHE_TESTATE if p in flags_per_b[BUDGET_PRIMARIO]]
    perm_rows = []
    for frac in BUDGETS:   # politiche senza un predittore utile: nessun p-value
        for pol in [p for p in POLITICHE_TESTATE if p in nc]:
            add("test_permutazione", "p_value", frac=frac, budget=ps.budget_size(n, frac), politica=pol, valore=NC, nota=nc[pol])
        if P_MODELLO in nc:
            add("controllo_negativo", "resa_media_etichette_permutate", frac=frac, budget=ps.budget_size(n, frac),
                politica=P_MODELLO, valore=NC, nota=nc[P_MODELLO])
    if degenere:
        for frac in BUDGETS:
            for pol in testate:
                add("test_permutazione", "p_value", frac=frac, budget=ps.budget_size(n, frac), politica=pol, valore=NC,
                    nota="evento assente o presente in tutti: test non calcolabile")
    else:
        rng = np.random.default_rng(np.random.SeedSequence([SEED, k, T_PERM]))
        for i in range(n_perm):
            yp = rng.permutation(d.y)  # INTERA pipeline: fold stratificati, lambda, fit e selezione rifatti su yp
            sp_mod = punteggi(x_mod, yp) if P_MODELLO not in nc else np.zeros(n)
            sp_rum = punteggi(d.rumore, yp) if P_RUMORE not in nc else np.zeros(n)
            for frac in BUDGETS:
                b = ps.budget_size(n, frac)
                fl = politiche(d, sp_mod, sp_rum, b, tie)
                for pol in testate:
                    perm_rows.append((k, i + 1, frac, pol, int(yp[fl[pol] == 1].sum())))
        perm = pd.DataFrame(perm_rows, columns=["k", "permutazione", "budget_frazione", "politica", "tp"])
        for frac in BUDGETS:
            b = ps.budget_size(n, frac)
            etichetta = "primario (D3)" if math.isclose(frac, BUDGET_PRIMARIO) else "secondario (D3)"
            for pol in testate:
                tp_p = perm[(perm["budget_frazione"] == frac) & (perm["politica"] == pol)]["tp"].to_numpy()
                ge = int((tp_p >= tp_obs[(frac, pol)]).sum())
                pv = ps.perm_pvalue(ge, n_perm)
                esito = "H0 rifiutata" if pv < ALPHA else "H0 non rifiutata"
                ruolo = {P_MODELLO: "test della sezione 10", P_RUMORE: "controllo negativo: predittori di rumore (sezione 12)",
                         P_LIVELLO: "regola semplice del livello (D9)", P_MARGINE: "regola del margine (esplorativa, D9)",
                         P_MUTAZIONE: "regola D14 (esplorativa)"}[pol]
                add("test_permutazione", "p_value", frac=frac, budget=b, politica=pol, n_=ge, den=n_perm, valore=pv,
                    metodo=f"(1 + permutazioni con resa >= osservata) / (1 + {n_perm}); unilaterale",
                    nota=f"{etichetta}; {ruolo}; alfa {ALPHA}: {esito} (ESPLORATIVA)")
            if P_MODELLO in nc:
                continue
            tp_m = perm[(perm["budget_frazione"] == frac) & (perm["politica"] == P_MODELLO)]["tp"].to_numpy()
            add("controllo_negativo", "resa_media_etichette_permutate", frac=frac, budget=b, politica=P_MODELLO,
                n_=n_perm, valore=float(tp_m.mean() / b), metodo=f"media su {n_perm} permutazioni dell'intera pipeline",
                nota=f"{etichetta}; deve tornare al livello del casuale, cioe' eventi / pazienti = {K}/{n}")
            add("controllo_negativo", "differenza_vs_casuale_etichette_permutate", frac=frac, budget=b, politica=P_MODELLO,
                valore=float(tp_m.mean() / b - K / n), lo=float(np.percentile(tp_m / b - K / n, 2.5)),
                hi=float(np.percentile(tp_m / b - K / n, 97.5)),
                metodo=f"media e percentili 2,5-97,5 su {n_perm} permutazioni", nota=etichetta)
    perm = pd.DataFrame(perm_rows, columns=["k", "permutazione", "budget_frazione", "politica", "tp"])

    # --- per paziente e curva rischio-copertura
    fl_p = flags_per_b[BUDGET_PRIMARIO]
    paz = pd.DataFrame({"k": k, "patient": d.pazienti, "indice": d.indici, "evento": d.y})
    for j, nome in enumerate(d.nomi):
        paz[nome] = d.x[:, j]
    paz["punteggio_modello"] = s_mod if det is not None else np.nan
    paz["probabilita_modello"] = det.probabilita if det is not None else np.nan
    paz["punteggio_rumore"] = s_rum if P_RUMORE not in nc else np.nan
    for pol in (P_LIVELLO, P_MARGINE, P_MODELLO, P_RUMORE, P_MUTAZIONE):
        if pol in fl_p:
            paz[f"rosso_{pol}_B{int(round(BUDGET_PRIMARIO * 100))}"] = fl_p[pol]
    curve = []
    for pol, s in score_auc.items():
        rc = metrics.risk_coverage_curve(s, d.y)
        rc.insert(0, "politica", pol)
        rc.insert(0, "k", k)
        curve.append(rc)
    return EsitoK(righe, paz, perm, pd.concat(curve, ignore_index=True) if curve else pd.DataFrame())


# --------------------------------------------------------------------------- analisi completa
def analizza(inc: ep.Inclusion, *, dataset: str, dich: Dichiarazioni | None = None, s1: pd.DataFrame | None = None,
             n_perm: int | None = None, n_boot: int | None = None, n_casuale: int | None = None,
             ks=ep.KS) -> dict[str, pd.DataFrame]:
    """Dalla tabella di inclusione (funzioni firmate) alle uscite della previsione esplorativa."""
    n_perm = N_PERM if n_perm is None else n_perm
    n_boot = N_BOOT if n_boot is None else n_boot
    n_casuale = N_CASUALE if n_casuale is None else n_casuale
    sigma = ep.estimate_sigma(inc.canon, inc)
    paz_ep = ep.endpoint_table(inc, sigma)
    righe = []
    for name, val in [("budget_primario", BUDGET_PRIMARIO), ("budget", ";".join(str(b) for b in BUDGETS)),
                      ("n_casuale", N_CASUALE), ("cv_fold", N_FOLDS), ("cv_ripetizioni", N_REPEATS),
                      ("fold_annidati", INNER_FOLDS), ("lambda_grid", ";".join(str(v) for v in LAMBDA_GRID)),
                      ("n_permutazioni", n_perm), ("alfa_unilaterale", ALPHA), ("n_boot", n_boot),
                      ("min_eventi_auc", MIN_EVENTI_AUC), ("min_pazienti", MIN_PAZIENTI),
                      ("soglie_beneficio_netto", ";".join(str(v) for v in PT_GRID)), ("seed", SEED), ("cv_seed", CV_SEED)]:
        righe.append(dict(analisi="parametri", misura=name, valore=val))
    righe.append(dict(analisi="rumore", misura="modalita_rumore", valore=sigma.noise, nota=sigma.reason))
    pazienti, perms, curve = [], [], []
    for k in ks:
        dk = costruisci_dati(inc, sigma, paz_ep, k, dich, s1)
        es = analizza_k(dk, n_perm=n_perm, n_boot=n_boot, n_casuale=n_casuale)
        righe += es.righe
        pazienti.append(es.pazienti)
        perms.append(es.permutazioni)
        curve.append(es.rischio_copertura)
    rie = pd.DataFrame([{**{c: "" for c in COLONNE_RIEPILOGO}, **r} for r in righe], dtype=object)
    rie["dataset"], rie[COLONNA_MARCATURA] = dataset, MARCATURA
    rie["modalita_lesione"], rie["rumore"] = inc.mode, sigma.noise
    rie = rie[COLONNE_RIEPILOGO].astype(object)
    rie = rie.where(rie.notna(), "")
    out = {"riepilogo": rie, "pazienti": pd.concat(pazienti, ignore_index=True),
           "permutazioni": pd.concat(perms, ignore_index=True), "rischio_copertura": pd.concat(curve, ignore_index=True)}
    for nome in ("pazienti", "permutazioni", "rischio_copertura"):
        out[nome].insert(0, COLONNA_MARCATURA, MARCATURA)
        out[nome].insert(0, "dataset", dataset)
    return out


# --------------------------------------------------------------------------- condizioni (dati veri e sintetici)
def nome_primaria(sintetico: bool) -> str:
    return f"{SYNTHETIC_TAG}_{ds.BASE_NAME}" if sintetico else ds.BASE_NAME


def controlla_primaria(cartella: str | Path, *, sintetico: bool, sha_dati: str) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Servono i risultati dell'analisi primaria (riepilogo e pazienti) con il .meta.json, calcolati su questa tabella."""
    base = nome_primaria(sintetico)
    tab = {}
    for suff in ("", "_pazienti"):
        csv, meta = Path(cartella) / f"{base}{suff}.csv", Path(cartella) / f"{base}{suff}.meta.json"
        if not csv.is_file() or not meta.is_file():
            raise PrevisioneError(f"STOP: la previsione esplorativa si esegue solo dopo l'analisi primaria: manca {csv.name} "
                                  f"o il suo .meta.json in {cartella}.")
        info = json.loads(meta.read_text(encoding="utf-8"))
        if info.get("synthetic") is not sintetico:
            raise PrevisioneError(f"STOP: {meta.name} ha synthetic = {info.get('synthetic')}: non corrisponde ai dati.")
        if sha_dati not in (info.get("input_sha256") or {}).values():
            raise PrevisioneError(f"STOP: {meta.name} non registra l'impronta di questa tabella: l'analisi primaria "
                                  "e' stata fatta su un altro file.")
        tab[suff] = pd.read_csv(csv, dtype=str, keep_default_na=False)
    return tab[""], tab["_pazienti"]


def regola_dss_negativi_attiva(riepilogo: pd.DataFrame) -> bool:
    from src.esegui_analisi_reale import MISURA_REGOLA

    if "misura" not in riepilogo.columns:
        return False
    sel = riepilogo[riepilogo["misura"] == MISURA_REGOLA]
    return bool(len(sel)) and set(sel["valore"]) == {"attiva"}


def confronta_con_primaria(paz_ep: pd.DataFrame, salvati: pd.DataFrame, ks=ep.KS) -> None:
    """L'endpoint ricalcolato deve coincidere paziente per paziente con quello salvato dall'analisi primaria."""
    cols = ["patient", "f1"] + [c for k in ks for c in (f"stato_k{k}", f"evento_k{k}")]
    if any(c not in salvati.columns for c in cols):
        raise PrevisioneError("STOP: il file dei pazienti dell'analisi primaria non ha le colonne attese.")
    def testo(tab: pd.DataFrame) -> pd.DataFrame:
        t = pd.DataFrame({c: ["" if pd.isna(v) else str(v) for v in tab[c]] for c in cols}, dtype=object)
        return t.sort_values("patient", kind="stable").reset_index(drop=True)

    nuovo, vecchio = testo(paz_ep), testo(salvati)
    if not nuovo.equals(vecchio):
        raise PrevisioneError("STOP: l'endpoint ricalcolato non coincide con analisi_primaria_pazienti: la tabella o il "
                              "codice non sono quelli dell'analisi primaria.")


def aggiungi_marcatura_meta(result_path: Path) -> None:
    """Aggiunge al .meta.json scritto da save_result il campo della marcatura ESPLORATIVA."""
    meta = result_path.with_name(result_path.stem + ".meta.json")
    info = json.loads(meta.read_text(encoding="utf-8"))
    info[CAMPO_META] = MARCATURA
    meta.write_text(json.dumps(info, indent=2, ensure_ascii=False), encoding="utf-8")


# --------------------------------------------------------------------------- riga di comando
def main(argv: list[str] | None = None, repo_root: str | Path = REPO_ROOT,
         dichiarazioni: str | Path = DICHIARAZIONI) -> int:
    ap = argparse.ArgumentParser(description="Previsione ESPLORATIVA (GO RIDOTTO, sezione 11), dopo l'analisi primaria")
    ap.add_argument("--data", required=True, help="tabella lunga del pannello primario (results/s5_tabella_primaria.csv)")
    ap.add_argument("--config", required=True, help="schema delle colonne (config/schema.yaml)")
    ap.add_argument("--primaria", required=True, help="cartella con i risultati dell'analisi primaria (results)")
    ap.add_argument("--out", required=True, help="cartella delle uscite (results)")
    ap.add_argument("--s1", default=None, help="Data S1: serve solo se D5 o D14 sono dichiarati e committati")
    args = ap.parse_args(argv)
    command = shlex.join(["python", "-m", "src.previsione_esplorativa", *(argv if argv is not None else sys.argv[1:])])
    try:
        sintetico = ds.classify_origin(args.data)
        if not sintetico:
            ds.check_prereg_signed(repo_root)
        git_info = git_state()  # fotografia unica prima di scrivere in results/
        rie_p, paz_p = controlla_primaria(args.primaria, sintetico=sintetico, sha_dati=sha256_file(args.data))
    except (ds.OriginError, ds.PreregError, SchemaError, PrevisioneError) as exc:
        print(str(exc), file=sys.stderr)
        return 2
    regola = regola_dss_negativi_attiva(rie_p)
    if regola:
        from src.esegui_analisi_reale import DeviazioneError, controlla_voce_dss_negativi
        try:
            controlla_voce_dss_negativi(repo_root)
        except DeviazioneError as exc:
            print(str(exc), file=sys.stderr)
            return 2
    precedente = ep.REGOLA_DSS_NEGATIVI_V034
    ep.REGOLA_DSS_NEGATIVI_V034 = regola
    try:
        return _esegui(args, sintetico, paz_p, git_info, command, repo_root, dichiarazioni)
    finally:
        ep.REGOLA_DSS_NEGATIVI_V034 = precedente


def _esegui(args, sintetico: bool, paz_p: pd.DataFrame, git_info: dict, command: str, repo_root, dichiarazioni) -> int:
    dataset = SYNTHETIC_TAG if sintetico else "REALE"
    if sintetico:
        print(f"*** DATI SINTETICI ({SYNTHETIC_TAG}): nessun dato di risposta reale e' usato ***")
    print(f"*** {MARCATURA} ***")
    try:
        inc = ds.stage_inclusion(ingest_samples(args.data, args.config))
        sigma = ep.estimate_sigma(inc.canon, inc)
        confronta_con_primaria(ep.endpoint_table(inc, sigma), paz_p)
        dich = leggi_dichiarazioni(dichiarazioni, repo_root)
        servono = dich.metadati + ([dich.colonna_gene] if dich.d14 else [])
        s1 = None
        if servono and dich.committate and args.s1:
            s1 = leggi_s1_colonne(args.s1, servono, args.config)
        out = analizza(inc, dataset=dataset, dich=dich, s1=s1)
    except (ep.EndpointError, SchemaError, PrevisioneError) as exc:
        print(str(exc), file=sys.stderr)
        return 2
    prefisso = f"{SYNTHETIC_TAG}_" if sintetico else ""
    ingressi = [args.data] + ([args.s1] if args.s1 else []) + [str(dichiarazioni)]
    ingressi += [str(Path(args.primaria) / f"{nome_primaria(sintetico)}{s}.csv") for s in ("", "_pazienti")]
    common = dict(seed=SEED, synthetic=sintetico, input_files=ingressi, command=command, results_dir=args.out,
                  git_info=git_info)
    percorsi = []
    for chiave, suff in (("pazienti", "_pazienti"), ("permutazioni", "_permutazioni"),
                         ("rischio_copertura", "_rischio_copertura"), ("riepilogo", "")):
        path = save_result(out[chiave], f"{prefisso}{BASE_NAME}{suff}", **common)
        aggiungi_marcatura_meta(path)
        percorsi.append(path)
    rie = out["riepilogo"]
    for k in ep.KS:
        r = rie[(rie["analisi"] == "conteggi") & (rie["k"] == k) & (rie["misura"] == "pazienti_valutabili")]
        print(f"k = {k}: pazienti valutabili {r['n'].iloc[0] if len(r) else 0}")
    print("Salvati: " + ", ".join(p.name for p in percorsi))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
