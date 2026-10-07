"""Render reference stills for each preset at high quality.

    python3 tests/render_stills.py [port] [outdir] [width] [height]
"""
import asyncio
import base64
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import websockets
from run_tests import CDP, launch, page_ws, wait_ready

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8099
OUT = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("/tmp/stills")
W = int(sys.argv[3]) if len(sys.argv) > 3 else 800
H = int(sys.argv[4]) if len(sys.argv) > 4 else 450
NAMES = ["iconic", "edge-on", "polar", "plunge"]


async def main():
    OUT.mkdir(parents=True, exist_ok=True)
    proc, prof, port = await launch(W, H)
    async with websockets.connect(page_ws(port), max_size=256 * 1024 * 1024,
                                  ping_interval=None) as ws:
        cdp = CDP(ws)
        for m in ("Runtime.enable", "Page.enable", "Log.enable"):
            await cdp.send(m)
        await cdp.send("Emulation.setDeviceMetricsOverride", width=W, height=H,
                       deviceScaleFactor=1, mobile=False)
        # renderScale 1.0 with the HIGH tier: full internal resolution
        await cdp.send("Page.navigate",
                       url=f"http://127.0.0.1:{PORT}/?quality=high&p.renderScale=1&paused=1&t=7")
        await wait_ready(cdp)

        for i, nm in enumerate(NAMES):
            await cdp.eval(f"GARGANTUA.setPreset({i},true)", awaitp=False)
            d = await asyncio.wait_for(
                cdp.eval("GARGANTUA.renderFrame({hideHud:true})"), timeout=900)
            p = OUT / f"{i}-{nm}.png"
            p.write_bytes(base64.b64decode(d.split(",", 1)[1]))
            print(f"  {p}", flush=True)

        # one diagnostic still: the capture mask with the analytic b_c ring
        await cdp.eval("GARGANTUA.setPreset(0,true)", awaitp=False)
        await cdp.eval("GARGANTUA.setView(7)", awaitp=False)
        d = await asyncio.wait_for(cdp.eval("GARGANTUA.renderFrame({hideHud:true})"),
                                   timeout=900)
        (OUT / "9-view7-capture-mask.png").write_bytes(base64.b64decode(d.split(",", 1)[1]))
        print(f"  {OUT}/9-view7-capture-mask.png", flush=True)

        print("console:", cdp.console[:5], flush=True)
        print("exceptions:", cdp.exceptions[:5], flush=True)
    proc.kill()


asyncio.run(main())
