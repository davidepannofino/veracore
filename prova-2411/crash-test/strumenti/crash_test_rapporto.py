"""Il Rapporto di rappresentativita' del crash test (strumenti/crash_test.py) come pagina di risultati da rivista,
stampabile in A4.

Due lingue (--lingua it|en del crash test, predefinito it): stessi numeri e stessa impaginazione; i testi stanno in
strumenti/crash_test_rapporto_testi.json, senza numeri (i numeri entrano dai segnaposto). In inglese i decimali hanno
il punto e i dati sintetici l'etichetta SYNTHETIC.

Regola: ogni numero della pagina e' letto dai CSV del crash test, e ogni CSV deve avere il suo .meta.json accanto;
nessun numero e' scritto a mano. Formati come nel sito (web/evidenze/formati.formatta): percentuali intere con
arrotondamento half-up, decimali con la virgola. Caratteri del progetto incorporati (web/fornitori/font, SIL OFL 1.1),
nessuna risorsa esterna. Uscita deterministica: stessi CSV, stessi byte.
"""
from __future__ import annotations

import base64
import html
import json
import math
import re
from pathlib import Path

import pandas as pd

from src import endpoint as ep
from src import esegui_analisi_reale as ear
from src import previsione_esplorativa as pe
from src.provenance import REPO_ROOT, SYNTHETIC_TAG
from web.evidenze.formati import formatta

# --------------------------------------------------------------------------- stile
# colori e caratteri dalla fonte unica del design (config/design.yaml): la sezione «stampa» (pagina bianca) e i tre caratteri
DESIGN = REPO_ROOT / "config" / "design.yaml"


def _design() -> dict:
    import yaml
    return yaml.safe_load(DESIGN.read_text(encoding="utf-8"))


_DESIGN = _design()
COLORI = {k: str(v).upper() for k, v in _DESIGN["stampa"].items()}
FAMIGLIE = {k: f["famiglia"] for k, f in _DESIGN["font"].items()}          # titolo, testo, mono


def _famiglia(nome: str) -> str:
    """Nome del carattere per il CSS: tra apici solo se contiene spazi (come sempre nel Rapporto)."""
    return f"'{nome}'" if " " in nome else nome


TITOLO, TESTO, MONO = (_famiglia(FAMIGLIE[k]) for k in ("titolo", "testo", "mono"))
# coppie (testo, fondo) usate per il testo: tutte devono superare il contrasto 4,5:1 (WCAG AA)
COPPIE_TESTO = [("testo", "fondo"), ("secondario", "fondo"), ("accento", "fondo"), ("accento", "accento_chiaro"),
                ("testo", "accento_chiaro"), ("ambra", "ambra_fondo"), ("ambra", "fondo"), ("grigio", "fondo"),
                ("grigio", "grigio_fondo"), ("testo", "ambra_fondo")]
FONT = {  # (famiglia, peso): file, per i pesi che il Rapporto usa
    (_DESIGN["font"][k]["famiglia"], peso): f'{_DESIGN["font"][k]["file"]}-latin-{peso}-normal.woff2'
    for k, peso in (("titolo", 500), ("titolo", 700), ("testo", 400), ("testo", 600), ("mono", 400))
}
CARTELLA_FONT = REPO_ROOT / "web" / "fornitori" / "font"
CSV = ("dati", "riepilogo", "inclusione", "pazienti", "farmaci", "politiche")
LINGUE = ("it", "en")
TESTI = json.loads((Path(__file__).resolve().parent / "crash_test_rapporto_testi.json").read_text(encoding="utf-8"))["testi"]
# numeri e riferimenti fissi del metodo: nel codice, non nei testi
LIVELLO = 0.95                 # intervalli al 95% (Wilson e bootstrap per paziente)
FDR = 0.05                     # Benjamini-Hochberg
PERCENTILI = (2.5, 97.5)       # banda della scelta casuale
RIF = {"d_indice": "D4", "d_ordine": "D2", "d_rumore": "D11", "d_libreria": "D15", "versione": "v0.3.3",
       "sez_a": "3–5", "sez_b": "9", "es_a": "t10", "es_b": "t2", "uno": "1", "zero": "0", "kp": "k+1",
       "licenza_font": "SIL Open Font License 1.1"}
