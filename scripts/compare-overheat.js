// node scripts/compare-overheat.js <source-json> [summary-output-json]
const fs=require('node:fs'),crypto=require('node:crypto');
const {compareOverheat}=require('../strategy-study-engine');
if(!process.argv[2])throw Error('Provide source JSON with IX0001, 0050, 00631L candle arrays');
const raw=fs.readFileSync(process.argv[2]),input=JSON.parse(raw),d=input.dataset||input;
const report=compareOverheat(d.IX0001,d['0050'],d['00631L']);
report.source='Fugle 歷史還原日 K';report.sourceSha256=crypto.createHash('sha256').update(raw).digest('hex');
for(const key of ['train','test','stress'])report[key]=report[key].map(({curve,tradeLog,...rest})=>rest);
const json=JSON.stringify(report,null,2)+'\n';
if(process.argv[3])fs.writeFileSync(process.argv[3],json);else console.log(json);
