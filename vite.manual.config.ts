import { defineConfig } from "vite-plus";
import config from "./vite.config.js";

// Explicit local research validation only; no CI workflow references this configuration.
export default defineConfig({
  ...config,
  test: {
    ...config.test,
    include: ["doc/reports/examples/formal-comprehension.manual.ts"],
  },
});