# valori dei CSV traducibili, per nome simbolico (TESTI[lingua]["valori"])
SIMBOLI = {ep.R_CONFLICT: "R_CONFLICT", ep.R_LESION_EMPTY: "R_LESION_EMPTY", ep.R_ONE_SAMPLE: "R_ONE_SAMPLE",
           ep.R_ONE_LESION: "R_ONE_LESION", ep.R_PANEL_EMPTY: "R_PANEL_EMPTY", ep.MODE_VERIFIED: "MODE_VERIFIED",
           ep.MODE_NOT_VERIFIED: "MODE_NOT_VERIFIED", ep.NOISE_VERIFIED: "NOISE_VERIFIED",
           ep.NOISE_NOT_VERIFIED: "NOISE_NOT_VERIFIED",
           "colonna libreria assente o vuota": "MOTIVO_LIBRERIA_NON_ESEGUITA",
           "piu' di due librerie: la sensibilita' D15 e' definita per due librerie": "MOTIVO_TROPPE_LIBRERIE"}
T: dict = TESTI["it"]          # lingua della pagina in costruzione (pagina() la imposta)


def _politiche() -> dict:
    p = T["politiche"]
    return {pe.P_NESSUNO: p["nessuno"], pe.P_TUTTI: p["tutti"], pe.P_CASUALE: p["casuale"], pe.P_MARGINE: p["margine"]}


def _legenda() -> dict:
    return dict(_politiche(), **{pe.P_MARGINE: T["legenda_margine"]})  # nel grafico: etichetta corta


def valore(v: str) -> str:
    """Un valore testuale del CSV (motivo, modalita', rumore) nella lingua della pagina."""
    return T["valori"].get(SIMBOLI.get(v, ""), v)


def nc() -> str:
    return T["nc"]


def n_casuale() -> str:
    """Migliaia con il punto in italiano, con la virgola in inglese."""
    t = f"{pe.N_CASUALE:,}"
    return t.replace(",", ".") if T["lang"] == "it" else t


def _locale(t: str) -> str:
    return t.replace(",", ".") if T["lang"] == "en" else t


def numero(x: float) -> str:
    """Un numero fisso del metodo (percentili) nel formato della lingua."""
    t = f"{x:g}"
    return t.replace(".", ",") if T["lang"] == "it" else t


def livello() -> str:
    return formatta(LIVELLO, "percentuale")


def perc() -> str:
    return f"{numero(PERCENTILI[0])}–{numero(PERCENTILI[1])}"


class RapportoError(RuntimeError):
    """Un CSV del crash test manca o non ha il suo .meta.json."""


# --------------------------------------------------------------------------- lettura dei CSV
def leggi(cartella: str | Path, nome: str) -> dict[str, pd.DataFrame]:
    """I CSV del crash test (testo esatto), solo se ognuno ha il suo .meta.json."""
    out = {}
    for chiave in CSV + ("libreria",):
        f = Path(cartella) / f"{nome}_{chiave}.csv"
        if chiave == "libreria" and not f.is_file():
            continue
        meta = f.with_name(f.stem + ".meta.json")
        if not f.is_file() or not meta.is_file():
            raise RapportoError(f"STOP: per il Rapporto servono {f.name} e {meta.name}")
        info = json.loads(meta.read_text(encoding="utf-8"))
        if info.get("result_file") != f.name or bool(info.get("synthetic")) != (SYNTHETIC_TAG in nome):
            raise RapportoError(f"STOP: {meta.name} non descrive {f.name} oppure non coincide sull'origine")
        out[chiave] = pd.read_csv(f, dtype=str, keep_default_na=False)
    return out


def _riga(df: pd.DataFrame, **filtri) -> pd.Series | None:
    m = pd.Series(True, index=df.index)
    for c, v in filtri.items():
        m &= df[c] == str(v)
    sel = df[m]
    return sel.iloc[0] if len(sel) else None


def quota(riep: pd.DataFrame, k: int, misura="quota_pazienti_con_evento", analisi=None) -> dict | None:
    """n, denominatore, valore, Wilson e bootstrap di una quota, come testo esatto del CSV."""
    analisi = analisi or ("primaria" if k == ep.K_PRIMARY else "secondaria")
    w = _riga(riep, analisi=analisi, k=k, misura=misura, metodo="Wilson 95%")
    b = riep[(riep["analisi"] == analisi) & (riep["k"] == str(k)) & (riep["misura"] == misura)
             & riep["metodo"].str.startswith("bootstrap")]
    if w is None or b.empty:
        return None
    b = b.iloc[0]
    return {"n": w["n"], "den": w["denominatore"], "valore": w["valore"], "w_lo": w["ic_lo"], "w_hi": w["ic_hi"],
            "b_lo": b["ic_lo"], "b_hi": b["ic_hi"], "metodo_b": b["metodo"]}


# --------------------------------------------------------------------------- formati
def pct(v: str) -> str:
    return _locale(formatta(v, "percentuale")) if _numero(v) else nc()


def dec(v: str) -> str:
    return _locale(formatta(v, "decimale")) if _numero(v) else nc()


