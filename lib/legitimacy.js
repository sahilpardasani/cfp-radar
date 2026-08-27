/** Server-side venue legitimacy and publication due-diligence. */
import {
  GOOD_PUBLISHERS, HISTORY_LINK_RE, acronymOf, claimedEditionFromText, exactIssnSet,
  hostIsGood, hostOf, legitimacyOf, norm, similarity,
} from "./legitimacyHeuristics.js";
import { fetchRemote, readResponseText } from "./safeFetch.js";
import { UNTRUSTED_CONTENT_RULE, untrustedPromptField } from "./promptSecurity.js";

export { legitimacyOf } from "./legitimacyHeuristics.js";

async function fetchJSON(url,ms=18000){const r=await fetch(url,{headers:{"User-Agent":"CFP-Radar-DueDiligence/2.0 (mailto:noreply@example.com)"},signal:AbortSignal.timeout(ms)});if(!r.ok)throw new Error(`HTTP ${r.status}`);return r.json();}
async function fetchText(url,ms=18000){const {response:r,finalUrl}=await fetchRemote(url,{headers:{"User-Agent":"CFP-Radar-DueDiligence/2.0","Accept":"text/html,*/*"},timeoutMs:ms});if(!r.ok)throw new Error(`HTTP ${r.status}`);return {url:finalUrl,text:await readResponseText(r,2*1024*1024)};}
function htmlText(h){return (h||"").replace(/<script[\s\S]*?<\/script>/gi," ").replace(/<style[\s\S]*?<\/style>/gi," ").replace(/<[^>]+>/g," ").replace(/&nbsp;/gi," ").replace(/&amp;/gi,"&").replace(/\s+/g," ").trim();}


