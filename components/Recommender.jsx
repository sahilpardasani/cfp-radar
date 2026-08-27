"use client";
import { useRef, useState } from "react";
import { MODELS, SUGGESTERS, DEFAULT_MODEL_ID, findSuggester } from "@/lib/models";

export default function Recommender() {
  const [file, setFile] = useState(null);
  const [drag, setDrag] = useState(false);
  const [loadingRec, setLoadingRec] = useState(false);
  const [loadingRef, setLoadingRef] = useState(false);
  const [rec, setRec] = useState(null);
  const [refs, setRefs] = useState(null);
  const [error, setError] = useState(null);
  const [model, setModel] = useState(DEFAULT_MODEL_ID);
  const [url, setUrl] = useState("");
  const [abstract, setAbstract] = useState("");
  const [copied, setCopied] = useState(false);
  const [compareIds, setCompareIds] = useState([]);
  const [compareQuestion, setCompareQuestion] = useState("Which of these would you choose right now, and why?");
  const [compareLoading, setCompareLoading] = useState(false);
  const [compareMessages, setCompareMessages] = useState([]);
  const [extensionUrl, setExtensionUrl] = useState("");
  const [extensionIdea, setExtensionIdea] = useState("");
  const [extensionLoading, setExtensionLoading] = useState(false);
  const [extensionResult, setExtensionResult] = useState(null);
  const [draftTarget, setDraftTarget] = useState("");
  const [draftLoading, setDraftLoading] = useState(false);
  const [draftReview, setDraftReview] = useState(null);
  const inputRef = useRef(null);

  const suggester = findSuggester(model); // non-null => journal-suggester mode

  async function openFinder() {
    if (suggester && abstract.trim()) {
      try {
        await navigator.clipboard.writeText(abstract.trim());
        setCopied(true);
        setTimeout(() => setCopied(false), 4000);
      } catch {}
    }
    if (suggester) window.open(suggester.url, "_blank", "noreferrer");
  }

  function pick(f) {
    if (!f) return;
    if (f.type !== "application/pdf" && !f.name.toLowerCase().endsWith(".pdf")) {
      setError("Please upload a PDF file.");
      return;
    }
    setError(null);
    setRec(null);
    setRefs(null);
    setFile(f);
  }

  async function runRecommend() {
    if (!file && !url.trim()) return;
    setLoadingRec(true);
    setError(null);
    setRec(null);
    try {
      const fd = new FormData();
      if (file) fd.append("file", file);
      if (url.trim()) fd.append("url", url.trim());
      fd.append("model", model);
      const res = await fetch("/api/recommend", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Request failed");
      setRec(data);
      setCompareIds((data.recommendations || []).slice(0, 2).map((r) => r.id));
      setCompareMessages([]);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoadingRec(false);
    }
  }

  async function runVerify() {
    if (!file && !url.trim()) return;
    setLoadingRef(true);
    setError(null);
    setRefs(null);
    try {
      const fd = new FormData();
      if (file) fd.append("file", file);
      if (url.trim()) fd.append("url", url.trim());
      fd.append("model", model);
      const res = await fetch("/api/verify-refs", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Request failed");
      setRefs(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoadingRef(false);
    }
  }

  async function runExtension() {
    if (!extensionUrl.trim() || !extensionIdea.trim()) return;
    setExtensionLoading(true);
    setError(null);
    setExtensionResult(null);
    try {
      const fd = new FormData();
      fd.append("url", extensionUrl.trim());
      fd.append("extensionIdea", extensionIdea.trim());
      fd.append("model", model);
      const res = await fetch("/api/extend", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Extension analysis failed");
      setExtensionResult(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setExtensionLoading(false);
    }
  }


  async function runDraftReview() {
    if (!file && !url.trim()) return;
    setDraftLoading(true);
    setError(null);
    setDraftReview(null);
    try {
      const fd = new FormData();
      if (file) fd.append("file", file);
      if (url.trim()) fd.append("url", url.trim());
      fd.append("target", draftTarget.trim());
      fd.append("model", model);
      const res = await fetch("/api/review-draft", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Draft review failed");
      setDraftReview(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setDraftLoading(false);
    }
  }

  function toggleCompare(id) {
    setCompareIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= 3) return prev;
      return [...prev, id];
    });
  }

  async function runCompare() {
    if (!rec || compareIds.length < 2 || compareIds.length > 3 || !compareQuestion.trim()) return;
    const q = compareQuestion.trim();
    setCompareLoading(true);
    setError(null);
    try {
      const fd = new FormData();
      if (file) fd.append("file", file);
      if (url.trim()) fd.append("url", url.trim());
      fd.append("model", model);
      fd.append("venueIds", JSON.stringify(compareIds));
      fd.append("question", q);
      fd.append("recommendationContext", JSON.stringify({ paperSummary: rec.paperSummary, recommendations: rec.recommendations }));
      const res = await fetch("/api/compare", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Comparison failed");
      setCompareMessages((prev) => [...prev, { role: "user", text: q }, { role: "assistant", text: data.answer }]);
      setCompareQuestion("");
    } catch (e) {
      setError(e.message);
    } finally {
      setCompareLoading(false);
    }
  }

  const verdictClass = { verified: "ref-ok", not_found: "ref-bad", unreachable: "ref-warn", unknown: "ref-warn" };
  const verdictLabel = { verified: "EXISTS", not_found: "NOT FOUND", unreachable: "UNREACHABLE", unknown: "UNCHECKED" };

  return (
    <div className="rec-wrap">
      <div className="panel">
        <h2>{suggester ? `${suggester.publisher} Journal Suggester` : "Find the best venue for your paper"}</h2>
        <p className="muted">
          {suggester
            ? `Paste your abstract, then open ${suggester.publisher}'s official journal finder — your abstract is copied to the clipboard so you can paste it straight in.`
            : "Upload your paper (PDF) or paste a link. Your chosen model reads the full text and matches it against the live dashboard of open CFPs, ranks the top 5, and tells you exactly what to change to fit each venue."}
        </p>

        <div className="model-row">
          <label htmlFor="model-select">Model / tool</label>
          <select id="model-select" className="select" value={model} onChange={(e) => setModel(e.target.value)}>
            <optgroup label="AI models — rank against the live dashboard">
              {MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </optgroup>
            <optgroup label="Publisher journal suggesters — paste your abstract">
              {SUGGESTERS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </optgroup>
          </select>
          {!suggester ? (
            <span className="model-hint">
              NVIDIA models need <code>NVIDIA_API_KEY</code>; the Groq option needs <code>GROQ_API_KEY</code>.
            </span>
          ) : null}
        </div>

        {suggester ? (
          <>
            <textarea
              className="input"
              style={{ width: "100%", minHeight: 160, resize: "vertical" }}
              placeholder="Paste your abstract in here…"
              value={abstract}
              onChange={(e) => setAbstract(e.target.value)}
            />
            <div style={{ display: "flex", gap: 10, marginTop: 14, flexWrap: "wrap", alignItems: "center" }}>
              <button className="btn" onClick={openFinder} disabled={!abstract.trim()}>
                Copy abstract &amp; open {suggester.publisher} finder →
              </button>
              {copied ? <span className="muted" style={{ fontSize: 13 }}>Abstract copied — paste it into the finder.</span> : null}
            </div>
          </>
        ) : (
          <>
            <div
              className={"dropzone" + (drag ? " drag" : "")}
              onClick={() => inputRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDrag(true);
              }}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDrag(false);
                pick(e.dataTransfer.files?.[0]);
              }}
            >
              {file ? (
                <span>
                  <strong>{file.name}</strong> selected · click to change
                </span>
              ) : (
                <span>
                  <strong>Drop your paper PDF here</strong> or click to browse
                </span>
              )}
              <input
                ref={inputRef}
                type="file"
                accept="application/pdf"
                style={{ display: "none" }}
                onChange={(e) => pick(e.target.files?.[0])}
              />
            </div>

            <div className="url-row">
              <span className="or-sep">or</span>
              <input
                className="input"
                style={{ flex: 1, minWidth: 220 }}
                placeholder="Paste a hosted paper URL (arXiv link or a PDF link)…"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
            </div>
            <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
              The model reads the <strong>full paper text</strong> (not just the abstract). The fetch agent can
              also pull a hosted paper (arXiv, direct PDF, or an HTML page) so you don't have to download it.
            </p>

            <div style={{ display: "flex", gap: 10, marginTop: 14, flexWrap: "wrap" }}>
              <button className="btn" onClick={runRecommend} disabled={(!file && !url.trim()) || loadingRec}>
                {loadingRec ? <span className="spinner" /> : "Recommend venues"}
              </button>
              <button className="btn secondary" onClick={runVerify} disabled={(!file && !url.trim()) || loadingRef}>
                {loadingRef ? <span className="spinner" /> : "Verify references & links"}
              </button>
            </div>
          </>
        )}

        {error ? (
          <div className="notice" style={{ marginTop: 12, color: "var(--danger)" }}>
            {error}
          </div>
        ) : null}
      </div>

      {!suggester ? (
        <div className="panel">
          <h2>Review and strengthen a paper draft</h2>
          <p className="muted">Use the PDF or hosted-paper link selected above. The model reviews the full draft like a demanding senior reviewer, identifies acceptance risks, recommends missing experiments and baselines, critiques every section, and builds a prioritized revision plan.</p>
          <input className="input" style={{ width: "100%" }} placeholder="Optional target: e.g. ACL Findings, an A-ranked journal, or 'best realistic venue'" value={draftTarget} onChange={(e) => setDraftTarget(e.target.value)} />
          <button className="btn" style={{ marginTop: 12 }} onClick={runDraftReview} disabled={(!file && !url.trim()) || draftLoading}>{draftLoading ? <span className="spinner" /> : "Review draft & improve acceptance chances"}</button>
        </div>
      ) : null}

      {draftReview ? (
        <div className="panel">
          <h2>Draft readiness review</h2>
          <div className="notice"><strong>{draftReview.verdict}</strong> · Readiness score: <strong>{draftReview.readinessScore}%</strong></div>
          <p>{draftReview.overallAssessment}</p>
          <p className="muted"><strong>Core contribution:</strong> {draftReview.coreContribution}</p>
          {draftReview.strongestAspects?.length ? <><h3>Strongest aspects</h3><ul className="gap-list">{draftReview.strongestAspects.map((x,i)=><li key={i}>{x}</li>)}</ul></> : null}
          {draftReview.acceptanceRisks?.length ? <><h3>Acceptance risks</h3>{draftReview.acceptanceRisks.map((r,i)=><div className="extension-card" key={i}><strong>{r.severity?.toUpperCase()}: {r.issue}</strong><p>{r.whyItMatters}</p><p><strong>Fix:</strong> {r.specificFix}</p></div>)}</> : null}
          {draftReview.mustRunExperiments?.length ? <><h3>Experiments or evidence to add</h3>{draftReview.mustRunExperiments.map((e,i)=><div className="extension-card" key={i}><strong>{e.experiment}</strong><p>{e.purpose}</p><p className="muted">Minimum evidence: {e.minimumEvidence}</p></div>)}</> : null}
          {draftReview.sectionReview ? <><h3>Section-by-section review</h3><div className="extension-grid">{Object.entries(draftReview.sectionReview).map(([k,v])=><div className="extension-card" key={k}><strong>{k.replace(/([A-Z])/g," $1")}</strong><ul className="gap-list">{(v||[]).map((x,i)=><li key={i}>{x}</li>)}</ul></div>)}</div></> : null}
          {draftReview.revisionPlan?.length ? <><h3>Prioritized revision plan</h3><ol className="gap-list">{draftReview.revisionPlan.sort((a,b)=>a.priority-b.priority).map((x,i)=><li key={i}><strong>{x.task}</strong> — {x.expectedImpact}</li>)}</ol></> : null}
          {draftReview.bestFitOpenVenues?.length ? <><h3>Best realistic open venues after revision</h3>{draftReview.bestFitOpenVenues.map((r,i)=><div className="rec-item" key={r.id}><strong>{i+1}. {r.venue?.acronym} · {r.venue?.type}</strong><p>{r.why}</p><ul className="gap-list">{r.changesBeforeSubmission?.map((x,j)=><li key={j}>{x}</li>)}</ul><a className="btn" href={r.venue?.cfpUrl || r.venue?.url || "#"} target="_blank" rel="noreferrer">Open venue →</a></div>)}</> : null}
        </div>
      ) : null}

      {!suggester ? (
        <div className="panel extension-panel">
          <h2>Extend an existing paper into new work</h2>
          <p className="muted">Paste a hosted paper link and describe what you want to add. The model reads the source paper, checks whether the idea is actually new, strengthens the research design, and recommends open conferences, workshops, journals, and special issues for the resulting paper.</p>
          <input className="input" style={{ width: "100%" }} placeholder="Source paper URL — arXiv, direct PDF, or hosted HTML paper" value={extensionUrl} onChange={(e) => setExtensionUrl(e.target.value)} />
          <textarea className="input" style={{ width: "100%", minHeight: 130, resize: "vertical", marginTop: 12 }} placeholder="Describe the extension. Example: evaluate protein, vitamin, and mineral estimation; add newer open-weight models; analyze nutrient-specific safety failures and performance across diets…" value={extensionIdea} onChange={(e) => setExtensionIdea(e.target.value)} />
          <button className="btn" style={{ marginTop: 12 }} onClick={runExtension} disabled={!extensionUrl.trim() || extensionIdea.trim().length < 30 || extensionLoading}>{extensionLoading ? <span className="spinner" /> : "Analyze extension & recommend venues"}</button>
        </div>
      ) : null}

      {extensionResult ? (
        <div className="panel">
          <h2>Extension research plan</h2>
          <p className="muted">{extensionResult.sourcePaperSummary}</p>
          <div className="extension-grid">
            <div className="extension-card"><strong>Novelty assessment</strong><p>{extensionResult.noveltyAssessment}</p>{extensionResult.noveltyRisks?.length ? <ul className="gap-list">{extensionResult.noveltyRisks.map((x,i)=><li key={i}>{x}</li>)}</ul> : null}</div>
            <div className="extension-card"><strong>Stronger contribution</strong><p>{extensionResult.strengthenedContribution}</p></div>
          </div>
          {extensionResult.candidateTitle ? <div className="notice" style={{ marginTop: 12 }}><strong>Possible title:</strong> {extensionResult.candidateTitle}</div> : null}
          {extensionResult.alreadyCovered?.length ? <><h3>What the source paper already covers</h3><ul className="gap-list">{extensionResult.alreadyCovered.map((x,i)=><li key={i}>{x}</li>)}</ul></> : null}
          {extensionResult.researchQuestions?.length ? <><h3>Research questions</h3><ul className="gap-list">{extensionResult.researchQuestions.map((x,i)=><li key={i}>{x}</li>)}</ul></> : null}
          {extensionResult.recommendedExperiments?.length ? <><h3>Experiments needed</h3><ul className="gap-list">{extensionResult.recommendedExperiments.map((x,i)=><li key={i}>{x}</li>)}</ul></> : null}
          <h3>Best open venues for the extended work</h3>
          {extensionResult.recommendations?.map((r,i)=><div className="rec-item" key={r.id}><div style={{display:"flex",justifyContent:"space-between",gap:10}}><div><span className="rec-rank">{i+1}</span><strong>{r.venue?.acronym || r.id}</strong> <span className="type-badge">{r.venue?.type}</span><div className="card-sub">{r.venue?.name}</div></div><strong>{r.fitScore}%</strong></div><div className="score-bar"><div className="score-fill" style={{width:`${Math.max(4,Math.min(100,r.fitScore))}%`}} /></div><p>{r.why}</p>{r.requiredChanges?.length ? <ul className="gap-list">{r.requiredChanges.map((x,j)=><li key={j}>{x}</li>)}</ul> : null}<div className="card-foot"><span className="deadline-txt">{r.deadlineFeasibility}</span><a className="btn" href={r.venue?.cfpUrl || r.venue?.url || "#"} target="_blank" rel="noreferrer">Open venue →</a></div></div>)}
        </div>
      ) : null}

      {rec ? (
        <div className="panel">
          <h2>Top venue matches</h2>
          {rec.paperSummary ? <p className="muted">{rec.paperSummary}</p> : null}
          {rec.detectedTopics?.length ? (
            <div className="topic-tags" style={{ marginBottom: 14 }}>
              {rec.detectedTopics.map((t) => (
                <span className="topic-tag" key={t}>
                  #{t}
                </span>
              ))}
            </div>
          ) : null}

          {rec.recommendations.map((r, i) => (
            <div className="rec-item" key={r.id}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
                <div>
                  <span className="rec-rank">{i + 1}</span>
                  <strong>{r.venue?.acronym || r.id}</strong> <span className="type-badge">{r.venue?.type}</span>
                  <div className="card-sub">{r.venue?.name}</div>
                </div>
                <div style={{ textAlign: "right", minWidth: 90 }}>
                  <div style={{ fontWeight: 800 }}>{r.fitScore}%</div>
                  <div className="card-sub">{r.deadlineFeasibility}</div>
                </div>
              </div>
              <div className="score-bar">
                <div className="score-fill" style={{ width: `${Math.max(4, Math.min(100, r.fitScore))}%` }} />
              </div>
              {r.why ? <div style={{ fontSize: 14 }}>{r.why}</div> : null}
              {r.requiredChanges?.length ? (
                <>
                  <div style={{ fontSize: 13, fontWeight: 700, marginTop: 8 }}>What to change:</div>
                  <ul className="gap-list">
                    {r.requiredChanges.map((c, j) => (
                      <li key={j}>{c}</li>
                    ))}
                  </ul>
                </>
              ) : null}
              <label className="compare-check"><input type="checkbox" checked={compareIds.includes(r.id)} onChange={() => toggleCompare(r.id)} disabled={!compareIds.includes(r.id) && compareIds.length >= 3} /> Compare this venue</label>
              <div className="card-foot" style={{ marginTop: 10 }}>
                {r.venue?.templateUrl ? (
                  <a className="btn secondary" href={r.venue.templateUrl} target="_blank" rel="noopener noreferrer">
                    Get template
                  </a>
                ) : null}
                <a className="btn" href={r.venue?.cfpUrl || r.venue?.url || "#"} target="_blank" rel="noreferrer">
                  Open CFP →
                </a>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {rec ? (
        <div className="panel">
          <h2>Compare shortlisted venues</h2>
          <p className="muted">Select exactly two or three of the model's recommendations. This follow-up chat is restricted to those venues and will not introduce alternatives. Before answering, a live research agent visits their official CFP, publication, proceedings, and policy pages to verify archival status, publisher, indexing claims, and cross-submission rules.</p>
          <div className="compare-selected">{rec.recommendations.filter((r) => compareIds.includes(r.id)).map((r) => <span className="topic-tag" key={r.id}>{r.venue?.acronym} · {r.venue?.type}</span>)}</div>
          {compareMessages.map((m, i) => <div key={i} className={`chat-bubble ${m.role}`}>{m.text}</div>)}
          <div className="url-row" style={{ marginTop: 12 }}>
            <textarea className="input" style={{ flex: 1, minHeight: 90, resize: "vertical" }} value={compareQuestion} onChange={(e) => setCompareQuestion(e.target.value)} placeholder="Ask why one venue beats another, compare prestige vs. fit, deadline risk, required changes…" />
            <button className="btn" onClick={runCompare} disabled={compareIds.length < 2 || compareIds.length > 3 || !compareQuestion.trim() || compareLoading}>{compareLoading ? <span className="spinner" /> : "Research & compare 2–3 venues"}</button>
          </div>
        </div>
      ) : null}

      {refs ? (
        <div className="panel">
          <h2>Reference &amp; link integrity</h2>
          <p className="muted">
            The agent extracted {refs.summary.total} references/links and checked each against Crossref (DOIs &amp;
            titles) and live HTTP requests (URLs).
          </p>
          <div className="chips" style={{ marginBottom: 14 }}>
            <span className="chip active" style={{ background: "var(--success)", borderColor: "var(--success)" }}>
              {refs.summary.verified} exist
            </span>
            <span className="chip" style={{ color: "var(--danger)" }}>{refs.summary.notFound} not found</span>
            <span className="chip" style={{ color: "var(--warning)" }}>{refs.summary.unreachable} unreachable</span>
          </div>
          {refs.references.map((r, i) => (
            <div className="ref-row" key={i}>
              <span className={"ref-status " + (verdictClass[r.verdict] || "ref-warn")}>
                {verdictLabel[r.verdict] || r.verdict}
              </span>
              <span style={{ flex: 1 }}>
                {r.title || r.url || r.doi || "Untitled reference"}
                {r.doi ? <span className="card-sub"> · DOI: {r.doi}</span> : null}
                {r.checks?.crossref?.match?.title && !r.title ? (
                  <span className="card-sub"> · matched: {r.checks.crossref.match.title}</span>
                ) : null}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
