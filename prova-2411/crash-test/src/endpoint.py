"""Endpoint primario "cambio di priorita'" (preregistrazione, sezioni 3, 4, 5; decisioni D1, D2, D4, D10, D11, D13).

Parte dalla tabella lunga (patient, [lesion], sample_id, drug, dss; nomi logici, vedi
src/ingest.ingest_samples) e produce, nell'ordine:
  1. campione indice (D4) e secondo campione (sezione 4), pannello comune, tabella di inclusione
     paziente per paziente con il motivo (sezione 3, D13);
  2. sigma_rep secondo D11, oppure modalita' D2 (solo rango, rumore NOT VERIFIED);
  3. endpoint con k = 1 (primario) e k = 3 (secondario), regola delle parita' della sezione 5.
Le regole operative, una per una, stanno in docs/ANALISI_PRIMARIA.md.

Riuso di src/power_simulation.py (verificato contro la sezione 5): delta_threshold e compute_endpoint
sono coerenti (calo > delta in senso stretto; F1 resta nel top-k se meno di k farmaci stanno
strettamente sopra, cioe' le parita' del secondo campione favoriscono F1; F1 = primo massimo, che con
le colonne in ordine alfabetico e' il primo per nome). compute_endpoint non gestisce i NaN, ne' pannelli
diversi tra righe, ne' la modalita' D2: per questo e' chiamato una riga alla volta sul solo pannello
comune e la condizione di rango per D2 e' implementata qui (rank_condition).

Questo modulo e' neutro rispetto ai dati: la prova con dati SINTETICI usa src/synthetic_long.py.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from src.power_simulation import compute_endpoint, delta_threshold

# --------------------------------------------------------------------------- parametri di protocollo
DELTA_Z = 1.96  # sezione 5: delta = 1,96 * sigma_rep * sqrt(2)
MIN_LESIONS_SIGMA = 5  # D11: almeno 5 lesioni con due o piu' organoidi
K_PRIMARY = 1  # D1
K_SECONDARY = 3  # D1: analisi secondaria
KS = (K_PRIMARY, K_SECONDARY)

NOISE_VERIFIED = "verificato"
NOISE_NOT_VERIFIED = "NOT VERIFIED"
MODE_VERIFIED = "lesione verificata"
MODE_NOT_VERIFIED = "tra campioni dello stesso paziente, lesione NON VERIFICATA"
NA = "non applicabile"
NC = "non calcolabile"

# motivi di esclusione (gerarchia: il primo che vale si registra)
R_CONFLICT = "collegamento incoerente"
R_LESION_EMPTY = "lesione vuota"
R_ONE_SAMPLE = "un solo campione con DSS"
R_ONE_LESION = "una sola lesione"
R_PANEL_EMPTY = "pannello comune vuoto"
EXCLUSION_REASONS = (R_CONFLICT, R_LESION_EMPTY, R_ONE_SAMPLE, R_ONE_LESION, R_PANEL_EMPTY)

# stato di un paziente (o coppia) a un dato k
ST_OK = "valutabile"
ST_NO_ACTIVE = "non valutabile: nessun farmaco attivo nell'indice"
ST_PANEL = "non valutabile: pannello comune con meno di k+1 farmaci"
STATES = (ST_OK, ST_NO_ACTIVE, ST_PANEL)


NEGATIVE_DSS_MESSAGE = (
    "DSS negativi: verificare il tipo di DSS della matrice; serve una decisione scritta in docs/DEVIATIONS.md "
    "prima di proseguire"
)


# Regola per i DSS negativi (preregistrazione v0.3.4, sezione 5). SPENTA di default: con False nulla cambia e un
# DSS negativo ferma l'analisi con NEGATIVE_DSS_MESSAGE. Con True: (1) i DSS negativi non fermano il calcolo e non
# vengono troncati ne' corretti; (2) l'evento usa l'ordine dei DSS e, se sigma_rep e' stimabile, le loro differenze
# (rank_condition, compute_endpoint: definiti anche con valori negativi); (3) un farmaco e' "attivo" solo con
# DSS > 0, quindi un indice con DSS massimo <= 0 non ha farmaci attivi (state_at_k). La stima di sigma_rep non cambia.
# La accende solo src/esegui_analisi_reale.py con --regola-dss-negativi-v034, dopo la voce in docs/DEVIATIONS.md.
REGOLA_DSS_NEGATIVI_V034 = False


class EndpointError(ValueError):
    """Dati non utilizzabili (per esempio righe duplicate)."""


# --------------------------------------------------------------------------- strutture
@dataclass
class PatientData:
    """Dati di un paziente incluso: campioni con i soli DSS non vuoti."""

    patient: str
    index: str
    second: str
    panel: list[str]
    samples: dict[str, dict[str, float]]  # sample_id -> {farmaco: dss}
    lesion: dict[str, str] | None  # sample_id -> lesione (None in modalita' NON VERIFICATA)


@dataclass
class Inclusion:
    mode: str  # MODE_VERIFIED / MODE_NOT_VERIFIED
    table: pd.DataFrame  # una riga per paziente, con il motivo di esclusione
    data: dict[str, PatientData]  # solo pazienti inclusi
    n_rows_no_patient: int  # righe senza paziente, scartate (D13)
    excluded_from_sigma: set[str] = field(default_factory=set)  # pazienti con collegamento incoerente o lesione vuota
    canon: pd.DataFrame | None = None  # tabella canonica da cui deriva (serve a sigma_rep)


@dataclass
class SigmaResult:
    """Rumore di replica. `sigma_rep` e `delta` sono None quando il rumore e' NOT VERIFIED."""

    noise: str
    sigma_rep: float | None = None
    reason: str = ""
    n_groups_total: int = 0  # gruppi (lesione, farmaco) con almeno 2 organoidi
    n_groups_floor: int = 0  # esclusi: tutti i DSS pari a 0 (effetto pavimento)
    n_groups_used: int = 0
    n_lesions_used: int = 0
    df_total: int = 0

    @property
    def delta(self) -> float | None:
        return None if self.sigma_rep is None else delta_threshold(self.sigma_rep, DELTA_Z)

    def __post_init__(self) -> None:
        if self.noise not in (NOISE_VERIFIED, NOISE_NOT_VERIFIED):
            raise ValueError(f"modalita_rumore non valida: {self.noise!r}")
        if self.noise == NOISE_VERIFIED and self.sigma_rep is None:
            raise ValueError("rumore verificato senza sigma_rep")
        if self.noise == NOISE_NOT_VERIFIED and self.sigma_rep is not None:
            raise ValueError("rumore NOT VERIFIED con sigma_rep: incoerente")


