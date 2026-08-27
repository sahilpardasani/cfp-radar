"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useState } from "react";
import ThemeToggle from "@/components/ThemeToggle";
import Dashboard from "@/components/Dashboard";
import Recommender from "@/components/Recommender";
import WorkshopProposals from "@/components/WorkshopProposals";
import BookCalls from "@/components/BookCalls";
import ReviewerCalls from "@/components/ReviewerCalls";
import { DeadlineClockProvider } from "@/components/useDeadlineClock";

const TABS = [
  {
    id: "dashboard",
    label: "Open calls",
    eyebrow: "Opportunity intelligence",
    title: "The academic calls worth knowing about.",
    description: "One trusted view of open conferences, workshops, journals and special issues—verified, deduplicated and translated into your local time.",
  },
  {
    id: "proposals",
    label: "Host a workshop",
    eyebrow: "Build the research agenda",
    title: "Turn an idea into a workshop.",
    description: "Find official calls inviting academics to propose and organize workshops at established conferences.",
  },
  {
    id: "books",
    label: "Books & chapters",
    eyebrow: "Long-form scholarship",
    title: "Find serious homes for bigger ideas.",
    description: "Book and chapter proposal calls from verified university presses and established scholarly publishers.",
  },
  {
    id: "reviewers",
    label: "Review papers",
    eyebrow: "Join the community",
    title: "Contribute as a reviewer.",
    description: "Official reviewer recruitment calls for researchers and students who want to serve their field.",
  },
  {
    id: "recommend",
    label: "Paper → Venue",
    eyebrow: "Private by default",
    title: "Decide where your work belongs.",
    description: "Use the live call set to compare venues, inspect a draft or develop an extension. Sharing a manuscript is always optional.",
  },
];

function RadarMark() {
  return (
    <span className="radar-mark" aria-hidden="true">
      <span className="radar-ring radar-ring-one" />
      <span className="radar-ring radar-ring-two" />
      <span className="radar-sweep" />
      <span className="radar-core" />
    </span>
  );
}

function TabIcon({ id }) {
  const paths = {
    dashboard: <><path d="M4 5h16v14H4z" /><path d="M8 9h8M8 13h5" /></>,
    proposals: <><path d="M12 3v18M3 12h18" /><circle cx="12" cy="12" r="7" /></>,
    books: <><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H11v16H6.5A2.5 2.5 0 0 0 4 21.5z" /><path d="M20 5.5A2.5 2.5 0 0 0 17.5 3H13v16h4.5a2.5 2.5 0 0 1 2.5 2.5z" /></>,
    reviewers: <><path d="M9 11l2 2 4-5" /><path d="M5 4h14v17l-7-3-7 3z" /></>,
    recommend: <><path d="M12 3l1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7z" /><path d="M19 17l.7 2.3L22 20l-2.3.7L19 23l-.7-2.3L16 20l2.3-.7z" /></>,
  };
  return <svg className="tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[id]}</svg>;
}

function CurrentView({ tab }) {
  if (tab === "dashboard") return <Dashboard />;
  if (tab === "proposals") return <WorkshopProposals />;
  if (tab === "books") return <BookCalls />;
  if (tab === "reviewers") return <ReviewerCalls />;
  return <Recommender />;
}

export default function Home() {
  const [tab, setTab] = useState("dashboard");
  const reduceMotion = useReducedMotion();
  const active = TABS.find((item) => item.id === tab) || TABS[0];

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to opportunities</a>
      <header className="site-header">
        <div className="container header-row">
          <button className="brand" onClick={() => setTab("dashboard")} aria-label="CFP Radar home">
            <RadarMark />
            <span className="brand-copy"><strong>CFP Radar</strong><small>Research opportunity intelligence</small></span>
          </button>
          <div className="header-status" title="The backend refreshes and revalidates calls every two days">
            <span className="live-dot" /> Verified · refreshed every 48h
          </div>
          <div className="spacer" />
          <ThemeToggle />
        </div>
        <div className="container nav-row">
          <nav className="tabs" role="tablist" aria-label="CFP Radar sections">
            {TABS.map((item) => (
              <button
                key={item.id}
                className={`tab-btn${tab === item.id ? " active" : ""}`}
                onClick={() => setTab(item.id)}
                role="tab"
                aria-selected={tab === item.id}
              >
                {tab === item.id ? <motion.span className="tab-active-bg" layoutId="active-tab" transition={{ type: "spring", bounce: 0.16, duration: 0.5 }} /> : null}
                <span className="tab-content"><TabIcon id={item.id} /><span>{item.label}</span></span>
              </button>
            ))}
          </nav>
        </div>
      </header>

      <DeadlineClockProvider>
        <main id="main-content" className="container app-main">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={tab}
              initial={reduceMotion ? false : { opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduceMotion ? { opacity: 1 } : { opacity: 0, y: -6 }}
              transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
            >
              <section className="workspace-hero" aria-labelledby="page-title">
                <div className="hero-orb hero-orb-one" aria-hidden="true" />
                <div className="hero-orb hero-orb-two" aria-hidden="true" />
                <div className="hero-content">
                  <div className="hero-eyebrow"><span className="hero-eyebrow-line" />{active.eyebrow}</div>
                  <h1 id="page-title">{active.title}</h1>
                  <p>{active.description}</p>
                  <div className="hero-proof" aria-label="Product guarantees">
                    <span><b>✓</b> Official-source links</span>
                    <span><b>✓</b> Closed calls disappear automatically</span>
                    <span><b>✓</b> No manuscript required</span>
                  </div>
                </div>
              </section>
              <CurrentView tab={tab} />
            </motion.div>
          </AnimatePresence>
        </main>
      </DeadlineClockProvider>

      <footer className="footer">
        <div className="container footer-inner">
          <div className="footer-brand"><RadarMark /><span><strong>CFP Radar</strong><small>Built for researchers who would rather do research than hunt for calls.</small></span></div>
          <div className="footer-meta"><span className="live-dot" /> Sources rechecked every two days · deadlines use your timezone</div>
        </div>
      </footer>
    </div>
  );
}
