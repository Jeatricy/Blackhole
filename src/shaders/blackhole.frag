// blackhole.frag -- Schwarzschild null-geodesic raytracer.
//
// Every pixel integrates a real null geodesic of the Schwarzschild metric. There
// is no black sphere, no billboard ring, no texture and no video: the shadow is
// where geodesics terminate on the horizon, the photon ring is where they wind
// many times near r = 3M, and the disk images are successive equatorial
// crossings of one integrated ray.
//
// Units are geometrized with M = 1:
//   horizon        r_s   = 2M
//   photon sphere  r_ph  = 3M
//   ISCO           r_isco= 6M
//   critical b     b_c   = 3*sqrt(3) M ~= 5.196
//
// Formulation: the orbit equation in u = 1/r,
//
//     d2u/dphi2 + u = 3 M u^2
//
// integrated with RK4 in the ray's own orbital plane. Working in-plane (rather
// than 3D Cartesian) is what makes this cheap enough to be real time: the state
// is two floats, phi advances monotonically so multiple disk crossings fall out
// for free, and equatorial crossings can be located analytically instead of by
// root-finding.

precision highp float;
precision highp int;

#include "common.glsl"
#include "color.glsl"
#include "sky.glsl"

#ifndef MAX_STEPS
#define MAX_STEPS 320
#endif

in vec2 vUv;
out vec4 fragColor;

// ---- camera / frame -------------------------------------------------------
uniform vec3  uCamPos;        // observer position, geometrized units
uniform vec3  uCamRight;      // orthonormal camera basis (static-observer tetrad)
uniform vec3  uCamUp;
uniform vec3  uCamFwd;
uniform vec2  uResolution;
uniform float uTanHalfFov;
uniform float uAspect;
uniform float uTime;

// ---- integrator -----------------------------------------------------------
uniform int   uSteps;         // <= MAX_STEPS, lets the slider move without recompiling
uniform float uDphi;          // base angular step (rad)
uniform int   uMaxCross;      // cap on equatorial crossings (image order)

// ---- disk -----------------------------------------------------------------
uniform float uDiskInner;     // r_in (>= r_ph; default ISCO = 6M)
uniform float uDiskOuter;
uniform float uDiskThickness; // scale height / r
uniform float uDiskDensity;   // face-on optical depth scale
uniform float uDiskBright;
uniform float uDiskTemp;      // peak effective temperature, K
uniform float uDiskSpin;      // +1 prograde, -1 retrograde
uniform float uDoppler;       // beaming exponent dial (g^(4*uDoppler))
uniform float uRedshift;      // chromatic shift dial (T * g^uRedshift)
uniform float uTurbulence;
uniform float uNoiseScale;
uniform float uFlowSpeed;

// ---- sky ------------------------------------------------------------------
uniform float uStarBright;
uniform float uGalaxyBright;
uniform float uSkyRot;

// ---- observer motion / debug ---------------------------------------------
uniform float uObsBeta;       // |v|/c of the observer, for aberration + beaming
uniform vec3  uObsBetaDir;
uniform int   uDebug;

const vec3  DISK_AXIS = vec3(0.0, 1.0, 0.0);
const float R_MAX     = 1400.0;   // "infinity" for escape testing
const float U_ESCAPE  = 1.0 / R_MAX;

// ===========================================================================
//  Accretion disk
// ===========================================================================

// Novikov-Thorne / Shakura-Sunyaev effective temperature, normalized so that
// the profile maximum (at r = 49/36 r_in) equals uDiskTemp exactly.
float diskTemp(float r, float rin){
  float s = max(1.0 - sqrt(rin / r), 0.0);
  float shape = pow(r, -0.75) * pow(s, 0.25);
  float rp = 1.3611111 * rin;              // 49/36 r_in
  float shapeP = pow(rp, -0.75) * pow(0.1428571, 0.25);   // s(rp) = 1/7
  return uDiskTemp * shape / max(shapeP, 1e-9);
}

// (T/Tpeak)^4 -- Stefan-Boltzmann surface brightness in the fluid frame.
float diskFlux(float r, float rin){
  float t = diskTemp(r, rin) / max(uDiskTemp, 1.0);
  return t * t * t * t;
}

float diskWindow(float r){
  float inner = smoothstep(0.0, 1.0, (r - uDiskInner) / max(0.20 * uDiskInner, 1e-3));
  float outer = 1.0 - smoothstep(0.70, 1.0, r / uDiskOuter);
  return inner * outer;
}

