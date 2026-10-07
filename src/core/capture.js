// capture.js -- screenshots and the URL/JS automation surface.
//
// Reading pixels back is order-sensitive: with preserveDrawingBuffer false the
// drawing buffer is cleared once the frame is composited, so toDataURL() must
// run in the *same task* as the render. Everything here keeps that invariant.

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

/** Parse the automation query string. */
export function parseUrlOptions(search = location.search) {
  const q = new URLSearchParams(search);
  const num = (k, d) => (q.has(k) && Number.isFinite(+q.get(k)) ? +q.get(k) : d);
  const bool = (k, d) => (q.has(k) ? !['0', 'false', 'no'].includes(q.get(k)) : d);
  return {
    shot: bool('shot', false),           // render one frame then expose it
    width: num('w', 0),
    height: num('h', 0),
    time: q.has('t') ? num('t', 0) : null,
    preset: q.get('preset'),
    quality: q.get('quality'),
    debug: q.has('view') ? num('view', 0) : null,
    hud: bool('hud', true),
    cine: bool('cine', false),
    orbit: bool('orbit', false),
    audio: bool('audio', false),
    paused: bool('paused', false),
    dpr: num('dpr', 0),
    preserve: bool('preserve', false) || bool('shot', false),
    params: Object.fromEntries([...q].filter(([k]) => k.startsWith('p.'))
      .map(([k, v]) => [k.slice(2), +v])),
  };
}

/**
 * Render one frame at an explicit size and return a PNG data URL.
 * Restores the previous size afterwards.
 */
export function captureFrame(app, { width = 0, height = 0, time = null, hideHud = true } = {}) {
  const prev = { w: app.cssW, h: app.cssH, dpr: app.dpr };
  const w = width > 0 ? width : prev.w;
  const h = height > 0 ? height : prev.h;

  if (hideHud) document.body.classList.add('shooting');
  try {
    if (width > 0 || height > 0) app.resize(w, h, 1);
    if (time !== null) app.setTime(time);
    app.renderOnce();                       // synchronous draw
    return app.canvas.toDataURL('image/png');   // same task -> buffer still valid
  } finally {
    if (hideHud) document.body.classList.remove('shooting');
    if (width > 0 || height > 0) { app.resize(prev.w, prev.h, prev.dpr); app.renderOnce(); }
  }
}

export function downloadDataUrl(dataUrl, name) {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * window.GARGANTUA -- stable surface for headless automation (Puppeteer,
 * Playwright, CI visual diffs). Also resolves window.__gargantuaReady.
 */
export function installApi(app) {
  const api = {
    version: '1.0.0',
    get ready() { return app.ready; },

    /** Render one frame at (w,h) for time t and return a PNG data URL. */
    renderFrame({ width = 0, height = 0, time = null, view = null, hideHud = true } = {}) {
      if (view !== null) app.setDebug(view);
      return captureFrame(app, { width, height, time, hideHud });
    },

    screenshot(opts = {}) { return app.screenshot(opts); },

    setParam(k, v) { return app.store.set(k, v); },
    setParams(obj) { for (const [k, v] of Object.entries(obj || {})) app.store.set(k, v); },
    getParams() { return { ...app.store.params }; },
    setQuality(q) { app.setQuality(q); },
    /** `instant` skips the 1.5s tween -- automation should not wait it out. */
    setPreset(i, instant = false) { app.setPreset(i, instant); },
    setView(i) { app.setDebug(i); },
    setTime(t) { app.setTime(t); },
    setPaused(p) { app.setPaused(p); },
    setCinematic(on) { app.toggleCinematic(!!on); },
    setHud(on) { app.hud.toggleHud(!!on); },
    resize(w, h, dpr) { app.resize(w, h, dpr); app.renderOnce(); },

    state() {
      return {
        ready: app.ready, quality: app.store.quality, view: app.store.debug,
        cam: { ...app.store.cam }, time: app.time, paused: app.paused,
        cine: app.rig.mode === 'cine', shot: app.rig.shotName,
        fps: app.stats.fps, ms: app.stats.ms,
        size: { css: [app.cssW, app.cssH], internal: [app.renderer.size.rw, app.renderer.size.rh] },
        float: app.renderer.floatOK, frames: app.renderer.frame, errors: app.errors.slice(),
      };
    },

    /** Mean linear luminance of the current canvas -- used by the smoke test. */
    probe(step = 8) {
      const c = document.createElement('canvas');
      const w = Math.max(1, Math.floor(app.canvas.width / step));
      const h = Math.max(1, Math.floor(app.canvas.height / step));
      c.width = w; c.height = h;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(app.canvas, 0, 0, w, h);
      const d = g.getImageData(0, 0, w, h).data;
      let sum = 0, max = 0, nonzero = 0;
      for (let i = 0; i < d.length; i += 4) {
        const L = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
        sum += L; max = Math.max(max, L);
        if (L > 0.02) nonzero++;
      }
      const n = d.length / 4;
      return { mean: sum / n, max, coverage: nonzero / n, w, h };
    },
  };
  window.GARGANTUA = api;
  return api;
}

export { stamp };
