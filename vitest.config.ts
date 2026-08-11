import { defineConfig } from "vitest/config";

// Two projects so the server/unit suites don't pay the cost of a DOM.
// E2E lives in Playwright (see playwright.config.ts) and is excluded here.
export default defineConfig({
  test: {
    globals: true,
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          globals: true,
          include: ["tests/unit/**/*.test.ts", "tests/server/**/*.test.ts", "tests/contract/**/*.test.ts"],
          setupFiles: ["tests/setup.node.ts"],
        },
      },
      {
        test: {
          name: "jsdom",
          environment: "jsdom",
          globals: true,
          include: ["tests/component/**/*.test.tsx"],
        },
      },
    ],
  },
});
