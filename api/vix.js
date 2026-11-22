const HISTORY = 'https://www.taifex.com.tw/indes/index.aspx/GetStockDayPrices';
const MONTHLY = 'https://www.taifex.com.tw/file/taifex/Dailydownload/vix/log2data/';
const MAX_DAYS = 252;

async function historyRows(start, end) {
  const format = date => date.replaceAll('-', '/');
  const response = await fetch(HISTORY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ syid: 'TAIWANVIX', flag: 'MS', startDate: format(start), endDate: format(end) }),
    signal: AbortSignal.timeout(5000)
  });
  if (!response.ok) throw new Error('TAIFEX index history unavailable');
  const { d } = await response.json();
  const { TrendData } = JSON.parse(d);
  return TrendData.map(({ Time, Price }) => [Time, Price]);
}

async function monthlyRows(month) {
  const response = await fetch(MONTHLY + month + 'new.txt', { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('TAIFEX monthly closes unavailable');
  // Each row begins with a date and time, then the close and the last-minute average.
  return (await response.text()).split(/\r?\n/).flatMap(line => {
    const match = /^\s*(\d{8})\s+\d{8}\s+(\d+(?:\.\d+)?)(?=\s|$)/.exec(line);
    return match && match[1].startsWith(month) ? [[match[1], match[2]]] : [];
  });
}

function normalize(rows, through) {
  const data = new Map();
  for (const [day, value] of rows) {
    if (!/^\d{8}$/.test(day) || value == null || value === '') continue;
    const date = day.slice(0, 4) + '-' + day.slice(4, 6) + '-' + day.slice(6);
    const stamp = new Date(date);
    const close = Number(value);
    if (!Number.isFinite(stamp.getTime()) || stamp.toISOString().slice(0, 10) !== date ||
        date > through || !Number.isFinite(close) || close <= 0) continue;
    data.set(date, { date, close });
  }
  return Array.from(data.values()).sort((a, b) => a.date.localeCompare(b.date)).slice(-MAX_DAYS);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const taipei = new Date(Date.now() + 8 * 3600000);
  const today = taipei.toISOString().slice(0, 10);
  const start = new Date(taipei);
  start.setUTCDate(start.getUTCDate() - 400);
  const yesterday = new Date(taipei);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const through = taipei.getUTCHours() * 60 + taipei.getUTCMinutes() >= 13 * 60 + 45
    ? today : yesterday.toISOString().slice(0, 10);
  const results = await Promise.allSettled([
    historyRows(start.toISOString().slice(0, 10), yesterday.toISOString().slice(0, 10)),
    monthlyRows(today.slice(0, 7).replace('-', ''))
  ]);
  const data = normalize(results.flatMap(result => result.status === 'fulfilled' ? result.value : []), through);
  if (!data.length) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(502).json({ error: '期交所波動率指數暫時無法取得' });
  }
  const ttl = data.length < MAX_DAYS || data.at(-1).date !== today ? 300 : 3600;
  res.setHeader('Cache-Control', 's-maxage=' + ttl + ', stale-while-revalidate=300');
  return res.status(200).json({ symbol: 'VIXTWN', data });
};