# --------------------------------------------------------------------------- tabella canonica
def canonicalize(df: pd.DataFrame) -> tuple[pd.DataFrame, int]:
    """Ordine canonico delle righe e controlli. Restituisce (tabella, righe scartate senza paziente).

    DSS negativi: errore esplicito, nessuna correzione automatica (A9 e il pavimento di sigma_rep li presuppongono >= 0).
    L'ordine (paziente, lesione, sample_id, farmaco) rende il risultato indipendente dall'ordine delle
    righe nel file, anche nelle somme in virgola mobile. Righe identiche per (paziente, lesione, sample_id,
    farmaco): errore, mai mediate (sezione 12).
    """
    for col in ("patient", "sample_id", "drug", "dss"):
        if col not in df.columns:
            raise EndpointError(f"manca la colonna logica '{col}'")
    out = df.copy()
    if "lesion" not in out.columns:
        out["lesion"] = None
    out = out[["patient", "lesion", "sample_id", "drug", "dss"]].astype(
        {"patient": object, "lesion": object, "sample_id": object, "drug": object}
    )
    out["dss"] = pd.to_numeric(out["dss"], errors="raise").astype(float)
    neg = out["dss"] < 0
    if neg.any() and not REGOLA_DSS_NEGATIVI_V034:  # senza la regola v0.3.4, A9 (massimo = 0) presuppone DSS mai negativi
        first = out[neg].iloc[0]
        raise EndpointError(
            f"{NEGATIVE_DSS_MESSAGE} (righe con DSS < 0: {int(neg.sum())}; prima riga: paziente={first['patient']}, "
            f"campione={first['sample_id']}, farmaco={first['drug']})"
        )
    has_patient = out["patient"].notna()
    n_no_patient = int((~has_patient).sum())
    out = out[has_patient].copy()
    keys = ["patient", "lesion", "sample_id", "drug"]
    for c in keys:  # chiavi di ordinamento: stringhe esatte, mancante = stringa vuota
        out[f"_k_{c}"] = out[c].map(lambda v: "" if v is None or v != v else str(v)).astype(object)
    out = out.sort_values([f"_k_{c}" for c in keys], kind="stable").drop(columns=[f"_k_{c}" for c in keys])
    out = out.reset_index(drop=True)
    ok = out["sample_id"].notna() & out["drug"].notna()
    # righe identiche per (paziente, lesione, sample_id, farmaco): errore. Lo stesso sample_id con lesioni o
    # pazienti DIVERSI non e' un duplicato ma un collegamento incoerente: lo gestisce build_inclusion (D13).
    dup = out[ok].duplicated(["patient", "lesion", "sample_id", "drug"], keep=False)
    if dup.any():
        ex = out[ok][dup].head(3)[["patient", "lesion", "sample_id", "drug"]].values.tolist()
        raise EndpointError(f"righe duplicate per (paziente, lesione, sample_id, farmaco): esempi {ex}")
    return out, n_no_patient


