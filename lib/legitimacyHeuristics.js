const GOOD_HOST_PATTERNS = [
  "openreview.net","aaai.org","acm.org","dl.acm.org","ieee.org","computer.org","ieeexplore.ieee.org",
  "aclweb.org","aclanthology.org","aclrollingreview.org","neurips.cc","icml.cc","iclr.cc","thecvf.com",
  "springer.com","link.springer.com","sciencedirect.com","elsevier.com","jmlr.org","proceedings.mlr.press",
  "dblp.org","ceur-ws.org","usenix.org","sigmod.org","kdd.org","sigir.org","recsys.acm.org"
];
export const HISTORY_LINK_RE = /(history|previous|past[-_ ]?(editions?|years?|conferences?)|archive|proceedings?|publications?)/i;
export const GOOD_PUBLISHERS = ["ieee","acm","springer","elsevier","wiley","aaai","usenix","pmlr","jmlr","acl anthology"];
const RANKED = new Set(["A*","A","B","C","Q1","Q2","Q3","Q4"]);
const SUSPICIOUS_HOST = /(\.online$|\.site$|\.info$|\.website$|\.conferences?\.(com|org|net)|\.engii\.|zmeeting|scitevents)/i;

export function hostOf(url){try{return new URL(url).hostname.replace(/^www\./,"").toLowerCase();}catch{return "";}}
export function hostIsGood(host){return GOOD_HOST_PATTERNS.some(g=>host===g||host.endsWith("."+g));}
export function norm(s){return (s||"").toLowerCase().replace(/&/g," and ").replace(/[^a-z0-9]+/g," ").trim();}
function tokens(s){return new Set(norm(s).split(" ").filter(x=>x.length>2));}
export function similarity(a,b){const A=tokens(a),B=tokens(b);if(!A.size||!B.size)return 0;let n=0;for(const x of A)if(B.has(x))n++;return n/Math.max(A.size,B.size);}
export function acronymOf(v){const m=(v.acronym||"").match(/[A-Za-z][A-Za-z0-9-]{1,15}/);return m?m[0].replace(/\d{4}$/ ,""):"";}
export function claimedEditionFromText(s){
  const m=(s||"").match(/\b(\d{1,3})(?:st|nd|rd|th)\s+(?:annual\s+)?(?:international\s+)?(?:conference|workshop|symposium|meeting|forum|congress)\b/i);
  return m?Number(m[1]):null;
}
export function exactIssnSet(v){return new Set([v.issn,v.eissn,...(v.issns||[])].filter(Boolean).map(x=>String(x).replace(/[^0-9X]/gi,"").toUpperCase()));}

export function legitimacyOf(venue){
  const reasons=[]; let good=0,bad=0;
  const host=hostOf(venue.cfpUrl)||hostOf(venue.url);
  const dd=venue.legitimacy||{};
  const p=dd.proceedings||{};
  const r=dd.ranking||{};
  const parent=dd.parentConference||{};
  const publisher=dd.publisherEvidence||{};
  const priorPublisherConfirmed = !!(publisher.priorProceedingsPublisherConfirmed || (p.publisherEvidenceUrls || []).some(u => hostIsGood(hostOf(u))));

  if(hostIsGood(host)){good+=1;reasons.push("Official society, publisher, repository, or established venue domain.");}
  if(SUSPICIOUS_HOST.test(host)){bad+=2;reasons.push("Domain pattern is common among conference farms or disposable CFP sites.");}
  if(!host){bad+=1;reasons.push("No usable official venue URL.");}

  if(venue.type==="journal"||venue.type==="special-issue"){
    if(r.identityConfirmed){good+=2;reasons.push(`Journal identity confirmed${r.matchedBy?` by ${r.matchedBy}`:""}.`);}
    if(r.scimago?.confirmed){good+=2;reasons.push(`SCImago listing confirmed${r.scimago.quartile?` (${r.scimago.quartile})`:""}.`);}
    else if(r.indexedInScopus||r.inDOAJ){good+=1;reasons.push("Independent indexing signal confirmed via OpenAlex/DOAJ metadata.");}
    if(r.identityConflict){bad+=3;reasons.push("Journal title/ISSN/publisher identity conflict detected.");}
  } else {
    if(p.established && priorPublisherConfirmed){good+=3;reasons.push("Recent prior editions verified on an established publisher/repository site.");}
    else if(p.established){good+=1;reasons.push("Prior proceedings found, but only one independent source corroborated them.");}
    if(p.checked&&!p.established){bad+=2;reasons.push("No convincing prior-proceedings history was independently verified.");}
    if(publisher.currentEditionConfirmed){good+=2;reasons.push("Current edition publication route confirmed on a publisher/repository domain.");}
    else if(publisher.claimed&&!publisher.currentEditionConfirmed){reasons.push("Publisher is claimed by the organiser but not independently confirmed for this edition.");}
    if(venue.type==="workshop"){
      if(parent.confirmed){good+=3;reasons.push("Workshop is listed by the official parent-conference site.");}
      else if(parent.claimed&&!parent.confirmed){bad+=1;reasons.push("Co-location is claimed but no official parent-conference listing was confirmed.");}
    }
  }

  if(RANKED.has(venue.tier) && (r.identityConfirmed || p.established)){good+=1;reasons.push(`Recognised rank (${venue.tier}) supports the independently matched venue identity.`);}
  if(venue.source==="openreview"){good+=1;reasons.push("Submission/review venue is present on OpenReview.");}
  if(venue.verification?.status==="unreachable"){bad+=1;reasons.push("Official page could not be reached during verification.");}
  if(venue.source==="other"&&!hostIsGood(host)&&!r.identityConfirmed&&!p.established){bad+=1;reasons.push("Unrecognised source without independent identity or proceedings evidence.");}

  const decisive = (venue.type==="journal"||venue.type==="special-issue")
    ? !!(r.identityConfirmed && (r.scimago?.confirmed || r.indexedInScopus || r.inDOAJ))
    : !!((p.established && priorPublisherConfirmed) || publisher.currentEditionConfirmed || parent.confirmed);
  let level="review";
  if(bad>=3 || (bad>=2&&!decisive)) level="caution";
  else if(decisive && good>=3 && bad===0) level="trusted";
  return {level,score:good-bad,reasons,evidenceQuality:decisive?"corroborated":"partial"};
}
