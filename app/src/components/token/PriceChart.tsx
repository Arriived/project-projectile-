// The price chart. Above the trade panel, where a trader looks first.
//
// A LINE, not candles, and that is deliberate. Almost every bucket on a bonding curve
// contains one trade or none, so a candlestick would render as a column of identical
// doji -- all the ink of an OHLC chart conveying exactly the information of a line. Real
// candles earn their place when a bucket holds many trades; this chart can adopt them the
// day that is true, from the same view, which already carries open/high/low.
//
// Lazy-loaded by TokenPage: lightweight-charts is ~50 kB gzip and nothing on the list
// page needs it.

import { useEffect, useRef } from "react";
import {
  createChart,
  ColorType,
  LineSeries,
  type IChartApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { useT } from "../../i18n";
import type { PricePoint } from "../../hooks/useCandles";

export function PriceChart({
  points,
  isFlatLaunch,
  isHistoryUnchartable,
  isLoading,
}: {
  points: PricePoint[];
  isFlatLaunch: boolean;
  isHistoryUnchartable: boolean;
  isLoading: boolean;
}) {
  const { t } = useT();
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);

  useEffect(() => {
    if (!box.current) return;

    const c = createChart(box.current, {
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#777777",
        fontFamily: "DM Mono, ui-monospace, monospace",
        fontSize: 10,
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { color: "#e9e9e5" },
      },
      rightPriceScale: { borderColor: "#d6d6d1" },
      timeScale: { borderColor: "#d6d6d1", timeVisible: true, secondsVisible: false },
      crosshair: { mode: 1 },
      handleScale: false,
      handleScroll: false,
      height: 220,
    });

    const series = c.addSeries(LineSeries, {
      color: "#111111",
      lineWidth: 2,
      // Launch prices are ~2.5e-6 USDC. The default formatter would render every point as
      // 0.00, so the precision is set from the data's own magnitude rather than a guess.
      priceFormat: { type: "price", precision: 10, minMove: 0.0000000001 },
      priceLineVisible: false,
      lastValueVisible: true,
    });

    // lightweight-charts brands its time type; our points are plain UNIX seconds, which
    // is exactly what UTCTimestamp is. The cast is the brand, not a shape change.
    series.setData(points.map((p) => ({ time: p.time as UTCTimestamp, value: p.value })));
    c.timeScale().fitContent();
    chart.current = c;

    // The chart does not observe its own container. Without this it keeps the width it
    // was born with and overflows the column the moment anything reflows.
    const ro = new ResizeObserver(() => {
      if (box.current) c.applyOptions({ width: box.current.clientWidth });
    });
    ro.observe(box.current);
    c.applyOptions({ width: box.current.clientWidth });

    return () => {
      ro.disconnect();
      c.remove();
      chart.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points]);

  return (
    <section className="chart-panel">
      <div className="chart-head">
        <h2 className="panel-h">{t("chart.heading")}</h2>
        {/* ⚠ SAY WHY THE LINE IS FLAT. A brand-new token's chart is a horizontal line, and
            without a label that is indistinguishable from a broken feed -- at precisely
            the moment the creator and their first buyers are looking hardest. */}
        {isFlatLaunch && <span className="hint">{t("chart.noTradesYet")}</span>}
        {/* Has traded, but the history predates the reserve columns and cannot be
            recovered. Saying "no trades yet" here would be checkably false. */}
        {isHistoryUnchartable && <span className="hint">{t("chart.historyUnavailable")}</span>}
      </div>

      {isLoading && points.length === 0 ? (
        <div className="chart-skeleton" aria-hidden />
      ) : points.length === 0 ? (
        <p className="hint chart-empty">{t("chart.unavailable")}</p>
      ) : (
        <div className="chart-box" ref={box} />
      )}

      <p className="hint chart-note">{t("chart.midPriceNote")}</p>
    </section>
  );
}
