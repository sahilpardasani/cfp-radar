import fs from 'node:fs';
import path from 'node:path';
import { fetchPage, duckDuckGoSearch, extractDeadlineTracks, selectOpenSubmissionTrack } from '../lib/webDiscovery.js';

const ROOT=process.cwd();
const DATA=path.join(ROOT,'data/cfps.json');
const SOURCES=path.join(ROOT,'data/workshop-sources.json');
const STATE=path.join(ROOT,'data/workshop-discovery-state.json');
const MAX=Number(process.env.WORKSHOP_DISCOVERY_MAX_PARENTS)||500;
const CONC=Number(process.env.WORKSHOP_DISCOVERY_CONCURRENCY)||6;
const now=new Date();
const read=(p,f)=>{try{return JSON.parse(fs.readFileSync(p,'utf8'))}catch{return f}};
const write=(p,v)=>fs.writeFileSync(p,JSON.stringify(v,null,2)+'\n');
const norm=s=>(s||'').toLowerCase().replace(/&/g,' and ').replace(/[^a-z0-9]+/g,' ').trim();
const host=u=>{try{return new URL(u).hostname.replace(/^www\./,'')}catch{return''}};
const badHost=h=>/openreview\.net|wikicfp|conferencealerts|allconferencealert|10times|facebook|linkedin|x\.com|twitter/.test(h);
const workshopish=(s)=>/(workshop|challenge|shared task|satellite|special session|doctoral symposium|tutorial)/i.test(s||'');
const mapLimit=async(arr,n,fn)=>{let i=0;const out=new Array(arr.length);await Promise.all(Array.from({length:Math.min(n,arr.length)},async()=>{while(true){const j=i++;if(j>=arr.length)return;try{out[j]=await fn(arr[j])}catch(e){out[j]={error:e.message}}}}));return out};

async function officialParent(parent){
  if(parent.officialUrl){try{return await fetchPage(parent.officialUrl,15000,2)}catch{}}
  const q=`${parent.name} official workshops satellite events call for papers`;
  for(const r of await duckDuckGoSearch(q,10)){
    if(badHost(host(r.url))) continue;
    try{const p=await fetchPage(r.url,15000,1); if(norm(p.text).includes(norm(parent.name).split(' ').slice(0,2).join(' '))) return p;}catch{}
  }
  return null;
}

function candidateLinks(page){
  const seen=new Set(); const out=[];
  for(const l of page.links||[]){
    if(!/^https?:/.test(l.url)||badHost(host(l.url))) continue;
    if(!workshopish(`${l.text} ${l.url}`)) continue;
    const u=l.url.split('#')[0]; if(seen.has(u))continue; seen.add(u); out.push({...l,url:u});
  }
  return out.slice(0,250);
}

async function inspectWorkshop(parent,link){
  let page; try{page=await fetchPage(link.url,15000,1)}catch{return null}
  const tracks=extractDeadlineTracks(page.text,now);
  let selected=selectOpenSubmissionTrack(tracks,now);
  if(!selected){
    const title=(page.text.match(/<title[^>]*>([^<]+)/i)||[])[1]||link.text;
    try{
      for(const r of await duckDuckGoSearch(`"${title||link.text}" submission deadline ${parent.year}`,5)){
        if(badHost(host(r.url))) continue;
        const p=await fetchPage(r.url,12000,0); const ts=extractDeadlineTracks(p.text,now); const s=selectOpenSubmissionTrack(ts,now);
        if(s){page=p;selected=s;break}
      }
    }catch{}
  }
  if(!selected||selected.date<=now)return null;
  const title=(page.text.match(/<title[^>]*>([^<]+)/i)||[])[1]?.replace(/\s+/g,' ').trim()||link.text||`${parent.name} Workshop`;
  return {title,page,selected,tracks};
}

