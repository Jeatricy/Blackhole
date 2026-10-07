// renderer.js -- WebGL2 pipeline: geodesic pass -> HDR target -> bloom mip
// chain -> composite. three.js is used only as a thin GL/RT wrapper; there is
// no scene graph, no lights, no meshes other than one fullscreen triangle.

import * as THREE from 'three';
import { QUALITY } from './params.js';

const FS_POS = new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]);

function fullscreenGeometry() {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(FS_POS, 3));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  return g;
}

export class Renderer {
  /** @param {HTMLCanvasElement} canvas @param {{vert:string,bh:string,bloom:string,comp:string}} src */
  constructor(canvas, src, opts = {}) {
    this.canvas = canvas;
    this.src = src;
    this.preserve = !!opts.preserveDrawingBuffer;

    this.three = new THREE.WebGLRenderer({
      canvas,
      antialias: false,                 // we supersample via renderScale instead
      alpha: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: this.preserve,
      powerPreference: 'high-performance',
      failIfMajorPerformanceCaveat: false,
    });
    const gl = this.three.getContext();
    this.isWebGL2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
    if (!this.isWebGL2) throw new Error('需要 WebGL2：本项目的片元着色器使用 GLSL ES 3.00。');

    // We own the whole colour pipeline: three must not tonemap or re-encode.
    this.three.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.three.toneMapping = THREE.NoToneMapping;
    this.three.autoClear = true;
    this.three.debug.checkShaderErrors = true;

    // HDR storage. Half float is required for real bloom headroom; if the
    // extension is missing we degrade to 8-bit and clamp bloom instead of
    // failing, so the page still shows an image.
    this.floatOK = !!gl.getExtension('EXT_color_buffer_float');
    this.hdrType = this.floatOK ? THREE.HalfFloatType : THREE.UnsignedByteType;

    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.geom = fullscreenGeometry();
    this.quad = new THREE.Mesh(this.geom, null);
    this.quad.frustumCulled = false;
    this.scene = new THREE.Scene();
    this.scene.add(this.quad);

    this.size = { w: 1, h: 1, rw: 1, rh: 1, dpr: 1, scale: 1 };
    this.mips = [];
    this.sceneRT = null;
    this.frame = 0;
    this._quality = opts.quality && QUALITY[opts.quality] ? opts.quality : 'high';

    this._buildMaterials();
  }

  // -------------------------------------------------------------------------
  _rt(w, h) {
    const rt = new THREE.WebGLRenderTarget(Math.max(1, w | 0), Math.max(1, h | 0), {
      type: this.hdrType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
      colorSpace: THREE.NoColorSpace,
    });
    return rt;
  }

