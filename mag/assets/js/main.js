document.getElementById('year').textContent = new Date().getFullYear();

const navToggle = document.querySelector('.nav-toggle');
const navMenu = document.getElementById('nav-menu');

navToggle.addEventListener('click', () => {
  const isOpen = navMenu.classList.toggle('is-open');
  navToggle.setAttribute('aria-expanded', String(isOpen));
});

navMenu.querySelectorAll('a').forEach((link) => {
  link.addEventListener('click', () => {
    navMenu.classList.remove('is-open');
    navToggle.setAttribute('aria-expanded', 'false');
  });
});

// Back-to-top: appears once the reader has scrolled past one viewport.
// Uses window.scrollTo rather than an anchor so it works on every page
// regardless of whether that page has a "#top" section.
const backToTop = document.createElement('button');
backToTop.type = 'button';
backToTop.className = 'back-to-top';
backToTop.setAttribute('aria-label', 'Back to top');
backToTop.innerHTML = '&uarr;';
document.body.appendChild(backToTop);

const toggleBackToTop = () => {
  backToTop.classList.toggle('is-visible', window.scrollY > window.innerHeight);
};
window.addEventListener('scroll', toggleBackToTop, { passive: true });
toggleBackToTop();

backToTop.addEventListener('click', () => {
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
});

// Scroll-spy: highlight the nav link for whichever in-page section is
// currently in view. Not gated behind prefers-reduced-motion — it's a
// state/color change, not motion, and reduced-motion users still benefit
// from knowing where they are on the page.
const spyLinks = Array.from(navMenu.querySelectorAll('a[href^="#"]'))
  .filter((link) => link.getAttribute('href').length > 1);
const spySections = spyLinks
  .map((link) => document.getElementById(link.getAttribute('href').slice(1)))
  .filter(Boolean);

if (spySections.length) {
  const setActive = (id) => {
    spyLinks.forEach((link) => {
      link.classList.toggle('is-active', link.getAttribute('href') === `#${id}`);
    });
  };
  const spyObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) setActive(entry.target.id);
    });
  }, { rootMargin: '-40% 0px -55% 0px', threshold: 0 });
  spySections.forEach((section) => spyObserver.observe(section));
}

const prefersReducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

if (!prefersReducedMotion) {
  // Scroll reveals
  const revealEls = Array.from(document.querySelectorAll('[data-reveal]'));
  revealEls.forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.top < window.innerHeight * 0.9) return; // already visible: don't hide
    el.dataset.hidden = '1';
  });
  const revealObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting && entry.target.dataset.hidden) {
        delete entry.target.dataset.hidden;
        revealObserver.unobserve(entry.target);
      }
    });
  }, { threshold: 0.08 });
  revealEls.forEach((el) => { if (el.dataset.hidden) revealObserver.observe(el); });

  // Per-item stagger: children of [data-stagger] containers cascade in
  // rather than revealing as one block. Skipped for containers already
  // visible at load, matching the [data-reveal] "don't hide the above-the-
  // fold" rule.
  const staggerItems = [];
  document.querySelectorAll('[data-stagger]').forEach((container) => {
    const r = container.getBoundingClientRect();
    if (r.top < window.innerHeight * 0.9) return;
    // display:none children are skipped rather than numbered — the project
    // index hides .project-card-stub cards that come from the shared partial,
    // and counting them would spend cascade slots on rows nobody sees, leaving
    // visible cards to arrive late and unevenly.
    const children = Array.from(container.children)
      .filter((child) => getComputedStyle(child).display !== 'none');
    children.forEach((child, i) => {
      child.style.setProperty('--i', i);
      child.dataset.hidden = '1';
      child.setAttribute('data-stagger-item', '');
      staggerItems.push(child);
    });
  });
  const staggerObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting && entry.target.dataset.hidden) {
        delete entry.target.dataset.hidden;
        staggerObserver.unobserve(entry.target);
      }
    });
  }, { threshold: 0.1 });
  staggerItems.forEach((el) => staggerObserver.observe(el));

  // Animated counters. The HTML already contains the real, correct value
  // (so no-JS visitors and crawlers see real numbers) — only zero it out
  // right as the count-up animation starts, never as a persistent state.
  const counters = Array.from(document.querySelectorAll('[data-count]'));
  const animateCounter = (el) => {
    const target = parseFloat(el.dataset.count);
    const decimals = parseInt(el.dataset.decimals || '0', 10);
    const duration = 1300;
    el.textContent = (0).toFixed(decimals);
    const start = performance.now();
    const tick = (now) => {
      const progress = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      el.textContent = (target * eased).toFixed(decimals);
      if (progress < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
  const counterObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        animateCounter(entry.target);
        counterObserver.unobserve(entry.target);
      }
    });
  }, { threshold: 0.6 });
  counters.forEach((el) => counterObserver.observe(el));
}