def _numero(v) -> bool:
    try:
        return math.isfinite(float(v))
    except (TypeError, ValueError):
        return False


# le parole dei numeri piccoli, per lingua (vocabolario, non valori): niente dipendenze, il Rapporto gira anche in Pyodide
LETTERE = {"it": ("zero", "uno", "due", "tre", "quattro", "cinque", "sei", "sette", "otto", "nove", "dieci"),
           "en": ("zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten")}


def in_lettere(n: int) -> str:
    """Un numero in lettere nella lingua della pagina («tre», «three»): per i testi, che non hanno numeri scritti a mano.
    Oltre dieci resta in cifre."""
    n = int(n)
    parole = LETTERE[T["lang"]]
    return parole[n] if 0 <= n < len(parole) else str(n)


def k_(k) -> str:
    """"k = 1" che non si spezza mai su due righe."""
    return f'<span class="nw">k&#8239;=&#8239;{k}</span>'


def e(t) -> str:
    return html.escape(str(t))


# --------------------------------------------------------------------------- frasi
def frase_principale(q: dict | None) -> str:
    if q is None or not _numero(q["valore"]):
        return T["frase_nessuno"]
    return T["frase_principale"].format(n=q["n"], den=q["den"], pct=pct(q["valore"]), livello=livello(),
                                        wlo=pct(q["w_lo"]), whi=pct(q["w_hi"]), blo=pct(q["b_lo"]), bhi=pct(q["b_hi"]))


def frase_k(q: dict | None, k: int) -> str:
    if q is None or not _numero(q["valore"]):
        return T["frase_k_nc"].format(k=k_(k))
    return T["frase_k"].format(k=k_(k), kn=k, n=q["n"], den=q["den"], pct=pct(q["valore"]), wlo=pct(q["w_lo"]),
                               whi=pct(q["w_hi"]), blo=pct(q["b_lo"]), bhi=pct(q["b_hi"]))


# --------------------------------------------------------------------------- grafici SVG
def svg_farmaci(far: pd.DataFrame, rumore: str) -> str:
    """Barre orizzontali ordinate della quota di pazienti discordanti, con il segno dopo Benjamini-Hochberg."""
    if rumore != ep.NOISE_VERIFIED or far.empty or not far["quota_discordanti"].map(_numero).any():
        return f'<div class="nc">{T["far_nc"]}</div>'
    f = far[far["quota_discordanti"].map(_numero)].copy()
    f["_q"] = f["quota_discordanti"].astype(float)
    f = f.sort_values(["_q", "farmaco"], ascending=[False, True], kind="stable")
    riga, sx, larg, top = 19, 150, 380, 24
    h = top + riga * len(f) + 34
    parti = [f'<svg class="fig" viewBox="0 0 640 {h}" role="img" aria-label="{T["far_aria"]}">']
    for t in (0, 0.25, 0.5, 0.75, 1.0):
        x = sx + larg * t
        parti.append(f'<line x1="{x:.1f}" y1="{top - 6}" x2="{x:.1f}" y2="{h - 28}" stroke="{COLORI["griglia"]}"/>'
                     f'<text x="{x:.1f}" y="{h - 12}" class="ax" text-anchor="middle">{_locale(formatta(t, "percentuale"))}</text>')
    for i, (_, r) in enumerate(f.iterrows()):
        y = top + i * riga
        w = larg * r["_q"]
        sig = r["significativo_fdr"] == "True"
        parti.append(
            f'<text x="{sx - 8}" y="{y + 14}" class="lab" text-anchor="end">{e(r["farmaco"])}</text>'
            f'<rect data-farmaco="{e(r["farmaco"])}" data-quota="{r["quota_discordanti"]}" data-sig="{int(sig)}" '
            f'x="{sx}" y="{y + 3}" width="{w:.2f}" height="{riga - 8}" '
            f'fill="{COLORI["accento"] if sig else COLORI["linea"]}"/>'
            f'<text x="{sx + w + 6:.1f}" y="{y + 14}" class="val">{r["n_discordanti"]}/{r["n_pazienti"]} '
            f'({pct(r["quota_discordanti"])}){" *" if sig else ""}</text>')
    parti.append(f'<text x="{sx}" y="14" class="ax">{T["far_asse"]}</text>')
    parti.append("</svg>")
    return "".join(parti)


