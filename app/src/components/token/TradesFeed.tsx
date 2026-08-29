// Section 6 — recent trades.
//
// TRAP 13: ordered by blockNumber then logIndex, NEVER by timestamp. Arc produces
// sub-second blocks and the docs are explicit that consecutive blocks may carry the same
// timestamp -- "Do not use block.timestamp for ordering." Timestamp ordering fails
// silently as out-of-order trades, which on a feed showing buys and sells reads as the
// price moving in the wrong direction.
//
// A per-token comment thread is designed to append directly beneath this without
// restructuring the page. Deliberately not built (it needs a table, an auth story and a
// moderation burden), but the seam is here.

import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import { SUPABASE_URL, SUPABASE_ANON_KEY, EXPLORER_URL } from "../../config";
import type { TokenData } from "../../hooks/useCurve";
import {
  fmtToken,
  fmtUsdc,
  shortAddress,
  relativeAge,
  safeText,
  approxBigIntFromIndexer,
} from "../../lib/format";

type TradeRow = {
  tx_hash: string;
  trader_address: string;
  is_buy: boolean;
  usdc_amount: string | number;
  token_amount: string | number;
  block_number: string | number;
  created_at: string;
};

export function TradesFeed({ token, data }: { token: Address; data: TokenData }) {
  const symbol = safeText(data.symbol, 16) || "tokens";

  const { data: trades, isError, isLoading } = useQuery({
    queryKey: ["trades", token],
    refetchInterval: 10_000,
    enabled: !!SUPABASE_URL && !!SUPABASE_ANON_KEY,
    queryFn: async (): Promise<TradeRow[]> => {
      // block_number descending is the canonical ordering key. The indexer does not
      // currently expose log_index; where two trades share a block the order between
      // them is unresolved and this feed does not pretend otherwise.
      const url =
        `${SUPABASE_URL}/rest/v1/trades` +
        `?select=tx_hash,trader_address,is_buy,usdc_amount,token_amount,block_number,created_at` +
        `&token_address=eq.${token}&order=block_number.desc&limit=30`;
      const r = await fetch(url, {
        headers: { apikey: SUPABASE_ANON_KEY!, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
      });
      if (!r.ok) throw new Error(`indexer ${r.status}`);
      return r.json();
    },
  });

  return (
    <section className="card">
      <h2 className="card-title">Recent trades</h2>

      {/* TRAP 19: the indexer is a speed layer, not a trust layer. When it is
          unreachable the page says so and stays readable -- everything above this
          section is read from the chain and is unaffected. */}
      {isError && (
        <p className="hint">
          Trade history is unavailable — the indexer is unreachable. Everything above is
          read from Arc directly and is unaffected.
        </p>
      )}

      {isLoading && !trades && <p className="hint">Loading trades…</p>}

      {trades && trades.length === 0 && <p className="hint">No trades yet.</p>}

      {trades && trades.length > 0 && (
        <table className="trades">
          <tbody>
            {trades.map((t) => (
              <tr key={t.tx_hash}>
                <td className={t.is_buy ? "buy" : "sell"}>{t.is_buy ? "Buy" : "Sell"}</td>
                <td className="mono small">{shortAddress(t.trader_address)}</td>
                <td>{fmtUsdc(approxBigIntFromIndexer(t.usdc_amount))} USDC</td>
                <td className="hint">
                  {/* approx*: token_amount arrives from PostgREST as a JSON number and
                      has ALREADY lost its low digits (trap 21). Fine for a feed, never
                      for anything acted on. */}
                  ~{fmtToken(approxBigIntFromIndexer(t.token_amount))} {symbol}
                </td>
                <td className="hint">{relativeAge(t.created_at)}</td>
                <td>
                  <a
                    href={`${EXPLORER_URL}/tx/${t.tx_hash}`}
                    target="_blank"
                    rel="noreferrer"
                    className="hint"
                  >
                    ↗
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
