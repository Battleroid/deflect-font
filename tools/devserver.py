"""Dev server for the game: serves game/ and accepts screenshots.

The browser pane this was built in is a narrow strip, far too small to judge a
full-screen game from. This serves the site as usual and adds one extra route:

    POST /__shot/<name>.png     body = raw PNG bytes, written to --out

so the page can render its canvas at whatever resolution we like and post the
result back to disk, where it can be looked at properly.

    python tools/devserver.py [port] [--out DIR]

Only for local development; nothing here is published.
"""

import argparse
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "game")
OUT = os.path.abspath(".")


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=os.path.abspath(ROOT), **kw)

    def end_headers(self):
        # never cache during development
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def do_POST(self):
        if not self.path.startswith("/__shot/"):
            self.send_error(404)
            return
        name = os.path.basename(self.path[len("/__shot/"):]) or "shot.png"
        if not name.endswith(".png"):
            name += ".png"
        length = int(self.headers.get("Content-Length", 0))
        data = self.rfile.read(length)
        path = os.path.join(OUT, name)
        with open(path, "wb") as fh:
            fh.write(data)
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.end_headers()
        self.wfile.write(("%d bytes -> %s" % (len(data), path)).encode())
        sys.stderr.write("shot: %s (%d bytes)\n" % (path, len(data)))

    def log_message(self, *a):
        pass


def main():
    global OUT
    ap = argparse.ArgumentParser()
    ap.add_argument("port", nargs="?", type=int, default=8173)
    ap.add_argument("--out", default=".")
    args = ap.parse_args()
    OUT = os.path.abspath(args.out)
    os.makedirs(OUT, exist_ok=True)
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print("serving %s on http://127.0.0.1:%d  (shots -> %s)" % (ROOT, args.port, OUT), flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