def svg_politiche(pol: pd.DataFrame, k: int) -> str:
    """Eventi intercettati per budget: nessuno, tutti, a caso (con banda 2,5-97,5) e regola del margine."""
    sub = pol[(pol["k"] == str(k)) & (pol["misura"] == "eventi_trovati")]
    if sub.empty:
        r = _riga(pol, k=k, misura="non_eseguita")
        nota = _nota_politiche(r["nota"]) if r is not None else T["pol_non_eseguita"]
        return f'<div class="nc">{T["pol_nc"].format(k=k_(k), nota=e(nota))}</div>'
    fr = sorted({float(x) for x in sub["budget_frazione"]})
    tot = int(sub["denominatore"].iloc[0])
    w, h, sx, dx, top, bot = 300, 210, 34, 72, 30, 34
    x = lambda f: sx + (w - sx - dx) * (f - 0) / (fr[-1] or 1)  # noqa: E731
    y = lambda v: h - bot - (h - top - bot) * v / max(tot, 1)  # noqa: E731
    p = [f'<svg class="fig pol" viewBox="0 0 {w} {h}" role="img" aria-label="{T["pol_aria"].format(k=k)}">',
         f'<text x="0" y="12" class="tit">{T["pol_titolo"].format(k=f"k{chr(160)}={chr(160)}{k}", tot=tot)}</text>',
         f'<text x="{w}" y="12" class="esp-svg" text-anchor="end">{T["esplorativa"]}</text>']
    for v in sorted({0, tot, *range(0, tot + 1, max(1, math.ceil(tot / 4)))}):
        p.append(f'<line x1="{sx}" y1="{y(v):.1f}" x2="{w - dx}" y2="{y(v):.1f}" stroke="{COLORI["griglia"]}"/>'
                 f'<text x="{sx - 5}" y="{y(v) + 3.5:.1f}" class="ax" text-anchor="end">{v}</text>')
    for f in [0.0, *fr]:
        p.append(f'<text x="{x(f):.1f}" y="{h - bot + 14}" class="ax" text-anchor="middle">{_locale(formatta(f, "percentuale"))}</text>')
    p.append(f'<text x="{(sx + w - dx) / 2:.1f}" y="{h - 6}" class="ax" text-anchor="middle">{T["pol_asse"]}</text>')
    cas = sub[sub["politica"] == pe.P_CASUALE].assign(_f=lambda d: d["budget_frazione"].astype(float)).sort_values("_f")
    banda = [(x(float(r["budget_frazione"])), y(float(r["ic_hi"]))) for _, r in cas.iterrows()] + \
            [(x(float(r["budget_frazione"])), y(float(r["ic_lo"]))) for _, r in cas.iloc[::-1].iterrows()]
    p.append(f'<polygon data-banda="casuale" points="{" ".join(f"{a:.1f},{b:.1f}" for a, b in banda)}" '
             f'fill="{COLORI["banda"]}"/>')
    stili = {pe.P_TUTTI: (COLORI["secondario"], "5 3", 1.5), pe.P_NESSUNO: (COLORI["secondario"], "1.5 3", 1.5),
             pe.P_CASUALE: (COLORI["grigio"], "", 1.5), pe.P_MARGINE: (COLORI["accento"], "", 2.5)}
    etichette, legenda = [], _legenda()
    for nome, (col, dash, sw) in stili.items():
        s = sub[sub["politica"] == nome].assign(_f=lambda d: d["budget_frazione"].astype(float)).sort_values("_f")
        if s.empty:   # politica non calcolabile (guardia sui predittori): nessuna linea, lo dice la tabella A3
            continue
        punti = [(x(float(a)), y(float(v))) for a, v in zip(s["budget_frazione"], s["n"])]
        p.append(f'<polyline data-politica="{nome}" data-valori="{";".join(s["n"])}" fill="none" stroke="{col}" '
                 f'stroke-width="{sw}" stroke-dasharray="{dash}" points="{" ".join(f"{a:.1f},{b:.1f}" for a, b in punti)}"/>')
        for a, b in punti:
            p.append(f'<circle cx="{a:.1f}" cy="{b:.1f}" r="{2.2 if nome == pe.P_MARGINE else 1.6}" fill="{col}"/>')
        etichette.append([punti[-1][1] + 3.5, legenda[nome], col])
    etichette.sort()
    for i in range(1, len(etichette)):
        etichette[i][0] = max(etichette[i][0], etichette[i - 1][0] + 11)
    for yy, testo, col in etichette:
        p.append(f'<text x="{w - dx + 6}" y="{yy:.1f}" class="leg" fill="{col}">{testo}</text>')
    p.append("</svg>")
    return "".join(p)


# --------------------------------------------------------------------------- tabelle dell'appendice
def _nota_politiche(nota: str) -> str:
    """La nota del CSV (in italiano) nella lingua della pagina."""
    m = re.fullmatch(r"meno di (\d+) pazienti valutabili a k = (\d+)", nota)
    return T["pol_pochi"].format(min=m.group(1), k=m.group(2)) if m else nota