  _mat(frag, uniforms, extra = {}) {
    return new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: this.src.vert,
      fragmentShader: frag,
      uniforms,
      depthTest: false,
      depthWrite: false,
      ...extra,
    });
  }

  _buildMaterials() {
    const t = QUALITY[this._quality];
    const V3 = () => new THREE.Vector3();

    this.bhMat = this._mat(this.src.bh, {
      uCamPos: { value: V3() }, uCamRight: { value: V3() },
      uCamUp: { value: V3() }, uCamFwd: { value: V3() },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uTanHalfFov: { value: 0.4 }, uAspect: { value: 1 }, uTime: { value: 0 },
      uSteps: { value: t.steps }, uDphi: { value: t.dphi }, uMaxCross: { value: 4 },
      uDiskInner: { value: 6 }, uDiskOuter: { value: 14.0 },
      uDiskThickness: { value: 0.02 }, uDiskDensity: { value: 2.2 },
      uDiskBright: { value: 0.30 }, uDiskTemp: { value: 6200.0 }, uDiskSpin: { value: 1 },
      uDoppler: { value: 1 }, uRedshift: { value: 1 },
      uTurbulence: { value: 0.55 }, uNoiseScale: { value: 1.25 }, uFlowSpeed: { value: 1 },
      uStarBright: { value: 1 }, uGalaxyBright: { value: 1 }, uSkyRot: { value: 0 },
      uObsBeta: { value: 0 }, uObsBetaDir: { value: new THREE.Vector3(1, 0, 0) },
      uDebug: { value: 0 },
    }, { defines: { MAX_STEPS: String(t.steps) } });

    const bloomUniforms = () => ({
      uTex: { value: null }, uTexel: { value: new THREE.Vector2() },
      uMode: { value: 0 }, uThreshold: { value: 0.45 }, uKnee: { value: 0.35 },
      uRadius: { value: 1.0 }, uClamp: { value: 90.0 },
    });
    this.preMat = this._mat(this.src.bloom, bloomUniforms());
    this.downMat = this._mat(this.src.bloom, bloomUniforms());
    this.downMat.uniforms.uMode.value = 1;
    // upsample accumulates into the coarser mip, hence additive blending
    this.upMat = this._mat(this.src.bloom, bloomUniforms(), {
      blending: THREE.AdditiveBlending, transparent: true,
    });
    this.upMat.uniforms.uMode.value = 2;

    this.compMat = this._mat(this.src.comp, {
      uScene: { value: null }, uBloom: { value: null },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uExposure: { value: 1.15 }, uBloomStrength: { value: 0.42 },
      uChroma: { value: 0.35 }, uVignette: { value: t.vignette },
      uGrain: { value: t.grain }, uTime: { value: 0 }, uDebug: { value: 0 },
      uDiagnostic: { value: false },
    });
  }

  /**
   * Change the step budget. MAX_STEPS is a compile-time bound (the loop must be
   * bounded for the driver to unroll/optimize), so this recompiles one shader
   * and carries the uniform objects across.
   */
  setQuality(q) {
    if (!QUALITY[q] || q === this._quality) return;
    this._quality = q;
    const t = QUALITY[q];
    const old = this.bhMat;
    this.bhMat = this._mat(this.src.bh, old.uniforms, { defines: { MAX_STEPS: String(t.steps) } });
    this.bhMat.uniforms.uSteps.value = t.steps;
    this.bhMat.uniforms.uDphi.value = t.dphi;
    this.compMat.uniforms.uVignette.value = t.vignette;
    this.compMat.uniforms.uGrain.value = t.grain;
    if (old && old !== this.bhMat) old.dispose();
    this._resizeTargets();
  }

  // -------------------------------------------------------------------------
  /**
   * @param w,h   CSS pixels
   * @param dpr   device pixel ratio (already clamped by the caller)
   * @param scale renderScale * quality tier scale
   */
  setSize(w, h, dpr, scale) {
    w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
    const t = QUALITY[this._quality];
    let rw = Math.max(1, Math.round(w * dpr * scale));
    let rh = Math.max(1, Math.round(h * dpr * scale));

    // Hard pixel budget: a per-pixel RK4 integrator on a 4K retina panel at
    // 1.2x supersample is ~40 Mpx of geodesics, which no GPU wants. Shrink
    // isotropically rather than letting the frame time explode.
    const BUDGET = t.steps >= 512 ? 5.0e6 : t.steps >= 320 ? 6.5e6 : 8.5e6;
    const over = (rw * rh) / BUDGET;
    if (over > 1) { const k = 1 / Math.sqrt(over); rw = Math.max(1, Math.round(rw * k)); rh = Math.max(1, Math.round(rh * k)); }

    const same = this.size.w === w && this.size.h === h
      && this.size.rw === rw && this.size.rh === rh;
    this.size = { w, h, rw, rh, dpr, scale };
    this.three.setPixelRatio(1);                 // we manage resolution ourselves
    this.three.setSize(w, h, false);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    if (!same) this._resizeTargets();
    return this.size;
  }

  _resizeTargets() {
    const { rw, rh } = this.size;
    const t = QUALITY[this._quality];

    if (this.sceneRT) this.sceneRT.dispose();
    this.sceneRT = this._rt(rw, rh);

    for (const m of this.mips) m.dispose();
    this.mips = [];
    let w = rw, h = rh;
    for (let i = 0; i < t.mips; i++) {
      w = Math.floor(w / 2); h = Math.floor(h / 2);
      if (w < 2 || h < 2) break;
      this.mips.push(this._rt(w, h));
    }
  }

  /** Full frame: geodesic pass, bloom chain, composite to the canvas. */
  render(state) {
    const { rw, rh } = this.size;
    const u = this.bhMat.uniforms;
    const p = state.params;

    u.uCamPos.value.copy(state.camPos);
    u.uCamRight.value.copy(state.camRight);
    u.uCamUp.value.copy(state.camUp);
    u.uCamFwd.value.copy(state.camFwd);
    u.uResolution.value.set(rw, rh);
    u.uTanHalfFov.value = Math.tan(THREE.MathUtils.degToRad(p.fov) * 0.5);
    u.uAspect.value = rw / rh;
    u.uTime.value = state.time;
    u.uSteps.value = Math.min(QUALITY[this._quality].steps, state.steps ?? QUALITY[this._quality].steps);
    u.uMaxCross.value = p.maxCross | 0;
    u.uDiskInner.value = p.diskInner;
    u.uDiskOuter.value = Math.max(p.diskOuter, p.diskInner * 1.15);
    u.uDiskThickness.value = p.thickness;
    u.uDiskDensity.value = p.density;
    u.uDiskBright.value = p.brightness;
    u.uDiskTemp.value = p.temp;
    u.uDiskSpin.value = p.diskSpin >= 0 ? 1 : -1;
    u.uDoppler.value = p.doppler;
    u.uRedshift.value = p.redshift;
    u.uTurbulence.value = p.turbulence;
    u.uNoiseScale.value = p.noiseScale;
    u.uFlowSpeed.value = p.flowSpeed;
    u.uStarBright.value = p.starBright;
    u.uGalaxyBright.value = p.galaxy;
    u.uSkyRot.value = state.skyRot ?? 0;
    u.uObsBeta.value = p.obsBeta;
    u.uObsBetaDir.value.copy(state.betaDir);
    u.uDebug.value = state.debug;

    this._pass(this.bhMat, this.sceneRT);
    const bloomTex = this._bloom(state);

    const c = this.compMat.uniforms;
    c.uScene.value = this.sceneRT.texture;
    c.uBloom.value = bloomTex;
    c.uResolution.value.set(rw, rh);
    c.uExposure.value = p.exposure;
    c.uBloomStrength.value = this.floatOK ? p.bloom : Math.min(p.bloom, 0.5);
    c.uChroma.value = p.chroma;
    c.uTime.value = state.time;
    c.uDebug.value = state.debug <= 3 ? state.debug : 0;
    c.uDiagnostic.value = state.debug >= 4;
    this._pass(this.compMat, null);
    this.frame++;
  }

  _pass(mat, target) {
    this.quad.material = mat;
    this.three.setRenderTarget(target);
    this.three.render(this.scene, this.camera);
    this.three.setRenderTarget(null);
  }

  _bloom(state) {
    if (!this.mips.length || state.params.bloom <= 0) return this.mips[0]?.texture ?? this.sceneRT.texture;

    // bright pass -> mip 0
    const pu = this.preMat.uniforms;
    pu.uTex.value = this.sceneRT.texture;
    pu.uTexel.value.set(1 / this.size.rw, 1 / this.size.rh);
    // Threshold lives in *pre-exposure* linear light, so it has to track the
    // disk's emission scale rather than the display range. With EMISSION at its
    // 0.30 default the disk peaks near 0.42, or ~0.87 once g^4 beaming hits the
    // approaching side; a 1.15 threshold sat above all of that and made the
    // bloom identically zero (debug view 2 rendered pure black). 0.45 keeps the
    // dim outer annulus out of the glow while letting the hot inner disk and the
    // photon ring carry it.
    pu.uThreshold.value = 0.45;
    pu.uKnee.value = 0.35;
    pu.uClamp.value = this.floatOK ? 120 : 4;
    this._pass(this.preMat, this.mips[0]);

    // downsample
    for (let i = 1; i < this.mips.length; i++) {
      const s = this.mips[i - 1];
      this.downMat.uniforms.uTex.value = s.texture;
      this.downMat.uniforms.uTexel.value.set(1 / s.width, 1 / s.height);
      this._pass(this.downMat, this.mips[i]);
    }
    // upsample, additively accumulating back down the chain
    for (let i = this.mips.length - 1; i > 0; i--) {
      const s = this.mips[i];
      this.upMat.uniforms.uTex.value = s.texture;
      this.upMat.uniforms.uTexel.value.set(1 / s.width, 1 / s.height);
      this.upMat.uniforms.uRadius.value = 1.0 + 0.35 * i;   // wider tent when coarser
      this._pass(this.upMat, this.mips[i - 1]);
    }
    return this.mips[0].texture;
  }

  dispose() {
    for (const m of this.mips) m.dispose();
    this.sceneRT?.dispose();
    this.geom.dispose();
    for (const m of [this.bhMat, this.preMat, this.downMat, this.upMat, this.compMat]) m?.dispose();
    this.three.dispose();
  }
}
