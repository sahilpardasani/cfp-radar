"use client";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useDeadlineClock } from "./useDeadlineClock";

function CountdownCell({ value, label, urgent = false }) {
  const reduceMotion = useReducedMotion();
  return (
    <div className={`cd-cell${urgent ? " cd-soon" : ""}`}>
      <span className="cd-num-wrap">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            className="cd-num"
            key={String(value)}
            initial={reduceMotion ? false : { y: -5, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { y: 5, opacity: 0 }}
            transition={{ duration: 0.18 }}
          >
            {value}
          </motion.span>
        </AnimatePresence>
      </span>
      <span className="cd-lab">{label}</span>
    </div>
  );
}

/**
 * Live countdown to a deadline, computed from the USER's system clock.
 * Shows months, days and hours remaining; the final hour switches to minutes.
 */
export default function Countdown({ deadline, tbd = false, activeNoDeadline = false }) {
  const now = useDeadlineClock();

  if (tbd) {
    return (
      <div className="countdown">
        <CountdownCell value="?" label="See CFP" />
      </div>
    );
  }

  if (!deadline) {
    return (
      <div className="countdown">
        <CountdownCell value={activeNoDeadline ? "Open" : "∞"} label={activeNoDeadline ? "No deadline shown" : "Rolling"} />
      </div>
    );
  }

  const target = new Date(deadline).getTime();
  let diff = target - now;
  const closed = diff <= 0;
  if (closed) diff = 0;

  // Break down into months / days / hours based on the user's local time.
  const nowD = new Date(now);
  const tgtD = new Date(target);
  let months =
    (tgtD.getFullYear() - nowD.getFullYear()) * 12 + (tgtD.getMonth() - nowD.getMonth());
  // Adjust if we haven't reached the day-of-month yet.
  const anchor = new Date(nowD);
  anchor.setMonth(anchor.getMonth() + months);
  if (anchor.getTime() > target) {
    months -= 1;
    anchor.setMonth(anchor.getMonth() - 1);
  }
  let rem = target - anchor.getTime();
  if (rem < 0) rem = 0;
  const days = Math.floor(rem / (1000 * 60 * 60 * 24));
  const hours = Math.floor((rem % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  const minutes = Math.max(1, Math.ceil(diff / (1000 * 60)));

  const soon = !closed && diff < 1000 * 60 * 60 * 24 * 7; // < 1 week

  if (closed) {
    return (
      <div className="countdown">
        <CountdownCell value="—" label="Closed" urgent />
      </div>
    );
  }

  if (diff < 1000 * 60 * 60) {
    return (
      <div className="countdown cd-soon">
        <CountdownCell value={minutes} label="Minutes left" urgent />
      </div>
    );
  }

  return (
    <div className={"countdown" + (soon ? " cd-soon" : "")}>
      <CountdownCell value={Math.max(0, months)} label="Months" urgent={soon} />
      <CountdownCell value={days} label="Days" urgent={soon} />
      <CountdownCell value={hours} label="Hours" urgent={soon} />
    </div>
  );
}
