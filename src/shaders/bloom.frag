// bloom.frag -- one shader, three modes, selected by uMode:
//   0 prefilter  (soft-knee bright pass + karis average)
//   1 downsample (13-tap box, dual-filter safe)
//   2 upsample   (3x3 tent, additively blended into the coarser mip)
precision highp float;

#include "common.glsl"

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uTex;
uniform vec2  uTexel;      // 1 / size of uTex
uniform int   uMode;
uniform float uThreshold;
uniform float uKnee;
uniform float uRadius;     // tent radius in texels, upsample only
uniform float uClamp;      // hard ceiling on prefiltered energy (fireflies)

vec3 fetch(vec2 uv){ return texture(uTex, uv).rgb; }

// weight by 1/(1+luma) inside the 4-tap average: kills single-pixel fireflies
// (lensed stars near the critical curve are exactly that) without dimming
// genuinely large bright areas like the inner disk.
vec3 karis4(vec3 a, vec3 b, vec3 c, vec3 d){
  float wa = 1.0 / (1.0 + luma(a)), wb = 1.0 / (1.0 + luma(b));
  float wc = 1.0 / (1.0 + luma(c)), wd = 1.0 / (1.0 + luma(d));
  return (a * wa + b * wb + c * wc + d * wd) / max(wa + wb + wc + wd, 1e-6);
}

void main(){
  vec2 t = uTexel;
  vec3 o = vec3(0.0);

  if (uMode == 0){
    vec3 a = fetch(vUv + vec2(-t.x, -t.y)), b = fetch(vUv + vec2(t.x, -t.y));
    vec3 c = fetch(vUv + vec2(-t.x,  t.y)), d = fetch(vUv + vec2(t.x,  t.y));
    vec3 col = karis4(a, b, c, d);
    col = min(col, vec3(uClamp));

    // Unreal-style soft knee around the threshold
    float br = max(col.r, max(col.g, col.b));
    float k  = max(uKnee, 1e-4);
    float sc = clamp(br - uThreshold + k, 0.0, 2.0 * k);
    sc = sc * sc / (4.0 * k);
    o = col * max(sc, br - uThreshold) / max(br, 1e-5);

  } else if (uMode == 1){
    vec3 A = fetch(vUv + t * vec2(-1.0,  1.0)), B = fetch(vUv + t * vec2( 0.0,  1.0));
    vec3 C = fetch(vUv + t * vec2( 1.0,  1.0)), D = fetch(vUv + t * vec2(-0.5,  0.5));
    vec3 E = fetch(vUv + t * vec2( 0.5,  0.5)), F = fetch(vUv + t * vec2(-1.0,  0.0));
    vec3 G = fetch(vUv),                        H = fetch(vUv + t * vec2( 1.0,  0.0));
    vec3 I = fetch(vUv + t * vec2(-0.5, -0.5)), J = fetch(vUv + t * vec2( 0.5, -0.5));
    vec3 K = fetch(vUv + t * vec2(-1.0, -1.0)), L = fetch(vUv + t * vec2( 0.0, -1.0));
    vec3 M = fetch(vUv + t * vec2( 1.0, -1.0));
    o  = (D + E + I + J) * 0.125;
    o += (A + B + G + F) * 0.03125;
    o += (B + C + H + G) * 0.03125;
    o += (F + G + L + K) * 0.03125;
    o += (G + H + M + L) * 0.03125;

  } else {
    vec2 r = t * uRadius;
    o  = fetch(vUv + vec2(-r.x,  r.y)) * 1.0 + fetch(vUv + vec2(0.0,  r.y)) * 2.0
       + fetch(vUv + vec2( r.x,  r.y)) * 1.0 + fetch(vUv + vec2(-r.x, 0.0)) * 2.0
       + fetch(vUv)                    * 4.0 + fetch(vUv + vec2( r.x, 0.0)) * 2.0
       + fetch(vUv + vec2(-r.x, -r.y)) * 1.0 + fetch(vUv + vec2(0.0, -r.y)) * 2.0
       + fetch(vUv + vec2( r.x, -r.y)) * 1.0;
    o /= 16.0;
  }

  fragColor = vec4(max(o, 0.0), 1.0);
}
