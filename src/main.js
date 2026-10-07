// main.js -- app shell: boot, resize, frame loop, input, adaptive quality,
// context-loss recovery, automation entry points.

import * as THREE from 'three';
import { Store, QUALITY, QUALITY_ORDER, PARAMS } from './core/params.js';
import { loadShaders } from './core/shaders.js';
import { Renderer } from './core/renderer.js';
import { CameraRig, PRESETS } from './core/camera.js';
import { Hud, DEBUG_VIEWS } from './core/hud.js';
import { AudioEngine } from './core/audio.js';
import { parseUrlOptions, captureFrame, downloadDataUrl, installApi, stamp } from './core/capture.js';

const $ = (id) => document.getElementById(id);
const SHADERS = ['fullscreen.vert', 'blackhole.frag', 'bloom.frag', 'composite.frag'];
const isMobile = () => matchMedia('(hover: none) and (pointer: coarse)').matches
  || /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);

class App {
  constructor() {
    this.canvas = $('gl');
    this.store = new Store();
    this.opts = parseUrlOptions();
    this.errors = [];
    this.ready = false;
    this.paused = false;
    this.time = 0;
    this.skyRot = 0;
    this.preset = -1;
    this.cssW = 1; this.cssH = 1; this.dpr = 1;
    this.stats = { fps: 0, ms: 0, ema: 16.7 };
    this.stepBudget = null;
    this._raf = 0;
    this._lost = false;
  }

  // ---- boot ---------------------------------------------------------------
  async boot() {
    this.progress(4, '读取会话状态…');
    // Precedence: defaults < localStorage < URL hash < URL query.
    this.store.load();
    this.store.fromHash(location.hash);
    this.applyUrlOptions();

    this.progress(14, '编译 GLSL 模块…');
    let src;
    try {
      const files = await loadShaders(SHADERS, (n, t) => this.progress(14 + (46 * n) / t, `着色器 ${n}/${t}`));
      src = {
        vert: files['fullscreen.vert'], bh: files['blackhole.frag'],
        bloom: files['bloom.frag'], comp: files['composite.frag'],
      };
    } catch (e) { this.fatal(e); return; }

    this.progress(66, '创建 WebGL2 上下文…');
    try {
      this.renderer = new Renderer(this.canvas, src, {
        quality: this.store.quality,
        preserveDrawingBuffer: this.opts.preserve,
      });
    } catch (e) { this.fatal(e); return; }

    this.progress(78, '构建观察者参考系…');
    this.rig = new CameraRig(this.canvas, this.store);
    this.audio = new AudioEngine();
    this.hud = new Hud(this.store, this);

    if (this.opts.preset) {
      const i = PRESETS.findIndex((p) => p.name.toLowerCase().startsWith(String(this.opts.preset).toLowerCase()));
      if (i >= 0) { this.rig.setPreset(i, true); this.preset = i; }
    }
    this.rig.autoOrbit = this.store.autoOrbit;
    if (this.store.cinematic) this.rig.setCinematic(true);
    if (this.opts.time !== null) this.time = this.opts.time;
    this.paused = !!this.opts.paused;
    if (!this.opts.hud) this.hud.toggleHud(false);
    if (isMobile()) this.hud.togglePanel(false);

    this.progress(88, '首帧积分零测地线…');
    this.installEvents();
    this.resize();
    this.renderer.setQuality(this.store.quality);

    try { this.renderOnce(); } catch (e) { this.fatal(e); return; }

    installApi(this);
    this.ready = true;
    this.progress(100, '就绪');
    setTimeout(() => $('boot').classList.add('hidden'), 260);
    if (this.audio.supported && !this.store.audio) $('tapaudio').classList.remove('hidden');
    if (this.store.audio || this.opts.audio) this.toggleAudio(true);

    this.hud.syncToggles({ cine: this.rig.mode === 'cine', orbit: this.rig.autoOrbit, audio: false, preset: this.preset });
    this.last = performance.now();
    this.loop();
    window.__gargantuaReady?.resolve?.(window.GARGANTUA);
  }

