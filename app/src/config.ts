// Deployed addresses and the environment surface.
//
// CLAUDE.md §10 is emphatic that nothing here should be hardcoded for mainnet: "anything
// that can fetch-and-verify at runtime should be built that way NOW, not hardcoded and
// swapped later". Testnet values are hardcoded because testnet is what exists; the shape
// below keeps them in one module so mainnet becomes a config change rather than a grep.

import type { Address } from "viem";

/** LFX1 factory. Frozen, verified, 24,033 bytes. Deployed at block 59366694. */
export const FACTORY_ADDRESS: Address = "0xEDeed1F05D34421Add0F59b7340588ab2BbaC04b";

/**
 * USDC. Both the gas token and the settlement asset -- one balance, two views.
 * Source: /arc/references/contract-addresses.
 */
export const USDC_ADDRESS: Address = "0x3600000000000000000000000000000000000000";

/** Block the factory was deployed at, for log queries that need a floor. */
export const FACTORY_DEPLOY_BLOCK = 59366694n;

export const EXPLORER_URL = "https://testnet.arcscan.app";

/**
 * Supabase, read-only, through the ANON key.
 *
 * TRAP 20. Vite inlines every VITE_-prefixed variable into the client bundle. That is
 * correct and intended for the anon key -- it is public by design, and RLS is what
 * protects the data, verified 11/11 with that key against the live project.
 *
 * The service-role key must NEVER be given a VITE_ prefix, referenced here, or imported
 * anywhere under src/. It bypasses RLS entirely. It belongs to the indexer process and
 * lives in indexer/.env, which is gitignored and outside this app's root.
 */
// `import.meta.env` exists only under Vite. This module is also imported by
// scripts/verify-chain.mts running under plain node, where reaching for `.env` on an
// undefined `import.meta.env` throws at module load and takes the whole check down with
// it. The guard keeps the module importable outside a bundler; the values are simply
// undefined there, which is correct -- a node script has no business reading them.
const viteEnv: Record<string, string | undefined> =
  (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};

export const SUPABASE_URL = viteEnv.VITE_SUPABASE_URL;
export const SUPABASE_ANON_KEY = viteEnv.VITE_SUPABASE_ANON_KEY;
