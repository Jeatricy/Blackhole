// hud.js -- readout, generated parameter panel, status strip, help overlay.
// Everything is built from the PARAMS table so the UI cannot drift from the
// shader's actual inputs.

import { PARAMS, GROUPS } from './params.js';
import { R_HORIZON, R_PHOTON, R_ISCO, PRESETS } from './camera.js';

export const DEBUG_VIEWS = [
  'FINAL COMPOSITE', 'BEAUTY (NO BLOOM)', 'BLOOM ONLY', 'LUMINANCE / EXPOSURE',
  'INTEGRATION COST', 'DISK CROSSINGS (n)', 'REDSHIFT g', 'IMPACT PARAMETER b',
  'LENSED SKY + GRID', 'DISK RADIAL GRID',
];

const KEYS = [
  ['DISPLAY', [
    ['H', '显示/隐藏 HUD'], ['Tab', '折叠参数面板'], ['?', '本帮助'],
    ['F', '全屏'], ['Q', '切换质量档 (STD/HIGH/CINE)'], ['S', '截图 PNG'],
    ['L', '复制带状态的链接'], ['R', '重置全部参数'],
  ]],
  ['CAMERA', [
    ['拖拽 / 单指', '轨道旋转'], ['滚轮 / 双指', '推拉距离'],
    ['C', '电影镜头循环'], ['O', '自动环绕'],
    ['Shift+1…4', `视角预设 (${PRESETS.map((p) => p.name).join(' / ')})`],
    ['↑ ↓', '升降倾角'], ['← →', '方位角'], ['- / =', '视场角'],
  ]],
  ['SIMULATION', [
    ['P / Space', '暂停时间演化'], [', / .', '时间倒退 / 前进'],
    ['[ / ]', '曝光 -/+'], ['M', '氛围音乐'],
  ]],
  ['DEBUG VIEWS', DEBUG_VIEWS.map((n, i) => [String(i), n])],
];

// Novikov-Thorne profile, mirrored from the shader so the readout cannot lie.
export function diskTempAt(r, rin, tpeak) {
  if (!(r > rin)) return 0;
  const shape = Math.pow(r, -0.75) * Math.pow(Math.max(1 - Math.sqrt(rin / r), 0), 0.25);
  const rp = (49 / 36) * rin;
  const shapeP = Math.pow(rp, -0.75) * Math.pow(1 / 7, 0.25);
  return (tpeak * shape) / Math.max(shapeP, 1e-9);
}

const $ = (id) => document.getElementById(id);
const fmtT = (k) => (k >= 1000 ? `${(k / 1000).toFixed(1)} kK` : `${Math.round(k)} K`);

// Readout rows: [id, label, cssClass, mobileHide]
const ROWS = [
  ['sep0', 'OBSERVER', 'sec'],
  ['r', 'r_obs', 'cold'], ['inc', 'INCLINATION', ''],
  ['dil', 'TIME DILATION', 'hot'], ['esc', 'v_esc', '', true],
  ['per', 'ORBITAL PERIOD', '', true],
  ['sep1', 'GEOMETRY', 'sec'],
  ['rh', 'HORIZON r_s', ''], ['rph', 'PHOTON SPHERE', ''],
  ['risco', 'ISCO', '', true], ['bc', 'CRITICAL b_c', 'hot'],
  ['sep2', 'DISK', 'sec'],
  ['tin', 'T @ r_in', 'hot'], ['tout', 'T @ r_out', '', true],
  ['om', 'Ω @ r_in', '', true],
  ['sep3', 'RENDER', 'sec'],
  ['fps', 'FRAME', ''], ['res', 'INTERNAL', ''], ['steps', 'RK4 BUDGET', '', true],
];

