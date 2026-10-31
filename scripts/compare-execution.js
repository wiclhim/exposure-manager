// node scripts/compare-execution.js <source-json> [summary-output-json]
const fs=require('node:fs'),crypto=require('node:crypto');
const {compareExecution}=require('../strategy-study-engine');
if(!process.argv[2])throw Error('Provide a source JSON file with IX0001, 0050 and 00631L candle arrays');
const raw=fs.readFileSync(process.argv[2]),input=JSON.parse(raw),d=input.dataset||input;
const report=compareExecution(d.IX0001,d['0050'],d['00631L']);
report.source='Fugle 歷史還原日 K';report.sourceSha256=crypto.createHash('sha256').update(raw).digest('hex');
for(const key of ['train','test','stress','initial160'])report[key]=report[key].map(({curve,tradeLog,...rest})=>rest);
delete report.latest;
const json=JSON.stringify(report,null,2);
if(process.argv[3])fs.writeFileSync(process.argv[3],json+'\n');else console.log(json);
