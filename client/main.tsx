import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import { trpc } from "./trpc";
import { App } from "./App";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: false,
    },
  },
});

async function init() {
  let token: string | undefined = window.__YSA_TOKEN__;
  if (!token) {
    try {
      const res = await fetch("/api/token");
      if (res.ok) token = await res.text();
    } catch {}
  }

  const trpcClient = trpc.createClient({
    links: [
      httpBatchLink({
        url: "/trpc",
        headers() {
          return token ? { Authorization: `Bearer ${token}` } : {};
        },
      }),
    ],
  });

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <trpc.Provider client={trpcClient} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          <App />
        </QueryClientProvider>
      </trpc.Provider>
    </StrictMode>,
  );
}

init();