export class Hud {
  constructor(store, app) {
    this.store = store;
    this.app = app;
    this.ro = {};
    this.sliders = new Map();

    this._buildReadout();
    this._buildParams();
    this._buildHelp();

    $('panel-toggle').addEventListener('click', () => this.togglePanel());
    $('help-close').addEventListener('click', () => this.toggleHelp(false));
    $('help').addEventListener('click', (e) => { if (e.target.id === 'help') this.toggleHelp(false); });

    for (const b of $('q-btns').children) b.addEventListener('click', () => app.setQuality(b.dataset.q));
    for (const b of $('p-btns').children) b.addEventListener('click', () => app.setPreset(+b.dataset.p));
    $('btn-cine').addEventListener('click', () => app.toggleCinematic());
    $('btn-orbit').addEventListener('click', () => app.toggleAutoOrbit());
    $('btn-audio').addEventListener('click', () => app.toggleAudio());
    $('btn-shot').addEventListener('click', () => app.screenshot());
    $('btn-link').addEventListener('click', () => app.copyLink());
    $('btn-reset').addEventListener('click', () => app.resetParams());

    store.subscribe((ev) => {
      if (ev.type === 'param') this.syncSlider(ev.key);
      else if (ev.type === 'reset') for (const k of this.sliders.keys()) this.syncSlider(k);
      else if (ev.type === 'quality') this.syncQuality();
      else if (ev.type === 'debug') this.syncDebug();
    });
    this.syncQuality();
    this.syncDebug();
  }

  _buildReadout() {
    const g = $('ro-grid');
    const frag = document.createDocumentFragment();
    for (const [id, label, cls, mHide] of ROWS) {
      if (cls === 'sec') {
        const hr = document.createElement('div');
        hr.className = 'hr';
        frag.appendChild(hr);
        continue;
      }
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      if (cls) dd.className = cls;
      dd.textContent = '—';
      if (mHide) { dt.classList.add('m-hide'); dd.classList.add('m-hide'); }
      frag.append(dt, dd);
      this.ro[id] = dd;
    }
    g.appendChild(frag);
  }

  _buildParams() {
    const host = $('panel-params');
    const frag = document.createDocumentFragment();
    for (const grp of GROUPS) {
      const h = document.createElement('div');
      h.className = 'grp';
      h.textContent = grp;
      frag.appendChild(h);
      for (const p of PARAMS.filter((x) => x.g === grp)) frag.appendChild(this._slider(p));
    }
    host.appendChild(frag);
  }

