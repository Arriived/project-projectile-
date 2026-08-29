// Everything the token page needs about one curve, read FROM THE CHAIN.
//
// Not from the indexer. Trap 21: PostgREST serialises uint256 reserves as JSON numbers,
// so they arrive past MAX_SAFE_INTEGER already truncated -- measured at a 30,224,021,407
// wei discrepancy on a live token -- and `BigInt()` swallows it without throwing because
// the value is already a whole number by the time JS sees it. Anything a user acts on
// comes from here. The indexer is a speed layer for discovery only (trap 19).

import { useReadContracts } from "wagmi";
import type { Address } from "viem";
import { lfx1Abi } from "../abi/lfx1";
import { lfx1TokenAbi } from "../abi/lfx1Token";
import { FACTORY_ADDRESS } from "../config";
import { arc } from "../chain";

/** The `curves(address)` tuple, named. Field order mirrors LFX1.sol exactly. */
export type Curve = {
  token: Address;
  creator: Address;
  virtualTokenReserves: bigint;
  virtualUsdcReserves: bigint;
  realUsdcReserves: bigint;
  tokenReserves: bigint;
  state: number;
  buyFeeBps: number;
  sellFeeBps: number;
  creatorBuyFeeBps: number;
  creatorSellFeeBps: number;
  graduationThresholdUsdc: bigint;
  creationBlock: bigint;
  creationTimestamp: bigint;
  snipeTaxTableVersion: number;
  snipeTaxTreasuryBps: number;
  maxCreatorLaunchBps: number;
  creatorLaunchWindow: number;
  lpRecipient: Address;
  poolBoostEnabled: boolean;
  poolBoost: bigint;
  creatorLaunchPurchased: bigint;
};

/**
 * viem returns a Solidity struct as an OBJECT WITH NAMED FIELDS, not a positional array.
 *
 * Verified against the live contract rather than assumed: `Array.isArray(result)` is
 * false, `result[2]` is `undefined`, and `result.virtualTokenReserves` is the value. The
 * first version of this function indexed positionally, so every field came back
 * undefined -- and the failure surfaced two layers away as
 * "Cannot mix BigInt and other types" when `undefined * totalSupply` was evaluated in the
 * market-cap calculation. A shape assumption, failing far from where it was made.
 *
 * Only the small integers are normalised: uint8/uint16/uint32 arrive as `number` already,
 * but going through Number() makes the intent explicit and survives a future ABI change
 * that widens one of them.
 */
type RawCurve = Record<string, unknown>;

function toCurve(t: RawCurve): Curve {
  return {
    token: t.token as Address,
    creator: t.creator as Address,
    virtualTokenReserves: t.virtualTokenReserves as bigint,
    virtualUsdcReserves: t.virtualUsdcReserves as bigint,
    realUsdcReserves: t.realUsdcReserves as bigint,
    tokenReserves: t.tokenReserves as bigint,
    state: Number(t.state),
    buyFeeBps: Number(t.buyFeeBps),
    sellFeeBps: Number(t.sellFeeBps),
    creatorBuyFeeBps: Number(t.creatorBuyFeeBps),
    creatorSellFeeBps: Number(t.creatorSellFeeBps),
    graduationThresholdUsdc: t.graduationThresholdUsdc as bigint,
    creationBlock: t.creationBlock as bigint,
    creationTimestamp: t.creationTimestamp as bigint,
    snipeTaxTableVersion: Number(t.snipeTaxTableVersion),
    snipeTaxTreasuryBps: Number(t.snipeTaxTreasuryBps),
    maxCreatorLaunchBps: Number(t.maxCreatorLaunchBps),
    creatorLaunchWindow: Number(t.creatorLaunchWindow),
    lpRecipient: t.lpRecipient as Address,
    poolBoostEnabled: t.poolBoostEnabled as boolean,
    poolBoost: t.poolBoost as bigint,
    creatorLaunchPurchased: t.creatorLaunchPurchased as bigint,
  };
}

/**
 * Guards against the same class of failure recurring silently. If a field the page does
 * arithmetic on is missing, say so loudly here rather than letting `undefined * bigint`
 * surface somewhere unrelated.
 */
function curveLooksComplete(c: Curve): boolean {
  return (
    typeof c.virtualUsdcReserves === "bigint" &&
    typeof c.virtualTokenReserves === "bigint" &&
    typeof c.realUsdcReserves === "bigint" &&
    typeof c.graduationThresholdUsdc === "bigint" &&
    typeof c.creatorLaunchPurchased === "bigint"
  );
}

export type TokenData = {
  curve: Curve | undefined;
  name: string | undefined;
  symbol: string | undefined;
  metadataURI: string | undefined;
  totalSupply: bigint | undefined;
  /** From `graduationProgressBps(token)` -- the contract's own figure, not ours. */
  progressBps: number | undefined;
  /** From `currentSnipeTaxBps(token)` -- live, and the authority for what is charged. */
  snipeTaxBps: number | undefined;
  /** CURVE_TOKEN_SUPPLY() -- read, never hardcoded. The 807M/193M split is load-bearing
   *  (CLAUDE.md §1.2) and a constant copied into the frontend would silently diverge. */
  curveSupply: bigint | undefined;
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
};

export function useCurve(token: Address | undefined): TokenData {
  const factory = { address: FACTORY_ADDRESS, abi: lfx1Abi, chainId: arc.id } as const;
  const tokenContract = { address: token as Address, abi: lfx1TokenAbi, chainId: arc.id } as const;

  const { data, isLoading, isError, refetch } = useReadContracts({
    query: { enabled: !!token, refetchInterval: 6_000 },
    contracts: [
      { ...factory, functionName: "curves", args: [token as Address] },
      { ...factory, functionName: "graduationProgressBps", args: [token as Address] },
      { ...factory, functionName: "currentSnipeTaxBps", args: [token as Address] },
      { ...factory, functionName: "CURVE_TOKEN_SUPPLY" },
      { ...tokenContract, functionName: "name" },
      { ...tokenContract, functionName: "symbol" },
      { ...tokenContract, functionName: "metadataURI" },
      { ...tokenContract, functionName: "totalSupply" },
    ],
  });

  const ok = <T,>(i: number): T | undefined =>
    data?.[i]?.status === "success" ? (data[i].result as T) : undefined;

  const raw = ok<RawCurve>(0);
  const curve = raw ? toCurve(raw) : undefined;

  return {
    curve: curve && curveLooksComplete(curve) ? curve : undefined,
    progressBps: ok<bigint>(1) !== undefined ? Number(ok<bigint>(1)) : undefined,
    snipeTaxBps: ok<number>(2) !== undefined ? Number(ok<number>(2)) : undefined,
    curveSupply: ok<bigint>(3),
    name: ok<string>(4),
    symbol: ok<string>(5),
    metadataURI: ok<string>(6),
    totalSupply: ok<bigint>(7),
    isLoading,
    isError,
    refetch,
  };
}

/**
 * Market cap from the curve's own price.
 *
 * Deliberately NOT from `currentPrice()`, which at launch scale evaluates to the integer
 * 2 (trap 3). Derived from the virtual reserves as the contract does, in a wide enough
 * intermediate to keep precision.
 */
export function marketCapUsdc6(curve: Curve, totalSupply: bigint): bigint {
  if (curve.virtualTokenReserves === 0n) return 0n;
  return (curve.virtualUsdcReserves * totalSupply) / curve.virtualTokenReserves;
}