async function searchWebLinks(query){
  // Keyless best-effort fallback. Search results are evidence leads only; every
  // candidate is opened and verified before it can affect the trust verdict.
  try{
    const {text}=await fetchText(`https://www.google.com/search?q=${encodeURIComponent(query)}`,12000);
    const links=[]; let m; const re=/href=["']\/url\?q=([^&"']+)/gi;
    while((m=re.exec(text))){try{const u=decodeURIComponent(m[1]);if(/^https?:/i.test(u))links.push(u);}catch{}}
    return [...new Set(links)].slice(0,12);
  }catch{return [];}
}
function editionYearsFromText(text, venue){
  const years=new Set();
  const acr=acronymOf(venue).replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
  const nameTokens=[...tokens(venue.name)].slice(0,5);
  const yearRe=/\b(19|20)\d{2}\b/g; let m;
  while((m=yearRe.exec(text||""))){
    const y=Number(m[0]); const around=(text||"").slice(Math.max(0,m.index-140),m.index+180);
    const identity=(acr&&new RegExp(`\\b${acr}\\b`,`i`).test(around))||nameTokens.filter(t=>norm(around).includes(t)).length>=2;
    if(identity) years.add(y);
  }
  return [...years];
}
async function officialHistoryEvidence(venue,page){
  const base=page||await pageAndLinks(venue.cfpUrl||venue.url);
  let common=[];
  try{
    const root=new URL(venue.cfpUrl||venue.url);
    common=["history.html","history","previous.html","previous-editions.html","archive.html","proceedings.html"].map(x=>new URL(x,`${root.protocol}//${root.host}/`).toString());
  }catch{}
  const candidates=[
    venue.historyUrl, venue.previousEditionsUrl,
    ...(base.links||[]).filter(u=>HISTORY_LINK_RE.test(u)),
    ...common
  ].filter(Boolean);
  const records=[],years=new Set(),publisherLinks=[];
  for(const u of [...new Set(candidates)].slice(0,8)){
    try{
      const p=await pageAndLinks(u);
      const ys=editionYearsFromText(p.plain,venue);
      for(const y of ys)years.add(y);
      const pub=(p.links||[]).filter(x=>hostIsGood(hostOf(x))&&/(dl\.acm|ieeexplore|springer|aclanthology|ceur-ws|proceedings\.mlr|dblp)/i.test(x));
      publisherLinks.push(...pub);
      if(ys.length||pub.length)records.push({url:p.url,years:ys,publisherLinks:pub.slice(0,10)});
    }catch{}
  }
  return {source:"Official history",years:[...years],records,publisherLinks:[...new Set(publisherLinks)]};
}
async function webSearchHistoryEvidence(venue){
  const acr=acronymOf(venue); const claimed=claimedEditionFromText(venue.name||"");
  if(!claimed||claimed<2)return {source:"Web search",years:[],records:[],publisherLinks:[]};
  const expectedYear=new Date().getFullYear()-1;
  const queries=[
    `"${venue.name}" previous editions proceedings`,
    `"${acr}" ${expectedYear} proceedings`,
    `site:dl.acm.org "${acr}" proceedings`,
    `site:link.springer.com "${acr}" proceedings`,
    `site:ieeexplore.ieee.org "${acr}" proceedings`
  ];
  const found=[];for(const q of queries){found.push(...await searchWebLinks(q));if(found.length>18)break;}
  const years=new Set(),records=[],publisherLinks=[];
  for(const u of [...new Set(found)].slice(0,14)){
    try{
      const p=await pageAndLinks(u); const identity=similarity(p.plain,venue.name)>0.045||norm(p.plain).includes(norm(acr));
      if(!identity)continue; const ys=editionYearsFromText(p.plain,venue);for(const y of ys)years.add(y);
      if(hostIsGood(hostOf(p.url)))publisherLinks.push(p.url);
      records.push({url:p.url,years:ys});
    }catch{}
  }
  return {source:"Web search",years:[...years],records,publisherLinks:[...new Set(publisherLinks)]};
}

async function crossrefProceedings(venue){
  const q=encodeURIComponent(venue.name||venue.acronym||"");
  const data=await fetchJSON(`https://api.crossref.org/works?query.container-title=${q}&filter=type:proceedings-article&rows=60&select=container-title,published,publisher,DOI,URL`);
  const acr=norm(acronymOf(venue)), name=venue.name||""; const years=new Set(),pubs=new Set(),records=[];
  for(const it of data?.message?.items||[]){
    const ct=(it["container-title"]||[]).join(" ");
    const hit=(acr&&new RegExp(`\\b${acr}\\b`,"i").test(norm(ct)))||similarity(ct,name)>=0.55;
    if(!hit)continue; const y=it.published?.["date-parts"]?.[0]?.[0]; if(y)years.add(y); if(it.publisher)pubs.add(it.publisher);
    records.push({year:y||null,title:ct,publisher:it.publisher||null,doi:it.DOI||null,url:it.URL||null});
  }
  return {source:"Crossref",years:[...years],publishers:[...pubs],records:records.slice(0,12)};
}
async function dblpProceedings(venue){
  const query=encodeURIComponent(`${acronymOf(venue)} ${venue.name||""}`);
  const data=await fetchJSON(`https://dblp.org/search/publ/api?q=${query}&h=100&format=json`);
  const hits=data?.result?.hits?.hit||[]; const years=new Set(),records=[];
  for(const h of hits){const i=h.info||{}; const title=String(i.title||"").replace(/<[^>]+>/g,""); if(similarity(title,venue.name||venue.acronym)<0.35&&!new RegExp(`\\b${acronymOf(venue)}\\b`,"i").test(title))continue; const y=Number(i.year);if(y)years.add(y);records.push({year:y||null,title,url:i.url||i.ee||null});}
  return {source:"DBLP",years:[...years],records:records.slice(0,15)};
}

export async function checkProceedingsHistory(venue, pageText="", page=null){
  const out={checked:true,established:false,editionsFound:0,years:[],recentYears:[],publishers:[],sources:[],corroboratedSources:0,claimedEdition:claimedEditionFromText(`${venue.name||""} ${pageText}`),reputablePublisher:false,officialHistoryConfirmed:false,webSearchAttempted:false,publisherEvidenceUrls:[]};
  const tasks=[crossrefProceedings(venue),dblpProceedings(venue),officialHistoryEvidence(venue,page)];
  if((out.claimedEdition||0)>=2)tasks.push(webSearchHistoryEvidence(venue));
  const results=await Promise.allSettled(tasks);
  const allYears=new Set(),pubs=new Set(),publisherUrls=new Set();
  for(const r of results){
    if(r.status!=="fulfilled")continue; const v=r.value;out.sources.push(v);
    for(const y of v.years||[])allYears.add(y);for(const p of v.publishers||[])pubs.add(p);for(const u of v.publisherLinks||[])publisherUrls.add(u);
    if(v.source==="Official history"&&(v.years?.length||v.publisherLinks?.length))out.officialHistoryConfirmed=true;
    if(v.source==="Web search")out.webSearchAttempted=true;
  }
  out.corroboratedSources=out.sources.filter(s=>(s.years||[]).length>0).length;
  out.years=[...allYears].sort();out.editionsFound=out.years.length;out.publishers=[...pubs];out.publisherEvidenceUrls=[...publisherUrls];
  out.reputablePublisher=out.publishers.some(x=>GOOD_PUBLISHERS.some(p=>norm(x).includes(p)))||out.publisherEvidenceUrls.some(u=>hostIsGood(hostOf(u)));
  // Legitimacy is based on recent continuity, not reconstructing the full edition count.
  // Conference names, acronyms, and publishers can change over a long-running series.
  const eventYear = Number(String(venue.eventDates || venue.deadline || "").match(/20\d{2}/)?.[0]) || new Date().getFullYear();
  out.recentYears = out.years.filter(y => y >= eventYear - 4 && y < eventYear).sort();
  const recentHistory = out.recentYears.length >= 1;
  const corroboratedRecentHistory = recentHistory && (
    out.corroboratedSources >= 2 ||
    (out.officialHistoryConfirmed && out.publisherEvidenceUrls.length > 0)
  );
  out.established = corroboratedRecentHistory;
  return out;
}

async function openAlexIdentity(venue){
  const ids=exactIssnSet(venue); const data=await fetchJSON(`https://api.openalex.org/sources?search=${encodeURIComponent((venue.name||"").replace(/ — .*/,""))}&per-page=8&mailto=noreply@example.com`);
  let best=null,bestScore=0;
  for(const s of data?.results||[]){const candidateIssns=new Set([s.issn_l,...(s.issn||[])].filter(Boolean).map(x=>String(x).replace(/[^0-9X]/gi,"").toUpperCase())); const issnHit=[...ids].some(x=>candidateIssns.has(x)); const score=issnHit?1:similarity(s.display_name,venue.name); if(score>bestScore){best=s;bestScore=score;}}
  if(!best||bestScore<0.58)return null;
  return {displayName:best.display_name,issn:best.issn||[],issnL:best.issn_l||null,publisher:best.host_organization_name||null,indexedInScopus:!!best.is_indexed_in_scopus,inDOAJ:!!best.is_in_doaj,hIndex:best.summary_stats?.h_index??null,meanCitedness:best.summary_stats?.["2yr_mean_citedness"]??null,matchScore:bestScore,matchedBy:bestScore===1?"ISSN":"exact-title similarity",openAlexId:best.id};
}
async function crossrefJournalIdentity(venue){
  const ids=[...exactIssnSet(venue)];
  if(ids.length){for(const id of ids){try{const d=await fetchJSON(`https://api.crossref.org/journals/${id}`);const m=d?.message;if(m)return {title:m.title||null,issn:m.ISSN||[],publisher:m.publisher||null,matchedBy:"ISSN"};}catch{}}}
  const d=await fetchJSON(`https://api.crossref.org/journals?query=${encodeURIComponent(venue.name||"")}&rows=8`);let best=null,score=0;for(const j of d?.message?.items||[]){const s=similarity(j.title,venue.name);if(s>score){best=j;score=s;}}return best&&score>=0.65?{title:best.title,issn:best.ISSN||[],publisher:best.publisher||null,matchedBy:"title",matchScore:score}:null;
}
async function scimagoCheck(venue){
  try{
    const {text:urlText,url}=await fetchText(`https://www.scimagojr.com/journalsearch.php?q=${encodeURIComponent(venue.name||"")}`);
    const plain=htmlText(urlText); const titleHit=similarity(plain.slice(0,15000),venue.name)>=0.05 || norm(plain).includes(norm(venue.name).slice(0,30));
    const issnHit=[...exactIssnSet(venue)].some(x=>norm(plain).includes(norm(x)));
    if(!titleHit&&!issnHit)return {checked:true,confirmed:false,url};
    const q=(plain.match(/\bQ[1-4]\b/)||[])[0]||null;
    return {checked:true,confirmed:true,quartile:q,url,matchedBy:issnHit?"ISSN":"title"};
  }catch{return {checked:false,confirmed:false};}
}
export async function checkRanking(venue){
  const out={checked:true,confirmed:false,identityConfirmed:false,identityConflict:false,indexedInScopus:null,inDOAJ:null,hIndex:null,meanCitedness:null,source:null,matchedBy:null,scimago:null};
  if(!(venue.type==="journal"||venue.type==="special-issue"))return out;
  const [oa,cr,sjr]=await Promise.allSettled([openAlexIdentity(venue),crossrefJournalIdentity(venue),scimagoCheck(venue)]);
  const O=oa.status==="fulfilled"?oa.value:null,C=cr.status==="fulfilled"?cr.value:null,S=sjr.status==="fulfilled"?sjr.value:null;
  if(O){Object.assign(out,{indexedInScopus:O.indexedInScopus,inDOAJ:O.inDOAJ,hIndex:O.hIndex,meanCitedness:O.meanCitedness,source:"OpenAlex",matchedBy:O.matchedBy,openAlex:O});}
  out.crossref=C;out.scimago=S;
  const titleOK=!!(O||C); const publisherConflict=O?.publisher&&C?.publisher&&similarity(O.publisher,C.publisher)<0.15;
  const suppliedPublisher=venue.publisher&&[O?.publisher,C?.publisher].filter(Boolean).length ? [O?.publisher,C?.publisher].filter(Boolean).every(p=>similarity(p,venue.publisher)<0.15) : false;
  out.identityConflict=!!(publisherConflict||suppliedPublisher);
  out.identityConfirmed=titleOK&&!out.identityConflict;out.confirmed=out.identityConfirmed&&(!!S?.confirmed||!!O?.indexedInScopus||!!O?.inDOAJ||!!C);return out;
}

async function pageAndLinks(url){
  const p=await fetchText(url); const hrefs=[]; let m; const re=/<a[^>]+href=["']([^"']+)["']/gi; while((m=re.exec(p.text))){try{hrefs.push(new URL(m[1],p.url).toString());}catch{}}
  return {url:p.url,plain:htmlText(p.text),links:[...new Set(hrefs)]};
}
export async function checkParentConference(venue,page=null){
  const claimed=venue.type==="workshop"&&/workshop/i.test(`${venue.type} ${venue.name}`);
  const out={checked:claimed,claimed,confirmed:false,parentUrl:null,evidence:null};if(!claimed)return out;
  const parentCandidates=[venue.parentConferenceUrl,venue.parentUrl,...((page?.links||[]).filter(u=>/2026\.(emnlp|acl|naacl|eacl)|neurips\.cc|icml\.cc|iclr\.cc|aaai\.org|thecvf\.com|acm\.org/i.test(u)))].filter(Boolean);
  for(const u of [...new Set(parentCandidates)].slice(0,4)){try{const p=await pageAndLinks(u);const hay=norm(p.plain);const acr=norm(acronymOf(venue));if((acr&&hay.includes(acr))||similarity(p.plain,venue.name)>0.08){return {...out,confirmed:true,parentUrl:p.url,evidence:"Workshop name/acronym found on official parent-conference page."};}}catch{}}
  return out;
}
export async function checkPublisherEvidence(venue,page=null,proceedings=null){
  const claimed=!!venue.publisher||GOOD_PUBLISHERS.some(p=>norm(page?.plain).includes(p));
  const out={checked:true,claimed,currentEditionConfirmed:false,priorProceedingsPublisherConfirmed:false,publisher:venue.publisher||null,evidenceUrls:[],priorEvidenceUrls:[]};
  const candidates=[venue.proceedingsUrl,venue.publisherUrl,...((page?.links||[]).filter(u=>hostIsGood(hostOf(u))&&/(proceed|antholog|xplore|dl\.acm|springer|ceur|pmlr)/i.test(u)))].filter(Boolean);
  const year=String((venue.deadline||venue.eventDates||new Date().getFullYear()).match?.(/20\d{2}/)?.[0]||"");
  for(const u of [...new Set(candidates)].slice(0,7)){try{const p=await pageAndLinks(u);const h=hostOf(p.url);const identity=(norm(p.plain).includes(norm(acronymOf(venue)))||similarity(p.plain,venue.name)>0.06);const yearHit=!year||p.plain.includes(year);if(hostIsGood(h)&&identity&&yearHit){out.currentEditionConfirmed=true;out.evidenceUrls.push(p.url);break;}}catch{}}
  const priorCandidates=[...(proceedings?.publisherEvidenceUrls||[])];
  for(const src of proceedings?.sources||[])for(const rec of src.records||[])if(rec.url)priorCandidates.push(rec.url);
  for(const u of [...new Set(priorCandidates)].slice(0,16)){
    try{const p=await pageAndLinks(u);const h=hostOf(p.url);const identity=norm(p.plain).includes(norm(acronymOf(venue)))||similarity(p.plain,venue.name)>0.045;if(hostIsGood(h)&&identity){out.priorProceedingsPublisherConfirmed=true;out.priorEvidenceUrls.push(p.url);if(out.priorEvidenceUrls.length>=2)break;}}catch{}
  }
  return out;
}


export async function deepLegitimacyCheck(venue){
  let page=null;try{if(venue.cfpUrl||venue.url)page=await pageAndLinks(venue.cfpUrl||venue.url);}catch{}
  const proceedings=await checkProceedingsHistory(venue,page?.plain||"",page);
  const [ranking,parentConference,publisherEvidence]=await Promise.all([
    checkRanking(venue),checkParentConference(venue,page),checkPublisherEvidence(venue,page,proceedings)
  ]);
  const enriched={...venue,legitimacy:{...(venue.legitimacy||{}),proceedings,ranking,parentConference,publisherEvidence}};
  const base=legitimacyOf(enriched);
  let llm=null;
  try{
    const {chat,parseJSONLoose,llmReady}=await import("./llm.js");
    if(page?.plain?.length>150&&llmReady()){
      const out=await chat([
        {
          role:"system",
          content:`Assess academic venue legitimacy. Focus on copied names, implausible edition claims, fake sponsor/publisher/indexing claims, conference-farm behavior, missing committee/contact details, and contradictory dates. Return strict JSON only. ${UNTRUSTED_CONTENT_RULE}`,
        },
        {
          role:"user",
          content:`${untrustedPromptField("PAGE",page.plain,9000)}\n\n${untrustedPromptField("STRUCTURED EVIDENCE",JSON.stringify({proceedings,ranking,parentConference,publisherEvidence}),30000)}\n\nReturn {\"verdict\":\"legitimate\"|\"uncertain\"|\"likely_predatory\",\"redFlags\":[],\"positiveSignals\":[],\"confidence\":0}.`,
        },
      ],{json:true,temperature:0,maxTokens:600});
      llm=parseJSONLoose(out);
    }
  }catch{}
  let level=base.level;if(llm?.verdict==="likely_predatory"&&base.level!=="trusted")level="caution";
  return {...base,level,proceedings,ranking,parentConference,publisherEvidence,llm,checkedAt:new Date().toISOString()};
}
