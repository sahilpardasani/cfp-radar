"use client";
import { createContext, useContext, useEffect, useState } from "react";

const DeadlineClockContext = createContext(null);

/** Shared client clock that also catches up immediately when a tab is reopened. */
export function DeadlineClockProvider({ children, intervalMs = 15_000 }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const update = () => setNow(Date.now());
    const timer = setInterval(update, intervalMs);
    const onVisibility = () => {
      if (document.visibilityState === "visible") update();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [intervalMs]);
  return <DeadlineClockContext.Provider value={now}>{children}</DeadlineClockContext.Provider>;
}

export function useDeadlineClock() {
  const now = useContext(DeadlineClockContext);
  if (now == null) throw new Error("useDeadlineClock must be used within DeadlineClockProvider");
  return now;
}