def lesion_mode(df: pd.DataFrame) -> str:
    """NON VERIFICATA se la colonna lesione manca o e' interamente vuota (sezione 3)."""
    if "lesion" in df.columns and df["lesion"].notna().any():
        return MODE_VERIFIED
    return MODE_NOT_VERIFIED


# --------------------------------------------------------------------------- inclusione (sezioni 3-4, D4, D13)
def _conflict_patients(df: pd.DataFrame, verified: bool) -> set[str]:
    """Pazienti con collegamento incoerente (D13): nessun abbinamento approssimato, nessuna congettura."""
    bad: set[str] = set()
    no_id = df["sample_id"].isna() | (df["drug"].isna() & df["dss"].notna())
    bad |= set(df.loc[no_id, "patient"])
    with_id = df[df["sample_id"].notna()]
    for _, g in with_id.groupby("sample_id", sort=True):
        if g["patient"].nunique() > 1:
            bad |= set(g["patient"])
        if verified and g["lesion"].dropna().nunique() > 1:
            bad |= set(g["patient"])
    return bad


def _empty_row(patient: str, reason: str, **extra) -> dict:
    row = {
        "patient": patient, "incluso": False, "motivo": reason, "n_campioni_con_dss": 0, "n_lesioni": NA,
        "indice": "", "secondo": "", "lesione_indice": NA, "lesione_secondo": NA, "n_pannello": 0, "pannello": "",
    }
    row.update(extra)
    return row


def build_inclusion(df: pd.DataFrame, n_rows_no_patient: int = 0) -> Inclusion:
    """Campione indice (D4), secondo campione, pannello comune e tabella di inclusione.

    Usa solo la PRESENZA dei DSS (celle non vuote), mai i loro valori: e' fatta prima di qualsiasi outcome.
    Ordinamento D4: sorted() di Python sulle stringhe esatte, senza interpretare i numeri.
    """
    mode = lesion_mode(df)
    verified = mode == MODE_VERIFIED
    conflicts = _conflict_patients(df, verified)
    rows: list[dict] = []
    data: dict[str, PatientData] = {}
    excluded_sigma: set[str] = set(conflicts)

    for patient, g in df.groupby("patient", sort=True):
        patient = str(patient)
        if patient in conflicts:
            rows.append(_empty_row(patient, R_CONFLICT))
            continue
        if verified and g["lesion"].isna().any():
            excluded_sigma.add(patient)
            rows.append(_empty_row(patient, R_LESION_EMPTY))
            continue
        lesion_of: dict[str, str] | None = None
        if verified:
            lesion_of = {str(s): str(l) for s, l in zip(g["sample_id"], g["lesion"])}
        samples: dict[str, dict[str, float]] = {}
        for sid, gs in g[g["dss"].notna()].groupby("sample_id", sort=True):
            samples[str(sid)] = {str(d): float(v) for d, v in zip(gs["drug"], gs["dss"])}
        ids = sorted(samples)  # D4: ordinamento di stringa esatto
        n_les = len({lesion_of[s] for s in ids}) if verified else NA
        if len(ids) < 2:
            rows.append(_empty_row(patient, R_ONE_SAMPLE, n_campioni_con_dss=len(ids), n_lesioni=n_les,
                                   indice=ids[0] if ids else "",
                                   lesione_indice=lesion_of[ids[0]] if (ids and verified) else NA))
            continue
        index = ids[0]
        if verified:
            others = [s for s in ids if lesion_of[s] != lesion_of[index]]
            if not others:
                rows.append(_empty_row(patient, R_ONE_LESION, n_campioni_con_dss=len(ids), n_lesioni=n_les,
                                       indice=index, lesione_indice=lesion_of[index]))
                continue
            second = others[0]
        else:
            second = ids[1]
        panel = sorted(set(samples[index]) & set(samples[second]))
        base = dict(
            patient=patient, n_campioni_con_dss=len(ids), n_lesioni=n_les, indice=index, secondo=second,
            lesione_indice=lesion_of[index] if verified else NA,
            lesione_secondo=lesion_of[second] if verified else NA,
            n_pannello=len(panel), pannello=";".join(panel),
        )
        if not panel:
            rows.append({**base, "incluso": False, "motivo": R_PANEL_EMPTY})
            continue
        rows.append({**base, "incluso": True, "motivo": ""})
        data[patient] = PatientData(patient, index, second, panel, samples, lesion_of)

    cols = ["patient", "incluso", "motivo", "n_campioni_con_dss", "n_lesioni", "indice", "secondo",
            "lesione_indice", "lesione_secondo", "n_pannello", "pannello"]
    table = pd.DataFrame(rows, columns=cols)
    return Inclusion(mode, table, data, n_rows_no_patient, excluded_sigma, df)


