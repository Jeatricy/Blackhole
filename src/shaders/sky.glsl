// sky.glsl -- fully procedural star field + Milky Way. This is the source image
// that the geodesics lens, so it must stay stable under extreme magnification:
// every layer takes an explicit filter width `fw` (radians) computed from the
// screen-space spread of the escape direction.
#ifndef SKY_GLSL
#define SKY_GLSL

#include "common.glsl"
#include "color.glsl"

// galactic pole / centre -- an arbitrary but fixed orientation so the band cuts
// a pleasing diagonal rather than lying along a screen axis
const vec3 GAL_POLE = vec3(0.4472136, 0.8017837, -0.3962), GAL_CTR = vec3(-0.8410, 0.4880, -0.2340);

// Cube-face parameterization: cheaper and better distributed than lat/long
// (no pole pinching) and gives us a natural per-face cell grid for stars.
void cubeFace(vec3 d, out vec2 uv, out float face){
  vec3 a = abs(d);
  if (a.x >= a.y && a.x >= a.z){ uv = d.zy / a.x; face = d.x > 0.0 ? 0.0 : 1.0; }
  else if (a.y >= a.z)         { uv = d.xz / a.y; face = d.y > 0.0 ? 2.0 : 3.0; }
  else                         { uv = d.xy / a.z; face = d.z > 0.0 ? 4.0 : 5.0; }
}

// One star layer: one candidate per cell, jittered inside it.
vec3 starLayer(vec3 dir, float cells, float fw, float seed, float density){
  vec2 uv; float face;
  cubeFace(dir, uv, face);
  vec2 g  = uv * cells;
  vec2 ci = floor(g);
  vec2 cf = g - ci;

  vec3 h = hash32(ci + vec2(face * 31.7 + seed, seed * 2.13));
  if (h.z > density) return vec3(0.0);

  vec2 jitter = hash22(ci + vec2(seed * 7.3, face * 5.1 + 1.7));
  vec2 delta  = (cf - mix(vec2(0.16), vec2(0.84), jitter)) / cells;

  // cube-uv -> radians: the face metric stretches by (1+|uv|^2)^(-1) toward
  // corners, and one uv unit spans the 45 deg half-angle of the face
  float m = 1.0 / (1.0 + dot(uv, uv));
  float ang = length(delta) * m * HALF_PI * 0.5;

  // Never draw a star narrower than a pixel, and conserve flux when widening,
  // otherwise the field boils with aliasing wherever lensing magnifies it.
  float rTrue = 0.00045 + 0.0016 * h.x * h.x;
  float rDraw = max(rTrue, fw * 0.85);
  float flux  = (rTrue * rTrue) / (rDraw * rDraw);

  // Few bright, many faint. The exponent has to be steep because the gain in
  // starField() otherwise lifts the whole mid-population toward saturation: at
  // 5.2, 2.9% of pure-sky pixels sat above 0.6 luminance (measured on the ICONIC
  // still), which is far too many near-white points for a star field. At 7.5 the
  // top percentile is untouched (0.99^7.5 is still 0.93) while the middle
  // collapses (0.5^7.5 is 5x dimmer than 0.5^5.2) -- closer to a real magnitude
  // distribution's shape. This is a look calibration, not a correctness fix.
  float mag  = pow(h.y, 7.5);
  float fall = exp(-(ang * ang) / (rDraw * rDraw * 0.30));

  float T = mix(2600.0, 13500.0, pow(hash12(ci * 1.7 + face + seed), 2.1));
  return blackbodyRGB(T) * (mag * flux * fall);
}

vec3 starField(vec3 dir, float fw, float bright){
  vec3 s = vec3(0.0);
  // Occupancy has to stay low or the field reads as coloured confetti rather
  // than stars. Each layer spawns 6*(2*cells)^2*density candidates over the six
  // faces: at 0.55/0.62/0.70 that was 1.44M, ~5.9 per pixel at 640x384, so the
  // tangentially-sheared star images overlapped into noise. These densities give
  // 243k (~1.0/px of full sky). The coarse layer carries the bright naked-eye
  // anchors, so it keeps most of its occupancy; the fine layers only suggest
  // depth and are weighted well below 1 below.
  s += starLayer(dir,  46.0, fw, 11.0, 0.42) * 1.00;
  s += starLayer(dir, 118.0, fw, 53.0, 0.20) * 0.42;
  s += starLayer(dir, 268.0, fw, 97.0, 0.09) * 0.17;
  return s * bright * 24.0;
}

vec3 galaxyBand(vec3 dir, float fw, float bright){
  float sinB = clamp(dot(dir, GAL_POLE), -1.0, 1.0);
  float band = exp(-pow(abs(sinB) / 0.155, 1.85));         // thickness in |sin b|

  // LOD: drop octaves as the filter widens, so magnified regions stay smooth
  int oct = int(clamp(5.0 - log2(max(fw, 1e-5) / 0.0016), 2.0, 5.0));

  vec3 q = dir * 3.1;
  float clouds = fbm3(q, oct) * 0.5 + 0.5;
  float fine   = fbm3(q * 6.3 + 21.0, max(oct - 1, 2)) * 0.5 + 0.5;
  float dust   = smoothstep(0.34, 0.86, fbm3(q * 2.05 - 9.0, max(oct - 1, 2)) * 0.5 + 0.5);

  float dens = band * (0.30 + 0.85 * clouds * clouds) * (0.42 + 0.72 * fine);
  dens *= mix(1.0, 0.16, dust * band);                     // dark lanes

  // warm crowded core, cooler at the edges, plus the central bulge
  vec3 col = mix(vec3(0.44, 0.56, 0.98), vec3(1.00, 0.86, 0.62),
                 clamp(band * 1.1, 0.0, 1.0) * 0.8);
  float bulge = exp(-pow(acos(clamp(dot(dir, GAL_CTR), -1.0, 1.0)) / 0.40, 2.0));
  col += vec3(1.00, 0.78, 0.46) * bulge * 0.85;
  col += vec3(0.85, 0.30, 0.34) * smoothstep(0.62, 1.0, fine) * band * 0.30;

  return col * dens * bright * 0.020;
}

vec3 skyRadiance(vec3 dir, float fw, float starBright, float galBright){
  return starField(dir, fw, starBright)
       + galaxyBand(dir, fw, galBright)
       + vec3(0.0007, 0.0009, 0.0017) * galBright;   // faint isotropic floor
}

#endif
