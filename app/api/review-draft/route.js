import { NextResponse } from "next/server";
import { chat, parseJSONLoose, llmReady } from "@/lib/llm";
import { findModel } from "@/lib/models";
import { getActiveCFPs } from "@/lib/cfp";
import { apiErrorResponse, guardExpensiveRequest, parseLimitedFormData } from "@/lib/apiSecurity";
import { textFromPaperInput } from "@/lib/paperInput";
import { UNTRUSTED_CONTENT_RULE, untrustedPromptField } from "@/lib/promptSecurity";
import { paperPromptExcerpt, venueContextForPaper } from "@/lib/venuePrompt";

export const dynamic = "force-dynamic";
export const maxDuration = 300;
const MAX_PAPER_CHARS = 70000;

const SYSTEM = `You are a rigorous but constructive senior academic reviewer and research mentor. Review the full research-paper draft, diagnose what would prevent acceptance, distinguish fatal flaws from polish issues, and propose concrete revisions, experiments, baselines, ablations, analyses, figures, and writing changes. Do not invent results or promise acceptance. Return strict JSON only.
${UNTRUSTED_CONTENT_RULE}`;

function buildPrompt(text, venues, target) {
  const excerpt = paperPromptExcerpt(text);
  const { context, selected, totalCount } = venueContextForPaper(venues, `${text.slice(0, 11_000)}\n${target}`);
  return `The application searched all ${totalCount} open venues and selected ${selected.length} candidates for detailed model review.\n\n${untrustedPromptField("CURRENTLY OPEN VENUE CANDIDATES", context, 24_000)}\n\n${untrustedPromptField("REPRESENTATIVE PAPER DRAFT EXCERPT", excerpt, 6_000)}\n\n${untrustedPromptField("AUTHOR TARGET", target || "No specific venue supplied; assess generally and against the live venue list.", 1_000)}\n\nReturn JSON exactly as:
{"overallAssessment":"...","readinessScore":0,"paperType":"...","coreContribution":"...","strongestAspects":["..."],"acceptanceRisks":[{"severity":"critical | major | moderate | minor","issue":"...","whyItMatters":"...","specificFix":"..."}],"sectionReview":{"titleAbstract":["..."],"introduction":["..."],"relatedWork":["..."],"methodology":["..."],"experiments":["..."],"resultsDiscussion":["..."],"limitationsEthics":["..."],"reproducibility":["..."]},"mustRunExperiments":[{"experiment":"...","purpose":"...","minimumEvidence":"..."}],"writingImprovements":["..."],"positioningAdvice":"...","recommendedVenueLevel":"...","bestFitOpenVenues":[{"id":"exact venue id","fitScore":0,"why":"...","changesBeforeSubmission":["..."]}],"revisionPlan":[{"priority":1,"task":"...","expectedImpact":"..."}],"verdict":"not ready | promising but needs major revision | near submission-ready | submission-ready"}
Choose at most 3 venues, only from the supplied list. Be specific to this draft.`;
}

export async function POST(req) {
  const blocked = guardExpensiveRequest(req, "review-draft", { limit: 12 });
  if (blocked) return blocked;
  try {
    const form = await parseLimitedFormData(req);
    const file = form.get("file");
    const url = (form.get("url") || "").toString().trim();
    const target = (form.get("target") || "").toString().trim().slice(0, 1_000);
    const chosen = findModel(form.get("model")?.toString());
    if (!chosen) return NextResponse.json({ error: "Choose a valid model from the model picker." }, { status: 400 });
    const modelOpts = { model: chosen.id, provider: chosen.provider, bodyExtra: chosen.bodyExtra };
    if (!llmReady(modelOpts)) return NextResponse.json({ error: `LLM not configured. Set ${chosen.provider === "nvidia" ? "NVIDIA_API_KEY" : "GROQ_API_KEY"} in .env.local.` }, { status: 503 });

    const text = await textFromPaperInput({ file, url, maxChars: MAX_PAPER_CHARS });
    if (!text || text.trim().length < 500) return NextResponse.json({ error: "Could not read enough draft text. Upload a text-based PDF or provide a readable hosted-paper URL." }, { status: 400 });

    const { items: venues } = getActiveCFPs(new Date());
    const content = await chat([{ role: "system", content: SYSTEM }, { role: "user", content: buildPrompt(text, venues, target) }], { json: true, temperature: 0.15, maxTokens: 2400, ...modelOpts });
    const parsed = parseJSONLoose(content);
    if (!parsed) return NextResponse.json({ error: "The model returned an unreadable review. Try again." }, { status: 502 });

    const byId = new Map(venues.map((v) => [v.id, v]));
    parsed.bestFitOpenVenues = (parsed.bestFitOpenVenues || []).map((r) => {
      const v = byId.get(r.id);
      return v ? { ...r, venue: { id: v.id, acronym: v.acronym, name: v.name, type: v.type, deadline: v.deadline, url: v.url, cfpUrl: v.cfpUrl, publisher: v.publisher, format: v.format } } : null;
    }).filter(Boolean).slice(0, 3);
    return NextResponse.json(parsed, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return apiErrorResponse(e, "Draft review failed.");
  }
}
