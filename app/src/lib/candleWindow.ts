export type OhlcBar = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

/**
 * Keep a labelled timeframe exact by narrowing its visible history instead of widening
 * its buckets. For 1S this returns at most 600 actual one-second buckets: ten minutes.
 * The latest candle before the window is retained only as the price carried into its
 * first empty second.
 */
export function trailingCandleWindow<T extends OhlcBar>(
  candles: T[],
  untilSeconds: number,
  bucketSeconds: number,
  maxCandles = 600
): OhlcBar[] {
  if (candles.length === 0 || bucketSeconds <= 0 || maxCandles <= 0) return [];
  const end = Math.floor(untilSeconds / bucketSeconds) * bucketSeconds;
  const start = end - (maxCandles - 1) * bucketSeconds;
  const sorted = [...candles].sort((a, b) => a.time - b.time);
  let prior: T | undefined;
  const visible: OhlcBar[] = [];
  for (const candle of sorted) {
    if (candle.time < start) prior = candle;
    else if (candle.time <= end) visible.push(candle);
  }
  if (prior && (visible.length === 0 || visible[0].time > start)) {
    visible.unshift({
      time: start,
      open: prior.close,
      high: prior.close,
      low: prior.close,
      close: prior.close,
    });
  }

  const out: OhlcBar[] = [];
  let idx = 0;
  let last = visible[0]?.open;
  if (last === undefined) return out;
  for (let time = visible[0].time; time <= end; time += bucketSeconds) {
    let bucket: OhlcBar | null = null;
    while (idx < visible.length && visible[idx].time < time + bucketSeconds) {
      const candle = visible[idx];
      bucket = bucket
        ? {
            time,
            open: bucket.open,
            high: Math.max(bucket.high, candle.high),
            low: Math.min(bucket.low, candle.low),
            close: candle.close,
          }
        : { ...candle, time };
      idx++;
    }
    if (bucket) {
      out.push(bucket);
      last = bucket.close;
    } else {
      out.push({ time, open: last, high: last, low: last, close: last });
    }
  }
  return out;
}
