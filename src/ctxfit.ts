/**
 * Menús contextuales: al aparecer se miden y, si no caben, se suben o se
 * mueven a la izquierda para verse enteros. Si son más altos que la ventana,
 * se desplazan por dentro (ver .ctx-menu en los estilos).
 */
const MARGIN = 6;

function fit(el: HTMLElement) {
  const r = el.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (r.bottom > vh - MARGIN) el.style.top = `${Math.max(MARGIN, vh - MARGIN - r.height)}px`;
  if (r.right > vw - MARGIN) el.style.left = `${Math.max(MARGIN, vw - MARGIN - r.width)}px`;
  if (r.top < MARGIN) el.style.top = `${MARGIN}px`;
  if (r.left < MARGIN) el.style.left = `${MARGIN}px`;
}

export function installMenuFit() {
  const seen = new WeakSet<HTMLElement>();
  const scan = () => {
    document.querySelectorAll<HTMLElement>(".ctx-menu").forEach((el) => {
      // Cada menú nuevo (o reabierto en otro sitio) se vuelve a encajar.
      const key = `${el.style.left}|${el.style.top}`;
      if (seen.has(el) && el.dataset.fitKey === key) return;
      seen.add(el);
      fit(el);
      el.dataset.fitKey = `${el.style.left}|${el.style.top}`;
    });
  };
  new MutationObserver(scan).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["style"] });
  window.addEventListener("resize", scan);
}
