const { reserveFugleCalls, rateLimitResponse } = require('../lib/fugle-rate-limit');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const symbol = String(req.query.symbol || '').trim().toUpperCase();
  if (!/^[A-Z0-9.-]{1,12}$/.test(symbol)) return res.status(400).json({ error: 'Invalid symbol' });
  const key = process.env.FUGLE_API_KEY;
  if (!key) return res.status(503).json({ error: 'FUGLE_API_KEY is not configured' });
  const reservation = await reserveFugleCalls(res, 1);
  if (!reservation.allowed) return rateLimitResponse(res, reservation);
  try {
    const url = `https://api.fugle.tw/marketdata/v1.0/stock/intraday/quote/${encodeURIComponent(symbol)}`;
    const upstream = await fetch(url, { headers: { 'X-API-KEY': key }, cache: 'no-store' });
    const body = await upstream.json().catch(() => ({}));
    if (!upstream.ok) return res.status(upstream.status).json({ error: body.message || body.error || `Fugle API error ${upstream.status}`, detail: body });
    const price = Number((Number(body.lastPrice) > 0 ? body.lastPrice : Number(body.closePrice) > 0 ? body.closePrice : body.previousClose));
    if (!Number.isFinite(price) || price <= 0) return res.status(502).json({ error: 'Fugle returned no valid price', detail: body });
    res.status(200).json({
      symbol: body.symbol || symbol,
      name: body.name || symbol,
      price,
      change: Number(body.change ?? 0),
      changePercent: Number(body.changePercent ?? 0),
      previousClose: Number(body.previousClose ?? 0),
      highPrice: Number(body.highPrice ?? 0),
      lowPrice: Number(body.lowPrice ?? 0),
      volume: Number(body.total?.tradeVolume ?? 0),
      date: body.date || null,
      quoteTime: body.lastTrade?.time || body.lastUpdated || null,
      lastUpdated: body.lastUpdated || null,
      isTrial: Boolean(body.isTrial),
      isClose: Boolean(body.isClose),
      source: 'Fugle',
      rawStatus: { isTrial: Boolean(body.isTrial), isClose: Boolean(body.isClose), tradingHalt: body.tradingHalt?.isHalted || false }
    });
  } catch (error) {
    res.status(502).json({ error: 'Unable to retrieve quote', detail: error.message });
  }
};
