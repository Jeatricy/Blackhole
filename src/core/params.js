// params.js -- the single source of truth for the 21 tunable parameters, the
// three quality tiers, and persistence (localStorage + URL hash).
//
// Everything downstream is generated from PARAMS: the HUD sliders, the help
// text, the uniform upload, the URL codec. Adding a parameter means adding one
// row here plus one uniform in the shader.

export const PARAMS = [
  // ---- relativity ---------------------------------------------------------
  { k: 'diskSpin',   g: 'RELATIVITY', l: 'SPIN SENSE',    min: -1,   max: 1,    s: 2,     d: 1,
    fmt: (v) => (v > 0 ? 'PROGRADE' : 'RETROGRADE'),
    h: '盘面旋转方向；决定哪一侧被 Doppler 增亮' },
  { k: 'doppler',    g: 'RELATIVITY', l: 'DOPPLER BEAM',  min: 0,    max: 1.5,  s: 0.01,  d: 1,
    h: '相对论集束指数 g^(4·k)；0 关闭，1 为物理值' },
  { k: 'redshift',   g: 'RELATIVITY', l: 'REDSHIFT',      min: 0,    max: 2,    s: 0.01,  d: 1,
    h: '色移强度 T_obs = T·g^k；引力红移 + 多普勒色移' },
  { k: 'maxCross',   g: 'RELATIVITY', l: 'IMAGE ORDER',   min: 1,    max: 6,    s: 1,     d: 4,
    fmt: (v) => `n ≤ ${v}`,
    h: '单条测地线最多穿越赤道面的次数；决定次级/高阶透镜像' },
  { k: 'obsBeta',    g: 'RELATIVITY', l: 'OBSERVER β',    min: 0,    max: 0.8,  s: 0.005, d: 0,
    fmt: (v) => `${v.toFixed(3)} c`,
    h: '观察者速度；产生光行差与视场畸变' },

  // ---- accretion disk -----------------------------------------------------
  { k: 'diskInner',  g: 'ACCRETION DISK', l: 'r_in',      min: 3,    max: 14,   s: 0.05,  d: 6,
    fmt: (v) => `${v.toFixed(2)} M`, h: '内边缘；默认 ISCO = 6M，可压到光子球 3M' },
  // Kept well inside the preset orbit radii: once r_out approaches r_obs the
  // disk's near edge is only a few M away, fills the frame and buries the
  // shadow. r_out/r_obs ~ 0.45 is what reads as "black hole with a disk".
  { k: 'diskOuter',  g: 'ACCRETION DISK', l: 'r_out',     min: 8,    max: 60,   s: 0.25,  d: 14,
    fmt: (v) => `${v.toFixed(1)} M`, h: '外边缘' },
  { k: 'thickness',  g: 'ACCRETION DISK', l: 'SCALE H/r',  min: 0.002, max: 0.12, s: 0.001, d: 0.02,
    fmt: (v) => v.toFixed(3), h: '相对标高；影响侧视时的厚度与掠射增亮' },
  { k: 'density',    g: 'ACCRETION DISK', l: 'OPT. DEPTH', min: 0.1,  max: 6,    s: 0.02,  d: 2.2,
    fmt: (v) => `τ ${v.toFixed(2)}`, h: '正视光学厚度；决定盘的不透明度与自遮挡' },
  { k: 'brightness', g: 'ACCRETION DISK', l: 'EMISSION',   min: 0.05, max: 6,    s: 0.01,  d: 0.30,
    h: 'Stefan-Boltzmann 亮度总增益' },
  { k: 'temp',       g: 'ACCRETION DISK', l: 'T_peak',     min: 2200, max: 40000, s: 50,   d: 6200,
    fmt: (v) => `${(v / 1000).toFixed(1)} kK`, h: 'Novikov-Thorne 温度峰值 (49/36 r_in 处)' },
  { k: 'turbulence', g: 'ACCRETION DISK', l: 'TURBULENCE', min: 0,    max: 1.2,  s: 0.01,  d: 0.55,
    h: '湍流对比度' },
  { k: 'noiseScale', g: 'ACCRETION DISK', l: 'GRAIN SCALE', min: 0.3, max: 4,    s: 0.01,  d: 1.25,
    h: '湍流空间频率' },
  { k: 'flowSpeed',  g: 'ACCRETION DISK', l: 'FLOW SPEED', min: 0,    max: 3,    s: 0.01,  d: 1,
    h: '开普勒剪切速率；差动旋转把结构缠成螺旋' },

  // ---- sky ----------------------------------------------------------------
  { k: 'starBright', g: 'SKY',   l: 'STARS',      min: 0,   max: 3,   s: 0.01, d: 1 ,
    h: '程序化星场亮度' },
  { k: 'galaxy',     g: 'SKY',   l: 'MILKY WAY',  min: 0,   max: 3,   s: 0.01, d: 1,
    h: '银河带亮度' },

  // ---- camera / render ----------------------------------------------------
  { k: 'fov',        g: 'CAMERA / RENDER', l: 'FOV',       min: 18,  max: 95,  s: 0.5,  d: 46,
    fmt: (v) => `${v.toFixed(1)}°`, h: '垂直视场角' },
  { k: 'renderScale', g: 'CAMERA / RENDER', l: 'RENDER SCALE', min: 0.4, max: 2, s: 0.05, d: 1,
    fmt: (v) => `${v.toFixed(2)}×`, h: '内部分辨率倍率；>1 为超采样' },

  // ---- post ---------------------------------------------------------------
  { k: 'exposure',   g: 'POST',  l: 'EXPOSURE',   min: 0.05, max: 8,  s: 0.01, d: 1.15,
    fmt: (v) => `${v.toFixed(2)} EV·` , h: 'ACES 之前的线性曝光' },
  { k: 'bloom',      g: 'POST',  l: 'BLOOM',      min: 0,   max: 1.5, s: 0.01, d: 0.34,
    h: 'HDR 泛光强度' },
  { k: 'chroma',     g: 'POST',  l: 'DISPERSION', min: 0,   max: 3,   s: 0.01, d: 0.35,
    h: '横向色散（轻微色差）' },
];

