"""Analisi primaria DESCRITTIVA (preregistrazione, sezioni 3, 4, 5, 9; D1, D2, D4, D10, D11, D13).

Stima la quota di pazienti in cui un secondo campione cambia la priorita' dei farmaci (endpoint della
sezione 5), con intervallo di Wilson e intervallo bootstrap per paziente (src/metrics.py). Secondari:
discordanza per farmaco con Benjamini-Hochberg, correlazione di Spearman tra i profili, coppie ordinate.
Riporta sempre i conteggi assoluti; scrive "non calcolabile" quando il denominatore e' zero.

Uso:
    python -m src.descriptive --data <file> --config config/schema.yaml --out results

Origine (controllo sul file grezzo, prima dello schema): un file e' sintetico solo se il nome contiene SINTETICO E
tutte le righe hanno origine = SINTETICO; nome e marcatore incoerenti fermano il comando. Le uscite dei dati
sintetici portano SINTETICO nel nome e in ogni riga.
Dati NON sintetici: il comando gira solo se esiste il tag git prereg-v0.3-firmata, se e' antenato di HEAD e se
il repository non ha modifiche non committate (CLAUDE.md: nessun DSS reale prima della preregistrazione
firmata). Non esiste nessun flag per scavalcare il controllo.

Le regole operative, una per una, stanno in docs/ANALISI_PRIMARIA.md.
"""
from __future__ import annotations

import argparse
import shlex
import subprocess
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.stats import binomtest, false_discovery_control, norm

from src import endpoint as ep
from src import metrics
from src.endpoint import NA, NC
from src.ingest import ORIGIN_COLUMN, SYNTHETIC_MARKER, SchemaError, ingest_samples, read_origin_column
from src.power_simulation import wilson_interval
from src.provenance import REPO_ROOT, SYNTHETIC_TAG, git_state, save_result

# --------------------------------------------------------------------------- parametri di protocollo
N_BOOT = 2000  # sezione 9: 2.000 ricampionamenti per paziente
SEED = 20261119  # seme fisso del bootstrap
FDR = 0.05  # sezione 5: Benjamini-Hochberg
MIN_SPEARMAN_PANEL = 3  # A13: Spearman solo con almeno 3 farmaci nel pannello comune
PREREG_TAG = "prereg-v0.3-firmata"
BASE_NAME = "analisi_primaria"
SUMMARY_COLUMNS = ["dataset", "modalita_lesione", "rumore", "analisi", "k", "misura", "n", "denominatore",
                   "valore", "ic_lo", "ic_hi", "metodo", "nota"]
WARNING_PAIRS = "le coppie dello stesso paziente NON sono indipendenti: intervallo solo bootstrap per paziente"


class PreregError(RuntimeError):
    """Il controllo sulla preregistrazione firmata non e' superato."""


class OriginError(RuntimeError):
    """Nome del file e marcatore `origine` nei dati non sono coerenti."""


# --------------------------------------------------------------------------- controllo preregistrazione (dati veri)
def _git_ok(repo: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=repo, capture_output=True, text=True)


def check_prereg_signed(repo_root: str | Path = REPO_ROOT, tag: str = PREREG_TAG) -> None:
    """Dati veri: serve (1) il tag, (2) il tag antenato di HEAD, (3) nessuna modifica non committata."""
    repo = Path(repo_root)
    if _git_ok(repo, "rev-parse", "--verify", "--quiet", f"refs/tags/{tag}").returncode != 0:
        raise PreregError(f"STOP: il tag git '{tag}' non esiste. Nessuna analisi di dati reali prima della "
                          "preregistrazione firmata e committata.")
    if _git_ok(repo, "merge-base", "--is-ancestor", f"refs/tags/{tag}", "HEAD").returncode != 0:
        raise PreregError(f"STOP: il tag '{tag}' non e' antenato di HEAD: il codice non parte dalla versione firmata.")
    status = _git_ok(repo, "status", "--porcelain")
    if status.returncode != 0:
        raise PreregError("STOP: impossibile leggere lo stato git del repository.")
    if status.stdout.strip():
        raise PreregError("STOP: il repository ha modifiche non committate. Committa o scarta le modifiche, poi riprova.")


