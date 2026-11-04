import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  server: {
    proxy: {
      // start-dev.ps1 sets PLANNER_API_URL when the API uses another port.
      "/api": loadEnv(mode, ".", "PLANNER_").PLANNER_API_URL ?? "http://127.0.0.1:8000",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
}));
