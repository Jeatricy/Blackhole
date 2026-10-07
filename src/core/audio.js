// audio.js -- optional ambient bed. Fully procedural WebAudio by default, so
// the page has zero required binary assets; if assets/audio/gargantua-drone.wav
// is present it is layered underneath as a pre-rendered pad.
//
// The drone is detuned by the observer's own time dilation, so diving toward the
// horizon audibly drops the pitch. Cheap, and it ties sound to the physics.

const WAV_URL = new URL('../../assets/audio/gargantua-drone.wav', import.meta.url);

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.on = false;
    this.ready = false;
    this.nodes = [];
    this.baseRate = 1;
    this._timer = 0;
  }

  get supported() {
    return typeof (window.AudioContext || window.webkitAudioContext) === 'function';
  }

  /** Must be called from a user gesture (autoplay policy). */
  async enable() {
    if (!this.supported) return false;
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC({ latencyHint: 'playback' });
      this._build();
      this._loadBed().catch(() => { /* the synth alone is fine */ });
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.on = true;
    this.master.gain.cancelScheduledValues(this.ctx.currentTime);
    this.master.gain.setTargetAtTime(0.55, this.ctx.currentTime, 1.6);
    this._schedule();
    return true;
  }

  disable() {
    if (!this.ctx) return;
    this.on = false;
    this.master.gain.setTargetAtTime(0.0, this.ctx.currentTime, 0.7);
    clearTimeout(this._timer);
  }

  async toggle() {
    if (this.on) { this.disable(); return false; }
    return await this.enable();
  }

  // -------------------------------------------------------------------------
  _build() {
    const c = this.ctx;
    this.master = c.createGain();
    this.master.gain.value = 0;

    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -18; comp.knee.value = 22;
    comp.ratio.value = 3.4; comp.attack.value = 0.02; comp.release.value = 0.35;
    this.master.connect(comp).connect(c.destination);

    // --- sub: two detuned sines, an octave apart ----------------------------
    this.subs = [];
    for (const [f, g, det] of [[34.5, 0.42, 0], [51.9, 0.24, 3.5], [69.3, 0.12, -2.5]]) {
      const o = c.createOscillator();
      o.type = 'sine'; o.frequency.value = f; o.detune.value = det;
      const gn = c.createGain(); gn.gain.value = g;
      o.connect(gn).connect(this.master);
      o.start();
      this.subs.push(o);
      this.nodes.push(o, gn);
    }

    // --- pad: filtered saws with a slow LFO on cutoff -----------------------
    const padGain = c.createGain(); padGain.gain.value = 0.10;
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 320; lp.Q.value = 3.2;
    lp.connect(padGain).connect(this.master);
    this.padFilter = lp;
    for (const [f, det] of [[103.8, -6], [155.6, 4], [207.7, 9]]) {
      const o = c.createOscillator();
      o.type = 'sawtooth'; o.frequency.value = f; o.detune.value = det;
      const gn = c.createGain(); gn.gain.value = 0.33;
      o.connect(gn).connect(lp);
      o.start();
      this.subs.push(o);
      this.nodes.push(o, gn);
    }
    const lfo = c.createOscillator();
    lfo.type = 'sine'; lfo.frequency.value = 0.031;
    const lfoAmt = c.createGain(); lfoAmt.gain.value = 190;
    lfo.connect(lfoAmt).connect(lp.frequency);
    lfo.start();
    this.nodes.push(lfo, lfoAmt);

    // --- wash: band-passed noise, 8 s looping buffer ------------------------
    const len = c.sampleRate * 8;
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    let b0 = 0, b1 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;          // two-pole lowpass -> brown-ish
      b0 = 0.997 * b0 + 0.003 * w;
      b1 = 0.985 * b1 + 0.015 * b0;
      d[i] = b1 * 9.0;
    }
    // taper the seam so the loop does not click
    const fade = Math.floor(c.sampleRate * 0.25);
    for (let i = 0; i < fade; i++) {
      const k = i / fade;
      d[i] *= k;
      d[len - 1 - i] *= k;
    }
    const src = c.createBufferSource();
    src.buffer = buf; src.loop = true;
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 420; bp.Q.value = 0.7;
    const ng = c.createGain(); ng.gain.value = 0.30;
    src.connect(bp).connect(ng).connect(this.master);
    src.start();
    this.nodes.push(src, bp, ng);
  }

  /** Sparse bell swells, so the bed never feels static. */
  _schedule() {
    clearTimeout(this._timer);
    if (!this.on || !this.ctx) return;
    const c = this.ctx;
    const t = c.currentTime + 0.1;
    const f = [155.6, 207.7, 233.1, 311.1, 415.3][(Math.random() * 5) | 0];
    const o = c.createOscillator();
    o.type = 'triangle'; o.frequency.value = f;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.085, t + 2.6);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 11.0);
    o.connect(g).connect(this.master);
    o.start(t); o.stop(t + 11.5);
    o.onended = () => { g.disconnect(); };
    this._timer = setTimeout(() => this._schedule(), 7000 + Math.random() * 11000);
  }

  /**
   * Tie pitch to the observer's gravitational time dilation: notes drop as the
   * camera approaches the horizon. `dilation` = dt_inf/dtau >= 1.
   */
  setDilation(dilation) {
    if (!this.ctx || !this.on) return;
    const k = Math.max(0.42, Math.min(1, 1 / Math.max(dilation, 1)));
    const t = this.ctx.currentTime;
    if (Math.abs(k - this.baseRate) < 0.002) return;
    this.baseRate = k;
    for (const o of this.subs) o.detune.setTargetAtTime((k - 1) * 1400, t, 0.5);
    this.padFilter?.frequency.setTargetAtTime(320 * (0.45 + 0.55 * k), t, 0.6);
  }

  /** Optional pre-rendered pad; absence is not an error. */
  async _loadBed() {
    const res = await fetch(WAV_URL, { cache: 'force-cache' });
    if (!res.ok) return;
    const buf = await this.ctx.decodeAudioData(await res.arrayBuffer());
    const src = this.ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    const g = this.ctx.createGain(); g.gain.value = 0.5;
    src.connect(g).connect(this.master);
    src.start();
    this.nodes.push(src, g);
    this.ready = true;
  }
}