# --------------------------------------------------------------------------- intervalli e quote
def _event_frame(df: pd.DataFrame, k: int, mask: pd.Series) -> pd.DataFrame:
    sub = df[mask]
    return pd.DataFrame({"patient": sub["patient"].to_numpy(), "evento": sub[f"evento_k{k}"].astype(int).to_numpy()})


def quota_rows(frame: pd.DataFrame, *, ctx: dict, analisi: str, k, misura: str, nota: str = "", wilson: bool = True) -> list[dict]:
    """Quota di eventi con conteggi assoluti, Wilson (se indipendenti) e bootstrap per paziente.

    `frame` ha una riga per unita' (paziente o coppia) con le colonne patient ed evento.
    Denominatore zero -> "non calcolabile" ovunque, mai 0.
    """
    n_ev, den = int(frame["evento"].sum()), len(frame)
    base = dict(analisi=analisi, k=k, misura=misura, n=n_ev, denominatore=den, nota=nota)
    if den == 0:
        out = [dict(base, valore=NC, ic_lo=NC, ic_hi=NC, metodo="bootstrap per paziente")]
        if wilson:
            out.insert(0, dict(base, valore=NC, ic_lo=NC, ic_hi=NC, metodo="Wilson 95%"))
        return out
    point = n_ev / den
    rows = []
    if wilson:
        lo, hi = wilson_interval(n_ev, den)
        rows.append(dict(base, valore=point, ic_lo=lo, ic_hi=hi, metodo="Wilson 95%"))
    bs = metrics.bootstrap_ci(frame, lambda d: float(d["evento"].mean()), patient_col="patient",
                              n_boot=ctx["n_boot"], seed=ctx["seed"])
    rows.append(dict(base, valore=point, ic_lo=bs["lo"], ic_hi=bs["hi"],
                     metodo=f"bootstrap per paziente ({ctx['n_boot']} ricampionamenti, seed {ctx['seed']})"))
    return rows


# --------------------------------------------------------------------------- secondari
def per_drug_table(inclusion: ep.Inclusion, sigma: ep.SigmaResult) -> pd.DataFrame:
    """Discordanza per farmaco: |ΔDSS| > delta sui pazienti inclusi che hanno il farmaco nel pannello comune.

    Test: binomiale esatto unilaterale della quota di discordanti contro p0 = 2 * (1 - Phi(z)), la quota attesa
    con solo rumore di replica; poi Benjamini-Hochberg. Senza delta (D2 / lesione NON VERIFICATA): non calcolabile.
    """
    per_drug: dict[str, list[float]] = {}
    for pdta in inclusion.data.values():
        a, b = pdta.samples[pdta.index], pdta.samples[pdta.second]
        for d in pdta.panel:
            per_drug.setdefault(d, []).append(a[d] - b[d])
    cols = ["farmaco", "n_pazienti", "n_discordanti", "quota_discordanti", "p0_solo_rumore", "p_value", "q_bh",
            "significativo_fdr"]
    if not per_drug:
        return pd.DataFrame(columns=cols)
    drugs = sorted(per_drug)
    delta = sigma.delta
    if delta is None:
        return pd.DataFrame([{"farmaco": d, "n_pazienti": len(per_drug[d]), "n_discordanti": NC, "quota_discordanti": NC,
                              "p0_solo_rumore": NA, "p_value": NC, "q_bh": NC, "significativo_fdr": NC} for d in drugs],
                            columns=cols)
    p0 = float(2 * norm.sf(ep.DELTA_Z))
    n = [len(per_drug[d]) for d in drugs]
    disc = [int((np.abs(np.array(per_drug[d])) > delta).sum()) for d in drugs]
    pv = np.array([binomtest(x, m, p0, alternative="greater").pvalue for x, m in zip(disc, n)])
    q = false_discovery_control(pv, method="bh")
    return pd.DataFrame({
        "farmaco": drugs, "n_pazienti": n, "n_discordanti": disc,
        "quota_discordanti": [x / m for x, m in zip(disc, n)], "p0_solo_rumore": p0,
        "p_value": pv, "q_bh": q, "significativo_fdr": [bool(v < FDR) for v in q],
    }, columns=cols)


