import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 4001,
    host: true,
    proxy: {
      "/trpc": "http://localhost:4000",
      "/api/token": "http://localhost:4000",
    },
  },
  build: {
    outDir: "dist",
  },
});
