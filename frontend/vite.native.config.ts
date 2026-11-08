import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => ({
  plugins: [react(), {
    name: "native-static-index", apply: "build", enforce: "post",
    generateBundle(_options, bundle) {
      const entry = bundle["native.html"];
      if (entry?.type !== "asset") throw new Error("The native Planner HTML entry was not built.");
      this.emitFile({ type: "asset", fileName: "index.html", source: entry.source });
    },
  }],
  publicDir: "public-native",
  server: { host: "127.0.0.1", proxy: {
    "/api/flights": loadEnv(mode, ".", "POC_").POC_API_URL ?? "http://127.0.0.1:8010",
    "/api/transit": loadEnv(mode, ".", "POC_").POC_API_URL ?? "http://127.0.0.1:8010",
  } },
  build: { outDir: "dist-native", rollupOptions: { input: "native.html" } },
}));
