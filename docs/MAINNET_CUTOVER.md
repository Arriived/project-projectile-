**Report only.** Based on `C:\dev\arc-launch` at `a399110`. No files or settings changed. Live cloud settings were not inspected; references to deployed state are dated records.

1. **Before contract deployment: establish the mainnet configuration record.**

   Record the approved RPC endpoints, expected chain ID **5042**, USDC address, explorer browser/API URLs, selected graduation venue, treasury recipient and deployer. Obtain network values from Circle or a Circle-named provider and verify the endpoints against that record.

   Test the indexer RPC for historical `eth_call` and log retrieval: reserves are read at each trade’s block, so a provider supporting current-state reads alone is insufficient. [indexer/src/index.js:398](C:/dev/arc-launch/indexer/src/index.js:398)

   **If missed:** independently configured components can target different chains or contracts; catch-up can fail even while ordinary RPC reads work.

2. **Before deployment: decide Supabase isolation and prepare its schema.**

   **My recommendation is a fresh mainnet Supabase project**, retaining the existing project for testnet. This is a proposed decision, not one I have applied.

   The alternative—sharing the project with `chain_id` filtering—requires implementation across all these reads:

   | Read surface | Current source |
   |---|---|
   | Token list and recent-buy ordering | [useTokenList.ts:97](C:/dev/arc-launch/app/src/hooks/useTokenList.ts:97), [useTokenList.ts:106](C:/dev/arc-launch/app/src/hooks/useTokenList.ts:106) |
   | Token trade feed | [TradesFeed.tsx:46](C:/dev/arc-launch/app/src/components/token/TradesFeed.tsx:46) |
   | Candles and trade-existence probe | [useCandles.ts:257](C:/dev/arc-launch/app/src/hooks/useCandles.ts:257), [useCandles.ts:286](C:/dev/arc-launch/app/src/hooks/useCandles.ts:286) |

   None filters by chain today. Moreover, `tokens` is keyed only by contract address, the base `trades` table has no `chain_id`, and the checkpoint uses a single fixed ID. A shared project therefore needs appropriate schema, query, write and checkpoint isolation—not merely one list filter. [000_base_schema.sql:28](C:/dev/arc-launch/indexer/migrations/000_base_schema.sql:28), [000_base_schema.sql:58](C:/dev/arc-launch/indexer/migrations/000_base_schema.sql:58), [recovery.js:1](C:/dev/arc-launch/indexer/src/recovery.js:1)

   For a fresh project, apply the numbered migrations through `007` using the verified generated bundle, check the schema, then verify public reads and denied writes using the **anon** key. DDL requires SQL-editor/database privileges; the service-role API credential cannot apply it. [indexer/RUNBOOK.md:7](C:/dev/arc-launch/indexer/RUNBOOK.md:7), [APPLY-ALL.sql:1270](C:/dev/arc-launch/indexer/migrations/APPLY-ALL.sql:1270)

   **If missed:** testnet tokens contaminate mainnet lists, feeds and candles; address collisions can overwrite records. Missing grants can also produce an apparently empty launchpad despite populated tables.

3. **Before deployment: fill and validate Hardhat’s mainnet settings.**

   | Setting | Required action |
   |---|---|
   | `ARC_MAINNET_RPC_URL` | Supply the approved endpoint; source defaults to blank. [hardhat.config.js:25](C:/dev/arc-launch/hardhat.config.js:25) |
   | `MAINNET_DEPLOYER_PRIVATE_KEY` | Supply the dedicated mainnet signer; source defaults to blank. [hardhat.config.js:26](C:/dev/arc-launch/hardhat.config.js:26) |
   | `arcMainnet.chainId` | Confirm the endpoint reports the configured `5042`. [hardhat.config.js:133](C:/dev/arc-launch/hardhat.config.js:133) |
   | `ARC_MAINNET_EXPLORER_API` | Supply the verified verification API URL. [hardhat.config.js:173](C:/dev/arc-launch/hardhat.config.js:173) |
   | `ARC_MAINNET_EXPLORER_URL` | Supply the verified browser URL. [hardhat.config.js:174](C:/dev/arc-launch/hardhat.config.js:174) |
   | `ARC_MAINNET_EXPLORER_KEY` | Supply a real key if the chosen verifier requires one; `"empty"` is only the current fallback. [hardhat.config.js:145](C:/dev/arc-launch/hardhat.config.js:145) |

   Confirm the verifier’s API compatibility rather than carrying the testnet Blockscout assumption forward. `MAINNET_RPC_URL` is the **Ethereum fork** setting; it does not configure Arc deployment. [hardhat.config.js:79](C:/dev/arc-launch/hardhat.config.js:79)

   **If missed:** deployment has no usable provider/signer, targets the wrong network, or succeeds while explorer verification cannot run.

