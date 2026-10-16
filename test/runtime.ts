import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

await fs.mkdir(".local/test", { recursive: true });
await build({ entryPoints: ["test/harness.ts"], outfile: ".local/test/worker.mjs", bundle: true, format: "esm", platform: "browser", target: "es2022", external: ["cloudflare:workers", "node:*"], plugins: [{ name: "raw", setup(b) {
  b.onResolve({ filter: /\.txt\?raw$/ }, a => ({ path: path.resolve(a.resolveDir, a.path.slice(0, -4)), namespace: "raw" }));
  b.onLoad({ filter: /.*/, namespace: "raw" }, async a => ({ contents: `export default ${JSON.stringify(await fs.readFile(a.path, "utf8"))};`, loader: "js" }));
} }] });
const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: "test", modules: true, scriptPath: ".local/test/worker.mjs", compatibilityDate: "2026-10-16", compatibilityFlags: ["allow_irrevocable_stub_storage", "nodejs_compat"],
  durableObjects: { TEST: { className: "Harness", useSQLite: true }, OAUTH: { className: "OAuthHarness", useSQLite: true }, UserAccount: { className: "UserAccount", useSQLite: true }, CanvaGatekeeper: { className: "CanvaGatekeeper", useSQLite: true } },
  bindings: { BASE_URL: "http://localhost:8787", CANVA_CLIENT_ID: "fixture-client", CANVA_CLIENT_SECRET: "" },
  outboundService: "mock-canva",
}, { name: "mock-canva", modules: true, compatibilityDate: "2026-10-16", script: `
let refreshes = 0;
export default { async fetch(request) {
  if (new URL(request.url).origin !== "https://mcp.canva.com") throw new Error("Unexpected network access");
  const form = await request.formData();
  if (form.get("grant_type") === "refresh_token") refreshes++;
  return Response.json({ access_token: "new-test-token-" + refreshes, token_type: "Bearer", refresh_token: "new-refresh", expires_in: 3600, scope: "profile:read" });
} };` }] }));
try {
  const worker: any = await mf.getWorker("test");
  const result = await worker.run();
  console.log(`Workers runtime: ${result.checks} checks passed; all ${result.tools} approved tools exercised with synthetic fixtures.`);
} finally { await mf.dispose(); }