// Differentially-sheared turbulence. The pattern co-rotates with the local
// Keplerian angular velocity, so structures wind up into trailing spirals.
// Sampling noise on a circle embedded in 3D keeps the azimuth seamless.
// Returns (density multiplier, hotspot weight).
vec2 diskTurbulence(float r, float phiD, float rin){
  float om  = uFlowSpeed * 0.42 * pow(max(r, 0.5), -1.5);
  float lr  = log(max(r / rin, 1e-3));
  float azF = 2.15 * uNoiseScale;
  float rdF = 7.20 * uNoiseScale;

  float pa = phiD - om * uTime;
  float n1 = fbm3(vec3(cos(pa) * azF, sin(pa) * azF, lr * rdF), 4);

  float pb = phiD - om * uTime * 2.35;
  float n2 = fbm3(vec3(cos(pb) * azF * 2.7, sin(pb) * azF * 2.7, lr * rdF * 2.3 + 17.0), 3);

  float dens = max(1.0 + uTurbulence * (1.55 * n1 + 0.85 * n2), 0.0);
  float hot  = smoothstep(0.10, 0.80, 0.62 * (0.5 * n1 + 0.5) + 0.38 * (0.5 * n2 + 0.5));
  return vec2(dens, hot);
}

// Combined Doppler + gravitational shift for a circular-orbit emitter:
//
//     g = nu_obs / nu_em = sqrt(1 - 3M/r) / (1 - Omega * lz)
//
// where lz = L_z/E of the *physical* photon (disk -> observer) and Omega is the
// emitter's coordinate angular velocity. Sign discipline matters here, because
// it decides which side of the disk is the bright one:
//
//   * the traced ray runs observer -> disk, so the real photon's angular
//     momentum is minus the traced ray's:  L_real = -b * (e1 x e2);
//   * Omega_vec = spin * sqrt(M/r^3) * axis, so Omega*lz = Omega_vec . L_real.
//
// Check, camera on +Z, axis = +Y, spin = +1: at the +X point of the disk the
// emitter velocity is Omega_vec x p = -Z_hat, i.e. receding, and the formula
// returns g < 1 (redshift). The -X side then gives g > 1. Consistent.
float shiftFactor(float r, vec3 Lreal){
  float grav = sqrt(max(1.0 - 3.0 / r, 1e-4));       // = sqrt(1 - 3M/r)
  vec3  omv  = uDiskSpin * sqrt(1.0 / (r * r * r)) * DISK_AXIS;
  float dop  = 1.0 - dot(omv, Lreal);
  return grav / max(dop, 1e-3);
}

// Emission of one equatorial crossing, already shifted into the observer frame.
// Returns rgb in .xyz and the opacity alpha in .w.
vec4 shadeCrossing(vec3 p, float r, float u, float dudphi, float amp,
                   vec3 Lreal, float obsShift, out float gOut)
{
  float rin = uDiskInner;
  float win = diskWindow(r);
  if (win <= 1e-4) { gOut = 1.0; return vec4(0.0); }

  // azimuth in the disk plane, for the co-rotating turbulence field
  vec3 e1d = normalize(vec3(1.0, 0.0, 0.0) - DISK_AXIS * DISK_AXIS.x);
  vec3 e2d = cross(DISK_AXIS, e1d);
  float phiD = atan(dot(p, e2d), dot(p, e1d));

  vec2  turb = diskTurbulence(r, phiD, rin);
  float dens = turb.x;

  // Incidence of the ray on the midplane. |dp/dphi| = (1/u) sqrt(1+(u'/u)^2),
  // while the vertical rate at a crossing is amp/u, so sin(i) follows directly.
  float slope   = dudphi / max(u, 1e-6);
  float sinInc  = amp / sqrt(1.0 + slope * slope);

  // Path through a slab of half-height H = thickness*r is 2H/sin(i), so the
  // grazing enhancement saturates once sin(i) ~ 2*thickness -- that is where
  // the chord stops being set by the slab and starts being set by the annulus.
  // This is what makes SCALE H/r matter: a razor-thin disk collapses to a
  // brilliant line edge-on, a puffy one stays soft.
  float grazeCap = clamp(0.5 / max(uDiskThickness, 1e-4), 1.0, 60.0);
  float graze    = clamp(1.0 / max(abs(sinInc), 1e-4), 1.0, grazeCap);

  // Gaussian vertical profile of scale height H = thickness * r: the column
  // through the slab is sqrt(2pi) H rho / sin(i), normalized so that a face-on
  // ray of density 1 has tau = uDiskDensity.
  float tau   = uDiskDensity * dens * win * graze;
  float alpha = 1.0 - exp(-tau);

  // relativistic shift: emitter orbit x observer motion
  float g  = shiftFactor(r, Lreal) * obsShift;
  gOut     = g;

  float Tem  = diskTemp(r, rin);
  float Tobs = Tem * pow(max(g, 1e-3), uRedshift);
  vec3  col  = blackbodyRGB(clamp(Tobs, 700.0, 46000.0));

  // Stefan-Boltzmann in the fluid frame, beamed by g^4 (dial-able).
  float I = diskFlux(r, rin) * uDiskBright * (0.55 + 0.85 * turb.y);
  I *= pow(max(g, 1e-3), 4.0 * uDoppler);

  return vec4(col * I, alpha);
}

