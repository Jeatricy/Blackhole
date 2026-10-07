// camera.js -- observer rig. Spherical coordinates (r, theta, phi) with theta
// measured from the disk normal (+Y), so theta -> pi/2 is edge-on and theta -> 0
// is a polar view. Feeds the shader an orthonormal tetrad (right, up, forward)
// plus the position; the shader converts that to Schwarzschild components.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export const R_HORIZON = 2, R_PHOTON = 3, R_ISCO = 6;
const R_MIN = 3.15;              // just outside the photon sphere
const R_MAX = 360;
const DEG = Math.PI / 180;

/** Four viewpoint presets. */
export const PRESETS = [
  { name: 'ICONIC',  r: 26,  theta: 78 * DEG, phi:  0.55, fov: 46,
    note: '低倾角经典构图：透镜化的上下弧与前景盘合成完整光环' },
  { name: 'EDGE-ON', r: 19,  theta: 88.4 * DEG, phi: -1.15, fov: 40,
    note: '近乎共面：盘塌成亮线，次级像在视界两侧拱起' },
  { name: 'POLAR',   r: 34,  theta: 21 * DEG, phi:  2.30, fov: 52,
    note: '极轴俯视：可见开普勒剪切与差动旋转的螺旋结构' },
  { name: 'PLUNGE',  r: 5.4, theta: 82 * DEG, phi:  0.15, fov: 78,
    note: '贴近光子球：极端引力透镜与强烈时间膨胀' },
];

/**
 * Cinematic loop. Each shot lerps (r, theta, phi, fov) with its own easing;
 * total ~64 s, then wraps. Shots are authored to walk through the physics:
 * reveal, plane crossing, edge-on, close approach, pull-back, polar.
 */
const EASE = {
  linear: (t) => t,
  smooth: (t) => t * t * (3 - 2 * t),
  inOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  out: (t) => 1 - Math.pow(1 - t, 3),
  in: (t) => t * t * t,
};

export const SHOTS = [
  { name: 'REVEAL',        d: 13, e: 'out',
    a: { r: 132, theta: 62 * DEG, phi: -0.35, fov: 30 },
    b: { r: 40,  theta: 71 * DEG, phi:  0.55, fov: 42 } },
  { name: 'PLANE CROSSING', d: 11, e: 'inOut',
    a: { r: 40,  theta: 71 * DEG, phi:  0.55, fov: 42 },
    b: { r: 27,  theta: 96 * DEG, phi:  1.62, fov: 48 } },
  { name: 'EDGE-ON PASS',  d: 10, e: 'smooth',
    a: { r: 27,  theta: 96 * DEG, phi:  1.62, fov: 48 },
    b: { r: 17,  theta: 89.5 * DEG, phi: 2.70, fov: 44 } },
  { name: 'CLOSE APPROACH', d: 12, e: 'inOut',
    a: { r: 17,  theta: 89.5 * DEG, phi: 2.70, fov: 44 },
    b: { r: 5.0, theta: 83 * DEG, phi:  3.85, fov: 82 } },
  { name: 'PULL BACK',     d: 10, e: 'out',
    a: { r: 5.0, theta: 83 * DEG, phi:  3.85, fov: 82 },
    b: { r: 30,  theta: 77 * DEG, phi:  4.90, fov: 46 } },
  { name: 'POLAR ASCENT',  d: 12, e: 'inOut',
    a: { r: 30,  theta: 77 * DEG, phi:  4.90, fov: 46 },
    b: { r: 132, theta: 62 * DEG, phi:  5.93, fov: 30 } },
];
export const CINE_TOTAL = SHOTS.reduce((s, x) => s + x.d, 0);

const AXIS = new THREE.Vector3(0, 1, 0);

export class CameraRig {
  constructor(canvas, store) {
    this.store = store;
    this.cam = new THREE.PerspectiveCamera(store.get('fov'), 1, 0.01, 1e6);
    this.target = new THREE.Vector3(0, 0, 0);

    this.sph = { r: store.cam.r, theta: store.cam.theta, phi: store.cam.phi };
    this._writeCamera();

    this.controls = new OrbitControls(this.cam, canvas);
    this.controls.target.copy(this.target);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.075;
    this.controls.enablePan = false;              // the hole stays centred
    this.controls.minDistance = R_MIN;
    this.controls.maxDistance = R_MAX;
    this.controls.rotateSpeed = 0.62;
    this.controls.zoomSpeed = 0.72;
    // Never look exactly down the pole: theta = 0 is a coordinate singularity
    // for the in-plane geodesic frame.
    this.controls.minPolarAngle = 0.035;
    this.controls.maxPolarAngle = Math.PI - 0.035;
    this.controls.update();

    this.mode = 'free';        // 'free' | 'cine'
    this.cineT = 0;
    this.shotName = SHOTS[0].name;
    this.autoOrbit = false;
    this.tween = null;

    // shader tetrad
    this.right = new THREE.Vector3();
    this.up = new THREE.Vector3();
    this.fwd = new THREE.Vector3();
    this.betaDir = new THREE.Vector3(1, 0, 0);

    this._userMoved = false;
    for (const ev of ['start']) this.controls.addEventListener(ev, () => { this._userMoved = true; });
  }

  _writeCamera() {
    const { r, theta, phi } = this.sph;
    const st = Math.sin(theta);
    this.cam.position.set(r * st * Math.cos(phi), r * Math.cos(theta), r * st * Math.sin(phi));
  }

  _readCamera() {
    const p = this.cam.position;
    const r = Math.max(p.length(), R_MIN);
    this.sph.r = r;
    this.sph.theta = Math.acos(THREE.MathUtils.clamp(p.y / r, -1, 1));
    this.sph.phi = Math.atan2(p.z, p.x);
  }

