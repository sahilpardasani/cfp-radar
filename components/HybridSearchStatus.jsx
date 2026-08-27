"use client";

export default function HybridSearchStatus({ query, interpretation }) {
  const active = Boolean(query.trim());
  return (
    <div className={`hybrid-search-status${active ? " active" : ""}`} aria-live="polite">
      <strong>{active ? "Smart search" : "Search naturally"}</strong>
      <span>
        {active
          ? interpretation || "Using keyword and contextual relevance"
          : "Try: “trustworthy AI with a deadline at least a month away”"}
      </span>
    </div>
  );
}
