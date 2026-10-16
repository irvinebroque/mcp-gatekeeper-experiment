import { defineConfig, bindings, exports } from "cf/config";
import * as worker from "./src/index" with { type: "cf-worker" };

export default defineConfig({
  worker: {
    name: "canva-gatekeeper",
    entrypoint: worker,
    compatibilityDate: "2026-10-16",
    compatibilityFlags: ["allow_irrevocable_stub_storage"],
    env: {
      BASE_URL: bindings.text("http://localhost:8787"),
      CANVA_CLIENT_ID: bindings.secret(),
      CANVA_CLIENT_SECRET: bindings.secret(),
    },
    exports: {
      UserAccount: exports.durableObject({ storage: "sqlite" }),
      CanvaGatekeeper: exports.durableObject({ storage: "sqlite" }),
    },
    observability: { enabled: false },
  },
});
