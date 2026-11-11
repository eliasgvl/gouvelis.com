(function () {
  'use strict';

  var outer = document.querySelector('[data-cube3d]');
  if (!outer) return;

  var wrap = outer.querySelector('.cube3d-scene-wrap');
  var scene = outer.querySelector('.cube3d-scene');
  var group = outer.querySelector('.cube3d-group');
  var resetBtn = outer.querySelector('.cube3d-reset');
  // Direct-child combinator only: .cube3d-point-win nests an inner
  // .cube3d-point-pulse-ring for its own scale animation (an animated
  // property always overrides an inline style on the *same* element, so
  // the billboard rotation must land one level up from anything animated,
  // or the animation silently wins and the ring stops facing the camera).
  var billboarded = outer.querySelectorAll('.cube3d-tick > i, .cube3d-point > i');
  if (!wrap || !scene || !group) return;

  var INITIAL_RX = -20;
  var INITIAL_RY = -28;
  var rx = INITIAL_RX;
  var ry = INITIAL_RY;

  // Box half-extents (must match the --x/--y/--z values baked into the
  // markup) plus a margin covering tick-label overhang and point radii, so
  // the fitted box never clips a label at any rotation. A cube, so all
  // three match.
  var HX = 140, HY = 140, HZ = 140, PAD = 45;
  var PERSPECTIVE = 1600;
  // A cube's projected width/height stay much closer to each other than
  // the old wide box's did (roughly 415-640px across the full rx/ry
  // range at PAD=45) — 620 sits just above the largest sampled value, so
  // it only caps the most oblique angles rather than routinely overriding
  // the width-driven fit.
  var MAX_HEIGHT = 620;
  var MIN_SCALE = 0.28;
  var MAX_SCALE = 1.3;

  var corners = (function () {
    var xs = [-HX - PAD, HX + PAD];
    var ys = [-HY - PAD, HY + PAD];
    var zs = [-HZ - PAD, HZ + PAD];
    var out = [];
    for (var xi = 0; xi < 2; xi++) {
      for (var yi = 0; yi < 2; yi++) {
        for (var zi = 0; zi < 2; zi++) {
          out.push([xs[xi], ys[yi], zs[zi]]);
        }
      }
    }
    return out;
  })();

  // Projects the box's corners through the same rotateX(rx) rotateY(ry)
  // + perspective(P) math the CSS group transform applies, to find how
  // wide/tall the box's rendered silhouette actually is at this angle —
  // this is what makes the fit angle-dependent rather than a fixed ratio.
  function projectedBounds(rxDeg, ryDeg) {
    var rxr = rxDeg * Math.PI / 180;
    var ryr = ryDeg * Math.PI / 180;
    var cosY = Math.cos(ryr), sinY = Math.sin(ryr);
    var cosX = Math.cos(rxr), sinX = Math.sin(rxr);
    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (var i = 0; i < corners.length; i++) {
      var p = corners[i];
      var x1 = p[0] * cosY + p[2] * sinY;
      var z1 = -p[0] * sinY + p[2] * cosY;
      var y2 = p[1] * cosX - z1 * sinX;
      var z2 = p[1] * sinX + z1 * cosX;
      var w = 1 - z2 / PERSPECTIVE;
      var sx = x1 / w;
      var sy = y2 / w;
      if (sx < minX) minX = sx;
      if (sx > maxX) maxX = sx;
      if (sy < minY) minY = sy;
      if (sy > maxY) maxY = sy;
    }
    return { minX: minX, maxX: maxX, minY: minY, maxY: maxY };
  }

  function renderPose() {
    group.style.transform = 'rotateX(' + rx + 'deg) rotateY(' + ry + 'deg)';
    var counter = 'rotateY(' + (-ry) + 'deg) rotateX(' + (-rx) + 'deg)';
    for (var i = 0; i < billboarded.length; i++) {
      billboarded[i].style.transform = counter;
    }
  }

  // Re-fits every frame, including idle auto-rotation — not just on
  // drag/resize/reset. The box's true on-screen footprint changes
  // continuously as it spins (e.g. viewed near end-on along the long mass
  // axis it's much narrower than face-on), so a fit computed once and then
  // held while ry keeps advancing would visibly shrink the box at those
  // angles instead of tracking them.
  function render() {
    renderPose();
    fit();
  }

  // Shared by fit() (every frame) and updateWrapHeight() (only at "settled"
  // moments — see below): the scale that makes the box's current projected
  // silhouette fill wrap's width, capped by MAX_HEIGHT.
  function computeFit() {
    var b = projectedBounds(rx, ry);
    var w = b.maxX - b.minX;
    var h = b.maxY - b.minY;
    var availWidth = wrap.clientWidth;
    var scale = Math.min(availWidth / w, MAX_HEIGHT / h);
    scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale));
    return { scale: scale, h: h, cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2 };
  }

  function fit() {
    var f = computeFit();
    scene.style.transform = 'translate(' + (-f.cx * f.scale).toFixed(2) + 'px, ' + (-f.cy * f.scale).toFixed(2) + 'px) scale(' + f.scale.toFixed(4) + ')';
  }

  // wrap's reserved height tracks the actual rendered size (previously a
  // flat MAX_HEIGHT constant, which left a lot of dead space above/below
  // the cube on narrow viewports where the width-driven scale is much
  // smaller than what MAX_HEIGHT assumes). Only called at settled moments
  // (init/resize/drag-end/reset), not every idle-rotation frame, so this
  // doesn't reflow the layout below it continuously during ambient spin.
  function updateWrapHeight() {
    var f = computeFit();
    wrap.style.height = Math.round(f.h * f.scale) + 'px';
  }

  if (window.ResizeObserver) {
    new ResizeObserver(function () { render(); updateWrapHeight(); }).observe(wrap);
  } else {
    window.addEventListener('resize', function () { render(); updateWrapHeight(); });
  }

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var dragging = false;
  var lastX = 0;
  var lastY = 0;
  var idleDelay = 0;

  function onPointerDown(e) {
    dragging = true;
    idleDelay = 1400;
    lastX = e.clientX;
    lastY = e.clientY;
    scene.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e) {
    if (!dragging) return;
    var dx = e.clientX - lastX;
    var dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    ry += dx * 0.4;
    rx -= dy * 0.4;
    rx = Math.max(-85, Math.min(85, rx));
    render();
  }

  function onPointerUp(e) {
    dragging = false;
    if (scene.hasPointerCapture && scene.hasPointerCapture(e.pointerId)) {
      scene.releasePointerCapture(e.pointerId);
    }
    updateWrapHeight();
  }

  scene.addEventListener('pointerdown', onPointerDown);
  scene.addEventListener('pointermove', onPointerMove);
  scene.addEventListener('pointerup', onPointerUp);
  scene.addEventListener('pointercancel', onPointerUp);

  if (resetBtn) {
    resetBtn.addEventListener('click', function () {
      rx = INITIAL_RX;
      ry = INITIAL_RY;
      idleDelay = 1400;
      render();
      updateWrapHeight();
    });
  }

  render();
  updateWrapHeight();

  if (!reduceMotion) {
    var lastTime = null;
    var DEG_PER_SEC = 6;

    function tick(time) {
      if (lastTime === null) lastTime = time;
      var dt = (time - lastTime) / 1000;
      lastTime = time;

      if (dragging) {
        idleDelay = 1400;
      } else if (idleDelay > 0) {
        idleDelay -= dt * 1000;
      } else {
        ry += DEG_PER_SEC * dt;
        render();
      }
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }
})();
