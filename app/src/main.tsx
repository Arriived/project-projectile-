import React from "react";
import ReactDOM from "react-dom/client";
import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { config } from "./wagmi";
import { App } from "./App";
import { ChainProvider } from "./providers/ChainProvider";
import { WalletDiagnostics } from "./diagnostics/WalletDiagnostics";
import { BrowserRouter } from "react-router-dom";
import "./styles.css";

// One QueryClient for the app. wagmi is built on React Query, so wagmi's reads and our
// own Supabase/quote queries share this client and its cache.
//
// Defaults are deliberately conservative for a chain with sub-second blocks: nothing is
// treated as fresh for long, but nothing refetches on every window focus either, which
// on a trading page would fire a burst of RPC calls at an endpoint documented as
// rate-limited.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 4_000,
      refetchOnWindowFocus: false,
      retry: 2,
    },
  },
});

// ?diag swaps the whole app for the diagnostic page, chosen ONCE at startup.
//
// It is mounted as a sibling of <App />, not inside it, and deliberately outside
// <ChainProvider>: the provider polls the wallet and raises the automatic switch prompt,
// and a diagnostic that reports on wallet state must not be running that machinery while
// it measures. Nesting it inside App also produced a genuine hook-order crash, because
// the two trees have different hook shapes.
const diagnostics =
  typeof window !== "undefined" && new URLSearchParams(window.location.search).has("diag");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        {diagnostics ? (
          <WalletDiagnostics />
        ) : (
          <BrowserRouter>
            <ChainProvider>
              <App />
            </ChainProvider>
          </BrowserRouter>
        )}
      </QueryClientProvider>
    </WagmiProvider>
  </React.StrictMode>
);