def spearman_rows(pazienti: pd.DataFrame, ctx: dict) -> list[dict]:
    """Mediana dei rho per paziente (A13), con IC bootstrap per paziente e numero di pazienti calcolabili."""
    comp = pazienti[pazienti["rho_spearman"].map(lambda v: not isinstance(v, str))]
    n_tot, n_ok = len(pazienti), len(comp)
    base = dict(analisi="secondaria_spearman", k="", n=n_ok, denominatore=n_tot, nota=f"per paziente sul pannello comune, "
                f"almeno {MIN_SPEARMAN_PANEL} farmaci e profili non costanti")
    if n_ok == 0:
        return [dict(base, misura="mediana_rho_spearman", valore=NC, ic_lo=NC, ic_hi=NC, metodo="mediana dei rho per paziente")]
    frame = pd.DataFrame({"patient": comp["patient"].to_numpy(), "rho": comp["rho_spearman"].astype(float).to_numpy()})
    bs = metrics.bootstrap_ci(frame, lambda d: float(np.median(d["rho"])), patient_col="patient",
                              n_boot=ctx["n_boot"], seed=ctx["seed"])
    return [dict(base, misura="mediana_rho_spearman", valore=float(np.median(frame["rho"])), ic_lo=bs["lo"], ic_hi=bs["hi"],
                 metodo=f"mediana dei rho; bootstrap per paziente ({ctx['n_boot']} ricampionamenti, seed {ctx['seed']})")]


# --------------------------------------------------------------------------- analisi
def stage_inclusion(df: pd.DataFrame) -> ep.Inclusion:
    """Fase 1: inclusione ed esclusioni paziente per paziente. Non guarda nessun valore di risposta."""
    canon, n_no_patient = ep.canonicalize(df)
    return ep.build_inclusion(canon, n_no_patient)


