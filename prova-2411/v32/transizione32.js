// N3.2 (notte 25/11): il movimento delle pagine interne e del cambio pagina, con il design 32.
// 1) Entrate: nelle pagine interne titolo, righe e gruppi salgono di 24 px con una sfocatura che si scioglie, a scalare di 80 ms
//    (come le sezioni della home). 2) Cambio pagina: dove il browser ha le transizioni fra documenti (@view-transition nel CSS) le
//    fa lui; altrove, prima di lasciare la pagina, 160 ms di uscita (opacita' e sfocatura). Tornando indietro (pageshow persisted)
//    la classe di uscita si toglie: la pagina non resta mai sfocata. Con il movimento ridotto: niente di tutto questo.
(() => {
  "use strict";
  const d = document, w = window;
  const ridotto = !!(w.matchMedia && w.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const togli = () => d.documentElement.classList.remove("uscita");
  w.addEventListener("pageshow", (e) => { if (e.persisted) togli(); });
  togli();
  // N3.3: un collegamento a un punto della pagina che sta dentro un gruppo chiuso apre il gruppo (e quelli che lo contengono)
  const apri = () => {
    const id = decodeURIComponent((location.hash || "").slice(1));
    const el = id && d.getElementById(id);
    for (let x = el; x; x = x.parentElement) if (x.tagName === "DETAILS") x.open = true;
    const vis = el && el.getClientRects().length ? el : el && el.closest("details");     // il titolo nascosto: si va al gruppo
    if (vis && vis.scrollIntoView) vis.scrollIntoView();
  };
  w.addEventListener("hashchange", apri);
  if (location.hash) apri();
  if (ridotto) return;
  if (d.body && d.body.classList.contains("interne32") && "IntersectionObserver" in w) {
    const el = Array.prototype.slice.call(d.querySelectorAll("main > h1, main > section > .colonna > *, main > section > h2, main > section > p, main > section > ol > li, main details, .pagina-piede .piede-griglia > div, .pagina-piede .piede-fondo"));
    const io = new w.IntersectionObserver((vv) => vv.forEach((v) => { if (v.isIntersecting) { v.target.classList.add("entrata"); io.unobserve(v.target); } }),
      { threshold: 0 });
    let k = 0;
    el.forEach((x) => { if (x.closest(".entra")) return; x.classList.add("entra", "entra-sola"); x.style.setProperty("--k", String(k++ % 8)); io.observe(x); });
  }
  if ("onpagereveal" in w) return;                // transizioni fra documenti del browser: bastano quelle del CSS
  d.addEventListener("click", (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
    if (!a || a.target || a.hasAttribute("download")) return;
    const u = new URL(a.href, d.baseURI);
    if (u.origin !== location.origin || (u.pathname === location.pathname && u.search === location.search)) return;   // stessa pagina: solo scorrimento
    e.preventDefault();
    d.documentElement.classList.add("uscita");
    w.setTimeout(() => { location.href = u.href; }, 160);
  });
})();