function makeCard(parent,r){
  const n=r.title.replace(/\s*[|–—-]\s*[^|–—]{0,80}$/,'').trim();
  const acronym=(n.match(/\b[A-Z][A-Z0-9-]{2,}\b/g)||[]).slice(-1)[0]||n.slice(0,18);
  return {
    id:`official-workshop-${norm(parent.name+' '+n).replace(/ /g,'-').slice(0,90)}`,
    acronym,name:n,type:/challenge/i.test(n)?'workshop':'workshop',field:'AI/CS & Related',tier:'Workshop',
    deadline:r.selected.date.toISOString(),deadlineType:r.selected.type,deadlineStatus:'verified',timezone:'UTC',eventDates:null,location:'See official site',
    description:`Official workshop/satellite call associated with ${parent.name}.`,topics:[],publisher:null,indexedIn:[],
    url:r.page.url,cfpUrl:r.page.url,submissionUrl:(r.page.links||[]).find(x=>/cmt|easychair|hotcrp|openreview|paperplaza|edas|submission/i.test(x.url+' '+x.text))?.url||null,
    source:'official-parent-workshop-agent',parentConference:parent.name,updatedAt:new Date().toISOString(),
    legitimacy:{level:'trusted',basis:'official parent conference or official workshop page'},admission:{status:'trusted',source:'official-workshop-discovery'},
    discoveryEvidence:{parentOfficialPage:parent.resolvedUrl||parent.officialUrl,officialWorkshopPage:r.page.url,deadlineEvidence:r.selected.raw,allDeadlineTracks:r.tracks.map(t=>({type:t.type,date:t.date.toISOString(),raw:t.raw}))}
  };
}
function equivalent(a,b){
 const na=norm(a.name),nb=norm(b.name); if(na===nb)return true;
 return a.parentConference&&b.parentConference&&norm(a.parentConference)===norm(b.parentConference)&&(na.includes(nb)||nb.includes(na));
}

async function processParent(parent){
 const pp=await officialParent(parent); if(!pp)return {parent,found:[],error:'official parent page not resolved'};
 parent={...parent,resolvedUrl:pp.url};
 let links=candidateLinks(pp);
 // Search specifically for a workshop index when homepage has no links.
 if(!links.length){
   try{for(const r of await duckDuckGoSearch(`${parent.name} accepted workshops official`,8)){if(!badHost(host(r.url))){const p=await fetchPage(r.url,12000,0);const ls=candidateLinks(p);if(ls.length){links=ls;break}}}}catch{}
 }
 const inspected=await mapLimit(links,3,l=>inspectWorkshop(parent,l));
 return {parent,found:inspected.filter(Boolean).map(r=>makeCard(parent,r)),linksChecked:links.length};
}

async function main(){
 const store=read(DATA,{items:[]}); const src=read(SOURCES,{parents:[]}); const state=read(STATE,{cursor:0});
 const parents=(src.parents||[]).slice(0,MAX);
 const results=await mapLimit(parents,CONC,processParent);
 let added=0,updated=0; const items=[...(store.items||[])];
 for(const res of results){
   for(const card of res.found||[]){
     const idx=items.findIndex(x=>equivalent(x,card));
     if(idx>=0){
       // Preserve richer curated metadata; refresh official CFP/deadline only.
       items[idx]={...items[idx],deadline:card.deadline,deadlineType:card.deadlineType,deadlineStatus:'verified',cfpUrl:card.cfpUrl,url:items[idx].url||card.url,submissionUrl:items[idx].submissionUrl||card.submissionUrl,parentConference:items[idx].parentConference||card.parentConference,updatedAt:card.updatedAt,officialWorkshopDiscovery:card.discoveryEvidence}; updated++;
     }else{items.push(card);added++;}
   }
 }
 // Remove expired cards created by this agent only.
 const live=items.filter(x=>x.source!=='official-parent-workshop-agent'||!x.deadline||new Date(x.deadline)>now);
 store.items=live;store.updatedAt=new Date().toISOString();store.source='curated + watchlist + verified external discovery + official parent workshop agent';
 write(DATA,store);write(STATE,{lastRunAt:new Date().toISOString(),parentsChecked:parents.length,added,updated,errors:results.filter(x=>x.error).slice(0,100)});
 console.log(`Workshop discovery complete: ${parents.length} parents checked; ${added} added; ${updated} refreshed; catalog ${live.length}.`);
}
main().catch(e=>{console.error(e);process.exit(1)});
