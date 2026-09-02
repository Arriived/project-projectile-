// The token page — the unit of navigation. `/t/:address`, deep-linkable.
//
// Section order is the spec's, and the order is the trust argument:
//   1 identity   2 your position   3 price and progress
//   4 trade      5 trust panel     6 trades feed
//
// "Your position" sits above price deliberately: it is the section that prevents the
// worst failure on this chain, where a buy succeeds, MetaMask shows nothing, and the
// user's gas-and-settlement balance is the only thing visibly changed (rule 9).

import { lazy, Suspense } from "react";
import { useParams, Link } from "react-router-dom";
import { isAddress, getAddress } from "viem";
import { useCurve } from "../hooks/useCurve";
import { useCandles } from "../hooks/useCandles";
import { LAUNCH_TOKEN_DECIMALS, USDC_ERC20_DECIMALS } from "../chain";
import { TokenIdentity } from "../components/token/TokenIdentity";
import { YourPosition } from "../components/token/YourPosition";
import { PriceAndProgress } from "../components/token/PriceAndProgress";
import { TradePanel } from "../components/token/TradePanel";
import { TrustPanel } from "../components/token/TrustPanel";
import { TradesFeed } from "../components/token/TradesFeed";

// Lazily loaded: lightweight-charts is the single biggest dependency in the app and
// nothing outside this route uses it. Loading it on the list page would tax every
// visitor for a component most of them never reach.
const PriceChart = lazy(() =>
  import("../components/token/PriceChart").then((m) => ({ default: m.PriceChart }))
);
import { tradeGate } from "../lib/curve";
import { useT } from "../i18n";

export function TokenPage() {
  const { t } = useT();
  const { address: raw } = useParams<{ address: string }>();

  // A malformed address in the URL is a user-visible state, not a crash. Checksummed so
  // the page and every read use one canonical form.
  if (!raw || !isAddress(raw)) {
    return (
      <main className="main">
        <div className="card card-err">
          <strong>{t("token.invalidAddress")}</strong>
          <p className="hint mono">{raw ?? "(none)"}</p>
          <Link to="/" className="btn">
            {t("common.back")}
          </Link>
        </div>
      </main>
    );
  }

  const token = getAddress(raw);
  return <TokenPageInner token={token} key={token} />;
}

function TokenPageInner({ token }: { token: `0x${string}` }) {
  const { t } = useT();
  const data = useCurve(token);

  // The curve mid-price, in USDC per whole token. Same formula the candle view uses, so
  // the flat launch line and the traded series are on ONE definition rather than two that
  // agree until they do not.
  //
  // USDC is 6dp and the token is 18dp, hence the 1e12 rescale. For an UNTRADED curve the
  // current reserves are still the launch reserves, which is what makes the flat line a
  // real price rather than a placeholder.
  const launchPrice =
    data.curve && data.curve.virtualTokenReserves > 0n
      ? (Number(data.curve.virtualUsdcReserves) / Number(data.curve.virtualTokenReserves)) *
        10 ** (LAUNCH_TOKEN_DECIMALS - USDC_ERC20_DECIMALS)
      : undefined;

  const candles = useCandles(
    token,
    launchPrice,
    data.curve ? Number(data.curve.creationTimestamp) : undefined
  );
  const { curve, isLoading, isError } = data;

  if (isLoading && !curve) {
    return (
      <main className="main">
        <div className="card skeleton-card">{t("token.loadingToken")}</div>
      </main>
    );
  }

  // UnknownToken from the factory means this address was never launched here. Saying so
  // is better than an empty page that looks broken.
  if (isError || !curve || curve.token === "0x0000000000000000000000000000000000000000") {
    return (
      <main className="main">
        <div className="card card-err">
          <strong>{t("token.notFoundTitle")}</strong>
          <p className="hint">{t("token.notFoundBody")}</p>
          <p className="mono small">{token}</p>
          <Link to="/" className="btn">
            {t("common.back")}
          </Link>
        </div>
      </main>
    );
  }

  const gate = tradeGate(curve.state);

  return (
    <main className="main token-page">
      {/* 1 — identity. Full address, always visible, never behind a tooltip. */}
      <TokenIdentity token={token} data={data} />

      {/* 2 — your position, high up, for the reason in rule 9. */}
      <YourPosition token={token} data={data} />

      {/* 3 — the chart, above the trade panel, where a trader looks first.
              Mid-price from reserves, never execution price: adjacent buys and sells
              at the same reserve level differ 5.3x because of the snipe tax, and
              charting that draws the fee schedule rather than the market. */}
      <Suspense fallback={<div className="chart-skeleton" aria-hidden />}>
        <PriceChart
          points={candles.points}
          isFlatLaunch={candles.isFlatLaunch}
          isHistoryUnchartable={candles.isHistoryUnchartable}
          isLoading={candles.isLoading}
        />
      </Suspense>

      {/* 3 — price and progress toward the threshold. */}
      <PriceAndProgress data={data} />

      {/* 4 — trade. Closed states explain themselves rather than offering a button
              that reverts. */}
      {gate.canBuy || gate.canSell ? (
        <TradePanel token={token} data={data} />
      ) : (
        <div className="card card-closed">
          <h2 className="card-title">{t("trade.closedTitle")}</h2>
          <p>{gate.reason}</p>
        </div>
      )}

      {/* 5 — trust. Fees per-token, LP recipient, creator disclosure. */}
      <TrustPanel data={data} />

      {/* 6 — trades. Ordered blockNumber then logIndex, never timestamp (trap 13).
              A per-token comment thread is designed to append below here without
              restructuring; it is deliberately not built yet. */}
      <TradesFeed token={token} data={data} />
    </main>
  );
}
