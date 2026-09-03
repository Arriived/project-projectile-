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
  type UTCTimestamp,
} from "lightweight-charts";
import { useT } from "../../i18n";
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
const PALETTE = {
  light: {
    text: "#777777", grid: "#e9e9e5", border: "#d6d6d1",
    up: "#1f6b3a", down: "#a32b2b", flat: "#777777",
  },
  dark: {
    text: "#8f8f86", grid: "#2f2f29", border: "#2f2f29",
    up: "#56b077", down: "#d97070", flat: "#8f8f86",
  },
} as const;

export function PriceChart({
  points,
  candles,
  isFlatLaunch,
  isHistoryUnchartable,
  isLoading,
}: {
  points: PricePoint[];
  candles: Candle[];
  isFlatLaunch: boolean;
  isHistoryUnchartable: boolean;
  isLoading: boolean;
}) {
  const { t } = useT();
  const { theme } = useTheme();
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);

  const now = Math.floor(Date.now() / 1000);
  const [tf, setTf] = useState<TimeframeId | null>(null);
  const chosen = tf ?? defaultTimeframe(candles, now);

  const series = useMemo(() => {
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

  useEffect(() => {
    if (!box.current || series.length === 0) return;
    const pal = PALETTE[theme];

    const c = createChart(box.current, {
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: pal.text,
        fontFamily: "DM Mono, ui-monospace, monospace",
        fontSize: 10,
      },
      grid: { vertLines: { visible: false }, horzLines: { color: pal.grid } },
      rightPriceScale: { borderColor: pal.border },
      timeScale: { borderColor: pal.border, timeVisible: true, secondsVisible: false },
      crosshair: { mode: 1 },
      // ⚠ Zoom and pan ON. The reset button below is what keeps it from being a trap:
      // scrolling into empty space on a sparse series can leave a blank canvas with no
      // obvious way back, and "the chart broke" is what that looks like to a user.
      handleScale: true,
      handleScroll: true,
      height: box.current.clientHeight || 260,
    });

    const s = c.addSeries(CandlestickSeries, {
      upColor: pal.up,
      downColor: pal.down,
      borderUpColor: pal.up,
      borderDownColor: pal.down,
      wickUpColor: pal.up,
      wickDownColor: pal.down,
      // Launch prices are ~2.5e-6 USDC. The default formatter renders every one as 0.00,
      // so precision comes from the data's magnitude rather than a guess.
      priceFormat: { type: "price", precision: 10, minMove: 0.0000000001 },
    });

    s.setData(
      series.map((k) => ({
        time: k.time as UTCTimestamp,
        open: k.open, high: k.high, low: k.low, close: k.close,
      }))
    );
    c.timeScale().fitContent();
    chart.current = c;

    // The chart does not observe its own container. Without this it keeps the width it was
    // born with and overflows the column the moment anything reflows.
    const ro = new ResizeObserver(() => {
      if (box.current) c.applyOptions({ width: box.current.clientWidth, height: box.current.clientHeight || 260 });
    });
    ro.observe(box.current);
    c.applyOptions({ width: box.current.clientWidth });

    return () => {
      ro.disconnect();
      c.remove();
      chart.current = null;
    };
  }, [series, theme]);

  const hasChart = series.length > 0;

  return (
    <section className="chart-panel">
      <div className="chart-head">
        <h2 className="panel-h">{t("chart.heading")}</h2>
        {/* ⚠ SAY WHY THE LINE IS FLAT. A brand-new token's chart is flat, and without a
            label that is indistinguishable from a broken feed -- at precisely the moment
            the creator and their first buyers are looking hardest. */}
        {isFlatLaunch && <span className="hint">{t("chart.noTradesYet")}</span>}
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

      {isLoading && !hasChart ? (
        <div className="chart-skeleton" aria-hidden />
      ) : !hasChart ? (
        <p className="hint chart-empty">{t("chart.unavailable")}</p>
      ) : (
        <div className="chart-box" ref={box} />
      )}

      <p className="hint chart-note">{t("chart.midPriceNote")}</p>
    </section>
  );
}
