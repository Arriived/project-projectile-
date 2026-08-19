// One-off backfill for a token that was skipped by an earlier, buggy checkpoint —
// re-runs the exact same indexing logic the live watcher uses, just targeted at one
// known address instead of scanning a block range.
//
// Usage: node src/backfillToken.js 0xTokenAddressHere

const { upsertTokenFromChain } = require("./index");

async function main() {
  const tokenAddress = process.argv[2];
  if (!tokenAddress) {
    console.error("Usage: node src/backfillToken.js 0xTokenAddressHere");
    process.exit(1);
  }

  console.log(`Backfilling ${tokenAddress}...`);
  await upsertTokenFromChain(tokenAddress);
  console.log("✅ Done. Check the tokens table in Supabase.");
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Backfill failed:", err.message);
  process.exit(1);
});
