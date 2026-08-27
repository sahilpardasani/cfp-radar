import { NextResponse } from "next/server";
import { getActiveCFPs } from "@/lib/cfp";
import { chat, parseJSONLoose, llmReady } from "@/lib/llm";
import { findModel } from "@/lib/models";
import { apiErrorResponse, guardExpensiveRequest, parseLimitedFormData } from "@/lib/apiSecurity";
import { textFromPaperInput } from "@/lib/paperInput";
import { UNTRUSTED_CONTENT_RULE, untrustedPromptField } from "@/lib/promptSecurity";
import { paperPromptExcerpt, venueContextForPaper } from "@/lib/venuePrompt";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const SYSTEM = `You are an expert academic advisor who matches research papers to the best publication venues.
You are given (a) the text of a paper and (b) a list of currently-open Call-for-Papers venues (conferences, workshops, journals, special issues) taken from a live dashboard.
You MUST only recommend venues from the provided list, referencing them by their exact id.
For each recommendation, judge topical fit, venue tier/prestige vs. the paper's apparent strength, deadline feasibility, and venue legitimacy.
Legitimacy is a ranking gate: prefer independently corroborated conferences/workshops and identity-confirmed journals. Never rank a caution venue above a trusted/review venue solely because its title sounds relevant. Clearly flag partial evidence.
Also produce a concrete "gap analysis": what the author must change to meet each venue's requirements (format/style, page limit, anonymization, missing sections like ethics/repro, template to use).
Return STRICT JSON only.
${UNTRUSTED_CONTENT_RULE}`;

// Extract enough source text to sample the beginning, middle and end. The
// bounded model excerpt is assembled separately to respect provider TPM limits.
const MAX_PAPER_CHARS = 60000;

function buildUserPrompt(paperText, venues) {
  const excerpt = paperPromptExcerpt(paperText);
  const { context, selected, totalCount } = venueContextForPaper(venues, paperText);
  const label = paperText.length > excerpt.length ? "REPRESENTATIVE PAPER EXCERPT" : "PAPER TEXT";
  // Put venue evidence first so stable candidates can benefit from provider
  // prefix caching when similar papers resolve to the same shortlist.
  return `The application deterministically searched all ${totalCount} currently open venues. The ${selected.length} highest-relevance candidates and their full metadata are below.\n\n${untrustedPromptField("OPEN VENUE CANDIDATES", context, 24_000)}\n\n${untrustedPromptField(label, excerpt, 6_000)}\n\nTask: Recommend the TOP 5 best-fit venues from the candidate list above. Consider conferences, workshops, journals, and special issues equally; do not default to conferences. Rank whichever venue types genuinely fit the paper best.
Return JSON with this exact shape:
{
  "paperSummary": "2-3 sentence summary of the paper's topic, method and contribution",
  "detectedTopics": ["..."],
  "recommendations": [
    {
      "id": "<venue id from the list>",
      "fitScore": 0-100,
      "why": "1-2 sentences on why it fits, explicitly naming the venue type and publication model",
      "deadlineFeasibility": "comfortable | tight | very tight",
      "requiredChanges": ["specific change 1", "specific change 2"],
      "templateUrl": "<copy the template url for this venue, or null>"
    }
  ]
}
Order recommendations best-first. Keep requiredChanges specific and actionable.`;
}

export async function POST(req) {
  const blocked = guardExpensiveRequest(req, "recommend", { limit: 20 });
  if (blocked) return blocked;
  try {
    const form = await parseLimitedFormData(req);
    const file = form.get("file");
    let paperText = form.get("text") || "";
    const requestedModel = form.get("model")?.toString();
    const chosen = findModel(requestedModel);
    if (!chosen) {
      return NextResponse.json({ error: "Choose a valid model from the model picker." }, { status: 400 });
    }
    const modelOpts = { model: chosen.id, provider: chosen.provider, bodyExtra: chosen.bodyExtra };

    if (!llmReady(modelOpts)) {
      const need = modelOpts.provider === "nvidia" ? "NVIDIA_API_KEY" : "GROQ_API_KEY (or NVIDIA_API_KEY)";
      return NextResponse.json({ error: `LLM not configured. Set ${need} in the environment.` }, { status: 503 });
    }

    const url = (form.get("url") || "").toString().trim();

    try {
      paperText = await textFromPaperInput({ file, url, text: paperText, maxChars: MAX_PAPER_CHARS });
    } catch (e) {
      return apiErrorResponse(e, "Could not read the paper from that URL.");
    }

    if (!paperText || paperText.trim().length < 200) {
      return NextResponse.json(
        { error: "Could not read enough text from the paper. Upload a text-based (non-scanned) PDF, paste a paper URL (arXiv or a PDF link), or paste the abstract + intro." },
        { status: 400 }
      );
    }

    const { items: venues } = getActiveCFPs(new Date());
    if (!venues.length) {
      return NextResponse.json({ error: "No open venues available right now." }, { status: 404 });
    }

    const content = await chat(
      [
        { role: "system", content: SYSTEM },
        { role: "user", content: buildUserPrompt(paperText, venues) },
      ],
      { json: true, temperature: 0.2, maxTokens: 1600, ...modelOpts }
    );

    const parsed = parseJSONLoose(content);
    if (!parsed || !Array.isArray(parsed.recommendations)) {
      return NextResponse.json({ error: "The model returned an unexpected response. Try again." }, { status: 502 });
    }

    // Enrich each recommendation with the full venue record from the dashboard.
    const byId = new Map(venues.map((v) => [v.id, v]));
    parsed.recommendations = parsed.recommendations
      .map((r) => {
        const v = byId.get(r.id);
        if (!v) return null;
        return {
          ...r,
          // Never let an LLM invent a clickable URL. Links always come from the
          // sanitized dashboard record selected by exact venue id.
          templateUrl: v.templateUrl || null,
          venue: {
            id: v.id,
            acronym: v.acronym,
            name: v.name,
            type: v.type,
            domain: v.domain,
            tier: v.tier,
            deadline: v.deadline,
            url: v.url,
            cfpUrl: v.cfpUrl,
            templateUrl: v.templateUrl,
            format: v.format,
          },
        };
      })
      .filter(Boolean)
      .slice(0, 5);

    return NextResponse.json(parsed, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return apiErrorResponse(e, "Recommendation failed.");
  }
}
