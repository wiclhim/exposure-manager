const { reserveFugleCalls, rateLimitResponse } = require('../lib/fugle-rate-limit');

function taipeiDate(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
function shiftDate(dateText, days) {
  const d = new Date(`${dateText}T00:00:00+08:00`);
  d.setUTCDate(d.getUTCDate() + days);
  return taipeiDate(d);
}
async function getCandles(symbol, key, from, to) {
  const params = new URLSearchParams({ from, to, timeframe: 'D', adjusted: 'true', fields: 'close' });
  const url = `https://api.fugle.tw/marketdata/v1.0/stock/historical/candles/${encodeURIComponent(symbol)}?${params}`;
  const r = await fetch(url, { headers: { 'X-API-KEY': key }, cache: 'no-store' });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.message || body.error || `Fugle history error ${r.status} for ${symbol}`);
  return (body.data || []).map(x => ({ date: x.date, close: Number(x.close) })).filter(x => x.close > 0);
}
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const symbol = String(req.query.symbol || '').trim().toUpperCase();
  const benchmark = String(req.query.benchmark || '0050').trim().toUpperCase();
  if (!/^[A-Z0-9.-]{1,12}$/.test(symbol) || !/^[A-Z0-9.-]{1,12}$/.test(benchmark)) return res.status(400).json({ error: 'Invalid symbol' });
  if (symbol === benchmark) return res.status(200).json({ symbol, benchmark, beta: 1, observations: 0, note: '基準標的 Beta 設為 1.00' });
  const key = process.env.FUGLE_API_KEY;
  if (!key) return res.status(503).json({ error: 'FUGLE_API_KEY is not configured' });
  const reservation = await reserveFugleCalls(res, 2);
  if (!reservation.allowed) return rateLimitResponse(res, reservation);
  try {
    const to = taipeiDate(new Date());
    const from = shiftDate(to, -364);
    const [asset, base] = await Promise.all([getCandles(symbol, key, from, to), getCandles(benchmark, key, from, to)]);
    const baseMap = new Map(base.map(x => [x.date, x.close]));
    const common = asset.filter(x => baseMap.has(x.date)).sort((a, b) => a.date.localeCompare(b.date));
    const returns = [];
    for (let i = 1; i < common.length; i++) {
      const aPrev = common[i - 1].close, aNow = common[i].close;
      const bPrev = baseMap.get(common[i - 1].date), bNow = baseMap.get(common[i].date);
      if (aPrev > 0 && bPrev > 0 && aNow > 0 && bNow > 0) returns.push({ a: aNow / aPrev - 1, b: bNow / bPrev - 1 });
    }
    if (returns.length < 30) return res.status(422).json({ error: '有效重疊交易日不足 30 日，無法穩定估算 Beta', observations: returns.length });
    const meanA = returns.reduce((s, x) => s + x.a, 0) / returns.length;
    const meanB = returns.reduce((s, x) => s + x.b, 0) / returns.length;
    let cov = 0, variance = 0;
    for (const x of returns) { cov += (x.a - meanA) * (x.b - meanB); variance += (x.b - meanB) ** 2; }
    const beta = variance > 0 ? cov / variance : null;
    if (!Number.isFinite(beta)) return res.status(422).json({ error: '基準報酬變異數不足，無法估算 Beta' });
    res.status(200).json({ symbol, benchmark, beta: Number(beta.toFixed(3)), observations: returns.length, method: 'covariance(asset daily returns, benchmark daily returns) / variance(benchmark daily returns)', from, to, adjusted: true });
  } catch (error) {
    res.status(502).json({ error: 'Beta estimation failed', detail: error.message });
  }
};
