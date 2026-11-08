import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  publicDir: "public-native",
  server: { host: "127.0.0.1" },
  build: { outDir: "dist-native", rollupOptions: { input: "native.html" } },
});