export const QUALITY = {
  standard:  { steps: 192, dphi: 0.055, mips: 4, scale: 0.85, grain: 0.030, vignette: 0.30 },
  high:      { steps: 320, dphi: 0.040, mips: 5, scale: 1.00, grain: 0.024, vignette: 0.32 },
  cinematic: { steps: 512, dphi: 0.028, mips: 6, scale: 1.20, grain: 0.018, vignette: 0.36 },
};
export const QUALITY_ORDER = ['standard', 'high', 'cinematic'];

export const BY_KEY = Object.fromEntries(PARAMS.map((p) => [p.k, p]));
export const GROUPS = [...new Set(PARAMS.map((p) => p.g))];

const LS_KEY = 'gargantua.state.v1';

export function defaults() {
  return Object.fromEntries(PARAMS.map((p) => [p.k, p.d]));
}

export function clampParam(k, v) {
  const p = BY_KEY[k];
  if (!p) return v;
  const n = Number(v);
  if (!Number.isFinite(n)) return p.d;
  const q = Math.round((n - p.min) / p.s) * p.s + p.min;
  return Math.min(p.max, Math.max(p.min, Number(q.toFixed(6))));
}

/** Reactive parameter/session store. Persists to localStorage + URL hash. */
export class Store {
  constructor() {
    this.params = defaults();
    this.quality = 'high';
    this.debug = 0;
    this.cam = { r: 26, theta: 1.30, phi: 0.55 };   // theta from +Y axis
    this.cinematic = false;
    this.autoOrbit = false;
    this.audio = false;
    this._subs = new Set();
  }

