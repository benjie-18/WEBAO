/**
 * WEBAO Motion Architecture
 * - All animations are CSS-first (transform/opacity) for 60fps.
 * - JS only observes visibility via IntersectionObserver and toggles .is-visible.
 * - Respects prefers-reduced-motion: reduce. JS bails and CSS disables transitions.
 * - No heavy libraries (no GSAP, Framer). Small, auditable, performant.
 *
 * Usage: add `data-reveal` (or data-reveal="fade|scale") to any element.
 * Optional inline `--d: 80ms` for stagger.
 *
 * Verified: IntersectionObserver 97%+ support, fallback is instant reveal.
 * View Transitions are not used for critical path; header persistence via CSS sticky.
 */

export function initReveal() {
  if (typeof window === "undefined") return;
  const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const els = document.querySelectorAll("[data-reveal]");
  if (prefersReduced || !("IntersectionObserver" in window)) {
    els.forEach((el) => el.classList.add("is-visible"));
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          (e.target as HTMLElement).classList.add("is-visible");
          io.unobserve(e.target);
        }
      }
    },
    { threshold: 0.12, rootMargin: "0px 0px -6% 0px" }
  );
  els.forEach((el) => io.observe(el));
}
