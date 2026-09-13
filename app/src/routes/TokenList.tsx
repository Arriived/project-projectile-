// The list page, at /.
//
// Two sections, GRADUATED ABOVE LIVE. That ordering is doing work: graduated tokens are
// evidence the mechanism completes, so they sit above the noise. The section stays visible
// at zero -- an empty "Graduated 0" with its one-line explanation is launch-day state and
// teaches a first-time visitor what the product does, so it must not look broken.
//
// No V1/V2 filter. The reference has one because it migrated contract versions; we have
// one frozen contract, and inventing an equivalent would imply a history that does not
// exist.

import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useReadContract } from "wagmi";
import { useT } from "../i18n";
import { arc } from "../chain";
import { lfx1Abi } from "../abi/lfx1";
import { FACTORY_ADDRESS } from "../config";
import { useTokenList } from "../hooks/useTokenList";
import { TokenCard } from "../components/list/TokenCard";
import {
  DEFAULT_SORT,
  DEFAULT_WINDOW,
  WINDOW_AVAILABILITY,
  LIVE_PAGE_SIZE,
  GRADUATED_PAGE_SIZE,
  matchesSearch,
  sortTokens,
  pageSlice,
  pageCount,
  type SortKey,
  type TimeWindow,
} from "../lib/tokenList";

const SORTS: SortKey[] = ["recentBuys", "newest", "oldest", "marketCap", "volume"];
const WINDOWS: TimeWindow[] = ["all", "24h", "7d"];

const SORT_KEY: Record<SortKey, "list.sortRecentBuys" | "list.sortNewest" | "list.sortOldest" | "list.sortMarketCap" | "list.sortVolume"> = {
  recentBuys: "list.sortRecentBuys",
  newest: "list.sortNewest",
  oldest: "list.sortOldest",
  marketCap: "list.sortMarketCap",
  volume: "list.sortVolume",
};
const WINDOW_KEY: Record<TimeWindow, "list.windowAll" | "list.window24h" | "list.window7d"> = {
  all: "list.windowAll",
  "24h": "list.window24h",
  "7d": "list.window7d",
};

