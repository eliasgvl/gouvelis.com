/* PYRFOROS IV flow-field viewer.
   Mounts into every [data-flow-viewer] element on the page.
   data-src  — directory holding core.json / sl_*.json / iso.json / field_*.json
               (default: same directory as the page). Needs THREE (r128+) loaded first. */
(function () {
  'use strict';
  if (typeof THREE === 'undefined') { return; }

  /* ------------------------------------------------------------ settings
     Every tunable lives here. Any of them can also be overridden per viewer
     from the markup without touching this file, by putting the same name in
     kebab-case on the mount element:
         <div data-flow-viewer data-fv-pulse-spacing="1.4" data-fv-line-base="0.04">
     Lengths are metres, speeds metres per second, widths CSS pixels.          */
  var DEFAULTS = {
    // framing
    targetY:        0.526,   // height the camera orbits, = body centroid
    azimuth:       -0.62,    // starting rotation
    polar:          1.40,    // starting elevation, radians (smaller = more from above)
    spanX:          3.0,     // half-length of world the fit tries to frame
    spanY:          0.85,    // half-height
    distMin:        5.0,
    distMax:        9.5,
    // motion
    rotateSpeed:    0.135,   // rad/s
    idleDelay:      0.0,     // s of stillness before auto-rotate resumes
    revealSpeed:    0.55,    // how fast lines draw in on load
    // streamlines
    lineWidth:      1.7,     // px
    lineWidthNarrow:1.2,     // px, under 640 px wide
    pulseSpacing:   1.55,    // m between travelling lights
    pulseSpeed:     0.8,     // m/s
    lineBase:       0.060,   // opacity of the resting line
    linePulse:      0.35,    // extra opacity at a light
    lineColorBase:  0.50,    // colour gain of the resting line
    lineColorPulse: 1.00,    // extra colour gain at a light
    // isosurfaces
    isoBase:        0.055,
    isoFresnel:     0.50
  };
  function settings(root) {
    var cfg = {}, key;
    for (key in DEFAULTS) if (DEFAULTS.hasOwnProperty(key)) {
      var attr = 'data-fv-' + key.replace(/[A-Z]/g, function (c) { return '-' + c.toLowerCase(); });
      var raw = root.getAttribute(attr);
      var num = raw === null ? NaN : parseFloat(raw);
      cfg[key] = isNaN(num) ? DEFAULTS[key] : num;
    }
    return cfg;
  }

  var REDUCED = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ------------------------------------------------------------ helpers */
  function b64bytes(s) {
    var n = s.length, out = new Uint8Array(Math.floor(n / 4) * 3), o = 0, i, k, bin;
    for (i = 0; i < n; i += 16384) {
      bin = atob(s.slice(i, i + 16384));
      for (k = 0; k < bin.length; k++) out[o++] = bin.charCodeAt(k);
    }
    return out.subarray(0, o);
  }
  function dequant(u16, lo, d) {
    var n = u16.length / 3, out = new Float32Array(u16.length), i;
    for (i = 0; i < n; i++) {
      out[i * 3]     = lo[0] + u16[i * 3]     / 65535 * d[0];
      out[i * 3 + 1] = lo[1] + u16[i * 3 + 1] / 65535 * d[1];
      out[i * 3 + 2] = lo[2] + u16[i * 3 + 2] / 65535 * d[2];
    }
    return out;
  }
  function f32(u16) {
    var a = new Float32Array(u16.length), i;
    for (i = 0; i < u16.length; i++) a[i] = u16[i] / 65535;
    return a;
  }

  /* ------------------------------------------------------------ shaders */
  var BODY_VS = [
    'attribute float scal; varying float vS; varying vec3 vN; varying vec3 vV;',
    'void main(){ vS=scal; vN=normalMatrix*normal;',
    '  vec4 mv=modelViewMatrix*vec4(position,1.0); vV=-mv.xyz;',
    '  gl_Position=projectionMatrix*mv; }'].join('\n');
  var BODY_FS = [
    'uniform sampler2D cmap; uniform vec3 uLight; uniform float uTint;',
    'varying float vS; varying vec3 vN; varying vec3 vV;',
    'void main(){',
    '  vec3 n=normalize(vN), v=normalize(vV);',
    '  if(!gl_FrontFacing) n=-n;',
    '  vec3 base=texture2D(cmap, vec2(clamp(vS,0.004,0.996),0.5)).rgb;',
    '  base=mix(base, vec3(0.33,0.37,0.44), uTint);',
    '  float key=max(dot(n,uLight),0.0);',
    '  float fill=0.5+0.5*n.y;',
    '  float back=max(dot(n,vec3(-0.5,-0.15,-0.8)),0.0);',
    '  float rim=pow(1.0-max(dot(n,v),0.0),2.7);',
    '  vec3 h=normalize(uLight+v);',
    '  vec3 col=base*(0.26+0.66*key+0.22*fill)+back*vec3(0.05,0.07,0.10);',
    '  col+=rim*vec3(0.16,0.29,0.40)+pow(max(dot(n,h),0.0),54.0)*0.22;',
    '  gl_FragColor=vec4(col,1.0);',
    '}'].join('\n');
  var SL_VS = [
    'attribute vec3 aPrev; attribute vec3 aNext;',
    'attribute float aSide; attribute float aS; attribute float aArc; attribute float aLen;',
    'uniform vec2 uRes; uniform float uW;',
    'varying float vS; varying float vArc; varying float vSide; varying float vLen;',
    'void main(){',
    '  vS=aS; vArc=aArc; vSide=aSide; vLen=aLen;',
    '  vec4 cur=projectionMatrix*modelViewMatrix*vec4(position,1.0);',
    '  vec4 nxt=projectionMatrix*modelViewMatrix*vec4(aNext,1.0);',
    '  vec4 prv=projectionMatrix*modelViewMatrix*vec4(aPrev,1.0);',
    '  vec2 h=uRes*0.5;',
    '  vec2 A=cur.xy/max(cur.w,1e-5)*h, B=nxt.xy/max(nxt.w,1e-5)*h, C=prv.xy/max(prv.w,1e-5)*h;',
    '  vec2 d=B-A; if(dot(d,d)<1e-8) d=A-C; if(dot(d,d)<1e-8) d=vec2(1.0,0.0);',
    '  vec2 dir=normalize(d);',
    '  cur.xy += vec2(-dir.y,dir.x)*aSide*uW*0.5/h*cur.w;',
    '  gl_Position=cur;',
    '}'].join('\n');
  var SL_FS = [
    'uniform sampler2D cmap; uniform float uTime; uniform float uReveal;',
    'uniform float uLambda; uniform float uSpeed;',
    'uniform float uBase; uniform float uPulse; uniform float uColA; uniform float uColB;',
    'varying float vS; varying float vArc; varying float vSide; varying float vLen;',
    'void main(){',
    '  if(vArc>uReveal) discard;',
    '  vec3 c=texture2D(cmap, vec2(clamp(vS,0.004,0.996),0.5)).rgb;',
    /* arc in METRES, so spacing and speed are the same on every line */
    '  float f=fract((vLen-uTime*uSpeed)/uLambda);',
    '  float pulse=smoothstep(0.0,0.16,f)*smoothstep(0.55,0.24,f);',
    '  float a=(uBase+pulse*uPulse)*smoothstep(1.05,0.30,abs(vSide));',
    '  a*=smoothstep(0.0,0.030,vArc)*smoothstep(1.0,0.945,vArc);',
    '  gl_FragColor=vec4(c*(uColA+pulse*uColB), a);',
    '}'].join('\n');
  var ISO_VS = [
    'attribute float shell; varying float vSh; varying vec3 vN; varying vec3 vV;',
    'void main(){ vSh=shell; vN=normalMatrix*normal;',
    '  vec4 mv=modelViewMatrix*vec4(position,1.0); vV=-mv.xyz;',
    '  gl_Position=projectionMatrix*mv; }'].join('\n');
  var ISO_FS = [
    'uniform vec3 uCol[4]; uniform float uReveal;',
    'uniform float uIsoA; uniform float uIsoB;',
    'varying float vSh; varying vec3 vN; varying vec3 vV;',
    'void main(){',
    '  int i=int(vSh+0.5);',
    '  vec3 c = i==0?uCol[0] : i==1?uCol[1] : i==2?uCol[2] : uCol[3];',
    '  vec3 n=normalize(vN), v=normalize(vV);',
    '  float fres=pow(1.0-abs(dot(n,v)),2.2);',
    '  gl_FragColor=vec4(c*(0.42+1.05*fres), (uIsoA+uIsoB*fres)*uReveal);',
    '}'].join('\n');

  /* ------------------------------------------------------------ one viewer */
  function mount(root) {
    var CFG = settings(root);
    var base = root.getAttribute('data-src') || '';
    if (base && base.charAt(base.length - 1) !== '/') base += '/';

    var q = function (s) { return root.querySelector(s); };
    var stage = q('.fv-stage'), cv = q('.fv-canvas');
    if (!stage || !cv) return;
    var elLoad = q('.fv-load'), elBar = q('.fv-bar i');
    var elSeg = q('.fv-seg'), elCtl = q('.fv-ctl');
    var elSurfName = q('.fv-surf-name'), elRampSurf = q('.fv-ramp-surf'), elLegSurf = q('.fv-leg-surf');
    var elSlName = q('.fv-sl-name'), elRampSl = q('.fv-ramp-sl'), elLegSl = q('.fv-leg-sl');
    var elLegIso = q('.fv-leg-iso'), elIsoKey = q('.fv-iso-key');
    var elTick = q('.fv-tick'), elSlab = q('.fv-slab');
    /* the stats row may live outside the viewer root */
    var elTri = q('.fv-tri') || document.querySelector('.fv-tri');

    var renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: true, alpha: false });
    renderer.setClearColor(0x000000, 0);
    renderer.outputEncoding = THREE.sRGBEncoding;
    var scene = new THREE.Scene();
    var camera = new THREE.PerspectiveCamera(34, 1, 0.35, 60);
    var LIGHT = new THREE.Vector3(0.42, 0.80, 0.44).normalize();
    var QLO = [0, 0, 0], QD = [1, 1, 1];

    /* orbit target sits on the body centroid so the model spins about itself */
    var view = { az: CFG.azimuth, pol: CFG.polar, dist: CFG.distMin,
                 tgt: new THREE.Vector3(0, CFG.targetY, 0) };
    var home = { az: CFG.azimuth, pol: CFG.polar, dist: CFG.distMin };
    var SPAN_X = CFG.spanX, SPAN_Y = CFG.spanY;
    var userZoomed = false, autoRot = !REDUCED, dragging = false;
    var vAz = 0, vPol = 0, idle = 0, px = 0, py = 0, pid = null;

    function fitDist(aspect) {
      var k = Math.tan(camera.fov * Math.PI / 360);
      return Math.min(CFG.distMax, Math.max(CFG.distMin,
               1.05 * Math.max(SPAN_X / (k * aspect), SPAN_Y / k)));
    }
    function setCam() {
      var sp = Math.sin(view.pol), cp = Math.cos(view.pol);
      camera.position.set(view.tgt.x + view.dist * sp * Math.sin(view.az),
                          view.tgt.y + view.dist * cp,
                          view.tgt.z + view.dist * sp * Math.cos(view.az));
      camera.lookAt(view.tgt);
    }
    function inCtl(e) { return e.target && e.target.closest && e.target.closest('.fv-ctl'); }
    stage.addEventListener('pointerdown', function (e) {
      if (inCtl(e)) return;
      dragging = true; pid = e.pointerId; px = e.clientX; py = e.clientY; idle = 0;
      stage.classList.add('is-drag'); stage.setPointerCapture(pid);
    });
    stage.addEventListener('pointermove', function (e) {
      if (!dragging || e.pointerId !== pid) return;
      /* inverted: dragging pulls the scene the opposite way */
      vAz -= (e.clientX - px) * 0.0026; vPol -= (e.clientY - py) * 0.0021;
      px = e.clientX; py = e.clientY;
    });
    function endDrag() { dragging = false; stage.classList.remove('is-drag'); idle = 0; }
    stage.addEventListener('pointerup', endDrag);
    stage.addEventListener('pointercancel', endDrag);
    stage.addEventListener('wheel', function (e) {
      if (inCtl(e)) return;
      e.preventDefault(); userZoomed = true;
      view.dist = Math.min(24, Math.max(2.6, view.dist * (1 + Math.sign(e.deltaY) * 0.085)));
    }, { passive: false });

    /* ---------------------------------------------------------- assets */
    var cache = {};
    /* Each asset carries its own quantisation box. Decoding one file with another
       file's box silently scales and shifts the geometry, and that stays invisible
       until two files are published out of step with each other. */
    function boxOf(asset) {
      var m = asset.meta;
      if (!m.qlo || !m.qhi) return { lo: QLO, d: QD };
      return { lo: m.qlo,
               d: [m.qhi[0]-m.qlo[0], m.qhi[1]-m.qlo[1], m.qhi[2]-m.qlo[2]] };
    }
    function loadAsset(name, onprog) {
      if (cache[name]) return Promise.resolve(cache[name]);
      return fetch(base + name).then(function (res) {
        if (!res.ok) throw new Error(name + ': HTTP ' + res.status);
        var total = +res.headers.get('content-length') || 0;
        if (!(res.body && res.body.getReader)) return res.text();
        var rd = res.body.getReader(), dec = new TextDecoder(), got = 0, parts = [];
        return (function pump() {
          return rd.read().then(function (r) {
            if (r.done) { parts.push(dec.decode()); return parts.join(''); }
            got += r.value.length; parts.push(dec.decode(r.value, { stream: true }));
            if (onprog) onprog(total ? got / total : Math.min(0.96, got / 2.9e6));
            return pump();
          });
        })();
      }).then(function (text) {
        var j = JSON.parse(text), by = b64bytes(j.b64);
        cache[name] = { meta: j.meta,
          buf: by.buffer.slice(by.byteOffset, by.byteOffset + by.byteLength) };
        return cache[name];
      });
    }
    function cmapTexture(b64) {
      var raw = b64bytes(b64), n = raw.length / 3, rgba = new Uint8Array(n * 4), i;
      for (i = 0; i < n; i++) {
        rgba[i * 4] = raw[i * 3]; rgba[i * 4 + 1] = raw[i * 3 + 1];
        rgba[i * 4 + 2] = raw[i * 3 + 2]; rgba[i * 4 + 3] = 255;
      }
      var t = new THREE.DataTexture(rgba, n, 1, THREE.RGBAFormat);
      t.needsUpdate = true; t.encoding = THREE.sRGBEncoding;
      t.minFilter = t.magFilter = THREE.LinearFilter;
      t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
      return { tex: t, raw: raw, n: n };
    }
    function rampCSS(cm, a, b) {
      var st = [], i, f, k;
      for (i = 0; i <= 12; i++) {
        f = i / 12; k = Math.round((a + f * (b - a)) * (cm.n - 1));
        st.push('rgb(' + cm.raw[k * 3] + ',' + cm.raw[k * 3 + 1] + ',' + cm.raw[k * 3 + 2] +
                ') ' + (f * 100).toFixed(1) + '%');
      }
      return 'linear-gradient(90deg,' + st.join(',') + ')';
    }

    /* ---------------------------------------------------------- body */
    var chunkGeos = [], chunkKeep = [], bodyMat = null;
    var fieldTex = {}, fieldMeta = {}, fieldAttr = {}, activeField = 'plain';

    function buildBody(core) {
      var S = core.meta.sections, buf = core.buf, i, ci;
      QLO = core.meta.qlo;
      QD = [core.meta.qhi[0] - QLO[0], core.meta.qhi[1] - QLO[1], core.meta.qhi[2] - QLO[2]];
      for (i = 0; i < core.meta.fields.length; i++) {
        var f = core.meta.fields[i];
        fieldTex[f.key] = cmapTexture(f.cmap); fieldMeta[f.key] = f;
      }
      bodyMat = new THREE.ShaderMaterial({
        uniforms: { cmap: { value: fieldTex.pressure.tex }, uLight: { value: LIGHT },
                    uTint: { value: 0 } },
        vertexShader: BODY_VS, fragmentShader: BODY_FS, side: THREE.DoubleSide,
        /* nudge the body back in depth only, so a streamline riding the skin is
           not swallowed by the surface it belongs to */
        polygonOffset: true, polygonOffsetFactor: 2.0, polygonOffsetUnits: 4.0 });
      var tris = 0;
      fieldAttr.pressure = [];
      for (ci = 0; ci < core.meta.chunks; ci++) {
        var pos = dequant(new Uint16Array(buf, S['pos' + ci].off, S['pos' + ci].len), QLO, QD);
        var idx = new Uint16Array(buf, S['idx' + ci].off, S['idx' + ci].len);
        var g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        g.setIndex(new THREE.BufferAttribute(idx, 1));
        var a = new THREE.BufferAttribute(
          f32(new Uint16Array(buf, S['scal' + ci].off, S['scal' + ci].len)), 1);
        fieldAttr.pressure.push(a);
        g.setAttribute('scal', a);
        g.computeVertexNormals();      /* smooth normals from the decimated surface */
        g.computeBoundingSphere();
        chunkGeos.push(g); chunkKeep.push(null);
        scene.add(new THREE.Mesh(g, bodyMat));
        tris += idx.length / 3;
      }
      if (elTri) elTri.innerHTML = Math.round(tris / 1000) + 'k <small>tri</small>';

      var gq = new THREE.Mesh(new THREE.PlaneGeometry(11, 5), new THREE.ShaderMaterial({
        transparent: true, depthWrite: false,
        vertexShader: 'varying vec2 vU; void main(){vU=uv;' +
          'gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
        fragmentShader: 'varying vec2 vU; void main(){ vec2 p=(vU-0.5)*vec2(2.4,3.1);' +
          'gl_FragColor=vec4(0.0,0.0,0.0,(1.0-smoothstep(0.25,1.0,length(p)))*0.55);}' }));
      gq.rotation.x = -Math.PI / 2; gq.position.set(0.1, 0.004, 0); gq.renderOrder = -1;
      scene.add(gq);
      applyField('plain');
    }

    function applyField(key) {
      activeField = key;
      var i, btns = elSeg ? elSeg.children : [];
      for (i = 0; i < btns.length; i++)
        btns[i].setAttribute('aria-pressed', String(btns[i].getAttribute('data-field') === key));
      if (!bodyMat) return;
      if (key === 'plain') {
        bodyMat.uniforms.uTint.value = 1;
        if (elLegSurf) elLegSurf.hidden = true;
        return;
      }
      bodyMat.uniforms.uTint.value = 0;
      for (i = 0; i < chunkGeos.length; i++) chunkGeos[i].setAttribute('scal', fieldAttr[key][i]);
      bodyMat.uniforms.cmap.value = fieldTex[key].tex;
      var f = fieldMeta[key];
      if (elSurfName) elSurfName.textContent = f.label;
      if (elRampSurf) elRampSurf.style.background = rampCSS(fieldTex[key], f.min, f.max);
      if (elLegSurf) elLegSurf.hidden = false;
    }

    function selectField(key, btn) {
      if (key === 'plain' || fieldAttr[key]) { applyField(key); return; }
      var f = fieldMeta[key];
      if (!f || !f.file || btn.getAttribute('data-busy') === '1') return;
      btn.setAttribute('data-busy', '1');
      loadAsset(f.file).then(function (a) {
        var arr = [], ci;
        for (ci = 0; ci < chunkGeos.length; ci++)
          arr.push(new THREE.BufferAttribute(
            f32(new Uint16Array(a.buf, a.meta.sections['scal' + ci].off,
                                a.meta.sections['scal' + ci].len)), 1));
        fieldAttr[key] = arr; applyField(key);
      })['catch'](function (err) { btn.title = 'Could not load: ' + (err.message || err); })
       .then(function () { btn.setAttribute('data-busy', '0'); });
    }

    /* ---------------------------------------------------------- layers */
    var slMats = [], built = {};
    var LAYER = { sl:  { file: 'streamlines.json', kind: 'sl' },
                  iso: { file: 'iso.json', kind: 'iso' } };

    function buildStreamlines(asset) {
      var S = asset.meta.sections, buf = asset.buf;
      var bx = boxOf(asset);
      var sp = dequant(new Uint16Array(buf, S.pos.off, S.pos.len), bx.lo, bx.d);
      var ss = new Uint16Array(buf, S.scal.off, S.scal.len);
      var sa = new Uint16Array(buf, S.arc.off, S.arc.len);
      var sn = new Uint16Array(buf, S.alen.off, S.alen.len);
      var ARCMAX = asset.meta.arcMax || 10.0;
      var off = new Uint32Array(buf, S.off.off, S.off.len);
      var nPt = ss.length, nL = off.length - 1, V = nPt * 2;
      var aPos = new Float32Array(V * 3), aPrev = new Float32Array(V * 3), aNext = new Float32Array(V * 3);
      var aSide = new Float32Array(V), aS = new Float32Array(V), aArc = new Float32Array(V);
      var aLen = new Float32Array(V);
      var idx = new Uint32Array((nPt - nL) * 6), w = 0, qi = 0, L, a, b, i, p, n, s, o;
      for (L = 0; L < nL; L++) {
        a = off[L]; b = off[L + 1];
        for (i = a; i < b; i++) {
          p = (i === a ? i : i - 1); n = (i === b - 1 ? i : i + 1);
          for (s = 0; s < 2; s++) {
            o = (w + s) * 3;
            aPos[o] = sp[i * 3]; aPos[o + 1] = sp[i * 3 + 1]; aPos[o + 2] = sp[i * 3 + 2];
            aPrev[o] = sp[p * 3]; aPrev[o + 1] = sp[p * 3 + 1]; aPrev[o + 2] = sp[p * 3 + 2];
            aNext[o] = sp[n * 3]; aNext[o + 1] = sp[n * 3 + 1]; aNext[o + 2] = sp[n * 3 + 2];
            aSide[w + s] = s ? 1 : -1; aS[w + s] = ss[i] / 65535; aArc[w + s] = sa[i] / 65535;
            aLen[w + s] = sn[i] / 65535 * ARCMAX;
          }
          if (i < b - 1) {
            idx[qi++] = w; idx[qi++] = w + 1; idx[qi++] = w + 2;
            idx[qi++] = w + 1; idx[qi++] = w + 3; idx[qi++] = w + 2;
          }
          w += 2;
        }
      }
      var g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(aPos, 3));
      g.setAttribute('aPrev', new THREE.BufferAttribute(aPrev, 3));
      g.setAttribute('aNext', new THREE.BufferAttribute(aNext, 3));
      g.setAttribute('aSide', new THREE.BufferAttribute(aSide, 1));
      g.setAttribute('aS', new THREE.BufferAttribute(aS, 1));
      g.setAttribute('aArc', new THREE.BufferAttribute(aArc, 1));
      g.setAttribute('aLen', new THREE.BufferAttribute(aLen, 1));
      g.setIndex(new THREE.BufferAttribute(idx, 1));
      g.computeBoundingSphere();
      var cm = cmapTexture(asset.meta.cmap);
      var m = new THREE.ShaderMaterial({
        uniforms: { cmap: { value: cm.tex }, uRes: { value: new THREE.Vector2(1, 1) },
                    uW: { value: CFG.lineWidth }, uTime: { value: 0 }, uReveal: { value: 0 },
                    uLambda: { value: CFG.pulseSpacing }, uSpeed: { value: CFG.pulseSpeed },
                    uBase: { value: CFG.lineBase }, uPulse: { value: CFG.linePulse },
                    uColA: { value: CFG.lineColorBase }, uColB: { value: CFG.lineColorPulse } },
        vertexShader: SL_VS, fragmentShader: SL_FS, transparent: true,
        depthWrite: false, depthTest: true,
        blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
      var mesh = new THREE.Mesh(g, m); mesh.frustumCulled = false;
      return { mesh: mesh, mat: m, cm: cm };
    }

    function buildIso(asset) {
      var S = asset.meta.sections, buf = asset.buf, i;
      var bi = boxOf(asset);
      var pos = dequant(new Uint16Array(buf, S.pos.off, S.pos.len), bi.lo, bi.d);
      var nv = pos.length / 3;
      var sh = new Uint8Array(buf, S.shell.off, S.shell.len);
      var shf = new Float32Array(nv);
      for (i = 0; i < nv; i++) shf[i] = sh[i];
      var g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('shell', new THREE.BufferAttribute(shf, 1));
      g.setIndex(new THREE.BufferAttribute(new Uint16Array(buf, S.idx.off, S.idx.len), 1));
      g.computeVertexNormals(); g.computeBoundingSphere();
      var cols = asset.meta.colors.map(function (c) { return new THREE.Vector3(c[0], c[1], c[2]); });
      while (cols.length < 4) cols.push(new THREE.Vector3(1, 1, 1));
      var m = new THREE.ShaderMaterial({
        uniforms: { uCol: { value: cols }, uReveal: { value: 0 },
                    uIsoA: { value: CFG.isoBase }, uIsoB: { value: CFG.isoFresnel } },
        vertexShader: ISO_VS, fragmentShader: ISO_FS, transparent: true,
        depthWrite: false, depthTest: true,
        blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
      if (elIsoKey) {
        elIsoKey.innerHTML = '';
        asset.meta.colors.forEach(function (c) {
          var s = document.createElement('i');
          s.style.background = 'rgb(' + Math.round(c[0] * 255) + ',' +
            Math.round(c[1] * 255) + ',' + Math.round(c[2] * 255) + ')';
          elIsoKey.appendChild(s);
        });
      }
      var mesh = new THREE.Mesh(g, m); mesh.frustumCulled = false;
      return { mesh: mesh, mat: m };
    }

    function refreshSlLegend() {
      var b = built.sl;
      if (!b || !b.mesh.visible) { if (elLegSl) elLegSl.hidden = true; return; }
      var a = cache[LAYER.sl.file];
      if (elRampSl) elRampSl.style.background = rampCSS(b.cm, a.meta.min, a.meta.max);
      if (elLegSl) elLegSl.hidden = false;
    }

    function toggleLayer(key, btn) {
      var L = LAYER[key];
      if (built[key]) {
        var vis = built[key].mesh.visible = !built[key].mesh.visible;
        btn.setAttribute('aria-pressed', String(vis));
        if (key === 'iso') { if (elLegIso) elLegIso.hidden = !vis; } else refreshSlLegend();
        return Promise.resolve();
      }
      if (btn.getAttribute('data-busy') === '1') return Promise.resolve();
      var label = btn.textContent;
      btn.setAttribute('data-busy', '1'); btn.textContent = 'LOADING…';
      return loadAsset(L.file).then(function (a) {
        var b = L.kind === 'sl' ? buildStreamlines(a) : buildIso(a);
        built[key] = b; scene.add(b.mesh);
        if (L.kind === 'sl') slMats.push(b.mat);
        btn.setAttribute('aria-pressed', 'true');
        if (key === 'iso') { if (elLegIso) elLegIso.hidden = false; } else refreshSlLegend();
        resize();
      })['catch'](function (err) {
        btn.setAttribute('aria-pressed', 'false');
        btn.title = 'Could not load: ' + (err.message || err);
      }).then(function () { btn.setAttribute('data-busy', '0'); btn.textContent = label; });
    }

    /* ---------------------------------------------------------- loop */
    function updateScale(h) {
      if (!elTick) return;
      var wpp = 2 * Math.tan(camera.fov * Math.PI / 360) * view.dist / h;
      var target = 120 * wpp, p = Math.pow(10, Math.floor(Math.log(target) / Math.LN10));
      var m = target / p, nice = (m >= 5 ? 5 : m >= 2 ? 2 : 1) * p;
      elTick.style.width = Math.round(nice / wpp) + 'px';
      if (elSlab) elSlab.textContent = nice >= 1
        ? nice.toFixed(nice % 1 ? 1 : 0) + ' m' : Math.round(nice * 100) + ' cm';
    }
    function resize() {
      var r = stage.getBoundingClientRect(), i;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(r.width, r.height, false);
      camera.aspect = r.width / r.height; camera.updateProjectionMatrix();
      home.dist = fitDist(camera.aspect);
      if (!userZoomed) view.dist = home.dist;
      for (i = 0; i < slMats.length; i++) {
        slMats[i].uniforms.uRes.value.set(r.width, r.height);
        slMats[i].uniforms.uW.value = r.width < 640 ? CFG.lineWidthNarrow : CFG.lineWidth;
      }
      updateScale(r.height);
    }
    window.addEventListener('resize', resize);

    var last = performance.now();
    function frame(now) {
      var dt = Math.min((now - last) / 1000, 0.05), i; last = now;
      if (!dragging) { idle += dt; if (autoRot && idle > CFG.idleDelay) view.az -= dt * CFG.rotateSpeed; }
      view.az += vAz; view.pol += vPol; vAz *= 0.86; vPol *= 0.86;
      view.pol = Math.max(0.22, Math.min(1.62, view.pol));
      setCam();
      for (i = 0; i < slMats.length; i++) {
        if (!REDUCED) slMats[i].uniforms.uTime.value += dt;
        slMats[i].uniforms.uReveal.value =
          Math.min(1, slMats[i].uniforms.uReveal.value + dt * (REDUCED ? 4 : CFG.revealSpeed));
      }
      if (built.iso) {
        var u = built.iso.mat.uniforms.uReveal;
        u.value = Math.min(1, u.value + dt * (REDUCED ? 4 : 1.1));
      }
      updateScale(stage.getBoundingClientRect().height);
      renderer.render(scene, camera);
      requestAnimationFrame(frame);
    }

    /* ---------------------------------------------------------- wiring */
    function press(el, fn) {
      el.setAttribute('type', 'button');
      el.addEventListener('click', function (ev) {
        ev.preventDefault(); ev.stopPropagation(); fn(ev);
      });
    }
    if (elSeg) Array.prototype.forEach.call(elSeg.children, function (b) {
      press(b, function () { selectField(b.getAttribute('data-field'), b); });
    });
    var layerBtns = root.querySelectorAll('.fv-ctl button[data-layer]');
    Array.prototype.forEach.call(layerBtns, function (b) {
      press(b, function () { toggleLayer(b.getAttribute('data-layer'), b); });
    });
    var bRot = q('.fv-rot'), bRst = q('.fv-reset');
    if (bRot) press(bRot, function () {
      autoRot = !autoRot; idle = 0; bRot.setAttribute('aria-pressed', String(autoRot)); });
    if (bRst) press(bRst, function () {
      userZoomed = false; view.az = home.az; view.pol = home.pol;
      view.dist = home.dist; vAz = vPol = 0; idle = 0; });

    loadAsset('core.json', function (f) {
      if (elBar) elBar.style.width = (f * 100).toFixed(0) + '%';
    }).then(function (core) {
      if (elBar) elBar.style.width = '100%';
      buildBody(core);
      resize();
      if (elLoad) { elLoad.style.opacity = '0'; setTimeout(function () { elLoad.hidden = true; }, 500); }
      requestAnimationFrame(frame);
      var sl = root.querySelector('.fv-ctl button[data-layer="sl"]');
      if (sl) toggleLayer('sl', sl);
    })['catch'](function (err) {
      if (elLoad) elLoad.innerHTML =
        '<div style="color:#F2A13C">COULD NOT LOAD FLOW FIELD</div>' +
        '<div style="font-size:10px;letter-spacing:0">' + String(err && err.message || err) + '</div>';
    });
  }

  function init() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-flow-viewer]'), mount);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