def stage_outcomes(inclusion: ep.Inclusion, *, dataset: str, n_boot: int = N_BOOT, seed: int = SEED) -> dict[str, pd.DataFrame]:
    """Fase 2: sigma_rep, endpoint e stime. Restituisce riepilogo, pazienti, farmaci, coppie."""
    canon = inclusion.canon
    ctx = {"n_boot": n_boot, "seed": seed}
    sigma = ep.estimate_sigma(canon, inclusion)
    pazienti = ep.endpoint_table(inclusion, sigma)
    farmaci = per_drug_table(inclusion, sigma)
    coppie = ep.ordered_pairs(inclusion, sigma)
    rows: list[dict] = []

    def add(analisi, misura, k="", n="", den="", valore="", lo="", hi="", metodo="", nota=""):
        rows.append(dict(analisi=analisi, k=k, misura=misura, n=n, denominatore=den, valore=valore, ic_lo=lo, ic_hi=hi,
                         metodo=metodo, nota=nota))

    # parametri di protocollo (nessun numero scritto a mano altrove)
    for name, val in [("z_delta", ep.DELTA_Z), ("n_boot", n_boot), ("seed", seed), ("fdr", FDR),
                      ("min_lesioni_sigma", ep.MIN_LESIONS_SIGMA), ("k_primario", ep.K_PRIMARY),
                      ("k_secondario", ep.K_SECONDARY), ("min_pannello_spearman", MIN_SPEARMAN_PANEL)]:
        add("parametri", name, valore=val)
    # rumore
    add("rumore", "modalita_rumore", valore=sigma.noise, nota=sigma.reason)
    add("rumore", "sigma_rep", valore=NA if sigma.sigma_rep is None else sigma.sigma_rep)
    add("rumore", "delta", valore=NA if sigma.delta is None else sigma.delta)
    for name, val in [("gruppi_lesione_farmaco_con_repliche", sigma.n_groups_total),
                      ("gruppi_esclusi_tutti_dss_zero", sigma.n_groups_floor),
                      ("gruppi_usati", sigma.n_groups_used), ("lesioni_usate", sigma.n_lesions_used)]:
        add("rumore", name, n=val)
    # inclusione
    tab = inclusion.table
    add("inclusione", "pazienti_nel_file", n=len(tab))
    add("inclusione", "pazienti_inclusi", n=int(tab["incluso"].sum()), den=len(tab))
    for reason in ep.EXCLUSION_REASONS:
        add("inclusione", "esclusi", n=int((tab["motivo"] == reason).sum()), den=len(tab), nota=reason)
    add("inclusione", "righe_senza_paziente_scartate", n=inclusion.n_rows_no_patient)

    n_inc = len(pazienti)
    for k in ep.KS:
        label = "primaria" if k == ep.K_PRIMARY else "secondaria"
        st, ev = pazienti[f"stato_k{k}"], pazienti[f"evento_k{k}"]
        ok = st == ep.ST_OK
        add("conteggi", "pazienti_inclusi", k=k, n=n_inc)
        add("conteggi", "non_valutabili_pannello_minore_k_piu_1", k=k, n=int((st == ep.ST_PANEL).sum()), den=n_inc)
        add("conteggi", "non_valutabili_nessun_farmaco_attivo", k=k, n=int((st == ep.ST_NO_ACTIVE).sum()), den=n_inc)
        add("conteggi", "valutabili", k=k, n=int(ok.sum()), den=n_inc)
        add("conteggi", "parita_sul_massimo_indice_tra_i_valutabili", k=k, n=int((ok & pazienti["parita"].astype(bool)).sum()), den=int(ok.sum()))
        # stima primaria (o secondaria per k=3)
        rows += quota_rows(_event_frame(pazienti, k, ok), ctx=ctx, analisi=label, k=k, misura="quota_pazienti_con_evento")
        # sensibilita': senza i pazienti con parita' sul massimo dell'indice (sezione 5)
        rows += quota_rows(_event_frame(pazienti, k, ok & ~pazienti["parita"].astype(bool)), ctx=ctx, analisi="sensibilita", k=k,
                           misura="quota_senza_parita", nota="esclude le parita' sul massimo dell'indice (sezione 5)")
        # sensibilita' descrittiva: include i pazienti senza farmaco attivo (A9)
        incl_zero = (st == ep.ST_OK) | ((st == ep.ST_NO_ACTIVE) & (pazienti["n_pannello"] >= k + 1))
        rows += quota_rows(_event_frame(pazienti, k, incl_zero), ctx=ctx, analisi="sensibilita", k=k,
                           misura="quota_con_pazienti_senza_farmaco_attivo",
                           nota="descrittiva: include i pazienti con DSS massimo pari a 0 nell'indice")
    # secondari
    n_tested = len(farmaci)
    add("secondaria_farmaci", "farmaci_testati", n=n_tested,
        nota="dettaglio per farmaco nel file _farmaci" if n_tested else NC)
    if sigma.delta is not None and n_tested:
        add("secondaria_farmaci", "farmaci_significativi_fdr", n=int(farmaci["significativo_fdr"].sum()), den=n_tested,
            nota="binomiale esatto unilaterale contro p0 del solo rumore, poi Benjamini-Hochberg")
    else:
        add("secondaria_farmaci", "farmaci_significativi_fdr", n=NC, den=n_tested, valore=NC,
            nota="delta non applicabile (rumore NOT VERIFIED) oppure nessun farmaco")
    rows += spearman_rows(pazienti, ctx)
    # coppie ordinate (sezione 4), a parte
    for k in ep.KS:
        st = coppie[f"stato_k{k}"] if len(coppie) else pd.Series([], dtype=object)
        ok = st == ep.ST_OK
        add("secondaria_coppie", "coppie_totali", k=k, n=len(coppie), nota="coppie ordinate di campioni di lesioni diverse")
        add("secondaria_coppie", "coppie_valutabili", k=k, n=int(ok.sum()), den=len(coppie))
        frame = (_event_frame(coppie, k, ok) if len(coppie)
                 else pd.DataFrame({"patient": [], "evento": []}))
        rows += quota_rows(frame, ctx=ctx, analisi="secondaria_coppie", k=k, misura="quota_coppie_con_evento",
                           nota=WARNING_PAIRS, wilson=False)

    summary = pd.DataFrame(rows)
    summary.insert(0, "rumore", sigma.noise)
    summary.insert(0, "modalita_lesione", inclusion.mode)
    summary.insert(0, "dataset", dataset)
    for c in SUMMARY_COLUMNS:
        if c not in summary.columns:
            summary[c] = ""
    summary = summary[SUMMARY_COLUMNS].astype(object)
    summary = summary.where(summary.notna(), "")
    return {"riepilogo": summary, "pazienti": pazienti, "farmaci": farmaci, "coppie": coppie}


