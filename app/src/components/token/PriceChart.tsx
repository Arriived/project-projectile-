// The price chart. CANDLESTICKS, from token_candles_1m.
//
// ── ⚠ EMPTY BUCKETS: CARRIED FORWARD, NOT LEFT AS GAPS ────────────────────────
//
// On a bonding curve price is a PURE FUNCTION OF RESERVES, and reserves move only when
// someone trades. Between two trades the price is not unknown -- it is exactly constant,
// and we know it. So a flat candle there is a true statement, and carrying the close
// forward is arithmetic rather than interpolation.
//
// A genuine gap would claim "we do not know", which is false. Compressing the axis to
// trade-time was rejected outright: it makes three trades over a week look identical to
// three in a minute, and "is this token alive" is the one question a launchpad chart must
// answer honestly.
//
// ⚠ That does not make sparse data look busy, and it is not supposed to. The mitigation
// for a sea of flat candles is the TIMEFRAME: the same three trades that are hundreds of
// doji at 1M are a handful of real candles at 6H. The default is chosen from the data span
// (see defaultTimeframe) rather than pinned at 1M.
//
// ── WHY CANDLES AT ALL, GIVEN A SINGLE TRADE PER BUCKET ───────────────────────
//
// This file used to argue for a line, on the grounds that one trade per bucket makes a
// doji. That was true of the OLD view, which priced every trade at its POST-trade reserves
// so open = close = high = low. Migration 006 takes each trade's open from the PREVIOUS
// trade's stored reserves, because a trade SWEEPS a range: it starts at the pre-trade
// curve price and ends at the post-trade one. A single trade now has a real body.
//
// ⚠ PRICE COMES FROM RESERVES, NEVER EXECUTION PRICE. Adjacent buys and sells at the same
// reserve level differ 5.3x -- that is the snipe tax and the fees, not the market.
//
// Lazy-loaded by TokenPage: lightweight-charts is ~50 kB gzip.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  createChart,
  CandlestickSeries,
  ColorType,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { planSeriesUpdate, type Bar } from "../../lib/chartSeries";
import {
  priceScaleFor,
  priceScaleLabel,
  formatScaledPrice,
  utcOffsetLabel,
  formatLocalTickMark,
  formatLocalCrosshair,
} from "../../lib/chartFormat";
import { useT } from "../../i18n";
import { INTL_TAG } from "../../i18n/locales";
import { useTheme } from "../../providers/ThemeProvider";
import {
  TIMEFRAMES,
  aggregateCandles,
  defaultTimeframe,
  forwardFillCandles,
  type Candle,
  type PricePoint,
  type TimeframeId,
} from "../../hooks/useCandles";

/**
 * ⚠ THE CHART TAKES ITS OWN COLOUR OPTIONS AND WILL NOT INHERIT CSS VARIABLES. A dark page
 * with a white chart is worse than no dark mode, so the palette is mirrored here from
 * styles.css and keyed on the same theme the rest of the app reads. If a token changes
 * there, it must change here -- there is no way to make lightweight-charts read a
 * custom property.
 */
// ⚠ THESE MIRROR styles.css AND MUST BE CHANGED IN THE SAME COMMIT AS THE TOKENS.
//
// lightweight-charts cannot read CSS custom properties -- it takes concrete colour
// strings at construction -- so the palette is duplicated here by necessity. The
// duplication is the hazard: change --line or --muted in styles.css alone and the chart
// keeps drawing the old theme against the new page, which looks like a rendering bug
// rather than a stale constant.
//
// Mapping, so the correspondence is checkable rather than remembered:
//   text          <- --muted     grid, border  <- --line
//   up            <- --pos       down          <- --neg
//
// `verify:theme` asserts this correspondence against the real styles.css and fails if the
// two drift.
const PALETTE = {
  light: {
    text: "#777777", grid: "#e9e9e5", border: "#d6d6d1",
    up: "#1f6b3a", down: "#a32b2b", flat: "#777777",
  },
  dark: {
    text: "#8f8f8f", grid: "#2e2e2e", border: "#2e2e2e",
    up: "#56b077", down: "#d97070", flat: "#8f8f8f",
  },
} as const;

