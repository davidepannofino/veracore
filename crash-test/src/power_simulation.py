"""SINTETICO - Simulazione di potenza per "Un campione basta?" (preregistrazione, sezioni 5-11).

DATI SINTETICI: questo modulo genera solo dati simulati. Non legge e non usa alcun dato di
risposta reale (DSS). Ogni output porta SINTETICO nel nome del file, la colonna
``dataset = "SINTETICO"``, ``synthetic = True`` e il relativo .meta.json (src/provenance.py).

Cosa fa
1. Genera dataset sintetici: per ogni paziente un profilo di DSS sui farmaci comuni; ogni
   campione = profilo + deviazione tra lesioni + rumore di replica (sezione 2 del piano).
2. Calcola l'endpoint primario (sezione 5), i predittori P1-P3 (sezione 6) e le politiche a pari
   budget (sezione 7): casuale, regola semplice del livello (P3 piu' alto), regola del margine
   (P1 piu' basso) e modello (logistica L2).
3. Validazione del modello (sezione 8, v0.2): 5 fold per paziente stratificati per evento,
   ripetuti 20 volte con seed fissi; punteggio = predittore lineare SENZA intercetta, medio
   sulle ripetizioni; lambda scelto con 5 fold annidati sul solo training. Il leave-one-patient-out
   resta solo come opzione del config (model.validation: lopo), per confronto.
4. Stima la potenza con il test ipergeometrico unilaterale (stima rapida) e verifica le celle con
   k = 3 e B = 30% con il test di permutazione dell'INTERA pipeline, p = (1 + conteggio) /
   (1 + n_perm) (sezioni 10-11). Calcola l'effetto minimo rilevabile. Controllo negativo con
   predittori di rumore (sezione 12).

5. Estensione --sample-size: curva di potenza in funzione del numero di pazienti N (livello e margine
   con l'ipergeometrica, modello con la permutazione dell'intera pipeline e guardia sul tempo).
   Ogni N vale solo per la cella e il rho SEGNAPOSTO indicati: non e' una stima dell'effetto reale.

6. Opzione --conteggi-reali <rapporto>: dopo l'audit e la preparazione di Data S5, la simulazione usa i soli
   CONTEGGI del rapporto della pipeline (results/s5_rapporto_conteggi.csv, src/prepara_s5.py): pazienti con un
   intervento idoneo e voci del pannello primario D15. Mai un valore di risposta. Le uscite hanno il suffisso
   _conteggi_reali e restano SINTETICHE: le griglie di eterogeneita', rumore e segnale sono sempre segnaposto.

Parametri, griglie e scenari di conteggi PRELIMINARI stanno in config/sim_params.yaml.
Uso: python -m src.power_simulation --config config/sim_params.yaml [--mode quick|full]
     python -m src.power_simulation --config config/sim_params.yaml --sample-size [--estimate]
     python -m src.power_simulation --config config/sim_params.yaml --conteggi-reali results/s5_rapporto_conteggi.csv
"""
from __future__ import annotations

import argparse
import math
import os
import shlex
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass
from pathlib import Path

# Un solo thread BLAS per processo: i problemi sono piccoli e si parallelizza per processi.
for _var in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_var, "1")

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
import yaml  # noqa: E402
from scipy.stats import hypergeom, rankdata  # noqa: E402

from src import metrics  # noqa: E402
from src.provenance import REPO_ROOT, SYNTHETIC_TAG, git_state, save_result  # noqa: E402

DATASET_TAG = SYNTHETIC_TAG  # "SINTETICO"
BANNER = "*** DATI SINTETICI (SINTETICO): nessun dato di risposta reale e' usato ***"
POLICIES = ("casuale", "livello", "margine", "modello")
VALIDATION_CV = "cv"  # 5 fold per paziente ripetuti (sezione 8, v0.2)
VALIDATION_LOPO = "lopo"  # leave-one-patient-out: solo per confronto
SCENARIO_PROFILE = "profilo"  # il segnale passa dalla scala delle deviazioni del profilo (P2)
SCENARIO_META = "metadato"  # il segnale passa da una caratteristica sintetica separata
SCENARIO_NEG = "controllo_negativo"  # predittori di puro rumore (sezione 12)
FROZEN_LOGIT = 12.0  # fold di training con una sola classe: probabilita' costante ~ 6e-6
RHO_MAX_EXCLUSIVE = 1.0


# --------------------------------------------------------------------------- configurazione
def load_config(path: str | Path) -> dict:
    with open(path, encoding="utf-8") as fh:
        return yaml.safe_load(fh)


def validate_config(cfg: dict, mode: str) -> None:
    """Controlli di coerenza: errori chiari prima di spendere tempo di calcolo."""
    grids, ms, model = cfg["grids"], cfg["modes"][mode], cfg["model"]
    scenarios = cfg.get("count_scenarios") or []
    if not scenarios:
        raise ValueError("count_scenarios: serve almeno uno scenario di conteggi")
    names = [sc["name"] for sc in scenarios]
    if len(set(names)) != len(names):
        raise ValueError("count_scenarios: i nomi devono essere unici")
    cv_folds = int(model.get("cv_folds", 5))
    for sc in scenarios:
        if sc["samples_per_patient"] < 2:
            raise ValueError(f"{sc['name']}: servono almeno 2 campioni per paziente (indice e secondo campione)")
        if sc["n_patients"] < max(4, cv_folds):
            raise ValueError(f"{sc['name']}: servono almeno {max(4, cv_folds)} pazienti (un paziente per fold)")
        if sc["n_drugs_common"] <= max(grids["k"]):
            raise ValueError(f"{sc['name']}: servono piu' farmaci comuni di k (P1 usa il farmaco in posizione k+1)")
    if not all(0 < f < 1 for f in grids["budget_fraction"]):
        raise ValueError("budget_fraction deve stare tra 0 e 1 (esclusi)")
    if not all(0 <= r < RHO_MAX_EXCLUSIVE for r in ms["signal_rho"]):
        raise ValueError("signal_rho deve stare in [0, 1)")
    if len(model["lambda_grid"]) < 1 or min(model["lambda_grid"]) <= 0:
        raise ValueError("lambda_grid: valori positivi")
    if model.get("validation", VALIDATION_CV) not in (VALIDATION_CV, VALIDATION_LOPO):
        raise ValueError("model.validation: 'cv' oppure 'lopo'")
    if cv_folds < 2 or int(model.get("inner_folds", 5)) < 2 or int(model.get("cv_repeats", 20)) < 1:
        raise ValueError("model: cv_folds e inner_folds >= 2, cv_repeats >= 1")
    if cfg["test"]["alpha"] <= 0 or cfg["test"]["alpha"] >= 1:
        raise ValueError("alpha tra 0 e 1")
    pc = ms.get("perm_check", {})
    if pc.get("enabled", False):
        if int(pc["k"]) not in [int(k) for k in grids["k"]]:
            raise ValueError("perm_check.k non e' nella griglia k")
        if not any(math.isclose(float(pc["budget_fraction"]), float(f)) for f in grids["budget_fraction"]):
            raise ValueError("perm_check.budget_fraction non e' nella griglia dei budget")
        if int(pc["n_perm"]) < 1 or int(pc["n_datasets"]) < 1:
            raise ValueError("perm_check: n_perm e n_datasets >= 1")


@dataclass(frozen=True)
class Cell:
    """Una cella della griglia: scenario, eterogeneita' tau, rumore sigma_rep, segnale rho."""

    scenario: str
    tau: float
    sigma_rep: float
    rho: float


def build_cells(cfg: dict, mode: str) -> list[Cell]:
    ms = cfg["modes"][mode]
    scenarios = [SCENARIO_PROFILE]
    if cfg.get("metadata_scenario", {}).get("enabled", False):
        scenarios.append(SCENARIO_META)
    cells = [
        Cell(sc, float(t), float(s), float(r))
        for sc in scenarios
        for t in ms["heterogeneity_tau"]
        for s in ms["sigma_rep"]
        for r in ms["signal_rho"]
    ]
    nc = cfg.get("negative_control", {})
    if nc.get("enabled", False):
        cells.append(Cell(SCENARIO_NEG, float(nc["tau"]), float(nc["sigma_rep"]), 0.0))
    return cells


def make_context(cfg: dict, mode: str, scenario_idx: int = 0) -> dict:
    """Dizionario semplice (serializzabile per i processi) con tutto cio' che serve ai worker.

    scenario_idx sceglie lo scenario di conteggi (config: count_scenarios).
    """
    ms, model = cfg["modes"][mode], cfg["model"]
    sc = cfg["count_scenarios"][scenario_idx]
    confirmed = bool(sc.get("counts_confirmed", False))
    return {
        "seed": int(cfg["seed"]),
        "mode": mode,
        "scenario_idx": int(scenario_idx),
        "count_scenario": str(sc["name"]),
        "counts_status": "CONFERMATO" if confirmed else str(sc.get("status", "PRELIMINARE")),
        "n_patients": int(sc["n_patients"]),
        "n_samples": int(sc["samples_per_patient"]),
        "n_drugs": int(sc["n_drugs_common"]),
        "structure": dict(cfg["structure"]),
        "delta_z": float(cfg["endpoint"]["delta_z"]),
        "ks": [int(k) for k in cfg["grids"]["k"]],
        "fracs": [float(f) for f in cfg["grids"]["budget_fraction"]],
        "lam_grid": [float(x) for x in model["lambda_grid"]],
        "validation": str(model.get("validation", VALIDATION_CV)),
        "cv_folds": int(model.get("cv_folds", 5)),
        "cv_repeats": int(model.get("cv_repeats", 20)),
        "inner_folds": int(model.get("inner_folds", 5)),
        "cv_seed": int(model.get("cv_seed", cfg["seed"])),
        "alpha": float(cfg["test"]["alpha"]),
        "power_threshold": float(cfg["test"]["power_threshold"]),
        "n_sim": int(ms["n_sim"]),
        "placeholder_counts": not confirmed,
    }


# --------------------------------------------------------------------------- modello generativo
@dataclass
class SimData:
    """Un dataset sintetico. dss ha forma (pazienti, campioni, farmaci)."""

    dss: np.ndarray
    z: np.ndarray  # latente di eterogeneita' tra lesioni, per paziente
    u_scale: np.ndarray  # scala delle deviazioni del profilo del paziente
    meta: np.ndarray  # caratteristica sintetica separata (usata solo nello scenario "metadato")
    noise_x: np.ndarray  # rumore puro per il controllo negativo


def simulate_dataset(
    rng: np.random.Generator,
    *,
    n_patients: int,
    n_samples: int,
    n_drugs: int,
    tau: float,
    sigma_rep: float,
    rho: float,
    structure: dict,
    metadata_scenario: bool = False,
) -> SimData:
    """DSS_psj = d_j + u_pj + N(0, tau_p) + N(0, sigma_rep), campione s = lesione diversa.

    - z_p ~ N(0,1): latente; tau_p = tau * exp(s_tau * z_p) (eterogeneita' tra lesioni).
    - u_pj ~ N(0, s_u * exp(rho*z_p + sqrt(1-rho^2)*e_p)): il legame con z_p sta nella scala
      delle deviazioni del profilo del paziente (scenario "profilo"). Con rho = 0 non c'e' legame.
    - Scenario "metadato": la scala di u non dipende da z (rho_u = 0) e il segnale passa da
      meta_p = rho*z_p + sqrt(1-rho^2)*e'_p, una caratteristica sintetica separata.
    Il flusso di numeri casuali e' lo stesso in tutti gli scenari.
    """
    n, s, j = n_patients, n_samples, n_drugs
    z = rng.standard_normal(n)
    e = rng.standard_normal(n)
    e_meta = rng.standard_normal(n)
    drug_effect = structure["mean_dss"] + structure["s_drug"] * rng.standard_normal(j)
    u_raw = rng.standard_normal((n, j))
    lesion_raw = rng.standard_normal((n, s, j))
    noise_raw = rng.standard_normal((n, s, j))
    noise_x = rng.standard_normal((n, 4))

    rho_u = 0.0 if metadata_scenario else rho
    u_scale = structure["s_u"] * np.exp(rho_u * z + math.sqrt(1.0 - rho_u**2) * e)
    profile = drug_effect[None, :] + u_scale[:, None] * u_raw
    tau_p = tau * np.exp(structure["s_tau"] * z)
    dss = profile[:, None, :] + tau_p[:, None, None] * lesion_raw + sigma_rep * noise_raw
    meta = rho * z + math.sqrt(1.0 - rho**2) * e_meta
    return SimData(dss=dss, z=z, u_scale=u_scale, meta=meta, noise_x=noise_x)


def simulate_cell_dataset(ctx: dict, cell: Cell, cell_idx: int, sim_idx: int) -> SimData:
    """Dataset numero sim_idx della cella cell_idx; il seme dipende solo da (seed, scenario, cella, sim)."""
    rng = np.random.default_rng(
        np.random.SeedSequence([ctx["seed"], ctx.get("scenario_idx", 0), cell_idx, sim_idx])
    )
    return simulate_dataset(
        rng,
        n_patients=ctx["n_patients"],
        n_samples=ctx["n_samples"],
        n_drugs=ctx["n_drugs"],
        tau=cell.tau,
        sigma_rep=cell.sigma_rep,
        rho=cell.rho,
        structure=ctx["structure"],
        metadata_scenario=cell.scenario == SCENARIO_META,
    )


def to_long(data: SimData) -> pd.DataFrame:
    """Formato lungo con i nomi logici dello schema (patient, lesion, drug, dss).

    Nessuna colonna inventata: il marchio SINTETICO sta in ``df.attrs["dataset"]``.
    """
    n, s, j = data.dss.shape
    pa, le, dr = np.meshgrid(np.arange(n), np.arange(s), np.arange(j), indexing="ij")
    df = pd.DataFrame(
        {"patient": pa.ravel(), "lesion": le.ravel(), "drug": dr.ravel(), "dss": data.dss.ravel()}
    )
    df.attrs["dataset"] = DATASET_TAG
    return df


