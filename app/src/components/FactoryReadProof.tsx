// Proof that a read against the frozen factory works end to end: chain definition →
// transport → generated ABI → typed decode → render.
//
// These particular values are chosen because they are the ones that have DRIFTED. The
// source defaults in LFX1.sol say launchCooldown = 10 and symbolLockDuration = 5 minutes;
// both were changed by setter on the live deployment and are now 5 and 0. A read proof
// that displayed constants would prove nothing, so it reads the two fields where the
// chain and the source are known to disagree, and says so.

import { useReadContracts } from "wagmi";
import { formatUnits } from "viem";
import { lfx1Abi } from "../abi/lfx1";
import { FACTORY_ADDRESS, EXPLORER_URL } from "../config";
import { USDC_ERC20_DECIMALS } from "../chain";

const factory = { address: FACTORY_ADDRESS, abi: lfx1Abi } as const;

export function FactoryReadProof() {
  const { data, isLoading, isError, error, refetch, isFetching } = useReadContracts({
    contracts: [
      { ...factory, functionName: "owner" },
      { ...factory, functionName: "treasury" },
      { ...factory, functionName: "paused" },
      { ...factory, functionName: "creationFeeUsdc" },
      { ...factory, functionName: "launchCooldown" },
      { ...factory, functionName: "symbolLockDuration" },
      { ...factory, functionName: "router" },
      { ...factory, functionName: "currentEconomicsHash" },
    ],
  });

  if (isLoading) return <div className="card">Reading the factory…</div>;

  if (isError) {
    return (
      <div className="card card-err">
        <strong>Read failed.</strong>
        <p className="mono small">{error?.message.split("\n")[0]}</p>
        <button className="btn" onClick={() => refetch()}>
          Retry
        </button>
      </div>
    );
  }

  const value = <T,>(i: number) =>
    data?.[i]?.status === "success" ? (data[i].result as T) : undefined;

  const owner = value<string>(0);
  const treasury = value<string>(1);
  const paused = value<boolean>(2);
  const creationFee = value<bigint>(3);
  const launchCooldown = value<bigint>(4);
  const symbolLock = value<bigint>(5);
  const router = value<string>(6);
  const economicsHash = value<string>(7);

  return (
    <div className="card">
      <div className="card-head">
        <h2>
          Live read —{" "}
          <a
            href={`${EXPLORER_URL}/address/${FACTORY_ADDRESS}`}
            target="_blank"
            rel="noreferrer"
            className="mono"
          >
            {FACTORY_ADDRESS.slice(0, 10)}…{FACTORY_ADDRESS.slice(-8)}
          </a>
        </h2>
        <button className="btn btn-ghost" onClick={() => refetch()} disabled={isFetching}>
          {isFetching ? "Reading…" : "Re-read"}
        </button>
      </div>

      <dl className="kv">
        <dt>owner</dt>
        <dd className="mono">{owner ?? "—"}</dd>

        <dt>treasury</dt>
        <dd className="mono">{treasury ?? "—"}</dd>

        <dt>router</dt>
        <dd className="mono">{router ?? "—"}</dd>

        <dt>paused</dt>
        <dd>{paused === undefined ? "—" : paused ? "YES" : "no"}</dd>

        <dt>creationFeeUsdc</dt>
        <dd>
          {creationFee === undefined
            ? "—"
            : `${formatUnits(creationFee, USDC_ERC20_DECIMALS)} USDC`}
          <span className="hint"> (raw {creationFee?.toString() ?? "—"}, 6dp)</span>
        </dd>

        <dt>launchCooldown</dt>
        <dd>
          {launchCooldown?.toString() ?? "—"} s
          {launchCooldown !== undefined && launchCooldown !== 10n && (
            <span className="drift"> source default is 10 — set by setter, read the chain</span>
          )}
        </dd>

        <dt>symbolLockDuration</dt>
        <dd>
          {symbolLock?.toString() ?? "—"} s
          {symbolLock === 0n && (
            <span className="drift"> 0 = lock disabled; symbols are fully duplicable</span>
          )}
        </dd>

        <dt>currentEconomicsHash</dt>
        <dd className="mono small">{economicsHash ?? "—"}</dd>
      </dl>

      <p className="footnote">
        Read through multicall3, batched by wagmi. The economics hash is shown here as
        proof of decode only — it must be re-fetched in the same action that sends
        <code> createToken</code>, never cached (rule 5).
      </p>
    </div>
  );
}