  applyUrlOptions() {
    const o = this.opts;
    if (o.quality && QUALITY[o.quality]) this.store.quality = o.quality;
    if (o.debug !== null) this.store.debug = Math.max(0, Math.min(9, o.debug | 0));
    if (o.cine) this.store.cinematic = true;
    if (o.orbit) this.store.autoOrbit = true;
    for (const [k, v] of Object.entries(o.params)) this.store.set(k, v, true);
  }

  progress(pct, msg) {
    const bar = $('boot-bar'), m = $('boot-msg');
    if (bar) bar.style.width = `${Math.min(100, pct)}%`;
    if (m && msg) m.textContent = msg;
  }

  fatal(err) {
    console.error('[GARGANTUA]', err);
    this.errors.push(String(err?.message || err));
    $('boot').classList.add('hidden');
    $('fatal-msg').textContent = String(err?.message || err);
    $('fatal').classList.remove('hidden');
    window.__gargantuaReady?.reject?.(err);
  }

  // ---- sizing -------------------------------------------------------------
  resize(cssW, cssH, dprOverride) {
    const w = cssW || Math.max(1, window.innerWidth);
    const h = cssH || Math.max(1, window.innerHeight);
    // Retina is welcome but unbounded DPR on a per-pixel RK4 integrator is not.
    const cap = isMobile() ? 2.0 : 2.5;
    const dpr = dprOverride ?? (this.opts.dpr > 0 ? this.opts.dpr
      : Math.min(window.devicePixelRatio || 1, cap));
    this.cssW = w; this.cssH = h; this.dpr = dpr;

    const scale = this.store.get('renderScale') * this.store.tier().scale;
    const s = this.renderer.setSize(w, h, dpr, scale);
    this.rig.cam.aspect = s.rw / s.rh;
    this.rig.cam.updateProjectionMatrix();
    return s;
  }

  // ---- frame loop ---------------------------------------------------------
  loop() {
    this._raf = requestAnimationFrame(() => this.loop());
    if (this._lost) return;

    const now = performance.now();
    let dt = (now - this.last) / 1000;
    this.last = now;
    dt = Math.min(Math.max(dt, 0), 0.1);      // tab-switch guard

    if (!this.paused) {
      this.time += dt;
      this.skyRot += dt * 0.0016;
    }

    const moved = this.rig.update(this.paused ? 0 : dt);
    this.adaptQuality();

    // Nothing changes when paused and still: skip the GPU work entirely.
    const needs = !this.paused || moved || this._dirty;
    this._dirty = false;
    if (needs) {
      const t0 = performance.now();
      try { this.draw(); } catch (e) { this.onDrawError(e); return; }
      const t1 = performance.now();
      this.stats.ms = t1 - t0;
      this.stats.ema = this.stats.ema * 0.9 + (t1 - t0) * 0.1;
    }
    this.stats.fps = this.stats.fps * 0.88 + (1 / Math.max(dt, 1e-4)) * 0.12;

    this.hud.update(this.frameState());
    this.audio.setDilation(this.rig.readout().dilation);
    this.saveSoon();
  }

  frameState() {
    const s = this.renderer.size;
    return {
      cam: this.rig.readout(), fps: this.stats.fps, ms: this.stats.ms,
      rw: s.rw, rh: s.rh, dpr: this.dpr,
      steps: this.effectiveSteps(), paused: this.paused,
      cine: this.rig.mode === 'cine', shot: this.rig.shotName, orbit: this.rig.autoOrbit,
    };
  }

  effectiveSteps() {
    const max = this.store.tier().steps;
    return Math.max(48, Math.min(max, Math.round(this.stepBudget ?? max)));
  }