def tabella(intest: list[str], righe: list[list[str]], classe="") -> str:
    th = "".join(f"<th>{h}</th>" for h in intest)
    tr = "".join("<tr>" + "".join(f"<td>{c}</td>" for c in r) + "</tr>" for r in righe)
    return f'<table class="{classe}"><thead><tr>{th}</tr></thead><tbody>{tr}</tbody></table>'


def _ic(lo, hi) -> str:
    return f"{pct(lo)}–{pct(hi)}" if _numero(lo) and _numero(hi) else nc()


def appendice(c: dict[str, pd.DataFrame], ks) -> str:
    riep = c["riepilogo"]
    righe = []
    for k in ks:
        for misura, testo, analisi in (("quota_pazienti_con_evento", T["a_cambio"], None),
                                       ("quota_senza_parita", T["a_senza_parita"], "sensibilita"),
                                       ("quota_con_pazienti_senza_farmaco_attivo", T["a_senza_attivo"], "sensibilita")):
            q = quota(riep, k, misura, analisi)
            if q:
                righe.append([k_(k), testo, f'{q["n"]}/{q["den"]}', pct(q["valore"]), _ic(q["w_lo"], q["w_hi"]),
                              _ic(q["b_lo"], q["b_hi"])])
    a1 = tabella([h.format(livello=livello()) for h in T["a1_intest"]], righe)
    far = c["farmaci"]
    a2 = tabella(T["a2_intest"],
                 [[e(r["farmaco"]), r["n_pazienti"], r["n_discordanti"], pct(r["quota_discordanti"]),
                   _p(r["p_value"]), _p(r["q_bh"]), {"True": T["si"], "False": T["no"]}.get(r["significativo_fdr"], nc())]
                  for _, r in far.iterrows()], "num")
    pol = c["politiche"]
    righe = []
    for k in ks:
        s = pol[(pol["k"] == str(k)) & (pol["misura"] == "eventi_trovati")]
        for frac in sorted({float(v) for v in s["budget_frazione"]}):
            g = s[s["budget_frazione"].astype(float) == frac].set_index("politica")
            cas = g.loc[pe.P_CASUALE]
            marg = pe.P_MARGINE in g.index   # assente se non calcolabile (guardia sui predittori)
            righe.append([k_(k), _locale(formatta(frac, "percentuale")),
                          g.loc[pe.P_MARGINE, "budget"] if marg else g.loc[pe.P_TUTTI, "budget"],
                          g.loc[pe.P_NESSUNO, "n"], g.loc[pe.P_TUTTI, "n"],
                          f'{dec(cas["n"])} ({dec(cas["ic_lo"])}–{dec(cas["ic_hi"])})',
                          g.loc[pe.P_MARGINE, "n"] if marg else nc()])
    a3 = tabella([h.format(livello=livello()) for h in T["a3_intest"]], righe, "num") \
        if righe else f"<p>{T['a3_vuota']}</p>"
    inc, paz = c["inclusione"], c["pazienti"].set_index("patient")
    righe = []
    for _, r in inc.iterrows():
        ev = []
        for k in ks:
            if r["incluso"] == "True" and r["patient"] in paz.index:
                st, v = paz.loc[r["patient"], f"stato_k{k}"], paz.loc[r["patient"], f"evento_k{k}"]
                ev.append((T["si"] if v == "1" else T["no"]) if st == ep.ST_OK else T["nv"])
            else:
                ev.append("–")
        rho = paz.loc[r["patient"], "rho_spearman"] if r["patient"] in paz.index else ""
        righe.append([e(r["patient"]), T["si"] if r["incluso"] == "True" else e(valore(r["motivo"])), e(r["indice"]) or "–",
                      e(r["secondo"]) or "–", r["n_pannello"], *ev, dec(rho) if _numero(rho) else "–"])
    i4 = T["a4_intest"]
    a4 = tabella([*i4[:5], *[i4[5].format(k=k_(k)) for k in ks], i4[6]], righe, "num")
    return (f'<section class="appendice"><h2>{T["app_titolo"]}</h2>'
            f'<h3>A1. {T["app_quote"]}</h3>{a1}<h3>A2. {T["app_farmaci"]}</h3>{a2}'
            f'<h3>A3. {T["app_politiche"]} <span class="esp">{T["esplorativa"]}</span></h3>{a3}'
            f'<p class="nota">{T["app_nota_pol"].format(n_casuale=n_casuale(), perc=perc())}</p>' +
            f'<h3>A4. {T["app_pazienti"]}</h3>{a4}<p class="nota">{T["app_nota_paz"]}</p></section>')


def _p(v: str) -> str:
    if not _numero(v):
        return nc()
    return f"&lt; {dec('0.01')}" if float(v) < 0.005 else dec(v)


