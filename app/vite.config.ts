import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", ["FLIGHTS_", "VERCEL"]);
  return {
    plugins: [react()],
    server: {
      host: "127.0.0.1",
      // Vercel dev serves /api/flights itself. start-dev.ps1 sets FLIGHTS_API_URL for the local function.
      proxy: env.VERCEL ? undefined : { "/api/flights": env.FLIGHTS_API_URL ?? "http://127.0.0.1:8010" },
    },
  };
});
