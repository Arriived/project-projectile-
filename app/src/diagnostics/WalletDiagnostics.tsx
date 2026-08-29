// Wallet diagnostics — reports FACTS from the real wallet. Fixes nothing.
//
// WHY THIS EXISTS. Three rounds of fixes passed against an injected test double and
// failed against real MetaMask. The double kept answering calls MetaMask does not answer
// (it emitted `chainChanged` when MetaMask may not; it exposed a live connector when
// wagmi may hold a stripped one). A test double that is wrong in the same direction as
// the bug is worse than no test at all, because it manufactures confidence.
//
// So this page asks the real wallet directly and prints raw answers. It changes no state
// except when a button is pressed, and it never writes to the app's own chain guard.
//
// Open with:  http://localhost:5173/?diag

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAccount, useConfig, useConnect, useDisconnect, useChainId } from "wagmi";
import { arc } from "../chain";

type Row = { label: string; value: string; note?: string };

type Eip6963 = {
  info: { uuid: string; name: string; rdns: string; icon?: string };
  provider: { request: (a: { method: string }) => Promise<unknown> };
};

function fmt(v: unknown): string {
  if (v === undefined) return "undefined";
  if (v === null) return "null";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function WalletDiagnostics() {
  const config = useConfig();
  const { address, chainId: accountChainId, connector, status } = useAccount();
  const configChainId = useChainId();
  const { connect, connectors } = useConnect();
  const { disconnect } = useDisconnect();

  const [announced, setAnnounced] = useState<Eip6963[]>([]);
  const [probes, setProbes] = useState<Row[]>([]);
  const [switchAttempt, setSwitchAttempt] = useState<string>("(not attempted)");
  const [running, setRunning] = useState(false);

  // ── Q3: is window.ethereum contested? ──────────────────────────────────────
  // EIP-6963 is how multiple wallets announce themselves without fighting over
  // window.ethereum. If more than one answers, the generic injected() connector may be
  // talking to whichever extension won the race, not necessarily MetaMask.
  useEffect(() => {
    const found: Eip6963[] = [];
    const onAnnounce = (e: Event) => {
      const detail = (e as CustomEvent).detail as Eip6963;
      if (detail?.info && !found.some((f) => f.info.uuid === detail.info.uuid)) {
        found.push(detail);
        setAnnounced([...found]);
      }
    };
    window.addEventListener("eip6963:announceProvider", onAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    return () => window.removeEventListener("eip6963:announceProvider", onAnnounce);
  }, []);

  const windowEthereum = useMemo(() => {
    const eth = (window as unknown as { ethereum?: Record<string, unknown> }).ethereum;
    if (!eth) return null;
    const flags = [
      "isMetaMask",
      "isRabby",
      "isBraveWallet",
      "isCoinbaseWallet",
      "isPhantom",
      "isTrust",
      "isOkxWallet",
    ].filter((f) => eth[f]);
    const nested = Array.isArray(eth.providers)
      ? (eth.providers as Record<string, unknown>[]).map(
          (p, i) =>
            `[${i}] ${["isMetaMask", "isRabby", "isBraveWallet", "isCoinbaseWallet"]
              .filter((f) => p[f])
              .join(",") || "unknown"}`
        )
      : null;
    return { flags, nested, hasRequest: typeof eth.request === "function" };
  }, []);

  // ── Q1 + Q2: what does wagmi actually hold, and can it be called? ──────────
  const runProbes = useCallback(async () => {
    setRunning(true);
    const out: Row[] = [];

    out.push({ label: "account status", value: fmt(status) });
    out.push({ label: "address", value: fmt(address) });
    out.push({
      label: "useAccount().chainId",
      value: fmt(accountChainId),
      note: "undefined here is why the UI says 'Network unconfirmed' rather than 'Wrong network'",
    });
    out.push({
      label: "useChainId() [config state]",
      value: fmt(configChainId),
      note: "always the configured chain; not the wallet's. Kept only to show the difference",
    });

    // THE CENTRAL QUESTION. wagmi persists connections with the connector reduced to
    // { id, name, type, uid } -- methods stripped. If what we hold is that shell, both
    // getProvider() and switchChain() are missing, which would explain the switch error
    // AND the failed probe with one cause.
    out.push({ label: "connector.id", value: fmt(connector?.id) });
    out.push({ label: "connector.name", value: fmt(connector?.name) });
    out.push({ label: "connector.type", value: fmt(connector?.type) });
    out.push({ label: "connector.uid", value: fmt(connector?.uid) });
    out.push({
      label: "typeof connector.getProvider",
      value: typeof connector?.getProvider,
      note: "'undefined' means we are holding a stripped persistence shell, not a live connector",
    });
    out.push({
      label: "typeof connector.switchChain",
      value: typeof (connector as unknown as { switchChain?: unknown })?.switchChain,
      note: "'undefined' produces: \"Injected\" does not support programmatic chain switching",
    });

    // The live connector instances the config was built with. These always have methods.
    const live = config.connectors.find((c) => c.uid === connector?.uid);
    out.push({
      label: "matching LIVE connector found in config.connectors",
      value: live ? `yes (${live.name})` : "no",
      note: "if the held connector is stripped but a live one matches by uid, that is the fix",
    });
    out.push({
      label: "config.connectors (all)",
      value: config.connectors.map((c) => `${c.name}[${c.id}/${c.type}]`).join(", ") || "(none)",
    });

    // ── eth_chainId down four independent paths ──────────────────────────────
    const ask = async (label: string, fn: () => Promise<unknown>, note?: string) => {
      try {
        const v = await fn();
        out.push({
          label,
          value: typeof v === "string" ? `${v} (= ${Number.parseInt(v, 16)})` : fmt(v),
          note,
        });
      } catch (e) {
        out.push({ label, value: `THREW: ${(e as Error).message?.split("\n")[0]}`, note });
      }
    };

    await ask(
      "eth_chainId via useAccount().connector",
      async () => {
        const p = (await connector?.getProvider()) as { request: (a: { method: string }) => Promise<unknown> };
        return p.request({ method: "eth_chainId" });
      },
      "this is the path the app's guard uses today"
    );

    await ask("eth_chainId via LIVE connector from config", async () => {
      if (!live) throw new Error("no live connector matched by uid");
      const p = (await live.getProvider()) as { request: (a: { method: string }) => Promise<unknown> };
      return p.request({ method: "eth_chainId" });
    });

    await ask("eth_chainId via window.ethereum", async () => {
      const eth = (window as unknown as { ethereum?: { request: (a: { method: string }) => Promise<unknown> } })
        .ethereum;
      if (!eth) throw new Error("window.ethereum absent");
      return eth.request({ method: "eth_chainId" });
    });

    for (const p of announced) {
      await ask(`eth_chainId via EIP-6963 "${p.info.name}"`, () =>
        p.provider.request({ method: "eth_chainId" })
      );
    }

    // ── Per-origin permissions ───────────────────────────────────────────────
    // MetaMask supports per-site network selection: with "Selected networks for each
    // site" on, eth_chainId returns the chain permitted to THIS ORIGIN, which can differ
    // from the network shown in the extension's own UI. If that is what is happening,
    // the app is reading the truth and the extension's global UI is the misleading part.
    await ask(
      "wallet_getPermissions",
      async () => {
        const p = (await connector?.getProvider()) as {
          request: (a: { method: string }) => Promise<unknown>;
        };
        return p.request({ method: "wallet_getPermissions" });
      },
      "shows what this ORIGIN is permitted, including any per-site chain scoping"
    );

    // ── What wagmi persisted ─────────────────────────────────────────────────
    let persistedChainId: number | undefined;
    try {
      const raw = window.localStorage.getItem("wagmi.store");
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as {
            state?: { chainId?: number; connections?: { value?: [string, { chainId?: number }][] } };
          };
          persistedChainId =
            parsed.state?.connections?.value?.[0]?.[1]?.chainId ?? parsed.state?.chainId;
        } catch {
          /* fall through to the raw dump */
        }
      }
      out.push({
        label: "persisted chainId (localStorage wagmi.store)",
        value: fmt(persistedChainId),
        note: "this is what rehydrates into useAccount().chainId on a fresh load",
      });
      out.push({
        label: "wagmi.store (raw)",
        value: raw ?? "(absent)",
      });
    } catch {
      out.push({ label: "wagmi.store", value: "(unreadable)" });
    }

    // ── The verdict that decides this ────────────────────────────────────────
    // The guard's green state requires a LIVE probe returning Arc; a persisted chainId
    // cannot produce it alone (proved against the pure resolver). So if the UI is green
    // while the extension shows another network, the provider itself is reporting Arc.
    const liveRow = out.find((r) => r.label === "eth_chainId via useAccount().connector");
    const liveSaysArc = liveRow?.value.includes(String(arc.id));
    out.push({
      label: "VERDICT",
      value: liveSaysArc
        ? "The BOUND PROVIDER itself reports Arc. This is not stale app state — the wallet is answering Arc for this origin."
        : "The bound provider does NOT report Arc; if the UI is green, that is an app bug.",
      note: liveSaysArc
        ? "Most likely MetaMask per-site network selection: this origin is permitted Arc while the extension's global UI shows another network. Check wallet_getPermissions above."
        : "Report this — it contradicts the resolver, which cannot go green without a live Arc reading.",
    });

    setProbes(out);
    setRunning(false);
  }, [address, accountChainId, configChainId, connector, config, announced, status]);

  const clearPersisted = () => {
    try {
      for (const k of Object.keys(window.localStorage)) {
        if (k.startsWith("wagmi")) window.localStorage.removeItem(k);
      }
      window.location.reload();
    } catch {
      setSwitchAttempt("could not clear localStorage");
    }
  };

  const trySwitch = async () => {
    setSwitchAttempt("attempting…");
    try {
      const live = config.connectors.find((c) => c.uid === connector?.uid);
      if (!live) {
        setSwitchAttempt("no live connector matched by uid — cannot attempt");
        return;
      }
      if (typeof live.switchChain !== "function") {
        setSwitchAttempt(`live connector ${live.name} has NO switchChain method`);
        return;
      }
      await live.switchChain({ chainId: arc.id });
      setSwitchAttempt("switchChain via LIVE connector RESOLVED");
    } catch (e) {
      const err = e as Error & { code?: number };
      setSwitchAttempt(`THREW: ${err.name} / code ${err.code} / ${err.message?.split("\n")[0]}`);
    }
  };

  const report = useMemo(() => {
    const lines = [
      "=== BALLISTA WALLET DIAGNOSTIC ===",
      `time: ${new Date().toISOString()}`,
      "",
      "-- EIP-6963 announced providers --",
      ...(announced.length
        ? announced.map((p) => `  ${p.info.name}  (rdns ${p.info.rdns})`)
        : ["  (none announced)"]),
      "",
      "-- window.ethereum --",
      windowEthereum
        ? `  flags: ${windowEthereum.flags.join(",") || "(none)"}\n  nested providers: ${
            windowEthereum.nested ? windowEthereum.nested.join(" | ") : "(no .providers array)"
          }\n  has request(): ${windowEthereum.hasRequest}`
        : "  (window.ethereum absent)",
      "",
      "-- probes --",
      ...probes.map((r) => `  ${r.label}: ${r.value}`),
      "",
      `-- switch attempt --`,
      `  ${switchAttempt}`,
    ];
    return lines.join("\n");
  }, [announced, windowEthereum, probes, switchAttempt]);

  return (
    <main className="main">
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Wallet diagnostics</h2>
        <p className="hint">
          Reports what the real wallet answers. Changes nothing unless you press a button.
        </p>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "14px 0" }}>
          {connectors.map((c) => (
            <button key={c.uid} className="btn" onClick={() => connect({ connector: c })}>
              Connect via {c.name}
            </button>
          ))}
          <button className="btn btn-ghost" onClick={() => disconnect()}>
            Disconnect
          </button>
          <button className="btn" onClick={runProbes} disabled={running}>
            {running ? "Running…" : "Run probes"}
          </button>
          <button className="btn btn-warn" onClick={trySwitch}>
            Try switch via live connector
          </button>
          <button className="btn btn-ghost" onClick={clearPersisted}>
            Clear persisted wagmi state + reload
          </button>
        </div>

        <h3 style={{ fontSize: 14 }}>EIP-6963 announced providers ({announced.length})</h3>
        <dl className="kv">
          {announced.length === 0 && <dd>(none announced)</dd>}
          {announced.map((p) => (
            <>
              <dt key={p.info.uuid}>{p.info.name}</dt>
              <dd className="mono small">{p.info.rdns}</dd>
            </>
          ))}
        </dl>

        <h3 style={{ fontSize: 14 }}>window.ethereum</h3>
        <dl className="kv">
          <dt>flags</dt>
          <dd className="mono small">{windowEthereum?.flags.join(", ") || "(none / absent)"}</dd>
          <dt>.providers[]</dt>
          <dd className="mono small">
            {windowEthereum?.nested ? windowEthereum.nested.join(" | ") : "(no providers array)"}
          </dd>
        </dl>

        {probes.length > 0 && (
          <>
            <h3 style={{ fontSize: 14 }}>Probes</h3>
            <dl className="kv">
              {probes.map((r, i) => (
                <>
                  <dt key={`d${i}`}>{r.label}</dt>
                  <dd key={`v${i}`}>
                    <span className="mono small">{r.value}</span>
                    {r.note && <div className="hint">{r.note}</div>}
                  </dd>
                </>
              ))}
            </dl>
          </>
        )}

        <h3 style={{ fontSize: 14 }}>Switch attempt</h3>
        <p className="mono small">{switchAttempt}</p>

        <h3 style={{ fontSize: 14 }}>Copy this back</h3>
        <textarea
          readOnly
          value={report}
          onFocus={(e) => e.currentTarget.select()}
          style={{
            width: "100%",
            minHeight: 220,
            background: "#0b0d10",
            color: "#e6eaef",
            border: "1px solid #262d36",
            borderRadius: 8,
            padding: 10,
            fontFamily: "ui-monospace, Menlo, Consolas, monospace",
            fontSize: 12,
          }}
        />
      </div>
    </main>
  );
}