export function TokenList() {
  const { t } = useT();
  const { tokens, source, unavailable, scannedFromBlock, isLoading, isError } = useTokenList();

  const [query, setQuery] = useState("");
  // DEFAULT_SORT is recentBuys, set explicitly in lib/tokenList.ts. Not Newest, which
  // ranks by creation and fills the feed with tokens nobody has traded.
  const [sort, setSort] = useState<SortKey>(DEFAULT_SORT);
  const [win, setWin] = useState<TimeWindow>(DEFAULT_WINDOW);
  const [livePage, setLivePage] = useState(1);
  const [gradPage, setGradPage] = useState(1);

  // CURVE_TOKEN_SUPPLY from the contract, never hardcoded -- the 807M/193M split is
  // load-bearing for the flash-loan bound (CLAUDE.md §1.2).
  const { data: curveSupply } = useReadContract({
    address: FACTORY_ADDRESS,
    abi: lfx1Abi,
    chainId: arc.id,
    functionName: "CURVE_TOKEN_SUPPLY",
  });
  const supply = curveSupply as bigint | undefined;

  const filtered = useMemo(() => tokens.filter((x) => matchesSearch(x, query)), [tokens, query]);
  const graduated = useMemo(() => filtered.filter((x) => x.graduated), [filtered]);
  const live = useMemo(
    () => sortTokens(filtered.filter((x) => !x.graduated), sort, supply),
    [filtered, sort, supply]
  );

  const degraded = source === "chain";

  if (isError) {
    return (
      <main className="main list">
        <div className="card card-err" role="alert">
          <strong>{t("list.unavailableTitle")}</strong>
          <p className="hint">{t("list.unavailableBody")}</p>
        </div>
      </main>
    );
  }

  return (
    <main className="main list">
      <div className="list-search">
        <input
          className="list-input"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setLivePage(1);
            setGradPage(1);
          }}
          placeholder={t("list.searchPlaceholder")}
          aria-label={t("list.searchPlaceholder")}
        />
        <Link to="/create" className="btn btn-primary">
          {t("list.create")}
        </Link>
      </div>

      {/* Trap 19: degraded, never blank, and it NAMES what is missing rather than
          rendering zeroes. A zero market cap is a claim; "unavailable" is the truth. */}
      {degraded && (
        <div className="banner-inline">
          <strong>{t("list.degradedTitle", { chain: arc.name })}</strong>
          <div className="hint">{t("list.degradedFields", { fields: unavailable.join(", ") })}</div>
          {scannedFromBlock !== undefined && (
            <div className="hint">{t("list.degradedRange", { blocks: "36,000" })}</div>
          )}
        </div>
      )}

      {/* GRADUATED — above live, and kept at zero.

          ⚠ THE COUNT AND THE EMPTY LINE ARE BOTH CLAIMS, AND NEITHER IS TRUE WHILE LOADING.
          This section rendered "0" and "None yet — the first curve to reach its threshold
          appears here" unconditionally, while Explore below correctly showed skeletons. On
          a cold load, and for the ~15 seconds the chain fallback takes when the indexer is
          unreachable, the page stated as fact something it had not yet been told.

          That is the single most repeated trap in this project: an empty list and a failed
          query look identical, and launch day legitimately looks empty. The count is
          suppressed until the data has actually arrived rather than defaulted to zero --
          a dash is honestly "not known yet"; a 0 is an assertion. */}
      <section className="list-section">
        <div className="list-head">
          <h2 className="list-h">
            {t("list.graduatedHeading")}{" "}
            <span className="list-count">{isLoading ? "—" : graduated.length}</span>
          </h2>
        </div>

        {isLoading ? (
          <div className="tgrid">
            {/* Matches Explore's treatment, so the two sections cannot disagree about
                whether the page is still loading. */}
            {Array.from({ length: 2 }).map((_, i) => (
              <div className="tcard tcard-skel" key={i} aria-hidden />
            ))}
          </div>
        ) : graduated.length === 0 ? (
          <p className="hint list-empty">{t("list.graduatedEmpty")}</p>
        ) : (
          <>
            <div className="tgrid">
              {pageSlice(graduated, gradPage, GRADUATED_PAGE_SIZE).map((tk) => (
                <TokenCard key={tk.address} token={tk} curveSupply={supply} degraded={degraded} />
              ))}
            </div>
            <Pager
              page={gradPage}
              pages={pageCount(graduated.length, GRADUATED_PAGE_SIZE)}
              onPage={setGradPage}
            />
          </>
        )}
      </section>

      {/* EXPLORE */}
      <section className="list-section">
        <div className="list-head">
          <h2 className="list-h">
            {t("list.exploreHeading")}{" "}
            {/* ⚠ SAME CLAIM AS THE GRADUATED COUNT. The grid below already showed skeletons
                while loading, but this heading still read "Explore 0" -- so the page was
                simultaneously saying "still loading" and "there are none". A dash says the
                one true thing: not known yet. */}
            <span className="list-count">{isLoading ? "—" : live.length}</span>
          </h2>
        </div>

        <div className="list-controls">
          <div className="seg">
            {SORTS.map((s) => (
              <button
                key={s}
                className={`seg-btn ${sort === s ? "on" : ""}`}
                onClick={() => {
                  setSort(s);
                  setLivePage(1);
                }}
              >
                {t(SORT_KEY[s])}
              </button>
            ))}
          </div>

          {/* 24h and 7d are HIDDEN, not rendered greyed out. A permanently-disabled
              button earns no place on a phone-width control -- the view only aggregates
              volume_1h_usdc, so there is nothing to switch to yet. If the indexer ever
              adds real 24h/7d windows, drop this filter: WINDOW_AVAILABILITY already
              controls both which buttons render here and which the query can serve, so
              flipping a window to `true` there is the only change this needs. */}
          <div className="seg">
            {WINDOWS.filter((w) => WINDOW_AVAILABILITY[w]).map((w) => (
              <button
                key={w}
                className={`seg-btn ${win === w ? "on" : ""}`}
                onClick={() => setWin(w)}
              >
                {t(WINDOW_KEY[w])}
              </button>
            ))}
          </div>
        </div>

        {sort === "volume" && <p className="hint list-note">{t("list.volumeIs1h")}</p>}

        {isLoading ? (
          <div className="tgrid">
            {/* Skeletons at the card's real dimensions, so the layout does not jump. */}
            {Array.from({ length: 4 }).map((_, i) => (
              <div className="tcard tcard-skel" key={i} aria-hidden />
            ))}
          </div>
        ) : live.length === 0 ? (
          query ? (
            <p className="hint list-empty">
              {t("list.noMatches", { query })}{" "}
              <button className="btn btn-tiny" onClick={() => setQuery("")}>
                {t("list.clearSearch")}
              </button>
            </p>
          ) : (
            // Launch day looks exactly like this and must not look broken.
            <p className="hint list-empty">
              {t("list.noTokens")} <Link to="/create">{t("list.noTokensCta")}</Link>
            </p>
          )
        ) : (
          <>
            <div className="tgrid">
              {pageSlice(live, livePage, LIVE_PAGE_SIZE).map((tk) => (
                <TokenCard key={tk.address} token={tk} curveSupply={supply} degraded={degraded} />
              ))}
            </div>
            <Pager page={livePage} pages={pageCount(live.length, LIVE_PAGE_SIZE)} onPage={setLivePage} />
          </>
        )}
      </section>
    </main>
  );
}

/** Numbered pages, not infinite scroll. Simpler to build and simpler to reason about. */
function Pager({ page, pages, onPage }: { page: number; pages: number; onPage: (n: number) => void }) {
  const { t } = useT();
  if (pages <= 1) return null;
  return (
    <nav className="pager" aria-label={t("list.page", { n: page })}>
      <button className="btn btn-tiny" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        {t("list.prev")}
      </button>
      {Array.from({ length: pages }, (_, i) => i + 1).map((n) => (
        <button
          key={n}
          className={`btn btn-tiny ${n === page ? "on" : ""}`}
          aria-current={n === page ? "page" : undefined}
          onClick={() => onPage(n)}
        >
          {n}
        </button>
      ))}
      <button className="btn btn-tiny" disabled={page >= pages} onClick={() => onPage(page + 1)}>
        {t("list.next")}
      </button>
    </nav>
  );
}
