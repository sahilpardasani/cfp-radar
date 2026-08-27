"use client";
import { useCallback, useEffect, useMemo, useState } from "react";

function formatAuthors(authors = []) {
  if (!authors.length) return "Authors unavailable";
  if (authors.length <= 3) return authors.map((author) => author.name).join(", ");
  return `${authors.slice(0, 3).map((author) => author.name).join(", ")} et al.`;
}

function CoverageNotice({ history }) {
  const coverage = history.coverage || {};
  return (
    <div className={`history-coverage coverage-${coverage.status || "partial"}`}>
      <strong>{coverage.status === "verified" ? "Verified venue history" : "Partial venue history"}</strong>
      <span>
        Exact venue identity and paper membership come from {coverage.membershipSource || "the listed proceedings source"}.
        {coverage.mode === "representative" ? ` Up to ${coverage.maxPapersPerYear} recent papers per year are retained for broad journal coverage.` : ""}
        {coverage.mode === "source-indexed" ? " Coverage contains the papers indexed by that authority for the displayed years." : ""}
        {" "}Similar-looking venues and unverified submissions are excluded.
      </span>
    </div>
  );
}

function InsightBars({ title, values = [], empty }) {
  const max = Math.max(1, ...values.map((value) => value.count));
  return (
    <section className="history-panel">
      <h2>{title}</h2>
      {values.length ? (
        <div className="insight-bars">
          {values.slice(0, 8).map((value) => (
            <div className="insight-row" key={value.label}>
              <div className="insight-label"><span>{value.label}</span><strong>{value.count}</strong></div>
              <div className="insight-track"><span style={{ width: `${Math.max(5, value.count / max * 100)}%` }} /></div>
            </div>
          ))}
        </div>
      ) : <p className="muted">{empty}</p>}
    </section>
  );
}

function PaperCard({ paper, venueType }) {
  const membershipLabel = venueType === "journal" ? "Published paper ✓" : "Accepted paper ✓";
  return (
    <article className="history-paper-card">
      <div className="history-paper-heading">
        <div>
          <div className="history-paper-title">{paper.title}</div>
          <div className="card-sub">{formatAuthors(paper.authors)} · {paper.eventYear}</div>
        </div>
        <span className="verified-membership" title={venueType === "journal" ? "Verified against the journal's exact ISSN" : "Verified against an exact proceedings table of contents"}>{membershipLabel}</span>
      </div>
      <div className="topic-tags">
        {(paper.topics || []).slice(0, 4).map((topic) => <span className="topic-tag" key={topic}>{topic}</span>)}
        {(paper.methodTags || []).slice(0, 3).map((method) => <span className="topic-tag method-tag" key={method}>{method}</span>)}
      </div>
      {paper.abstract ? <p className="paper-abstract">{paper.abstract.slice(0, 420)}{paper.abstract.length > 420 ? "…" : ""}</p> : (
        <p className="paper-abstract muted">Abstract metadata is unavailable; relevance and method labels use the title only.</p>
      )}
      <div className="paper-meta">
        {paper.doi ? <span>DOI {paper.doi}</span> : null}
        {Number.isFinite(paper.citationCount) ? <span>{paper.citationCount} citations</span> : null}
        {paper.pages ? <span>pp. {paper.pages}</span> : null}
      </div>
      <div className="card-foot paper-links">
        {paper.dblpUrl ? <a className="btn secondary" href={paper.dblpUrl} target="_blank" rel="noopener noreferrer">DBLP record ↗</a> : null}
        {paper.openAccessUrl ? <a className="btn secondary" href={paper.openAccessUrl} target="_blank" rel="noopener noreferrer">Open-access copy ↗</a> : null}
        {paper.publisherUrl ? <a className="btn" href={paper.publisherUrl} target="_blank" rel="noopener noreferrer">Publisher / DOI ↗</a> : null}
      </div>
    </article>
  );
}

