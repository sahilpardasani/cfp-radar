import { NextResponse } from "next/server";
import { extractLinksAndDois } from "@/lib/pdf";
import { chat, parseJSONLoose, llmReady } from "@/lib/llm";
import { findModel } from "@/lib/models";
import { apiErrorResponse, guardExpensiveRequest, parseLimitedFormData } from "@/lib/apiSecurity";
import { textFromPaperInput } from "@/lib/paperInput";
import { fetchRemote } from "@/lib/safeFetch";
import { mapLimit } from "@/lib/asyncPool";
import { UNTRUSTED_CONTENT_RULE, untrustedPromptField } from "@/lib/promptSecurity";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const SYSTEM = `You are a citation-integrity agent. Given the text of a research paper, extract its bibliography/references as structured data.
Return STRICT JSON only. Do not invent references that are not in the text.
${UNTRUSTED_CONTENT_RULE}`;

function buildPrompt(text) {
  const clipped = text.slice(-14000); // references live at the end of a paper
  return `From the paper text below, extract every bibliographic reference you can find.
Return JSON:
{
  "references": [
    { "title": "...", "authors": "first author et al. or null", "year": "YYYY or null", "doi": "10.xxxx/... or null", "url": "http... or null" }
  ]
}
Only include references actually present. If none are found, return an empty array.
${untrustedPromptField("PAPER TEXT (tail)", clipped, 14_000)}`;
}

async function checkUrl(url) {
  try {
    let { response: res } = await fetchRemote(url, {
      method: "HEAD",
      headers: { "User-Agent": "CFP-Radar-RefCheck/1.0" },
      timeoutMs: 12000,
    });
    // Some servers reject HEAD; retry with GET.
    if (res.status === 405 || res.status === 501) {
      await res.body?.cancel().catch(() => {});
      ({ response: res } = await fetchRemote(url, {
        method: "GET",
        headers: { "User-Agent": "CFP-Radar-RefCheck/1.0", Range: "bytes=0-0" },
        timeoutMs: 12000,
      }));
    }
    const result = { ok: res.status >= 200 && res.status < 400, status: res.status };
    await res.body?.cancel().catch(() => {});
    return result;
  } catch (e) {
    return { ok: false, status: 0, error: e.name === "TimeoutError" ? "timeout" : "unreachable" };
  }
}

async function checkDoi(doi) {
  try {
    const normalized = String(doi || "").trim().slice(0, 300);
    if (!/^10\.\d{4,9}\/\S+$/i.test(normalized)) return { exists: false };
    const res = await fetch(`https://api.crossref.org/works/${encodeURIComponent(normalized)}`, {
      headers: { "User-Agent": "CFP-Radar-RefCheck/1.0 (mailto:noreply@example.com)" },
      signal: AbortSignal.timeout(12000),
    });
    if (res.ok) {
      const data = await res.json();
      const title = data?.message?.title?.[0] || null;
      return { exists: true, resolvedTitle: title };
    }
    return { exists: false };
  } catch {
    return { exists: null };
  }
}

async function searchCrossrefByTitle(title) {
  try {
    const query = String(title || "").trim().slice(0, 500);
    if (!query) return { match: null };
    const res = await fetch(
      `https://api.crossref.org/works?rows=1&query.bibliographic=${encodeURIComponent(query)}`,
      {
        headers: { "User-Agent": "CFP-Radar-RefCheck/1.0 (mailto:noreply@example.com)" },
        signal: AbortSignal.timeout(12000),
      }
    );
    if (!res.ok) return { match: null };
    const data = await res.json();
    const item = data?.message?.items?.[0];
    if (!item) return { match: null };
    const foundTitle = (item.title?.[0] || "").toLowerCase();
    const q = query.toLowerCase();
    // crude similarity: shared word ratio
    const qWords = new Set(q.split(/\W+/).filter((w) => w.length > 3));
    const fWords = new Set(foundTitle.split(/\W+/).filter((w) => w.length > 3));
    let shared = 0;
    for (const w of qWords) if (fWords.has(w)) shared++;
    const ratio = qWords.size ? shared / qWords.size : 0;
    return { match: ratio >= 0.6 ? { title: item.title?.[0], doi: item.DOI } : null, ratio };
  } catch {
    return { match: null };
  }
}