# --------------------------------------------------------------------------- endpoint e predittori
def delta_threshold(sigma_rep: float, z: float = 1.96) -> float:
    """delta = 1,96 * sigma_rep * sqrt(2) (sezione 5)."""
    return z * sigma_rep * math.sqrt(2.0)


def compute_endpoint(
    dss_index: np.ndarray, dss_second: np.ndarray, k: int, sigma_rep: float, z: float = 1.96
) -> np.ndarray:
    """Evento (1) = F1 non e' tra i primi k del secondo campione E il calo supera delta.

    F1 = farmaco con DSS piu' alto nell'indice (pannello comune). Il calo e'
    DSS_indice(F1) - DSS_secondo(F1) > delta (strettamente).
    """
    n = dss_index.shape[0]
    rows = np.arange(n)
    f1 = dss_index.argmax(axis=1)
    v_idx = dss_index[rows, f1]
    v_sec = dss_second[rows, f1]
    n_better = (dss_second > v_sec[:, None]).sum(axis=1)  # farmaci strettamente sopra F1
    out_of_top_k = n_better >= k
    drop = (v_idx - v_sec) > delta_threshold(sigma_rep, z)
    return (out_of_top_k & drop).astype(int)


def compute_predictors(dss_index: np.ndarray, k: int, sigma_rep: float) -> np.ndarray:
    """P1-P3 (sezione 6) dal solo campione indice, colonne [P1, P2, P3].

    P1 = (DSS F1 - DSS del farmaco in posizione k+1) / sigma_rep; P2 = sd dei DSS del pannello
    (ddof=1); P3 = DSS di F1. Sono sempre calcolati dai DSS simulati dell'indice.
    """
    srt = np.sort(dss_index, axis=1)[:, ::-1]
    p1 = (srt[:, 0] - srt[:, k]) / sigma_rep
    p2 = dss_index.std(axis=1, ddof=1)
    p3 = srt[:, 0]
    return np.column_stack([p1, p2, p3])


def make_features(data: SimData, cell: Cell, k: int) -> np.ndarray:
    """Matrice dei predittori. Solo il campione indice (colonna 0 dei campioni) entra."""
    x = compute_predictors(data.dss[:, 0, :], k, cell.sigma_rep)
    if cell.scenario == SCENARIO_META:
        return np.column_stack([x, data.meta])  # P4: metadato sintetico
    if cell.scenario == SCENARIO_NEG:
        return data.noise_x[:, : x.shape[1]].copy()  # rumore al posto di P1-P3
    return x


# --------------------------------------------------------------------------- logistica L2 (numpy)
def _sigmoid(t: np.ndarray) -> np.ndarray:
    return 0.5 * (1.0 + np.tanh(0.5 * t))


def _newton_l2(
    xa: np.ndarray, y: np.ndarray, w: np.ndarray, pen: np.ndarray, max_iter: int = 40, tol: float = 1e-8
) -> np.ndarray:
    """Regressione logistica con penalita' L2, in batch (Newton).

    Minimizza  sum_n w_n * logloss_n + 0.5 * sum_q pen_q * beta_q^2  (come sklearn con
    C = 1/lambda; l'intercetta, colonna 0, non e' penalizzata).
    xa: (F, n, q) con la colonna 0 di uni; y: (n,) o (F, n); w: (F, n) pesi 0/1 del training;
    pen: (q,) uguale per tutti i fit, oppure (F, q) con una penalita' (lambda) per ogni fit.
    Fold con una sola classe nel training: probabilita' costante, coefficienti nulli.
    """
    n_fits, _, q = xa.shape
    y2 = y[None, :] if y.ndim == 1 else y
    beta = np.zeros((n_fits, q))
    n_tr = w.sum(axis=1)
    n_pos = (w * y2).sum(axis=1)
    frozen = (n_pos <= 0) | (n_pos >= n_tr)
    beta[frozen, 0] = np.where(n_pos[frozen] <= 0, -FROZEN_LOGIT, FROZEN_LOGIT)
    act = np.flatnonzero(~frozen)
    if act.size == 0:
        return beta
    xa_a, w_a = xa[act], w[act]
    y_a = np.broadcast_to(y2, w.shape)[act]
    pen = np.asarray(pen, dtype=float)
    pen_a = pen if pen.ndim == 1 else pen[act]
    b = np.zeros((act.size, q))
    eye = np.eye(q)
    ridge = (np.diag(pen_a) if pen_a.ndim == 1 else pen_a[:, :, None] * eye) + 1e-9 * eye
    for _ in range(max_iter):
        eta = (xa_a @ b[:, :, None])[:, :, 0]
        p = _sigmoid(eta)
        grad = (xa_a.transpose(0, 2, 1) @ (w_a * (p - y_a))[:, :, None])[:, :, 0] + b * pen_a
        s = w_a * p * (1.0 - p)
        hess = (xa_a * s[:, :, None]).transpose(0, 2, 1) @ xa_a + ridge
        step = np.clip(np.linalg.solve(hess, grad[:, :, None])[:, :, 0], -5.0, 5.0)
        b -= step
        if np.abs(step).max() < tol:
            break
    beta[act] = b
    return beta


def _penalty(lam: float, n_features: int) -> np.ndarray:
    return np.r_[0.0, np.full(n_features, lam)]


def fit_l2_logistic(z: np.ndarray, y: np.ndarray, lam: float) -> tuple[float, np.ndarray]:
    """Un singolo fit su predittori gia' standardizzati. Restituisce (intercetta, coefficienti)."""
    z = np.asarray(z, dtype=float)
    xa = np.concatenate([np.ones((1, z.shape[0], 1)), z[None]], axis=2)
    beta = _newton_l2(xa, np.asarray(y, dtype=float), np.ones((1, z.shape[0])), _penalty(lam, z.shape[1]))
    return float(beta[0, 0]), beta[0, 1:].copy()


