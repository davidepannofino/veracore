"""Dai file veri al risultato con UN solo comando (da lanciare dopo la firma della preregistrazione).

Istruzioni in parole semplici: docs/ESEGUIRE_ANALISI_REALE.md.

    python -m src.esegui_analisi_reale --s5 <Data S5.xlsx> --s1 <Data S1.xlsx> --audit <DATA_AUDIT.csv>

Ordine fisso dei passi:
  (a) origine e firma: con dati veri servono il tag git prereg-v0.3-firmata, antenato di HEAD, e l'albero pulito
      (src/descriptive.check_prereg_signed). Il controllo viene PRIMA di aprire Data S5. Nessun flag lo salta.
  (b) src/prepara_s5.py: tabelle lunghe e rapporto di soli conteggi. Con --solo-preparazione ci si ferma qui.
  (c) controllo D8 (preregistrazione, sezione 13): serve <out>/D8_riproduzione.csv con esito RIPRODOTTO, fatto
      sullo stesso file Data S5 da src/d8_riproduzione.py. Senza, il comando si ferma PRIMA dell'analisi primaria.
  (d) analisi primaria sul pannello primario D15, con le funzioni di src/descriptive.py: gli stessi file che
      scrive `python -m src.descriptive` sulla tabella primaria.
  (e) analisi secondarie con le stesse funzioni: pannello esteso (farmaci singoli), pannello esteso con le
      combinazioni (D12), sensibilita' per libreria (D15).

DSS negativi (preregistrazione v0.3.4, sezione 5). Senza opzioni un DSS negativo ferma il comando (src/endpoint.py).
Con --regola-dss-negativi-v034 si applica la regola gia' decisa: i negativi non fermano il calcolo e non vengono
troncati ne' corretti, l'evento usa l'ordine dei DSS (e le differenze se sigma_rep e' stimabile), un farmaco e'
"attivo" solo con DSS > 0. L'opzione e' accettata solo se docs/DEVIATIONS.md, committato, contiene la voce
"Attuazione della regola DSS negativi (v0.3.4)"; ogni riepilogo dichiara che la regola e' attiva.

Ogni file va in <out> (di norma results/) con il suo .meta.json (src/provenance.py). In stampa compaiono solo
conteggi e nomi di file, mai valori di risposta. Con dati sintetici ogni uscita porta SINTETICO nel nome.
"""
from __future__ import annotations

import argparse
import dataclasses
import json
import shlex
import subprocess
import sys
from pathlib import Path

import pandas as pd

from src import descriptive as ds
from src import endpoint as ep
from src import prepara_s5 as ps
from src.ingest import SchemaError, ingest_samples
from src.provenance import REPO_ROOT, SYNTHETIC_TAG, save_result

# --------------------------------------------------------------------------- controllo D8 (sezione 13)
D8_NOME = "D8_riproduzione"
D8_ESITO_OK = "RIPRODOTTO"
D8_COLONNA = "esito"

# --------------------------------------------------------------------------- nomi delle analisi
PRIMARIA = ds.BASE_NAME  # "analisi_primaria": gli stessi nomi di python -m src.descriptive
SEC_ESTESO = "analisi_secondaria_pannello_esteso"
SEC_COMBINAZIONI = "analisi_secondaria_pannello_esteso_combinazioni"
SEC_LIBRERIA = "analisi_secondaria_libreria"
ETICHETTE = {
    SEC_ESTESO: "SECONDARIA: pannello esteso, tutti i farmaci singoli (D15)",
    SEC_COMBINAZIONI: "SECONDARIA: pannello esteso con le combinazioni (D12, D15)",
    SEC_LIBRERIA: "SECONDARIA: sensibilita' per libreria sul pannello primario (D15)",
}
COLONNA_ETICHETTA = "analisi_preregistrata"
R_LIBRERIA = "nessuna libreria in comune tra indice e secondo campione (D15)"
_LIBRERIE = {ps.LIB1: {ps.LIB1}, ps.LIB2: {ps.LIB2}, ps.ENTRAMBE: {ps.LIB1, ps.LIB2}, ps.NESSUNA: set()}


