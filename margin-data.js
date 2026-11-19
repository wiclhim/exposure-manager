(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.MarginData=api;})(typeof globalThis!=='undefined'?globalThis:this,()=>{
  'use strict';
  function normalize(body){
    if(body?.stat!=='OK'||!Array.isArray(body.data)||body.data.length<2)throw new Error('證交所暫無完整融資資料');
    const seen=new Set();
    return body.data.map(row=>{
      const raw=String(row.date),date=`${raw.slice(0,4)}-${raw.slice(4,6)}-${raw.slice(6,8)}`;
      const value=row.marginAmt;
      if(!/^\d{8}$/.test(raw)||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date||seen.has(date)||typeof value!=='number'||!Number.isFinite(value)||value<0)throw new Error('證交所融資資料格式異常');
      seen.add(date);
      // TWSE marginAmt is NT$ thousands; 100,000 thousands = NT$ 100 million.
      return {date,balance:value/100000};
    }).sort((a,b)=>a.date.localeCompare(b.date)).map((row,i,rows)=>({...row,change:i?row.balance-rows[i-1].balance:null,ma20:i>=19?rows.slice(i-19,i+1).reduce((sum,r)=>sum+r.balance,0)/20:null}));
  }
  function summary(rows){
    const i=rows.findLastIndex(row=>Number.isFinite(row.balance));
    const last=rows[i],previous=rows[i-1];
    const change=key=>Number.isFinite(last?.[key])&&Number.isFinite(previous?.[key])?last[key]-previous[key]:null;
    const window=i>=5 ? rows.slice(i-5,i+1) : [];
    const five=window.length && window.every(row=>Number.isFinite(row.balance)) ? window[0].balance : null;
    return {
      last,
      dayChange:change('balance'),
      listedDayChange:change('listedBalance'),
      otcDayChange:change('otcBalance'),
      dayPercent:previous?.balance>0?(last.balance/previous.balance-1)*100:null,
      fiveChange:five!=null?last.balance-five:null,
      fivePercent:five>0?(last.balance/five-1)*100:null
    };
  }
  function addOtcBalance(listed, otc) {
    const byDate = new Map(otc.map(row => [row.date, row.marginBalance]));
    const totals = listed.map(row => {
      const otcBalance = byDate.get(row.date.replaceAll('-', ''));
      const available = Number.isFinite(otcBalance) && otcBalance >= 0;
      return { date: row.date, listedBalance: row.balance, otcBalance: available ? otcBalance : null,
        balance: available ? row.balance + otcBalance : null };
    });
    return withChanges(totals);
  }
  function withChanges(totals) {
    return totals.map((row, i) => {
      const previous = totals[i - 1]?.balance;
      const window = i >= 19 ? totals.slice(i - 19, i + 1) : [];
      return {
        ...row,
        change: row.balance != null && previous != null ? row.balance - previous : null,
        ma20: window.length && window.every(day => day.balance != null)
          ? window.reduce((sum, day) => sum + day.balance, 0) / 20 : null
      };
    });
  }
  function mergeHistory(...histories) {
    const byDate = new Map();
    for (const rows of histories) {
      if (!Array.isArray(rows)) continue;
      for (const row of rows) {
        if (typeof row?.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.date)) continue;
        const day = new Date(row.date + 'T00:00:00Z');
        if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== row.date) continue;
        const previous = byDate.get(row.date);
        const listedBalance = Number.isFinite(row.listedBalance) && row.listedBalance >= 0 ? row.listedBalance : previous?.listedBalance ?? null;
        const otcBalance = Number.isFinite(row.otcBalance) && row.otcBalance >= 0 ? row.otcBalance : previous?.otcBalance ?? null;
        const keepRate = Number.isFinite(row.keepRate) && row.keepRate > 0 ? row.keepRate : previous?.keepRate ?? null;
        const financingRate = Number.isFinite(row.financingRate) && row.financingRate > 0 ? row.financingRate : previous?.financingRate ?? null;
        const unpriced = Number.isInteger(row.unpriced) && row.unpriced >= 0 ? row.unpriced : previous?.unpriced ?? null;
        if (listedBalance == null && otcBalance == null && keepRate == null && financingRate == null) continue;
        const balance = listedBalance != null && otcBalance != null ? listedBalance + otcBalance : null;
        byDate.set(row.date, { date: row.date, listedBalance, otcBalance, balance, keepRate, financingRate, unpriced });
      }
    }
    const sorted = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
    return withChanges(sorted);
  }
  function normalizeMaintenance(body){
    if(body?.stat!=='OK'||!Array.isArray(body.data))throw new Error('證交所暫無維持率資料');
    const seen=new Set();
    return body.data.map(row=>{
      const raw=String(row.date),date=`${raw.slice(0,4)}-${raw.slice(4,6)}-${raw.slice(6,8)}`;
      if(!/^\d{8}$/.test(raw)||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date||seen.has(date))throw new Error('證交所維持率日期異常');
      seen.add(date);
      if(row.keepRate==null||row.keepRate==='')return {date,keepRate:null};
      if(typeof row.keepRate!=='number'||!Number.isFinite(row.keepRate)||row.keepRate<=0)throw new Error('證交所維持率格式異常');
      return {date,keepRate:row.keepRate};
    }).sort((a,b)=>a.date.localeCompare(b.date));
  }
  function combine(balance,maintenance){
    const lookup=new Map(maintenance.map(row=>[row.date,row.keepRate]));
    return balance.map(row=>({...row,keepRate:lookup.get(row.date)??null}));
  }
  // Splitting missing observations prevents a line from inventing values across an unavailable period.
  function segments(rows,key){
    const groups=[];let current=[];
    rows.forEach((row,i)=>{if(Number.isFinite(row[key]))current.push({row,index:i});else if(current.length){groups.push(current);current=[];}});
    if(current.length)groups.push(current);
    return groups;
  }
  return {normalize,summary,addOtcBalance,normalizeMaintenance,combine,segments,mergeHistory};
});