  /**
   * Adaptive step budget. The integrator dominates frame cost, so trading step
   * count is the honest knob: the image degrades at the shadow edge first,
   * which is exactly where it is least noticeable in motion.
   */
  adaptQuality() {
    const max = this.store.tier().steps;
    if (this.stepBudget === null) this.stepBudget = max;
    const ms = this.stats.ema;
    if (ms > 30) this.stepBudget = Math.max(max * 0.4, this.stepBudget * 0.94);
    else if (ms < 15) this.stepBudget = Math.min(max, this.stepBudget * 1.03 + 1);
    if (this.paused) this.stepBudget = max;    // stills always get full quality
  }

  draw() {
    this.renderer.render({
      params: this.store.params,
      camPos: this.rig.cam.position,
      camRight: this.rig.right, camUp: this.rig.up, camFwd: this.rig.fwd,
      betaDir: this.rig.betaDir,
      time: this.time, skyRot: this.skyRot,
      debug: this.store.debug, steps: this.effectiveSteps(),
    });
  }

  renderOnce() { this.rig.update(0); this.draw(); }

  onDrawError(e) {
    console.error('[GARGANTUA] draw failed', e);
    this.errors.push(String(e?.message || e));
    cancelAnimationFrame(this._raf);
    // Step down before giving up: most draw failures here are resource limits.
    if (this.store.quality !== 'standard') {
      this.hud.toast('渲染异常，降级到 STANDARD');
      this.setQuality('standard');
      this.last = performance.now();
      this.loop();
    } else {
      this.fatal(e);
    }
  }

