// common.glsl -- constants, hashes, value noise, small utilities.
#ifndef COMMON_GLSL
#define COMMON_GLSL

const float PI      = 3.141592653589793;
const float TWO_PI  = 6.283185307179586;
const float HALF_PI = 1.570796326794897;

// ---- hashes (integer-free, stable across drivers) -------------------------
float hash11(float p){
  p = fract(p * 0.1031);
  p *= p + 33.33;
  return fract(p * (p + p));
}
float hash12(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
vec3 hash32(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yzz) * p3.zyx);
}
float hash13(vec3 p){
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

// ---- gradient-free value noise, quintic-smoothed --------------------------
float vnoise3(vec3 x){
  vec3 i = floor(x), fp = fract(x);
  vec3 w = fp * fp * fp * (fp * (fp * 6.0 - 15.0) + 10.0);
  float n000 = hash13(i + vec3(0,0,0)), n100 = hash13(i + vec3(1,0,0));
  float n010 = hash13(i + vec3(0,1,0)), n110 = hash13(i + vec3(1,1,0));
  float n001 = hash13(i + vec3(0,0,1)), n101 = hash13(i + vec3(1,0,1));
  float n011 = hash13(i + vec3(0,1,1)), n111 = hash13(i + vec3(1,1,1));
  float x00 = mix(n000, n100, w.x), x10 = mix(n010, n110, w.x);
  float x01 = mix(n001, n101, w.x), x11 = mix(n011, n111, w.x);
  return mix(mix(x00, x10, w.y), mix(x01, x11, w.y), w.z) * 2.0 - 1.0;
}

float fbm3(vec3 p, int oct){
  float a = 0.5, s = 0.0, n = 0.0;
  for (int i = 0; i < 6; ++i){
    if (i >= oct) break;
    s += a * vnoise3(p);
    n += a; a *= 0.5;
    p = p * 2.02 + vec3(11.3, 7.7, 5.1);
  }
  return s / max(n, 1e-6);
}

// ---- misc -----------------------------------------------------------------
float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

// Rodrigues rotation about a unit axis.
vec3 rotAxis(vec3 v, vec3 axis, float ang){
  float c = cos(ang), s = sin(ang);
  return v * c + cross(axis, v) * s + axis * dot(axis, v) * (1.0 - c);
}

// Antialiased periodic line, for the debug grids. `w` is the filter width in
// the same units as `x`, so lines stay ~1px wide under any magnification.
float gridLine(float x, float period, float w){
  float d = abs(fract(x / period + 0.5) - 0.5) * period;
  return 1.0 - smoothstep(0.0, max(w * 1.6, 1e-6), d);
}

#endif
