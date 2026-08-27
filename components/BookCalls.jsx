"use client";
import { useEffect, useMemo, useState } from "react";
import Countdown from "./Countdown";
import { isCallActive } from "@/lib/callLifecycle";
import { hybridSearch } from "@/lib/hybridSearch";
import { useDeadlineClock } from "./useDeadlineClock";
import HybridSearchStatus from "./HybridSearchStatus";

const LABELS = { "book-proposal": "Book proposal", "chapter-proposal": "Chapter proposal" };

export default function BookCalls() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState("");
  const [type, setType] = useState("all");
  const now = useDeadlineClock();

  useEffect(() => {
    fetch("/api/book-calls")
      .then((response) => { if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.json(); })
      .then(setData).catch((reason) => setError(String(reason)));
  }, []);

  const searchState = useMemo(() => {
    const source = type === "review" ? (data?.reviewItems || []) : (data?.items || []);
    const eligible = source.filter((item) => {
      if (type === "review") return true;
      if (!isCallActive(item, new Date(now))) return false;
      if (type !== "all" && item.type !== type) return false;
      return true;
    });
    return hybridSearch(eligible, query, { now: new Date(now) });
  }, [data, query, type, now]);
  const items = searchState.items;

  if (error) return <div className="notice">Failed to load book and chapter calls: {error}</div>;
  if (!data) return <div className="notice">Checking verified publishers and university presses…</div>;

  return (
    <section className="proposal-wrap">
      <div className="panel proposal-intro">
        <div className="section-heading"><div><span className="section-kicker">Publisher call index</span><h2>Search verified proposals</h2></div><span className="section-trust">Official sources only</span></div>
        <p className="muted">Search computing, data science, AI/ML and interdisciplinary opportunities. Aggregator-only and unverifiable calls stay outside the trusted view.</p>
        <input className="input search" aria-label="Search book and chapter calls" placeholder="Search keywords or describe the book opportunity you need…" value={query} onChange={(event) => setQuery(event.target.value)} />
        <HybridSearchStatus query={query} interpretation={searchState.interpretation} />
        <div className="chips">
          {[{ key: "all", label: "All trusted" }, { key: "book-proposal", label: "Book proposals" }, { key: "chapter-proposal", label: "Chapter proposals" }, { key: "review", label: `Needs review (${data.reviewCount || 0})` }].map((entry) => (
            <button key={entry.key} className={`chip${type === entry.key ? " active" : ""}`} onClick={() => setType(entry.key)}>{entry.label}</button>
          ))}
        </div>
      </div>

      <div className="count-line">Showing <strong>{items.length}</strong> {type === "review" ? "transparent review candidate" : "rigorously verified call"}{items.length === 1 ? "" : "s"} · {type === "review" ? "not admitted as trusted" : "official publisher links only"} · refreshed {data.updatedAt ? new Date(data.updatedAt).toLocaleDateString() : "—"}</div>
      <div className="grid">
        {items.map((item) => (
          <article className={`card${type === "review" ? " review-card" : ""}`} key={item.id}>
            <div className="card-top"><div><div className="card-title">{item.name}</div><div className="card-sub">{item.publisher}</div></div><span className={`badge ${type === "review" ? "type-review" : "type-book"}`}>{type === "review" ? item.reviewStatus.replace(/-/g, " ") : LABELS[item.type]}</span></div>
            <div className="badges"><span className="topic-tag">{item.domain}</span>{type !== "review" ? <span className="topic-tag">Official publisher</span> : <span className="topic-tag">Candidate only</span>}{item.integrity?.memberships?.slice(0, 2).map((entry) => <span className="topic-tag" key={entry}>{entry}</span>)}</div>
            {item.rolling ? <div className="rolling-call"><strong>Rolling proposals</strong><span>No fixed closing date published</span></div> : item.deadline && new Date(item.deadline) > new Date(now) ? <Countdown deadline={item.deadline} /> : null}
            <div className="deadline-txt">
              {item.deadline ? <><strong>Proposal deadline:</strong> {new Date(item.deadline).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" })}</> : <><strong>Status:</strong> {type === "review" ? "No verified deadline" : "Currently accepting proposals"}</>}
              {item.description ? <><br />{item.description}</> : null}
            </div>
            {type === "review" ? <ul className="review-reasons">{item.reviewReasons.map((reason) => <li key={reason}>{reason}</li>)}</ul> : <div className="integrity-note">✓ Publisher domain verified · ✓ scholarly review evidence · ✓ CS/AI scope checked</div>}
            <div className="card-foot">{item.seriesUrl && item.seriesUrl !== item.callUrl ? <a className="btn secondary" href={item.seriesUrl} target="_blank" rel="noopener noreferrer">View series ↗</a> : <span />}<a className="btn" href={item.callUrl} target="_blank" rel="noopener noreferrer">{type === "review" ? "Inspect source →" : "View official call →"}</a></div>
          </article>
        ))}
      </div>
      {!items.length ? <div className="notice">No matching {type === "review" ? "review candidates" : "verified calls"}. Configured presses will continue to be checked every two days.</div> : null}
    </section>
  );
}
