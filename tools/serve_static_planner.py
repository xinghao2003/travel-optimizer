"""Serve only the production files, without proxies or API routes."""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class StaticFiles(SimpleHTTPRequestHandler):
    # Windows registry MIME settings can otherwise label .js as text/plain,
    # which browsers correctly refuse for module scripts and workers.
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, '.js': 'text/javascript', '.mjs': 'text/javascript'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=5176)
    args = parser.parse_args()
    directory = Path(__file__).resolve().parents[1] / 'app/dist'
    if not (directory / 'index.html').is_file():
        parser.error('Build the production artifact first: npm --prefix app run build')
    with ThreadingHTTPServer(('127.0.0.1', args.port), partial(StaticFiles, directory=directory)) as server:
        print(f'Static Planner: http://127.0.0.1:{server.server_port}/', flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
