const KEYWORDS = /(call for papers|submission|archival|non-archival|proceedings|publisher|published|index|scopus|web of science|dblp|anthology|xplore|digital library|springer|lecture notes|lncs|lnee|lnce|acm|ieee|dual submission|cross-submission|previously published|camera-ready)/i;

function decode(s="") {
  return s.replace(/&nbsp;/gi," ").replace(/&amp;/gi,"&").replace(/&quot;/gi,'"').replace(/&#39;/gi,"'").replace(/&lt;/gi,"<").replace(/&gt;/gi,">");
}
function text(html="") {
  return decode(html.replace(/<script[\s\S]*?<\/script>/gi," ").replace(/<style[\s\S]*?<\/style>/gi," ").replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim());
}
function links(html, base) {
  const out=[]; let m;
  const re=/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  while((m=re.exec(html))) {
    try {
      const u=new URL(m[1],base).toString(); const label=text(m[2]);
      if (/cfp|call|submission|author|proceedings|publication|program|accepted|policy|faq/i.test(label+" "+u)) out.push(u);
    } catch {}
  }
  return [...new Set(out)].slice(0,4);
}
async function get(url) {
  const {response:r,finalUrl}=await fetchRemote(url,{headers:{"User-Agent":"CFP-Radar-VenueResearch/1.0","Accept":"text/html,application/xhtml+xml,*/*"},timeoutMs:20000});
  if(!r.ok) throw new Error(`HTTP ${r.status}`);
  const html=await readResponseText(r,2*1024*1024);
  return {url:finalUrl,html,plain:text(html)};
}
function excerpts(plain) {
  const sentences=plain.split(/(?<=[.!?])\s+/).filter(s=>KEYWORDS.test(s));
  return sentences.slice(0,18).map(s=>s.slice(0,700));
}
export async function researchVenue(venue) {
  const seeds=[venue.cfpUrl,venue.url,venue.templateUrl].filter(Boolean);
  const visited=new Set(); const pages=[];
  const seedPages=await mapLimit([...new Set(seeds)].slice(0,2),2,async(seed)=>{
    try {
      return await get(seed);
    } catch(e) { return {url:seed,error:e.message}; }
  });
  const linked=[];
  for(const p of seedPages){
    visited.add(p.url);
    pages.push(p.error?{url:p.url,error:p.error}:{url:p.url,excerpts:excerpts(p.plain)});
    if(!p.error)linked.push(...links(p.html,p.url));
  }
  const remaining=[...new Set(linked)].filter(u=>!visited.has(u)).slice(0,Math.max(0,5-visited.size));
  const linkedPages=await mapLimit(remaining,3,async(u)=>{
    try{return await get(u);}catch(e){return {url:u,error:e.message};}
  });
  for(const p of linkedPages)pages.push(p.error?{url:p.url,error:p.error}:{url:p.url,excerpts:excerpts(p.plain)});
  return {venueId:venue.id,checkedAt:new Date().toISOString(),pages};
}

export function researchContext(r) {
  return r.pages.map((p,i)=>`SOURCE ${i+1}: ${p.url}\n${p.error?`ERROR: ${p.error}`:(p.excerpts||[]).map(x=>`- ${x}`).join("\n")}`).join("\n\n");
}
import { mapLimit } from "./asyncPool.js";
import { fetchRemote, readResponseText } from "./safeFetch.js";
