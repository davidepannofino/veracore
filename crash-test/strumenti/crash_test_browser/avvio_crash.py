"""Crash test nel browser: codice Python eseguito da Pyodide, nel Web Worker.

Importa strumenti/crash_test.py, strumenti/crash_test_rapporto.py e le funzioni di src/ cosi' come sono (il worker li ha
gia' verificati con impronte_codice.json) e lancia lo stesso comando, strumenti.crash_test.main. Due sole differenze,
solo dentro il browser:
  - git non c'e': provenance.git_state restituisce l'impronta del manifesto del codice al posto del commit;
  - niente porta sul retro: se il file e' riconosciuto come derivato dai dati di Kryeziu (crash_test.motivo_kryeziu,
    gli stessi criteri del comando) la pagina NON calcola, nemmeno con la firma: rimanda ai risultati ufficiali.
"""
from __future__ import annotations

import contextlib
import io
import json
import os
import sys
import time
import zipfile
from pathlib import Path

REPO = Path("/home/pyodide/repo")
LAVORO = Path("/home/pyodide/lavoro")
USCITA = "rapporto"  # cartella del Rapporto, relativa a LAVORO (come il comando lanciato da una cartella di lavoro)
DATA_ZIP = (1980, 1, 1, 0, 0, 0)  # data fissa delle voci dello zip


def installa(impronta_manifesto: str) -> None:
    """Prima di qualsiasi import del progetto: git_state senza git, firma mai concessa nel browser."""
    sys.path.insert(0, str(REPO))
    from src import provenance as pv

    def stato_browser():
        return {"commit": "browser: codice verificato con impronte_codice.json", "git_dirty": None,
                "manifesto_codice_sha256": impronta_manifesto}

    pv.git_state = stato_browser
    from src import descriptive as ds
    from strumenti import crash_test as ct

    def mai_nel_browser(repo_root=None, tag=ds.PREREG_TAG):
        raise ds.PreregError("STOP (browser): i dati di Kryeziu et al. 2026 non si analizzano in questa pagina.")

    ds.check_prereg_signed = mai_nel_browser
    for modulo in list(sys.modules.values()):
        if getattr(modulo, "git_state", None) is not None and getattr(modulo, "__name__", "").startswith(("src.", "strumenti.")):
            modulo.git_state = stato_browser
    ct.git_state = stato_browser


def _nome_sicuro(nome: str) -> str:
    nome = os.path.basename(nome.replace("\\", "/")).strip() or "dati.csv"
    return nome if not nome.startswith(".") else "_" + nome


def esegui(nome: str) -> str:
    """Crash test sul file LAVORO/nome. Restituisce un JSON con l'esito; Rapporto e zip restano nel file system."""
    from strumenti import crash_test as ct

    os.chdir(LAVORO)
    esito = {"nome": nome, "codice_uscita": None, "rifiutato": None, "errore": "", "stampa": "", "secondi": 0.0}
    motivo = ct.motivo_kryeziu(LAVORO / nome, REPO)
    if motivo is not None:
        esito["rifiutato"] = motivo
        return json.dumps(esito)
    stampa, errore = io.StringIO(), io.StringIO()
    t0 = time.perf_counter()
    with contextlib.redirect_stdout(stampa), contextlib.redirect_stderr(errore):
        codice = ct.main(["--dati", nome, "--uscita", USCITA], repo_root=REPO)
    esito.update(codice_uscita=codice, secondi=time.perf_counter() - t0, stampa=stampa.getvalue()[-2000:],
                 errore=errore.getvalue().strip()[-2000:])
    if codice == 0:
        cartella = LAVORO / USCITA
        file = sorted(p for p in cartella.iterdir() if p.is_file())
        esito["rapporto"] = next(p.name for p in file if p.name.endswith("_rapporto.html"))
        esito["file"] = [p.name for p in file]
        zip_nome = esito["rapporto"].replace("_rapporto.html", "_rapporto.zip")
        with zipfile.ZipFile(LAVORO / zip_nome, "w", zipfile.ZIP_DEFLATED) as z:
            for p in file:
                info = zipfile.ZipInfo(f"{USCITA}/{p.name}", DATA_ZIP)
                info.compress_type = zipfile.ZIP_DEFLATED
                z.writestr(info, p.read_bytes())
        esito["zip"] = zip_nome
    return json.dumps(esito)


def prepara_file(nome: str) -> str:
    """Pulisce la cartella di lavoro e restituisce il nome sicuro con cui il worker scrive il file scelto."""
    import shutil

    os.chdir("/")  # la cartella corrente non si puo' cancellare
    if LAVORO.exists():
        shutil.rmtree(LAVORO)
    LAVORO.mkdir(parents=True)
    return _nome_sicuro(nome)
