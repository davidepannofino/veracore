"""Lettura dei dati (xlsx/csv) secondo lo schema in config/schema.yaml.

Se il file non rispetta lo schema (colonna mancante, valori vuoti nel paziente)
si ferma con SchemaError e un messaggio che dice cosa manca.
Include lo split per paziente: mai lo stesso paziente in training e test.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd
import yaml

REQUIRED_KEYS = ("patient", "lesion", "drug", "dss")
DEFAULT_SCHEMA = Path(__file__).resolve().parent.parent / "config" / "schema.yaml"


class SchemaError(ValueError):
    """Dati o schema non coerenti."""


def load_schema(schema_path: str | Path = DEFAULT_SCHEMA) -> dict[str, str]:
    """Legge lo schema e restituisce {nome logico: nome colonna nel file}."""
    path = Path(schema_path)
    if not path.is_file():
        raise SchemaError(f"Schema non trovato: {path}")
    content = yaml.safe_load(path.read_text(encoding="utf-8"))
    columns = content.get("columns") if isinstance(content, dict) else None
    if not isinstance(columns, dict):
        raise SchemaError(f"Schema {path}: manca la sezione 'columns'")
    missing = [k for k in REQUIRED_KEYS if not columns.get(k)]
    if missing:
        raise SchemaError(f"Schema {path}: chiavi mancanti o vuote in 'columns': {missing}")
    return {k: str(columns[k]) for k in REQUIRED_KEYS}


def read_table(data_path: str | Path) -> pd.DataFrame:
    """Legge un file .xlsx o .csv."""
    path = Path(data_path)
    if not path.is_file():
        raise SchemaError(f"File dati non trovato: {path}")
    suffix = path.suffix.lower()
    if suffix == ".csv":
        return pd.read_csv(path)
    if suffix in (".xlsx", ".xlsm"):
        return pd.read_excel(path)
    raise SchemaError(f"Formato non supportato '{suffix}' (ammessi: .csv, .xlsx)")


def ingest(data_path: str | Path, schema_path: str | Path = DEFAULT_SCHEMA) -> pd.DataFrame:
    """Legge i dati e restituisce solo le colonne dello schema, con nomi logici."""
    schema = load_schema(schema_path)
    df = read_table(data_path)
    missing = {k: col for k, col in schema.items() if col not in df.columns}
    if missing:
        raise SchemaError(
            f"{data_path}: colonne mancanti rispetto allo schema {schema_path}: "
            f"{sorted(missing.values())}. Colonne presenti: {list(df.columns)}"
        )
    out = df[[schema[k] for k in REQUIRED_KEYS]].copy()
    out.columns = list(REQUIRED_KEYS)
    if out["patient"].isna().any():
        raise SchemaError(f"{data_path}: valori vuoti nella colonna paziente '{schema['patient']}'")
    return out.reset_index(drop=True)


def assert_no_patient_overlap(train: pd.DataFrame, test: pd.DataFrame, patient_col: str = "patient") -> None:
    """Errore se un paziente compare sia in training sia in test."""
    shared = set(train[patient_col]) & set(test[patient_col])
    if shared:
        raise ValueError(f"Pazienti presenti sia in training sia in test: {sorted(shared, key=str)}")


def split_by_patient(
    df: pd.DataFrame, test_fraction: float = 0.3, seed: int = 0, patient_col: str = "patient"
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Split in training/test per paziente (tutte le righe di un paziente nello stesso gruppo)."""
    if not 0 < test_fraction < 1:
        raise ValueError("test_fraction deve stare tra 0 e 1 (esclusi)")
    patients = np.array(sorted(df[patient_col].unique(), key=str), dtype=object)
    if len(patients) < 2:
        raise ValueError("Servono almeno 2 pazienti per fare lo split")
    rng = np.random.default_rng(seed)
    shuffled = rng.permutation(patients)
    n_test = min(max(1, round(test_fraction * len(patients))), len(patients) - 1)
    test_patients = set(shuffled[:n_test])
    is_test = df[patient_col].isin(test_patients)
    train, test = df[~is_test], df[is_test]
    assert_no_patient_overlap(train, test, patient_col)
    return train, test


# --------------------------------------------------------------------------- tabella lunga per l'analisi primaria
REQUIRED_KEYS_SAMPLES = ("patient", "sample_id", "drug", "dss")


def load_schema_samples(schema_path: str | Path = DEFAULT_SCHEMA) -> dict[str, str | None]:
    """Schema per l'analisi primaria: patient, sample_id, drug, dss obbligatori; lesion OPZIONALE.

    Se `lesion` manca o e' vuoto nello schema il risultato ha lesion=None (modalita' lesione NON VERIFICATA).
    """
    path = Path(schema_path)
    if not path.is_file():
        raise SchemaError(f"Schema non trovato: {path}")
    content = yaml.safe_load(path.read_text(encoding="utf-8"))
    columns = content.get("columns") if isinstance(content, dict) else None
    if not isinstance(columns, dict):
        raise SchemaError(f"Schema {path}: manca la sezione 'columns'")
    missing = [k for k in REQUIRED_KEYS_SAMPLES if not columns.get(k)]
    if missing:
        raise SchemaError(f"Schema {path}: chiavi mancanti o vuote in 'columns': {missing}")
    out: dict[str, str | None] = {k: str(columns[k]) for k in REQUIRED_KEYS_SAMPLES}
    out["lesion"] = str(columns["lesion"]) if columns.get("lesion") else None
    return out


