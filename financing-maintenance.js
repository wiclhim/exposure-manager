'use strict';

const { validDate } = require('./risk-engine');
const SOURCE_URL = 'https://finlab.finance/api/market/margin-maintenance-ratio';

function normalize(body) {
  const dates = body?.series?.d, values = body?.series?.v;
  if (!validDate(body?.as_of) || !Array.isArray(dates) || !dates.length ||
      !Array.isArray(values) || dates.length !== values.length) {
    throw new Error('FinLab 融資維持率資料格式異常');
  }
  const seen = new Set();
  const rows = dates.map((date, index) => {
    const value = values[index];
    if (!validDate(date) || date > body.as_of || seen.has(date) ||
        !Number.isFinite(value) || value <= 0) {
      throw new Error('FinLab 融資維持率日期或數值異常');
    }
    seen.add(date);
    // FinLab expresses the ratio as a multiple. 1.5441 corresponds to 154.41%.
    return { date, financingRate: Math.round(value * 10000) / 100, financingSource: 'FinLab' };
  }).sort((a, b) => a.date.localeCompare(b.date));
  if (rows.at(-1).date !== body.as_of) throw new Error('FinLab 最新資料日不一致');
  return rows;
}

async function load() {
  const response = await fetch(SOURCE_URL, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('FinLab 融資維持率暫時無法取得');
  return normalize(await response.json());
}

module.exports = { normalize, load };
