"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import CFPCard from "./CFPCard";
import { legitimacyOf } from "@/lib/legitimacyHeuristics";
import { macroDomain } from "@/lib/domains";
import { isCallActive } from "@/lib/callLifecycle";
import { hybridSearch } from "@/lib/hybridSearch";
import { useDeadlineClock } from "./useDeadlineClock";
import HybridSearchStatus from "./HybridSearchStatus";
import { conferenceRankGroupForItem } from "@/lib/conferenceRankings";

const PAGE_SIZE = 24;
const CATALOG_ATTEMPTS = 3;

function wait(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function fetchCatalog() {
  let lastError;
  for (let attempt = 0; attempt < CATALOG_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch("/api/cfps", { signal: AbortSignal.timeout(12_000) });
      if (response.ok) return response.json();
      lastError = new Error(`HTTP ${response.status}`);
      const retryable = response.status === 404 || response.status === 408 || response.status === 429 || response.status >= 500;
      if (!retryable) {
        lastError.retryable = false;
        throw lastError;
      }
    } catch (error) {
      lastError = error;
      if (error?.retryable === false) throw error;
    }
    if (attempt < CATALOG_ATTEMPTS - 1) await wait(300 * (attempt + 1));
  }
  throw lastError || new Error("Catalog request failed");
}

