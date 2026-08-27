"use client";
import Link from "next/link";
import { motion, useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";
import Countdown from "./Countdown";

const TRUSTED_META = { label: "Trusted", cls: "legit-trusted", tip: "This venue passed the backend admission checks before being added to the live dashboard." };

function isDifferentDeadline(trackDeadline, primaryDeadline) {
  if (!trackDeadline) return false;
  if (!primaryDeadline) return true;

  const trackTime = new Date(trackDeadline).getTime();
  const primaryTime = new Date(primaryDeadline).getTime();
  return !Number.isFinite(trackTime) || !Number.isFinite(primaryTime) || trackTime !== primaryTime;
}

export default function CFPCard({ c, catalog = {}, index = 0 }) {
  const [deadlineTxt, setDeadlineTxt] = useState(
    c.deadlineTBD ? "Multiple — see workshops page" : c.deadline ? "Loading local time…" : c.deadlineStatus === "openreview-active-no-public-deadline" ? "Active on OpenReview · deadline not publicly exposed" : "Rolling / open submission"
  );
  const [timeZone, setTimeZone] = useState("");
  const [trackDeadlineText, setTrackDeadlineText] = useState([]);

  useEffect(() => {
    if (!c.deadline || c.deadlineTBD) return;
    const deadline = new Date(c.deadline);
    setDeadlineTxt(
      deadline.toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZoneName: "short",
      })
    );
    setTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone || "your local timezone");
  }, [c.deadline, c.deadlineTBD]);

  useEffect(() => {
    const rows = Array.isArray(c.openreviewDeadlines) ? c.openreviewDeadlines : [];
    setTrackDeadlineText(rows.map((row) => row.deadline
      ? new Date(row.deadline).toLocaleString(undefined, {
          year: "numeric", month: "short", day: "numeric",
          hour: "2-digit", minute: "2-digit", timeZoneName: "short",
        })
      : "Open for submissions · no public deadline"));
  }, [c.openreviewDeadlines]);

  // The live dataset is admission-controlled in the backend. Every visible card has already passed vetting.
  const lmeta = TRUSTED_META;
  const typeLabel = catalog.venueTypes?.find((type) => type.key === c.type)?.singular || c.type;
  const sourceLabel = catalog.sourceLabels?.[c.source] || c.source;
  const ranking = catalog.rankingSystems?.[c.type];
  const cfpLinkLabel = catalog.linkPolicy?.labels?.[c.cfpLinkKind || c.type] || "View CFP →";
  const reduceMotion = useReducedMotion();
  const mark = String(c.acronym || c.name || "CFP").replace(/[^a-z0-9]/gi, "").slice(0, 3).toUpperCase();

  return (
    <motion.article
      className={`card card-${c.type}`}
      layout={!reduceMotion ? "position" : false}
      initial={reduceMotion || index > 17 ? false : { opacity: 0, y: 14, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.97 }}
      whileHover={reduceMotion ? undefined : { y: -3 }}
      transition={{ duration: 0.3, delay: Math.min(index, 8) * 0.025, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="card-top">
        <div className="venue-identity">
          <span className="venue-mark" aria-hidden="true">{mark}</span>
          <div className="card-heading-copy">
            <div className="card-kicker">{typeLabel}</div>
            <div className="card-title">{c.acronym}</div>
            <div className="card-sub">{c.name}</div>
          </div>
        </div>
        <div className="card-trust-stack">
          <span className={"badge type-" + c.type}>{typeLabel}</span>
          <span className={"legit-badge " + lmeta.cls} title={lmeta.tip}>
            <span aria-hidden="true">✓</span> {lmeta.label}
          </span>
        </div>
      </div>

      <div className="badges">
        <span className="topic-tag">{c.domain}</span>
        {c.tier && c.tier !== "workshop" && c.tier !== "community" ? (
          <span className="topic-tag" title={`${ranking?.label || "Ranking"} classification`}>
            {(ranking?.prefix || "") + c.tier}
          </span>
        ) : null}
        {c.source ? (
          <span className="topic-tag" title="Where this CFP is hosted / sourced from">
            {sourceLabel}
          </span>
        ) : null}
        {c.publisher ? <span className="topic-tag">{c.publisher}</span> : null}
        {c.location ? <span className="topic-tag">{c.location}</span> : null}
      </div>

      {(c.type === "journal" || c.type === "special-issue") && (c.metrics || c.legitimacy?.ranking?.hIndex) ? (
        <div className="metrics">
          {c.metrics?.impactFactor ? (
            <span className="metric" title="Journal Impact Factor">
              <strong>IF</strong> {c.metrics.impactFactor}
            </span>
          ) : null}
          {c.metrics?.impactFactor5yr ? (
            <span className="metric" title="5-year Journal Impact Factor">
              <strong>5-yr IF</strong> {c.metrics.impactFactor5yr}
            </span>
          ) : null}
          {c.metrics?.citeScore ? (
            <span className="metric" title="CiteScore (Scopus)">
              <strong>CiteScore</strong> {c.metrics.citeScore}
            </span>
          ) : null}
          {c.metrics?.subToFirstDecision ? (
            <span className="metric" title="Submission to first decision">
              <strong>1st decision</strong> {c.metrics.subToFirstDecision}
            </span>
          ) : null}
          {c.metrics?.acceptanceToPub ? (
            <span className="metric" title="Acceptance to publication">
              <strong>Accept→pub</strong> {c.metrics.acceptanceToPub}
            </span>
          ) : null}
          {c.metrics?.acceptanceRate ? (
            <span className="metric" title="Acceptance rate">
              <strong>Accept</strong> {c.metrics.acceptanceRate}
            </span>
          ) : null}
          {c.metrics?.apc ? (
            <span className="metric" title="Article publication charge (open access)">
              <strong>APC</strong> {c.metrics.apc}
            </span>
          ) : null}
          {c.metrics?.openAccess ? (
            <span className="metric" title="Open access status">
              {c.metrics.openAccess}
            </span>
          ) : null}
          {!c.metrics?.impactFactor && c.legitimacy?.ranking?.hIndex ? (
            <span className="metric" title="h-index (OpenAlex)">
              <strong>h-index</strong> {c.legitimacy.ranking.hIndex}
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="countdown-block">
        <span className="countdown-heading">Time remaining</span>
        <Countdown deadline={c.deadline} tbd={c.deadlineTBD} activeNoDeadline={c.deadlineStatus === "openreview-active-no-public-deadline"} />
      </div>


      {Array.isArray(c.openreviewDeadlines) && c.openreviewDeadlines.length ? (
        <div className="openreview-track-list">
          {c.openreviewDeadlines.map((row, idx) => (
            <div className="openreview-track" key={`${row.deadline || "open"}-${idx}`}>
              <div className="openreview-track-date">
                {trackDeadlineText[idx] || (row.deadline ? "Loading local time…" : "Open for submissions")}
              </div>
              {isDifferentDeadline(row.deadline, c.deadline) ? (
                <div className="track-countdown">
                  <Countdown deadline={row.deadline} />
                </div>
              ) : null}
              <div className="openreview-track-links">
                {(row.links || []).map((link, linkIdx) => (
                  <a
                    className="topic-tag"
                    key={`${link.groupId || link.url}-${linkIdx}`}
                    href={link.url}
                    target="_blank"
                    rel="noreferrer"
                    title="Open this track on OpenReview"
                  >
                    {link.label || "Main submission"} ↗
                  </a>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      <div className="topic-tags">
        {(c.topics || []).slice(0, 4).map((t) => (
          <span className="topic-tag" key={t}>
            #{t}
          </span>
        ))}
      </div>

      <div className="deadline-txt">
        <strong>Deadline:</strong> {deadlineTxt}
        {c.estimated ? (
          <span title="Projected from the prior-year cycle — official CFP not yet posted"> · est.</span>
        ) : null}
        {c.deadline && !c.deadlineTBD && timeZone ? (
          <span className="local-time-note"> · shown in {timeZone}</span>
        ) : null}
        {c.eventDates ? (
          <>
            <br />
            <strong>Event:</strong> {c.eventDates}
          </>
        ) : null}
      </div>



      <div className="card-foot card-actions">
        {c.venueId && c.historyCoverage?.paperCount > 0 && ["verified", "partial"].includes(c.historyCoverage.status) ? (
          <Link className="btn secondary" href={`/venues/${encodeURIComponent(c.venueId)}/related-work`}>
            Past work &amp; venue fit →
          </Link>
        ) : null}
        {c.templateUrl ? (
          <a className="btn secondary" href={c.templateUrl} target="_blank" rel="noreferrer">
            Template
          </a>
        ) : null}
        {c.openreviewUrl ? (
          <a className="btn secondary" href={c.openreviewUrl} target="_blank" rel="noreferrer">
            OpenReview ↗
          </a>
        ) : null}
        {c.resolvedCfpUrl ? (
          <a className="btn" href={c.resolvedCfpUrl} target="_blank" rel="noopener noreferrer">
            {cfpLinkLabel}
          </a>
        ) : (
          <span className="btn unavailable" title="No verified paper-call page is available for this entry">
            CFP link unavailable
          </span>
        )}
      </div>
    </motion.article>
  );
}
