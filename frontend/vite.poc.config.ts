import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    // Vercel dev handles /api itself. The account-free runner uses this proxy.
    proxy: process.env.VERCEL ? undefined : {
      "/api": loadEnv(mode, ".", "POC_").POC_API_URL ?? "http://127.0.0.1:8010",
    },
  },
  build: {
    outDir: "dist-poc",
    rollupOptions: { input: ["prototype.html", "solver-comparison.html"] },
  },
}));
