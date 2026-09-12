// Pure formatting helpers for the price chart -- kept dependency-free (no import from
// "lightweight-charts") on the same principle as chartSeries.ts: a Node script can call
// these directly without loading a browser-oriented charting library, which is what makes
// them checkable at all in a suite that has no DOM.
//
// Three unrelated fixes live here because they were made in the same pass and all share
// the same shape: a value lightweight-charts would otherwise render too wide, too
// ambiguous, or in the wrong timezone.

/**
 * A power-of-ten divisor chosen so a price displays with a bounded, small number of
 * digits regardless of its raw magnitude. Launch prices on this curve run ~2.5e-6 USDC;
 * printed at full precision that is a 12-character string ("0.0000025400") eating close to
 * a third of a 380px axis. Dividing by the nearest power of ten below the price collapses
 * the leading digits to a single one in [1, 10), so the FORMATTED width stays bounded even
 * though the raw value is not.
 *
 * Deliberately NOT recomputed per re-render or per zoom: it is read once, from the price
 * the chart had when it was first drawn, exactly like the fixed `precision`/`minMove` this
 * replaces. A token whose price later moves by orders of magnitude will show a scale that
 * no longer centres on 1-9, which is an accepted trade-off against a caption whose meaning
 * would otherwise change silently as the user watches it.
 */
export function priceScaleFor(referencePrice: number): number {
  if (!Number.isFinite(referencePrice) || referencePrice <= 0) return 1;
  return 10 ** Math.floor(Math.log10(referencePrice));
}

/** The caption naming the scale once, e.g. "×1e-6", so the axis numbers need no exponent
 * of their own. `scale` must be a power of ten produced by `priceScaleFor` (or `1`). */
export function priceScaleLabel(scale: number): string {
  if (scale === 1) return "×1";
  const exp = Math.round(Math.log10(scale));
  return `×1e${exp}`;
}

/**
 * A raw price, divided by the stated scale and fixed at 4 decimals so every label on the
 * axis is the same width regardless of which candle it belongs to. 4 decimals keeps
 * meaningful resolution on the scaled value (matching the ~4 significant digits the old
 * fixed `precision: 10` gave a price around 2.5e-6) without letting a rounding artifact
 * two candles apart read as identical.
 */
export function formatScaledPrice(price: number, scale: number): string {
  if (!Number.isFinite(price) || !Number.isFinite(scale) || scale === 0) return "";
  return (price / scale).toFixed(4);
}

/** `UTC+1`, `UTC-5`, `UTC+5:30` -- from a minutes-ahead-of-UTC offset, so the caption
 * stating "this axis is local time" can say WHICH local time once, rather than leaving a
 * bare "14:32" that could be any zone. Takes the offset as a parameter (rather than
 * reading `Date` internally) purely so it can be asserted against a fixed value here --
 * the caller passes `-new Date().getTimezoneOffset()`, which is the only place the actual
 * clock is read. */
export function utcOffsetLabel(minutesAheadOfUtc: number): string {
  const sign = minutesAheadOfUtc >= 0 ? "+" : "-";
  const abs = Math.abs(minutesAheadOfUtc);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return m === 0 ? `UTC${sign}${h}` : `UTC${sign}${h}:${String(m).padStart(2, "0")}`;
}

// lightweight-charts' TickMarkType enum, reproduced as plain numbers rather than imported,
// so this file stays free of a browser-oriented charting library. Values confirmed against
// the installed package's own typings (node_modules/lightweight-charts/dist/typings.d.ts):
// Year = 0, Month = 1, DayOfMonth = 2, Time = 3, TimeWithSeconds = 4. PriceChart.tsx passes
// the real `TickMarkType.Year` etc., which ARE these numbers, so the two cannot drift
// silently -- a library upgrade that renumbered the enum would pass a different number in
// and this file's switch would fall through to the default (Time) case rather than
// throwing, which is a display change worth noticing, not a crash worth crashing over.

/**
 * The axis tick label, in the VIEWER'S local time zone. lightweight-charts' own default
 * formatter constructs its strings from `getUTCHours()`/`getUTCDate()`/etc (confirmed by
 * reading the installed bundle) -- this is the same shape, with local getters via
 * `Intl.DateTimeFormat`, which is the only reason it differs.
 *
 * `timeZone` is optional and exists ONLY so a check can pin a deterministic zone
 * regardless of which machine runs the suite; production never passes it, which is what
 * makes `Intl.DateTimeFormat` resolve to the viewer's actual local zone.
 */
export function formatLocalTickMark(
  epochSeconds: number,
  tickMarkType: number,
  intlTag: string,
  timeZone?: string
): string {
  const date = new Date(epochSeconds * 1000);
  const opts: Intl.DateTimeFormatOptions =
    tickMarkType === 0 // Year
      ? { year: "numeric" }
      : tickMarkType === 1 // Month
        ? { month: "short" }
        : tickMarkType === 2 // DayOfMonth
          ? { day: "numeric", month: "short" }
          : tickMarkType === 4 // TimeWithSeconds
            ? { hour: "2-digit", minute: "2-digit", second: "2-digit" }
            : { hour: "2-digit", minute: "2-digit" }; // Time (3), and the default
  return new Intl.DateTimeFormat(intlTag, { ...opts, timeZone }).format(date);
}

/** The crosshair label -- date and time together, since a lone time is ambiguous about
 * which day it falls on once the visible range spans more than one. Same local-vs-UTC
 * reasoning and the same test-only `timeZone` escape hatch as `formatLocalTickMark`. */
export function formatLocalCrosshair(epochSeconds: number, intlTag: string, timeZone?: string): string {
  const date = new Date(epochSeconds * 1000);
  return new Intl.DateTimeFormat(intlTag, {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
    timeZone,
  }).format(date);
}
