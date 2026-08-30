# Static assets served at the site root

These are carried over from the landing page, which held the apex before the app did.
Vite copies everything in `public/` to the root of the build output untouched.

## Required — the favicon set the HTML references

    favicon-32x32.png
    favicon-16x16.png
    apple-touch-icon.png
    site.webmanifest
    ballista-logo.png        <- also the Open Graph / Twitter card image

The originals were not in the repository; they were served from the old host. Drop them
here and they will be served at the same paths, so no HTML changes are needed.

## Required — Google Search Console file verification

    google3af9e8ceff8d4db2.html

One line, no markup:

    google-site-verification: google3af9e8ceff8d4db2.html

There are TWO independent verifications on this property: this file, and the
`<meta name="google-site-verification" content="HVHUslal_...">` tag in index.html. Keep
both. Losing either does not warn you -- the property simply stops being verified, and
the first symptom is missing data weeks later.

**This file must bypass the SPA rewrite.** A single-page app normally routes every
unmatched path to index.html; if that catches this path, Google receives the app shell
instead of the verification string and the check fails. On most hosts, files in `public/`
are matched before the rewrite, but confirm it after deploying by fetching the path
directly and checking the body is the one line above.
