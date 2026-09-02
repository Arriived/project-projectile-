# `app/public/` — static assets served at the site root

Vite copies everything in `public/` to the root of the build output untouched.

⚠ **This file lives OUTSIDE `public/` on purpose.** It used to sit inside it, which meant
Vite copied it into `dist/` and served it at `/README.md` — a developer note published on
the open web for no reason. Nothing in it was secret, but nothing in it was for visitors
either. Anything placed in `public/` is public; that is the whole contract of the
directory.

## Present and verified

All seven were pulled from the live landing page at `ballista.trading` on 2 September 2026
and checked rather than trusted: every PNG carries the PNG magic number, and every one's
IHDR dimensions match the size in its filename (an HTTP 200 can still be an error page).

    favicon-32x32.png            32x32
    favicon-16x16.png            16x16
    apple-touch-icon.png         180x180
    android-chrome-192x192.png   192x192
    android-chrome-512x512.png   512x512
    ballista-logo.png            526x421   <- also the Open Graph / Twitter card image
    site.webmanifest

**The two `android-chrome-*` files were not on the original list** and are here because
`site.webmanifest` references them. Without them, an Android "add to home screen" resolves
two 404s and installs with no icon.

### `site.webmanifest` was edited, not copied verbatim

The version served by the old host had three defects, all carried over from a favicon
generator's defaults:

| field | was | now | why |
|---|---|---|---|
| `name` / `short_name` | `""` (empty) | `Ballista` | an installed PWA showed a blank label |
| `theme_color` | `#ffffff` | `#f3f3f0` | contradicted `index.html`'s `theme-color`, which is `--bg` |
| `background_color` | `#ffffff` | `#f3f3f0` | same — the splash flashed white against the app's ground |
| `start_url` | absent | `/` | absent means "the URL it was installed from", so installing from `/t/0x…` pinned a home screen icon to one token |

## Google Search Console verification

    google3af9e8ceff8d4db2.html

One line, no markup:

    google-site-verification: google3af9e8ceff8d4db2.html

There are **two independent** verifications on this property: this file, and the
`<meta name="google-site-verification" content="HVHUslal_…">` tag in `index.html`. Keep
both. Losing either does not warn you — the property simply stops being verified, and the
first symptom is missing data weeks later.

**This file must bypass the SPA rewrite**, and it does so structurally rather than by
luck: `vercel.json`'s rewrite source excludes any path containing a dot. See `DEPLOY.md`
for why that is written as a negative lookahead instead of relying on Vercel checking the
filesystem first, and for the one-line `curl` that confirms it after every deploy.
`npm run verify:upload` (checks U27/U28) asserts the same property against the real
`vercel.json` at build time.