/** A bar in lightweight-charts' own shape. */
const toChartBar = (k: Bar) => ({
  time: k.time as UTCTimestamp,
  open: k.open, high: k.high, low: k.low, close: k.close,
});

/** The colours, applied at creation AND on every theme change -- never by rebuilding. */
function themeOptions(pal: (typeof PALETTE)[keyof typeof PALETTE]) {
  return {
    chart: {
      layout: { background: { type: ColorType.Solid as const, color: "transparent" }, textColor: pal.text },
      grid: { vertLines: { visible: false }, horzLines: { color: pal.grid } },
      rightPriceScale: { borderColor: pal.border },
      timeScale: { borderColor: pal.border },
    },
    series: {
      upColor: pal.up,
      downColor: pal.down,
      borderUpColor: pal.up,
      borderDownColor: pal.down,
      wickUpColor: pal.up,
      wickDownColor: pal.down,
    },
  };
}

export function PriceChart({
  points,
  candles,
  now,
  isFlatLaunch,
  isHistoryUnchartable,
  isLoading,
  isError,
}: {
  points: PricePoint[];
  candles: Candle[];
  /**
   * UNIX seconds, floored to the minute: the clock useCandles filled to. Passed in, not read
   * here -- a Date.now() in render changed on every render and rebuilt the series with it.
   */
  now: number;
  isFlatLaunch: boolean;
  isHistoryUnchartable: boolean;
  isLoading: boolean;
  isError: boolean;
}) {
  const { t, locale } = useT();
  const { theme } = useTheme();
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const bars = useRef<ISeriesApi<"Candlestick"> | null>(null);
  // What the series holds right now, and at which timeframe: the "before" for the planner.
  const drawn = useRef<Bar[] | null>(null);
  const drawnTf = useRef<TimeframeId | null>(null);
  // The theme to create with, without making creation depend on the theme.
  const themeNow = useRef(theme);
  themeNow.current = theme;
  // Same reasoning, for locale: read fresh at creation time without making creation
  // depend on it (only "en" ships today, so this is a robustness match for `themeNow`
  // rather than a live need).
  const localeNow = useRef(locale);
  localeNow.current = locale;

  const [tf, setTf] = useState<TimeframeId | null>(null);
  const chosen = tf ?? defaultTimeframe(candles, now);

  const series = useMemo((): Bar[] => {
    if (candles.length === 0) {
      // No chartable trades: fall back to the flat launch line the hook already builds,
      // rendered as flat candles so the series type does not change under the user.
      return points.map((p) => ({ time: p.time, open: p.value, high: p.value, low: p.value, close: p.value }));
    }
    const spec = TIMEFRAMES.find((x) => x.id === chosen)!;
    // ALL: one bucket wide enough to hold the whole span in ~120 candles.
    const bucket =
      spec.seconds === 0
        ? Math.max(60, Math.ceil((now - Math.min(...candles.map((c) => c.time))) / 120 / 60) * 60)
        : spec.seconds;
    return forwardFillCandles(aggregateCandles(candles, bucket), now, bucket);
  }, [candles, points, chosen, now]);

  const hasChart = series.length > 0;

  // The price-axis scale, locked in from whatever the series' last close was the FIRST
  // time a chart exists to show it -- computed lazily during render (not in an effect) so
  // it is available in time for both the series' priceFormat below and the caption in the
  // JSX, in the same pass. Fixed for the life of the mounted chart, exactly like the
  // precision/minMove it replaces: recomputing it as the price moves would change what the
  // caption means while someone is reading it.
  const lockedScale = useRef<number | null>(null);
  if (lockedScale.current === null && series.length > 0) {
    lockedScale.current = priceScaleFor(series[series.length - 1].close);
  }
  const scale = lockedScale.current ?? 1;

  // Stable for the life of the session -- a viewer's timezone does not change mid-visit --
  // so this is computed once rather than read fresh on every render. Unlike Date.now()
  // (K11), it never feeds a memo or effect dependency and cannot cause a rebuild.
  const utcOffsetMinutes = useMemo(() => -new Date().getTimezoneOffset(), []);

  // ── ⚠ THE CHART IS CREATED ONCE, AND NEVER FOR NEW DATA ───────────────────────────
  //
  // This effect used to depend on [series, theme]. The series changed on every render, so
  // the chart was destroyed, recreated and fitContent()-ed every time: on an active token,
  // every trade threw away the user's zoom and pan. It now runs only when the box mounts or
  // unmounts. Data arrives through the effect below; the theme through applyOptions.
  useEffect(() => {
    if (!hasChart || !box.current) return;
    const el = box.current;
    const look = themeOptions(PALETTE[themeNow.current]);

    const intlTag = INTL_TAG[localeNow.current];

    const c = createChart(el, {
      ...look.chart,
      layout: { ...look.chart.layout, fontFamily: "DM Mono, ui-monospace, monospace", fontSize: 10 },
      // ⚠ tickMarkDensity RAISED FROM THE DEFAULT (2.5) TO REDUCE LABEL COLLISIONS.
      // lightweight-charts' own current-price tag and its regular gridline labels are two
      // independent rendering passes that do not know about each other -- the library has
      // no "keep these apart" option between them, confirmed by reading the bundled
      // source (there is no counterpart to `alignLabels`, which only reconciles a price
      // scale's OWN set of last-value/crosshair views against each other, for the tick
      // marks a separate builder draws). A higher density is the one lever the library
      // exposes for this: fewer, more widely spaced gridlines make the collision far less
      // likely, but it is a mitigation, not a guarantee -- a current price landing exactly
      // on a surviving gridline's value can still coincide at some zoom level.
      rightPriceScale: { ...look.chart.rightPriceScale, tickMarkDensity: 5 },
      timeScale: {
        ...look.chart.timeScale,
        timeVisible: true,
        secondsVisible: false,
        // ⚠ THE FIX FOR "BARE VERTICAL LINES." lightweight-charts' default minBarSpacing
        // is 0.5px, so fitContent() over many buckets in a narrow mobile column happily
        // compresses each candle's rendered width below what a body rectangle needs to
        // read as anything but a line. Flooring it means fitContent() shows fewer, legible
        // candles instead of every candle illegibly -- the rest are reachable by scrolling
        // (handleScroll is already on) or the Reset button below.
        minBarSpacing: 4,
        // Local time, not UTC -- lightweight-charts' own default tick formatter builds its
        // strings from getUTCHours()/getUTCDate()/etc (confirmed by reading the bundled
        // source), so a bare "14:32" was always UTC with nothing on screen saying so. See
        // lib/chartFormat.ts for why the granularity switch uses plain numbers rather than
        // importing TickMarkType.
        tickMarkFormatter: (time: number, tickMarkType: number) =>
          formatLocalTickMark(time, tickMarkType, intlTag),
      },
      // The crosshair label gets the same local-time treatment as the axis ticks.
      localization: { timeFormatter: (time: number) => formatLocalCrosshair(time, intlTag) },
      crosshair: { mode: 1 },
      // ⚠ Zoom and pan ON. The reset button below is what keeps it from being a trap:
      // scrolling into empty space on a sparse series can leave a blank canvas with no
      // obvious way back, and "the chart broke" is what that looks like to a user.
      handleScale: true,
      handleScroll: true,
      height: el.clientHeight || 260,
    });
    bars.current = c.addSeries(CandlestickSeries, {
      ...look.series,
      // Launch prices are ~2.5e-6 USDC. A fixed `precision: 10` rendered every label as a
      // 12-character string ("0.0000025400"), eating close to a third of a 380px axis. A
      // custom formatter divides by the scale locked in above and shows 4 decimals of
      // THAT, so the label width stays bounded regardless of the raw magnitude -- the
      // scale itself is stated once, in the caption below the chart, rather than repeated
      // on every label.
      priceFormat: {
        type: "custom",
        formatter: (price: number) => formatScaledPrice(price, lockedScale.current ?? 1),
        minMove: 0.0000000001,
      },
    });
    chart.current = c;
    drawn.current = null;
    drawnTf.current = null;

    // The chart does not observe its own container. Without this it keeps the width it was
    // born with and overflows the column the moment anything reflows.
    const ro = new ResizeObserver(() => {
      c.applyOptions({ width: el.clientWidth, height: el.clientHeight || 260 });
    });
    ro.observe(el);
    c.applyOptions({ width: el.clientWidth });

    return () => {
      ro.disconnect();
      c.remove();
      chart.current = null;
      bars.current = null;
      drawn.current = null;
    };
  }, [hasChart]);

  // Theme: restyle in place.
  useEffect(() => {
    const look = themeOptions(PALETTE[theme]);
    chart.current?.applyOptions(look.chart);
    bars.current?.applyOptions(look.series);
  }, [theme]);

  // ── DATA: THE SMALLEST CHANGE THAT GETS THERE ─────────────────────────────────────────
  //
  // planSeriesUpdate (lib/chartSeries.ts) compares what is drawn with what should be:
  //   none    nothing to do.
  //   update  series.update() per bar. A trade in the current bucket or a new minute lands
  //           here, and the user's zoom and pan are untouched.
  //   reset   setData(), keeping the visible TIME range, so a re-bucket or a late-indexed
  //           trade does not throw the view away either.
  // Only a first draw and a timeframe change fit the content -- plus the Reset button.
  useEffect(() => {
    const c = chart.current;
    const s = bars.current;
    if (!c || !s) return;
    const tfChanged = drawnTf.current !== chosen;
    const plan = tfChanged ? { kind: "reset" as const } : planSeriesUpdate(drawn.current, series);
    if (plan.kind === "update") {
      for (const b of plan.bars) s.update(toChartBar(b));
    } else if (plan.kind === "reset") {
      const firstForView = drawn.current === null || tfChanged;
      const keep = firstForView ? null : c.timeScale().getVisibleRange();
      s.setData(series.map(toChartBar));
      if (keep) c.timeScale().setVisibleRange(keep);
      else c.timeScale().fitContent();
    }
    drawn.current = series;
    drawnTf.current = chosen;
  }, [series, chosen, hasChart]);

  return (
    <section className="chart-panel">
      <div className="chart-head">
        <h2 className="panel-h">{t("chart.heading")}</h2>
        {/* ⚠ SAY WHY THE LINE IS FLAT. A brand-new token's chart is flat, and without a
            label that is indistinguishable from a broken feed -- at precisely the moment
            the creator and their first buyers are looking hardest. */}
        {!isError && isFlatLaunch && <span className="hint">{t("chart.noTradesYet")}</span>}
        {/* Has traded, but the history predates the reserve columns and cannot be
            recovered. Saying "no trades yet" here would be checkably false. */}
        {isHistoryUnchartable && <span className="hint">{t("chart.historyUnavailable")}</span>}

        {hasChart && (
          <div className="chart-tfs" role="group" aria-label={t("chart.timeframeLabel")}>
            {TIMEFRAMES.map((x) => (
              <button
                key={x.id}
                type="button"
                className={`chart-tf${x.id === chosen ? " on" : ""}`}
                aria-pressed={x.id === chosen}
                onClick={() => setTf(x.id)}
              >
                {x.id}
              </button>
            ))}
            {/* Zooming into empty space on a sparse series can strand the user on a blank
                canvas. This is the way back, and it is always present rather than
                appearing only once they are lost. */}
            <button
              type="button"
              className="chart-tf chart-reset"
              onClick={() => chart.current?.timeScale().fitContent()}
              title={t("chart.resetZoom")}
            >
              {t("chart.resetZoom")}
            </button>
          </div>
        )}
      </div>

      {isError ? (
        <p className="hint chart-empty">{t("chart.unavailable")}</p>
      ) : isLoading && !hasChart ? (
        <div className="chart-skeleton" aria-hidden />
      ) : !hasChart ? (
        <p className="hint chart-empty">{t("chart.unavailable")}</p>
      ) : (
        <div className="chart-box" ref={box} />
      )}

      <p className="hint chart-note">{t("chart.midPriceNote")}</p>
      {/* The scale factor and the timezone, each stated ONCE here rather than repeated
          on every axis label -- that repetition is exactly what made the price axis 12
          characters wide. See lib/chartFormat.ts. */}
      {hasChart && (
        <p className="hint chart-note">
          {t("chart.priceScaleNote", { scale: priceScaleLabel(scale) })}
          {" · "}
          {t("chart.localTimeNote", { offset: utcOffsetLabel(utcOffsetMinutes) })}
        </p>
      )}
    </section>
  );
}