# --------------------------------------------------------------------------- pagina
def _font_css() -> str:
    out = []
    for (famiglia, peso), nome in FONT.items():
        dati = base64.b64encode((CARTELLA_FONT / nome).read_bytes()).decode()
        out.append(f"@font-face{{font-family:'{famiglia}';font-weight:{peso};font-style:normal;"
                   f"src:url(data:font/woff2;base64,{dati}) format('woff2')}}")
    return "".join(out)


def _css() -> str:
    c = COLORI
    return _font_css() + f"""
:root{{color-scheme:light}}
@page{{size:A4;margin:14mm 14mm 16mm}}
*{{box-sizing:border-box}}
body{{margin:0;background:{c['fondo']};color:{c['testo']};font:400 9.8pt/1.45 {TESTO},sans-serif}}
main{{max-width:182mm;margin:0 auto;padding:10mm 0}}
@media print{{main{{max-width:none;padding:0}}}}
h1,h2,h3{{font-family:{TITOLO},sans-serif;font-weight:700;line-height:1.2;break-after:avoid}}
h1{{font-size:21pt;margin:2mm 0 1mm}}
h2{{font-size:12pt;font-weight:700;margin:5mm 0 1.5mm;padding-top:1.5mm;border-top:1px solid {c['linea']}}}
h3{{font-size:10.5pt;font-weight:500;margin:5mm 0 1.5mm}}
p{{margin:0 0 2.2mm}}
.nw{{white-space:nowrap}}
.mono,code{{font-family:{MONO},monospace;font-size:9pt}}
.sint{{font-family:{TITOLO},sans-serif;font-weight:700;letter-spacing:.08em;color:{c['testo']};
background:{c['ambra_fondo']};border:1px solid {c['ambra']};padding:1.5mm 3mm;margin:0 0 3mm;font-size:9.5pt}}
.occhiello{{font-family:{TITOLO},sans-serif;font-weight:500;color:{c['accento']};font-size:9.5pt;
letter-spacing:.06em;text-transform:uppercase;margin:0}}
.dati{{color:{c['secondario']};font-size:9pt;margin-bottom:4mm}}
.chip{{display:inline-block;font-family:{MONO},monospace;font-size:8.5pt;padding:0 1.6mm;border-radius:1mm;
white-space:nowrap}}
.chip.nv{{color:{c['grigio']};background:{c['grigio_fondo']}}}
.chip.ok{{color:{c['accento']};background:{c['accento_chiaro']}}}
.esp{{display:inline-block;font-family:{TITOLO},sans-serif;font-weight:700;font-size:8pt;letter-spacing:.08em;
color:{c['ambra']};background:{c['ambra_fondo']};padding:0 1.6mm;border-radius:1mm;vertical-align:middle}}
#risultato{{border-left:4px solid {c['accento']};background:{c['accento_chiaro']};padding:4mm 5mm;margin:2mm 0 4mm;
break-inside:avoid}}
#risultato .principale{{font-size:12.5pt;line-height:1.45;margin:0 0 2mm}}
#risultato .grande{{font-family:{TITOLO},sans-serif;color:{c['accento']};font-size:15pt}}
#risultato .k3{{font-size:10pt;margin:0}}
.nc{{color:{c['grigio']};background:{c['grigio_fondo']};padding:3mm 4mm;font-size:9.5pt;break-inside:avoid}}
figure{{margin:2mm 0 3mm;break-inside:avoid}}
figcaption{{font-size:9pt;color:{c['secondario']};margin-top:1.5mm}}
figcaption b{{color:{c['testo']}}}
.fig{{width:100%;height:auto;display:block}}
.coppia{{display:flex;gap:6mm}} .coppia>*{{flex:1 1 0;min-width:0}}
svg text{{font-family:{TESTO},sans-serif;fill:{c['testo']}}}
svg .ax{{font-size:9px;fill:{c['secondario']}}} svg .lab{{font-size:10px}} svg .val{{font-size:9.5px;font-family:{MONO},monospace}}
svg .tit{{font-family:{TITOLO},sans-serif;font-weight:500;font-size:10.5px}}
svg .leg{{font-size:9.5px}} svg .esp-svg{{font-family:{TITOLO},sans-serif;font-weight:700;font-size:9px;
letter-spacing:.08em;fill:{c['ambra']}}}
ul{{margin:0 0 2mm;padding-left:5mm}} li{{margin:0 0 1mm}}
table{{border-collapse:collapse;width:100%;font-size:8.5pt;margin:1mm 0 2mm}}
th{{text-align:left;font-weight:600;border-bottom:1.5px solid {c['testo']};padding:1mm 1.5mm}}
td{{border-bottom:1px solid {c['griglia']};padding:.8mm 1.5mm;vertical-align:top}}
tr{{break-inside:avoid}} thead{{display:table-header-group}}
table.num td{{font-variant-numeric:tabular-nums}}
.nota{{font-size:8.5pt;color:{c['secondario']}}}
.appendice{{break-before:page}}
.piede{{margin-top:6mm;font-size:8.5pt;color:{c['secondario']};border-top:1px solid {c['linea']};padding-top:2mm}}
"""


