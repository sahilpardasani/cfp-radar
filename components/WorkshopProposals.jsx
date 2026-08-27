"use client";
import { useEffect, useMemo, useState } from "react";
import Countdown from "./Countdown";
import { isCallActive } from "@/lib/callLifecycle";
import { hybridSearch } from "@/lib/hybridSearch";
import { useDeadlineClock } from "./useDeadlineClock";
import HybridSearchStatus from "./HybridSearchStatus";

export default function WorkshopProposals() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState("");
  const now = useDeadlineClock();

  useEffect(() => {
    fetch("/api/workshop-proposals")
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

  if (error) return <div className="notice">Failed to load workshop organizer calls: {error}</div>;
  if (!data) return <div className="notice">Checking open calls for workshop organizers…</div>;

  return (
    <section className="proposal-wrap">
      <div className="panel proposal-intro">
        <div className="section-heading"><div><span className="section-kicker">Organizer call index</span><h2>Search workshop opportunities</h2></div><span className="section-trust">Official sources only</span></div>
        <p className="muted">
          These are calls to propose and host a workshop—not calls to submit a paper to one.
        </p>
        <input
          className="input search"
          aria-label="Search workshop organizer calls"
          placeholder="Search keywords or describe the workshop opportunity you need…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <HybridSearchStatus query={query} interpretation={searchState.interpretation} />
      </div>

      <div className="count-line">
        Showing <strong>{items.length}</strong> open organizer call{items.length === 1 ? "" : "s"} · verified official pages only · refreshed {data.updatedAt ? new Date(data.updatedAt).toLocaleDateString() : "—"}
      </div>

      <div className="grid">
        {items.map((item) => (
          <article className="card" key={item.id}>
            <div className="card-top">
              <div>
                <div className="card-title">{item.conference}</div>
                <div className="card-sub">{item.name}</div>
              </div>
              <span className="badge type-proposal">Organizer call</span>
            </div>
            <div className="badges">
              <span className="topic-tag">{item.domain}</span>
              {item.submissionPlatform ? <span className="topic-tag">{item.submissionPlatform}</span> : null}
              {item.location ? <span className="topic-tag">{item.location}</span> : null}
            </div>
            <Countdown deadline={item.deadline} />
            <div className="deadline-txt">
              <strong>Proposal deadline:</strong>{" "}
              {new Date(item.deadline).toLocaleString(undefined, {
                year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short",
              })}
              {item.deadlineTimezone ? ` · ${item.deadlineTimezone}` : ""}
              {item.eventDates ? <><br /><strong>Conference:</strong> {item.eventDates}</> : null}
            </div>
            {item.requirements ? <p className="proposal-requirements">{item.requirements}</p> : null}
            <div className="card-foot">
              {item.submissionUrl ? (
                <a className="btn secondary" href={item.submissionUrl} target="_blank" rel="noopener noreferrer">Submit ↗</a>
              ) : <span />}
              <a className="btn" href={item.cfpUrl} target="_blank" rel="noopener noreferrer">View organizer call →</a>
            </div>
          </article>
        ))}
      </div>
      {!items.length ? <div className="notice">No matching open organizer calls. The configured conference sources will continue to be checked.</div> : null}
    </section>
  );
}