  _slider(p) {
    const wrap = document.createElement('div');
    wrap.className = 'p';
    wrap.dataset.k = p.k;

    const top = document.createElement('div');
    top.className = 'p-top';
    const lab = document.createElement('label');
    lab.textContent = p.l;
    lab.title = `${p.h}\n(在标签上上下拖动可微调)`;
    lab.htmlFor = `sl-${p.k}`;
    const out = document.createElement('output');
    out.htmlFor = `sl-${p.k}`;
    top.append(lab, out);

    const inp = document.createElement('input');
    inp.type = 'range';
    inp.id = `sl-${p.k}`;
    inp.min = p.min; inp.max = p.max; inp.step = p.s;
    inp.value = this.store.get(p.k);
    inp.setAttribute('aria-label', `${p.l} — ${p.h}`);
    inp.addEventListener('input', () => this.store.set(p.k, +inp.value));

    // Drag the label vertically for fine control: sliders are coarse for things
    // like r_in where 0.05 M matters.
    lab.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      lab.setPointerCapture(e.pointerId);
      const y0 = e.clientY, v0 = this.store.get(p.k);
      const span = (p.max - p.min) / 260;
      const move = (m) => this.store.set(p.k, v0 + (y0 - m.clientY) * span);
      const up = () => {
        lab.removeEventListener('pointermove', move);
        lab.removeEventListener('pointerup', up);
        lab.removeEventListener('pointercancel', up);
      };
      lab.addEventListener('pointermove', move);
      lab.addEventListener('pointerup', up);
      lab.addEventListener('pointercancel', up);
    });

    wrap.append(top, inp);
    this.sliders.set(p.k, { wrap, inp, out, p });
    this.syncSlider(p.k);
    return wrap;
  }

  syncSlider(k) {
    const s = this.sliders.get(k);
    if (!s) return;
    const v = this.store.get(k);
    if (+s.inp.value !== v) s.inp.value = v;
    s.out.textContent = s.p.fmt ? s.p.fmt(v) : (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2));
    s.wrap.classList.toggle('mod', v !== s.p.d);
  }

  syncQuality() {
    for (const b of $('q-btns').children) b.classList.toggle('on', b.dataset.q === this.store.quality);
  }

  syncDebug() {
    const d = this.store.debug;
    $('st-view').textContent = `VIEW ${d} · ${DEBUG_VIEWS[d]}`;
  }

  syncToggles({ cine, orbit, audio, preset }) {
    $('btn-cine').classList.toggle('on', !!cine);
    $('btn-orbit').classList.toggle('on', !!orbit);
    $('btn-audio').classList.toggle('on', !!audio);
    for (const b of $('p-btns').children) b.classList.toggle('on', +b.dataset.p === preset);
  }

  _buildHelp() {
    const g = $('help-grid');
    const frag = document.createDocumentFragment();
    for (const [sec, rows] of KEYS) {
      const h = document.createElement('div');
      h.className = 'hsec';
      h.textContent = sec;
      frag.appendChild(h);
      for (const [k, d] of rows) {
        const row = document.createElement('div');
        row.className = 'hk';
        const b = document.createElement('b');
        b.textContent = k;
        const s = document.createElement('span');
        s.textContent = d;
        row.append(b, s);
        frag.appendChild(row);
      }
    }
    g.appendChild(frag);
  }

  /** Per-frame readout refresh. `st` comes from the app loop. */
  update(st) {
    const p = this.store.params;
    const r = st.cam.r;
    const set = (id, v, cls) => {
      const el = this.ro[id];
      if (!el) return;
      if (el.textContent !== v) el.textContent = v;
      if (cls !== undefined) el.className = cls;
    };

    set('r', `${r.toFixed(2)} M`);
    set('inc', `${st.cam.inclination >= 0 ? '+' : ''}${st.cam.inclination.toFixed(1)}°`);
    set('dil', `× ${st.cam.dilation.toFixed(4)}`);
    set('esc', `${st.cam.escapeBeta.toFixed(3)} c`);
    set('per', `${st.cam.orbitPeriod.toFixed(0)} M`);

    set('rh', `${R_HORIZON.toFixed(2)} M`);
    set('rph', `${R_PHOTON.toFixed(2)} M`);
    set('risco', `${R_ISCO.toFixed(2)} M`);
    set('bc', `${(3 * Math.sqrt(3)).toFixed(3)} M`);

    const rin = p.diskInner, rout = Math.max(p.diskOuter, rin * 1.15);
    set('tin', fmtT(diskTempAt((49 / 36) * rin, rin, p.temp)));
    set('tout', fmtT(diskTempAt(rout, rin, p.temp)));
    set('om', `${(Math.pow(rin, -1.5)).toFixed(4)} /M`);

    set('fps', `${st.fps.toFixed(0)} fps · ${st.ms.toFixed(1)} ms`,
      st.fps >= 50 ? 'cold' : st.fps >= 26 ? '' : 'hot');
    set('res', `${st.rw}×${st.rh}`);
    set('steps', `${st.steps} × RK4`);

    $('st-perf').textContent = `${st.fps.toFixed(0)} fps`;
    $('st-res').textContent = `${st.rw}×${st.rh} @ ${st.dpr.toFixed(2)}dpr`;
    const mode = st.cine ? `CINEMA · ${st.shot}` : st.orbit ? 'AUTO-ORBIT' : 'FREE ORBIT';
    const label = st.paused ? `${mode} · PAUSED` : mode;
    if ($('st-mode').textContent !== label) $('st-mode').textContent = label;
  }

  togglePanel(force) {
    const off = force === undefined ? !document.body.classList.contains('panel-closed') : !force;
    document.body.classList.toggle('panel-closed', off);
    const b = $('panel-toggle');
    b.textContent = off ? '▸' : '▾';
    b.setAttribute('aria-expanded', String(!off));
  }

  toggleHud(force) {
    const off = force === undefined ? !document.body.classList.contains('hud-off') : !force;
    document.body.classList.toggle('hud-off', off);
  }

  toggleHelp(force) {
    const el = $('help');
    const show = force === undefined ? el.classList.contains('hidden') : force;
    el.classList.toggle('hidden', !show);
    if (show) $('help-close').focus();
  }

  toast(msg) {
    const host = $('toasts');
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    host.appendChild(t);
    setTimeout(() => t.remove(), 2500);
    while (host.children.length > 4) host.firstChild.remove();
  }
}