export async function POST(req) {
  const blocked = guardExpensiveRequest(req, "verify-refs", { limit: 12 });
  if (blocked) return blocked;
  try {
    const form = await parseLimitedFormData(req);
    const file = form.get("file");
    let text = form.get("text") || "";
    const requestedModel = form.get("model")?.toString();
    const chosen = findModel(requestedModel);
    if (!chosen) {
      return NextResponse.json({ error: "Choose a valid model from the model picker." }, { status: 400 });
    }
    const modelOpts = { model: chosen.id, provider: chosen.provider, bodyExtra: chosen.bodyExtra };
    const url = (form.get("url") || "").toString().trim();
    try {
      text = await textFromPaperInput({ file, url, text, maxChars: 100_000 });
    } catch (e) {
      return apiErrorResponse(e, "Could not read the paper from that URL.");
    }
    if (!text || text.trim().length < 200) {
      return NextResponse.json({ error: "Could not read enough text from the paper (upload a PDF or paste a paper URL)." }, { status: 400 });
    }

    // 1) Structured references via LLM (if configured); always also grab raw links/DOIs.
    let references = [];
    if (llmReady(modelOpts)) {
      try {
        const content = await chat(
          [
            { role: "system", content: SYSTEM },
            { role: "user", content: buildPrompt(text) },
          ],
          { json: true, temperature: 0, maxTokens: 2500, ...modelOpts }
        );
        const parsed = parseJSONLoose(content);
        if (parsed && Array.isArray(parsed.references)) references = parsed.references;
      } catch {
        // fall through to heuristic
      }
    }

    const { urls, dois } = extractLinksAndDois(text);
    // Merge heuristic links/DOIs that the LLM may have missed.
    const seenDoi = new Set(references.map((r) => (r.doi || "").toLowerCase()));
    for (const d of dois) {
      if (!seenDoi.has(d.toLowerCase())) {
        references.push({ title: null, doi: d, url: null, year: null, authors: null });
        seenDoi.add(d.toLowerCase());
      }
    }
    const seenUrl = new Set(references.map((r) => (r.url || "").toLowerCase()));
    for (const u of urls) {
      if (!seenUrl.has(u.toLowerCase())) {
        references.push({ title: null, doi: null, url: u, year: null, authors: null });
        seenUrl.add(u.toLowerCase());
      }
    }

    // 2) Verify each reference concurrently.
    const checked = await mapLimit(
      references.slice(0, 80),
      6,
      async (r) => {
        const out = { ...r, checks: {}, verdict: "unknown" };

        if (r.doi) {
          const d = await checkDoi(r.doi);
          out.checks.doi = d;
          if (d.exists === true) out.verdict = "verified";
          else if (d.exists === false) out.verdict = "not_found";
        }

        if (out.verdict !== "verified" && r.url) {
          const u = await checkUrl(r.url);
          out.checks.url = u;
          if (u.ok) out.verdict = out.verdict === "not_found" ? "not_found" : "verified";
          else if (out.verdict === "unknown") out.verdict = "unreachable";
        }

        if (out.verdict !== "verified" && r.title && !r.doi) {
          const s = await searchCrossrefByTitle(r.title);
          out.checks.crossref = s;
          if (s.match) out.verdict = "verified";
          else out.verdict = "not_found";
        }

        return out;
      }
    );

    const summary = {
      total: checked.length,
      verified: checked.filter((c) => c.verdict === "verified").length,
      notFound: checked.filter((c) => c.verdict === "not_found").length,
      unreachable: checked.filter((c) => c.verdict === "unreachable").length,
      unknown: checked.filter((c) => c.verdict === "unknown").length,
    };

    return NextResponse.json({ summary, references: checked }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return apiErrorResponse(e, "Verification failed.");
  }
}
