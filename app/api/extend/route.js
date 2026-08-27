import { NextResponse } from "next/server";
import { getActiveCFPs, venueContextLine } from "@/lib/cfp";
import { fetchPaper } from "@/lib/fetchPaper";
import { chat, parseJSONLoose, llmReady } from "@/lib/llm";
import { findModel } from "@/lib/models";
import { apiErrorResponse, guardExpensiveRequest, parseLimitedFormData } from "@/lib/apiSecurity";
import { UNTRUSTED_CONTENT_RULE, untrustedPromptField } from "@/lib/promptSecurity";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_PAPER_CHARS = 60000;
const SYSTEM = `You are an expert research-development and academic venue advisor. The user gives you a published or hosted source paper and a proposed extension they want to turn into a distinct new research contribution. Analyze the full source paper, identify what it already does, test whether the proposed extension is genuinely novel rather than a trivial rerun, strengthen the extension into a defensible contribution, and match the resulting NEW work against currently open conferences, workshops, journals, and special issues. You MUST only recommend venues from the supplied live venue list and reference exact venue ids. Return strict JSON only.
${UNTRUSTED_CONTENT_RULE}`;

function promptFor(paperText, extensionIdea, venues) {
  const full = paperText.length > MAX_PAPER_CHARS ? paperText.slice(0, MAX_PAPER_CHARS) : paperText;
  return `${untrustedPromptField("CURRENTLY OPEN VENUES", venues.map(venueContextLine).join("\n"), 160_000)}\n\n${untrustedPromptField("SOURCE PAPER TEXT", full, MAX_PAPER_CHARS)}\n\n${untrustedPromptField("USER'S PROPOSED EXTENSION", extensionIdea, 6_000)}\n\nReturn JSON exactly in this shape:\n{\n  "sourcePaperSummary": "2-3 sentences",\n  "alreadyCovered": ["important capability/data/experiment already in the paper"],\n  "noveltyAssessment": "strong | moderate | weak as currently stated",\n  "noveltyRisks": ["where the idea may overlap with the original or be only an incremental rerun"],\n  "strengthenedContribution": "a precise one-paragraph framing of the new paper",\n  "researchQuestions": ["RQ1 ...", "RQ2 ..."],\n  "recommendedExperiments": ["specific experiment, dataset, metric, baseline, or analysis"],\n  "candidateTitle": "possible title",\n  "recommendations": [\n    {\n      "id": "exact venue id",\n      "fitScore": 0-100,\n      "why": "why the extended work fits this conference, workshop, journal, or special issue",\n      "deadlineFeasibility": "comfortable | tight | very tight",\n      "requiredChanges": ["specific work needed before submission"]\n    }\n  ]\n}\nRecommend the top 5 across all venue types. Judge the venue against the strengthened NEW contribution, not merely the source paper.`;
}

export async function POST(req) {
  const blocked = guardExpensiveRequest(req, "extend", { limit: 15 });
  if (blocked) return blocked;
  try {
    const form = await parseLimitedFormData(req);
    const url = (form.get("url") || "").toString().trim();
    const extensionIdea = (form.get("extensionIdea") || "").toString().trim().slice(0, 6_000);
    const requestedModel = form.get("model")?.toString();
    const chosen = findModel(requestedModel);
    if (!chosen) return NextResponse.json({ error: "Choose a valid model from the model picker." }, { status: 400 });
    const modelOpts = { model: chosen.id, provider: chosen.provider, bodyExtra: chosen.bodyExtra };
    if (!llmReady(modelOpts)) {
      const need = modelOpts.provider === "nvidia" ? "NVIDIA_API_KEY" : "GROQ_API_KEY";
      return NextResponse.json({ error: `LLM not configured. Set ${need} in .env.local.` }, { status: 503 });
    }
    if (!url) return NextResponse.json({ error: "Paste the hosted source-paper URL." }, { status: 400 });
    if (extensionIdea.length < 30) return NextResponse.json({ error: "Describe the proposed extension in a little more detail." }, { status: 400 });

    let paperText;
    try {
      paperText = (await fetchPaper(url)).text;
    } catch (e) {
      return NextResponse.json({ error: e.message || "Could not read the source paper." }, { status: 400 });
    }
    if (!paperText || paperText.trim().length < 200) return NextResponse.json({ error: "Could not extract enough text from that paper link." }, { status: 400 });

    const { items: venues } = getActiveCFPs(new Date());
    if (!venues.length) return NextResponse.json({ error: "No open venues are available right now." }, { status: 404 });

    const content = await chat([
      { role: "system", content: SYSTEM },
      { role: "user", content: promptFor(paperText, extensionIdea, venues) },
    ], { json: true, temperature: 0.2, maxTokens: 2800, ...modelOpts });

    const parsed = parseJSONLoose(content);
    if (!parsed || !Array.isArray(parsed.recommendations)) return NextResponse.json({ error: "The model returned an unexpected response. Try again." }, { status: 502 });
    const byId = new Map(venues.map((v) => [v.id, v]));
    parsed.recommendations = parsed.recommendations.map((r) => {
      const v = byId.get(r.id);
      if (!v) return null;
      return { ...r, venue: { id: v.id, acronym: v.acronym, name: v.name, type: v.type, tier: v.tier, deadline: v.deadline, url: v.url, cfpUrl: v.cfpUrl, templateUrl: v.templateUrl, format: v.format } };
    }).filter(Boolean).slice(0, 5);
    return NextResponse.json(parsed, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return apiErrorResponse(e, "Extension analysis failed.");
  }
}