4. **Before deployment: prepare every frontend network change; finalize receipt-dependent values afterward.**

   These are the runtime testnet bindings in the deployed `app/` frontend:

   | Current value and source | Mainnet action | What breaks if missed |
   |---|---|---|
   | Factory `0xEDeed1F05D34421Add0F59b7340588ab2BbaC04b` — [config.ts:11](C:/dev/arc-launch/app/src/config.ts:11) | Replace with the final, verified mainnet factory after deployment. | Reads, approvals and writes target the wrong address. |
   | USDC `0x3600000000000000000000000000000000000000` — [config.ts:17](C:/dev/arc-launch/app/src/config.ts:17) | Verify against mainnet and the deployed factory; retain only if confirmed identical. | Balances, allowances and settlement target the wrong asset. |
   | Factory start block `59366694n` — [config.ts:20](C:/dev/arc-launch/app/src/config.ts:20) | Replace with the actual mainnet factory receipt block. | Stale deployment metadata survives. **Currently unused elsewhere in `app/src`**, so changing this does not configure the indexer or fix its start block. |
   | Explorer `https://testnet.arcscan.app` — [config.ts:22](C:/dev/arc-launch/app/src/config.ts:22) | Replace with the verified mainnet browser URL. | Address and transaction links open testnet. |
   | Imported/spread `arcTestnet` — [chain.ts:9](C:/dev/arc-launch/app/src/chain.ts:9), [chain.ts:50](C:/dev/arc-launch/app/src/chain.ts:50) | Replace the complete chain definition, including inherited ID `5042002`, name `Arc Testnet` and `testnet: true`. | Wallet configuration and guards continue targeting testnet; the header labels it testnet. |
   | HTTP `https://rpc.testnet.arc.io` — [chain.ts:58](C:/dev/arc-launch/app/src/chain.ts:58) | Set the approved browser-usable mainnet RPC. | Frontend reads remain on testnet. |
   | WebSocket `wss://rpc.testnet.arc.io` — [chain.ts:59](C:/dev/arc-launch/app/src/chain.ts:59) | Replace with a verified mainnet endpoint, or omit if unsupported. | Chain metadata retains a testnet transport. |
   | Inherited explorer browser/API URLs — [arcTestnet.ts:24](C:/dev/arc-launch/app/node_modules/viem/chains/definitions/arcTestnet.ts:24) | Replace independently of `EXPLORER_URL`. | Wallet/library metadata can still reference testnet despite corrected product links. |
   | Inherited Multicall3 `0xcA11bde05977b3631167028862bE2a173976CA11`, `blockCreated: 0` — [arcTestnet.ts:31](C:/dev/arc-launch/app/node_modules/viem/chains/definitions/arcTestnet.ts:31) | Verify mainnet code and deployment metadata before declaring support; otherwise use a verified non-multicall read path. | Reads using a nonexistent or incorrectly declared deployment fail. |

   The installed `viem` mainnet definition supplies ID/name/native currency but has an **empty HTTP list and no explorer or Multicall3 metadata**. Changing the import alone is insufficient. [arc.ts:3](C:/dev/arc-launch/app/node_modules/viem/chains/definitions/arc.ts:3)

   Also revalidate the existing fee assumptions—20-Gwei floor, 20,000-Gwei ceiling, 1-Gwei tip—and native/USDC decimals `18/6`; these require verification, not automatic replacement. Incorrect values distort affordability or transaction fees. [chain.ts:23](C:/dev/arc-launch/app/src/chain.ts:23), [chain.ts:31](C:/dev/arc-launch/app/src/chain.ts:31), [chain.ts:37](C:/dev/arc-launch/app/src/chain.ts:37), [chain.ts:133](C:/dev/arc-launch/app/src/chain.ts:133)

   Chain-ID hex, wallet targeting and network labels already derive from `arc`; they need verification after this change, not independent hardcoded replacements. [chain.ts:119](C:/dev/arc-launch/app/src/chain.ts:119), [wagmi.ts:47](C:/dev/arc-launch/app/src/wagmi.ts:47), [App.tsx:50](C:/dev/arc-launch/app/src/App.tsx:50)

