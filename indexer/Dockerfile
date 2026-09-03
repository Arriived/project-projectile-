# The indexer, and nothing else. Not the app, not the contracts, not Hardhat.
#
# ── ⚠ NODE 22, AND THE REASON IS NOT THE ONE YOU MIGHT ASSUME ─────────────────
#
# There is no `engines` field anywhere in this repo and no .nvmrc, so the required version
# had to be established rather than looked up. The obvious guess is that Node 22 is needed
# for `--experimental-strip-types` -- that is true of app/'s verify:* scripts, and it is
# NOT the reason here. The indexer is plain CommonJS .js and needs no type stripping.
#
# The real floor comes from the dependency itself:
#
#   @supabase/supabase-js@2.110.8   engines: { "node": ">=22.0.0" }
#   @supabase/postgrest-js@2.110.8  engines: { "node": ">=22.0.0" }
#   ethers@6.17.0                   engines: { "node": ">=14.0.0" }
#   dotenv@16.6.1                   engines: { "node": ">=12" }
#
# So the binding constraint is Supabase at >=22, and `indexer/package.json` now declares
# that floor so npm warns instead of failing at runtime on some subtle API difference.
#
# Pinned to a minor, not `:22`, so a rebuild months from now produces the same runtime.
# bookworm-slim rather than alpine: ethers and supabase both pull native-ish deps and
# musl has burned this class of project before; the size difference is not worth the risk
# on a single long-lived machine.
FROM node:22.11.0-bookworm-slim

# dumb-init makes PID 1 behave: it reaps zombies and forwards SIGTERM/SIGINT to node.
# ⚠ THIS MATTERS FOR THE CHECKPOINT. Without it node runs as PID 1, ignores the default
# SIGTERM, and the platform escalates to SIGKILL after its grace period -- killing the
# process mid-batch. Nothing corrupts (saveCheckpoint is monotonic and writes only after a
# batch lands), but a clean stop is the difference between a redeploy that resumes and one
# that re-processes.
RUN apt-get update \
 && apt-get install -y --no-install-recommends dumb-init \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /app

# Dependencies first, as their own layer, so a source-only change does not re-install.
# ⚠ `npm ci`, NOT `npm install`. ci installs exactly what package-lock.json pins and fails
# if the lockfile and package.json disagree; install would silently resolve newer versions
# and produce an image that does not match what was tested.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Only what the process actually runs. See .dockerignore for what is kept out and why --
# in particular .env, which must never be baked into an image.
COPY src/ ./src/
COPY scripts/ ./scripts/
COPY migrations/ ./migrations/

# Drop privileges. The base image ships an unprivileged `node` user; nothing here needs
# root, and this process holds a service-role key.
USER node

# Documentation only -- publishing a port is the platform's job, not the image's. Must
# agree with HEALTH_PORT's default in src/health.js and with fly.toml's internal_port.
EXPOSE 8080

# ⚠ NO SECRETS AND NO .env. Every value comes from the host's secret store at runtime:
#   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, FACTORY_RPC_URL, FACTORY_ADDRESS,
#   FACTORY_DEPLOY_BLOCK, and optionally HEARTBEAT_URL / HEALTH_PORT.
# All five of the first group are validated at startup (index.js) and the process exits
# rather than starting from the wrong place.

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/index.js"]
