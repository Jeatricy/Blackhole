// composite.frag -- HDR scene + bloom -> exposure -> dispersion -> ACES ->
// vignette -> grain -> sRGB. Order matters: dispersion and vignette belong to
// the lens (linear, pre-tonemap), grain belongs to the film (post-tonemap).
precision highp float;

#include "common.glsl"
#include "color.glsl"

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform vec2  uResolution;
uniform float uExposure;
uniform float uBloomStrength;
uniform float uChroma;      // lateral dispersion, in pixels at the frame edge
uniform float uVignette;
uniform float uGrain;
uniform float uTime;
uniform int   uDebug;       // 1 = beauty only, 2 = bloom only, 3 = luma heatmap
// Views 4-9 are false-colour diagnostics produced by the geodesic pass. They
// must NOT go through ACES: the filmic toe crushes everything below ~0.003
// linear to exactly zero, which turns a quantitative readout into mush. They
// get a straight sRGB encode, no tonemap, no vignette, no grain.
uniform bool  uDiagnostic;

void main(){
  vec2 uv = vUv;
  vec2 c  = uv - 0.5;
  float r2 = dot(c, c);

  if (uDiagnostic){
    fragColor = vec4(linearToSRGB(texture(uScene, uv).rgb), 1.0);
    return;
  }

  // Lateral chromatic aberration: radial, quadratic with field position, in
  // pixel units so it does not change appearance with resolution.
  vec2 px = 1.0 / uResolution;
  vec3 scene, bloom;
  if (uChroma > 1e-4){
    // Weighted heavily toward the bloom. The sharp layer is a field of nearly
    // delta-function stars, and *any* per-channel offset comparable to a pixel
    // splits each one into separate red and blue dots -- measurably so: it
    // produced 1467 pure-green pixels in a 400x260 frame, which a blackbody
    // can never be, and tripled the count of saturated primaries. Real lens
    // dispersion is conspicuous in defocused highlights, so keep the scene
    // offset sub-pixel and let the already-blurred bloom carry the effect as a
    // soft rainbow around the disk.
    vec2 drS = c * r2 * uChroma * 3.0  * px;   // <1px at the default
    vec2 drB = c * r2 * uChroma * 26.0 * px;   // visible on the halo
    scene = vec3(texture(uScene, uv + drS).r,
                 texture(uScene, uv).g,
                 texture(uScene, uv - drS).b);
    bloom = vec3(texture(uBloom, uv + drB).r,
                 texture(uBloom, uv).g,
                 texture(uBloom, uv - drB).b);
  } else {
    scene = texture(uScene, uv).rgb;
    bloom = texture(uBloom, uv).rgb;
  }

  if (uDebug == 2){
    // bloom isolation: show the glow contribution alone, same exposure path
    vec3 b = bloom * uBloomStrength * uExposure;
    fragColor = vec4(linearToSRGB(acesFitted(b)), 1.0);
    return;
  }

  vec3 hdr = scene;
  if (uDebug != 1) hdr += bloom * uBloomStrength;
  hdr *= uExposure;

  if (uDebug == 3){
    // exposure diagnostic: false-colour log luminance, 1.0 = clipping
    float L = luma(scene + bloom * uBloomStrength) * uExposure;
    vec3 hm = heatmap(clamp(log2(max(L, 1e-4)) * 0.22 + 0.86, 0.0, 1.0));
    if (L > 1.0) hm = mix(hm, vec3(1.0), 0.35 + 0.35 * sin(uTime * 7.0));
    fragColor = vec4(linearToSRGB(hm), 1.0);
    return;
  }

  // optical vignette (cos^4-ish falloff), applied in linear light
  float vig = 1.0 - uVignette * smoothstep(0.06, 0.86, r2 * 1.65);
  hdr *= clamp(vig, 0.0, 1.0);

  vec3 col = acesFitted(hdr);
  col = linearToSRGB(col);

  // film grain: luminance-dependent so black stays black
  if (uGrain > 1e-4){
    float n = hash12(uv * uResolution + vec2(uTime * 121.7, uTime * 53.3)) - 0.5;
    float lm = luma(col);
    col += n * uGrain * (0.35 + 0.9 * sqrt(clamp(lm, 0.0, 1.0)));
  }

  fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
