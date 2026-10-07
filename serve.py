#!/usr/bin/env python3
"""Static server for GARGANTUA.

The project is build-free, but it is not file:// -free: ES modules and the
fetch() used to load .glsl sources both require a real HTTP origin.

    python3 serve.py            # http://127.0.0.1:8080
    python3 serve.py 9000       # custom port
    python3 serve.py 9000 0.0.0.0   # expose on the LAN (phone testing)
"""
from __future__ import annotations

import functools
import http.server
import socket
import socketserver
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript; charset=utf-8",
        ".mjs": "text/javascript; charset=utf-8",
        ".glsl": "text/plain; charset=utf-8",
        ".vert": "text/plain; charset=utf-8",
        ".frag": "text/plain; charset=utf-8",
        ".wasm": "application/wasm",
        ".wav": "audio/wav",
        ".ogg": "audio/ogg",
        ".json": "application/json; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".html": "text/html; charset=utf-8",
        ".svg": "image/svg+xml",
    }

    def end_headers(self) -> None:
        # Shader edits must show up on reload, so nothing is cached.
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Referrer-Policy", "no-referrer")
        super().end_headers()

    def log_message(self, fmt: str, *args) -> None:
        if "404" in (fmt % args):
            sys.stderr.write("  404  %s\n" % (args[0] if args else ""))


class Server(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    host = sys.argv[2] if len(sys.argv) > 2 else "127.0.0.1"
    handler = functools.partial(Handler, directory=str(ROOT))
    try:
        with Server((host, port), handler) as srv:
            shown = host if host != "0.0.0.0" else socket.gethostbyname(socket.gethostname())
            print(f"GARGANTUA  ->  http://{shown}:{port}/")
            print(f"serving     {ROOT}")
            print("Ctrl+C to stop")
            srv.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
    except OSError as e:
        print(f"cannot bind {host}:{port} — {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