5. **Before building the mainnet candidate: configure Vercel’s Preview and Production scopes separately.**

   Set/check all five names in **both scopes**, using the selected mainnet database for the mainnet candidate. If other previews must remain testnet, isolate their configuration explicitly.

   | Variable | Required value | What breaks if missed |
   |---|---|---|
   | `VITE_SUPABASE_URL` | Selected mainnet project URL | Reads target testnet or fall back to an incomplete chain list. |
   | `VITE_SUPABASE_ANON_KEY` | Matching project’s anon key | Database reads fail; a mismatched URL/key pair cannot authenticate. |
   | `VITE_WALLETCONNECT_PROJECT_ID` | Valid project ID, checked in each scope | Missing ID removes the connector; invalid ID breaks connection services. |
   | `VITE_PINATA_GATEWAY` | Intended public gateway hostname | Images use the public fallback and may load slowly or fail. |
   | `PINATA_JWT` | Valid server-only upload credential | `/api/sign-upload` returns `503` when absent. |

   Sources: [app/DEPLOY.md:175](C:/dev/arc-launch/app/DEPLOY.md:175), [config.ts:43](C:/dev/arc-launch/app/src/config.ts:43), [wagmi.ts:68](C:/dev/arc-launch/app/src/wagmi.ts:68), [sign-upload.ts:67](C:/dev/arc-launch/app/api/sign-upload.ts:67).

   Keep the service-role key out of Vercel entirely and never prefix the Pinata secret with `VITE_`. Build after setting the values: the browser variables are baked into the bundle. The recorded live domain serves an aliased **Preview** build, so changing Production variables alone does not change that bundle. [app/DEPLOY.md:57](C:/dev/arc-launch/app/DEPLOY.md:57), [HANDOFF.md:102](C:/dev/arc-launch/docs/HANDOFF.md:102)

6. **Deploy the contracts before publishing the mainnet frontend or starting its indexer.**

   Execute the chosen venue’s corrected runbook after its gates pass. For v4, preserve hook → adapter → LFX1 ordering and complete the binding read-back before token creation. Complete explorer verification and post-deploy checks.

   Record the **actual factory address and receipt block `D`**, USDC, router, treasury and applicable adapter/hook addresses. Use confirmed deployed values for downstream configuration. The v4 script prints addresses and nonces but its final JSON does **not** include the factory receipt block; obtain `D` from the receipt. [deploy-v4-stack.js:266](C:/dev/arc-launch/scripts/deploy-v4-stack.js:266), [deploy-v4-stack.js:296](C:/dev/arc-launch/scripts/deploy-v4-stack.js:296)

   **If missed:** the product can expose an unverified or incomplete stack, and downstream services may use predictions or the wrong start block.