def analyze(df: pd.DataFrame, *, dataset: str = "SINTETICO", n_boot: int = N_BOOT, seed: int = SEED) -> dict[str, pd.DataFrame]:
    """Pipeline completa in memoria: inclusione + esiti. Restituisce anche la tabella di inclusione."""
    inc = stage_inclusion(df)
    out = stage_outcomes(inc, dataset=dataset, n_boot=n_boot, seed=seed)
    out["inclusione"] = inc.table
    return out


# --------------------------------------------------------------------------- riga di comando
def is_synthetic_name(path: str | Path) -> bool:
    return SYNTHETIC_TAG in Path(path).name


def classify_origin(path: str | Path) -> bool:
    """True = dati sintetici, False = dati veri. Controllo sul file GREZZO, prima dello schema.

    Sintetico solo se il nome contiene SINTETICO E tutte le righe hanno origine = SINTETICO.
    Nome con SINTETICO ma marcatore assente o incompleto: errore. Marcatore presente (almeno una riga con
    origine = SINTETICO) ma nome senza SINTETICO: errore. Si legge solo la colonna `origine`.
    """
    name_synth = is_synthetic_name(path)
    values = read_origin_column(path)
    n_marked = 0 if values is None else sum(v == SYNTHETIC_MARKER for v in values)
    if name_synth:
        if values is None:
            raise OriginError(f"STOP: il nome del file contiene {SYNTHETIC_TAG} ma la colonna '{ORIGIN_COLUMN}' manca nei dati.")
        if n_marked != len(values):
            raise OriginError(f"STOP: il nome del file contiene {SYNTHETIC_TAG} ma solo {n_marked} righe su {len(values)} "
                              f"hanno {ORIGIN_COLUMN} = {SYNTHETIC_MARKER}: marcatore incompleto.")
        return True
    if n_marked:
        raise OriginError(f"STOP: {n_marked} righe hanno {ORIGIN_COLUMN} = {SYNTHETIC_MARKER} ma il nome del file non contiene "
                          f"{SYNTHETIC_TAG}: dati sintetici con un nome da dati veri.")
    return False


def main(argv: list[str] | None = None, repo_root: str | Path = REPO_ROOT) -> int:
    ap = argparse.ArgumentParser(description="Analisi primaria descrittiva (preregistrazione, sezioni 3-5 e 9)")
    ap.add_argument("--data", required=True, help="tabella lunga .csv/.xlsx")
    ap.add_argument("--config", required=True, help="schema delle colonne (config/schema.yaml)")
    ap.add_argument("--out", required=True, help="cartella dei risultati")
    args = ap.parse_args(argv)
    try:
        synthetic = classify_origin(args.data)  # sul file grezzo, prima dello schema
        if not synthetic:
            check_prereg_signed(repo_root)
    except (OriginError, PreregError, SchemaError) as exc:
        print(str(exc), file=sys.stderr)
        return 2
    dataset = SYNTHETIC_TAG if synthetic else "REALE"
    if synthetic:
        print(f"*** DATI SINTETICI ({SYNTHETIC_TAG}): nessun dato di risposta reale e' usato ***")
    name = f"{SYNTHETIC_TAG}_{BASE_NAME}" if synthetic else BASE_NAME
    command = shlex.join(["python", "-m", "src.descriptive", *(argv if argv is not None else sys.argv[1:])])
    git_info = git_state()  # una sola fotografia: i risultati scritti in results/ non sporcano i successivi
    common = dict(seed=SEED, synthetic=synthetic, input_files=[args.data], command=command,
                  results_dir=args.out, git_info=git_info)

    try:
        df = ingest_samples(args.data, args.config)
        inc = stage_inclusion(df)  # nessun file e' ancora stato scritto: un errore sui dati non lascia risultati parziali
    except (ep.EndpointError, SchemaError) as exc:
        print(str(exc), file=sys.stderr)
        return 2
    save_result(inc.table, f"{name}_inclusione", **common)  # PRIMA di qualsiasi calcolo degli esiti
    out = stage_outcomes(inc, dataset=dataset)
    save_result(out["pazienti"], f"{name}_pazienti", **common)
    save_result(out["farmaci"], f"{name}_farmaci", **common)
    save_result(out["coppie"], f"{name}_coppie", **common)
    path = save_result(out["riepilogo"], name, **common)
    print(f"Modalita' lesione: {inc.mode}")
    print(f"Salvato: {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