# --------------------------------------------------------------------------- regola DSS negativi (v0.3.4, sezione 5)
FILE_DEVIAZIONI = "docs/DEVIATIONS.md"
VOCE_DSS_NEGATIVI = "Attuazione della regola DSS negativi (v0.3.4)"
MISURA_REGOLA = "regola_dss_negativi_v034"


class DeviazioneError(RuntimeError):
    """L'opzione --regola-dss-negativi-v034 e' stata chiesta senza la voce committata in docs/DEVIATIONS.md."""


def controlla_voce_dss_negativi(repo_root: str | Path = REPO_ROOT) -> None:
    """La regola si puo' accendere solo se docs/DEVIATIONS.md, nella versione COMMITTATA (HEAD) e senza modifiche
    in sospeso, contiene la voce VOCE_DSS_NEGATIVI (preregistrazione v0.3.4, sezione 5)."""
    base = f"STOP: --regola-dss-negativi-v034 si puo' usare solo se {FILE_DEVIAZIONI}, committato, contiene la voce "
    base += f"'{VOCE_DSS_NEGATIVI}' (preregistrazione v0.3.4, sezione 5). "
    committato = subprocess.run(["git", "show", f"HEAD:{FILE_DEVIAZIONI}"], cwd=repo_root, capture_output=True, text=True)
    if committato.returncode != 0:
        raise DeviazioneError(base + f"{FILE_DEVIAZIONI} non e' committato.")
    if VOCE_DSS_NEGATIVI not in committato.stdout:
        raise DeviazioneError(base + "La versione committata non contiene la voce.")
    stato = subprocess.run(["git", "status", "--porcelain", "--", FILE_DEVIAZIONI], cwd=repo_root, capture_output=True, text=True)
    if stato.returncode != 0 or stato.stdout.strip():
        raise DeviazioneError(base + f"{FILE_DEVIAZIONI} ha modifiche non committate.")


class D8Error(RuntimeError):
    """Il controllo con il risultato pubblicato (D8, sezione 13) manca o non e' superato."""


def controlla_d8(out: str | Path, *, sintetico: bool, sha_s5: str) -> Path:
    """Controllo D8: il file lo scrive src/d8_riproduzione.py (scelta confermata dal responsabile della letteratura il 19/11/2026).

    Contratto del file, salvato con src/provenance.save_result:
      - <out>/D8_riproduzione.csv (SINTETICO_D8_riproduzione.csv per i dati sintetici);
      - colonna `esito`, almeno una riga, tutte con il valore esatto RIPRODOTTO;
      - .meta.json accanto, con `synthetic` coerente e, tra gli input_sha256, l'SHA256 dello stesso Data S5.
    """
    nome = f"{SYNTHETIC_TAG}_{D8_NOME}" if sintetico else D8_NOME
    csv, meta = Path(out) / f"{nome}.csv", Path(out) / f"{nome}.meta.json"
    base = (f"STOP (preregistrazione, sezione 13): prima dell'analisi primaria va riprodotto il risultato pubblicato "
            f"scelto in D8. ")
    if not csv.is_file():
        raise D8Error(base + f"Non trovo {csv}.")
    tab = pd.read_csv(csv, dtype=str, keep_default_na=False)
    if D8_COLONNA not in tab.columns or len(tab) == 0:
        raise D8Error(base + f"{csv.name} deve avere la colonna '{D8_COLONNA}' e almeno una riga.")
    esiti = sorted({v.strip() for v in tab[D8_COLONNA]})
    if esiti != [D8_ESITO_OK]:
        raise D8Error(base + f"In {csv.name} l'esito e' {esiti}, non '{D8_ESITO_OK}': ci si ferma e si cerca la causa.")
    if not meta.is_file():
        raise D8Error(base + f"Manca {meta.name}: il risultato di D8 va salvato con il suo .meta.json.")
    info = json.loads(meta.read_text(encoding="utf-8"))
    if info.get("synthetic") is not sintetico:
        raise D8Error(base + f"{meta.name} ha synthetic = {info.get('synthetic')}, i dati in ingresso sono "
                      f"{'sintetici' if sintetico else 'veri'}.")
    if sha_s5 not in (info.get("input_sha256") or {}).values():
        raise D8Error(base + f"{meta.name} non registra l'SHA256 di questo Data S5: D8 e' stato fatto su un altro file.")
    return csv


