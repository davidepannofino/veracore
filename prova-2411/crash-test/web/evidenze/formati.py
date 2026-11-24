"""Formati dei valori mostrati (decisione del revisore 18/11/2026).

- percentuale: senza decimali ("33%"), con arrotondamento half-up; va sempre accompagnata da "n su N" nel testo;
- decimale: due cifre, virgola italiana;
- intero: cifre intere; testo: cosi' com'e'.
Se il valore non e' numerico (per esempio "mai_raggiunta") si restituisce com'e'.
"""
from __future__ import annotations

from decimal import ROUND_HALF_UP, Decimal, InvalidOperation


def come_numero(valore) -> Decimal | None:
    """Decimal se `valore` e' un numero finito, altrimenti None."""
    if valore is None or isinstance(valore, bool):
        return None
    try:
        d = Decimal(str(valore).strip())
    except InvalidOperation:
        return None
    return d if d.is_finite() else None


def uguali(a, b) -> bool:
    """Confronto normalizzato: numerico se entrambi sono numeri, altrimenti di testo."""
    da, db = come_numero(a), come_numero(b)
    if da is not None and db is not None:
        return da == db
    return (None if a is None else str(a).strip()) == (None if b is None else str(b).strip())


def formatta(valore, formato: str) -> str | None:
    if valore is None:
        return None
    n = come_numero(valore)
    if formato == "testo" or n is None:
        return str(valore)
    if formato == "intero":
        return str(int(n.to_integral_value(rounding=ROUND_HALF_UP)))
    if formato == "percentuale":
        return f"{int((n * 100).to_integral_value(rounding=ROUND_HALF_UP))}%"
    if formato == "decimale":
        return str(n.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)).replace(".", ",")
    if formato == "decimale3":           # per una p di permutazione: tre decimali, mai arrotondata a zero
        return str(n.quantize(Decimal("0.001"), rounding=ROUND_HALF_UP)).replace(".", ",")
    raise ValueError(f"formato sconosciuto: {formato}")
