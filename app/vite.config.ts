import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
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
});
