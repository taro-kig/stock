import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: "forks",
    execArgv: ["--disable-warning=ExperimentalWarning"],
  },
});