def pagina(cartella: str | Path, nome: str, lingua: str = "it") -> str:
    """La pagina HTML del Rapporto, dai soli CSV (con .meta.json) della cartella, nella lingua chiesta (it | en)."""
    global T
    if lingua not in LINGUE:
        raise RapportoError(f"STOP: lingua sconosciuta {lingua!r} (ammesse: {', '.join(LINGUE)})")
    precedente, T = T, TESTI[lingua]
    try:
        return _pagina(cartella, nome)
    finally:
        T = precedente


def _pagina(cartella: str | Path, nome: str) -> str:
    c = leggi(cartella, nome)
    d = dict(zip(c["dati"]["chiave"], c["dati"]["valore"]))
    riep = c["riepilogo"]
    ks = [int(k) for k in d["k"].split(";")]
    sint = d["dataset"] == SYNTHETIC_TAG
    rumore = riep["rumore"].iloc[0]
    modo = riep["modalita_lesione"].iloc[0]
    q1 = quota(riep, ep.K_PRIMARY) if ep.K_PRIMARY in ks else None
    altri = [k for k in ks if k != ep.K_PRIMARY]
    chip_r = (f'<span class="chip {"ok" if rumore == ep.NOISE_VERIFIED else "nv"}">'
              f'{T["rumore_chip"].format(r=e(valore(rumore)))}</span>')
    # --- riquadro
    riquadro = (f'<section id="risultato" aria-label="{T["aria_risultato"]}"><p class="principale" data-k="1">'
                f'{frase_principale(q1)}</p>'
                + "".join(f'<p class="k3" data-k="{k}">{frase_k(quota(riep, k), k)}</p>' for k in altri) + "</section>")
    if ep.K_PRIMARY not in ks:
        riquadro = ('<section id="risultato">' + "".join(f'<p class="k3" data-k="{k}">{frase_k(quota(riep, k), k)}</p>'
                                                         for k in ks) + "</section>")
    # --- pazienti
    inc = c["inclusione"]
    n_file, n_inc = len(inc), int((inc["incluso"] == "True").sum())
    esclusi = [(m, int((inc["motivo"] == m).sum())) for m in ep.EXCLUSION_REASONS]
    esclusi = [T["escluso_per"].format(n=n, m=e(valore(m))) for m, n in esclusi if n]
    val = []
    for k in ks:
        v = _riga(riep, analisi="conteggi", k=k, misura="valutabili")
        pan = _riga(riep, analisi="conteggi", k=k, misura="non_valutabili_pannello_minore_k_piu_1")
        att = _riga(riep, analisi="conteggi", k=k, misura="non_valutabili_nessun_farmaco_attivo")
        val.append(T["valutabili"].format(k=k_(k), v=v["n"], den=v["denominatore"], pan=pan["n"], kp=k + 1, att=att["n"]))
    interv = ""
    if d["colonna_intervento"] == "si":
        interv = T["interventi"].format(versione=RIF["versione"], n=d["campioni_altri_interventi"])
    lista = "; ".join(val)
    paz_html = (f"<p>{T['pazienti'].format(nf=n_file, ni=n_inc)}"
                f"{T['esclusi'].format(lista=', '.join(esclusi)) if esclusi else T['nessun_escluso']}{interv}</p>"
                f"<p>{lista[0].upper() + lista[1:]}.</p>")
    # --- rumore
    sig = _riga(riep, analisi="rumore", misura="sigma_rep")
    les = _riga(riep, analisi="rumore", misura="lesioni_usate")
    if rumore == ep.NOISE_VERIFIED:
        rum_html = T["rumore_v"].format(d=RIF["d_rumore"], s=dec(sig["valore"]), l=les["n"],
                                        delta=dec(_riga(riep, analisi="rumore", misura="delta")["valore"]))
    else:
        rum_html = T["rumore_nv"].format(min=ep.MIN_LESIONS_SIGMA, d=RIF["d_ordine"])
    # --- spearman
    sp = _riga(riep, analisi="secondaria_spearman")
    sp_html = (T["spearman"].format(v=dec(sp["valore"]), livello=livello(), lo=dec(sp["ic_lo"]), hi=dec(sp["ic_hi"]),
                                    n=sp["n"], den=sp["denominatore"], uno=RIF["uno"], zero=RIF["zero"])
               if _numero(sp["valore"]) else T["spearman_nc"])
    # --- libreria
    if "libreria" in c:
        lq = quota(c["libreria"], ep.K_PRIMARY) if ep.K_PRIMARY in ks else None
        lib_html = (T["libreria"].format(d=RIF["d_libreria"], nota=e(d["nota_libreria"]),
                                         n=d.get("esclusi_per_libreria", "0"))
                    + (T["libreria_k"].format(k=k_(1), n=lq["n"], den=lq["den"], pct=pct(lq["valore"]),
                                              w=_ic(lq["w_lo"], lq["w_hi"]), b=_ic(lq["b_lo"], lq["b_hi"]))
                       if lq and _numero(lq["valore"]) else ""))
    else:
        lib_html = T["libreria_nc"].format(nota=e(valore(d["nota_libreria"])))
    # --- figure
    fig_far = svg_farmaci(c["farmaci"], rumore)
    n_sig = int((c["farmaci"]["significativo_fdr"] == "True").sum()) if len(c["farmaci"]) else 0
    cap_far = (f"<b>{T['figura']} 1.</b> " + (T["cap_far"].format(fdr=_locale(formatta(FDR, "percentuale")), ns=n_sig,
                                                                   nt=len(c["farmaci"]))
                                              if rumore == ep.NOISE_VERIFIED else T["cap_far_nv"]))
    fig_pol = "".join(svg_politiche(c["politiche"], k) for k in ks)
    cap_pol = (f"<b>{T['figura']} 2.</b> <span class='esp'>{T['esplorativa']}</span> "
               + T["cap_pol"].format(perc=perc(), n_casuale=n_casuale(), kp=RIF["kp"]))
    verso = T["verso_alto"] if d["verso"].startswith("piu_alto") else T["verso_basso"]
    limiti = [T["limite_clinico"], T["limite_coppie"], T["limite_curva"]]
    if rumore != ep.NOISE_VERIFIED:
        limiti.insert(1, T["limite_rumore"])
    if modo == ep.MODE_NOT_VERIFIED:
        limiti.insert(1, T["limite_lesione"])
    if not d["verso"].startswith("piu_alto"):
        limiti.append(T["limite_verso"])
    banda = (f'<div class="sint">{T["banda_sintetica"].format(tag=SYNTHETIC_TAG)}</div>' if sint else "")
    titolo_t = T["titolo"] + (T["titolo_sintetico"].format(tag=SYNTHETIC_TAG) if sint else "")
    # k primario e secondario letti dal file (colonna k dei dati), il secondario anche in lettere nella lingua della pagina
    k_sec = next((k for k in ks if k != ep.K_PRIMARY), ep.K_SECONDARY)
    regole = T["regole"].format(es_a=RIF["es_a"], es_b=RIF["es_b"], d_indice=RIF["d_indice"],
                                k_primario=k_(ep.K_PRIMARY if ep.K_PRIMARY in ks else ks[0]), k_secondario=k_(k_sec),
                                k_secondario_lettere=in_lettere(k_sec), rumore=rum_html, sez_a=RIF["sez_a"], sez_b=RIF["sez_b"])
    corpo = f"""<main>
{banda}<p class="occhiello">{T['occhiello']}</p>
<h1>{titolo_t}</h1>
<p class="dati">{T['dati'].format(file=e(d['file']), righe=d['righe'], verso=verso, modo=e(valore(modo)), chip=chip_r)}</p>
{riquadro}
<h2>{T['h_dati']}</h2>
<p>{regole}</p>
<h2>{T['h_pazienti']}</h2>
{paz_html}
<h2>{T['h_farmaci']}</h2>
<figure>{fig_far}<figcaption>{cap_far}</figcaption></figure>
<h2>{T['h_spearman']}</h2>
<p>{sp_html}</p>
<h2>{T['h_libreria']}</h2>
<p>{lib_html}</p>
<h2>{T['h_politiche']} <span class="esp">{T['esplorativa']}</span></h2>
<figure><div class="coppia">{fig_pol}</div><figcaption>{cap_pol}</figcaption></figure>
<h2>{T['h_limiti']}</h2>
<ul>{''.join(f'<li>{x}</li>' for x in limiti)}</ul>
{appendice(c, ks)}
<p class="piede">{T['piede'].format(licenza_font=RIF['licenza_font'])}</p>
</main>"""
    return (f'<!doctype html>\n<html lang="{T["lang"]}"><head><meta charset="utf-8">'
            f'<meta name="viewport" content="width=device-width, initial-scale=1">'
            f"<title>{T['titolo']}</title><style>{_css()}</style></head>\n<body>\n{corpo}\n</body></html>\n")
