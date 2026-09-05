import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

/**
 * A Reown/WalletConnect project id is 32 hex characters.
 *
 * ⚠ SHAPE ONLY — deliberately NOT the `86c706f1c` prefix of the current project. Asserting
 * the prefix would over-fit to one project and fail a legitimate key rotation, which is a
 * worse failure than the one this catches: it would block every deploy after a rotation.
 */
const WALLETCONNECT_PROJECT_ID_RE = /^[0-9a-f]{32}$/i;

export default defineConfig(({ mode }) => {
  // `loadEnv` reads the same .env files Vite itself would, so this validates exactly the
  // value that is about to be inlined -- not a separately-read copy that could differ.
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const projectId = env.VITE_WALLETCONNECT_PROJECT_ID;

  /**
   * ⚠ FAIL THE BUILD, NOT THE SITE. This trap already fired in production.
   *
   * Production carried `6c706f1caa5d9a114f7e206898ea947` -- 31 characters, the leading `8`
   * lost to a dashboard paste. WalletConnect then initialised and failed at auth with a
   * 403 that reads exactly like an origin-allowlist problem, which is where the debugging
   * time went.
   *
   * Why the check belongs HERE rather than at runtime, and it is not a style preference:
   *
   *   - Vite INLINES every VITE_ variable into the bundle at build. The id is a literal in
   *     the shipped JS and cannot change afterwards, so a build-time check catches
   *     everything a boot-time check would.
   *   - It fails the DEPLOYMENT instead of the site. Vercel marks the build failed and
   *     production keeps serving the last good build, so no user meets a blank page. A
   *     boot-time `throw` would take down browsing for everyone -- including the majority
   *     who never touch a wallet, on a site whose own copy says browsing needs no wallet.
   *
   * ⚠ The existing guard in wagmi.ts is a TRUTHINESS check (`WALLETCONNECT_PROJECT_ID ? …`)
   * and that is precisely why the truncation was invisible: unset and empty are falsy and
   * correctly skip the connector, but a 31-character id is TRUTHY, so the connector was
   * built and then failed. Truthiness cannot separate valid from malformed. This can.
   *
   * ⚠ UNSET REMAINS LEGITIMATE. A fresh clone with no id gets no WalletConnect connector,
   * which is the intended behaviour (see config.ts) -- an offered button that cannot
   * connect is worse than no button. Only SET-BUT-MALFORMED is an error.
   *
   * ⚠ AND "UNSET" INCLUDES THE EMPTY STRING, which is not the same test as `!== undefined`.
   * A red-proof caught this: `loadEnv` returns `""` for a bare `VITE_WALLETCONNECT_PROJECT_ID=`
   * line (present, no value) rather than omitting the key, so an `!== undefined` guard
   * failed the build on a file that meant "no id". The app itself treats empty as unset --
   * wagmi.ts gates on truthiness, so `""` builds no connector -- and the build check has to
   * agree with the app, or a legitimate .env.local blocks the deploy. Trimmed, so a stray
   * space is not a value either.
   *
   * Scoped to production so `npm run dev` is never blocked mid-experiment.
   */
  const idIsSet = projectId !== undefined && projectId.trim() !== "";
  if (mode === "production" && idIsSet && !WALLETCONNECT_PROJECT_ID_RE.test(projectId.trim())) {
    throw new Error(
      `VITE_WALLETCONNECT_PROJECT_ID is malformed: ${projectId.length} characters ` +
        `(expected 32 hex). WalletConnect would initialise and then fail auth with a 403 ` +
        `that looks like an origin-allowlist problem. Fix the value in the Vercel ` +
        `dashboard -- the CLI truncates long values pasted at its prompt.`
    );
  }

  return {
    plugins: [react()],
    server: { port: 5173, strictPort: true },
    build: {
      /**
       * ⚠ SET EXPLICITLY, NOT LEFT TO THE DEFAULT.
       *
       * `false` is already Vite's production default, so this line changes nothing today --
       * which is exactly why it is worth writing down rather than relying on. A source map
       * republishes the original TypeScript: every comment, every internal name, and the
       * full shape of the trade and create paths, served from the same origin as the app.
       * That is not a secret leak (there are no secrets in client code) but it is free
       * reconnaissance for the twelve competitors CLAUDE.md notes are launching on Arc, and
       * it is the sort of thing a future "let's debug production" change flips on and
       * forgets.
       *
       * Stated as an intentional setting so flipping it is a visible decision in a diff.
       */
      sourcemap: false,
    },
  };
});
