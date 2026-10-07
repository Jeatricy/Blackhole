#!/usr/bin/env python3
"""Generate assets/audio/gargantua-drone.wav -- a seamless ambient loop.

Pure stdlib, no numpy. The loop is seamless *by construction* rather than by
crossfading: every component is periodic in the buffer length, because

  * drone partials sit on exact integer multiples of the loop fundamental
    f0 = sr / N, as do their amplitude LFOs;
  * the noise bed is synthesized in the frequency domain and inverse-FFT'd,
    which makes it inherently circular.

N is a power of two so the hand-rolled radix-2 IFFT applies.

    python3 tools/make_audio.py [--seconds 23.8] [--rate 22050]
"""
from __future__ import annotations

import argparse
import cmath
import math
import random
import struct
import wave
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "assets" / "audio" / "gargantua-drone.wav"


def ifft(a: list[complex]) -> list[complex]:
    """In-place iterative radix-2 inverse FFT (unnormalized conjugate form)."""
    n = len(a)
    if n & (n - 1):
        raise ValueError("length must be a power of two")
    # bit-reversal permutation
    j = 0
    for i in range(1, n):
        bit = n >> 1
        while j & bit:
            j ^= bit
            bit >>= 1
        j |= bit
        if i < j:
            a[i], a[j] = a[j], a[i]
    length = 2
    while length <= n:
        ang = 2 * math.pi / length          # +2pi -> inverse transform
        wl = cmath.exp(1j * ang)
        for i in range(0, n, length):
            w = 1 + 0j
            half = length >> 1
            for k in range(i, i + half):
                u = a[k]
                v = a[k + half] * w
                a[k] = u + v
                a[k + half] = u - v
                w *= wl
        length <<= 1
    return a


def noise_bed(n: int, sr: int, rng: random.Random,
              lo: float, hi: float, tilt: float) -> list[float]:
    """Circular band-limited noise: shaped magnitude spectrum, random phase."""
    spec = [0j] * n
    half = n // 2
    for k in range(1, half):
        f = k * sr / n
        if f < lo * 0.25 or f > hi * 4.0:
            continue
        # band shape: soft skirts either side of [lo, hi], then a 1/f^tilt tilt
        env = 1.0
        if f < lo:
            env *= (f / lo) ** 2
        if f > hi:
            env *= (hi / f) ** 2
        env *= (lo / f) ** tilt
        if env < 1e-6:
            continue
        ph = rng.uniform(0, 2 * math.pi)
        spec[k] = env * cmath.exp(1j * ph)
        spec[n - k] = spec[k].conjugate()      # keep the result real
    out = ifft(spec)
    return [c.real for c in out]


def normalize(x: list[float], peak: float) -> None:
    m = max((abs(v) for v in x), default=0.0)
    if m > 0:
        g = peak / m
        for i, v in enumerate(x):
            x[i] = v * g


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--rate", type=int, default=22050)
    ap.add_argument("--log2n", type=int, default=19, help="buffer = 2**log2n samples")
    ap.add_argument("--seed", type=int, default=20240501)
    ap.add_argument("--out", type=Path, default=OUT)
    a = ap.parse_args()

    sr, n = a.rate, 1 << a.log2n
    f0 = sr / n                                  # loop fundamental
    rng = random.Random(a.seed)
    print(f"buffer {n} samples @ {sr} Hz = {n / sr:.2f} s   (f0 = {f0:.4f} Hz)")

    # ---- noise beds --------------------------------------------------------
    print("synthesizing noise beds (inverse FFT)…")
    sub = noise_bed(n, sr, rng, 28.0, 90.0, 0.35)
    mid = noise_bed(n, sr, rng, 180.0, 900.0, 0.85)
    air = noise_bed(n, sr, rng, 1400.0, 6000.0, 1.15)
    normalize(sub, 1.0); normalize(mid, 1.0); normalize(air, 1.0)

    # ---- drone partials ----------------------------------------------------
    # Snap every frequency (and every LFO rate) to an exact multiple of f0, so
    # the whole mix is periodic in exactly n samples.
    def snap(f: float) -> float:
        return max(1.0, round(f / f0)) * f0

    partials = [
        (snap(34.65), 0.50, snap(0.031), 0.30),   # C1-ish fundamental
        (snap(51.91), 0.30, snap(0.043), 0.34),   # fifth
        (snap(69.30), 0.20, snap(0.027), 0.28),   # octave
        (snap(103.83), 0.13, snap(0.037), 0.40),
        (snap(138.59), 0.075, snap(0.019), 0.45),
        (snap(155.56), 0.065, snap(0.053), 0.50),  # minor sixth, unsettling
        (snap(207.65), 0.045, snap(0.023), 0.55),
        (snap(311.13), 0.022, snap(0.041), 0.60),
    ]
    print(f"{len(partials)} drone partials")

    print("mixing…")
    left: list[float] = [0.0] * n
    right: list[float] = [0.0] * n
    two_pi = 2 * math.pi
    for idx, (f, amp, lfo, depth) in enumerate(partials):
        ph = rng.uniform(0, two_pi)
        lph = rng.uniform(0, two_pi)
        pan = 0.5 + 0.42 * math.sin(idx * 1.37)      # spread across the field
        dw = two_pi * f / sr
        dl = two_pi * lfo / sr
        for i in range(n):
            env = 1.0 - depth + depth * (0.5 + 0.5 * math.sin(lph + dl * i))
            s = amp * env * math.sin(ph + dw * i)
            left[i] += s * (1.0 - pan)
            right[i] += s * pan

    # noise beds, decorrelated by a circular shift (still perfectly periodic)
    shift = n // 3
    for i in range(n):
        j = (i + shift) % n
        nl = 0.30 * sub[i] + 0.115 * mid[i] + 0.030 * air[i]
        nr = 0.30 * sub[j] + 0.115 * mid[j] + 0.030 * air[j]
        left[i] += nl
        right[i] += nr

    # ---- soft saturation + normalize --------------------------------------
    print("saturating…")
    for buf in (left, right):
        for i, v in enumerate(buf):
            buf[i] = math.tanh(v * 1.15)
    normalize(left, 0.72); normalize(right, 0.72)

    a.out.parent.mkdir(parents=True, exist_ok=True)
    print(f"writing {a.out}")
    with wave.open(str(a.out), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(sr)
        frames = bytearray()
        for i in range(n):
            frames += struct.pack("<hh",
                                  int(max(-1.0, min(1.0, left[i])) * 32767),
                                  int(max(-1.0, min(1.0, right[i])) * 32767))
        w.writeframes(bytes(frames))

    size = a.out.stat().st_size
    print(f"done: {size / 1024 / 1024:.2f} MiB, {n / sr:.2f} s seamless loop")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
