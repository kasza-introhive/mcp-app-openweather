import { defineConfig, devices } from "@playwright/test";

// Standalone on purpose: there is no `webServer` block because the specs load
// the built `dist/mcp-app.html` from disk and drive it with a fake host bridge
// (tests/e2e/fake-host.ts). That keeps E2E self-contained -- no need to clone
// and run an external MCP host.
//
// Known gap: a fake bridge does NOT exercise a real host's iframe sandbox or
// CSP enforcement. See README "Verifying against a real host" for that step.
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  timeout: 30_000,
  reporter: process.env.CI ? "list" : "html",
  use: {
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    // Recharts' ResponsiveContainer collapses to 0px without a real width.
    viewport: { width: 1000, height: 800 },
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          // Opt-in escape hatch for restricted sandboxes (e.g. a hardened CI
          // container or a macOS seatbelt profile) where Chromium's default
          // multi-process launch is blocked from creating Mach ports. Not
          // enabled by default: --single-process is slower and less isolated.
          //
          // Caveat, learned the hard way: with --single-process the browser
          // does not survive closing a BrowserContext, so only the FIRST test
          // per worker runs and the rest report "browser has been closed".
          // Under PW_SINGLE_PROCESS, run one test at a time (`-g "<title>"`).
          // On an unrestricted machine drop the flag and the full suite runs
          // normally in one pass.
          args: process.env.PW_SINGLE_PROCESS
            ? ["--no-sandbox", "--single-process", "--disable-gpu"]
            : [],
        },
      },
    },
  ],
});
