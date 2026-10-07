// color.glsl -- blackbody colour, ACES tonemap, sRGB transfer, false colour.
#ifndef COLOR_GLSL
#define COLOR_GLSL

// Planckian locus in CIE 1931 xy (Kim et al. cubic fit), 1667K..25000K.
vec2 planckXY(float T){
  float t = clamp(T, 1667.0, 25000.0);
  float i = 1.0 / t, i2 = i * i, i3 = i2 * i;
  float x;
  if (t < 4000.0) x = -0.2661239e9*i3 - 0.2343589e6*i2 + 0.8776956e3*i + 0.179910;
  else            x = -3.0258469e9*i3 + 2.1070379e6*i2 + 0.2226347e3*i + 0.240390;
  float x2 = x * x, x3 = x2 * x, y;
  if      (t < 2222.0) y = -1.1063814*x3 - 1.34811020*x2 + 2.18555832*x - 0.20219683;
  else if (t < 4000.0) y = -0.9549476*x3 - 1.37418593*x2 + 2.09137015*x - 0.16748867;
  else                 y =  3.0817580*x3 - 5.87338670*x2 + 3.75112997*x - 0.37001483;
  return vec2(x, y);
}

// Normalized so the peak channel is 1: absolute scale comes from Stefan-Boltzmann.
vec3 blackbodyRGB(float T){
  vec2 xy = planckXY(T);
  float y = max(xy.y, 1e-4);
  vec3 XYZ = vec3(xy.x / y, 1.0, (1.0 - xy.x - xy.y) / y);
  vec3 rgb = mat3( 3.2404542, -0.9692660,  0.0556434,
                  -1.5371385,  1.8760108, -0.2040259,
                  -0.4985314,  0.0415560,  1.0572252) * XYZ;
  rgb = max(rgb, 0.0);
  return rgb / max(max(rgb.r, max(rgb.g, rgb.b)), 1e-5);
}

// ACES RRT+ODT fit (Stephen Hill). Keeps the deep reds of the outer disk from
// clipping to orange the way the cheap Narkowicz curve does.
const mat3 ACES_IN = mat3(
  0.59719, 0.07600, 0.02840,
  0.35458, 0.90834, 0.13383,
  0.04823, 0.01566, 0.83777);
const mat3 ACES_OUT = mat3(
   1.60475, -0.10208, -0.00327,
  -0.53108,  1.10813, -0.07276,
  -0.07367, -0.00605,  1.07602);

vec3 rrtOdtFit(vec3 v){
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}
vec3 acesFitted(vec3 c){
  c = ACES_IN * max(c, 0.0);
  c = rrtOdtFit(c);
  return clamp(ACES_OUT * c, 0.0, 1.0);
}

// linear -> sRGB (we drive the final encode ourselves, three does none)
vec3 linearToSRGB(vec3 c){
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

// perceptual false colour for the diagnostic views
vec3 heatmap(float t){
  t = clamp(t, 0.0, 1.0);
  vec3 c = mix(vec3(0.02, 0.04, 0.20), vec3(0.05, 0.62, 0.88), smoothstep(0.0, 0.36, t));
  c = mix(c, vec3(0.98, 0.86, 0.20), smoothstep(0.34, 0.70, t));
  c = mix(c, vec3(1.00, 0.20, 0.09), smoothstep(0.68, 1.0, t));
  return c;
}

#endif
