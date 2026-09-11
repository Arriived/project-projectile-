// Driving the price chart without tearing it down.
//
// ── ⚠ WHY THIS EXISTS ─────────────────────────────────────────────────────────
//
// PriceChart used to destroy and recreate its whole lightweight-charts instance whenever its
// series changed, then call fitContent(). The series changed on EVERY render: `now` was read
// from Date.now() inside render, and useCandles returned freshly built arrays each time. So
// every page re-render -- on an active token, every trade the 6s curve poll noticed -- threw
// the chart away, and the user's zoom and pan with it.
//
// This decides, from what the chart already draws and what it should draw, the cheapest
// correct way to get there. It is pure, so verify:chart can prove it without a browser.
//
//   none    nothing changed: touch nothing.
//   update  only the last bar changed and/or newer bars were appended: series.update() for
//           each, in time order. update() replaces the last bar when the time matches and
//           appends when it is newer. It REFUSES to go backwards ("Cannot update oldest
//           data"), so every appended bar must be strictly newer than the one before it.
//   reset   anything earlier changed, bars went missing, or the time grid moved (a
//           re-bucket): series.setData(), with the caller keeping the visible time range.

export type Bar = { time: number; open: number; high: number; low: number; close: number };

export type SeriesPlan =
  | { kind: "none" }
  | { kind: "update"; bars: Bar[] }
  | { kind: "reset" };

const same = (a: Bar, b: Bar): boolean =>
  a.time === b.time && a.open === b.open && a.high === b.high && a.low === b.low && a.close === b.close;

export function planSeriesUpdate(drawn: readonly Bar[] | null, next: readonly Bar[]): SeriesPlan {
  if (drawn === null || drawn.length === 0) {
    return next.length === 0 ? { kind: "none" } : { kind: "reset" };
  }
  if (next.length < drawn.length) return { kind: "reset" };

  // Everything before the last drawn bar must be untouched, bar for bar. A late-indexed trade
  // in an old bucket rewrites history, and update() cannot rewrite history.
  const last = drawn.length - 1;
  for (let i = 0; i < last; i++) {
    if (!same(drawn[i], next[i])) return { kind: "reset" };
  }
  if (next[last].time !== drawn[last].time) return { kind: "reset" };

  const bars: Bar[] = [];
  if (!same(drawn[last], next[last])) bars.push(next[last]);
  let previous = next[last].time;
  for (let i = drawn.length; i < next.length; i++) {
    if (!(next[i].time > previous)) return { kind: "reset" };
    bars.push(next[i]);
    previous = next[i].time;
  }
  return bars.length === 0 ? { kind: "none" } : { kind: "update", bars };
}
