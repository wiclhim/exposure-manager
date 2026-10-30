const { reserveFugleCalls, rateLimitResponse } = require('../lib/fugle-rate-limit');

function taipeiDate(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
function shiftDate(dateText, days) {
  const d = new Date(`${dateText}T00:00:00+08:00`);
  d.setUTCDate(d.getUTCDate() + days);
  return taipeiDate(d);
}
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const symbol = String(req.query.symbol || '0050').trim().toUpperCase();
  if (!/^[A-Z0-9.-]{1,12}$/.test(symbol)) return res.status(400).json({ error: 'Invalid symbol' });
  const key = process.env.FUGLE_API_KEY;
  if (!key) return res.status(503).json({ error: 'FUGLE_API_KEY is not configured' });
  const reservation = await reserveFugleCalls(res, 1);
  if (!reservation.allowed) return rateLimitResponse(res, reservation);
  try {
    const to = taipeiDate(new Date());
    const from = shiftDate(to, -364); // Fugle 歷史 K 單次查詢區間須小於一年
    const params = new URLSearchParams({ from, to, timeframe: 'D', adjusted: 'true', fields: 'close' });
    const url = `https://api.fugle.tw/marketdata/v1.0/stock/historical/candles/${encodeURIComponent(symbol)}?${params}`;
    const upstream = await fetch(url, { headers: { 'X-API-KEY': key }, cache: 'no-store' });
    const body = await upstream.json().catch(() => ({}));
    if (!upstream.ok) return res.status(upstream.status).json({ error: body.message || body.error || `Fugle API error ${upstream.status}`, detail: body });
    const data = Array.isArray(body.data) ? body.data.map(row => ({ date: row.date, close: Number(row.close) })).filter(row => row.close > 0) : [];
    if (!data.length) return res.status(404).json({ error: `No historical data for ${symbol}` });
    const high = data.reduce((a, b) => b.close > a.close ? b : a, data[0]);
    res.status(200).json({ symbol, from, to, highClose: high.close, highDate: high.date, data, source: 'Fugle historical candles', adjusted: true });
  } catch (error) {
    res.status(502).json({ error: 'Unable to retrieve historical data', detail: error.message });
  }
};
