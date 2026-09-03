// External links for a token: contract, pool, and the chart aggregators.
//
// ── THE RULE: RENDER ONLY WHAT RESOLVES ───────────────────────────────────────
//
// Dexscreener and GeckoTerminal index a token by its MAINNET address, and a pool link
// needs a pool that has been created. Arc mainnet launches 16 September; until then none
// of those three exist for any token here.
//
// A dead link is worse than a missing one on a launchpad whose stated moat is
// verifiability: a link to a Dexscreener page that 404s reads as "this token was delisted"
// rather than "this chain has not launched". A greyed row of four disabled buttons is the
// same claim in a politer font -- it advertises three things the product cannot do, on
// every token page, for two weeks.
//
// So each entry resolves to a URL or to null, and the row renders the non-null ones. Today
// exactly one resolves (the verified contract), so the row is a single link and looks
// deliberate. On 16 September, filling in the mainnet host and pool address turns the same
// row into four without touching the component.

import type { Address } from "viem";
import type { MessageKey } from "../i18n";

export type LinkId = "contract" | "pool" | "dexscreener" | "geckoterminal";

// ⚠ labelKey is MessageKey, not string. Typing it as string compiles here and then fails
// at the call site where t() is invoked -- and worse, a typo'd key would only surface as
// a missing translation at runtime. The i18n layer already makes every key checkable; this
// keeps that guarantee across the module boundary.
export type AggregatorLink = { id: LinkId; labelKey: MessageKey; href: string };

/**
 * What the resolvers need. Everything optional except the token: the whole point is that
 * most of this does not exist yet.
 */
export type LinkContext = {
  token: Address;
  /** Explorer base for the CURRENT chain. Always present. */
  explorerUrl: string;
  /**
   * The DEX pair address, once a token has graduated and a pool exists. Undefined
   * pre-graduation -- which is every token today.
   */
  poolAddress?: Address;
  /**
   * Aggregator chain slug, e.g. "arc". ⚠ UNKNOWN until mainnet: neither Dexscreener nor
   * GeckoTerminal has published one for Arc, and guessing it produces a confident 404.
   * Undefined keeps both links unrendered, which is the correct state.
   */
  aggregatorChainSlug?: string;
};

/**
 * Every link that currently resolves, in display order.
 *
 * ⚠ Order is fixed here rather than at the call site so it cannot drift between pages:
 * contract first because it is the one that is always true and the one the trust story
 * rests on.
 */
export function resolveLinks(ctx: LinkContext): AggregatorLink[] {
  const out: AggregatorLink[] = [];

  // Always resolves. The verified contract on the explorer for whatever chain we are on.
  out.push({
    id: "contract",
    labelKey: "token.linkContract",
    href: `${ctx.explorerUrl}/address/${ctx.token}`,
  });

  // Resolves only after graduation, when a pair actually exists.
  if (ctx.poolAddress) {
    out.push({
      id: "pool",
      labelKey: "token.linkPool",
      href: `${ctx.explorerUrl}/address/${ctx.poolAddress}`,
    });
  }

  // Both need a chain slug the aggregators have not published for Arc. Gated on the slug
  // rather than on a date so this starts working the moment the slug is filled in, and
  // cannot start working before.
  if (ctx.aggregatorChainSlug) {
    out.push({
      id: "dexscreener",
      labelKey: "token.linkDexscreener",
      href: `https://dexscreener.com/${ctx.aggregatorChainSlug}/${ctx.poolAddress ?? ctx.token}`,
    });
    out.push({
      id: "geckoterminal",
      labelKey: "token.linkGeckoterminal",
      href: `https://www.geckoterminal.com/${ctx.aggregatorChainSlug}/pools/${ctx.poolAddress ?? ctx.token}`,
    });
  }

  return out;
}

/**
 * ⚠ NOT SET, DELIBERATELY. Fill in on 16 September once the aggregators publish an Arc
 * slug -- and verify a real token page loads at the constructed URL before shipping it.
 * A wrong slug produces a link that 404s, which is the exact failure this module exists
 * to avoid.
 */
export const AGGREGATOR_CHAIN_SLUG: string | undefined = undefined;
