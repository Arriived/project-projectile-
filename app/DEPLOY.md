# Deploying `app/` to Vercel

**Preview deployments only.** Nothing here points at the production domain.
`ballista.trading` keeps serving the old landing page until the operator says otherwise.

## ⚠ THIS IS NO LONGER A PURELY STATIC BUILD

`api/sign-upload.ts` exists, so the deploy is **a folder plus a function**, not a folder.
That is an accepted, deliberate change (image upload cannot ship without it — see
`src/lib/upload.ts`), recorded here and in CLAUDE.md §11.17 so it is not rediscovered as a
surprise by a future session wondering why the "static site" has a runtime.

**The trust boundary is narrow and worth stating exactly: that function can mint an upload
URL and nothing else.** It holds no key that touches funds, signs no transaction, reads no
database, and cannot affect any token that has already launched. If it disappears,
existing tokens are unaffected and only new image uploads stop working.

## Build settings

| setting | value |
|---|---|
| **Root Directory** | `app` |
| **Framework preset** | Vite |
| **Build command** | `npm run build` (= `tsc -b && vite build`) |
| **Output directory** | `dist` |
| **Install command** | `npm install` |

⚠ **Root Directory must be `app`.** The repo root is a Hardhat/Foundry project with its own
`package.json`; building from there produces contracts, not a site. This is a Vercel
*project setting*, not something `vercel.json` can express. It is also what makes
`app/api/sign-upload.ts` resolve to `/api/sign-upload` rather than `/app/api/…`.

## Environment variables

Set all of these on **Preview** scope.

| name | scope | reaches the browser? | required |
|---|---|---|---|
| `VITE_SUPABASE_URL` | Preview | **yes, by design** | yes |
| `VITE_SUPABASE_ANON_KEY` | Preview | **yes, by design** | yes |
| `VITE_WALLETCONNECT_PROJECT_ID` | Preview | **yes, by design** | optional |
| `VITE_PINATA_GATEWAY` | Preview | **yes, by design** | optional, recommended |
| `PINATA_JWT` | Preview | **NO — server only** | required for upload |

**Verified against the real build output, not assumed** (2 September 2026): the three
`VITE_` values above are the only configured variables whose values appear in `dist/`, and
`grep -r "service_role\|eyJ" dist/` across all 74 files returns exactly one hit — a JWT
that decodes to `{"role":"anon"}`. Zero occurrences of the literal `service_role`. Zero
`.map` files and no `sourceMappingURL`.

### ⚠ NEVER set the Supabase service-role key. Not under any name.

`SUPABASE_SERVICE_ROLE_KEY` bypasses RLS entirely. It belongs to the indexer process, in
`indexer/.env`, on a machine that is not a CDN.

The danger is not only the `VITE_` prefix. Setting it *unprefixed* here is also wrong: it
would not reach the bundle, so nothing would visibly break, and the secret would sit in the
dashboard indefinitely with no signal — available to anyone with project access and to any
future build step that starts reading `process.env`. **There is no correct way to put it
here.**

### ⚠ `PINATA_JWT` must NOT be `VITE_`-prefixed

Vite inlines every `VITE_` variable into the client bundle. A prefixed Pinata key would be
published to every visitor, and Pinata's own documentation is explicit that even an
upload-only key lets an attacker "upload tons of files, costing you significant money or
locking out your account". There is no scoping that makes a browser-side Pinata key safe —
which is the entire reason `api/sign-upload.ts` exists.

`npm run verify:upload` fails the build if that name ever acquires a prefix (check U1,
red-proved).

### `VITE_PINATA_GATEWAY` is public and is not a credential

A gateway hostname, e.g. `your-gateway.mypinata.cloud`, with no scheme and no trailing
slash. It appears in every image URL the page renders, so there is nothing to keep secret.

**Optional, but recommended.** Uploads write `ipfs://<cid>` to the chain (deliberately —
a gateway hostname baked into on-chain metadata is a permanent dependency on one domain).
That URI is resolved to a gateway at *render* time. Without this set the fallback is
`ipfs.io`, a public gateway that must FIND content on the network: a just-uploaded image
may render slowly or not at all, which is exactly the moment a creator is watching.

## The SPA rewrite, and the two paths it must not swallow

`vercel.json`:

```json
{ "source": "/((?!api/)(?!.*\\.).*)", "destination": "/index.html" }
```

Two exclusions, both load-bearing:

1. **`(?!api/)`** — `/api/sign-upload` is extensionless, so without this the catch-all
   rewrites it to the app shell and the upload receives HTML where it expects JSON.
2. **`(?!.*\.)`** — only extensionless paths are rewritten. `/`, `/about`, `/create` and
   `/t/0xEDeed1F0…` route to the app; anything containing a dot —
   `/google3af9e8ceff8d4db2.html`, `/favicon-32x32.png`, `/site.webmanifest` — is left for
   the static filesystem.

⚠ **Written this way ON PURPOSE rather than relying on filesystem precedence.** Vercel does
check the filesystem (and `api/`) before applying top-level rewrites, so a bare `/(.*)`
catch-all would *probably* work for both. "Probably" is not good enough for the Google
path: if it ever fails, Google receives the app shell instead of the verification string,
reports **no error**, and the property silently stops being verified. The first symptom is
missing Search Console data weeks later. The lookahead makes the outcome independent of
precedence rules that could change under us.

**Both properties are asserted at build time** by `npm run verify:upload` (U26–U29),
against the real `vercel.json` rather than a retyped copy of the pattern — and both are
red-proved: restoring the old `/(.*)` catch-all turns them red.

## `public/` — present and verified

All seven assets were pulled from the live landing page on 2 September 2026 and checked,
not trusted: PNG magic numbers verified, and each file's IHDR dimensions match the size in
its name (an HTTP 200 can still be an error page).

    favicon-32x32.png  favicon-16x16.png  apple-touch-icon.png
    android-chrome-192x192.png  android-chrome-512x512.png
    ballista-logo.png  site.webmanifest  google3af9e8ceff8d4db2.html

The two `android-chrome-*` files were not on the original list; `site.webmanifest`
references them, so without them an Android "add to home screen" resolves two 404s. See
`PUBLIC_ASSETS.md` for the three defects fixed in the manifest itself.

## Source maps

Off, and set **explicitly** in `vite.config.ts` rather than left to Vite's default, so
turning them on is a visible decision in a diff. A source map republishes the original
TypeScript — every comment and the full shape of the trade and create paths — from the same
origin as the app. Asserted by `verify:upload` U30.

## Two Google verifications, not one

1. `/google3af9e8ceff8d4db2.html` — the file
2. `<meta name="google-site-verification" content="HVHUslal_…">` in `index.html`

Keep both. Losing either does not warn you.
