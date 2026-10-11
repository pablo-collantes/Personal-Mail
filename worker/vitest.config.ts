import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // Tests never reach Workers AI: no remote AI binding, and no classifier at all unless a test
      // sets one up with a fake (the Mailbox's own alarm sweeps then find none and do nothing).
      remoteBindings: false,
      miniflare: { bindings: { CLASSIFIER_MODEL: "" } },
    }),
  ],
});
