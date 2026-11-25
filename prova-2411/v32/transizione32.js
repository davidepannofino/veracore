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
  // U8 (ultimo giro 25/11): pagine interne vive come la home
  if (d.body && d.body.classList.contains("interne32")) {
    // il titolo si compone (lettere che cambiano fino al testo vero, come gli occhielli della home)
    const h1 = d.querySelector("main h1");
    if (h1 && h1.children.length === 0) {
      const fine = h1.textContent, segni = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", t0 = performance.now();
      h1.setAttribute("aria-label", fine);
      const giro = (t) => { const k = Math.min(1, (t - t0) / 650), n = Math.floor(fine.length * k);
        h1.textContent = fine.slice(0, n) + fine.slice(n).replace(/\S/g, () => segni[Math.floor(Math.random() * segni.length)]);
        if (k < 1) w.requestAnimationFrame(giro); else { h1.textContent = fine; h1.removeAttribute("aria-label"); } };
      w.requestAnimationFrame(giro);
    }
    // righe di elenchi e tabelle a scalare quando il loro blocco entra
    if ("IntersectionObserver" in w) {
      const io2 = new w.IntersectionObserver((vv) => vv.forEach((v) => { if (v.isIntersecting) { v.target.classList.add("righe-dentro"); io2.unobserve(v.target); } }), { threshold: 0 });
      d.querySelectorAll("main ul, main ol, main table").forEach((l) => {
        const righe = l.tagName === "TABLE" ? l.querySelectorAll("tr") : l.children;
        Array.prototype.forEach.call(righe, (r, i) => { r.classList.add("riga-entra"); r.style.setProperty("--r", String(Math.min(i, 14))); });
        io2.observe(l);
      });
    }
    // i gruppi chiusi si aprono e si chiudono con un movimento (altezza e dissolvenza), non di scatto
    d.querySelectorAll("details.gruppo-interno").forEach((g) => {
      const s = g.querySelector(":scope > summary");
      if (!s || !g.animate) return;
      let anim = null;
      s.addEventListener("click", (e) => {
        e.preventDefault();
        if (anim) anim.cancel();
        const da = g.offsetHeight, chiudi = g.open;
        if (!chiudi) g.open = true;
        const a = chiudi ? s.offsetHeight : g.scrollHeight;
        g.style.overflow = "hidden";
        anim = g.animate([{ height: da + "px", opacity: chiudi ? 1 : 0.6 }, { height: a + "px", opacity: 1 }], { duration: 380, easing: "cubic-bezier(.16,.84,.24,1)" });
        anim.onfinish = () => { if (chiudi) g.open = false; g.style.overflow = ""; anim = null; };
        anim.oncancel = () => { g.style.overflow = ""; };
      });
    });
    // una linea sottile di avanzamento dello scorrimento sotto la barra del menù
    const nav = d.querySelector(".pagina-barra nav");
    if (nav) {
      const linea = d.createElement("span"); linea.className = "avanza"; linea.setAttribute("aria-hidden", "true"); nav.appendChild(linea);
      let in_coda = false;
      const posa = () => { in_coda = false; const h = d.documentElement.scrollHeight - w.innerHeight;
        linea.style.transform = "scaleX(" + (h > 0 ? Math.min(1, Math.max(0, w.scrollY / h)) : 0).toFixed(4) + ")"; };
      w.addEventListener("scroll", () => { if (!in_coda) { in_coda = true; w.requestAnimationFrame(posa); } }, { passive: true });
      posa();
    }
    // crash test: quando il Rapporto e' pronto (la cornice non e' piu' nascosta) la cornice entra con il suo movimento
    const rap = d.getElementById("rapporto");
    if (rap && "MutationObserver" in w) {
      const mo = new w.MutationObserver(() => { if (!rap.hidden) { rap.classList.remove("cornice-entra"); void rap.offsetWidth; rap.classList.add("cornice-entra"); } });
      mo.observe(rap, { attributes: true, attributeFilter: ["hidden"] });
    }
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
