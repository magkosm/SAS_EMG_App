#!/usr/bin/env python3
"""Serve this folder on http://localhost:<port> with caching disabled.

Plain `python3 -m http.server` lets Chrome reuse stale copies of updated .js files,
which can leave the app half-updated and broken. Every response here says no-store.
"""
import http.server
import os
import sys


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8040
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    http.server.ThreadingHTTPServer(("127.0.0.1", port), NoCacheHandler).serve_forever()
