import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { sharedAlias } from "../shared-alias";

export default defineConfig({
  root: resolve(__dirname),
  publicDir: resolve(__dirname, "../src/renderer/public"),
  plugins: [react()],
  resolve: { alias: sharedAlias },
  server: { host: "127.0.0.1", port: 4189, strictPort: true, fs: { allow: [resolve(__dirname, "../../..")] } },
});