def _weighted_mean_sd(x: np.ndarray, w: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Media (F, p), sd (F, p) e x centrato (F, n, p) calcolati SOLO sulle righe con peso 1."""
    n_tr = w.sum(axis=1)
    mu = (w @ x) / n_tr[:, None]
    centered = x[None, :, :] - mu[:, None, :]
    var = np.einsum("fn,fnp->fp", w, centered**2) / n_tr[:, None]
    sd = np.sqrt(var)
    sd[sd < 1e-12] = 1.0
    return mu, sd, centered


def standardize_weighted(x: np.ndarray, w: np.ndarray) -> np.ndarray:
    """Standardizza x (n, p) con media e sd calcolate SOLO sulle righe con peso 1, per ogni fold.

    w: (F, n) pesi 0/1 del training. Restituisce z (F, n, p): le righe di test (peso 0)
    sono trasformate con i parametri del training, senza contribuire ai parametri.
    """
    _, sd, centered = _weighted_mean_sd(x, w)
    return centered / sd[:, None, :]


def _with_intercept(z: np.ndarray) -> np.ndarray:
    return np.concatenate([np.ones(z.shape[:2] + (1,)), z], axis=2)


def _logloss(y: np.ndarray, eta: np.ndarray) -> np.ndarray:
    return np.logaddexp(0.0, eta) - y * eta


def lopo_train_weights(n: int) -> np.ndarray:
    """Pesi di training per il LOPO esterno: la riga i esclude il solo paziente i."""
    return 1.0 - np.eye(n)


def pair_train_weights(n: int, a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Pesi di training per i fit interni: la riga c esclude i pazienti a[c] e b[c]."""
    w = np.ones((len(a), n))
    rows = np.arange(len(a))
    w[rows, a] = 0.0
    w[rows, b] = 0.0
    return w


def nested_lopo_scores(
    x: np.ndarray, y: np.ndarray, lam_grid, max_cells: int = 4_000_000
) -> tuple[np.ndarray, np.ndarray]:
    """Rischio previsto per ogni paziente: LOPO esterno, lambda scelto con LOPO annidato.

    Per il paziente i (test esterno): il lambda si sceglie solo sugli altri pazienti, con LOPO
    interno (si lascia fuori j != i e si addestra sugli altri N-2), minimizzando la log-loss.
    Standardizzazione e fit usano solo il training. Il fit "fuori {i, j}" e' lo stesso per
    la coppia (i fuori, j interno) e (j fuori, i interno): si calcola una volta per coppia.
    Restituisce (punteggi, indice del lambda scelto per ciascun paziente).
    """
    x = np.asarray(x, dtype=float)
    y = np.asarray(y, dtype=float)
    n, p = x.shape
    lams = [float(v) for v in lam_grid]
    n_lam = len(lams)
    inner_loss = np.zeros((n, n_lam))
    ia, ib = np.triu_indices(n, 1)
    chunk = max(1, max_cells // (n * (p + 1)))
    for start in range(0, len(ia), chunk):
        a, b = ia[start : start + chunk], ib[start : start + chunk]
        w = pair_train_weights(n, a, b)
        xa = _with_intercept(standardize_weighted(x, w))
        rows = np.arange(len(a))
        for li, lam in enumerate(lams):
            beta = _newton_l2(xa, y, w, _penalty(lam, p), max_iter=40)
            eta_a = (xa[rows, a] * beta).sum(axis=1)  # paziente a, previsto dal modello senza a e b
            eta_b = (xa[rows, b] * beta).sum(axis=1)
            # fold esterno a: il paziente interno lasciato fuori e' b; fold esterno b: e' a
            inner_loss[:, li] += np.bincount(a, weights=_logloss(y[b], eta_b), minlength=n)
            inner_loss[:, li] += np.bincount(b, weights=_logloss(y[a], eta_a), minlength=n)
    # a parita' di log-loss si preferisce il lambda piu' grande (piu' regolarizzato)
    best = n_lam - 1 - np.argmin(np.round(inner_loss, 12)[:, ::-1], axis=1)

    w_out = lopo_train_weights(n)
    xa_out = _with_intercept(standardize_weighted(x, w_out))
    idx = np.arange(n)
    eta_all = np.empty((n, n_lam))
    for li, lam in enumerate(lams):
        beta = _newton_l2(xa_out, y, w_out, _penalty(lam, p), max_iter=40)
        eta_all[:, li] = (xa_out[idx, idx] * beta).sum(axis=1)
    return _sigmoid(eta_all[idx, best]), best


# --------------------------------------------------------------------------- validazione a 5 fold (sezione 8)
@dataclass(frozen=True)
class CVFolds:
    """Fold esterni e interni di tutte le ripetizioni. C = ripetizioni x fold esterni.

    Ogni riga e' un paziente: lo split e' per paziente per costruzione.
    outer_train (C, n) pesi 0/1; outer_test (C, n) bool; inner_train (C, I, n) pesi 0/1 dei
    fold interni (annidati nel solo training esterno); inner_test (C, I, n) bool.
    """

    outer_train: np.ndarray
    outer_test: np.ndarray
    inner_train: np.ndarray
    inner_test: np.ndarray
    n_repeats: int


def stratified_folds(y: np.ndarray, n_folds: int, rng: np.random.Generator) -> np.ndarray:
    """Fold (0..n_folds-1) per paziente, stratificati per evento.

    Eventi e non-eventi si mescolano a caso e si assegnano con un unico contatore ciclico: gli
    eventi per fold e le dimensioni dei fold differiscono al massimo di 1. Le etichette dei fold
    sono permutate a caso, cosi' nessun fold riceve sempre i pazienti in piu'.
    """
    y = np.asarray(y)
    n = len(y)
    order = np.concatenate([rng.permutation(np.flatnonzero(y == 1)), rng.permutation(np.flatnonzero(y != 1))])
    labels = rng.permutation(n_folds)
    folds = np.empty(n, dtype=int)
    folds[order] = labels[np.arange(n) % n_folds]
    return folds


def cv_fold_weights(y: np.ndarray, n_folds: int, n_repeats: int, inner_folds: int, cv_seed: int) -> CVFolds:
    """Fold esterni (n_folds, ripetuti n_repeats volte con seed fissi) e fold interni sul training.

    Ripetizione r: seme SeedSequence([cv_seed, r]); i fold interni del fold esterno f usano
    SeedSequence([cv_seed, r, 1 + f]) e contengono SOLO pazienti del training di quel fold.
    Dipende solo da y (per la stratificazione) e dai semi, non dai predittori.
    """
    y = np.asarray(y)
    n = len(y)
    c_tot = n_repeats * n_folds
    outer_train = np.ones((c_tot, n))
    inner_train = np.zeros((c_tot, inner_folds, n))
    inner_test = np.zeros((c_tot, inner_folds, n), dtype=bool)
    for r in range(n_repeats):
        folds = stratified_folds(y, n_folds, np.random.default_rng(np.random.SeedSequence([cv_seed, r])))
        for f in range(n_folds):
            c = r * n_folds + f
            outer_train[c, folds == f] = 0.0
            tr = np.flatnonzero(folds != f)
            rng_in = np.random.default_rng(np.random.SeedSequence([cv_seed, r, 1 + f]))
            inner = stratified_folds(y[tr], inner_folds, rng_in)
            for i in range(inner_folds):
                held = tr[inner == i]
                inner_train[c, i, tr] = 1.0
                inner_train[c, i, held] = 0.0
                inner_test[c, i, held] = True
    return CVFolds(outer_train, outer_train == 0.0, inner_train, inner_test, n_repeats)


def _lambda_penalties(lams: list[float], n_fits: int, p: int) -> np.ndarray:
    """Penalita' (L * n_fits, p + 1): i fit sono ordinati per lambda, poi per fold."""
    return np.repeat(np.array([_penalty(lam, p) for lam in lams]), n_fits, axis=0)


def cv_scores_given_folds(
    x: np.ndarray, y: np.ndarray, folds: CVFolds, lam_grid
) -> tuple[np.ndarray, np.ndarray]:
    """Punteggio per paziente dai fold dati: predittore lineare SENZA intercetta, medio sulle ripetizioni.

    Per ogni fold esterno: (1) standardizzazione con media e sd del solo training; (2) lambda scelto
    minimizzando la log-loss dei fold interni (solo sul training); in caso di parita' vince il
    lambda piu' grande; (3) fit sul training con quel lambda; (4) punteggio dei pazienti di test
    = sum_q (beta_q / sd_q) * x_q, senza intercetta ne' centratura: dipendono dal fold e
    renderebbero i punteggi di fold diversi non confrontabili. Ogni paziente e' nel test una volta
    per ripetizione: il suo punteggio e' la media delle ripetizioni.
    Fold con una sola classe nel training o beta = 0: punteggio 0 (nessuna informazione).
    Restituisce (punteggi, indice del lambda scelto per ogni fold esterno).
    """
    x = np.asarray(x, dtype=float)
    y = np.asarray(y, dtype=float)
    n, p = x.shape
    lams = sorted(float(v) for v in lam_grid)
    n_lam = len(lams)
    c_tot, n_in = folds.inner_train.shape[:2]

    # fit interni: tutti i lambda e tutti i fold in un unico batch
    w_in = folds.inner_train.reshape(c_tot * n_in, n)
    xa_in = np.tile(_with_intercept(standardize_weighted(x, w_in)), (n_lam, 1, 1))
    beta_in = _newton_l2(xa_in, y, np.tile(w_in, (n_lam, 1)), _lambda_penalties(lams, c_tot * n_in, p))
    eta_in = np.einsum("fnq,fq->fn", xa_in, beta_in).reshape(n_lam, c_tot, n_in, n)
    inner_loss = (_logloss(y, eta_in) * folds.inner_test[None]).sum(axis=(2, 3))  # (lambda, C)
    best = n_lam - 1 - np.argmin(np.round(inner_loss, 12)[::-1], axis=0)  # parita': lambda piu' grande

    # fit esterni sul training
    w_out = folds.outer_train
    _, sd, centered = _weighted_mean_sd(x, w_out)
    xa_out = np.tile(_with_intercept(centered / sd[:, None, :]), (n_lam, 1, 1))
    beta_out = _newton_l2(xa_out, y, np.tile(w_out, (n_lam, 1)), _lambda_penalties(lams, c_tot, p))
    chosen = beta_out.reshape(n_lam, c_tot, p + 1)[best, np.arange(c_tot)]
    coef = chosen[:, 1:] / sd  # coefficienti sulla scala originale; l'intercetta non entra
    fold_scores = coef @ x.T  # (C, n)
    return (fold_scores * folds.outer_test).sum(axis=0) / folds.n_repeats, best


def cv_scores(
    x: np.ndarray, y: np.ndarray, lam_grid, *, n_folds: int = 5, n_repeats: int = 20,
    inner_folds: int = 5, cv_seed: int = 0,
) -> tuple[np.ndarray, np.ndarray]:
    """Validazione esterna a n_folds fold per paziente, stratificata, ripetuta, con seed fissi."""
    folds = cv_fold_weights(y, n_folds, n_repeats, inner_folds, cv_seed)
    return cv_scores_given_folds(x, y, folds, lam_grid)


# --------------------------------------------------------------------------- politiche e test
def budget_size(n: int, frac: float) -> int:
    """B = round(frac * N), almeno 1 (arrotondamento classico, 0,5 verso l'alto)."""
    return max(1, int(math.floor(frac * n + 0.5)))


def _select_top(values: np.ndarray, budget: int, tie_key: np.ndarray | None) -> np.ndarray:
    """Rosso (1) ai `budget` pazienti con il valore piu' ALTO.

    A parita' di valore: ordine casuale dato da `tie_key` (un numero casuale per paziente, da seed
    fisso); senza `tie_key` l'ordine dei pazienti (stabile, solo per compatibilita' e test).
    """
    values = np.asarray(values, dtype=float)
    order = np.argsort(-values, kind="stable") if tie_key is None else np.lexsort((tie_key, -values))
    flags = np.zeros(len(values), dtype=int)
    flags[order[:budget]] = 1
    return flags


def flag_lowest(values: np.ndarray, budget: int, tie_key: np.ndarray | None = None) -> np.ndarray:
    """Rosso (1) ai `budget` pazienti con il valore piu' basso (pareggi: vedi _select_top)."""
    return _select_top(-np.asarray(values, dtype=float), budget, tie_key)


def flag_highest(values: np.ndarray, budget: int, tie_key: np.ndarray | None = None) -> np.ndarray:
    """Rosso (1) ai `budget` pazienti con il valore piu' alto (pareggi: vedi _select_top)."""
    return _select_top(values, budget, tie_key)


def boundary_tie_size(values: np.ndarray, budget: int) -> int:
    """Quanti pazienti hanno il valore della soglia se il pareggio attraversa il confine di B, altrimenti 0.

    Se > 0 il pareggio DECIDE la selezione: chi entra tra i B dipende dallo spareggio, non dai valori.
    `values` e' il punteggio in cui piu' alto = rosso (per il margine si passa -P1).
    """
    v = np.sort(np.asarray(values, dtype=float))[::-1]
    if budget >= len(v) or v[budget - 1] != v[budget]:
        return 0
    return int((v == v[budget - 1]).sum())


def flag_random(n: int, budget: int, rng: np.random.Generator) -> np.ndarray:
    flags = np.zeros(n, dtype=int)
    flags[rng.choice(n, size=budget, replace=False)] = 1
    return flags


def policy_flags(
    p1: np.ndarray, model_scores: np.ndarray, budget: int, rng: np.random.Generator | None = None,
    p3: np.ndarray | None = None, tie_key: np.ndarray | None = None,
) -> dict[str, np.ndarray]:
    """Le politiche a pari budget: casuale (se c'e' rng), livello (se c'e' p3: P3 piu' alto),
    margine (P1 piu' basso), modello (punteggio piu' alto)."""
    out = {"margine": flag_lowest(p1, budget, tie_key), "modello": flag_highest(model_scores, budget, tie_key)}
    if p3 is not None:
        out["livello"] = flag_highest(p3, budget, tie_key)
    if rng is not None:
        out["casuale"] = flag_random(len(p1), budget, rng)
    return out


def perm_pvalue(n_ge: int, n_perm: int) -> float:
    """p-value di permutazione (sezione 10): (1 + permutazioni con resa >= osservata) / (1 + n_perm)."""
    return (1 + int(n_ge)) / (1 + int(n_perm))


def hypergeom_pvalue(tp: int, n: int, n_events: int, budget: int) -> float:
    """P(TP' >= tp) con TP' ~ Ipergeometrica(N, K, B): scelta casuale di B pazienti su N.

    Unilaterale. Se non ci sono eventi o sono tutti eventi il test non e' calcolabile e
    non puo' rifiutare: p = 1.
    """
    if n_events <= 0 or n_events >= n:
        return 1.0
    return float(hypergeom.sf(tp - 1, n, n_events, budget))


def random_expectation(n: int, n_events: int, budget: int) -> dict[str, float]:
    """Valore atteso (analitico) delle metriche della politica casuale a budget B.

    I denominatori sono fissi, quindi il valore atteso del rapporto e' il rapporto dei valori attesi.
    """
    tp = budget * n_events / n
    fp = budget - tp
    fn = n_events - tp
    tn = n - n_events - fp

    def ratio(a: float, d: float) -> float:
        return a / d if d else float("nan")

    return {
        "tp": tp, "fp": fp, "fn": fn, "tn": tn,
        "resa": ratio(tp, budget),
        "falsa_rassicurazione": ratio(fn, n - budget),
        "eventi_persi": ratio(fn, n_events),
        "falsi_allarmi": ratio(fp, n - n_events),
    }


def auc_score(y: np.ndarray, score: np.ndarray) -> float:
    """AUC (Mann-Whitney) di `score` per l'evento y; NaN se manca una delle due classi.

    Diagnostica univariata per capire QUALE predittore porta informazione: non e' l'AUC
    preregistrata (sezione 9), che si calcola sui dati veri con il suo intervallo.
    """
    y = np.asarray(y).astype(bool)
    n1, n0 = int(y.sum()), int((~y).sum())
    if n1 == 0 or n0 == 0:
        return float("nan")
    ranks = rankdata(score)
    return float((ranks[y].sum() - n1 * (n1 + 1) / 2) / (n1 * n0))


def wilson_interval(successes: float, n: int, z: float = 1.96) -> tuple[float, float]:
    if n <= 0:
        return float("nan"), float("nan")
    p = successes / n
    denom = 1.0 + z**2 / n
    centre = (p + z**2 / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z**2 / (4 * n**2)) / denom
    return max(0.0, centre - half), min(1.0, centre + half)


# --------------------------------------------------------------------------- un dataset -> record
def model_scores_for(x: np.ndarray, y: np.ndarray, ctx: dict) -> np.ndarray:
    """Punteggi del modello secondo ctx["validation"]; dataset degeneri: punteggi uguali.

    "cv": 5 fold per paziente ripetuti, punteggio lineare senza intercetta (sezione 8).
    "lopo": leave-one-patient-out annidato, solo per confronto (probabilita' con intercetta).
    """
    if y.sum() in (0, len(y)):
        return np.zeros(len(y))
    if ctx["validation"] == VALIDATION_LOPO:
        return nested_lopo_scores(x, y, ctx["lam_grid"])[0]
    return cv_scores(
        x, y, ctx["lam_grid"], n_folds=ctx["cv_folds"], n_repeats=ctx["cv_repeats"],
        inner_folds=ctx["inner_folds"], cv_seed=ctx["cv_seed"],
    )[0]


def evaluate_dataset(data: SimData, cell: Cell, ctx: dict, tie_seed=None) -> list[dict]:
    """Per ogni k e ogni budget: metriche e test delle tre politiche su un dataset."""
    n, alpha = ctx["n_patients"], ctx["alpha"]
    rows: list[dict] = []
    tie_rng = None if tie_seed is None else np.random.default_rng(tie_seed)
    for k in ctx["ks"]:
        tie_key = None if tie_rng is None else tie_rng.random(n)  # spareggio casuale da seed fisso
        y = compute_endpoint(data.dss[:, 0, :], data.dss[:, 1, :], k, cell.sigma_rep, ctx["delta_z"])
        n_events = int(y.sum())
        degenerate = n_events in (0, n)
        x = make_features(data, cell, k)
        scores = model_scores_for(x, y, ctx)
        nan = float("nan")
        aucs = {
            "auc_p1_basso": auc_score(y, -x[:, 0]),  # punteggio = -P1: margine basso = rischio alto
            "auc_p2": auc_score(y, x[:, 1]),
            "auc_p3": auc_score(y, x[:, 2]),
            "auc_p4": auc_score(y, x[:, 3]) if x.shape[1] > 3 else nan,
            "auc_modello": nan if degenerate else auc_score(y, scores),
        }
        for frac in ctx["fracs"]:
            budget = budget_size(n, frac)
            flags = policy_flags(x[:, 0], scores, budget, p3=x[:, 2], tie_key=tie_key)
            tie_n = {"livello": boundary_tie_size(x[:, 2], budget), "margine": boundary_tie_size(-x[:, 0], budget),
                     "modello": boundary_tie_size(scores, budget)}
            summ = {pol: metrics.summary(y, fl) for pol, fl in flags.items()}
            base = {
                "k": k, "budget_fraction": frac, "budget": budget,
                "n_events": n_events, "degenerate": float(degenerate), **aucs,
            }
            rows.append({**base, "policy": "casuale", **random_expectation(n, n_events, budget),
                         "p_value": np.nan, "reject": np.nan})
            for pol in ("livello", "margine", "modello"):
                s = summ[pol]
                pval = hypergeom_pvalue(s["tp"], n, n_events, budget)
                row = {**base, "policy": pol, **s, "p_value": pval, "reject": float(pval < alpha),
                       "tie_n": tie_n[pol], "tie_decides": float(tie_n[pol] > 0)}
                if pol == "modello":
                    row["diff_resa_vs_margine"] = s["resa"] - summ["margine"]["resa"]
                    row["beats_margin"] = float(s["tp"] > summ["margine"]["tp"])
                    row["tie_margin"] = float(s["tp"] == summ["margine"]["tp"])
                    # confronto con la regola semplice del livello (D9): il valore aggiunto richiede
                    # che il modello eguagli o superi P3
                    row["diff_resa_vs_livello"] = s["resa"] - summ["livello"]["resa"]
                    row["beats_level"] = float(s["tp"] > summ["livello"]["tp"])
                    row["tie_level"] = float(s["tp"] == summ["livello"]["tp"])
                    row["at_least_level"] = float(s["tp"] >= summ["livello"]["tp"])
                rows.append(row)
    return rows


# --------------------------------------------------------------------------- esecuzione
def tie_seed_for(ctx: dict, cell_idx: int, sim: int) -> np.random.SeedSequence:
    """Seed fisso dello spareggio dei punteggi uguali: dipende solo da (seed, scenario, cella, sim)."""
    return np.random.SeedSequence([ctx["seed"], ctx["scenario_idx"], cell_idx, sim, 4242])


def _task_power(payload) -> list[dict]:
    ctx, cell, cell_idx, sims = payload
    out: list[dict] = []
    for sim in sims:
        data = simulate_cell_dataset(ctx, cell, cell_idx, sim)
        for row in evaluate_dataset(data, cell, ctx, tie_seed=tie_seed_for(ctx, cell_idx, sim)):
            row.update(cell_idx=cell_idx, scenario=cell.scenario, tau=cell.tau,
                       sigma_rep=cell.sigma_rep, rho=cell.rho, sim=sim)
            out.append(row)
    return out


def _task_perm(payload) -> dict:
    """Controllo con permutazioni su un dataset: l'INTERA pipeline si rifa' su etichette permutate."""
    ctx, cell, cell_idx, sim, k, frac, n_perm = payload
    n = ctx["n_patients"]
    data = simulate_cell_dataset(ctx, cell, cell_idx, sim)
    y = compute_endpoint(data.dss[:, 0, :], data.dss[:, 1, :], k, cell.sigma_rep, ctx["delta_z"])
    n_events, budget = int(y.sum()), budget_size(n, frac)
    base = {"cell_idx": cell_idx, "scenario": cell.scenario, "tau": cell.tau,
            "sigma_rep": cell.sigma_rep, "rho": cell.rho, "k": k, "budget_fraction": frac,
            "budget": budget, "sim": sim, "n_events": n_events}
    if n_events in (0, n):  # evento assente o presente in tutti: test non calcolabile, non puo' rifiutare
        return {**base, "p_hyper": 1.0, "p_perm": 1.0}
    x = make_features(data, cell, k)
    tie_key = np.random.default_rng(tie_seed_for(ctx, cell_idx, sim)).random(n)  # stesso spareggio per osservato e permutazioni
    tp_obs = int(y[flag_highest(model_scores_for(x, y, ctx), budget, tie_key) == 1].sum())
    rng = np.random.default_rng(np.random.SeedSequence([ctx["seed"], ctx["scenario_idx"], cell_idx, sim, 777]))
    ge = 0
    for _ in range(n_perm):
        # le etichette si permutano tra pazienti e si rifa' l'INTERA pipeline (fold, lambda, fit, selezione)
        yp = rng.permutation(y)
        tp_p = int(yp[flag_highest(model_scores_for(x, yp, ctx), budget, tie_key) == 1].sum())
        ge += tp_p >= tp_obs
    return {**base, "p_hyper": hypergeom_pvalue(tp_obs, n, n_events, budget),
            "p_perm": perm_pvalue(ge, n_perm)}


def _run_tasks(func, payloads: list, workers: int, label: str) -> list:
    """Esegue i task (in ordine) in un solo processo o con ProcessPoolExecutor."""
    t0, results = time.time(), []
    step = max(1, len(payloads) // 10)
    if workers <= 1:
        it = map(func, payloads)
        pool = None
    else:
        pool = ProcessPoolExecutor(max_workers=workers)
        it = pool.map(func, payloads)
    try:
        for i, res in enumerate(it, 1):
            results.append(res)
            if i % step == 0 or i == len(payloads):
                print(f"  [{label}] {i}/{len(payloads)} task, {time.time() - t0:.0f}s", flush=True)
    finally:
        if pool is not None:
            pool.shutdown()
    return results


def _chunks(items: list, size: int) -> list[list]:
    return [items[i : i + size] for i in range(0, len(items), size)]


# --------------------------------------------------------------------------- aggregazione
AUC_COLUMNS = ["auc_p1_basso", "auc_p2", "auc_p3", "auc_p4", "auc_modello"]
KEYS = ["scenario", "tau", "sigma_rep", "rho", "k", "budget_fraction", "budget", "policy"]


LEVEL_COLUMNS = ["diff_resa_vs_livello", "beats_level", "tie_level", "at_least_level"]


def _const_columns(df: pd.DataFrame, ctx: dict) -> pd.DataFrame:
    """Colonne costanti di ogni output: marchio SINTETICO, stato dei conteggi, scenario, validazione."""
    consts = [
        ("dataset", DATASET_TAG), ("synthetic", True), ("placeholder_counts", ctx["placeholder_counts"]),
        ("counts_status", ctx["counts_status"]), ("count_scenario", ctx["count_scenario"]),
        ("mode", ctx["mode"]), ("n_patients", ctx["n_patients"]), ("samples_per_patient", ctx["n_samples"]),
        ("n_drugs_common", ctx["n_drugs"]), ("validation", ctx["validation"]),
    ]
    for i, (name, value) in enumerate(consts):
        df.insert(i, name, value)
    return df


def aggregate_power(rec: pd.DataFrame, ctx: dict) -> pd.DataFrame:
    """Una riga per cella x k x B x politica. Potenza = quota di dataset con p < alpha."""
    for col in ("diff_resa_vs_margine", "beats_margin", "tie_margin", "tie_n", "tie_decides", *LEVEL_COLUMNS, *AUC_COLUMNS):
        if col not in rec:
            rec[col] = np.nan
    g = rec.groupby(KEYS, sort=False)
    out = g.agg(
        n_sim=("sim", "size"),
        n_events_mean=("n_events", "mean"),
        n_degenerate=("degenerate", "sum"),
        power=("reject", "mean"),
        tp_mean=("tp", "mean"), fp_mean=("fp", "mean"), fn_mean=("fn", "mean"), tn_mean=("tn", "mean"),
        resa_mean=("resa", "mean"),
        eventi_persi_mean=("eventi_persi", "mean"),
        falsa_rassicurazione_mean=("falsa_rassicurazione", "mean"),
        falsi_allarmi_mean=("falsi_allarmi", "mean"),
        diff_resa_vs_margine=("diff_resa_vs_margine", "mean"),
        quota_modello_supera_margine=("beats_margin", "mean"),
        quota_pari_margine=("tie_margin", "mean"),
        quota_pareggio_decisivo=("tie_decides", "mean"),
        pazienti_in_pareggio_medi=("tie_n", "mean"),
        diff_resa_vs_livello=("diff_resa_vs_livello", "mean"),
        quota_modello_supera_livello=("beats_level", "mean"),
        quota_pari_livello=("tie_level", "mean"),
        quota_modello_almeno_livello=("at_least_level", "mean"),
        **{col: (col, "mean") for col in AUC_COLUMNS},
    ).reset_index()
    out["n_degenerate"] = out["n_degenerate"].astype(int)
    out["prevalence_mean"] = out["n_events_mean"] / ctx["n_patients"]
    ci = [wilson_interval(p * n, n) if not np.isnan(p) else (np.nan, np.nan)
          for p, n in zip(out["power"], out["n_sim"])]
    out["power_lo"] = [c[0] for c in ci]
    out["power_hi"] = [c[1] for c in ci]
    return _const_columns(out, ctx)


MDE_POLICIES = ("livello", "margine", "modello")


def compute_mde(power_df: pd.DataFrame, threshold: float, policies=MDE_POLICIES) -> pd.DataFrame:
    """Effetto minimo rilevabile: il rho piu' basso della griglia con potenza >= soglia.

    Per ogni (scenario, tau, sigma_rep, k, B, politica livello/margine/modello). `mde_monotone` e'
    falso se un rho piu' alto torna sotto soglia. Il controllo negativo non ha un MDE.
    """
    sub = power_df[power_df["policy"].isin(list(policies)) & (power_df["scenario"] != SCENARIO_NEG)]
    keys = ["scenario", "tau", "sigma_rep", "k", "budget_fraction", "budget", "policy"]
    rows = []
    for key, grp in sub.groupby(keys, sort=False):
        grp = grp.sort_values("rho")
        rho, pw = grp["rho"].to_numpy(), grp["power"].to_numpy()
        ok = np.flatnonzero(pw >= threshold)
        rec = dict(zip(keys, key))
        if ok.size:
            first = ok[0]
            rec.update(mde_rho=float(rho[first]), mde_status="raggiunto",
                       mde_monotone=bool((pw[first:] >= threshold).all()), power_at_mde=float(pw[first]))
        else:
            rec.update(mde_rho=np.nan, mde_status="non raggiunto", mde_monotone=True, power_at_mde=np.nan)
        rec.update(power_threshold=threshold, n_rho_levels=int(len(rho)), n_sim=int(grp["n_sim"].iloc[0]))
        rows.append(rec)
    return pd.DataFrame(rows)


def aggregate_perm_check(rec: pd.DataFrame, ctx: dict, n_perm: int) -> pd.DataFrame:
    """Per cella: potenza con ipergeometrica e con permutazione sugli stessi dataset."""
    alpha = ctx["alpha"]
    keys = ["scenario", "tau", "sigma_rep", "rho", "k", "budget_fraction", "budget"]
    rows = []
    for key, grp in rec.groupby(keys, sort=False):
        ph, pp = grp["p_hyper"].to_numpy(), grp["p_perm"].to_numpy()
        nd = len(grp)
        lo_h, hi_h = wilson_interval(float((ph < alpha).sum()), nd)
        lo_p, hi_p = wilson_interval(float((pp < alpha).sum()), nd)
        rows.append({
            **dict(zip(keys, key)),
            "policy": "modello",
            "n_datasets": nd, "n_perm": n_perm, "p_min_possible": perm_pvalue(0, n_perm),
            "power_hyper": float((ph < alpha).mean()), "power_hyper_lo": lo_h, "power_hyper_hi": hi_h,
            "power_perm": float((pp < alpha).mean()), "power_perm_lo": lo_p, "power_perm_hi": hi_p,
            "n_events_mean": float(grp["n_events"].mean()),
            "p_hyper_mean": float(ph.mean()), "p_perm_mean": float(pp.mean()),
            "mean_abs_diff_p": float(np.abs(ph - pp).mean()),
            "decision_agreement": float(((ph < alpha) == (pp < alpha)).mean()),
        })
    return _const_columns(pd.DataFrame(rows), ctx)


def perm_power_frame(perm_df: pd.DataFrame) -> pd.DataFrame:
    """Potenza da permutazione in formato 'potenza per cella', per riusare compute_mde."""
    out = perm_df.copy()
    out["policy"] = "modello_perm"
    out["power"] = out["power_perm"]
    out["n_sim"] = out["n_datasets"]
    return out


# --------------------------------------------------------------------------- curva di potenza vs N (SINTETICA)
# DATI SINTETICI. Stesso modello generativo di run(), con N pazienti variabile. Livello (P3) e margine
# sono regole che NON dipendono dalle etichette: per loro il test ipergeometrico e' valido. Il modello
# usa la permutazione dell'INTERA pipeline, su un numero ridotto di dataset e di celle (tempo).
SS_SEED_TAG = 5150  # etichetta di dominio dei semi: questi dataset non coincidono con quelli di run()
SS_NEG_NAME = "controllo_negativo"
SS_RULES = ("livello", "margine")
POLICY_P4 = "regola_p4"  # regola semplice basata solo su P4 (scenario biomarcatore)
SS_POLICIES = ("livello", "margine", "modello")
SS_HYPER = "ipergeometrica"
SS_PERM = "permutazione"
ST_REACHED, ST_NOT_REACHED, ST_NOT_EVALUATED = "raggiunto", "non raggiunto", "non valutato"
SS_WARNING = (
    "SEGNAPOSTO: ogni N vale solo per questa cella (tau, sigma_rep) e questo rho: "
    "'se l'effetto fosse questo, servirebbero N pazienti'. Non e' una stima dell'effetto reale."
)
SS_NEG_WARNING = "CONTROLLO NEGATIVO: predittori di puro rumore; la potenza deve restare vicino ad alfa o sotto."
SS_POWER_COLUMNS = [
    "scenario", "cell", "tau", "sigma_rep", "rho", "k", "budget_fraction", "n_patients", "budget",
    "policy", "method", "n_datasets", "planned_datasets", "stopped_for_time", "n_perm", "n_degenerate",
    "power", "power_lo", "power_hi", "prevalence_mean", "quota_pareggio_decisivo", "perm_done_mean",
    "power_hyper_diagnostico",
]


@dataclass(frozen=True)
class SSCell:
    """Una cella di eterogeneita' e rumore con il suo nome e il suo indice (entra nel seme)."""

    name: str
    idx: int
    scenario: str
    tau: float
    sigma_rep: float

    def at(self, rho: float) -> Cell:
        return Cell(self.scenario, self.tau, self.sigma_rep, rho)


def ss_cells(ss: dict) -> list[SSCell]:
    return [SSCell(str(c["name"]), i, SCENARIO_PROFILE, float(c["tau"]), float(c["sigma_rep"]))
            for i, c in enumerate(ss["cells"])]


def ss_negative_cell(ss: dict) -> SSCell | None:
    nc = ss.get("negative_control", {})
    if not nc.get("enabled", False):
        return None
    return SSCell(SS_NEG_NAME, len(ss["cells"]), SCENARIO_NEG, float(nc["tau"]), float(nc["sigma_rep"]))


def perm_stop_count(n_perm: int, alpha: float) -> int:
    """Il piu' piccolo numero di permutazioni con resa >= osservata per cui p NON e' < alfa.

    Raggiunto questo numero il rifiuto non e' piu' possibile: si puo' smettere di permutare senza
    cambiare la decisione (con n_perm = 99 e alfa = 0,05 vale 4: p = 5/100 non e' < 0,05).
    """
    c = 0
    while perm_pvalue(c, n_perm) < alpha:
        c += 1
    return c


def validate_sample_size_config(cfg: dict) -> None:
    """Errori chiari prima di spendere tempo di calcolo."""
    ss = cfg.get("sample_size")
    if not ss:
        raise ValueError("manca il blocco sample_size nel config")
    scen = {sc["name"]: sc for sc in cfg["count_scenarios"]}
    if ss["count_scenario"] not in scen:
        raise ValueError("sample_size.count_scenario non e' tra i count_scenarios")
    n_drugs, model = int(scen[ss["count_scenario"]]["n_drugs_common"]), cfg["model"]
    ns = [int(n) for n in ss["n_grid"]]
    if len(set(ns)) != len(ns) or min(ns) < max(4, int(model.get("cv_folds", 5))):
        raise ValueError("n_grid: valori distinti e almeno un paziente per fold")
    if any(int(k) >= n_drugs for k in ss["k"]):
        raise ValueError("sample_size.k: servono piu' farmaci comuni di k")
    if not 0 < float(ss["budget_fraction"]) < 1:
        raise ValueError("sample_size.budget_fraction tra 0 e 1 (esclusi)")
    if not all(0 <= float(r) < RHO_MAX_EXCLUSIVE for r in ss["rho"]):
        raise ValueError("sample_size.rho deve stare in [0, 1)")
    names = [str(c["name"]) for c in ss["cells"]]
    if len(set(names)) != len(names) or SS_NEG_NAME in names:
        raise ValueError("sample_size.cells: nomi unici e diversi da 'controllo_negativo'")
    if any(float(c["tau"]) <= 0 or float(c["sigma_rep"]) <= 0 for c in ss["cells"]):
        raise ValueError("sample_size.cells: tau e sigma_rep positivi")
    mdl = ss["model"]
    if not set(mdl["cells"]) <= set(names):
        raise ValueError("sample_size.model.cells: celle sconosciute")
    if int(mdl["block_size"]) < 1 or int(mdl["max_datasets"]) < int(mdl["block_size"]):
        raise ValueError("sample_size.model: block_size >= 1 e max_datasets >= block_size")
    if perm_pvalue(0, int(mdl["n_perm"])) >= float(cfg["test"]["alpha"]):
        raise ValueError("sample_size.model.n_perm troppo basso: con 0 eccedenze p non e' sotto alfa")
    if int(ss["hypergeometric"]["n_datasets"]) < 1:
        raise ValueError("sample_size.hypergeometric.n_datasets >= 1")
    tb = ss["time_budget_min"]
    if float(tb["model"]) <= 0 or float(tb["total"]) <= 0:
        raise ValueError("sample_size.time_budget_min: minuti positivi")


def ss_context(cfg: dict) -> dict:
    """Contesto della curva vs N: conteggi (campioni, farmaci) dallo scenario scelto; N viene dalla griglia."""
    ss = cfg["sample_size"]
    names = [sc["name"] for sc in cfg["count_scenarios"]]
    ctx = make_context(cfg, "quick", names.index(ss["count_scenario"]))
    ctx.update(mode="sample_size", ks=[int(k) for k in ss["k"]], ss_frac=float(ss["budget_fraction"]))
    return ctx


def _ss_seed(ctx: dict, n: int, cell_idx: int, rho_idx: int, sim: int, *extra: int) -> np.random.SeedSequence:
    return np.random.SeedSequence([ctx["seed"], SS_SEED_TAG, n, cell_idx, rho_idx, sim, *extra])


def simulate_ss_dataset(ctx: dict, cell: Cell, n: int, cell_idx: int, rho_idx: int, sim: int) -> SimData:
    """Dataset `sim` della configurazione (N, cella, rho): il seme dipende solo da questi indici."""
    return simulate_dataset(
        np.random.default_rng(_ss_seed(ctx, n, cell_idx, rho_idx, sim)),
        n_patients=n, n_samples=ctx["n_samples"], n_drugs=ctx["n_drugs"], tau=cell.tau,
        sigma_rep=cell.sigma_rep, rho=cell.rho, structure=ctx["structure"],
        metadata_scenario=cell.scenario == SCENARIO_META,
    )


def ss_tie_seed(ctx: dict, n: int, cell_idx: int, rho_idx: int, sim: int) -> np.random.SeedSequence:
    return _ss_seed(ctx, n, cell_idx, rho_idx, sim, 4242)


def ss_tie_keys(ctx: dict, n: int, cell_idx: int, rho_idx: int, sim: int) -> dict[int, np.ndarray]:
    """Spareggio casuale da seed fisso, una chiave per k (stesso ordine di evaluate_dataset)."""
    rng = np.random.default_rng(ss_tie_seed(ctx, n, cell_idx, rho_idx, sim))
    return {k: rng.random(n) for k in ctx["ks"]}


def ss_hyper_dataset(ctx: dict, cell: Cell, n: int, cell_idx: int, rho_idx: int, sim: int) -> list[dict]:
    """Livello (P3 piu' alto) e margine (P1 piu' basso) con p-value ipergeometrico, per ogni k."""
    data = simulate_ss_dataset(ctx, cell, n, cell_idx, rho_idx, sim)
    ties = ss_tie_keys(ctx, n, cell_idx, rho_idx, sim)
    budget, out = budget_size(n, ctx["ss_frac"]), []
    for k in ctx["ks"]:
        y = compute_endpoint(data.dss[:, 0, :], data.dss[:, 1, :], k, cell.sigma_rep, ctx["delta_z"])
        n_events, x = int(y.sum()), make_features(data, cell, k)
        if cell.scenario == SCENARIO_META:  # biomarcatore: la regola semplice usa solo P4 (piu' alto = rischio)
            rules = {POLICY_P4: (flag_highest(x[:, 3], budget, ties[k]), boundary_tie_size(x[:, 3], budget))}
        else:
            rules = {
                "livello": (flag_highest(x[:, 2], budget, ties[k]), boundary_tie_size(x[:, 2], budget)),
                "margine": (flag_lowest(x[:, 0], budget, ties[k]), boundary_tie_size(-x[:, 0], budget)),
            }
        for pol, (flags, tie_n) in rules.items():
            tp = int(y[flags == 1].sum())
            pval = hypergeom_pvalue(tp, n, n_events, budget)
            rec = {"k": k, "policy": pol, "budget": budget, "n_events": n_events,
                   "degenerate": n_events in (0, n), "tp": tp, "p_value": pval,
                   "reject": pval < ctx["alpha"], "tie_n": tie_n}
            if pol == POLICY_P4:
                rec["auc_p4"] = auc_score(y, x[:, 3])  # diagnostica: discriminazione di P4 per l'evento
            out.append(rec)
    return out


def _task_ss_hyper(payload) -> list[dict]:
    """Tutti i dataset di una configurazione (cella, rho, N): conteggi per k e politica."""
    ctx, cell, name, cell_idx, rho_idx, n, n_sims = payload
    acc: dict[tuple, dict] = {}
    for sim in range(n_sims):
        for r in ss_hyper_dataset(ctx, cell, n, cell_idx, rho_idx, sim):
            a = acc.setdefault((r["k"], r["policy"]), {"budget": r["budget"], "n_reject": 0, "n_degenerate": 0,
                                                      "events": 0, "tie_decides": 0})
            if "auc_p4" in r and not math.isnan(r["auc_p4"]):
                a["auc_sum"], a["auc_n"] = a.get("auc_sum", 0.0) + r["auc_p4"], a.get("auc_n", 0) + 1
            a["n_reject"] += int(r["reject"])
            a["n_degenerate"] += int(r["degenerate"])
            a["events"] += r["n_events"]
            a["tie_decides"] += int(r["tie_n"] > 0)
    return [{"scenario": cell.scenario, "cell": name, "tau": cell.tau, "sigma_rep": cell.sigma_rep,
             "rho": cell.rho, "k": k, "policy": pol, "n_patients": n, "n_datasets": n_sims, **a}
            for (k, pol), a in acc.items()]


def ss_model_dataset(
    ctx: dict, cell: Cell, n: int, cell_idx: int, rho_idx: int, k: int, sim: int, n_perm: int,
    early_stop: bool = True,
) -> dict:
    """Modello su un dataset: permutazione dell'INTERA pipeline (fold, lambda, fit, selezione).

    Con early_stop si smette appena il rifiuto non e' piu' possibile (perm_stop_count): la decisione
    resta identica a quella del giro completo; il p esatto resta definito solo se il giro e' completo.
    """
    data = simulate_ss_dataset(ctx, cell, n, cell_idx, rho_idx, sim)
    budget = budget_size(n, ctx["ss_frac"])
    y = compute_endpoint(data.dss[:, 0, :], data.dss[:, 1, :], k, cell.sigma_rep, ctx["delta_z"])
    n_events = int(y.sum())
    out = {"k": k, "sim": sim, "n_events": n_events, "budget": budget, "perm_done": 0, "exceed": 0}
    if n_events in (0, n):  # evento assente o presente in tutti: test non calcolabile, non puo' rifiutare
        return {**out, "tp_obs": 0, "p_hyper": 1.0, "p_perm": 1.0, "reject": False}
    x = make_features(data, cell, k)
    tie_key = ss_tie_keys(ctx, n, cell_idx, rho_idx, sim)[k]  # stesso spareggio per osservato e permutazioni
    tp_obs = int(y[flag_highest(model_scores_for(x, y, ctx), budget, tie_key) == 1].sum())
    rng = np.random.default_rng(_ss_seed(ctx, n, cell_idx, rho_idx, sim, k, 777))
    stop_at, ge, done = perm_stop_count(n_perm, ctx["alpha"]), 0, 0
    for _ in range(n_perm):
        yp = rng.permutation(y)  # etichette permutate tra pazienti, intera pipeline rifatta
        tp_p = int(yp[flag_highest(model_scores_for(x, yp, ctx), budget, tie_key) == 1].sum())
        done += 1
        ge += int(tp_p >= tp_obs)
        if early_stop and ge >= stop_at:
            break
    return {**out, "tp_obs": tp_obs, "p_hyper": hypergeom_pvalue(tp_obs, n, n_events, budget),
            "p_perm": perm_pvalue(ge, n_perm) if done == n_perm else float("nan"),
            "perm_done": done, "exceed": ge, "reject": ge < stop_at}


def _task_ss_model(payload) -> dict:
    ctx, cell, name, cell_idx, rho_idx, n, k, sim, n_perm = payload
    rec = ss_model_dataset(ctx, cell, n, cell_idx, rho_idx, k, sim, n_perm)
    return {**rec, "scenario": cell.scenario, "cell": name, "tau": cell.tau, "sigma_rep": cell.sigma_rep,
            "rho": cell.rho, "n_patients": n}


def _ss_wilson(df: pd.DataFrame) -> pd.DataFrame:
    ci = [wilson_interval(p * n, n) for p, n in zip(df["power"], df["n_datasets"])]
    df["power_lo"], df["power_hi"] = [c[0] for c in ci], [c[1] for c in ci]
    return df


def aggregate_ss_hyper(rows: list[dict]) -> pd.DataFrame:
    """Una riga per cella x rho x k x N x politica (livello, margine): potenza ipergeometrica."""
    df = pd.DataFrame(rows)
    df["power"] = df["n_reject"] / df["n_datasets"]
    df["prevalence_mean"] = df["events"] / (df["n_datasets"] * df["n_patients"])
    df["quota_pareggio_decisivo"] = df["tie_decides"] / df["n_datasets"]
    df["method"], df["planned_datasets"], df["stopped_for_time"] = SS_HYPER, df["n_datasets"], False
    df["n_perm"] = df["perm_done_mean"] = df["power_hyper_diagnostico"] = np.nan
    if "auc_n" in df.columns:  # solo la regola P4 (scenario biomarcatore)
        df["auc_p4_mean"] = df["auc_sum"] / df["auc_n"]
        df = df.drop(columns=["auc_sum", "auc_n"])
    return _ss_wilson(df)


def aggregate_ss_model(records: list[dict], planned: int, n_perm: int, alpha: float) -> pd.DataFrame:
    """Una riga per cella x rho x k x N: potenza del modello con la permutazione (e, come diagnostica,
    quella che darebbe l'ipergeometrica, NON valida per il modello)."""
    keys = ["scenario", "cell", "tau", "sigma_rep", "rho", "k", "n_patients"]
    rows = []
    for key, g in pd.DataFrame(records).groupby(keys, sort=False):
        nd = len(g)
        rows.append({
            **dict(zip(keys, key)), "policy": "modello", "method": SS_PERM, "budget": int(g["budget"].iloc[0]),
            "n_datasets": nd, "planned_datasets": planned, "stopped_for_time": nd < planned, "n_perm": n_perm,
            "n_degenerate": int(g["n_events"].isin([0, int(key[-1])]).sum()),
            "power": float(g["reject"].mean()), "prevalence_mean": float(g["n_events"].mean() / key[-1]),
            "quota_pareggio_decisivo": np.nan, "perm_done_mean": float(g["perm_done"].mean()),
            "power_hyper_diagnostico": float((g["p_hyper"] < alpha).mean()),
        })
    return _ss_wilson(pd.DataFrame(rows))


def _ss_const_columns(df: pd.DataFrame, ctx: dict, frac: float) -> pd.DataFrame:
    """Colonne costanti: marchio SINTETICO, stato dei conteggi, avvertenza sul segnaposto."""
    df = df.copy()
    df["budget_fraction"] = frac
    warn = np.where(df["scenario"] == SCENARIO_NEG, SS_NEG_WARNING, SS_WARNING)
    consts = [("dataset", DATASET_TAG), ("synthetic", True), ("placeholder_counts", ctx["placeholder_counts"]),
              ("counts_status", ctx["counts_status"]), ("count_scenario", ctx["count_scenario"]),
              ("mode", ctx["mode"]), ("samples_per_patient", ctx["n_samples"]),
              ("n_drugs_common", ctx["n_drugs"]), ("validation", ctx["validation"]), ("avvertenza", warn)]
    for i, (name, value) in enumerate(consts):
        df.insert(i, name, value)
    return df


def _n_text(value) -> str:
    return "NA" if pd.isna(value) else str(int(value))


def _first_n(grp: pd.DataFrame, column: str, threshold: float):
    ok = np.flatnonzero(grp[column].to_numpy() >= threshold)
    return (int(grp["n_patients"].iloc[ok[0]]), int(ok[0])) if ok.size else (None, None)


def compute_n_min(
    power_df: pd.DataFrame, threshold: float, cells: list[SSCell], ks, rhos,
    policies=SS_POLICIES,
) -> pd.DataFrame:
    """N minimo (primo N della griglia) con potenza >= soglia, per politica x cella x k x rho.

    n_min: stima puntuale. n_min_prudente: primo N con il limite inferiore di Wilson >= soglia.
    NA = non raggiunto nella griglia; "non valutato" = combinazione non simulata (tempo).
    `monotone` e' falso se dopo il primo N raggiunto la potenza torna sotto soglia.
    """
    groups = {k: g.sort_values("n_patients") for k, g in power_df.groupby(["policy", "cell", "k", "rho"])}
    rows = []
    for pol in policies:
        for cell in cells:
            for k in ks:
                for rho in rhos:
                    grp = groups.get((pol, cell.name, int(k), float(rho)))
                    rec = {"policy": pol, "cell": cell.name, "tau": cell.tau, "sigma_rep": cell.sigma_rep,
                           "rho": float(rho), "k": int(k)}
                    if grp is None:
                        rows.append({**rec, "method": "", "n_min": None, "n_min_prudente": None,
                                     "status": ST_NOT_EVALUATED, "status_prudente": ST_NOT_EVALUATED,
                                     "monotone": None, "power_at_n_min": np.nan, "n_grid_max": np.nan,
                                     "power_at_n_grid_max": np.nan, "n_datasets": 0})
                        continue
                    n_min, i0 = _first_n(grp, "power", threshold)
                    n_pru, _ = _first_n(grp, "power_lo", threshold)
                    rows.append({
                        **rec, "method": grp["method"].iloc[0], "n_min": n_min, "n_min_prudente": n_pru,
                        "status": ST_REACHED if n_min is not None else ST_NOT_REACHED,
                        "status_prudente": ST_REACHED if n_pru is not None else ST_NOT_REACHED,
                        "monotone": True if i0 is None else bool((grp["power"].to_numpy()[i0:] >= threshold).all()),
                        "power_at_n_min": float(grp["power"].iloc[i0]) if i0 is not None else np.nan,
                        "n_grid_max": int(grp["n_patients"].max()),
                        "power_at_n_grid_max": float(grp["power"].iloc[-1]),
                        "n_datasets": int(grp["n_datasets"].min()),
                    })
    out = pd.DataFrame(rows)
    for col in ("n_min", "n_min_prudente"):
        out[col] = out[col].astype("Int64")
    out["n_min_testo"] = [ST_NOT_EVALUATED if s == ST_NOT_EVALUATED else _n_text(v)
                          for s, v in zip(out["status"], out["n_min"])]
    out["n_min_prudente_testo"] = [ST_NOT_EVALUATED if s == ST_NOT_EVALUATED else _n_text(v)
                                   for s, v in zip(out["status_prudente"], out["n_min_prudente"])]
    out["power_threshold"] = threshold
    return out  # l'avvertenza sul segnaposto la aggiunge _ss_const_columns


def n_min_markdown(nmin: pd.DataFrame, threshold: float | None = None) -> str:
    """Tabella markdown "N minimo per potenza 0,80": righe politica x k x rho, colonne le celle.

    Ogni cella: N minimo (N prudente tra parentesi). NA = non raggiunto nella griglia; n.v. = non valutato;
    * = la potenza torna sotto soglia a N piu' grandi. Costruita solo dal CSV: nessun numero a mano.
    """
    thr = float(nmin["power_threshold"].iloc[0]) if threshold is None else threshold
    cells = list(dict.fromkeys(nmin["cell"]))
    heads = {c: f"{c} (tau {g['tau'].iloc[0]:g}, sigma {g['sigma_rep'].iloc[0]:g})"
             for c, g in nmin.groupby("cell", sort=False)}
    lines = [f"**N minimo per potenza {thr:.2f}**".replace(".", ","),
             "", f"> {SS_WARNING}", "",
             "Ogni cella: N minimo (N prudente, con limite inferiore dell'IC di Wilson >= soglia, tra parentesi). "
             "NA = non raggiunto nella griglia; n.v. = non valutato (tempo); * = la potenza torna sotto soglia "
             "a N piu' grandi.", "",
             "| politica | k | rho | " + " | ".join(heads[c] for c in cells) + " |",
             "|---|---|---|" + "---|" * len(cells)]
    for (pol, k, rho), g in nmin.groupby(["policy", "k", "rho"], sort=False):
        cols = []
        for c in cells:
            r = g[g["cell"] == c].iloc[0]
            if r["status"] == ST_NOT_EVALUATED:
                cols.append("n.v.")
            elif r["status"] == ST_NOT_REACHED:
                cols.append("NA")
            else:
                cols.append(f"{r['n_min_testo']}{'' if r['monotone'] else '*'} ({r['n_min_prudente_testo']})")
        lines.append(f"| {pol} | {k} | {rho:g} | " + " | ".join(cols) + " |")
    return "\n".join(lines)


def _map_tasks(pool, func, payloads: list) -> list:
    return list(map(func, payloads)) if pool is None else list(pool.map(func, payloads, chunksize=1))


def estimate_sample_size(cfg: dict, workers: int) -> dict[str, float]:
    """Cronometra poche passate vere e stima i tempi (caso peggiore: nessun stop anticipato)."""
    ss, ctx = cfg["sample_size"], ss_context(cfg)
    cells, neg = ss_cells(ss), ss_negative_cell(ss)
    mcell = next(c for c in cells if c.name in ss["model"]["cells"])
    rhos, ns, mdl = [float(r) for r in ss["rho"]], [int(n) for n in ss["n_grid"]], ss["model"]
    n_hyper_cfg = len(cells) * len(rhos) + (1 if neg else 0)
    hyper_core = model_core = 0.0
    print("  N     ipergeometrica (ms/dataset)   modello (s/passata)")
    for n in ns:
        t = time.perf_counter()
        for sim in range(20):
            ss_hyper_dataset(ctx, mcell.at(rhos[len(rhos) // 2]), n, mcell.idx, len(rhos) // 2, sim)
        t_h = (time.perf_counter() - t) / 20
        data = simulate_ss_dataset(ctx, mcell.at(rhos[-1]), n, mcell.idx, len(rhos) - 1, 0)
        k = max(ctx["ks"])
        y = compute_endpoint(data.dss[:, 0, :], data.dss[:, 1, :], k, mcell.sigma_rep, ctx["delta_z"])
        x, t = make_features(data, mcell.at(rhos[-1]), k), time.perf_counter()
        for _ in range(2):
            model_scores_for(x, y, ctx)
        t_p = (time.perf_counter() - t) / 2
        print(f"  {n:<5d} {t_h * 1000:>12.2f} {t_p:>26.3f}")
        hyper_core += n_hyper_cfg * int(ss["hypergeometric"]["n_datasets"]) * t_h
        model_core += (len(mdl["cells"]) * len(rhos) * len(ctx["ks"]) * int(mdl["max_datasets"])
                       * (1 + int(mdl["n_perm"])) * t_p)
    est = {"hyper_min": hyper_core / workers / 60, "model_worst_min": model_core / workers / 60}
    tb = ss["time_budget_min"]
    print(f"Stima con {workers} processi: ipergeometrica ~{est['hyper_min']:.1f} min; modello nel caso peggiore "
          f"(nessuno stop anticipato, {mdl['max_datasets']} dataset) ~{est['model_worst_min']:.0f} min.")
    print(f"Guardia a blocchi di {mdl['block_size']} dataset: modello al massimo {tb['model']} min, "
          f"totale al massimo {tb['total']} min. Il numero di dataset del modello effettivamente fatti e' in n_datasets.")
    return est


def run_model_blocks(
    ctx: dict, combos: list, ns: list[int], ks: list[int], *, max_ds: int, block: int, n_perm: int,
    allowed_s: float, workers: int,
) -> tuple[list[dict], int]:
    """Modello (permutazione dell'intera pipeline) a blocchi di dataset con guardia sul tempo.

    combos: lista di (SSCell, indice di rho nella griglia di sample_size.rho, rho). Prima di ogni blocco la
    guardia stima la durata dal blocco piu' lento e si ferma se supererebbe `allowed_s` secondi.
    Restituisce i record e il numero di dataset fatti per configurazione.
    """
    records, wave_times, t_model = [], [], time.time()
    pool = ProcessPoolExecutor(max_workers=workers) if workers > 1 else None
    try:
        for start in range(0, max_ds, block):
            elapsed, est = time.time() - t_model, max(wave_times, default=0.0)
            if wave_times and elapsed + 1.1 * est > allowed_s:
                print(f"  guardia: fermo dopo {len(wave_times) * block} dataset "
                      f"({elapsed / 60:.1f} min fatti, il prossimo blocco ne richiede ~{est / 60:.1f})")
                break
            sims = range(start, min(start + block, max_ds))
            tasks = sorted(
                [(ctx, c.at(rho), c.name, c.idx, ri, n, k, sim, n_perm)
                 for sim in sims for c, ri, rho in combos for k in ks for n in ns],
                key=lambda p: -p[5],
            )
            t0 = time.time()
            records.extend(_map_tasks(pool, _task_ss_model, tasks))
            wave_times.append(time.time() - t0)
            print(f"  dataset {sims.start + 1}-{sims.stop}: {wave_times[-1]:.0f}s (totale modello "
                  f"{(time.time() - t_model) / 60:.1f} min)", flush=True)
    finally:
        if pool is not None:
            pool.shutdown()
    return records, len(wave_times) * block


def run_sample_size(
    cfg: dict,
    *,
    workers: int | None = None,
    results_dir: str | Path = REPO_ROOT / "results",
    config_path: str | Path | None = None,
    command: str | None = None,
    estimate_only: bool = False,
) -> dict[str, Path]:
    """Curva di potenza vs N: ipergeometrica per livello e margine, permutazione per il modello."""
    t_start = time.time()
    validate_sample_size_config(cfg)
    ss, ctx = cfg["sample_size"], ss_context(cfg)
    cells, neg = ss_cells(cfg["sample_size"]), ss_negative_cell(ss)
    rhos, ns = [float(r) for r in ss["rho"]], sorted(int(n) for n in ss["n_grid"])
    if workers is None:
        w = cfg.get("workers", "auto")
        workers = (os.cpu_count() or 1) if w == "auto" else int(w)
    print(BANNER)
    print(f"Curva di potenza vs N | scenario di conteggi: {ctx['count_scenario']} ({ctx['counts_status']}) | "
          f"N: {ns} | k: {ctx['ks']} | B = {ctx['ss_frac']:.0%} | processi: {workers}")
    if ctx["placeholder_counts"]:
        print("ATTENZIONE: conteggi PRELIMINARI (counts_confirmed: false): i numeri non vanno citati.")
    print(SS_WARNING)
    if estimate_only:
        estimate_sample_size(cfg, workers)
        return {}
    git = git_state()  # fotografato una volta, prima di scrivere in results/ (che e' tracciata)
    print(f"Commit {git['commit'][:7]} | git_dirty: {git['git_dirty']}")

    n_hyper = int(ss["hypergeometric"]["n_datasets"])
    hyper_cells = [(c, ri, rho) for c in cells for ri, rho in enumerate(rhos)] + ([(neg, 0, 0.0)] if neg else [])
    payloads = sorted(
        [(ctx, c.at(rho), c.name, c.idx, ri, n, n_hyper) for c, ri, rho in hyper_cells for n in ns],
        key=lambda p: -p[5],
    )
    print(f"\n== Ipergeometrica (livello, margine): {len(payloads)} configurazioni x {n_hyper} dataset")
    hyper = aggregate_ss_hyper([r for part in _run_tasks(_task_ss_hyper, payloads, workers, "ipergeometrica")
                                for r in part])

    # modello: permutazione dell'intera pipeline, a blocchi di dataset con guardia sul tempo
    mdl = ss["model"]
    block, max_ds, n_perm = int(mdl["block_size"]), int(mdl["max_datasets"]), int(mdl["n_perm"])
    model_cells = [c for c in cells if c.name in mdl["cells"]]
    allowed = min(float(ss["time_budget_min"]["model"]) * 60,
                  float(ss["time_budget_min"]["total"]) * 60 - (time.time() - t_start) - 60)
    print(f"\n== Modello (permutazione, {n_perm} permutazioni, stop anticipato a parita' di decisione): "
          f"celle {[c.name for c in model_cells]}, fino a {max_ds} dataset a blocchi di {block}; "
          f"tempo massimo {allowed / 60:.0f} min")
    combos = [(c, ri, rho) for c in model_cells for ri, rho in enumerate(rhos)]
    records, n_done = run_model_blocks(ctx, combos, ns, ctx["ks"], max_ds=max_ds, block=block, n_perm=n_perm,
                                       allowed_s=allowed, workers=workers)
    model = aggregate_ss_model(records, max_ds, n_perm, ctx["alpha"])

    power = _ss_const_columns(pd.concat([hyper, model], ignore_index=True), ctx, ctx["ss_frac"])
    power = power[list(power.columns[: power.columns.get_loc("avvertenza") + 1]) + SS_POWER_COLUMNS]
    power["_o"] = power["policy"].map({p: i for i, p in enumerate(SS_POLICIES)})
    power = (power.sort_values(["scenario", "_o", "cell", "k", "rho", "n_patients"], kind="stable")
             .drop(columns="_o").reset_index(drop=True))
    real = power[power["scenario"] != SCENARIO_NEG]
    nmin = compute_n_min(real, ctx["power_threshold"], cells, ctx["ks"], rhos)
    nmin = _ss_const_columns(nmin.assign(scenario=SCENARIO_PROFILE), ctx, ctx["ss_frac"]).drop(columns="scenario")

    save = dict(seed=int(cfg["seed"]), synthetic=True, input_files=[config_path] if config_path else [],
                command=command, results_dir=results_dir, git_info=git)
    out = {"sample_size": save_result(power, "SINTETICO_sample_size", **save),
           "nmin": save_result(nmin, "SINTETICO_sample_size_nmin", **save)}
    print_ss_negative_control(power, ctx)
    print(f"\nModello: {n_done} dataset su {max_ds} previsti per configurazione.")
    print("\n" + n_min_markdown(nmin))
    print(f"\nFatto in {(time.time() - t_start) / 60:.1f} min. File: " + ", ".join(p.name for p in out.values()))
    print(BANNER)
    return out


# --------------------------------------------------------------------------- parti aggiuntive (SINTETICHE)
# Parte "modello_celle_estreme": il modello (permutazione dell'intera pipeline) anche nelle celle bassa e alta,
# con le stesse regole della corsa principale (stessi semi per cella e rho: il rho viene dalla griglia di
# sample_size.rho), a rho ridotti. Scrive file propri: non tocca i risultati della corsa principale.
PART_MODEL_CELLS = "modello_celle_estreme"


def sample_size_part(cfg: dict, name: str) -> dict:
    parts = cfg.get("sample_size", {}).get("parts", {})
    if name not in parts:
        raise ValueError(f"sample_size.parts: parte '{name}' non definita nel config")
    return parts[name]


def validate_model_cells_part(cfg: dict, name: str = PART_MODEL_CELLS) -> None:
    validate_sample_size_config(cfg)
    ss, part = cfg["sample_size"], sample_size_part(cfg, name)
    names = {str(c["name"]) for c in ss["cells"]}
    if not part["cells"] or not set(part["cells"]) <= names:
        raise ValueError(f"{name}: celle sconosciute")
    grid = [float(r) for r in ss["rho"]]
    if not part["rho"] or not all(any(math.isclose(float(r), g) for g in grid) for r in part["rho"]):
        raise ValueError(f"{name}: rho deve stare nella griglia sample_size.rho (stessi semi della corsa principale)")
    if int(part["block_size"]) < 1 or int(part["max_datasets"]) < int(part["block_size"]):
        raise ValueError(f"{name}: block_size >= 1 e max_datasets >= block_size")
    if perm_pvalue(0, int(part["n_perm"])) >= float(cfg["test"]["alpha"]):
        raise ValueError(f"{name}: n_perm troppo basso: con 0 eccedenze p non e' sotto alfa")
    if float(part["time_budget_min"]) <= 0:
        raise ValueError(f"{name}: time_budget_min positivo")


def run_model_cells_part(
    cfg: dict,
    name: str = PART_MODEL_CELLS,
    *,
    workers: int | None = None,
    results_dir: str | Path = REPO_ROOT / "results",
    config_path: str | Path | None = None,
    command: str | None = None,
) -> dict[str, Path]:
    """Modello nelle celle e nei rho della parte `name`: curva di potenza vs N e N minimo (solo modello)."""
    t_start = time.time()
    validate_model_cells_part(cfg, name)
    ss, part, ctx = cfg["sample_size"], sample_size_part(cfg, name), ss_context(cfg)
    cells = ss_cells(ss)
    grid, ns = [float(r) for r in ss["rho"]], sorted(int(n) for n in ss["n_grid"])
    sel = [c for c in cells if c.name in part["cells"]]
    rhos = [float(r) for r in part["rho"]]
    combos = [(c, next(i for i, g in enumerate(grid) if math.isclose(g, r)), r) for c in sel for r in rhos]
    if workers is None:
        w = cfg.get("workers", "auto")
        workers = (os.cpu_count() or 1) if w == "auto" else int(w)
    print(BANNER)
    print(f"Parte '{name}' | scenario di conteggi: {ctx['count_scenario']} ({ctx['counts_status']}) | N: {ns} | "
          f"k: {ctx['ks']} | B = {ctx['ss_frac']:.0%} | celle: {[c.name for c in sel]} | rho: {rhos} | processi: {workers}")
    if ctx["placeholder_counts"]:
        print("ATTENZIONE: conteggi PRELIMINARI (counts_confirmed: false): i numeri non vanno citati.")
    print(SS_WARNING)
    git = git_state()
    print(f"Commit {git['commit'][:7]} | git_dirty: {git['git_dirty']}")
    max_ds, block, n_perm = int(part["max_datasets"]), int(part["block_size"]), int(part["n_perm"])
    allowed = float(part["time_budget_min"]) * 60
    print(f"\n== Modello (permutazione, {n_perm} permutazioni, stop anticipato a parita' di decisione): fino a "
          f"{max_ds} dataset a blocchi di {block}; tempo massimo {allowed / 60:.0f} min")
    records, n_done = run_model_blocks(ctx, combos, ns, ctx["ks"], max_ds=max_ds, block=block, n_perm=n_perm,
                                       allowed_s=allowed, workers=workers)
    if not records:
        raise RuntimeError("nessun dataset completato: tempo insufficiente")
    model = aggregate_ss_model(records, max_ds, n_perm, ctx["alpha"])
    power = _ss_const_columns(model, ctx, ctx["ss_frac"])
    power = power[list(power.columns[: power.columns.get_loc("avvertenza") + 1]) + SS_POWER_COLUMNS]
    power = power.sort_values(["cell", "k", "rho", "n_patients"], kind="stable").reset_index(drop=True)
    nmin = compute_n_min(power, ctx["power_threshold"], sel, ctx["ks"], rhos, policies=("modello",))
    nmin = _ss_const_columns(nmin.assign(scenario=SCENARIO_PROFILE), ctx, ctx["ss_frac"]).drop(columns="scenario")
    save = dict(seed=int(cfg["seed"]), synthetic=True, input_files=[config_path] if config_path else [],
                command=command, results_dir=results_dir, git_info=git)
    out = {"sample_size": save_result(power, f"SINTETICO_sample_size_{name}", **save),
           "nmin": save_result(nmin, f"SINTETICO_sample_size_{name}_nmin", **save)}
    print(f"\nModello: {n_done} dataset su {max_ds} previsti per configurazione.")
    print("\n" + n_min_markdown(nmin))
    print(f"\nFatto in {(time.time() - t_start) / 60:.1f} min. File: " + ", ".join(p.name for p in out.values()))
    print(BANNER)
    return out


# Parte "biomarcatore" (SINTETICA): il segnale passa da P4, una caratteristica sintetica separata che porta
# informazione sull'eterogeneita' (correlazione rho con la latente z); P1-P3 non portano informazione.
# Politiche: modello con P1-P4 (permutazione dell'intera pipeline) e regola semplice basata solo su P4
# (ipergeometrica). Domanda: quanto forte deve essere un biomarcatore perche' bastino N pazienti.
PART_BIOMARKER = "biomarcatore"
META_IDX_OFFSET = 100   # i semi del biomarcatore non coincidono con quelli dello scenario profilo
META_RHO_IDX_OFFSET = 10


def validate_biomarker_part(cfg: dict, name: str = PART_BIOMARKER) -> None:
    validate_sample_size_config(cfg)
    ss, part = cfg["sample_size"], sample_size_part(cfg, name)
    if str(part["cell"]) not in {str(c["name"]) for c in ss["cells"]}:
        raise ValueError(f"{name}: cella sconosciuta")
    strengths = [float(r) for r in part["strengths"]]
    if not strengths or len(set(strengths)) != len(strengths) or not all(0 < r < RHO_MAX_EXCLUSIVE for r in strengths):
        raise ValueError(f"{name}: strengths distinti e in (0, 1)")
    if not 0 <= float(part.get("control_rho", 0.0)) < RHO_MAX_EXCLUSIVE or float(part.get("control_rho", 0.0)) in strengths:
        raise ValueError(f"{name}: control_rho in [0, 1) e diverso dalle forze")
    if int(part["hyper_datasets"]) < 1:
        raise ValueError(f"{name}: hyper_datasets >= 1")
    validate_model_cells_part({**cfg, "sample_size": {**ss, "parts": {name: {
        "cells": [part["cell"]], "rho": [ss["rho"][0]], **{k: part[k] for k in
        ("max_datasets", "block_size", "n_perm", "time_budget_min")}}}}}, name)


def biomarker_cell(ss: dict, part: dict) -> SSCell:
    base = next(c for c in ss_cells(ss) if c.name == str(part["cell"]))
    return SSCell(base.name, META_IDX_OFFSET + base.idx, SCENARIO_META, base.tau, base.sigma_rep)


def run_biomarker_part(
    cfg: dict,
    name: str = PART_BIOMARKER,
    *,
    workers: int | None = None,
    results_dir: str | Path = REPO_ROOT / "results",
    config_path: str | Path | None = None,
    command: str | None = None,
) -> dict[str, Path]:
    """Curva di potenza vs N e N minimo per forza del biomarcatore: modello P1-P4 e regola solo P4."""
    t_start = time.time()
    validate_biomarker_part(cfg, name)
    ss, part, ctx = cfg["sample_size"], sample_size_part(cfg, name), ss_context(cfg)
    cell = biomarker_cell(ss, part)
    ns = sorted(int(n) for n in ss["n_grid"])
    strengths = [float(r) for r in part["strengths"]]
    control = float(part.get("control_rho", 0.0))
    if workers is None:
        w = cfg.get("workers", "auto")
        workers = (os.cpu_count() or 1) if w == "auto" else int(w)
    print(BANNER)
    print(f"Parte '{name}' (biomarcatore P4) | conteggi: {ctx['count_scenario']} ({ctx['counts_status']}) | N: {ns} | "
          f"k: {ctx['ks']} | B = {ctx['ss_frac']:.0%} | cella: {cell.name} | forze: {strengths} | controllo: {control} | "
          f"processi: {workers}")
    if ctx["placeholder_counts"]:
        print("ATTENZIONE: conteggi PRELIMINARI (counts_confirmed: false): i numeri non vanno citati.")
    print(SS_WARNING)
    git = git_state()
    print(f"Commit {git['commit'][:7]} | git_dirty: {git['git_dirty']}")

    n_hyper = int(part["hyper_datasets"])
    rho_list = [control, *strengths]
    payloads = sorted([(ctx, cell.at(r), cell.name, cell.idx, META_RHO_IDX_OFFSET + i, n, n_hyper)
                       for i, r in enumerate(rho_list) for n in ns], key=lambda p: -p[5])
    print(f"\n== Ipergeometrica (regola solo P4): {len(payloads)} configurazioni x {n_hyper} dataset")
    hyper = aggregate_ss_hyper([r for part_ in _run_tasks(_task_ss_hyper, payloads, workers, "ipergeometrica")
                                for r in part_])

    max_ds, block, n_perm = int(part["max_datasets"]), int(part["block_size"]), int(part["n_perm"])
    allowed = min(float(part["time_budget_min"]) * 60, float(part["time_budget_min"]) * 60 - (time.time() - t_start))
    print(f"\n== Modello P1-P4 (permutazione, {n_perm} permutazioni, stop anticipato a parita' di decisione): fino a "
          f"{max_ds} dataset a blocchi di {block}; tempo massimo {allowed / 60:.0f} min")
    combos = [(cell, META_RHO_IDX_OFFSET + 1 + i, r) for i, r in enumerate(strengths)]
    records, n_done = run_model_blocks(ctx, combos, ns, ctx["ks"], max_ds=max_ds, block=block, n_perm=n_perm,
                                       allowed_s=allowed, workers=workers)
    if not records:
        raise RuntimeError("nessun dataset completato: tempo insufficiente")
    model = aggregate_ss_model(records, max_ds, n_perm, ctx["alpha"])

    power = _ss_const_columns(pd.concat([hyper, model], ignore_index=True), ctx, ctx["ss_frac"])
    power = power[list(power.columns[: power.columns.get_loc("avvertenza") + 1]) + SS_POWER_COLUMNS + ["auc_p4_mean"]]
    power["_o"] = power["policy"].map({POLICY_P4: 0, "modello": 1})
    power = (power.sort_values(["_o", "k", "rho", "n_patients"], kind="stable").drop(columns="_o").reset_index(drop=True))
    nmin = compute_n_min(power, ctx["power_threshold"], [cell], ctx["ks"], strengths, policies=(POLICY_P4, "modello"))
    nmin = _ss_const_columns(nmin.assign(scenario=SCENARIO_META), ctx, ctx["ss_frac"]).drop(columns="scenario")
    save = dict(seed=int(cfg["seed"]), synthetic=True, input_files=[config_path] if config_path else [],
                command=command, results_dir=results_dir, git_info=git)
    out = {"sample_size": save_result(power, f"SINTETICO_sample_size_{name}", **save),
           "nmin": save_result(nmin, f"SINTETICO_sample_size_{name}_nmin", **save)}
    ctl = power[(power["rho"] == control) & (power["policy"] == POLICY_P4)]
    print(f"\nControllo (P4 senza segnale, rho = {control:g}), potenza massima su tutti gli N (alfa = {ctx['alpha']}):")
    for k, g in ctl.groupby("k"):
        r = g.loc[g["power"].idxmax()]
        print(f"  k={int(k)}: {r['power']:.3f} [{r['power_lo']:.3f}, {r['power_hi']:.3f}] a N={int(r['n_patients'])}")
    print(f"\nModello: {n_done} dataset su {max_ds} previsti per configurazione.")
    print("\n" + n_min_markdown(nmin))
    print(f"\nFatto in {(time.time() - t_start) / 60:.1f} min. File: " + ", ".join(p.name for p in out.values()))
    print(BANNER)
    return out


def print_ss_negative_control(power: pd.DataFrame, ctx: dict) -> None:
    """Controllo negativo: con predittori di rumore la potenza massima su tutti gli N non deve superare alfa di molto."""
    neg = power[power["scenario"] == SCENARIO_NEG]
    if neg.empty:
        return
    print(f"\nControllo negativo (alfa = {ctx['alpha']}), potenza massima su tutti gli N, ipergeometrica:")
    for (pol, k), g in neg.groupby(["policy", "k"]):
        r = g.loc[g["power"].idxmax()]
        print(f"  {pol:8s} k={int(k)}: {r['power']:.3f} [{r['power_lo']:.3f}, {r['power_hi']:.3f}] a N={int(r['n_patients'])}, "
              f"n_datasets={int(r['n_datasets'])}")


# --------------------------------------------------------------------------- conteggi reali dal rapporto della pipeline
RAPPORTO_COLONNE = ("dataset", "sezione", "metrica", "valore", "dettaglio")  # src/prepara_s5.COLONNE_RAPPORTO
RAPPORTO_PAZIENTI = ("intervento", "pazienti_con_intervento_idoneo")  # v0.3.3: almeno 2 lesioni con DSS nel pannello
RAPPORTO_FARMACI = ("schema", "voci_pannello_primario")  # D15: le voci del pannello primario
SCENARIO_CONTEGGI_REALI = "conteggi_reali"
SUFFISSO_CONTEGGI_REALI = "_conteggi_reali"
CAMPIONI_PER_PAZIENTE_REALI = 2  # indice e secondo campione (sezione 4): l'endpoint ne usa due


def _valore_rapporto(tab: pd.DataFrame, sezione: str, metrica: str, nome: str) -> int:
    righe = tab[(tab["sezione"] == sezione) & (tab["metrica"] == metrica)]
    if len(righe) != 1:
        raise ValueError(f"{nome}: serve una sola riga sezione={sezione}, metrica={metrica} (trovate {len(righe)})")
    testo = righe["valore"].iloc[0].strip()
    if not testo.isdigit():
        raise ValueError(f"{nome}: il valore di {sezione}/{metrica} deve essere un conteggio intero, non {testo!r}")
    return int(testo)


def conteggi_da_rapporto(path: str | Path) -> dict:
    """Pazienti e farmaci dal rapporto di SOLI CONTEGGI scritto da src/prepara_s5.py (dopo l'audit).

    Si leggono due righe: pazienti con un intervento idoneo (v0.3.3, decisa dalla sola presenza delle celle) e voci
    del pannello primario D15. Nessun valore di risposta: il rapporto non ne contiene. Il rapporto deve avere il suo
    .meta.json, con il flag synthetic coerente con la colonna dataset e con il nome del file.
    """
    path = Path(path)
    if not path.is_file():
        raise ValueError(f"rapporto dei conteggi non trovato: {path}")
    meta_path = path.with_name(path.stem + ".meta.json")
    if not meta_path.is_file():
        raise ValueError(f"manca {meta_path.name}: il rapporto va salvato dalla pipeline con il suo .meta.json")
    tab = pd.read_csv(path, dtype=str, keep_default_na=False)
    if tuple(tab.columns) != RAPPORTO_COLONNE:
        raise ValueError(f"{path.name}: colonne {list(tab.columns)}, attese {list(RAPPORTO_COLONNE)}")
    datasets = sorted(set(tab["dataset"]))
    if len(datasets) != 1:
        raise ValueError(f"{path.name}: la colonna dataset deve avere un solo valore, trovati {datasets}")
    sintetico = datasets[0] == SYNTHETIC_TAG
    meta = yaml.safe_load(meta_path.read_text(encoding="utf-8"))  # JSON e' YAML valido
    if bool(meta.get("synthetic")) != sintetico or (SYNTHETIC_TAG in path.name) != sintetico:
        raise ValueError(f"{path.name}: nome, colonna dataset e flag synthetic del .meta.json non sono coerenti")
    return {
        "n_patients": _valore_rapporto(tab, *RAPPORTO_PAZIENTI, path.name),
        "n_drugs_common": _valore_rapporto(tab, *RAPPORTO_FARMACI, path.name),
        "dataset": datasets[0],
        "file": path.name,
    }


def percorso_relativo(p: str | Path) -> str:
    """Percorso relativo alla radice del repository; fuori dal repository solo il nome, preceduto da
    "(fuori dal repository)" (come strumenti/certificato.py). Cosi' il .meta.json vale su ogni macchina."""
    q = Path(p).resolve()
    try:
        return q.relative_to(REPO_ROOT.resolve()).as_posix()
    except ValueError:
        return f"(fuori dal repository) {q.name}"


def relativizza_ingressi(result_path: Path) -> None:
    """Riscrive le chiavi di input_sha256 del .meta.json scritto da save_result con percorsi relativi (le impronte
    restano quelle calcolate sul file)."""
    import json

    meta = Path(result_path).with_name(Path(result_path).stem + ".meta.json")
    info = json.loads(meta.read_text(encoding="utf-8"))
    info["input_sha256"] = {percorso_relativo(k): v for k, v in (info.get("input_sha256") or {}).items()}
    meta.write_text(json.dumps(info, indent=2, ensure_ascii=False), encoding="utf-8")


def config_con_conteggi_reali(cfg: dict, rapporto: str | Path) -> dict:
    """Copia del config con un solo scenario di conteggi, preso dal rapporto. Griglie e parametri non cambiano."""
    c = conteggi_da_rapporto(rapporto)
    scenario = {
        "name": SCENARIO_CONTEGGI_REALI,
        "n_patients": c["n_patients"],
        "samples_per_patient": CAMPIONI_PER_PAZIENTE_REALI,
        "n_drugs_common": c["n_drugs_common"],
        "counts_confirmed": True,
        "status": (f"CONTEGGI dal rapporto della pipeline ({c['file']}, dataset {c['dataset']}): pazienti con un "
                   f"intervento idoneo (v0.3.3) e voci del pannello primario D15; nessun valore di risposta"),
    }
    out = dict(cfg)
    out["count_scenarios"] = [scenario]
    return out


# --------------------------------------------------------------------------- run e CLI
def run(
    cfg: dict,
    mode: str | None = None,
    *,
    workers: int | None = None,
    results_dir: str | Path = REPO_ROOT / "results",
    config_path: str | Path | None = None,
    command: str | None = None,
    perm_check: bool = True,
    conteggi_reali: str | Path | None = None,
) -> dict[str, Path]:
    """Simulazione principale. Con `conteggi_reali` (rapporto della pipeline) usa un solo scenario con quei conteggi
    e salva i file con il suffisso _conteggi_reali; il rapporto entra tra i file in ingresso del .meta.json."""
    suffix = ""
    if conteggi_reali is not None:
        cfg = config_con_conteggi_reali(cfg, conteggi_reali)
        suffix = SUFFISSO_CONTEGGI_REALI
    mode = mode or cfg.get("mode", "quick")
    validate_config(cfg, mode)
    cells = build_cells(cfg, mode)
    if workers is None:
        w = cfg.get("workers", "auto")
        workers = (os.cpu_count() or 1) if w == "auto" else int(w)
    git = git_state()  # fotografato UNA volta, prima di scrivere in results/ (che e' tracciata)
    n_sc = len(cfg["count_scenarios"])
    print(BANNER)
    print(f"Modalita': {mode} | scenari di conteggi: {n_sc} | celle per scenario: {len(cells)} | "
          f"validazione: {cfg['model'].get('validation', VALIDATION_CV)} | processi: {workers}")
    print(f"Commit {git['commit'][:7]} | git_dirty: {git['git_dirty']}")

    pc = cfg["modes"][mode].get("perm_check", {})
    do_perm = perm_check and pc.get("enabled", False)
    t0 = time.time()
    powers, mdes, perms, mde_perms = [], [], [], []
    for si in range(n_sc):
        ctx = make_context(cfg, mode, si)
        print(f"\n== Scenario di conteggi '{ctx['count_scenario']}' ({ctx['counts_status']}): "
              f"{ctx['n_patients']} pazienti, {ctx['n_samples']} campioni, {ctx['n_drugs']} farmaci | "
              f"n_sim: {ctx['n_sim']}")
        if ctx["placeholder_counts"]:
            print("ATTENZIONE: conteggi PRELIMINARI (counts_confirmed: false): i numeri non vanno citati.")
        chunk = max(1, ctx["n_sim"] // 10)
        payloads = [
            (ctx, cell, ci, sims)
            for ci, cell in enumerate(cells)
            for sims in _chunks(list(range(ctx["n_sim"])), chunk)
        ]
        raw = _run_tasks(_task_power, payloads, workers, f"{ctx['count_scenario']}: potenza")
        power = aggregate_power(pd.DataFrame([r for part in raw for r in part]), ctx)
        powers.append(power)
        mdes.append(_const_columns(compute_mde(power, ctx["power_threshold"]), ctx))

        if do_perm:
            n_perm, k_p, b_p = int(pc["n_perm"]), int(pc["k"]), float(pc["budget_fraction"])
            tasks = [(ctx, cell, ci, sim, k_p, b_p, n_perm)
                     for ci, cell in enumerate(cells) for sim in range(int(pc["n_datasets"]))]
            print(f"  permutazioni (intera pipeline): k={k_p}, B={b_p:.0%}: {len(tasks)} dataset x {n_perm} permutazioni")
            prec = pd.DataFrame(_run_tasks(_task_perm, tasks, workers, f"{ctx['count_scenario']}: permutazioni"))
            perm_df = aggregate_perm_check(prec, ctx, n_perm)
            perms.append(perm_df)
            mde_perms.append(_const_columns(
                compute_mde(perm_power_frame(perm_df), ctx["power_threshold"], policies=("modello_perm",)), ctx))
        print_negative_control(power, perms[-1] if do_perm else None, ctx)

    seed = int(cfg["seed"])
    inputs = ([config_path] if config_path else []) + ([conteggi_reali] if conteggi_reali is not None else [])
    save = dict(seed=seed, synthetic=True, input_files=inputs, command=command,
                results_dir=results_dir, git_info=git)
    out: dict[str, Path] = {}
    out["power"] = save_result(pd.concat(powers, ignore_index=True), f"SINTETICO_power{suffix}", **save)
    out["mde"] = save_result(pd.concat(mdes, ignore_index=True), f"SINTETICO_mde{suffix}", **save)
    if do_perm:
        out["perm_check"] = save_result(pd.concat(perms, ignore_index=True), f"SINTETICO_power_perm_check{suffix}", **save)
        out["mde_perm"] = save_result(pd.concat(mde_perms, ignore_index=True), f"SINTETICO_mde_perm{suffix}", **save)
    for path in out.values():
        relativizza_ingressi(path)

    full_power = pd.concat(powers, ignore_index=True)
    low = full_power[(full_power["policy"] == "modello")
                     & ((full_power["prevalence_mean"] < 0.05) | (full_power["prevalence_mean"] > 0.95))]
    if len(low):
        print(f"Nota: {len(low)} celle con prevalenza dell'evento fuori da [5%, 95%]: potenza poco informativa.")
    print(f"\nFatto in {time.time() - t0:.0f}s. File: " + ", ".join(p.name for p in out.values()))
    print(BANNER)
    return out


def print_negative_control(power: pd.DataFrame, perm_df: pd.DataFrame | None, ctx: dict) -> None:
    """Controllo negativo (sezione 12): con predittori di rumore la potenza deve restare vicino ad alfa
    (o sotto, perche' il test e' discreto). Stampa le quote di rifiuto a k = 3 e B primario."""
    neg = power[(power["scenario"] == SCENARIO_NEG) & (power["policy"] != "casuale")]
    if neg.empty:
        return
    print(f"  controllo negativo (alfa = {ctx['alpha']}), potenza con predittori di rumore:")
    for _, r in neg.sort_values(["k", "budget_fraction", "policy"]).iterrows():
        if r["k"] == 3 and math.isclose(r["budget_fraction"], 0.30):
            print(f"    {r['policy']:8s} k=3 B=30% ipergeometrica: {r['power']:.3f} "
                  f"[{r['power_lo']:.3f}, {r['power_hi']:.3f}], n_sim={int(r['n_sim'])}")
    if perm_df is not None:
        pr = perm_df[perm_df["scenario"] == SCENARIO_NEG]
        for _, r in pr.iterrows():
            print(f"    modello  k={int(r['k'])} B={r['budget_fraction']:.0%} permutazione: {r['power_perm']:.3f} "
                  f"[{r['power_perm_lo']:.3f}, {r['power_perm_hi']:.3f}], n_datasets={int(r['n_datasets'])}")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="SINTETICO - simulazione di potenza (nessun dato reale)")
    ap.add_argument("--config", default=str(REPO_ROOT / "config" / "sim_params.yaml"))
    ap.add_argument("--mode", choices=["quick", "full"], default=None, help="sovrascrive 'mode' del config")
    ap.add_argument("--workers", type=int, default=None, help="processi (default: dal config)")
    ap.add_argument("--results-dir", default=str(REPO_ROOT / "results"))
    ap.add_argument("--no-perm-check", action="store_true", help="salta il controllo con permutazioni")
    ap.add_argument("--sample-size", action="store_true",
                    help="curva di potenza in funzione di N (blocco sample_size del config) al posto di run()")
    ap.add_argument("--part", default=None,
                    help="con --sample-size: esegue una parte aggiuntiva di sample_size.parts "
                         "(modello_celle_estreme, biomarcatore) al posto della corsa principale")
    ap.add_argument("--estimate", action="store_true",
                    help="con --sample-size: cronometra poche passate e stima i tempi, senza eseguire")
    ap.add_argument("--conteggi-reali", default=None, metavar="RAPPORTO",
                    help="rapporto di soli conteggi della pipeline (results/s5_rapporto_conteggi.csv), da usare dopo "
                         "l'audit: pazienti e farmaci al posto degli scenari segnaposto; uscite *_conteggi_reali")
    args = ap.parse_args(argv)
    cfg = load_config(args.config)
    command = shlex.join(["python", "-m", "src.power_simulation", *(argv if argv is not None else sys.argv[1:])])
    if args.estimate and not args.sample_size:
        ap.error("--estimate richiede --sample-size")
    if args.part and not args.sample_size:
        ap.error("--part richiede --sample-size")
    if args.conteggi_reali and args.sample_size:
        ap.error("--conteggi-reali vale per la simulazione principale, non con --sample-size")
    if args.sample_size and args.part == PART_MODEL_CELLS:
        run_model_cells_part(cfg, args.part, workers=args.workers, results_dir=args.results_dir,
                             config_path=args.config, command=command)
        return 0
    if args.sample_size and args.part == PART_BIOMARKER:
        run_biomarker_part(cfg, args.part, workers=args.workers, results_dir=args.results_dir,
                           config_path=args.config, command=command)
        return 0
    if args.sample_size and args.part:
        ap.error(f"parte sconosciuta: {args.part}")
    if args.sample_size:
        run_sample_size(cfg, workers=args.workers, results_dir=args.results_dir, config_path=args.config,
                        command=command, estimate_only=args.estimate)
        return 0
    try:
        run(cfg, args.mode, workers=args.workers, results_dir=args.results_dir, config_path=args.config,
            command=command, perm_check=not args.no_perm_check, conteggi_reali=args.conteggi_reali)
    except ValueError as exc:
        if args.conteggi_reali is None:
            raise
        print(f"STOP: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