# --------------------------------------------------------------------------- sensibilita' per libreria (D15)
def inclusione_per_libreria(inc: ep.Inclusion, librerie: dict[str, str]) -> ep.Inclusion:
    """Restano solo i pazienti in cui indice e secondo campione hanno una libreria in comune (run_id_lib1 presente
    in entrambi, oppure run_id_lib2 presente in entrambi). Gli altri sono esclusi con il motivo.

    Il rumore di replica non cambia: si stima sulla stessa tabella dell'analisi primaria (A10: le repliche
    descrivono il saggio), cosi' la sensibilita' cambia solo i pazienti e non la soglia.
    """
    fuori = [p for p, d in inc.data.items() if not (_LIBRERIE[librerie[d.index]] & _LIBRERIE[librerie[d.second]])]
    tabella = inc.table.copy()
    sel = tabella["patient"].isin(fuori)
    tabella.loc[sel, "incluso"] = False
    tabella.loc[sel, "motivo"] = R_LIBRERIA
    return dataclasses.replace(inc, table=tabella, data={p: d for p, d in inc.data.items() if p not in fuori})


# --------------------------------------------------------------------------- analisi con le funzioni di src/descriptive.py
def salva_analisi(inc: ep.Inclusion, base: str, *, dataset: str, common: dict) -> Path:
    """Stessa sequenza di src/descriptive.main: prima la tabella di inclusione, poi gli esiti."""
    prefisso = f"{SYNTHETIC_TAG}_" if common["synthetic"] else ""
    nome = f"{prefisso}{base}"
    save_result(inc.table, f"{nome}_inclusione", **common)  # PRIMA di qualsiasi calcolo degli esiti
    out = ds.stage_outcomes(inc, dataset=dataset)
    save_result(out["pazienti"], f"{nome}_pazienti", **common)
    save_result(out["farmaci"], f"{nome}_farmaci", **common)
    save_result(out["coppie"], f"{nome}_coppie", **common)
    riepilogo = out["riepilogo"]
    if base != PRIMARIA:  # i file secondari dichiarano in ogni riga di non essere il risultato primario
        if base == SEC_LIBRERIA:
            riga = {c: "" for c in riepilogo.columns}
            riga.update(dataset=dataset, modalita_lesione=inc.mode, rumore=riepilogo["rumore"].iloc[0],
                        analisi="inclusione", misura="esclusi", n=int((inc.table["motivo"] == R_LIBRERIA).sum()),
                        denominatore=len(inc.table), nota=R_LIBRERIA)
            riepilogo = pd.concat([riepilogo, pd.DataFrame([riga], dtype=object)], ignore_index=True)
        riepilogo.insert(0, COLONNA_ETICHETTA, ETICHETTE[base])
    if ep.REGOLA_DSS_NEGATIVI_V034:  # il risultato dichiara di essere stato calcolato con la regola v0.3.4
        riga = {c: "" for c in riepilogo.columns}
        riga.update({c: riepilogo[c].iloc[0] for c in ("dataset", "modalita_lesione", "rumore", COLONNA_ETICHETTA)
                     if c in riepilogo.columns})
        riga.update(analisi="parametri", misura=MISURA_REGOLA, valore="attiva", n=int((inc.canon["dss"] < 0).sum()),
                    nota=f"n = righe con DSS < 0 nella tabella; preregistrazione v0.3.4, sezione 5; voce in {FILE_DEVIAZIONI}")
        riepilogo = pd.concat([riepilogo, pd.DataFrame([riga], dtype=object)], ignore_index=True)
    return save_result(riepilogo, nome, **common)