export default function Dashboard() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [q, setQ] = useState("");
  const [type, setType] = useState("all");
  const [domain, setDomain] = useState("all");
  const [sort, setSort] = useState("deadline");
  const [legit, setLegit] = useState("all");
  const [conferenceRank, setConferenceRank] = useState("all");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [reloadKey, setReloadKey] = useState(0);
  const searchRef = useRef(null);
  const now = useDeadlineClock();

  useEffect(() => {
    let cancelled = false;
    setError(null);
    // The dashboard only ever reads open CFPs. The backend watchlist
    // (data/watchlist.json) is intentionally NOT exposed to the frontend.
    fetchCatalog()
      .then((nextData) => { if (!cancelled) setData(nextData); })
      .catch((e) => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, [reloadKey]);

  useEffect(() => {
    function focusSearch(event) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
      }
    }
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);

  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [q, type, domain, sort, legit, conferenceRank]);

  const domains = useMemo(() => {
    if (!data?.items) return [];
    return [...new Set(data.items.map((c) => macroDomain(c.domain)))].sort();
  }, [data]);

  const searchState = useMemo(() => {
    if (!data?.items) return { items: [], interpretation: "" };
    let items = data.items.filter((c) => {
      if (!isCallActive(c, new Date(now))) return false;
      if (type !== "all" && c.type !== type) return false;
      if (domain !== "all" && macroDomain(c.domain) !== domain) return false;
      if (conferenceRank !== "all" && conferenceRankGroupForItem(c) !== conferenceRank) return false;
      if (legit !== "all") {
        const lv = legitimacyOf(c).level;
        if (legit === "trusted" && lv !== "trusted") return false;
        if (legit === "hide-caution" && lv === "caution") return false;
      }
      return true;
    });
    const search = hybridSearch(items, q, { now: new Date(now) });
    items = search.items;
    if (sort === "name") {
      items = [...items].sort((a, b) => a.acronym.localeCompare(b.acronym));
    } // With a query, hybrid relevance wins; otherwise the API deadline order is preserved.
    return { ...search, items };
  }, [data, q, type, domain, sort, legit, conferenceRank, now]);
  const filtered = searchState.items;
  const visibleItems = filtered.slice(0, visibleCount);

  const typeCounts = useMemo(() => {
    const counts = new Map();
    for (const item of data?.items || []) counts.set(item.type, (counts.get(item.type) || 0) + 1);
    return counts;
  }, [data]);

  const nextDeadline = useMemo(() => filtered
    .filter((item) => item.deadline && new Date(item.deadline).getTime() > now)
    .sort((left, right) => new Date(left.deadline) - new Date(right.deadline))[0] || null, [filtered, now]);

  const activeFilterCount = [q.trim(), type !== "all", domain !== "all", legit !== "all", conferenceRank !== "all", sort !== "deadline"]
    .filter(Boolean).length;
  const reduceMotion = useReducedMotion();

  if (error) return <div className="notice notice-error"><strong>We couldn’t load the call index.</strong><span>{error}</span><button className="btn secondary" onClick={() => setReloadKey((x) => x + 1)}>Try again</button></div>;
  if (!data) return <div className="loading-state"><span className="spinner" /><strong>Loading verified open calls…</strong><span>Checking the latest backend snapshot.</span></div>;

  const updated = data.updatedAt ? new Date(data.updatedAt).toLocaleDateString() : "—";
  const types = [{ key: "all", label: "All" }, ...(data.catalog?.venueTypes || [])];

  return (
    <div className="dashboard-view">
      <section className="dashboard-stats" aria-label="Open-call summary">
        <div className="stat-card stat-primary"><span className="stat-label">Open now</span><strong>{data.items.length}</strong><small>verified opportunities</small></div>
        <div className="stat-card"><span className="stat-label">In this view</span><strong>{filtered.length}</strong><small>{activeFilterCount ? `${activeFilterCount} active filter${activeFilterCount === 1 ? "" : "s"}` : "all call types"}</small></div>
        <div className="stat-card"><span className="stat-label">Next deadline</span><strong className="stat-date">{nextDeadline ? new Date(nextDeadline.deadline).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "Rolling"}</strong><small>{nextDeadline?.acronym || "No fixed date"}</small></div>
        <div className="stat-card"><span className="stat-label">Freshness</span><strong className="stat-date">{updated}</strong><small>full check every 48h</small></div>
      </section>

      <section className="filter-panel" aria-label="Search and filter calls">
        <div className="search-field">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" /></svg>
          <input
            ref={searchRef}
            className="input search"
            aria-label="Search open academic opportunities"
            placeholder="Try “trustworthy AI with a deadline at least one month away”"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          {q ? <button className="clear-search" onClick={() => setQ("")} aria-label="Clear search">×</button> : <kbd>⌘ K</kbd>}
        </div>

        <HybridSearchStatus query={q} interpretation={searchState.interpretation} />

        <div className="filter-grid">
          <label><span>Research area</span><select className="select" value={domain} onChange={(e) => setDomain(e.target.value)}>
            <option value="all">All domains</option>
            {domains.map((d) => <option key={d} value={d}>{d}</option>)}
          </select></label>
          <label><span>Integrity</span><select className="select" value={legit} onChange={(e) => setLegit(e.target.value)}>
            <option value="all">All verified calls</option>
            <option value="trusted">Trusted only</option>
            <option value="hide-caution">Hide caution</option>
          </select></label>
          <label><span>Conference rank</span><select className="select" aria-label="Filter by conference ranking" value={conferenceRank} onChange={(e) => setConferenceRank(e.target.value)}>
            {(data.catalog?.rankingFilters?.conference || []).map((rank) => <option key={rank.key} value={rank.key}>{rank.label}</option>)}
          </select></label>
          <label><span>Order</span><select className="select" value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="deadline">{q.trim() ? "Smart relevance" : "Deadline · soonest"}</option>
            <option value="name">Name · A–Z</option>
          </select></label>
        </div>

        <div className="type-filter-row">
          <div className="chips" role="group" aria-label="Filter by call type">
            {types.map((t) => (
              <button key={t.key} className={`chip${type === t.key ? " active" : ""}`} onClick={() => setType(t.key)} aria-pressed={type === t.key}>
                <span>{t.label}</span><small>{t.key === "all" ? data.items.length : typeCounts.get(t.key) || 0}</small>
              </button>
            ))}
          </div>
          {activeFilterCount ? <button className="reset-filters" onClick={() => { setQ(""); setType("all"); setDomain("all"); setLegit("all"); setConferenceRank("all"); setSort("deadline"); }}>Reset filters</button> : null}
        </div>
      </section>

      <div className="results-bar">
        <div><span className="results-kicker">Live index</span><strong>{filtered.length} matching opportunit{filtered.length === 1 ? "y" : "ies"}</strong></div>
        <div className="results-meta">Showing {Math.min(visibleItems.length, filtered.length)} of {filtered.length} · Updated {updated} · times shown locally
        {q.trim() ? <> · ranked by contextual relevance</> : null}
        {data.openreviewSync ? (
          <> · OpenReview <strong>{data.openreviewSync.mirroredEntries ?? 0}</strong> live calls
            {data.openreviewSync.runtimeFallback || data.openreviewSync.warning ? (
              <> · <button className="link-button" onClick={() => setReloadKey((x) => x + 1)}>Reload snapshot</button></>
            ) : null}
          </>
        ) : null}
        </div>
      </div>

      <motion.div className="grid" layout={!reduceMotion}>
        <AnimatePresence initial={false} mode="popLayout">
          {visibleItems.map((c, index) => <CFPCard key={c.id} c={c} catalog={data.catalog} index={index} />)}
        </AnimatePresence>
      </motion.div>
      {visibleItems.length < filtered.length ? (
        <div className="load-more-wrap">
          <button className="btn secondary load-more" onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}>
            Show {Math.min(PAGE_SIZE, filtered.length - visibleItems.length)} more
            <span aria-hidden="true">↓</span>
          </button>
          <small>{filtered.length - visibleItems.length} opportunities remain</small>
        </div>
      ) : null}
      {filtered.length === 0 ? <div className="empty-state"><span className="empty-radar"><span /></span><h2>No calls match that combination.</h2><p>Try a broader research area, remove a rank filter, or describe your goal with fewer constraints.</p><button className="btn secondary" onClick={() => { setQ(""); setType("all"); setDomain("all"); setLegit("all"); setConferenceRank("all"); }}>Clear all filters</button></div> : null}
    </div>
  );
}
