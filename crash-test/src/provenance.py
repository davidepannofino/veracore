"""Salvataggio di un risultato in results/ con il suo file .meta.json.

Il .meta.json registra: commit git, data/ora (UTC), seed, SHA256 dei file di input,
comando lanciato, flag synthetic. Ogni numero in testi o interfaccia deve venire
da un risultato salvato con questa funzione.
"""
from __future__ import annotations

import hashlib
import json
import shlex
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

REPO_ROOT = Path(__file__).resolve().parent.parent
SYNTHETIC_TAG = "SINTETICO"


def sha256_file(path: str | Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _git(*args: str) -> str | None:
    try:
        out = subprocess.run(
            ["git", *args], cwd=REPO_ROOT, capture_output=True, text=True, check=True
        )
        return out.stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return None


def nome_ingresso(path: str | Path) -> str:
    """Nome con cui un file in ingresso entra nel .meta.json: relativo alla radice del repository se sta dentro il
    repository (cosi' i .meta.json non contengono percorsi assoluti della macchina), altrimenti com'e' stato dato."""
    p = Path(path)
    try:
        return p.resolve().relative_to(REPO_ROOT).as_posix()
    except ValueError:
        return str(path)


def git_state() -> dict:
    """Commit corrente e se ci sono modifiche non committate."""
    commit = _git("rev-parse", "HEAD")
    status = _git("status", "--porcelain")
    return {"commit": commit or "unknown", "git_dirty": None if status is None else bool(status)}


def save_result(
    result,
    name: str,
    *,
    seed: int,
    synthetic: bool,
    input_files=(),
    command: str | None = None,
    results_dir: str | Path = REPO_ROOT / "results",
    git_info: dict | None = None,
) -> Path:
    """Salva `result` (DataFrame -> .csv, dict/list -> .json) e `<name>.meta.json`.

    I dati sintetici devono avere SINTETICO nel nome; quelli non sintetici no.
    `git_info` (come restituito da git_state()) permette di fotografare lo stato git prima di
    scrivere piu' risultati in results/ (che e' tracciata): altrimenti il primo file scritto
    renderebbe "sporco" il repository per i successivi. Se manca, si legge ora.
    Restituisce il percorso del file del risultato.
    """
    if "/" in name or "\\" in name:
        raise ValueError("name non deve contenere separatori di percorso")
    if synthetic and SYNTHETIC_TAG not in name:
        raise ValueError(f"synthetic=True: il nome '{name}' deve contenere {SYNTHETIC_TAG}")
    if not synthetic and SYNTHETIC_TAG in name:
        raise ValueError(f"synthetic=False ma il nome '{name}' contiene {SYNTHETIC_TAG}")

    out_dir = Path(results_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    if isinstance(result, pd.DataFrame):
        result_path = out_dir / f"{name}.csv"
        result.to_csv(result_path, index=False)
    elif isinstance(result, (dict, list)):
        result_path = out_dir / f"{name}.json"
        result_path.write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
    else:
        raise TypeError("result deve essere un DataFrame, un dict o una list")

    meta = {
        "result_file": result_path.name,
        **(git_info if git_info is not None else git_state()),
        "timestamp_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "seed": seed,
        "input_sha256": {nome_ingresso(p): sha256_file(p) for p in input_files},
        "command": command if command is not None else shlex.join(sys.argv),
        "synthetic": bool(synthetic),
    }
    meta_path = out_dir / f"{name}.meta.json"
    meta_path.write_text(json.dumps(meta, indent=2, ensure_ascii=False), encoding="utf-8")
    return result_path
