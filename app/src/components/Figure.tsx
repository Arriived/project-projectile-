// A number that flashes briefly when it changes, and dims while it is being refreshed.
//
// Two different states that are easy to conflate and must not be:
//
//   REFRESHING  we are fetching; the number on screen is the PREVIOUS answer. It is
//               dimmed and marked, because a stale figure presented as live is the same
//               failure class as the volume windows before the backfill -- confident and
//               wrong. On a curve whose snipe tax decays every second, "a second old" is
//               a material difference, not a pedantic one.
//
//   CHANGED     a new value has landed. It flashes once so the eye catches a figure that
//               moved while being read.
//
// ⚠ THE FLASH ANIMATES BACKGROUND ONLY. Nothing here may change size or weight: a quote
// updates every second during the snipe window, and a figure that reflows on each update
// makes the panel unusable exactly when it matters most.

import { useEffect, useRef, useState } from "react";

export function Figure({
  value,
  refreshing = false,
  className = "",
}: {
  /** The rendered text. Compared by identity to decide whether to flash. */
  value: string;
  refreshing?: boolean;
  className?: string;
}) {
  const [flash, setFlash] = useState(false);
  const prev = useRef(value);

  useEffect(() => {
    if (prev.current === value) return;
    prev.current = value;
    setFlash(true);
    // Matches the CSS duration. Cleared on unmount so a figure that disappears
    // mid-animation does not set state on a dead component.
    const id = window.setTimeout(() => setFlash(false), 450);
    return () => window.clearTimeout(id);
  }, [value]);

  return (
    <span
      className={[className, flash ? "num-flash" : "", refreshing ? "refreshing" : ""]
        .filter(Boolean)
        .join(" ")}
      // Tells a screen reader the value is in flux, so it is not read out as settled.
      aria-busy={refreshing || undefined}
    >
      {value}
      {refreshing && <span className="refresh-dot" aria-hidden />}
    </span>
  );
}