# --------------------------------------------------------------------------- sigma_rep (D11)
def estimate_sigma(df: pd.DataFrame, inclusion: Inclusion) -> SigmaResult:
    """sigma_rep pooled tra organoidi della stessa lesione (D11, con le regole A10).

    Gruppi = (paziente, lesione, farmaco) con almeno 2 organoidi (sample_id distinti) con DSS non vuoto.
    I gruppi con tutti i DSS pari a 0 sono esclusi (effetto pavimento) e contati. Pooled =
    sqrt(somma degli scarti quadratici / somma dei gradi di liberta'). Le lesioni si contano dopo l'esclusione,
    su tutto il file (anche pazienti esclusi dal primario). Senza lesione verificata, D11 non si applica.
    """
    if inclusion.mode == MODE_NOT_VERIFIED:
        return SigmaResult(NOISE_NOT_VERIFIED, reason="lesione NON VERIFICATA: D11 non applicabile, si usa D2")
    usable = df[df["dss"].notna() & df["lesion"].notna() & ~df["patient"].isin(inclusion.excluded_from_sigma)]
    n_total = n_floor = 0
    ss_parts: list[float] = []
    df_parts: list[int] = []
    lesions: set[tuple[str, str]] = set()
    for (patient, lesion, _drug), g in usable.groupby(["patient", "lesion", "drug"], sort=True):
        vals = g["dss"].to_numpy(dtype=float)
        if len(vals) < 2:
            continue
        n_total += 1
        if not np.any(vals != 0.0):
            n_floor += 1
            continue
        ss_parts.append(math.fsum((vals - math.fsum(vals) / len(vals)) ** 2))
        df_parts.append(len(vals) - 1)
        lesions.add((str(patient), str(lesion)))
    counts = dict(n_groups_total=n_total, n_groups_floor=n_floor, n_groups_used=len(ss_parts),
                  n_lesions_used=len(lesions), df_total=int(sum(df_parts)))
    if len(lesions) < MIN_LESIONS_SIGMA or sum(df_parts) == 0:
        return SigmaResult(
            NOISE_NOT_VERIFIED, reason=f"meno di {MIN_LESIONS_SIGMA} lesioni con organoidi replicati: si usa D2", **counts
        )
    sigma = math.sqrt(math.fsum(ss_parts) / sum(df_parts))
    return SigmaResult(NOISE_VERIFIED, sigma_rep=sigma, reason="D11", **counts)


# --------------------------------------------------------------------------- endpoint (sezione 5)
def rank_condition(dss_index: np.ndarray, dss_second: np.ndarray, k: int) -> bool:
    """Condizione 1: F1 NON e' tra i primi k del secondo campione. Le parita' contano a favore di F1."""
    f1 = int(np.argmax(dss_index))
    n_better = int((dss_second > dss_second[f1]).sum())
    return n_better >= k


def pair_event(dss_index: np.ndarray, dss_second: np.ndarray, k: int, sigma: SigmaResult) -> int:
    """Evento (1) per una coppia, su vettori del pannello comune in ordine alfabetico dei farmaci.

    Rumore verificato: sezione 5 intera (riuso di compute_endpoint). Rumore NOT VERIFIED (D2): solo la
    condizione di rango, senza condizione sul calo.
    """
    if sigma.noise == NOISE_NOT_VERIFIED:
        return int(rank_condition(dss_index, dss_second, k))
    return int(compute_endpoint(dss_index[None, :], dss_second[None, :], k, sigma.sigma_rep, DELTA_Z)[0])


def state_at_k(n_panel: int, max_index: float | None, k: int) -> str:
    """A9 e A7: nessun farmaco attivo (max = 0) oppure pannello con meno di k+1 farmaci -> non valutabile.

    Con REGOLA_DSS_NEGATIVI_V034 un farmaco e' attivo solo con DSS > 0: nessun farmaco attivo se max <= 0.
    """
    if n_panel > 0 and (max_index <= 0.0 if REGOLA_DSS_NEGATIVI_V034 else max_index == 0.0):
        return ST_NO_ACTIVE
    if n_panel < k + 1:
        return ST_PANEL
    return ST_OK