// ===========================================================================
//  Integrator: RK4 on  u'' = 3 M u^2 - u   with y = (u, du/dphi)
// ===========================================================================
vec2 geoDeriv(vec2 y){ return vec2(y.y, 3.0 * y.x * y.x - y.x); }

vec2 rk4(vec2 y, float h){
  vec2 k1 = geoDeriv(y);
  vec2 k2 = geoDeriv(y + 0.5 * h * k1);
  vec2 k3 = geoDeriv(y + 0.5 * h * k2);
  vec2 k4 = geoDeriv(y + h * k3);
  return y + (h / 6.0) * (k1 + 2.0 * k2 + 2.0 * k3 + k4);
}

void main(){
  // ---- primary ray in the observer's local orthonormal frame ---------------
  vec2 ndc = vUv * 2.0 - 1.0;
  vec3 dir = normalize(uCamFwd
                     + uCamRight * (ndc.x * uTanHalfFov * uAspect)
                     + uCamUp    * (ndc.y * uTanHalfFov));

  float pixAngle = 2.0 * uTanHalfFov / uResolution.y;

  // Relativistic aberration for a moving observer. Correcting the direction
  // *before* integration is what makes the boost physical: it changes which
  // geodesic the pixel looks along, not just its brightness.
  float obsShift = 1.0;
  if (uObsBeta > 1e-4){
    float b  = min(uObsBeta, 0.985);
    float gm = 1.0 / sqrt(1.0 - b * b);
    vec3  bd = normalize(uObsBetaDir);
    vec3  bv = bd * b;
    float mu = dot(dir, bd);
    vec3  dPar = bd * mu, dPer = dir - dPar;
    // d_static = [ d_par - beta ] + d_perp/gamma, renormalized
    vec3  ds = normalize((dPar - bv) + dPer / gm);
    obsShift = 1.0 / max(gm * (1.0 - dot(bv, ds)), 1e-4);
    dir = ds;
  }

  float r0 = length(uCamPos);
  // Nudge the observer outside the horizon rather than dividing by zero.
  if (r0 < 2.02){ r0 = 2.02; }
  vec3  er = uCamPos / max(length(uCamPos), 1e-6);
  float f0 = 1.0 - 2.0 / r0;

  // Split the ray into radial / tangential parts of the static tetrad.
  float nr  = dot(dir, er);
  vec3  tv  = dir - er * nr;
  float nt  = length(tv);

  // Impact parameter b = L/E = r * n_t / sqrt(f), from the tetrad projection.
  float bImp = r0 * nt / sqrt(max(f0, 1e-6));
  float bCrit = 3.0 * sqrt(3.0);

  vec3 skyDir = dir;            // asymptotic direction, filled in below
  bool escaped = false, captured = false;
  int  steps = 0, crossings = 0;
  vec3 acc = vec3(0.0);
  float trans = 1.0;
  float gDbg = 1.0, rDbg = 0.0;
  vec3  pDbg3 = vec3(1.0, 0.0, 0.0);

  if (nt < 1e-6){
    // Purely radial ray: the (u,phi) chart degenerates. Outward escapes along
    // er, inward falls in. Equatorial crossings are measure-zero here.
    if (nr > 0.0){ escaped = true; skyDir = er; } else { captured = true; }
  } else {
    // ---- orbital-plane frame -----------------------------------------------
    vec3 e1 = er;
    vec3 e2 = tv / nt;
    vec3 Lhat = normalize(cross(e1, e2));   // traced-ray angular momentum axis
    vec3 Lreal = -bImp * Lhat;              // physical photon: opposite sense

    // Height above the disk plane is  y(phi) = A cos(phi - phi0) / u, so the
    // equatorial crossings sit exactly at phi0 + pi/2 + k*pi. No root finding.
    float ay = dot(e1, DISK_AXIS), by = dot(e2, DISK_AXIS);
    float amp = sqrt(ay * ay + by * by);
    float ph0 = atan(by, ay);

    vec2  y   = vec2(1.0 / r0, -nr * sqrt(max(f0, 1e-6)) / (r0 * nt));
    float phi = 0.0;
    int   maxS = min(uSteps, MAX_STEPS);

    for (int i = 0; i < MAX_STEPS; ++i){
      if (i >= maxS) break;
      steps = i + 1;

      // Adaptive step: cap the fractional change in u so that near-radial rays
      // race outward in a few steps while near-critical rays stay resolved.
      float h = min(uDphi, 0.24 * y.x / max(abs(y.y), 1e-9));
      h = max(h, 1.0e-6);

      vec2  y0 = y;
      float p0 = phi;
      y   = rk4(y, h);
      phi = p0 + h;

      if (y.x >= 0.4999){ captured = true; break; }        // crossed r = 2M
      if (y.x <= U_ESCAPE){                                 // out to infinity
        escaped = true;
        vec3 dp = -y0.y * (cos(p0) * e1 + sin(p0) * e2)
                +  y0.x * (-sin(p0) * e1 + cos(p0) * e2);
        skyDir = normalize(dp);
        break;
      }

      // ---- equatorial crossing between p0 and phi -------------------------
      // View 7 is a pure capture-geometry mask, so the disk is skipped there:
      // an optically thick disk triggers the transmittance early-out below,
      // which is right for beauty rendering but would leave absorbed pixels
      // flagged neither captured nor escaped, and paint them as sky.
      if (uDebug != 7 && crossings < uMaxCross && amp > 1e-5){
        float sa = cos(p0  - ph0);
        float sb = cos(phi - ph0);
        if (sa * sb < 0.0){
          // exact crossing angle, then Hermite interpolation of u across the step
          float k  = floor((p0 - ph0 - HALF_PI) / PI) + 1.0;
          float pc = ph0 + HALF_PI + k * PI;
          float t  = clamp((pc - p0) / h, 0.0, 1.0);
          float t2 = t * t, t3 = t2 * t;
          float h00 =  2.0*t3 - 3.0*t2 + 1.0, h10 =      t3 - 2.0*t2 + t;
          float h01 = -2.0*t3 + 3.0*t2,       h11 =      t3 -     t2;
          float uc  = h00*y0.x + h10*h*y0.y + h01*y.x + h11*h*y.y;
          float duc = (( 6.0*t2 - 6.0*t)*y0.x + ( 3.0*t2 - 4.0*t + 1.0)*h*y0.y
                     + (-6.0*t2 + 6.0*t)*y.x  + ( 3.0*t2 - 2.0*t      )*h*y.y) / h;
          if (uc > 1e-6){
            float rc = 1.0 / uc;
            if (rc > uDiskInner * 0.9 && rc < uDiskOuter * 1.05){
              vec3 pc3 = rc * (cos(pc) * e1 + sin(pc) * e2);
              float gg;
              vec4 em = shadeCrossing(pc3, rc, uc, duc, amp, Lreal, obsShift, gg);
              if (em.w > 1e-5){
                acc  += trans * em.rgb * em.w;
                trans *= (1.0 - em.w);
                if (crossings == 0){ gDbg = gg; rDbg = rc; pDbg3 = pc3; }
              }
              crossings++;
            }
          }
          if (trans < 0.004) break;   // fully occluded: stop early
        }
      }
    }
    if (!escaped && !captured){
      // step budget exhausted -- only happens for rays winding at b ~ b_c,
      // which belong to the shadow edge anyway
      vec3 dp = -y.y * (cos(phi) * e1 + sin(phi) * e2)
              +  y.x * (-sin(phi) * e1 + cos(phi) * e2);
      skyDir = normalize(dp);
    }
  }

  // ---- background sky ------------------------------------------------------
  // Screen-space spread of the escape direction is the correct filter width for
  // the star field: near the critical curve neighbouring pixels look at wildly
  // different parts of the sky, and without this the stars alias violently.
  // Evaluated here, at uniform control flow, never inside the loop.
  vec3 sdx = dFdx(skyDir), sdy = dFdy(skyDir);
  float fw = clamp(max(length(sdx), length(sdy)), pixAngle, 40.0 * pixAngle);

  float skyShift = obsShift / sqrt(max(f0, 1e-4));

  vec3 col = acc;
  if (!captured && trans > 0.004){
    vec3 sd = rotAxis(skyDir, GAL_POLE, uSkyRot);
    vec3 sky = skyRadiance(sd, fw, uStarBright, uGalaxyBright);
    sky *= pow(max(skyShift, 1e-3), 4.0 * uDoppler);
    col += trans * sky;
  }

  // ---- debug views ---------------------------------------------------------
  if (uDebug >= 4){
    int maxS = min(uSteps, MAX_STEPS);
    if (uDebug == 4){
      col = heatmap(float(steps) / float(maxS));
    } else if (uDebug == 5){
      float c = float(crossings);
      col = captured && crossings == 0 ? vec3(0.02)
          : mix(vec3(0.02, 0.03, 0.06), heatmap(clamp(c / 4.0, 0.0, 1.0)), step(0.5, c));
    } else if (uDebug == 6){
      float lg = clamp(log2(max(gDbg, 1e-3)) * 1.6 + 0.5, 0.0, 1.0);
      col = crossings > 0 ? heatmap(1.0 - lg) : vec3(0.015);
    } else if (uDebug == 7){
      // Capture mask + analytic critical curve. Captured pixels are exactly
      // black; everything else is definitely not. The orange ring is drawn from
      // the closed-form b_c = 3*sqrt(3)M, *not* from the integration, so if the
      // two disagree the integrator is wrong and it is immediately visible.
      if (captured){
        col = vec3(0.0);
      } else {
        col = vec3(0.055, 0.075, 0.145)
            + vec3(0.0, 0.30, 0.52) * smoothstep(bCrit, bCrit * 2.6, bImp) * 0.5;
      }
      // Fixed width in units of b, NOT scaled by fw: fw diverges near the
      // critical curve, which would smear this reference marker into a wide
      // annulus and hide the very edge it is meant to measure.
      const float ringW = 0.05;
      col += vec3(1.0, 0.66, 0.26) * exp(-pow((bImp - bCrit) / ringW, 2.0));
    } else if (uDebug == 8){
      vec3 sd = rotAxis(skyDir, GAL_POLE, uSkyRot);
      col = captured ? vec3(0.0) : skyRadiance(sd, fw, uStarBright, uGalaxyBright);
      if (!captured){
        float lat = asin(clamp(sd.y, -1.0, 1.0)), lon = atan(sd.z, sd.x);
        float gl = gridLine(lat, PI / 12.0, fw * 2.0) + gridLine(lon, PI / 12.0, fw * 2.0);
        col += vec3(0.10, 0.55, 0.95) * clamp(gl, 0.0, 1.0) * 0.85;
      }
    } else if (uDebug == 9){
      col = acc * 0.9;
      if (crossings > 0){
        float rr = rDbg;
        float band = gridLine(log(max(rr, 0.1)), 0.2231435, fw * 3.0); // e^0.223 ~ 1.25x
        vec3 pd = pDbg3;
        float az = atan(dot(pd, cross(DISK_AXIS, normalize(vec3(1.0, 0.0, 0.0)))),
                        dot(pd, normalize(vec3(1.0, 0.0, 0.0))));
        band += gridLine(az, PI / 12.0, fw * 3.0);
        col += vec3(0.15, 0.75, 1.0) * clamp(band, 0.0, 1.0) * 0.55;
        col += vec3(1.0, 0.45, 0.15) * exp(-pow((rr - 6.0) * 3.2, 2.0)) * 0.8;  // ISCO
        col += vec3(0.4, 0.9, 1.0)  * exp(-pow((rr - 3.0) * 3.2, 2.0)) * 0.8;   // r_ph
      }
    }
  }

  if (any(isnan(col)) || any(isinf(col))) col = vec3(0.0);
  fragColor = vec4(max(col, 0.0), 1.0);
}