export default function RelatedWorkExplorer({ venueId }) {
  const [history, setHistory] = useState(null);
  const [papers, setPapers] = useState(null);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [year, setYear] = useState("");
  const [topic, setTopic] = useState("");
  const [method, setMethod] = useState("");
  const [sort, setSort] = useState("relevance");
  const [openAccess, setOpenAccess] = useState(false);
  const [loadingPapers, setLoadingPapers] = useState(false);

  useEffect(() => {
    fetch(`/api/venues/${encodeURIComponent(venueId)}/history`)
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "History could not be loaded.");
        return payload;
      })
      .then(setHistory)
      .catch((reason) => setError(reason.message));
  }, [venueId]);

  const loadPapers = useCallback(async ({ append = false, cursor = null } = {}) => {
    setLoadingPapers(true);
    setError(null);
    try {
      const params = new URLSearchParams({ sort, limit: "20" });
      if (submittedQuery) params.set("q", submittedQuery);
      if (year) params.set("year", year);
      if (topic) params.set("topic", topic);
      if (method) params.set("method", method);
      if (openAccess) params.set("openAccess", "1");
      if (cursor) params.set("cursor", cursor);
      const response = await fetch(`/api/venues/${encodeURIComponent(venueId)}/papers?${params}`);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Papers could not be loaded.");
      setPapers((previous) => append && previous
        ? { ...payload, items: [...previous.items, ...payload.items] }
        : payload);
    } catch (reason) {
      setError(reason.message);
    } finally {
      setLoadingPapers(false);
    }
  }, [venueId, submittedQuery, year, topic, method, sort, openAccess]);

  useEffect(() => { loadPapers(); }, [loadPapers]);

  const summary = useMemo(() => {
    if (!history?.insights) return "";
    const themes = (history.insights.themes || []).slice(0, 3).map((entry) => entry.label).join(", ");
    const periods = history.venue.venueType === "journal" ? "publication years" : "editions";
    return `${history.insights.paperCount} verified papers across ${history.coverage?.editionCount || history.editions.length} ${periods}. The most visible recurring themes are ${themes || "still being classified"}.`;
  }, [history]);

  function submitSearch(event) {
    event.preventDefault();
    setSubmittedQuery(query.trim());
  }

  if (!history && !error) return <main className="container related-work-page"><div className="notice">Loading verified venue history…</div></main>;
  if (!history) return <main className="container related-work-page"><a href="/">← Back to CFP Radar</a><div className="notice">{error}</div></main>;
  const isJournal = history.venue.venueType === "journal";

  return (
    <main className="container related-work-page">
      <a className="back-link" href="/">← Back to CFP Radar</a>
      <header className="history-hero">
        <div>
          <div className="eyebrow">Past work &amp; venue fit</div>
          <h1>{history.venue.canonicalName}</h1>
          <p>{summary}</p>
        </div>
        <div className="history-hero-actions">
          {history.currentCall?.cfpUrl ? <a className="btn" href={history.currentCall.cfpUrl} target="_blank" rel="noopener noreferrer">Current CFP ↗</a> : null}
          {history.venue.identityEvidence?.url ? <a className="btn secondary" href={history.venue.identityEvidence.url} target="_blank" rel="noopener noreferrer">Verify source identity ↗</a> : null}
        </div>
      </header>

      <CoverageNotice history={history} />

      <section className="history-stats" aria-label="Venue-history coverage">
        <div><strong>{history.coverage?.paperCount || 0}</strong><span>verified papers</span></div>
        <div><strong>{history.coverage?.editionCount || 0}</strong><span>{history.venue.venueType === "journal" ? "publication years" : "editions"}</span></div>
        <div><strong>{history.coverage?.startYear || "—"}–{history.coverage?.endYear || "—"}</strong><span>coverage</span></div>
        <div><strong>{history.insights?.extractionEvidence === "title-only" ? "Title" : "Title + abstract"}</strong><span>insight evidence</span></div>
      </section>

      <div className="history-insights-grid">
        <InsightBars title="What this venue publishes" values={history.insights?.themes} empty="No theme evidence is available." />
        <InsightBars title={isJournal ? "How published work is done" : "How accepted work is done"} values={history.insights?.methods} empty="No method evidence is available." />
      </div>
      <p className="history-caveat">
        These patterns describe previously {isJournal ? "published" : "accepted"} work; they do not predict acceptance. Labels are evidence-bounded and currently use {history.insights?.extractionEvidence === "title-only" ? "paper titles" : "titles and available abstracts"}.
      </p>

      <section className="history-panel">
        <h2>{history.venue.venueType === "journal" ? "Recent publication history" : "Previous editions"}</h2>
        <div className="edition-timeline">
          {history.editions.map((edition) => (
            <article className="edition-card" key={edition.id}>
              <div className="edition-year">{edition.eventYear}</div>
              <div><strong>{edition.title}</strong><div className="card-sub">{edition.paperCount} verified papers · {edition.volumes.length} {isJournal ? "journal source" : "proceedings volume"}{edition.volumes.length === 1 ? "" : "s"}</div></div>
              <div className="edition-links">{edition.volumes.map((volume) => {
                const sourceUrl = volume.dblpUrl || volume.publisherUrl;
                const sourceLabel = volume.volume
                  ? `Volume ${volume.volume}`
                  : history.venue.venueType === "journal" ? "Journal archive" : "Proceedings";
                return sourceUrl ? <a href={sourceUrl} target="_blank" rel="noopener noreferrer" key={volume.proceedingsKey}>{sourceLabel} ↗</a> : null;
              })}</div>
            </article>
          ))}
        </div>
      </section>

      <section className="history-panel paper-search-panel">
        <div className="paper-search-heading">
          <div><h2>{isJournal ? "Published papers" : "Accepted papers"}</h2><p className="muted">Search this venue without uploading a manuscript. Natural-language prompts work alongside exact keywords.</p></div>
          <span className="count-line">{papers?.total ?? 0} verified papers in this view</span>
        </div>
        <form className="history-search" onSubmit={submitSearch}>
          <input className="input search" aria-label={isJournal ? "Search papers published in this journal" : "Search papers accepted at this venue"} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Try “privacy-preserving AI”, “user study with robots”, or an exact method…" />
          <button className="btn" type="submit">Search past work</button>
        </form>
        {!submittedQuery ? <div className="hybrid-search-status active"><strong>Current-call relevance</strong><span>Results use the live CFP domain and topics until you enter your own prompt.</span></div> : <div className="hybrid-search-status active"><strong>Prompt relevance</strong><span>Ranking {isJournal ? "published" : "accepted"} papers for “{submittedQuery}”.</span></div>}
        <div className="history-filters">
          <select className="select" aria-label={isJournal ? "Filter by publication year" : "Filter by edition year"} value={year} onChange={(event) => setYear(event.target.value)}><option value="">{isJournal ? "All publication years" : "All editions"}</option>{history.filters.years.map((value) => <option value={value} key={value}>{value}</option>)}</select>
          <select className="select" aria-label="Filter by theme" value={topic} onChange={(event) => setTopic(event.target.value)}><option value="">All themes</option>{history.filters.topics.map((value) => <option value={value} key={value}>{value}</option>)}</select>
          <select className="select" aria-label="Filter by method" value={method} onChange={(event) => setMethod(event.target.value)}><option value="">All methods</option>{history.filters.methods.map((value) => <option value={value} key={value}>{value}</option>)}</select>
          <select className="select" aria-label={isJournal ? "Sort published papers" : "Sort accepted papers"} value={sort} onChange={(event) => setSort(event.target.value)}><option value="relevance">Relevant to query/current call</option><option value="representative">Representative mix</option><option value="recent">Most recent</option><option value="cited">Most cited</option></select>
          <label className="history-check"><input type="checkbox" checked={openAccess} onChange={(event) => setOpenAccess(event.target.checked)} /> Open-access copy only</label>
        </div>
      </section>

      {error ? <div className="notice">{error}</div> : null}
      <div className="history-paper-list">
        {(papers?.items || []).map((paper) => <PaperCard paper={paper} venueType={history.venue.venueType} key={`${paper.editionId}-${paper.id}`} />)}
      </div>
      {papers && !papers.items.length && !loadingPapers ? <div className="notice">No verified papers match these filters. Try a broader prompt or clear a filter.</div> : null}
      {papers?.nextCursor ? <button className="btn load-more" disabled={loadingPapers} onClick={() => loadPapers({ append: true, cursor: papers.nextCursor })}>{loadingPapers ? "Loading…" : "Load more verified papers"}</button> : null}
      <div className="history-source-note">Last metadata sync: {history.updatedAt ? new Date(history.updatedAt).toLocaleString() : "not available"}. Full text remains on publisher or open-access sites; CFP Radar stores bibliographic metadata and provenance.</div>
    </main>
  );
}
