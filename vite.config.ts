import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  base: "./",
  plugins: [svelte()],
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/artifacts/**", "**/dist/**", "**/dist-electron/**", "**/release/**"],
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/@xterm")) return "xterm";
          if (id.includes("node_modules/lucide-svelte")) return "icons";
          return undefined;
        },
      },
    },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
  },
});
