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
import { shortAddress, safeText, approxBigIntFromIndexer } from "../../lib/format";
import { useT } from "../../i18n";
import { arc } from "../../chain";

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
  const { t, fmt } = useT();
  const symbol = safeText(data.symbol, 16) || "tokens";

  const configured = !!SUPABASE_URL && !!SUPABASE_ANON_KEY;

  const { data: trades, isError, isLoading } = useQuery({
    queryKey: ["trades", token],
    refetchInterval: 10_000,
    enabled: configured,
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
      <h2 className="card-title">{t("trades.title")}</h2>

      {/* TRAP 19: the indexer is a speed layer, not a trust layer. When it is
          unreachable the page says so and stays readable -- everything above this
          section is read from the chain and is unaffected. */}
      {/* A5. Two distinct failures, said differently. "Unreachable" means the indexer
          exists and did not answer; "not configured" means this build has no indexer
          credentials at all. The first version rendered an EMPTY section for the second
          case -- silent, and indistinguishable from "no trades yet". */}
      {!configured && (
        <p className="hint">{t("trades.indexerNotConfigured", { chain: arc.name })}</p>
      )}
      {configured && isError && (
        <p className="hint">{t("trades.indexerDown", { chain: arc.name })}</p>
      )}

      {configured && isLoading && !trades && <p className="hint">{t("trades.loading")}</p>}

      {trades && trades.length === 0 && <p className="hint">{t("trades.none")}</p>}

      {trades && trades.length > 0 && (
        // ⚠ THE WRAPPER IS THE FIX, NOT THE `overflow-x` PROPERTY ALONE. `.card` here
        // sits in `.token-page`'s default (stretched) flex column, so the wrapper gets a
        // real bounded width from its ancestor -- unlike `.watch-fail`, which needed
        // `align-self: stretch` because ITS ancestor used `align-items: flex-end`. Six
        // columns of mono figures plus a trader address had no containment at all before
        // this: not even an ineffective `overflow-x: auto`, so a wide row forced the
        // whole page wider on a phone instead of scrolling in place.
        <div className="trades-wrap">
          <table className="trades">
            <tbody>
              {trades.map((row) => (
                <tr key={row.tx_hash}>
                  <td className={row.is_buy ? "buy" : "sell"}>{row.is_buy ? t("trade.buy") : t("trade.sell")}</td>
                  <td className="mono small">{shortAddress(row.trader_address)}</td>
                  <td>{fmt.usdcCompact(approxBigIntFromIndexer(row.usdc_amount))} USDC</td>
                  <td className="hint">
                    {/* approx*: token_amount arrives from PostgREST as a JSON number and
                        has ALREADY lost its low digits (trap 21). Fine for a feed, never
                        for anything acted on. */}
                    ~{fmt.tokenCompact(approxBigIntFromIndexer(row.token_amount))} {symbol}
                  </td>
                  <td className="hint">{fmt.age(row.created_at)}</td>
                  <td>
                    <a
                      href={`${EXPLORER_URL}/tx/${row.tx_hash}`}
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
        </div>
      )}
    </section>
  );
}