def _read_text_table(path: str | Path) -> pd.DataFrame:
    """Legge .csv o .xlsx con tutte le celle come TESTO (gli ID non vanno interpretati come numeri)."""
    p = Path(path)
    if not p.is_file():
        raise SchemaError(f"File dati non trovato: {p}")
    suffix = p.suffix.lower()
    if suffix == ".csv":
        return pd.read_csv(p, dtype=str, keep_default_na=False)
    if suffix in (".xlsx", ".xlsm"):
        return pd.read_excel(p, dtype=str, keep_default_na=False)
    raise SchemaError(f"Formato non supportato '{suffix}' (ammessi: .csv, .xlsx)")


def _clean_text(values) -> list:
    """Spazi ai bordi tolti (A2); testo vuoto o mancante -> None. Maiuscole e minuscole restano distinte."""
    out: list = []
    for v in values:
        if v is None or (isinstance(v, float) and v != v):
            out.append(None)
            continue
        t = str(v).strip()
        out.append(t if t else None)
    return out


def ingest_samples(data_path: str | Path, schema_path: str | Path = DEFAULT_SCHEMA) -> pd.DataFrame:
    """Tabella lunga con nomi logici: patient, [lesion], sample_id, drug, dss (float, NaN se vuoto).

    Gli ID sono testo esatto (spazi ai bordi tolti). La colonna `lesion` compare solo se lo schema la
    indica E il file la contiene; altrimenti manca (modalita' lesione NON VERIFICATA). Le righe restano
    nell'ordine del file: l'ordinamento canonico lo fa src/endpoint.py.
    """
    schema = load_schema_samples(schema_path)
    raw = _read_text_table(data_path)
    needed = {k: v for k, v in schema.items() if k != "lesion"}
    missing = {k: col for k, col in needed.items() if col not in raw.columns}
    if missing:
        raise SchemaError(
            f"{data_path}: colonne mancanti rispetto allo schema {schema_path}: "
            f"{sorted(missing.values())}. Colonne presenti: {list(raw.columns)}"
        )
    out = pd.DataFrame({"patient": _clean_text(raw[schema["patient"]])}, dtype=object)
    lesion_col = schema["lesion"]
    if lesion_col is not None and lesion_col in raw.columns:
        out["lesion"] = pd.Series(_clean_text(raw[lesion_col]), dtype=object)
    out["sample_id"] = pd.Series(_clean_text(raw[schema["sample_id"]]), dtype=object)
    out["drug"] = pd.Series(_clean_text(raw[schema["drug"]]), dtype=object)
    dss: list[float] = []
    for i, t in enumerate(_clean_text(raw[schema["dss"]])):
        if t is None:
            dss.append(float("nan"))
            continue
        try:
            value = float(t)
        except ValueError as exc:
            raise SchemaError(
                f"{data_path}: valore DSS non numerico alla riga {i + 2} del file (colonna '{schema['dss']}')"
            ) from exc
        if value != value or value in (float("inf"), float("-inf")):
            raise SchemaError(
                f"{data_path}: valore DSS non finito ('{t}') alla riga {i + 2} del file (colonna '{schema['dss']}'): "
                "una misura mancante va lasciata vuota"
            )
        dss.append(value)
    out["dss"] = dss
    return out


ORIGIN_COLUMN = "origine"  # marcatore dei soli dati sintetici: in ogni riga vale SYNTHETIC_MARKER
SYNTHETIC_MARKER = "SINTETICO"


def read_origin_column(data_path: str | Path) -> list[str | None] | None:
    """Valori della colonna `origine` del file GREZZO (prima dello schema), oppure None se la colonna non c'e'.

    Legge solo quella colonna (testo, spazi ai bordi tolti, vuoto -> None): nessun altro valore del file viene
    toccato, cosi' il controllo sull'origine si puo' fare prima di qualsiasi uso dei dati.
    """
    p = Path(data_path)
    if not p.is_file():
        raise SchemaError(f"File dati non trovato: {p}")
    keep = lambda c: str(c).strip() == ORIGIN_COLUMN  # noqa: E731
    suffix = p.suffix.lower()
    if suffix == ".csv":
        raw = pd.read_csv(p, usecols=keep, dtype=str, keep_default_na=False)
    elif suffix in (".xlsx", ".xlsm"):
        raw = pd.read_excel(p, usecols=keep, dtype=str, keep_default_na=False)
    else:
        raise SchemaError(f"Formato non supportato '{suffix}' (ammessi: .csv, .xlsx)")
    if raw.shape[1] == 0:
        return None
    return _clean_text(raw.iloc[:, 0])
