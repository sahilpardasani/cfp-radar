"use client";
import { useEffect, useMemo, useState } from "react";
import Countdown from "./Countdown";
import { isCallActive } from "@/lib/callLifecycle";
import { hybridSearch } from "@/lib/hybridSearch";
import { useDeadlineClock } from "./useDeadlineClock";
import HybridSearchStatus from "./HybridSearchStatus";

export default function ReviewerCalls() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState("");
  const now = useDeadlineClock();

  useEffect(() => {
    fetch("/api/reviewer-calls")
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then(setData)
      .catch((reason) => setError(String(reason)));
  }, []);

  const searchState = useMemo(() => {
    const active = (data?.items || []).filter((item) => isCallActive(item, new Date(now)));
    return hybridSearch(active, query, { now: new Date(now) });
  }, [data, query, now]);
  const items = searchState.items;

  if (error) return <div className="notice">Failed to load reviewer calls: {error}</div>;
  if (!data) return <div className="notice">Checking official calls for academic reviewers…</div>;

  return (
    <section className="proposal-wrap">
      <div className="panel proposal-intro">
        <div className="section-heading"><div><span className="section-kicker">Service opportunity index</span><h2>Search reviewer calls</h2></div><span className="section-trust">Cross-checked</span></div>
        <p className="muted">
          Conferences and workshops inviting academics or students to review. A form alone is never enough: every card links back to an official venue page.
        </p>
        <input
          className="input search"
          aria-label="Search reviewer calls"
          placeholder="Try “ethics reviewer”, “HCI”, or describe the reviewing opportunity you want…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <HybridSearchStatus query={query} interpretation={searchState.interpretation} />
      </div>

      <div className="count-line">
        Showing <strong>{items.length}</strong> verified reviewer call{items.length === 1 ? "" : "s"} · official venue evidence only · refreshed {data.updatedAt ? new Date(data.updatedAt).toLocaleDateString() : "—"}
      </div>

      <div className="grid">
        {items.map((item) => (
          <article className="card" key={item.id}>
            <div className="card-top">
              <div>
                <div className="card-title">{item.venue}</div>
                <div className="card-sub">{item.role}</div>
              </div>
              <span className="badge type-reviewer">Reviewer call</span>
            </div>
            <div className="badges">
              <span className="topic-tag">{item.domain}</span>
              <span className="topic-tag">{item.venueType}</span>
              <span className="topic-tag">Officially verified</span>
            </div>
            {item.deadline ? (
              <>
                <Countdown deadline={item.deadline} />
                <div className="deadline-txt">
                  <strong>Application deadline:</strong>{" "}
                  {new Date(item.deadline).toLocaleString(undefined, {
                    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short",
                  })}
                </div>
              </>
            ) : (
              <div className="rolling-call">
                <strong>Applications currently open</strong>
                <span>No reviewer sign-up deadline is published; the official page is rechecked every two days.</span>
              </div>
            )}
            {item.reviewPeriod ? <div className="deadline-txt"><strong>Review service:</strong> {item.reviewPeriod}</div> : null}
            {item.eligibility ? <p className="proposal-requirements">{item.eligibility}</p> : null}
            <div className="integrity-note">✓ Official venue page · ✓ explicit reviewer recruitment · ✓ application route cross-checked</div>
            <div className="card-foot">
              <a className="btn secondary" href={item.applicationUrl} target="_blank" rel="noopener noreferrer">Apply to review ↗</a>
              <a className="btn" href={item.callUrl} target="_blank" rel="noopener noreferrer">View official call →</a>
            </div>
          </article>
        ))}
      </div>
      {!items.length ? <div className="notice">No matching verified reviewer calls. Configured venues will continue to be checked every two days.</div> : null}
    </section>
  );
}
