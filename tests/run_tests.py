#!/usr/bin/env python3
"""Headless acceptance tests for GARGANTUA.

Drives Chrome over the DevTools Protocol: boots the page, asserts the console is
clean, then checks the *image* rather than just the absence of exceptions --
non-black frame, a real shadow where the shadow belongs, a disk brighter than
the sky, all ten debug views, all four presets, all three quality tiers,
interaction, persistence, resize and context-loss recovery.

    python3 tests/run_tests.py [--port 8099] [--keep-shots]

Requires: google-chrome (or chromium), python3 -m pip install websockets
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import contextlib
import io
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import websockets
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SHOTS = ROOT / "tests" / "shots"
SCALE = 0.30          # renderScale used throughout (SwiftShader has no GPU)

CHROME_CANDIDATES = [
    "google-chrome", "google-chrome-stable", "chromium", "chromium-browser",
    "/usr/bin/google-chrome", "/usr/bin/chromium",
]


def find_chrome() -> str:
    for c in CHROME_CANDIDATES:
        p = shutil.which(c) or (c if Path(c).exists() else None)
        if p:
            return p
    raise SystemExit("no chrome/chromium binary found")


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class CDP:
    """Minimal DevTools Protocol client."""

    def __init__(self, ws):
        self.ws = ws
        self._id = 0
        self._pending: dict[int, asyncio.Future] = {}
        self.console: list[str] = []      # console.error / console.warn
        self.exceptions: list[str] = []   # uncaught throws
        self._task = asyncio.create_task(self._reader())

    async def _reader(self):
        try:
            async for raw in self.ws:
                msg = json.loads(raw)
                if "id" in msg:
                    fut = self._pending.pop(msg["id"], None)
                    if fut and not fut.done():
                        fut.set_result(msg)
                else:
                    self._event(msg)
        except Exception:
            pass

    def _event(self, msg):
        m = msg.get("method", "")
        p = msg.get("params", {})
        if m == "Runtime.consoleAPICalled":
            if p.get("type") in ("error", "warning", "assert"):
                args = " ".join(str(a.get("value", a.get("description", "")))
                                for a in p.get("args", []))
                self.console.append(f'{p["type"]}: {args}')
        elif m == "Runtime.exceptionThrown":
            d = p.get("exceptionDetails", {})
            txt = d.get("exception", {}).get("description") or d.get("text", "?")
            self.exceptions.append(str(txt).split("\n")[0])
        elif m == "Log.entryAdded":
            e = p.get("entry", {})
            if e.get("level") in ("error", "warning"):
                self.console.append(f'{e.get("source")}/{e.get("level")}: {e.get("text")}')

    async def send(self, method, **params):
        self._id += 1
        i = self._id
        fut = asyncio.get_running_loop().create_future()
        self._pending[i] = fut
        await self.ws.send(json.dumps({"id": i, "method": method, "params": params}))
        msg = await asyncio.wait_for(fut, timeout=900)
        if "error" in msg:
            raise RuntimeError(f'{method}: {msg["error"]}')
        return msg.get("result", {})

    async def eval(self, expr, awaitp=True):
        r = await self.send("Runtime.evaluate", expression=expr, awaitPromise=awaitp,
                            returnByValue=True, userGesture=True)
        if r.get("exceptionDetails"):
            d = r["exceptionDetails"]
            raise RuntimeError(d.get("exception", {}).get("description") or d.get("text"))
        return r.get("result", {}).get("value")

    async def screenshot(self) -> Image.Image:
        r = await self.send("Page.captureScreenshot", format="png", fromSurface=True)
        return Image.open(io.BytesIO(base64.b64decode(r["data"]))).convert("RGB")


# ---------------------------------------------------------------------------
# image analysis
# ---------------------------------------------------------------------------
def lum(px) -> float:
    return (0.2126 * px[0] + 0.7152 * px[1] + 0.0722 * px[2]) / 255.0


def analyze(img: Image.Image) -> dict:
    small = img.resize((160, 90), Image.BILINEAR)
    w, h = small.size
    d = list(small.getdata())
    L = [lum(p) for p in d]
    n = len(L)
    mean = sum(L) / n
    mx = max(L)
    var = sum((x - mean) ** 2 for x in L) / n

    # centre patch: with the hole framed, this must contain the shadow
    cx0, cx1 = int(w * 0.42), int(w * 0.58)
    cy0, cy1 = int(h * 0.40), int(h * 0.60)
    centre = [L[y * w + x] for y in range(cy0, cy1) for x in range(cx0, cx1)]
    centre_min = min(centre)

    # colour: the disk should be warm somewhere (Doppler-blue on one limb too)
    warm = sum(1 for p in d if p[0] > 60 and p[0] > p[2] + 18)
    bright = sum(1 for x in L if x > 0.35)

    return {
        "mean": mean, "max": mx, "var": var, "std": var ** 0.5,
        "centre_min": centre_min,
        "coverage": sum(1 for x in L if x > 0.02) / n,
        "warm_frac": warm / n, "bright_frac": bright / n,
        "size": img.size,
    }


class Results:
    def __init__(self):
        self.rows: list[tuple[bool, str, str]] = []

    def check(self, ok: bool, name: str, detail: str = "") -> bool:
        self.rows.append((bool(ok), name, detail))
        mark = "PASS" if ok else "FAIL"
        print(f"  [{mark}] {name}" + (f"  — {detail}" if detail else ""), flush=True)
        return bool(ok)

    @property
    def failed(self):
        return [r for r in self.rows if not r[0]]

    def summary(self) -> int:
        n = len(self.rows)
        bad = self.failed
        print("\n" + "=" * 68)
        print(f"  {n - len(bad)}/{n} checks passed")
        if bad:
            print("  failures:")
            for _, name, detail in bad:
                print(f"    - {name} {detail}")
        print("=" * 68)
        return 1 if bad else 0


# ---------------------------------------------------------------------------
# chrome plumbing
# ---------------------------------------------------------------------------
async def launch(width, height, port=None):
    port = port or free_port()
    prof = tempfile.mkdtemp(prefix="gargantua-prof-")
    args = [
        find_chrome(), "--headless=new", f"--remote-debugging-port={port}",
        f"--user-data-dir={prof}", "--no-sandbox", "--no-first-run",
        "--disable-dev-shm-usage", "--disable-extensions", "--mute-audio",
        "--hide-scrollbars", "--no-default-browser-check",
        f"--window-size={width},{height}",
        # SwiftShader: no GPU in this environment, but a real WebGL2 stack with
        # EXT_color_buffer_float, which is what the pipeline actually needs.
        "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
        "--disable-frame-rate-limit", "about:blank",
    ]
    proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    import urllib.request
    for _ in range(120):
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=1) as r:
                json.load(r)
                break
        except Exception:
            await asyncio.sleep(0.25)
    else:
        proc.kill()
        raise SystemExit("chrome did not expose a devtools endpoint")
    return proc, prof, port


def page_ws(port: int) -> str:
    """The websocket URL of the first page target."""
    import urllib.request
    for _ in range(80):
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=1) as r:
                for t in json.load(r):
                    if t.get("type") == "page" and t.get("webSocketDebuggerUrl"):
                        return t["webSocketDebuggerUrl"]
        except Exception:
            pass
        time.sleep(0.25)
    raise SystemExit("no page target")


async def wait_ready(cdp, timeout=300):
    """Wait for the module to evaluate, then for the app to produce two frames."""
    t0 = time.time()
    # the document may still be loading right after Page.navigate
    while time.time() - t0 < timeout:
        try:
            fatal = await cdp.eval(
                "document.getElementById('fatal') && "
                "!document.getElementById('fatal').classList.contains('hidden')"
                "? (document.getElementById('fatal-msg').textContent||'fatal') : ''",
                awaitp=False)
            if fatal:
                raise RuntimeError(f"fatal overlay: {fatal}")
            if await cdp.eval("!!window.GARGANTUA", awaitp=False):
                break
        except RuntimeError:
            raise
        except Exception:
            pass
        await asyncio.sleep(0.4)
    else:
        raise TimeoutError("window.GARGANTUA never appeared")

    # One frame is the correct bar: with ?paused=1 the loop deliberately stops
    # redrawing a static scene, so demanding two would never be satisfied.
    while time.time() - t0 < timeout:
        s = json.loads(await cdp.eval("JSON.stringify(GARGANTUA.state())", awaitp=False))
        if s["ready"] and s["frames"] >= 1:
            return s
        await asyncio.sleep(0.5)
    raise TimeoutError("never produced a frame")


async def settle(cdp, frames=3, timeout=180):
    """Wait for N further frames so animated content is definitely current."""
    start = json.loads(await cdp.eval("JSON.stringify(GARGANTUA.state())", awaitp=False))["frames"]
    t0 = time.time()
    while time.time() - t0 < timeout:
        s = json.loads(await cdp.eval("JSON.stringify(GARGANTUA.state())", awaitp=False))
        if s["frames"] >= start + frames:
            return s
        await asyncio.sleep(0.4)
    return json.loads(await cdp.eval("JSON.stringify(GARGANTUA.state())", awaitp=False))


# ---------------------------------------------------------------------------
# physics probes
# ---------------------------------------------------------------------------
SHADOW_JS = r"""(()=>{
  // Debug view 7 is the capture mask: captured pixels are exactly black, every
  // escaped pixel has a floor, the disk is skipped and ACES is bypassed. So
  // black-vs-not is an exact readout of the capture cross-section, and the
  // orange overlay marks the closed-form b_c = 3*sqrt(3)M independently.
  const a=window.__gargantuaApp, st=a.store;
  const v0=st.debug;
  st.setDebug(7); a.renderOnce();
  const c=a.canvas, s=2;
  const cv=document.createElement('canvas');
  cv.width=Math.max(8,c.width/s|0); cv.height=Math.max(8,c.height/s|0);
  const g=cv.getContext('2d',{willReadFrequently:true});
  g.drawImage(c,0,0,cv.width,cv.height);
  const W=cv.width,H=cv.height,d=g.getImageData(0,0,W,H).data;
  const at=(x,y)=>{const i=((y|0)*W+(x|0))*4; return [d[i],d[i+1],d[i+2]];};
  const L=(x,y)=>{const p=at(x,y);
    return (0.2126*p[0]+0.7152*p[1]+0.0722*p[2])/255;};
  const cx=W/2, cy=H/2, TH=0.02, N=144;

  // integrated capture edge: outermost black sample per ray (the thin b_c
  // overlay punches a bright annulus into the rim, so take the last black)
  let esum=0,emin=1e9,emax=0,en=0;
  for(let k=0;k<N;k++){
    const th=k*2*Math.PI/N, ux=Math.cos(th), uy=Math.sin(th);
    let last=0;
    for(let t=0;t<Math.min(cx,cy);t+=0.5){
      const x=cx+ux*t, y=cy+uy*t;
      if(x<0||y<0||x>=W||y>=H) break;
      if(L(x,y)<TH) last=t;
    }
    if(last>0){esum+=last;emin=Math.min(emin,last);emax=Math.max(emax,last);en++;}
  }
  const edge=en?esum/en:0;

  // analytic ring radius: azimuthal mean of (R-B), which isolates the orange
  // overlay against the blue escaped base
  let best=0,bestv=-1e9;
  const prof=[];
  for(let t=0;t<Math.min(cx,cy);t+=0.5){
    let s2=0,n2=0;
    for(let k=0;k<N;k++){
      const th=k*2*Math.PI/N;
      const x=cx+Math.cos(th)*t, y=cy+Math.sin(th)*t;
      if(x<0||y<0||x>=W||y>=H) continue;
      const p=at(x,y); s2+=p[0]-p[2]; n2++;
    }
    if(n2){const v=s2/n2; prof.push([t,v]); if(v>bestv){bestv=v;best=t;}}
  }
  let num=0,den=0;
  for(const [t,v] of prof) if(Math.abs(t-best)<=6 && v>0){num+=t*v;den+=v;}
  const ring=den?num/den:best;

  // centroid of the black region, to confirm the shadow is centred
  let sx=0,sy=0,n=0;
  for(let y=0;y<H;y++)for(let x=0;x<W;x++) if(L(x,y)<TH){sx+=x;sy+=y;n++;}

  const R=st.cam.r, fov=st.params.fov*Math.PI/180;
  const sinA=(3*Math.sqrt(3)/R)*Math.sqrt(Math.max(1-2/R,0));
  const pred=Math.tan(Math.asin(Math.min(sinA,1)))/Math.tan(fov/2)*(H/2);

  st.setDebug(v0); a.renderOnce();
  return JSON.stringify({
    edge_px:+edge.toFixed(2), ring_px:+ring.toFixed(2), pred_px:+pred.toFixed(2),
    circularity:+(emin/Math.max(emax,1e-9)).toFixed(4),
    offset:[+(n?sx/n-cx:0).toFixed(2), +(n?sy/n-cy:0).toFixed(2)],
    dark_frac:+(n/(W*H)).toFixed(4), r_obs:+R.toFixed(2),
  });
})()"""


async def shadow_geometry(cdp) -> dict:
    """Capture cross-section vs the closed-form Schwarzschild result."""
    return json.loads(await cdp.eval(SHADOW_JS, awaitp=False))


async def disk_asymmetry(cdp) -> float:
    """
    Mean luminance of the left half minus the right half over the disk band.
    Doppler beaming makes the approaching limb far brighter, so |asymmetry|
    should be large, and it must flip sign when the spin sense flips.
    """
    js = """(()=>{
      const a=window.__gargantuaApp;
      a.renderOnce();          // draw and read in one task: the drawing buffer
      const c=a.canvas;        // is cleared after compositing otherwise
      const cv=document.createElement('canvas');
      cv.width=Math.max(2,c.width>>2); cv.height=Math.max(2,c.height>>2);
      const g=cv.getContext('2d',{willReadFrequently:true});
      g.drawImage(c,0,0,cv.width,cv.height);
      const d=g.getImageData(0,0,cv.width,cv.height).data;
      const W=cv.width,H=cv.height;
      let l=0,r=0,nl=0,nr=0;
      for(let y=(H*0.32)|0;y<(H*0.68)|0;y++)for(let x=0;x<W;x++){
        const i=(y*W+x)*4;
        const L=(0.2126*d[i]+0.7152*d[i+1]+0.0722*d[i+2])/255;
        if(x<W*0.42){l+=L;nl++;} else if(x>W*0.58){r+=L;nr++;}
      }
      return (l/Math.max(nl,1))-(r/Math.max(nr,1));
    })()"""
    return float(await cdp.eval(js, awaitp=False))


# ---------------------------------------------------------------------------
# the suite
# ---------------------------------------------------------------------------
async def run(base: str, width: int, height: int, keep: bool) -> int:
    R = Results()
    SHOTS.mkdir(parents=True, exist_ok=True)
    proc, prof, port = await launch(width, height)
    ws_url = page_ws(port)

    async with websockets.connect(ws_url, max_size=64 * 1024 * 1024,
                                  ping_interval=None) as ws:
        cdp = CDP(ws)
        await cdp.send("Runtime.enable")
        await cdp.send("Log.enable")
        await cdp.send("Page.enable")
        await cdp.send("Emulation.setDeviceMetricsOverride",
                       width=width, height=height, deviceScaleFactor=1, mobile=False)

        # Page.captureScreenshot needs the browser compositor, which never
        # produces a frame under headless SwiftShader here (both fromSurface
        # modes time out). Reading the WebGL canvas directly is both reliable
        # and closer to what we actually want to assert: the shader output,
        # uncontaminated by HUD pixels.
        async def shot(name, timeout=300):
            d = await asyncio.wait_for(
                cdp.eval("GARGANTUA.renderFrame({hideHud:true})"), timeout=timeout)
            raw = base64.b64decode(d.split(",", 1)[1])
            img = Image.open(io.BytesIO(raw)).convert("RGB")
            if keep:
                (SHOTS / f"{name}.png").write_bytes(raw)
            return img

        # ---- 1. boot ------------------------------------------------------
        print("\n[1] boot / console")
        # renderScale is held low throughout: this runs on SwiftShader (no GPU),
        # and a per-pixel RK4 integrator at native resolution would take minutes
        # per frame. It exercises every code path at a cheaper pixel count.
        url = f"{base}/?quality=standard&p.renderScale={SCALE}&preset=iconic"
        await cdp.send("Page.navigate", url=url)
        t0 = time.time()
        try:
            st = await wait_ready(cdp)
            boot_ok = True
        except Exception as e:
            boot_ok = False
            st = {}
            print(f"    boot failed: {e}")
        R.check(boot_ok, "页面启动并产出帧", f"{time.time() - t0:.1f}s")
        if not boot_ok:
            for c in cdp.console[:10]:
                print("      console:", c)
            for c in cdp.exceptions[:10]:
                print("      throw:", c)
            proc.kill()
            shutil.rmtree(prof, ignore_errors=True)
            return R.summary()

        R.check(not cdp.exceptions, "无未捕获异常", "; ".join(cdp.exceptions[:3]))
        R.check(not cdp.console, "无 console 错误/警告", "; ".join(cdp.console[:3]))
        R.check(st.get("float") is True, "EXT_color_buffer_float 可用 (HDR)")
        R.check(not st.get("errors"), "应用内部无记录错误", "; ".join(st.get("errors", [])[:2]))

        # ---- 2. the image -------------------------------------------------
        print("\n[2] 首帧图像")
        img = await shot("01-iconic")
        a = analyze(img)
        print(f"    mean={a['mean']:.4f} max={a['max']:.3f} std={a['std']:.4f} "
              f"centre_min={a['centre_min']:.4f} warm={a['warm_frac']:.3f}")
        R.check(a["mean"] > 0.004, "非黑屏 (平均亮度 > 0.004)", f"mean={a['mean']:.4f}")
        R.check(a["max"] > 0.55, "存在高光 (吸积盘)", f"max={a['max']:.3f}")
        R.check(a["std"] > 0.02, "画面有结构而非纯色", f"std={a['std']:.4f}")
        R.check(a["centre_min"] < 0.012, "中心存在深黑视界阴影",
                f"centre_min={a['centre_min']:.4f}")
        R.check(a["warm_frac"] > 0.01, "存在高温暖色盘面", f"warm={a['warm_frac']:.3f}")

        # ---- 3. geodesics: shadow size vs analytic value -------------------
        print("\n[3] 测地线正确性")
        sg = await shadow_geometry(cdp)
        print("    " + json.dumps(sg))
        pred, ring, edge = sg["pred_px"], sg["ring_px"], sg["edge_px"]
        # the analytic b_c marker validates the impact parameter + projection
        ring_err = abs(ring - pred) / max(pred, 1e-9)
        R.check(ring_err < 0.03, "解析临界曲线 b_c 与投影自洽",
                f"{ring:.1f}px vs {pred:.1f}px ({ring_err * 100:.1f}%)")
        # the integrated capture edge validates the integrator itself. It lands
        # marginally inside b_c because rays with b just below b_c need
        # unbounded windings; the few that exhaust the step budget render as sky.
        edge_err = abs(edge - pred) / max(pred, 1e-9)
        R.check(edge_err < 0.08, "积分捕获边界符合 b_c = 3√3M 解析解",
                f"{edge:.1f}px vs {pred:.1f}px ({edge_err * 100:.1f}%)")
        R.check(edge <= ring * 1.01, "捕获边界不超出临界曲线 (物理上必须)",
                f"edge={edge:.1f} ring={ring:.1f}")
        R.check(sg["circularity"] > 0.93, "阴影为正圆 (Schwarzschild 球对称)",
                f"min/max={sg['circularity']:.3f}")
        R.check(abs(sg["offset"][0]) < 3 and abs(sg["offset"][1]) < 3,
                "阴影居中于视轴", f"offset={sg['offset']}")

        # Doppler beaming must be strong and must invert with the spin sense.
        asym_p = await disk_asymmetry(cdp)
        await cdp.eval("GARGANTUA.setParam('diskSpin',-1)", awaitp=False)
        asym_r = await disk_asymmetry(cdp)
        await cdp.eval("GARGANTUA.setParam('diskSpin',1)", awaitp=False)
        print(f"    asymmetry prograde={asym_p:+.4f} retrograde={asym_r:+.4f}")
        R.check(abs(asym_p) > 0.004, "Doppler 增亮产生明显左右不对称",
                f"Δ={asym_p:+.4f}")
        R.check(asym_p * asym_r < 0, "反转自旋后增亮侧翻转 (符号约定正确)",
                f"{asym_p:+.4f} -> {asym_r:+.4f}")

        # Doppler off -> asymmetry must collapse
        await cdp.eval("GARGANTUA.setParams({doppler:0,redshift:0})", awaitp=False)
        asym_off = await disk_asymmetry(cdp)
        await cdp.eval("GARGANTUA.setParams({doppler:1,redshift:1})", awaitp=False)
        R.check(abs(asym_off) < abs(asym_p) * 0.7, "关闭 Doppler 后不对称显著减小",
                f"{asym_off:+.4f} < {asym_p:+.4f}")

        # Higher-order images: raising IMAGE ORDER must add light near the ring.
        await cdp.eval("GARGANTUA.setParam('maxCross',1)", awaitp=False)
        m1 = analyze(await shot("03-order1"))["mean"]
        await cdp.eval("GARGANTUA.setParam('maxCross',4)", awaitp=False)
        m4 = analyze(await shot("04-order4"))["mean"]
        print(f"    mean luminance: n<=1 {m1:.5f}  n<=4 {m4:.5f}")
        R.check(m4 > m1 * 1.002, "提高 IMAGE ORDER 增加多次穿越贡献",
                f"{m1:.5f} -> {m4:.5f}")

        # ---- 4. presets ---------------------------------------------------
        print("\n[4] 四个视角预设")
        names = ["iconic", "edge-on", "polar", "plunge"]
        for i, nm in enumerate(names):
            # instant: the 1.5s tween is 6 rendered frames here, ~90s of
            # SwiftShader time for no extra coverage
            await cdp.eval(f"GARGANTUA.setPreset({i},true)", awaitp=False)
            im = await shot(f"05-preset-{i}-{nm}")
            an = analyze(im)
            ok = an["mean"] > 0.003 and an["max"] > 0.35 and an["std"] > 0.012
            R.check(ok, f"预设 {i} {nm.upper()} 正常成像",
                    f"mean={an['mean']:.4f} max={an['max']:.3f} std={an['std']:.4f}")

        await cdp.eval("GARGANTUA.setPreset(0,true)", awaitp=False)

        # ---- 5. debug views ------------------------------------------------
        print("\n[5] 0-9 调试视图")
        for v in range(10):
            await cdp.eval(f"GARGANTUA.setView({v})", awaitp=False)
            im = await shot(f"06-view-{v}")
            an = analyze(im)
            # every view must draw something with structure
            ok = an["mean"] > 0.002 and an["std"] > 0.004
            R.check(ok, f"视图 {v} 有效输出",
                    f"mean={an['mean']:.4f} std={an['std']:.4f}")
        await cdp.eval("GARGANTUA.setView(0)", awaitp=False)
        await settle(cdp, 2)

        # ---- 6. quality tiers ---------------------------------------------
        print("\n[6] 三档质量")
        for q in ["standard", "high", "cinematic"]:
            await cdp.eval(f"GARGANTUA.setQuality('{q}')", awaitp=False)
            s = json.loads(await cdp.eval("JSON.stringify(GARGANTUA.state())", awaitp=False))
            an = analyze(await shot(f"07-quality-{q}"))
            R.check(s["quality"] == q and an["mean"] > 0.003,
                    f"质量档 {q.upper()} 生效并成像",
                    f"internal={s['size']['internal']} mean={an['mean']:.4f}")
        await cdp.eval("GARGANTUA.setQuality('standard')", awaitp=False)
        await settle(cdp, 3)

        # ---- 7. all 21 parameters respond ----------------------------------
        print("\n[7] 21 项参数")
        pj = await cdp.eval("JSON.stringify(GARGANTUA.getParams())", awaitp=False)
        params = json.loads(pj)
        R.check(len(params) == 21, "参数数量为 21", f"got {len(params)}")
        # each param must round-trip through clamping
        bad = []
        for k in params:
            probe = await cdp.eval(
                f"(()=>{{const b=GARGANTUA.getParams()['{k}'];"
                f"const v=GARGANTUA.setParam('{k}',b);"
                f"return JSON.stringify([b,v]);}})()", awaitp=False)
            b, v = json.loads(probe)
            if abs(b - v) > 1e-6:
                bad.append(k)
        R.check(not bad, "所有参数可读写且钳位一致", ", ".join(bad))

        # a visible effect: exposure up must brighten the frame
        before = analyze(await shot("08-exposure-lo"))["mean"]
        await cdp.eval("GARGANTUA.setParam('exposure',3.2)", awaitp=False)
        after = analyze(await shot("09-exposure-hi"))["mean"]
        await cdp.eval("GARGANTUA.setParam('exposure',1.15)", awaitp=False)
        await settle(cdp, 2)
        R.check(after > before * 1.25, "EXPOSURE 参数改变画面亮度",
                f"{before:.4f} -> {after:.4f}")

        # turbulence must actually animate the disk
        f1 = await cdp.eval("GARGANTUA.setTime(0), GARGANTUA.renderFrame({hideHud:true})")
        f2 = await cdp.eval("GARGANTUA.setTime(9.5), GARGANTUA.renderFrame({hideHud:true})")
        R.check(f1 != f2, "时间推进改变盘面湍流 (动态盘)")

        # ---- 8. interaction ------------------------------------------------
        print("\n[8] 交互 / 快捷键")

        async def key(k, code=None, shift=False):
            mods = 8 if shift else 0
            for t in ("keyDown", "keyUp"):
                await cdp.send("Input.dispatchKeyEvent", type=t, key=k,
                               code=code or f"Key{k.upper()}", modifiers=mods,
                               windowsVirtualKeyCode=ord(k.upper()) if len(k) == 1 else 0)
            await asyncio.sleep(0.25)

        await key("3", code="Digit3")
        await settle(cdp, 2)
        v = json.loads(await cdp.eval("JSON.stringify(GARGANTUA.state())", awaitp=False))["view"]
        R.check(v == 3, "数字键切换调试视图", f"view={v}")
        await key("0", code="Digit0")
        await settle(cdp, 2)

        await key("c")
        await settle(cdp, 3)
        s = json.loads(await cdp.eval("JSON.stringify(GARGANTUA.state())", awaitp=False))
        R.check(s["cine"] is True, "C 进入电影镜头循环", f"shot={s['shot']}")
        await key("c")
        await settle(cdp, 2)

        await key("p")
        await asyncio.sleep(0.4)
        s = json.loads(await cdp.eval("JSON.stringify(GARGANTUA.state())", awaitp=False))
        R.check(s["paused"] is True, "P 暂停时间演化")
        await key("p")
        await asyncio.sleep(0.3)

        # The keyboard path uses the 1.5s tween, and dt is clamped to 0.1s per
        # frame (deliberately -- it stops the camera jumping after a tab switch),
        # so the tween needs >=15 rendered frames. Poll for completion instead of
        # sleeping: here a frame is seconds, not milliseconds.
        await key("2", code="Digit2", shift=True)
        for _ in range(90):
            await asyncio.sleep(0.6)
            if await cdp.eval("window.__gargantuaApp.rig.tween === null", awaitp=False):
                break
        cam = json.loads(await cdp.eval("JSON.stringify(GARGANTUA.state())", awaitp=False))["cam"]
        R.check(abs(cam["r"] - 19) < 2.5, "Shift+2 切到 EDGE-ON 预设", f"r={cam['r']:.2f}")
        await cdp.eval("GARGANTUA.setPreset(0,true)", awaitp=False)

        # Drag must orbit the camera. Hide the HUD first: on a narrow viewport
        # the readout and control panels nearly meet in the middle, so a drag at
        # the frame centre would land on a panel instead of the canvas.
        await cdp.eval("GARGANTUA.setHud(false)", awaitp=False)
        await asyncio.sleep(0.2)
        before = json.loads(await cdp.eval("JSON.stringify(GARGANTUA.state())", awaitp=False))["cam"]
        cx, cy = width // 2, height // 2
        await cdp.send("Input.dispatchMouseEvent", type="mousePressed", x=cx, y=cy,
                       button="left", clickCount=1, buttons=1)
        for i in range(1, 7):
            await cdp.send("Input.dispatchMouseEvent", type="mouseMoved",
                           x=cx + i * 14, y=cy + i * 4, button="left", buttons=1)
            await asyncio.sleep(0.05)
        await cdp.send("Input.dispatchMouseEvent", type="mouseReleased", x=cx + 84,
                       y=cy + 24, button="left", buttons=0)
        await settle(cdp, 5)
        after = json.loads(await cdp.eval("JSON.stringify(GARGANTUA.state())", awaitp=False))["cam"]
        moved = abs(after["phi"] - before["phi"]) + abs(after["theta"] - before["theta"])
        R.check(moved > 0.01, "鼠标拖拽经 OrbitControls 旋转视角", f"Δ={moved:.4f}")
        await cdp.eval("GARGANTUA.setHud(true)", awaitp=False)

        # ---- 9. screenshot API --------------------------------------------
        print("\n[9] 截图 / 自动化接口")
        png = await cdp.eval("GARGANTUA.renderFrame({width:640,height:360})")
        ok = isinstance(png, str) and png.startswith("data:image/png;base64,")
        if ok:
            raw = base64.b64decode(png.split(",", 1)[1])
            im = Image.open(io.BytesIO(raw)).convert("RGB")
            an = analyze(im)
            R.check(im.size == (640, 360), "renderFrame 按请求尺寸输出", f"{im.size}")
            R.check(an["mean"] > 0.003 and an["max"] > 0.3,
                    "截图内容非空", f"mean={an['mean']:.4f} max={an['max']:.3f}")
            if keep:
                im.save(SHOTS / "10-api-640x360.png")
        else:
            R.check(False, "renderFrame 返回 PNG dataURL")
            R.check(False, "截图内容非空")

        # a bigger, offscreen-sized capture must also work
        png2 = await cdp.eval("GARGANTUA.renderFrame({width:1280,height:720,time:6.0})")
        if isinstance(png2, str) and png2.startswith("data:image"):
            im2 = Image.open(io.BytesIO(base64.b64decode(png2.split(",", 1)[1]))).convert("RGB")
            an2 = analyze(im2)
            R.check(im2.size == (1280, 720) and an2["mean"] > 0.003,
                    "1280×720 离屏截图", f"mean={an2['mean']:.4f}")
            if keep:
                im2.save(SHOTS / "11-api-1280x720.png")
        else:
            R.check(False, "1280×720 离屏截图")

        # size must be restored afterwards
        s = json.loads(await cdp.eval("JSON.stringify(GARGANTUA.state())", awaitp=False))
        R.check(s["size"]["css"] == [width, height], "截图后恢复原尺寸",
                f"{s['size']['css']}")

        # ---- 10. persistence + URL state -----------------------------------
        print("\n[10] 状态持久化 / URL")
        await cdp.eval(f"GARGANTUA.setParams({{temp:15000,turbulence:0.9,renderScale:{SCALE}}})",
                       awaitp=False)
        await cdp.eval("GARGANTUA.setQuality('high')", awaitp=False)
        await settle(cdp, 3)
        link = await cdp.eval("window.__gargantuaApp.copyLink()")
        R.check("temp=15000" in link and "q=high" in link, "链接编码非默认参数",
                link.split("#")[-1][:96])
        await cdp.eval("window.__gargantuaApp.store.save()", awaitp=False)

        # Plain reload, no hash: this must come back purely from localStorage
        # (the low renderScale rides along inside the saved state).
        await cdp.send("Page.navigate", url=f"{base}/")
        st2 = await wait_ready(cdp)
        p2 = json.loads(await cdp.eval("JSON.stringify(GARGANTUA.getParams())", awaitp=False))
        R.check(abs(p2["temp"] - 15000) < 1 and st2["quality"] == "high",
                "重新加载后 localStorage 状态恢复",
                f"temp={p2['temp']} q={st2['quality']}")

        # A pasted link into a *running* instance is only a fragment change, so
        # the document never reloads -- it must still take effect.
        await cdp.eval(f"location.hash='q=standard&temp=4400&renderScale={SCALE}'", awaitp=False)
        await asyncio.sleep(1.2)
        p3 = json.loads(await cdp.eval("JSON.stringify(GARGANTUA.getParams())", awaitp=False))
        s3 = json.loads(await cdp.eval("JSON.stringify(GARGANTUA.state())", awaitp=False))
        R.check(abs(p3["temp"] - 4400) < 1 and s3["quality"] == "standard",
                "运行中粘贴链接即时生效 (hashchange)", f"temp={p3['temp']} q={s3['quality']}")

        # and on a genuine load the hash must beat localStorage
        await cdp.send("Page.navigate",
                       url=f"{base}/?nocache=1#q=cinematic&temp=9100&renderScale={SCALE}")
        await wait_ready(cdp)
        p4 = json.loads(await cdp.eval("JSON.stringify(GARGANTUA.getParams())", awaitp=False))
        s4 = json.loads(await cdp.eval("JSON.stringify(GARGANTUA.state())", awaitp=False))
        R.check(abs(p4["temp"] - 9100) < 1 and s4["quality"] == "cinematic",
                "URL hash 覆盖本地存储 (完整加载)", f"temp={p4['temp']} q={s4['quality']}")
        await cdp.eval("localStorage.clear()", awaitp=False)

        # ---- 11. resize / retina / mobile ----------------------------------
        print("\n[11] 尺寸 / Retina / 移动端")
        await cdp.send("Page.navigate", url=f"{base}/?quality=standard&p.renderScale={SCALE}")
        await wait_ready(cdp)
        await settle(cdp, 3)

        for (w, h, dpr, label) in [(900, 520, 1, "900×520"), (480, 900, 2, "480×900 @2dpr"),
                                   (1400, 620, 1, "1400×620")]:
            await cdp.send("Emulation.setDeviceMetricsOverride", width=w, height=h,
                           deviceScaleFactor=dpr, mobile=(w < 600))
            await asyncio.sleep(0.5)
            s = json.loads(await cdp.eval("JSON.stringify(GARGANTUA.state())", awaitp=False))
            an = analyze(await shot(f"12-resize-{w}x{h}"))
            ok = s["size"]["css"] == [w, h] and an["mean"] > 0.002 and not cdp.exceptions
            R.check(ok, f"{label} 自适应且成像",
                    f"internal={s['size']['internal']} mean={an['mean']:.4f}")

        await cdp.send("Emulation.setDeviceMetricsOverride", width=width, height=height,
                       deviceScaleFactor=1, mobile=False)
        await settle(cdp, 3)

        # touch input must orbit too
        await cdp.eval("GARGANTUA.setHud(false)", awaitp=False)
        await asyncio.sleep(0.2)
        before = json.loads(await cdp.eval("JSON.stringify(GARGANTUA.state())", awaitp=False))["cam"]
        cx, cy = width // 2, height // 2
        tp = lambda x, y: [{"x": x, "y": y, "radiusX": 12, "radiusY": 12, "id": 1}]
        with contextlib.suppress(Exception):
            await cdp.send("Input.dispatchTouchEvent", type="touchStart", touchPoints=tp(cx, cy))
            for i in range(1, 6):
                await cdp.send("Input.dispatchTouchEvent", type="touchMove",
                               touchPoints=tp(cx + i * 16, cy))
                await asyncio.sleep(0.06)
            await cdp.send("Input.dispatchTouchEvent", type="touchEnd", touchPoints=[])
        await settle(cdp, 4)
        after = json.loads(await cdp.eval("JSON.stringify(GARGANTUA.state())", awaitp=False))["cam"]
        R.check(abs(after["phi"] - before["phi"]) > 0.005, "触摸拖拽可旋转 (移动端)",
                f"Δφ={abs(after['phi'] - before['phi']):.4f}")
        await cdp.eval("GARGANTUA.setHud(true)", awaitp=False)

        # ---- 12. WebGL context loss / restore ------------------------------
        print("\n[12] WebGL 上下文丢失恢复")
        lost = await cdp.eval("""(async()=>{
          const c=window.__gargantuaApp.canvas;
          const gl=window.__gargantuaApp.renderer.three.getContext();
          const ext=gl.getExtension('WEBGL_lose_context');
          if(!ext) return 'no-ext';
          const before=window.__gargantuaApp.renderer.frame;
          ext.loseContext();
          await new Promise(r=>setTimeout(r,320));
          const wasLost=window.__gargantuaApp._lost===true;
          ext.restoreContext();
          for(let i=0;i<80;i++){
            await new Promise(r=>setTimeout(r,150));
            if(window.__gargantuaApp._lost===false &&
               window.__gargantuaApp.renderer.frame>before) break;
          }
          return JSON.stringify({wasLost, recovered:window.__gargantuaApp._lost===false,
                                 frames:window.__gargantuaApp.renderer.frame});
        })()""")
        if lost == "no-ext":
            R.check(True, "WEBGL_lose_context 不可用，跳过", "skipped")
        else:
            d = json.loads(lost)
            R.check(d["wasLost"], "捕获 webglcontextlost 事件")
            R.check(d["recovered"], "上下文恢复后继续渲染", f"frames={d['frames']}")
            an = analyze(await shot("13-after-context-restore"))
            R.check(an["mean"] > 0.002, "恢复后画面正常", f"mean={an['mean']:.4f}")

        # ---- 13. final console sweep ---------------------------------------
        print("\n[13] 全程日志汇总")
        # WebGL context loss legitimately logs; ignore only that.
        noise = [c for c in cdp.console
                 if "context" not in c.lower() and "lost" not in c.lower()]
        R.check(not cdp.exceptions, "全程无未捕获异常", "; ".join(cdp.exceptions[:3]))
        R.check(not noise, "全程无多余 console 错误/警告", "; ".join(noise[:3]))

    proc.terminate()
    with contextlib.suppress(Exception):
        proc.wait(timeout=6)
    proc.kill()
    shutil.rmtree(prof, ignore_errors=True)
    return R.summary()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=0, help="port of a running serve.py")
    ap.add_argument("--width", type=int, default=1024)
    ap.add_argument("--height", type=int, default=576)
    ap.add_argument("--keep-shots", action="store_true", default=True)
    a = ap.parse_args()

    srv = None
    port = a.port
    if not port:
        port = free_port()
        srv = subprocess.Popen([sys.executable, str(ROOT / "serve.py"), str(port)],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(1.2)
    base = f"http://127.0.0.1:{port}"
    print(f"GARGANTUA acceptance tests -> {base}  ({a.width}×{a.height})")
    try:
        rc = asyncio.run(run(base, a.width, a.height, a.keep_shots))
    finally:
        if srv:
            srv.terminate()
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
