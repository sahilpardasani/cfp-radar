import fs from 'node:fs';
const w=JSON.parse(fs.readFileSync('data/watchlist.json','utf8'));
const s=JSON.parse(fs.readFileSync('data/workshop-sources.json','utf8'));
for(const name of ['EMNLP 2026','ECCV 2026','MICCAI 2026','ACMMM 2026','COLM 2026','IEEE IROS 2026']){
 if(!s.parents.some(x=>x.name===name)) throw new Error(`missing parent ${name}`);
}
if(!w.conferences.some(x=>/EMNLP/i.test(x.acronym+' '+x.name))) throw new Error('EMNLP absent from watchlist');
console.log(`Workshop sources OK: ${s.parents.length} parents; watchlist ${w.conferences.length} conferences.`);