  setPreset(i, instant = false) {
    const p = PRESETS[((i | 0) % PRESETS.length + PRESETS.length) % PRESETS.length];
    this.mode = 'free';
    const from = { ...this.sph, fov: this.store.get('fov') };
    // take the short way round in azimuth
    let dphi = p.phi - from.phi;
    while (dphi > Math.PI) dphi -= 2 * Math.PI;
    while (dphi < -Math.PI) dphi += 2 * Math.PI;
    const to = { r: p.r, theta: p.theta, phi: from.phi + dphi, fov: p.fov };
    if (instant) {
      this.sph = { r: to.r, theta: to.theta, phi: to.phi };
      this.store.set('fov', to.fov);
      this.tween = null;
      this._writeCamera();
      this._syncControls();
    } else {
      this.tween = { from, to, t: 0, d: 1.5 };
    }
    return p;
  }

  setCinematic(on) {
    this.mode = on ? 'cine' : 'free';
    this.tween = null;
    if (!on) this._syncControls();
  }

  _syncControls() {
    this._writeCamera();
    this.cam.lookAt(this.target);
    this.controls.target.copy(this.target);
    this.controls.update();
  }

  /** @returns {boolean} true if the observer moved this frame */
  update(dt) {
    const store = this.store;
    let moved = false;

    if (this.mode === 'cine') {
      this.cineT = (this.cineT + dt) % CINE_TOTAL;
      let t = this.cineT, shot = SHOTS[0];
      for (const s of SHOTS) { if (t < s.d) { shot = s; break; } t -= s.d; }
      this.shotName = shot.name;
      const k = EASE[shot.e](THREE.MathUtils.clamp(t / shot.d, 0, 1));
      const L = (a, b) => a + (b - a) * k;

      // Slow handheld drift: enough to feel photographed, far below the scale
      // of any physical structure in frame.
      const tt = performance.now() * 0.001;
      const j = 0.0016;
      this.sph.r = L(shot.a.r, shot.b.r) * (1 + 0.0022 * Math.sin(tt * 0.37));
      this.sph.theta = THREE.MathUtils.clamp(
        L(shot.a.theta, shot.b.theta) + j * Math.sin(tt * 0.53 + 1.7), 0.035, Math.PI - 0.035);
      this.sph.phi = L(shot.a.phi, shot.b.phi) + j * Math.cos(tt * 0.41);
      store.set('fov', L(shot.a.fov, shot.b.fov), true);
      moved = true;
    } else {
      if (this.tween) {
        const w = this.tween;
        w.t = Math.min(w.d, w.t + dt);
        const k = EASE.inOut(w.t / w.d);
        const L = (a, b) => a + (b - a) * k;
        this.sph.r = L(w.from.r, w.to.r);
        this.sph.theta = L(w.from.theta, w.to.theta);
        this.sph.phi = L(w.from.phi, w.to.phi);
        store.set('fov', L(w.from.fov, w.to.fov), true);
        moved = true;
        if (w.t >= w.d) { this.tween = null; this._syncControls(); }
      } else if (this.autoOrbit) {
        this.sph.phi += dt * 0.055;
        moved = true;
      } else {
        moved = false;
      }

      if (!moved) {
        // pure OrbitControls frame: it owns the camera, we read the state back
        const bx = this.cam.position.x, by = this.cam.position.y, bz = this.cam.position.z;
        this.controls.update();               // user input + inertial damping
        const p = this.cam.position;
        moved = (p.x - bx) ** 2 + (p.y - by) ** 2 + (p.z - bz) ** 2 > 1e-12;
        this._readCamera();
      }
    }

    // Scripted motion (cine / tween / auto-orbit) drives the spherical state,
    // so push it to the camera and keep OrbitControls in step for handover.
    if (this.mode === 'cine' || this.tween || (this.mode === 'free' && this.autoOrbit)) {
      this._writeCamera();
      this.cam.lookAt(this.target);
      this.controls.target.copy(this.target);
    }

    // ---- tetrad for the shader ---------------------------------------------
    this.cam.fov = store.get('fov');
    this.cam.updateProjectionMatrix();
    this.cam.updateMatrixWorld(true);
    const m = this.cam.matrixWorld.elements;
    this.right.set(m[0], m[1], m[2]).normalize();
    this.up.set(m[4], m[5], m[6]).normalize();
    this.fwd.set(-m[8], -m[9], -m[10]).normalize();

    // Boost direction: the local circular-orbit velocity, so raising OBSERVER β
    // aberrates exactly as co-orbiting with the disk would.
    const rad = this.cam.position.clone().normalize();
    this.betaDir.copy(AXIS).cross(rad).normalize();
    if (this.betaDir.lengthSq() < 0.25) this.betaDir.copy(this.right);
    if (store.get('diskSpin') < 0) this.betaDir.negate();

    store.cam.r = this.sph.r;
    store.cam.theta = this.sph.theta;
    store.cam.phi = this.sph.phi;
    return moved;
  }

  /** Local physics readout at the observer. */
  readout() {
    const r = this.sph.r;
    const f = 1 - R_HORIZON / r;
    return {
      r, f,
      dilation: 1 / Math.sqrt(Math.max(f, 1e-6)),   // dt_inf / dtau
      escapeBeta: Math.sqrt(Math.min(R_HORIZON / r, 1)),
      orbitPeriod: 2 * Math.PI * Math.sqrt(r * r * r),   // 2*pi*sqrt(r^3/M)
      inclination: 90 - (this.sph.theta * 180) / Math.PI,
    };
  }

  dispose() { this.controls.dispose(); }
}
