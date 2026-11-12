"""Private Windows quote relay. Read the two Shioaji keys as JSON on stdin."""

from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import logging
from logging.handlers import RotatingFileHandler
from math import isfinite
import os
from pathlib import Path
from queue import Queue
import re
import sys
from threading import BoundedSemaphore, Lock, Thread
from time import sleep
from urllib.parse import parse_qs, urlsplit

import shioaji as sj


PORT = 8765
SITE = "https://exposure-manager.vercel.app"
INDEX = "IX0001"
MARKET_SYMBOLS = ("0050", INDEX)
MAX_SYMBOLS = 100
STREAM_INTERVAL = 20
HOLDINGS_INTERVAL = 60
STALE_SECONDS = 180
TAIPEI = timezone(timedelta(hours=8))
log = logging.getLogger("shioaji-relay")


def log_broker_event(response_code, event_code, _info, _event):
    if event_code in (0, 1, 2, 4, 12, 13, 17):
        log.info("broker event=%s response=%s", event_code, response_code)


def allowed_request(headers, remote_host, remote_login):
    host = headers.get("Host")
    forwarded = headers.get("X-Forwarded-Host")
    if headers.get("Origin") not in (None, SITE):
        return False
    if host == f"127.0.0.1:{PORT}" and forwarded is None:
        return True
    return bool(
        remote_host and remote_login and host == forwarded == remote_host
        and headers.get("X-Forwarded-Proto") == "https"
        and headers.get("Tailscale-User-Login") == remote_login
    )


class QuoteFeed:
    def __init__(self, previous_quotes=()):
        self.state = "connecting"
        self.lock = Lock()
        self.asked = set()
        self.unsupported = set()
        self.quotes = {quote["symbol"]: quote for quote in previous_quotes}
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
        quote = {
            "symbol": code, "price": price, "quoteTime": millis,
            "date": stamp.date().isoformat(), "source": "永豐 Shioaji",
        }
        if code == INDEX:
            try:
                high, low = float(event.high), float(event.low)
                if isfinite(high) and isfinite(low) and 0 < low <= price <= high:
                    quote.update(high=high, low=low)
            except (ValueError, TypeError, AttributeError, OverflowError):
                pass
        with self.lock:
            previous = self.quotes.get(code)
            if code in self.asked and (not previous or previous["quoteTime"] <= millis):
                self.quotes[code] = quote

    def read(self, symbols):
        with self.lock:
            new_symbols = [code for code in symbols if code not in self.asked]
            remaining = max(0, MAX_SYMBOLS - len(self.asked))
            for code in new_symbols[:remaining]:
                self.asked.add(code)
                self.requests.put_nowait(code)
            return self.snapshot(symbols)

    def market_stale(self, now):
        minutes = now.hour * 60 + now.minute
        if now.weekday() >= 5 or not 9 * 60 + STALE_SECONDS // 60 <= minutes < 13 * 60 + 30:
            return False
        cutoff = (now.timestamp() - STALE_SECONDS) * 1000
        return all(self.quotes.get(code, {}).get("quoteTime", 0) < cutoff for code in MARKET_SYMBOLS)

    def snapshot(self, symbols):
        return {
            "state": self.state,
            "marketStale": self.market_stale(datetime.now(TAIPEI)),
            "quotes": [self.quotes[code] for code in symbols if code in self.quotes],
            "unsupported": [code for code in symbols if code in self.unsupported],
            "stream": True,
        }

    def set_state(self, state):
        with self.lock:
            self.state = state

    def run(self, keys):
        api = sj.Shioaji(simulation=True)
        api.set_event_callback(log_broker_event)
        try:
            api.login(api_key=keys["api_key"], secret_key=keys["secret_key"], subscribe_trade=False)
        except Exception as error:
            log.warning("broker login failed: %s", type(error).__name__)
            self.set_state("login_error")
            return
        finally:
            keys.clear()
        api.set_on_tick_stk_v1_callback(self.on_quote)
        api.set_on_quote_idx_v1_callback(self.on_quote)
        log.info("broker login succeeded")
        self.set_state("connected")
        while True:
            code = self.requests.get()
            try:
                contract = api.contracts.get(code)
                if contract is None or contract.security_type not in (sj.SecurityType.Stock, sj.SecurityType.Index):
                    raise LookupError(code)
                quote_type = sj.QuoteType.Quote if contract.security_type == sj.SecurityType.Index else sj.QuoteType.Tick
                api.subscribe(contract, quote_type=quote_type)
            except Exception as error:
                if code in MARKET_SYMBOLS:
                    log.warning("benchmark subscription failed: %s %s", code, type(error).__name__)
                with self.lock:
                    self.unsupported.add(code)


def serve(keys):
    log_path = os.environ.get("EXPOSURE_SHIOAJI_LOG_FILE")
    if log_path:
        try:
            handler = RotatingFileHandler(log_path, maxBytes=65536, backupCount=1, encoding="utf-8")
            handler.setFormatter(logging.Formatter("%(asctime)s %(message)s"))
            log.addHandler(handler)
            log.setLevel(logging.INFO)
        except OSError:
            pass
    feed = QuoteFeed(keys.pop("previous_quotes", ()))
    feed.read(MARKET_SYMBOLS)
    stream_slots = BoundedSemaphore(12)
    remote_host = os.environ.get("EXPOSURE_TAILSCALE_HOST")
    remote_login = os.environ.get("EXPOSURE_TAILSCALE_LOGIN")
    token_path = os.environ.get("EXPOSURE_NGROK_TOKEN_FILE")

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_GET(self):
            origin = self.headers.get("Origin")
            target = urlsplit(self.path)
            if not allowed_request(self.headers, remote_host, remote_login):
                self.send_error(403)
                return
            if target.path == "/pair-ngrok":
                if origin != SITE or target.query:
                    self.send_error(403)
                    return
                try:
                    token = Path(token_path).read_text(encoding="ascii").strip() if token_path else ""
                except OSError:
                    token = ""
                if not re.fullmatch(r"[A-Za-z0-9_-]{43}", token):
                    self.send_error(503)
                    return
                body = json.dumps({"token": token}).encode("ascii")
                self.quote_headers(origin, "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
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
                if not 1 <= len(symbols) <= MAX_SYMBOLS:
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
            market_symbols = symbols[:1] if symbols[0] == INDEX else symbols[:2]
            previous_market = None
            cycle = 0
            try:
                while True:
                    full_sync = cycle == 0
                    snapshot = feed.read(symbols if full_sync else market_symbols)
                    market = snapshot
                    if full_sync:
                        market = {
                            **snapshot,
                            "quotes": [quote for quote in snapshot["quotes"] if quote["symbol"] in market_symbols],
                            "unsupported": [code for code in snapshot["unsupported"] if code in market_symbols],
                        }
                        snapshot = {**snapshot, "holdingsSync": True}
                    frame = ": heartbeat\n\n"
                    if full_sync or market != previous_market:
                        frame = "data: " + json.dumps(snapshot, ensure_ascii=False) + "\n\n"
                    self.wfile.write(frame.encode("utf-8"))
                    self.wfile.flush()
                    previous_market = market
                    cycle = (cycle + 1) % (HOLDINGS_INTERVAL // STREAM_INTERVAL)
                    sleep(STREAM_INTERVAL)
            except OSError:
                return

    with ThreadingHTTPServer(("127.0.0.1", PORT), Handler) as server:
        Thread(target=feed.run, args=(keys,), daemon=True).start()
        server.serve_forever()


if __name__ == "__main__":
    serve(json.load(sys.stdin.buffer))
