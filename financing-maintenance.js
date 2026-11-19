'use strict';

const { validDate } = require('./risk-engine');

function number(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return NaN;
  const text = String(value).replaceAll(',', '').trim();
  return /^\d+(\.\d+)?$/.test(text) ? Number(text) : NaN;
}

function marketValue(margin, prices, amount, priceColumn) {
  if (!Array.isArray(margin) || !margin.length || !Array.isArray(prices) || !prices.length ||
      !Number.isFinite(amount) || amount <= 0) throw new Error('融資股數或金額資料不完整');
  const quotes = new Map(prices.map(row => [row[0], number(row[priceColumn])]));
  let value = 0, pricedUnits = 0, totalUnits = 0, unpriced = 0;
  for (const row of margin) {
    const units = number(row[6]);
    if (!Number.isFinite(units)) throw new Error('融資餘額欄位異常');
    totalUnits += units;
    if (!units) continue;
    const close = quotes.get(row[0]);
    if (!Number.isFinite(close) || close <= 0) {
      unpriced++;
      continue;
    }
    // Both financing lots and the financing amount use thousands.
    value += units * close;
    pricedUnits += units;
  }
  if (pricedUnits <= 0 || totalUnits <= 0) throw new Error('融資股票收盤報價不足');
  return { value, amount, pricedUnits, totalUnits, unpriced };
}

function calculate(date, listedMargin, listedPrices, otcMargin, otcPrices) {
  if (!validDate(date)) throw new Error('融資維持率日期異常');
  const day = date.replaceAll('-', '');
  for (const report of [listedMargin, listedPrices, otcMargin, otcPrices]) {
    if (String(report?.stat).toLowerCase() !== 'ok' || report.date !== day ||
        !Array.isArray(report.tables)) throw new Error('融資與報價資料日期不一致');
  }
  const listedStocks = listedMargin.tables.find(table => table.fields?.[0] === '代號' && table.fields[6] === '今日餘額');
  const listedQuotes = listedPrices.tables.find(table => table.fields?.[0] === '證券代號' && table.fields[8] === '收盤價');
  const listedAmount = listedMargin.tables.flatMap(table => table.data || [])
    .find(row => row[0] === '融資金額(仟元)');
  const otcStocks = otcMargin.tables.find(table => table.fields?.[0] === '代號' && table.fields[6] === '資餘額');
  const otcQuotes = otcPrices.tables.find(table => table.fields?.[0] === '代號' && table.fields[2] === '收盤');
  const otcAmount = otcMargin.tables.flatMap(table => table.summary || [])
    .find(row => row[1] === '融資金(仟元)');
  const listed = marketValue(listedStocks?.data, listedQuotes?.data, number(listedAmount?.[5]), 8);
  const otc = marketValue(otcStocks?.data, otcQuotes?.data, number(otcAmount?.[6]), 2);
  const financingRate = (listed.value + otc.value) / (listed.amount + otc.amount) * 100;
  return {
    date,
    financingRate: Math.round(financingRate * 100) / 100,
    unpriced: listed.unpriced + otc.unpriced
  };
}

async function load(date) {
  if (!validDate(date)) throw new Error('融資維持率日期異常');
  const day = date.replaceAll('-', '');
  const otcDay = date.replaceAll('-', '/');
  const urls = [
    'https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?response=json&selectType=ALL&date=' + day,
    'https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?response=json&type=ALLBUT0999&date=' + day,
    'https://www.tpex.org.tw/www/zh-tw/margin/balance?response=json&date=' + otcDay,
    'https://www.tpex.org.tw/www/zh-tw/afterTrading/dailyQuotes?response=json&date=' + otcDay
  ];
  const reports = await Promise.all(urls.map(async url => {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('融資維持率資料來源暫時無法連線（HTTP ' + response.status + '）');
    return response.json();
  }));
  return calculate(date, ...reports);
}

module.exports = { calculate, load };
