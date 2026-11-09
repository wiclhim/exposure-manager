"""Private Windows quote relay. Read the two Shioaji keys as JSON on stdin."""

from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from math import isfinite
from queue import Queue
import re
import sys
from threading import BoundedSemaphore, Condition, Thread
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
        self.changed = Condition()
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
        with self.changed:
            previous = self.quotes.get(code)
            if code in self.asked and (not previous or previous["quoteTime"] <= millis):
                self.quotes[code] = {
                    "symbol": code, "price": price, "quoteTime": millis,
                    "date": stamp.date().isoformat(), "source": "永豐 Shioaji",
                }
                self.changed.notify_all()

    def read(self, symbols):
        with self.changed:
            new_symbols = [code for code in symbols if code not in self.asked]
            remaining = max(0, MAX_SYMBOLS - len(self.asked))
            for code in new_symbols[:remaining]:
                self.asked.add(code)
                self.requests.put_nowait(code)
            return self.snapshot(symbols)

    def snapshot(self, symbols):
        return {
            "state": self.state,
            "quotes": [self.quotes[code] for code in symbols if code in self.quotes],
            "unsupported": [code for code in symbols if code in self.unsupported],
            "stream": True,
        }

    def next_snapshot(self, symbols, previous):
        with self.changed:
            self.changed.wait_for(lambda: self.snapshot(symbols) != previous, timeout=15)
            return self.snapshot(symbols)

    def set_state(self, state):
        with self.changed:
            self.state = state
            self.changed.notify_all()

    def run(self, keys):
        api = sj.Shioaji(simulation=True)
        api.set_event_callback(lambda *_: None)
        try:
            api.login(api_key=keys["api_key"], secret_key=keys["secret_key"], subscribe_trade=False)
        except Exception:
            self.set_state("login_error")
            return
        finally:
            keys.clear()
        api.set_on_tick_stk_v1_callback(self.on_quote)
        api.set_on_quote_idx_v1_callback(self.on_quote)
        self.set_state("connected")
        while True:
            code = self.requests.get()
            try:
                contract = api.contracts.get(code)
                if contract is None or contract.security_type not in (sj.SecurityType.Stock, sj.SecurityType.Index):
                    raise LookupError(code)
                quote_type = sj.QuoteType.Quote if contract.security_type == sj.SecurityType.Index else sj.QuoteType.Tick
                api.subscribe(contract, quote_type=quote_type)
            except Exception:
                with self.changed:
                    self.unsupported.add(code)
                    self.changed.notify_all()


def serve(keys):
    feed = QuoteFeed()
    feed.read(["0050", INDEX])
    stream_slots = BoundedSemaphore(12)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_GET(self):
            origin = self.headers.get("Origin")
            target = urlsplit(self.path)
            if self.headers.get("Host") != f"127.0.0.1:{PORT}" or origin not in (None, SITE):
                self.send_error(403)
                return
            if target.path not in ("/quotes", "/stream"):
                self.send_error(404)
                return
            raw = parse_qs(target.query).get("symbols", ["0050,IX0001"])[0]
            if len(raw) > MAX_SYMBOLS * 13:
                self.send_error(400)
                return
            symbols = list(dict.fromkeys(code for code in raw.split(",") if re.fullmatch(r"[A-Z0-9.-]{1,12}", code)))
            if target.path == "/stream":
                if not 1 <= len(symbols) <= 2:
                    self.send_error(400)
                    return
                if not stream_slots.acquire(blocking=False):
                    self.send_error(503)
                    return
                try:
                    self.stream_quotes(origin, symbols)
                finally:
                    stream_slots.release()
                return
            body = json.dumps(feed.read(symbols[:MAX_SYMBOLS]), ensure_ascii=False).encode("utf-8")
            self.quote_headers(origin, "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def quote_headers(self, origin, content_type):
            self.send_response(200)
            if origin == SITE:
                self.send_header("Access-Control-Allow-Origin", SITE)
                self.send_header("Vary", "Origin")
            self.send_header("Content-Type", content_type)
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")

        def stream_quotes(self, origin, symbols):
            self.quote_headers(origin, "text/event-stream; charset=utf-8")
            self.end_headers()
            self.connection.settimeout(5)
            previous = None
            snapshot = feed.read(symbols)
            try:
                while True:
                    frame = ": heartbeat\n\n" if snapshot == previous else "data: " + json.dumps(snapshot, ensure_ascii=False) + "\n\n"
                    self.wfile.write(frame.encode("utf-8"))
                    self.wfile.flush()
                    previous = snapshot
                    snapshot = feed.next_snapshot(symbols, previous)
            except OSError:
                return

    with ThreadingHTTPServer(("127.0.0.1", PORT), Handler) as server:
        Thread(target=feed.run, args=(keys,), daemon=True).start()
        server.serve_forever()


if __name__ == "__main__":
    serve(json.load(sys.stdin))
