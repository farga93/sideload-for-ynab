import { defineConfig } from "vitest/config";

export default defineConfig({
  root: "src/web",
  build: { outDir: "../../dist", emptyOutDir: true },
  test: { root: ".", include: ["test/**/*.test.ts"] },
});
