"""Metriche di triage "un campione basta?".

Convenzioni (da confermare con il team):
- y_true: 1 se il caso e' davvero da intercettare (un campione aggiuntivo lo troverebbe).
- flagged: 1 se il triage consiglia un campione aggiuntivo ("rosso"), 0 se dice "verde"
  (un campione basta).
- TP = flagged e y_true; FP = flagged e non y_true (falso allarme);
  FN = verde e y_true (falso verde); TN = verde e non y_true.
Le metriche con denominatore zero restituiscono NaN.
"""
from __future__ import annotations

from typing import Callable

import numpy as np
import pandas as pd


def _bools(y_true, flagged) -> tuple[np.ndarray, np.ndarray]:
    y = np.asarray(y_true).astype(bool)
    f = np.asarray(flagged).astype(bool)
    if y.shape != f.shape or y.ndim != 1:
        raise ValueError("y_true e flagged devono essere vettori della stessa lunghezza")
    return y, f


def _ratio(num: float, den: float) -> float:
    return float(num / den) if den else float("nan")


def flag_from_score(score, threshold: float) -> np.ndarray:
    """Rosso (1) se il punteggio di rischio e' >= soglia."""
    return (np.asarray(score, dtype=float) >= threshold).astype(int)


def confusion_counts(y_true, flagged) -> dict[str, int]:
    y, f = _bools(y_true, flagged)
    return {
        "tp": int((y & f).sum()),
        "fp": int((~y & f).sum()),
        "fn": int((y & ~f).sum()),
        "tn": int((~y & ~f).sum()),
    }


def yield_per_sample(y_true, flagged) -> float:
    """Resa: casi intercettati per campione aggiuntivo = TP / casi flaggati."""
    c = confusion_counts(y_true, flagged)
    return _ratio(c["tp"], c["tp"] + c["fp"])


def false_green_rate(y_true, flagged) -> float:
    """Falsi verdi: quota dei casi dichiarati verdi che erano da intercettare = FN / verdi."""
    c = confusion_counts(y_true, flagged)
    return _ratio(c["fn"], c["fn"] + c["tn"])


def missed_event_rate(y_true, flagged) -> float:
    """Eventi persi: quota degli eventi veri dichiarati verdi = FN / (TP + FN)."""
    c = confusion_counts(y_true, flagged)
    return _ratio(c["fn"], c["tp"] + c["fn"])


def false_alarm_rate(y_true, flagged) -> float:
    """Falsi allarmi: quota dei casi da non intercettare che sono stati flaggati = FP / negativi."""
    c = confusion_counts(y_true, flagged)
    return _ratio(c["fp"], c["fp"] + c["tn"])


def summary(y_true, flagged) -> dict[str, float]:
    """Riepilogo: conteggi e metriche (NaN se il denominatore e' zero)."""
    c = confusion_counts(y_true, flagged)
    return {
        "tp": c["tp"],
        "fp": c["fp"],
        "fn": c["fn"],
        "tn": c["tn"],
        "resa": yield_per_sample(y_true, flagged),
        "falsa_rassicurazione": false_green_rate(y_true, flagged),
        "eventi_persi": missed_event_rate(y_true, flagged),
        "falsi_allarmi": false_alarm_rate(y_true, flagged),
    }


def risk_coverage_curve(score, y_true) -> pd.DataFrame:
    """Curva rischio-copertura.

    Si dichiarano verdi i casi con punteggio <= soglia (punteggio basso = rischio basso).
    coverage = quota di casi dichiarati verdi; risk = quota di falsi verdi tra i verdi.
    Una riga per ogni valore distinto di punteggio (i pareggi entrano insieme).
    """
    s = np.asarray(score, dtype=float)
    y = np.asarray(y_true).astype(bool)
    if s.shape != y.shape or s.ndim != 1 or s.size == 0:
        raise ValueError("score e y_true devono essere vettori non vuoti della stessa lunghezza")
    order = np.argsort(s, kind="stable")
    s_sorted, y_sorted = s[order], y[order]
    cum_pos = np.cumsum(y_sorted)
    # ultimo indice di ogni valore distinto: il verde include tutti i pareggi
    last = np.flatnonzero(np.r_[s_sorted[1:] != s_sorted[:-1], True])
    n_green = last + 1
    n_false_green = cum_pos[last]
    return pd.DataFrame(
        {
            "threshold": s_sorted[last],
            "coverage": n_green / s.size,
            "risk": n_false_green / n_green,
            "n_green": n_green,
            "n_false_green": n_false_green,
        }
    )


def net_benefit(y_true, flagged, threshold_prob: float) -> float:
    """Beneficio netto (decision curve): TP/N - FP/N * pt/(1-pt).

    threshold_prob (pt, tra 0 e 1 esclusi) esprime quanto pesa un falso allarme
    rispetto a un caso intercettato.
    """
    if not 0 < threshold_prob < 1:
        raise ValueError("threshold_prob deve stare tra 0 e 1 (esclusi)")
    c = confusion_counts(y_true, flagged)
    n = sum(c.values())
    if n == 0:
        return float("nan")
    return c["tp"] / n - c["fp"] / n * threshold_prob / (1 - threshold_prob)


def bootstrap_replicates(
    df: pd.DataFrame,
    metric_fn: Callable[[pd.DataFrame], float],
    *,
    patient_col: str = "patient",
    n_boot: int = 1000,
    seed: int = 0,
) -> np.ndarray:
    """Bootstrap per paziente: si ricampionano i pazienti (con le loro righe intere)."""
    df = df.reset_index(drop=True)
    groups = list(df.groupby(patient_col).indices.values())
    if not groups:
        raise ValueError("DataFrame vuoto")
    rng = np.random.default_rng(seed)
    n = len(groups)
    reps = np.empty(n_boot)
    for b in range(n_boot):
        picked = rng.integers(0, n, n)
        idx = np.concatenate([groups[i] for i in picked])
        reps[b] = metric_fn(df.iloc[idx])
    return reps


def bootstrap_ci(
    df: pd.DataFrame,
    metric_fn: Callable[[pd.DataFrame], float],
    *,
    patient_col: str = "patient",
    n_boot: int = 1000,
    alpha: float = 0.05,
    seed: int = 0,
) -> dict[str, float]:
    """Stima puntuale e intervallo percentile (1-alpha) con bootstrap per paziente."""
    reps = bootstrap_replicates(df, metric_fn, patient_col=patient_col, n_boot=n_boot, seed=seed)
    valid = reps[~np.isnan(reps)]
    lo, hi = (np.percentile(valid, [100 * alpha / 2, 100 * (1 - alpha / 2)]) if valid.size else (np.nan, np.nan))
    return {
        "point": float(metric_fn(df)),
        "lo": float(lo),
        "hi": float(hi),
        "n_boot": int(n_boot),
        "n_valid": int(valid.size),
    }
