"""Validate quote enrichment without brokerage login or network requests."""
from datetime import datetime
from decimal import Decimal
import importlib.util
from pathlib import Path
import sys
from types import SimpleNamespace

sys.modules["shioaji"] = SimpleNamespace()
spec = importlib.util.spec_from_file_location("relay", Path(__file__).parents[1] / "scripts/shioaji-feed.py")
relay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(relay)

feed = relay.QuoteFeed()
feed.read(["0050"])
stamp = datetime(2026, 11, 27, 10)


def tick(price, change=None, **extra):
    fields = dict(code="0050", close=Decimal(price), datetime=stamp)
    if change is not None:
        fields["price_chg"] = Decimal(change)
    feed.on_quote(SimpleNamespace(**fields, **extra))
    return feed.read(["0050"])["quotes"][0]


assert tick("110", "10")["previousClose"] == 100
assert tick("90", "-10")["previousClose"] == 100
assert tick("100", "0")["previousClose"] == 100
assert tick("10.51", ".13")["previousClose"] == 10.38
for change in ("NaN", "Infinity", "200"):
    assert "previousClose" not in tick("110", change)
assert "previousClose" not in tick("110")
assert tick("110", reference=Decimal("100"))["previousClose"] == 100
tick("90", "-10", simtrade=True)
assert feed.read(["0050"])["quotes"][0]["price"] == 110
feed.on_quote(SimpleNamespace(code="0050", close=Decimal("90"), price_chg=Decimal("-10"), datetime=datetime(2026, 11, 26, 10)))
assert feed.read(["0050"])["quotes"][0]["price"] == 110

for reference in (0, -1, float("nan")):
    cache = relay.QuoteFeed([{"symbol":"0050", "date":"2026-11-27", "price":110}])
    cache.seed_previous_close(SimpleNamespace(code="0050", reference=reference, update_date="2026-11-27"))
    assert "previousClose" not in cache.quotes["0050"]
cache = relay.QuoteFeed([{"symbol":"0050", "date":"2026-11-27", "price":110}])
cache.seed_previous_close(SimpleNamespace(code="0050", reference=100, update_date="2026-11-26"))
assert "previousClose" not in cache.quotes["0050"], "a contract from another date cannot fill the reference"
cache.seed_previous_close(SimpleNamespace(code="0050", reference=100, update_date="2026-11-27"))
assert cache.quotes["0050"]["previousClose"] == 100
cache.seed_previous_close(SimpleNamespace(code="0050", reference=90, update_date="2026-11-27"))
assert cache.quotes["0050"]["previousClose"] == 100, "keep the reference already received with the quote"
print("PASS: signed and flat tick changes, invalid fields, simulated and stale ticks, and same-date cached contract references")