def pair_record(d_a: dict[str, float], d_b: dict[str, float], sigma: SigmaResult, ks=KS) -> dict:
    """Valutazione di una coppia ordinata (a = indice, b = secondo) sul pannello comune."""
    panel = sorted(set(d_a) & set(d_b))
    a = np.array([d_a[d] for d in panel], dtype=float)
    b = np.array([d_b[d] for d in panel], dtype=float)
    rec: dict = {"n_pannello": len(panel)}
    if not panel:
        rec.update(f1="", dss_f1_indice=NA, dss_f1_secondo=NA, n_a_pari_massimo=0, parita=False, massimo_zero=False)
        max_a = None
    else:
        f1 = int(np.argmax(a))
        max_a = float(a[f1])
        n_tie = int((a == max_a).sum())
        rec.update(f1=panel[f1], dss_f1_indice=max_a, dss_f1_secondo=float(b[f1]),
                   n_a_pari_massimo=n_tie, parita=n_tie > 1, massimo_zero=max_a == 0.0)
    for k in ks:
        st = state_at_k(len(panel), max_a, k)
        rec[f"stato_k{k}"] = st
        # l'evento si calcola ogni volta che il pannello ha k+1 farmaci; il denominatore lo decide lo stato
        rec[f"evento_k{k}"] = pair_event(a, b, k, sigma) if len(panel) >= k + 1 else pd.NA
    return rec


def spearman_profile(d_a: dict[str, float], d_b: dict[str, float]):
    """Spearman tra i due profili sul pannello comune: n >= 3 e profili non costanti, altrimenti non calcolabile."""
    from scipy.stats import spearmanr

    panel = sorted(set(d_a) & set(d_b))
    if len(panel) < 3:
        return NC
    a = np.array([d_a[d] for d in panel], dtype=float)
    b = np.array([d_b[d] for d in panel], dtype=float)
    if np.ptp(a) == 0 or np.ptp(b) == 0:
        return NC
    return float(spearmanr(a, b).statistic)


def endpoint_table(inclusion: Inclusion, sigma: SigmaResult, ks=KS) -> pd.DataFrame:
    """Una riga per paziente incluso: coppia (indice, secondo), F1, parita', stato ed evento per ogni k."""
    delta = sigma.delta
    rows = []
    for patient, pdta in inclusion.data.items():
        d_a, d_b = pdta.samples[pdta.index], pdta.samples[pdta.second]
        rec = pair_record(d_a, d_b, sigma, ks)
        rows.append({
            "patient": patient, "indice": pdta.index, "secondo": pdta.second,
            "sigma_rep": NA if sigma.sigma_rep is None else sigma.sigma_rep,
            "delta": NA if delta is None else delta,
            "rho_spearman": spearman_profile(d_a, d_b),
            **rec,
        })
    cols = ["patient", "indice", "secondo", "sigma_rep", "delta", "n_pannello", "f1", "dss_f1_indice",
            "dss_f1_secondo", "n_a_pari_massimo", "parita", "massimo_zero", "rho_spearman"]
    cols += [c for k in ks for c in (f"stato_k{k}", f"evento_k{k}")]
    out = pd.DataFrame(rows, columns=cols)
    for k in ks:
        out[f"evento_k{k}"] = out[f"evento_k{k}"].astype("Int64")
    return out


def ordered_pairs(inclusion: Inclusion, sigma: SigmaResult, ks=KS) -> pd.DataFrame:
    """Analisi secondaria (sezione 4): tutte le coppie ordinate (a, b) di campioni di lesioni diverse (NON VERIFICATA:
    campioni distinti) dei pazienti inclusi. Le coppie dello stesso paziente NON sono indipendenti."""
    rows = []
    for patient, pdta in inclusion.data.items():
        ids = sorted(pdta.samples)
        for a in ids:
            for b in ids:
                if a == b:
                    continue
                if pdta.lesion is not None and pdta.lesion[a] == pdta.lesion[b]:
                    continue
                rec = pair_record(pdta.samples[a], pdta.samples[b], sigma, ks)
                rows.append({"patient": patient, "campione_a": a, "campione_b": b, **rec})
    cols = ["patient", "campione_a", "campione_b", "n_pannello", "f1", "dss_f1_indice", "dss_f1_secondo",
            "n_a_pari_massimo", "parita", "massimo_zero"] + [c for k in ks for c in (f"stato_k{k}", f"evento_k{k}")]
    out = pd.DataFrame(rows, columns=cols)
    for k in ks:
        out[f"evento_k{k}"] = out[f"evento_k{k}"].astype("Int64")
    return out