  // ---- events -------------------------------------------------------------
  installEvents() {
    let rt = 0;
    const onResize = () => {
      clearTimeout(rt);
      rt = setTimeout(() => { this.resize(); this._dirty = true; }, 90);
    };
    addEventListener('resize', onResize, { passive: true });
    addEventListener('orientationchange', onResize, { passive: true });

    // WebGL context loss: recoverable, and common on mobile after backgrounding.
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();                     // required for restore to fire
      this._lost = true;
      this.errors.push('webglcontextlost');
      $('boot-msg').textContent = 'GPU 上下文丢失，等待恢复…';
      $('boot').classList.remove('hidden');
      this.progress(40);
    }, false);

    this.canvas.addEventListener('webglcontextrestored', () => {
      try {
        // three re-uploads programs and textures; render targets need rebuilding
        // because their GPU-side storage went away with the context.
        this.renderer._resizeTargets();
        this.resize();
        this.renderOnce();
        this._lost = false;
        $('boot').classList.add('hidden');
        this.hud.toast('GPU 上下文已恢复');
        this.last = performance.now();
      } catch (e) { this.fatal(e); }
    }, false);

    this.store.subscribe((ev) => {
      this._dirty = true;
      if (ev.type === 'param' && (ev.key === 'renderScale')) this.resize();
      if (ev.type === 'quality') { this.renderer.setQuality(ev.value); this.resize(); this.stepBudget = null; }
      if (ev.type === 'reset') this.resize();
      this.saveSoon();
    });

    const tap = $('tapaudio');
    const arm = () => { this.toggleAudio(true); tap.classList.add('hidden'); };
    tap.addEventListener('click', arm);
    tap.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') arm(); });

    // A pasted link into a running instance only changes the fragment, so the
    // document never reloads. Apply it live -- shareable links are pointless if
    // they need a manual refresh. (copyLink uses replaceState, which is silent.)
    addEventListener('hashchange', () => {
      if (!location.hash || location.hash === `#${this._lastHash}`) return;
      if (!this.store.fromHash(location.hash)) return;
      this.renderer.setQuality(this.store.quality);
      this.rig.sph = { ...this.store.cam };
      this.rig._syncControls();
      this.resize();
      for (const k of this.hud.sliders.keys()) this.hud.syncSlider(k);
      this.hud.syncQuality();
      this.hud.syncDebug();
      this._dirty = true;
      this.hud.toast('已从链接载入状态');
    });

    addEventListener('keydown', (e) => this.onKey(e));
    // Any manual interaction leaves cinematic mode: the user is in charge.
    this.canvas.addEventListener('pointerdown', () => {
      if (this.rig.mode === 'cine') this.toggleCinematic(false);
    });
    this.canvas.addEventListener('wheel', () => {
      if (this.rig.mode === 'cine') this.toggleCinematic(false);
    }, { passive: true });
  }

  onKey(e) {
    const t = e.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key;

    // digits: 0-9 debug views, Shift+1..4 presets
    const digit = /^Digit([0-9])$/.exec(e.code) || /^Numpad([0-9])$/.exec(e.code);
    if (digit) {
      const n = +digit[1];
      if (e.shiftKey) { if (n >= 1 && n <= PRESETS.length) { this.setPreset(n - 1); e.preventDefault(); } }
      else { this.setDebug(n); e.preventDefault(); }
      return;
    }

    switch (k.toLowerCase()) {
      case 'h': this.hud.toggleHud(); break;
      case 'tab': this.hud.togglePanel(); e.preventDefault(); break;
      case '?': case '/': this.hud.toggleHelp(); e.preventDefault(); break;
      case 'escape': this.hud.toggleHelp(false); break;
      case 'p': case ' ': this.setPaused(!this.paused); e.preventDefault(); break;
      case 'c': this.toggleCinematic(); break;
      case 'o': this.toggleAutoOrbit(); break;
      case 'm': this.toggleAudio(); break;
      case 'r': this.resetParams(); break;
      case 's': this.screenshot(); break;
      case 'l': this.copyLink(); break;
      case 'f': this.toggleFullscreen(); break;
      case 'q': {
        const i = QUALITY_ORDER.indexOf(this.store.quality);
        this.setQuality(QUALITY_ORDER[(i + 1) % QUALITY_ORDER.length]);
        break;
      }
      case 'g': this.setDebug(this.store.debug === 8 ? 0 : 8); break;
      case '[': this.nudge('exposure', -0.06); break;
      case ']': this.nudge('exposure', 0.06); break;
      case '-': this.nudge('fov', 1.5); break;
      case '=': case '+': this.nudge('fov', -1.5); break;
      case ',': this.setTime(this.time - 1.0); break;
      case '.': this.setTime(this.time + 1.0); break;
      case 'arrowup': this.orbitBy(0, -0.035); e.preventDefault(); break;
      case 'arrowdown': this.orbitBy(0, 0.035); e.preventDefault(); break;
      case 'arrowleft': this.orbitBy(-0.045, 0); e.preventDefault(); break;
      case 'arrowright': this.orbitBy(0.045, 0); e.preventDefault(); break;
      default: return;
    }
  }

  orbitBy(dphi, dtheta) {
    if (this.rig.mode === 'cine') this.toggleCinematic(false);
    const s = this.rig.sph;
    s.phi += dphi;
    s.theta = THREE.MathUtils.clamp(s.theta + dtheta, 0.035, Math.PI - 0.035);
    this.rig._syncControls();
    this._dirty = true;
  }

  nudge(k, d) {
    const v = this.store.set(k, this.store.get(k) + d);
    const p = PARAMS.find((x) => x.k === k);
    this.hud.toast(`${p.l} ${p.fmt ? p.fmt(v) : v.toFixed(2)}`);
  }

  // ---- actions ------------------------------------------------------------
  setQuality(q) {
    this.store.setQuality(q);
    this.hud.toast(`QUALITY · ${q.toUpperCase()} · ${QUALITY[q].steps} steps`);
  }

  setPreset(i, instant = false) {
    const p = this.rig.setPreset(i, instant);
    this.preset = i;
    this.hud.syncToggles({ cine: this.rig.mode === 'cine', orbit: this.rig.autoOrbit, audio: this.audio.on, preset: i });
    this.hud.toast(`${p.name} — ${p.note}`);
    this._dirty = true;
  }

  setDebug(d) {
    this.store.setDebug(d);
    this.hud.toast(`VIEW ${this.store.debug} · ${DEBUG_VIEWS[this.store.debug]}`);
    this._dirty = true;
  }

  setPaused(p) {
    this.paused = !!p;
    this._dirty = true;
    this.hud.toast(this.paused ? '时间演化已暂停' : '时间演化继续');
  }

  setTime(t) {
    this.time = Math.max(0, t);
    this._dirty = true;
  }

  toggleCinematic(force) {
    const on = force === undefined ? this.rig.mode !== 'cine' : !!force;
    this.rig.setCinematic(on);
    this.store.cinematic = on;
    if (on) this.rig.autoOrbit = false;
    this.hud.syncToggles({ cine: on, orbit: this.rig.autoOrbit, audio: this.audio.on, preset: this.preset });
    if (force === undefined) this.hud.toast(on ? `电影镜头循环 · ${this.rig.shotName}` : '自由轨道');
    this._dirty = true;
  }

  toggleAutoOrbit(force) {
    const on = force === undefined ? !this.rig.autoOrbit : !!force;
    this.rig.autoOrbit = on;
    this.store.autoOrbit = on;
    if (on && this.rig.mode === 'cine') this.toggleCinematic(false);
    this.hud.syncToggles({ cine: this.rig.mode === 'cine', orbit: on, audio: this.audio.on, preset: this.preset });
    this._dirty = true;
  }

  async toggleAudio(force) {
    if (!this.audio.supported) { this.hud.toast('此浏览器不支持 WebAudio'); return; }
    const want = force === undefined ? !this.audio.on : !!force;
    const on = want ? await this.audio.enable() : (this.audio.disable(), false);
    this.store.audio = on;
    $('tapaudio').classList.add('hidden');
    this.hud.syncToggles({ cine: this.rig.mode === 'cine', orbit: this.rig.autoOrbit, audio: on, preset: this.preset });
    if (force === undefined) this.hud.toast(on ? '氛围音乐开启' : '氛围音乐关闭');
  }

  screenshot(opts = {}) {
    try {
      const url = captureFrame(this, opts);
      if (opts.noDownload) return url;
      downloadDataUrl(url, `gargantua-${stamp()}.png`);
      this.hud.toast('截图已保存');
      return url;
    } catch (e) {
      console.warn(e);
      this.hud.toast('截图失败');
      return null;
    }
  }

  async copyLink() {
    const h = this.store.toHash();
    const url = `${location.origin}${location.pathname}#${h}`;
    this._lastHash = h;                 // so our own write is not re-applied
    history.replaceState(null, '', `#${h}`);
    try {
      await navigator.clipboard.writeText(url);
      this.hud.toast('链接已复制到剪贴板');
    } catch {
      this.hud.toast('链接已写入地址栏');
    }
    return url;
  }

  resetParams() {
    this.store.reset();
    this.hud.toast('参数已重置为默认值');
  }

  toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else document.documentElement.requestFullscreen?.().catch(() => {
      this.hud.toast('全屏被浏览器拒绝');
    });
  }

  saveSoon() {
    clearTimeout(this._saveT);
    this._saveT = setTimeout(() => this.store.save(), 700);
  }
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------
{
  let res, rej;
  const p = new Promise((a, b) => { res = a; rej = b; });
  p.resolve = res; p.reject = rej;
  window.__gargantuaReady = p;
}

const app = new App();
window.__gargantuaApp = app;

addEventListener('error', (e) => {
  app.errors.push(String(e.message || e.error));
  if (!app.ready) app.fatal(e.error || new Error(e.message));
});
addEventListener('unhandledrejection', (e) => {
  app.errors.push(String(e.reason?.message || e.reason));
  if (!app.ready) app.fatal(e.reason instanceof Error ? e.reason : new Error(String(e.reason)));
});

$('fatal-retry').addEventListener('click', () => location.reload());

app.boot().catch((e) => app.fatal(e));
