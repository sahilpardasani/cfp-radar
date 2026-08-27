import { fetchRemote, readResponseText } from "../../safeFetch.js";

function normalizedDoi(value) {
  return String(value || "").toLowerCase().replace(/^https?:\/\/doi\.org\//, "").trim();
}

function abstractFromInvertedIndex(index) {
  if (!index || typeof index !== "object") return null;
  const words = [];
  for (const [word, positions] of Object.entries(index)) {
    for (const position of positions || []) words[position] = word;
  }
  return words.filter(Boolean).join(" ") || null;
}

async function fetchJson(url) {
  const { response } = await fetchRemote(url, {
    headers: { "User-Agent": "CFP-Radar-VenueHistory/1.0" },
    timeoutMs: 30_000,
  });
  if (!response.ok) throw new Error(`OpenAlex request failed (HTTP ${response.status}).`);
  return JSON.parse(await readResponseText(response, 8 * 1024 * 1024));
}

export async function enrichPapersWithOpenAlex(papers, providerConfig = {}) {
  const apiKey = process.env.OPENALEX_API_KEY;
  if (!apiKey || providerConfig.enabled === false) return { papers, enriched: 0, skipped: "OPENALEX_API_KEY is not configured" };
  const baseUrl = providerConfig.baseUrl || "https://api.openalex.org";
  const byDoi = new Map();
  for (const paper of papers) if (paper.doi) byDoi.set(normalizedDoi(paper.doi), paper);
  const dois = [...byDoi.keys()];
  let enriched = 0;

  for (let index = 0; index < dois.length; index += 50) {
    const batch = dois.slice(index, index + 50);
    const filter = batch.map((doi) => `https://doi.org/${doi}`).join("|");
    const params = new URLSearchParams({
      filter: `doi:${filter}`,
      "per-page": "50",
      select: "id,doi,title,abstract_inverted_index,cited_by_count,open_access,primary_location,topics,publication_year",
      api_key: apiKey,
    });
    const data = await fetchJson(`${baseUrl.replace(/\/$/, "")}/works?${params}`);
    for (const work of data.results || []) {
      const paper = byDoi.get(normalizedDoi(work.doi));
      if (!paper) continue;
      paper.openAlexId = work.id || null;
      paper.abstract = abstractFromInvertedIndex(work.abstract_inverted_index);
      paper.citationCount = Number.isFinite(work.cited_by_count) ? work.cited_by_count : null;
      paper.openAccessUrl = work.open_access?.oa_url || (work.open_access?.is_oa ? work.primary_location?.landing_page_url : null);
      paper.openAlexTopics = (work.topics || []).slice(0, 5).map((topic) => topic.display_name).filter(Boolean);
      enriched += 1;
    }
  }
  return { papers, enriched, skipped: null };
}

export const __test = { normalizedDoi, abstractFromInvertedIndex };
