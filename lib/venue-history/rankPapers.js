function normalize(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STOP = new Set(["a", "an", "and", "are", "at", "for", "from", "in", "is", "of", "on", "or", "the", "to", "with"]);
function tokens(value) {
  return normalize(value).split(" ").filter((token) => token.length > 1 && !STOP.has(token));
}

function documentFor(paper) {
  const high = tokens([paper.title, ...(paper.topics || []), ...(paper.methodTags || [])].join(" "));
  const body = tokens([paper.abstract, ...(paper.authors || []).map((author) => author.name)].filter(Boolean).join(" "));
  return { paper, high, body, length: high.length * 2.5 + body.length || 1 };
}

function bm25(documents, query) {
  const terms = [...new Set(tokens(query))];
  if (!terms.length) return documents.map((document) => ({ ...document, score: 0 }));
  const averageLength = documents.reduce((sum, document) => sum + document.length, 0) / Math.max(1, documents.length);
  const documentFrequency = new Map(terms.map((term) => [
    term,
    documents.filter((document) => document.high.includes(term) || document.body.includes(term)).length,
  ]));
  return documents.map((document) => {
    let score = 0;
    for (const term of terms) {
      const frequency = document.high.filter((token) => token === term).length * 2.5 + document.body.filter((token) => token === term).length;
      if (!frequency) continue;
      const inverse = Math.log(1 + (documents.length - documentFrequency.get(term) + 0.5) / (documentFrequency.get(term) + 0.5));
      const denominator = frequency + 1.2 * (0.25 + 0.75 * document.length / Math.max(1, averageLength));
      score += inverse * (frequency * 2.2 / denominator);
    }
    return { ...document, score };
  });
}

function diversify(ranked, limit) {
  const selected = [];
  const usedTopics = new Map();
  const remaining = [...ranked];
  while (remaining.length && selected.length < limit) {
    remaining.sort((a, b) => {
      const noveltyA = Math.max(0, ...(a.paper.topics || []).map((topic) => 1 / (1 + (usedTopics.get(topic) || 0))), 0.2);
      const noveltyB = Math.max(0, ...(b.paper.topics || []).map((topic) => 1 / (1 + (usedTopics.get(topic) || 0))), 0.2);
      return (b.score + noveltyB * 0.7) - (a.score + noveltyA * 0.7);
    });
    const next = remaining.shift();
    selected.push(next);
    for (const topic of next.paper.topics || []) usedTopics.set(topic, (usedTopics.get(topic) || 0) + 1);
  }
  return selected;
}

export function rankVenuePapers(papers, {
  query = "", sort = "relevance", year, topic, method, openAccess = false, offset = 0, limit = 20,
} = {}) {
  let filtered = papers.filter((paper) => {
    if (year && paper.eventYear !== Number(year)) return false;
    if (topic && !(paper.topics || []).includes(topic)) return false;
    if (method && !(paper.methodTags || []).includes(method)) return false;
    if (openAccess && !paper.openAccessUrl) return false;
    return true;
  });
  let ranked = bm25(filtered.map(documentFor), query);
  if (sort === "recent") ranked.sort((a, b) => b.paper.eventYear - a.paper.eventYear || a.paper.title.localeCompare(b.paper.title));
  else if (sort === "cited") ranked.sort((a, b) => (b.paper.citationCount || 0) - (a.paper.citationCount || 0) || b.paper.eventYear - a.paper.eventYear);
  else ranked.sort((a, b) => b.score - a.score || b.paper.eventYear - a.paper.eventYear || a.paper.title.localeCompare(b.paper.title));
  if (sort === "representative") ranked = diversify(ranked, ranked.length);
  const total = ranked.length;
  const page = ranked.slice(offset, offset + limit).map(({ paper, score }) => ({ ...paper, relevanceScore: Number(score.toFixed(4)) }));
  return { total, items: page, nextOffset: offset + page.length < total ? offset + page.length : null };
}

export const __test = { normalize, tokens };
