import React from "react";
import ReactDOM from "react-dom/client";
import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { config } from "./wagmi";
import { App } from "./App";
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

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </WagmiProvider>
  </React.StrictMode>
);
