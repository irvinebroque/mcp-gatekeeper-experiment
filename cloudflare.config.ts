import { defineConfig, bindings, exports } from "cf/config";
import * as worker from "./src/index" with { type: "cf-worker" };
import { credentialWorker, accessAudience, devAccess } from "./auth/cloudflare.config.ts";

export default defineConfig(({ mode }) => ({
  worker: {
    name: "canva-gatekeeper",
    entrypoint: worker,
    compatibilityDate: "2026-10-16",
    compatibilityFlags: ["allow_irrevocable_stub_storage"],
    env: {
      ACCESS_AUDIENCE: bindings.text(accessAudience),
      CREDENTIALS: bindings.worker({ worker: credentialWorker, exportName: "CredentialBroker" }),
    },
    exports: {
      CanvaGatekeeper: exports.durableObject({ storage: "sqlite" }),
    },
    observability: { enabled: false },
    ...(mode === "access-dev" ? { access: devAccess } : {}),
  },
}));
