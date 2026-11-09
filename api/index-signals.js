const { calculate } = require('../risk-engine');

const monthCache = new Map();
const MONTH = 'https://www.twse.com.tw/rwd/zh/TAIEX/MI_5MINS_HIST';

function parseRow(row) {
  const match = /^(\d{2,3})\/(\d{2})\/(\d{2})$/.exec(row[0]);
  if (!match) return null;
  const date = [Number(match[1]) + 1911, match[2], match[3]].join('-');
  const [high, low, close] = row.slice(2, 5).map(value => Number(String(value).replaceAll(',', '')));
  if (![high, low, close].every(value => Number.isFinite(value) && value > 0) || low > close || close > high) return null;
  return { date, high, low, close };
}

async function monthRows(month, currentMonth) {
  const key = month.replaceAll('-', '') + '01';
  if (month !== currentMonth && monthCache.has(key)) return monthCache.get(key);
  const query = new URLSearchParams({ date: key, response: 'json' });
  const response = await fetch(MONTH + '?' + query, { signal: AbortSignal.timeout(4000) });
  if (!response.ok) throw new Error('證交所月資料無法取得');
  const body = await response.json();
  if (body.stat !== 'OK' || !Array.isArray(body.data)) {
    // A new month can start on a weekend or holiday.
    if (month === currentMonth && /沒有符合條件|查無資料/.test(String(body.stat))) return [];
    throw new Error('證交所日線暫不可用');
  }
  const rows = body.data.map(parseRow).filter(row => row?.date.startsWith(month + '-'));
  if (rows.length !== body.data.length) throw new Error('證交所日線欄位無法確認');
  if (month !== currentMonth) {
    monthCache.set(key, rows);
    if (monthCache.size > 24) monthCache.delete(monthCache.keys().next().value);
  }
  return rows;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const now = new Date();
  const taipei = new Date(now.getTime() + 8 * 3600000);
  const today = taipei.toISOString().slice(0, 10);
  const end = new Date(taipei);
  if (end.getUTCHours() * 60 + end.getUTCMinutes() < 13 * 60 + 45) {
    end.setUTCDate(end.getUTCDate() - 1);
  }
  const to = end.toISOString().slice(0, 10);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 364);
  const from = start.toISOString().slice(0, 10);
  const months = [];
  for (let cursor = new Date(from.slice(0, 7) + '-01T00:00:00Z'); cursor <= end; cursor.setUTCMonth(cursor.getUTCMonth() + 1)) {
    months.push(cursor.toISOString().slice(0, 7));
  }
  try {
    const rows = (await Promise.all(months.map(month => monthRows(month, taipei.toISOString().slice(0, 7))))).flat()
      .filter(row => row.date >= from && row.date <= to);
    if (rows.length < 200) throw new Error('近一年有效交易日不足，暫停計算指標');
    const hasTodayClose = rows.some(row => row.date === today);
    res.setHeader('Cache-Control', hasTodayClose ? 's-maxage=3600' : 's-maxage=300');
    return res.status(200).json({ symbol: 'IX0001', name: '臺灣加權指數', source: '臺灣證券交易所收盤日線', fetchedAt: now.toISOString(), data: calculate(rows) });
  } catch (error) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(502).json({ error: error.message });
  }
};
