import { defineConfig, defineWorker, bindings, exports } from "cf/config";
import * as worker from "./index" with { type: "cf-worker" };

// Set this to the Access application's audience tag before deployment.
export const accessAudience = "configure-access-audience";
export const devAccess = { dev: { aud: accessAudience, identity: { user_uuid: "local-developer", email: "developer@example.com" } } };

export const credentialWorker = defineWorker(({ mode }) => ({
  name: "canva-credentials",
  entrypoint: worker,
  compatibilityDate: "2026-10-16",
  compatibilityFlags: ["allow_irrevocable_stub_storage"],
  env: {
    BASE_URL: bindings.text("http://localhost:8788"),
    ACCESS_AUDIENCE: bindings.text(accessAudience),
    CANVA_CLIENT_ID: bindings.secret(),
    CANVA_CLIENT_SECRET: bindings.secret(),
    ACCOUNTS: bindings.durableObject({ worker: "canva-credentials", exportName: "UserAccount" }),
  },
  exports: { UserAccount: exports.durableObject({ storage: "sqlite" }) },
  ...(mode === "access-dev" ? { access: devAccess } : {}),
  observability: { enabled: false },
}));

export default defineConfig({ worker: credentialWorker });
