"""Private Windows quote relay. Read the two Shioaji keys as JSON on stdin."""

from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from math import isfinite
from queue import Queue
import re
import sys
from threading import Lock, Thread
from urllib.parse import parse_qs, urlsplit

import shioaji as sj


PORT = 8765
SITE = "https://exposure-manager.vercel.app"
INDEX = "IX0001"
MAX_SYMBOLS = 100
TAIPEI = timezone(timedelta(hours=8))


class QuoteFeed:
    def __init__(self):
        self.state = "connecting"
        self.lock = Lock()
        self.asked = set()
        self.unsupported = set()
        self.quotes = {}
        self.requests = Queue()

    def on_quote(self, event):
        try:
            price = float(event.close)
            stamp = event.datetime
            if isinstance(stamp, tuple):
                stamp = datetime(*stamp)
            stamp = stamp.replace(tzinfo=TAIPEI) if stamp.tzinfo is None else stamp.astimezone(TAIPEI)
        except (ValueError, TypeError, AttributeError, OverflowError):
            return
        if getattr(event, "simtrade", False) or not isfinite(price) or price <= 0:
            return
        millis = int(stamp.timestamp() * 1000)
        code = event.code
        with self.lock:
            previous = self.quotes.get(code)
            if code in self.asked and (not previous or previous["quoteTime"] <= millis):
                self.quotes[code] = {
                    "symbol": code, "price": price, "quoteTime": millis,
                    "date": stamp.date().isoformat(), "source": "永豐 Shioaji",
                }

    def read(self, symbols):
        with self.lock:
            new_symbols = [code for code in symbols if code not in self.asked]
            remaining = max(0, MAX_SYMBOLS - len(self.asked))
            for code in new_symbols[:remaining]:
                self.asked.add(code)
                self.requests.put_nowait(code)
            return {
                "state": self.state,
                "quotes": [self.quotes[code] for code in symbols if code in self.quotes],
                "unsupported": [code for code in symbols if code in self.unsupported],
            }

    def run(self, keys):
        api = sj.Shioaji(simulation=True)
        api.set_event_callback(lambda *_: None)
        try:
            api.login(api_key=keys["api_key"], secret_key=keys["secret_key"], subscribe_trade=False)
        except Exception:
            self.state = "login_error"
            return
        finally:
            keys.clear()
        api.set_on_tick_stk_v1_callback(self.on_quote)
        api.set_on_quote_idx_v1_callback(self.on_quote)
        self.state = "connected"
        while True:
            code = self.requests.get()
            try:
                contract = api.contracts.get(code)
                if contract is None or contract.security_type not in (sj.SecurityType.Stock, sj.SecurityType.Index):
                    raise LookupError(code)
                quote_type = sj.QuoteType.Quote if contract.security_type == sj.SecurityType.Index else sj.QuoteType.Tick
                api.subscribe(contract, quote_type=quote_type)
            except Exception:
                with self.lock:
                    self.unsupported.add(code)


def serve(keys):
    feed = QuoteFeed()
    feed.read(["0050", INDEX])

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_GET(self):
            origin = self.headers.get("Origin")
            target = urlsplit(self.path)
            if self.headers.get("Host") != f"127.0.0.1:{PORT}" or origin not in (None, SITE):
                self.send_error(403)
                return
            if target.path != "/quotes":
                self.send_error(404)
                return
            raw = parse_qs(target.query).get("symbols", ["0050,IX0001"])[0]
            if len(raw) > MAX_SYMBOLS * 13:
                self.send_error(400)
                return
            symbols = list(dict.fromkeys(code for code in raw.split(",") if re.fullmatch(r"[A-Z0-9.-]{1,12}", code)))
            body = json.dumps(feed.read(symbols[:MAX_SYMBOLS]), ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            if origin == SITE:
                self.send_header("Access-Control-Allow-Origin", SITE)
                self.send_header("Vary", "Origin")
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    with ThreadingHTTPServer(("127.0.0.1", PORT), Handler) as server:
        Thread(target=feed.run, args=(keys,), daemon=True).start()
        server.serve_forever()


if __name__ == "__main__":
    serve(json.load(sys.stdin))
