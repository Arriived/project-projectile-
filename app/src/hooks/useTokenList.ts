// The list page's data.
//
// ── WHERE EACH FIGURE COMES FROM ──────────────────────────────────────────────
//
// The indexer is a SPEED LAYER, not a trust layer (trap 19). Everything it supplies here
// is a display figure and is named `approx*` (trap 21: PostgREST serialises uint256 as
// JSON numbers, already truncated before JavaScript sees them). Nothing a user acts on
// comes from here -- clicking a card opens the token page, which reads the chain.
//
// ── RECENT BUYS IS DERIVED, NOT A COLUMN ──────────────────────────────────────
//
// Measured against the live view with the anon key before this was written:
// tokens_with_volume has NO last_buy_at, last_buy_block, volume_24h_usdc, volume_7d_usdc
// or total_supply. So the default sort is served by a SECOND query against `trades`,
// deduped by token. Migration 003 would fold it into the view; until then this is honest
// and it works.

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { parseAbiItem } from "viem";
import { SUPABASE_URL, SUPABASE_ANON_KEY, FACTORY_ADDRESS } from "../config";
import { arc } from "../chain";
import { findSymbolCollisions, hasCollision, type ListToken } from "../lib/tokenList";

/** Rows as PostgREST returns them: uint256 columns arrive as JSON numbers. */
type ViewRow = {
  contract_address: string;
  name: string | null;
  symbol: string | null;
  metadata_uri: string | null;
  created_at: string;
  graduated: boolean;
  real_usdc_reserves: number | string;
  virtual_usdc_reserves: number | string;
  virtual_token_reserves: number | string;
  graduation_threshold_usdc: number | string;
  volume_1h_usdc: number | string;
};

/** Trap 21: already truncated by the time we see it. The name carries the warning. */
function approx(v: number | string | null | undefined): bigint {
  if (v === null || v === undefined) return 0n;
  if (typeof v === "string") {
    try {
      return BigInt(v);
    } catch {
      return 0n;
    }
  }
  return Number.isFinite(v) ? BigInt(Math.trunc(v)) : 0n;
}

export type ListSource = "indexer" | "chain";

export type TokenListResult = {
  tokens: ListToken[];
  source: ListSource;
  /** Fields the current source cannot supply. Named, never rendered as zeroes. */
  unavailable: string[];
  /** Set only for the chain fallback: how far back it actually read. */
  scannedFromBlock?: bigint;
  isLoading: boolean;
  isError: boolean;
};

const SUPABASE_READY = !!SUPABASE_URL && !!SUPABASE_ANON_KEY;
const headers = { apikey: SUPABASE_ANON_KEY ?? "", Authorization: `Bearer ${SUPABASE_ANON_KEY}` };

/**
 * How far back the chain fallback reads.
 *
 * Arc's public RPC rejects wide eth_getLogs ranges (-32012 "requested range too large")
 * and then rate-limits the chunked retry, and CLAUDE.md §8 records it stalling 150 seconds
 * at a time under load. A fallback that tried to replay from the deploy block would hang
 * the page on exactly the day the indexer is down.
 *
 * So it is BOUNDED: the most recent MAX_FALLBACK_CHUNKS windows, and the UI says how far
 * back it reached rather than implying the list is complete.
 */
const CHUNK = 9_000n;
const MAX_FALLBACK_CHUNKS = 4n; // 36,000 blocks ≈ 4.8h at Arc's ~0.48s blocks

