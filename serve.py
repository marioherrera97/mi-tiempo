"""Servidor local para probar Mi Tiempo: python serve.py [puerto]

Sirve la carpeta sin caché y muestra la dirección para abrirla desde el móvil en la misma red Wi-Fi.
(La geolocalización y la instalación como app necesitan HTTPS; para eso publícala en GitHub Pages o similar.)
"""
import http.server
import socket
import sys
from functools import partial
from pathlib import Path

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
ROOT = Path(__file__).resolve().parent


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      '.js': 'text/javascript', '.webmanifest': 'application/manifest+json'}

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, fmt, *args):
        pass


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('8.8.8.8', 80))
        return s.getsockname()[0]
    except OSError:
        return '127.0.0.1'
    finally:
        s.close()


if __name__ == '__main__':
    handler = partial(NoCacheHandler, directory=str(ROOT))
    with http.server.ThreadingHTTPServer(('0.0.0.0', PORT), handler) as httpd:
        print(f'Mi Tiempo en http://localhost:{PORT}')
        print(f'Desde el móvil (misma Wi-Fi): http://{lan_ip()}:{PORT}')
        httpd.serve_forever()
