import { NextResponse } from "next/server";
import { getActiveCFPs, venueContextLine } from "@/lib/cfp";
import { chat, llmReady } from "@/lib/llm";
import { findModel } from "@/lib/models";
import { researchVenue, researchContext } from "@/lib/venueResearch";
import { apiErrorResponse, guardExpensiveRequest, parseLimitedFormData } from "@/lib/apiSecurity";
import { textFromPaperInput } from "@/lib/paperInput";
import { UNTRUSTED_CONTENT_RULE, untrustedPromptField } from "@/lib/promptSecurity";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const SYSTEM = `You are an academic venue-selection advisor with a live browsing/research step. Treat official venue and publisher pages as primary evidence. Distinguish confirmed facts, organizer claims, and unknowns. Never claim Scopus, Web of Science, DBLP, IEEE Xplore, ACM DL, ACL Anthology, or Springer-series indexing unless the supplied evidence supports it. Explain archival vs non-archival precisely: archival normally enters formal proceedings and usually blocks duplicate archival publication; non-archival is peer-reviewed/presented but omitted from proceedings and may often be submitted elsewhere, subject to both venues' policies. When a selected workshop explicitly permits non-archival cross-submission and another selected archival venue permits simultaneous submission, explain the two-track strategy; otherwise warn the user not to dual-submit without written policy confirmation. You are an academic venue-selection advisor. The user has already received ranked recommendations and now wants to compare only the selected two or three venues. You must not introduce or recommend any venue outside the supplied shortlist. Compare conferences, workshops, journals, and special issues fairly. Explain trade-offs in topical fit, prestige, review/publication model, deadline feasibility, required revisions, audience, and career value. State which one you would choose now and why, while acknowledging uncertainty. Be direct and specific.
${UNTRUSTED_CONTENT_RULE}`;

export async function POST(req) {
  const blocked = guardExpensiveRequest(req, "compare", { limit: 20 });
  if (blocked) return blocked;
  try {
    const form = await parseLimitedFormData(req);
    const requestedModel = form.get("model")?.toString();
    const chosen = findModel(requestedModel);
    if (!chosen) return NextResponse.json({ error: "Choose a valid model from the model picker." }, { status: 400 });
    const modelOpts = { model: chosen.id, provider: chosen.provider, bodyExtra: chosen.bodyExtra };
    if (!llmReady(modelOpts)) {
      const need = chosen.provider === "nvidia" ? "NVIDIA_API_KEY" : "GROQ_API_KEY";
      return NextResponse.json({ error: `LLM not configured. Set ${need} in .env.local.` }, { status: 503 });
    }

    let ids;
    try {
      ids = JSON.parse(form.get("venueIds")?.toString() || "[]");
    } catch {
      return NextResponse.json({ error: "The selected venue list is malformed." }, { status: 400 });
    }
    if (!Array.isArray(ids) || ids.length < 2 || ids.length > 3) {
      return NextResponse.json({ error: "Select exactly two or three recommended venues to compare." }, { status: 400 });
    }
    const question = (form.get("question") || "Compare these venues and tell me which one you would choose right now.").toString().trim().slice(0, 2_000);
    const recommendationContext = (form.get("recommendationContext") || "").toString().slice(0, 12_000);
    const { items } = getActiveCFPs(new Date());
    const byId = new Map(items.map((v) => [v.id, v]));
    const selected = ids.map((id) => byId.get(id)).filter(Boolean);
    if (selected.length !== ids.length) return NextResponse.json({ error: "One of the selected venues is no longer open." }, { status: 400 });

    const file = form.get("file");
    const url = (form.get("url") || "").toString().trim();
    const paperText = await textFromPaperInput({ file, url, maxChars: 45_000 });

    const liveResearch = await Promise.all(selected.map(researchVenue));
    const evidence = liveResearch.map((r, i) => `\n=== LIVE RESEARCH: ${selected[i].acronym} ===\n${researchContext(r)}`).join("\n");

    const prompt = `${untrustedPromptField("PAPER TEXT", paperText || "Not re-supplied; rely on the prior recommendation context below.", 45_000)}

${untrustedPromptField("PRIOR RECOMMENDATION CONTEXT", recommendationContext, 12_000)}

${untrustedPromptField("ONLY COMPARE THESE VENUES", selected.map(venueContextLine).join("\n"), 30_000)}

${untrustedPromptField("LIVE OFFICIAL-PAGE RESEARCH", evidence, 60_000)}

${untrustedPromptField("USER QUESTION", question, 2_000)}

For each venue report: submission route; archival/non-archival options; proceedings publisher or host; confirmed indexing/discovery destinations; peer-review status; dual/cross-submission rule; and what proof is missing. Then answer in clear prose. Use a compact comparison, then give a decisive current pick. Do not mention any venue outside the shortlist.`;

    const answer = await chat(
      [{ role: "system", content: SYSTEM }, { role: "user", content: prompt }],
      { temperature: 0.2, maxTokens: 1400, ...modelOpts }
    );
    return NextResponse.json({ answer, research: liveResearch }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return apiErrorResponse(e, "Comparison failed.");
  }
}