export function useTokenList(): TokenListResult {
  const client = usePublicClient({ chainId: arc.id });

  // ── primary: the indexer ─────────────────────────────────────────────────────
  const indexer = useQuery({
    queryKey: ["tokenList", "indexer"],
    enabled: SUPABASE_READY,
    refetchInterval: 15_000,
    retry: 1,
    queryFn: async () => {
      const cols =
        "contract_address,name,symbol,metadata_uri,created_at,graduated," +
        "real_usdc_reserves,virtual_usdc_reserves,virtual_token_reserves," +
        "graduation_threshold_usdc,volume_1h_usdc";
      const r = await fetch(`${SUPABASE_URL}/rest/v1/tokens_with_volume?select=${cols}`, { headers });
      if (!r.ok) throw new Error(`indexer ${r.status}`);
      const rows = (await r.json()) as ViewRow[];

      // Recent buys, derived. One extra query, ordered by block -- never by timestamp
      // (trap 13: Arc's sub-second blocks share timestamps).
      const lastBuy = new Map<string, bigint>();
      try {
        const tr = await fetch(
          `${SUPABASE_URL}/rest/v1/trades?select=token_address,block_number&is_buy=eq.true` +
            `&order=block_number.desc&limit=1000`,
          { headers }
        );
        if (tr.ok) {
          for (const row of (await tr.json()) as { token_address: string; block_number: number | string }[]) {
            const k = row.token_address.toLowerCase();
            if (!lastBuy.has(k)) lastBuy.set(k, approx(row.block_number));
          }
        }
      } catch {
        // No buy history means no recency ordering, not a failed page.
      }
      return { rows, lastBuy };
    },
  });

  // ── fallback: the chain (trap 19) ────────────────────────────────────────────
  const chain = useQuery({
    queryKey: ["tokenList", "chain"],
    // Only runs when the indexer is genuinely unusable, so the normal path costs nothing.
    enabled: !!client && (!SUPABASE_READY || indexer.isError),
    staleTime: 60_000,
    retry: 0,
    queryFn: async () => {
      const head = await client!.getBlockNumber();
      const span = CHUNK * MAX_FALLBACK_CHUNKS;
      const from = head > span ? head - span : 0n;

      const created: { address: string; block: bigint }[] = [];
      let successfulChunks = 0;
      for (let start = from; start <= head; start += CHUNK) {
        const end = start + CHUNK - 1n > head ? head : start + CHUNK - 1n;
        try {
          const logs = await client!.getLogs({
            address: FACTORY_ADDRESS,
            event: parseAbiItem(
              "event TokenCreated(address indexed token, address indexed creator, string name, string symbol, string metadataURI)"
            ),
            fromBlock: start,
            toBlock: end,
          });
          successfulChunks++;
          for (const l of logs) {
            created.push({ address: l.args.token as string, block: l.blockNumber ?? 0n });
          }
        } catch {
          // A chunk the RPC refuses is a gap, not a failure. Keep what was read and let
          // the UI say the list is partial.
        }
      }
      if (successfulChunks === 0) {
        throw new Error("RPC refused every token-list log range");
      }
      return { created, from };
    },
  });

  // ── assemble ─────────────────────────────────────────────────────────────────
  if (indexer.data) {
    const { rows, lastBuy } = indexer.data;

    // C3: collisions across the WHOLE LIVE SET, not the current page. A page-scoped scan
    // cannot see a collision on page 4, which would clear tokens that are in fact
    // impersonated -- worse than not checking.
    const liveSymbols = rows.filter((r) => !r.graduated).map((r) => r.symbol ?? "");
    const collided = findSymbolCollisions(liveSymbols);

    const tokens: ListToken[] = rows.map((r) => ({
      address: r.contract_address,
      name: r.name ?? "",
      symbol: r.symbol ?? "",
      metadataUri: r.metadata_uri,
      createdAt: r.created_at,
      graduated: r.graduated,
      approxRealUsdcReserves: approx(r.real_usdc_reserves),
      approxVirtualUsdcReserves: approx(r.virtual_usdc_reserves),
      approxVirtualTokenReserves: approx(r.virtual_token_reserves),
      approxThresholdUsdc: approx(r.graduation_threshold_usdc),
      approxVolume1hUsdc: approx(r.volume_1h_usdc),
      lastBuyBlock: lastBuy.get(r.contract_address.toLowerCase()) ?? null,
      symbolCollision: !r.graduated && hasCollision(r.symbol ?? "", collided),
    }));

    return { tokens, source: "indexer", unavailable: [], isLoading: false, isError: false };
  }

  if (chain.data) {
    // The chain gives identity and existence. It does NOT give reserves, volume, market
    // cap or progress without a per-token call, which would be one round trip per row on
    // an RPC that rate-limits. Those fields are NAMED as unavailable rather than rendered
    // as zeroes -- a zero market cap is a claim; "unavailable" is the truth.
    const tokens: ListToken[] = chain.data.created.map((c) => ({
      address: c.address,
      name: "",
      symbol: "",
      metadataUri: null,
      createdAt: "",
      graduated: false,
      approxRealUsdcReserves: 0n,
      approxVirtualUsdcReserves: 0n,
      approxVirtualTokenReserves: 0n,
      approxThresholdUsdc: 0n,
      approxVolume1hUsdc: 0n,
      lastBuyBlock: null,
      symbolCollision: false,
    }));
    return {
      tokens,
      source: "chain",
      unavailable: ["marketCap", "progress", "volume", "age", "name", "symbol"],
      scannedFromBlock: chain.data.from,
      isLoading: false,
      isError: false,
    };
  }

  return {
    tokens: [],
    source: SUPABASE_READY ? "indexer" : "chain",
    unavailable: [],
    isLoading: indexer.isLoading || chain.isLoading,
    isError: indexer.isError && chain.isError,
  };
}
