// Pagina iniziale: (1) apre i «Dettagli tecnici» quando un collegamento punta dentro di essi; (2) i numeri chiave contano fino al
// loro valore quando entrano nello schermo. Il valore finale e' gia' scritto nella pagina (senza JavaScript si legge lo stesso);
// con «riduci movimento» non c'e' nessuna animazione.
(function () {
  "use strict";
  function apriPer(id) {
    if (!id) return;
    const bersaglio = document.getElementById(id);
    const dettagli = bersaglio && bersaglio.closest("details");
    if (dettagli && !dettagli.open) { dettagli.open = true; bersaglio.scrollIntoView(); }
  }
  document.addEventListener("click", (e) => {
    const a = e.target.closest && e.target.closest('a[href^="#"]');
    if (a) apriPer(decodeURIComponent(a.getAttribute("href").slice(1)));
  });
  window.addEventListener("hashchange", () => apriPer(decodeURIComponent(location.hash.slice(1))));
  apriPer(decodeURIComponent(location.hash.slice(1)));

  const ridotto = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  // (3) le scene dei capitoli: partono solo quando sono sullo schermo e si fermano quando escono; il pulsante le ferma del tutto.
  // Con «riduci movimento» (o senza IntersectionObserver) resta il poster: nessun video parte.
  if (!ridotto && "IntersectionObserver" in window) {
    const scene = new IntersectionObserver((voci) => {
      voci.forEach((v) => {
        const video = v.target.querySelector("video");
        if (!video || video.dataset.fermata === "1") return;
        if (v.isIntersecting) { const p = video.play(); if (p && p.catch) p.catch(() => {}); } else video.pause();
      });
    }, { threshold: 0.35 });
    document.querySelectorAll("figure.scena").forEach((f) => {
      const video = f.querySelector("video"), b = f.querySelector(".scena-pausa");
      if (!video || !b) return;
      b.hidden = false;
      b.addEventListener("click", () => {
        const ferma = video.dataset.fermata !== "1";
        video.dataset.fermata = ferma ? "1" : "0";
        if (ferma) video.pause(); else { const p = video.play(); if (p && p.catch) p.catch(() => {}); }
        b.textContent = ferma ? b.dataset.riprendi : b.dataset.ferma;
      });
      scene.observe(f);
    });
  }
  if (ridotto || !("IntersectionObserver" in window) || !window.requestAnimationFrame) return;
  const conta = (el) => {
    const fine = Number(el.dataset.conta), suff = el.dataset.suffisso || "", t0 = performance.now(), durata = 1100;
    el.setAttribute("aria-label", fine + suff);       // i lettori di schermo leggono solo il valore finale
    const passo = (t) => {
      const u = Math.min(1, (t - t0) / durata), v = Math.round(fine * (1 - Math.pow(1 - u, 3)));
      el.textContent = v + suff;
      if (u < 1) requestAnimationFrame(passo);
    };
    requestAnimationFrame(passo);
  };
  const oss = new IntersectionObserver((voci) => {
    voci.forEach((v) => { if (v.isIntersecting) { oss.unobserve(v.target); conta(v.target); } });
  }, { threshold: 0.6 });
  document.querySelectorAll(".cifra[data-conta]").forEach((el) => oss.observe(el));
})();
