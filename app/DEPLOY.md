# Deploying `app/` to Vercel

Preview deployments only for now. Nothing here points at the production domain.

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
*project setting*, not something `vercel.json` can express.

## Environment variables

Exactly three, all `VITE_`-prefixed, all **Preview** scope:

    VITE_SUPABASE_URL
    VITE_SUPABASE_ANON_KEY
    VITE_WALLETCONNECT_PROJECT_ID

### ⚠ NEVER set the service-role key. Not under any name.

`SUPABASE_SERVICE_ROLE_KEY` bypasses RLS entirely. It belongs to the indexer process, in
`indexer/.env`, on a machine that is not a CDN.

The danger is not only the `VITE_` prefix. Setting it *unprefixed* on a static project is
also wrong: it would not reach the bundle, so nothing would visibly break, and the secret
would sit in the dashboard indefinitely with no signal — available to anyone with project
access and to any future build step that starts reading `process.env`. **There is no
correct way to put it here.**

The anon key IS meant to ship. Vite inlines every `VITE_` variable into the client bundle,
which is correct for it: RLS is what protects the data, verified 11/11 against the live
project with that exact key. The WalletConnect project id is likewise public by design —
the relay needs it from the browser.

## The SPA rewrite, and the one path it must not swallow

`vercel.json`:

```json
{ "source": "/((?!.*\\.).*)", "destination": "/index.html" }
```

The negative lookahead means **only extensionless paths are rewritten.** `/`, `/about`,
`/create` and `/t/0xEDeed1F0…` have no dot and route to the app. Anything containing a dot
— `/google3af9e8ceff8d4db2.html`, `/favicon-32x32.png`, `/site.webmanifest` — is left for
the static filesystem.

⚠ **Written this way ON PURPOSE rather than relying on filesystem precedence.** Vercel does
check the filesystem before rewrites, so a bare `/(.*)` catch-all would *probably* work.
"Probably" is not good enough here: if it ever fails, Google receives the app shell instead
of the verification string, reports **no error**, and the property silently stops being
verified. The first symptom is missing Search Console data weeks later. The lookahead makes
the outcome independent of precedence rules that could change under us.

**Verify after every deploy** — see the check in the deploy steps. It is one `curl`.

## Files still missing from `public/`

`google3af9e8ceff8d4db2.html` now exists. These do **not**, and `index.html` references
them, so they will 404:

    favicon-32x32.png
    favicon-16x16.png
    apple-touch-icon.png
    site.webmanifest
    ballista-logo.png     <- also the Open Graph / Twitter card image

They are binary assets from the old host and are not in the repository. A preview deploy
works without them; the tab icon is blank and link previews have no image. Drop them into
`public/` and they are served at the same paths with no HTML change.

## Two verifications, not one

There are **two independent** Google verifications on this property:

1. `/google3af9e8ceff8d4db2.html` — the file
2. `<meta name="google-site-verification" content="HVHUslal_…">` in `index.html`

Keep both. Losing either does not warn you.
