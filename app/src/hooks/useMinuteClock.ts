// The one clock the price chart reads: UNIX seconds, floored to the minute, advancing once
// per minute on the boundary.
//
// ⚠ WHY IT EXISTS. PriceChart and useCandles both called Date.now() during render. That value
// changes on every render, it fed the chart's series, and so every render -- on an active
// token, every trade the page noticed -- rebuilt the series and, with it, the whole chart,
// throwing away the user's zoom and pan. The chart's finest bucket is one minute, so a clock
// that ticks once a minute loses nothing. See CLAUDE.md §23.

import { useEffect, useState } from "react";

const MINUTE_MS = 60_000;
const flooredNow = (): number => Math.floor(Date.now() / MINUTE_MS) * 60;

export function useMinuteClock(): number {
  const [now, setNow] = useState(flooredNow);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      // Fire just after the next minute boundary, so the new minute is already current.
      timer = setTimeout(() => {
        setNow(flooredNow());
        schedule();
      }, MINUTE_MS - (Date.now() % MINUTE_MS) + 50);
    };
    schedule();
    return () => clearTimeout(timer);
  }, []);
  return now;
}
