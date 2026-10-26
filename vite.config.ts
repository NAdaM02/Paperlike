import fs from "node:fs";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/** JPEG 2000 and JBIG2 images need pdf.js's wasm decoders, under stable names. */
function pdfjsWasmPlugin(): Plugin {
  const src = path.resolve("node_modules/pdfjs-dist/wasm");
  const files = () => fs.readdirSync(src).filter((name) => !name.startsWith("LICENSE"));
  return {
    name: "pdfjs-wasm",
    configureServer(server) {
      server.middlewares.use("/pdfjs/wasm", (req, res, next) => {
        const name = decodeURIComponent((req.url || "/").split("?")[0].replace(/^\/+/, ""));
        if (!name || name.includes("..") || name.includes("/") || name.includes("\\")) {
          next();
          return;
        }
        const file = path.join(src, name);
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
          next();
          return;
        }
        if (name.endsWith(".wasm")) res.setHeader("Content-Type", "application/wasm");
        else if (name.endsWith(".js")) res.setHeader("Content-Type", "text/javascript");
        fs.createReadStream(file).pipe(res);
      });
    },
    generateBundle() {
      for (const name of files()) {
        this.emitFile({
          type: "asset",
          fileName: `pdfjs/wasm/${name}`,
          source: fs.readFileSync(path.join(src, name)),
        });
      }
    },
  };
}

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), pdfjsWasmPlugin()],
  // Loaded from disk by the desktop shell, so bundle size is not a network cost.
  build: { chunkSizeWarningLimit: 2000 },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
});