def main(argv: list[str] | None = None, repo_root: str | Path = REPO_ROOT) -> int:
    ap = argparse.ArgumentParser(description="Dai file veri al risultato con un solo comando (dopo la firma)")
    ps.aggiungi_argomenti(ap)
    ap.add_argument("--solo-preparazione", action="store_true",
                    help="si ferma dopo la preparazione di Data S5: nessun controllo D8, nessuna analisi")
    ap.add_argument("--regola-dss-negativi-v034", action="store_true",
                    help=f"applica la regola DSS negativi della preregistrazione v0.3.4 (sezione 5); serve la voce "
                         f"'{VOCE_DSS_NEGATIVI}' in {FILE_DEVIAZIONI}, committato")
    args = ap.parse_args(argv)
    command = shlex.join(["python", "-m", "src.esegui_analisi_reale", *(argv if argv is not None else sys.argv[1:])])
    if args.regola_dss_negativi_v034:
        try:
            controlla_voce_dss_negativi(repo_root)
        except DeviazioneError as exc:
            print(str(exc), file=sys.stderr)
            return 2
    # la regola vale solo dentro questa esecuzione: senza l'opzione resta lo stop di src/endpoint.py
    precedente = ep.REGOLA_DSS_NEGATIVI_V034
    ep.REGOLA_DSS_NEGATIVI_V034 = bool(args.regola_dss_negativi_v034)
    try:
        return _esegui(args, command, repo_root)
    finally:
        ep.REGOLA_DSS_NEGATIVI_V034 = precedente


def _esegui(args: argparse.Namespace, command: str, repo_root: str | Path) -> int:
    # (a) origine e firma, poi (b) preparazione: il controllo sulla firma e' il primo passo di ps.prepara
    try:
        prep = ps.esegui_preparazione(args.s5, args.s1, args.audit, args.config, args.out, command=command,
                                      repo_root=repo_root)
    except ps.ERRORI as exc:
        print(str(exc), file=sys.stderr)
        return 2
    percorsi = prep.percorsi
    if args.solo_preparazione:
        print("Fermato dopo la preparazione (--solo-preparazione): nessun controllo D8, nessuna analisi.")
        return 0

    # (c) controllo D8: prima dell'analisi primaria
    try:
        d8 = controlla_d8(args.out, sintetico=prep.sintetico, sha_s5=prep.sha["S5"])
    except D8Error as exc:
        print(str(exc), file=sys.stderr)
        return 2
    print(f"Controllo D8 superato: {d8}")
    if ep.REGOLA_DSS_NEGATIVI_V034:
        print(f"Regola DSS negativi v0.3.4 ATTIVA (voce committata in {FILE_DEVIAZIONI}).")

    # tutte le tabelle di inclusione prima di qualsiasi esito: un errore sui dati (per esempio DSS negativi,
    # src/endpoint.py) ferma il comando senza lasciare risultati parziali dell'analisi
    try:
        primaria = ingest_samples(percorsi[ps.T_PRIMARIA], args.config)
        estesa = ingest_samples(percorsi[ps.T_ESTESA], args.config)
        combinazioni = ingest_samples(percorsi[ps.T_COMBINAZIONI], args.config)
        inc_primaria = ds.stage_inclusion(primaria)
        inclusioni = {
            SEC_ESTESO: ds.stage_inclusion(estesa),
            SEC_COMBINAZIONI: ds.stage_inclusion(pd.concat([estesa, combinazioni], ignore_index=True)),
            SEC_LIBRERIA: inclusione_per_libreria(inc_primaria, prep.librerie),
        }
    except (ep.EndpointError, SchemaError) as exc:
        print(str(exc), file=sys.stderr)
        return 2
    ingressi = [prep.ingressi["S5"], prep.ingressi["S1"], prep.ingressi["audit"], str(d8)]
    common = dict(seed=ds.SEED, synthetic=prep.sintetico, command=command, results_dir=args.out, git_info=prep.git_info)

    # (d) analisi primaria, pannello primario D15
    path = salva_analisi(inc_primaria, PRIMARIA, dataset=prep.dataset,
                         common=dict(common, input_files=[str(percorsi[ps.T_PRIMARIA]), *ingressi]))
    print(f"Modalita' lesione: {inc_primaria.mode}")
    print(f"Analisi primaria salvata: {path}")

    # (e) analisi secondarie, con le stesse funzioni
    tabelle = {SEC_ESTESO: [ps.T_ESTESA], SEC_COMBINAZIONI: [ps.T_ESTESA, ps.T_COMBINAZIONI], SEC_LIBRERIA: [ps.T_PRIMARIA]}
    for base, inc in inclusioni.items():
        path = salva_analisi(inc, base, dataset=prep.dataset,
                             common=dict(common, input_files=[*(str(percorsi[t]) for t in tabelle[base]), *ingressi]))
        print(f"{ETICHETTE[base]} salvata: {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