7. **After contract verification: finalize and build the frontend candidate.**

   Fill the actual factory address and `D` from step 6. Build from a clean reviewed checkout with Vercel Root Directory `app`, build command `npm run build`, output `dist`, and the upload function included. Run the frontend checks and inspect the built configuration. [app/DEPLOY.md:24](C:/dev/arc-launch/app/DEPLOY.md:24)

   Adapt the live chain verifier before relying on it: it contains testnet token `0x2b4a6568e24679b38Cec48971F57318C13ac6C52` and an assertion requiring the testnet RPC. Its token-decimals check must wait for a verified mainnet token. [verify-chain.mts:71](C:/dev/arc-launch/app/scripts/verify-chain.mts:71), [verify-chain.mts:85](C:/dev/arc-launch/app/scripts/verify-chain.mts:85)

   **If missed:** a successful build can still contain stale network values; unchanged live checks can fail for testnet assumptions rather than a mainnet defect.

8. **After `D` is known, before starting the mainnet indexer: configure Fly and initialize its cursor.**

   Stop the old writer before repointing an existing Fly app. Configure these together:

   | Fly secret | Mainnet value |
   |---|---|
   | `SUPABASE_URL` | Same project selected for the frontend |
   | `SUPABASE_SERVICE_ROLE_KEY` | That project’s server-side writer credential |
   | `FACTORY_RPC_URL` | Verified archive-capable mainnet RPC |
   | `FACTORY_ADDRESS` | Actual verified factory |
   | `FACTORY_DEPLOY_BLOCK` | Receipt block **`D`**, not `D−1` |
   | `HEARTBEAT_URL` | Mainnet monitor URL; regenerate the previously exposed credential |

   The first five are mandatory at startup. [indexer/src/index.js:49](C:/dev/arc-launch/indexer/src/index.js:49), [indexer/RUNBOOK.md:293](C:/dev/arc-launch/indexer/RUNBOOK.md:293)

   Initialize `indexer_state`, ID **`arc_launch_factory`**, to **`last_processed_block = D−1`**. A fresh database with no checkpoint also starts correctly from `FACTORY_DEPLOY_BLOCK`; an existing checkpoint overrides that variable. [recovery.js:1](C:/dev/arc-launch/indexer/src/recovery.js:1), [indexer/src/index.js:577](C:/dev/arc-launch/indexer/src/index.js:577)

   **If missed:** missing secrets stop startup; mismatched secrets write to the wrong database or watch the wrong chain. A stale checkpoint can skip mainnet history or cause excessive replay. Setting the checkpoint to `D` skips the deployment block.

9. **Start one mainnet indexer and prove ingestion before public cutover.**

   Preserve the immediate replacement strategy and single-machine deployment. Verify the running configuration against the mainnet record, then confirm `/health` tracks the mainnet head. Perform the approved controlled create/buy/sell sequence after contract gates, and verify its token, trades and candles through the **same anon credentials the candidate uses**. Run the live reserves comparison after a real trade. [indexer/RUNBOOK.md:134](C:/dev/arc-launch/indexer/RUNBOOK.md:134), [indexer/RUNBOOK.md:154](C:/dev/arc-launch/indexer/RUNBOOK.md:154), [CLAUDE.md:7224](C:/dev/arc-launch/CLAUDE.md:7224)

   **If missed:** a healthy process may be watching the wrong factory; head progress alone does not prove correct data ingestion. Multiple writers can interfere through the shared cursor.

10. **Publish only after the candidate and indexer agree; verify the public domain again.**

    Point `ballista.trading` at the approved mainnet deployment. Verify which environment scope built the actual artifact; do not assume moving an alias changes its embedded configuration. Repeat the network label, factory reads, explorer links, image upload, indexed data and real-wallet checks on the public origin—including a phone WalletConnect session.

    Record the frontend deployment ID, source commit, build scope, Fly release, database project, factory address and `D` together.

    **If missed:** the reviewed preview and public site can serve different configurations, while old wallet sessions or scope differences leave public create/trade paths unusable. Live WalletConnect validation remains explicitly outstanding in the record. [CLAUDE.md:7213](C:/dev/arc-launch/CLAUDE.md:7213)