  get(k) { return this.params[k]; }

  set(k, v, quiet = false) {
    const c = clampParam(k, v);
    if (this.params[k] === c) return c;
    this.params[k] = c;
    if (!quiet) this.emit({ type: 'param', key: k, value: c });
    return c;
  }

  setQuality(q) {
    if (!QUALITY[q] || q === this.quality) return;
    this.quality = q;
    this.emit({ type: 'quality', value: q });
  }

  setDebug(d) {
    d = Math.max(0, Math.min(9, d | 0));
    if (d === this.debug) return;
    this.debug = d;
    this.emit({ type: 'debug', value: d });
  }

  reset() {
    this.params = defaults();
    this.emit({ type: 'reset' });
  }

  subscribe(fn) { this._subs.add(fn); return () => this._subs.delete(fn); }
  emit(ev) { for (const f of this._subs) { try { f(ev); } catch (e) { console.warn(e); } } }

  tier() { return QUALITY[this.quality]; }

  // ---- serialization ------------------------------------------------------
  /** Only non-default params travel, so shared links stay short and readable. */
  toObject() {
    const p = {};
    for (const d of PARAMS) if (this.params[d.k] !== d.d) p[d.k] = this.params[d.k];
    return {
      v: 1, p, q: this.quality, d: this.debug,
      c: [+this.cam.r.toFixed(3), +this.cam.theta.toFixed(4), +this.cam.phi.toFixed(4)],
      cine: this.cinematic ? 1 : 0, orbit: this.autoOrbit ? 1 : 0, audio: this.audio ? 1 : 0,
    };
  }

  fromObject(o) {
    if (!o || typeof o !== 'object') return false;
    if (o.p && typeof o.p === 'object') {
      for (const [k, v] of Object.entries(o.p)) if (BY_KEY[k]) this.params[k] = clampParam(k, v);
    }
    if (QUALITY[o.q]) this.quality = o.q;
    if (Number.isFinite(o.d)) this.debug = Math.max(0, Math.min(9, o.d | 0));
    if (Array.isArray(o.c) && o.c.length === 3 && o.c.every(Number.isFinite)) {
      this.cam = {
        r: Math.min(400, Math.max(3.2, o.c[0])),
        theta: Math.min(Math.PI - 0.02, Math.max(0.02, o.c[1])),
        phi: o.c[2],
      };
    }
    this.cinematic = !!o.cine; this.autoOrbit = !!o.orbit; this.audio = !!o.audio;
    return true;
  }

  toHash() {
    const o = this.toObject();
    const bits = [`q=${o.q}`, `c=${o.c.join(',')}`];
    if (o.d) bits.push(`d=${o.d}`);
    if (o.cine) bits.push('cine=1');
    if (o.orbit) bits.push('orbit=1');
    const ps = Object.entries(o.p).map(([k, v]) => `${k}=${v}`);
    if (ps.length) bits.push(...ps);
    return bits.join('&');
  }

  fromHash(hash) {
    const s = (hash || '').replace(/^#/, '');
    if (!s) return false;
    const q = new URLSearchParams(s);
    const o = { p: {} };
    for (const [k, v] of q) {
      if (k === 'q') o.q = v;
      else if (k === 'd') o.d = +v;
      else if (k === 'c') o.c = v.split(',').map(Number);
      else if (k === 'cine') o.cine = v === '1';
      else if (k === 'orbit') o.orbit = v === '1';
      else if (BY_KEY[k]) o.p[k] = +v;
    }
    return this.fromObject(o);
  }

  save() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(this.toObject())); return true; }
    catch { return false; }   // private mode / quota: persistence is optional
  }

  load() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      return raw ? this.fromObject(JSON.parse(raw)) : false;
    } catch { return false; }
  }

  static clearStorage() { try { localStorage.removeItem(LS_KEY); } catch { /* ignore */ } }
}
