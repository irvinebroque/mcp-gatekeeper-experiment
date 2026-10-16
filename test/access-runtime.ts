import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

await fs.mkdir(".local/access-test", { recursive: true });
for (const [name, entry] of [["gatekeeper", "src/index.ts"], ["auth", "auth/index.ts"], ["controller", "test/access-harness.ts"]]) {
  const result = await build({ entryPoints: [entry], outfile: `.local/access-test/${name}.mjs`, bundle: true, format: "esm", platform: "browser", target: "es2022", external: ["cloudflare:workers"], metafile: true,
    plugins: [{ name: "raw", setup(b) {
      b.onResolve({ filter: /\.txt\?raw$/ }, a => ({ path: path.resolve(a.resolveDir, a.path.slice(0, -4)), namespace: "raw" }));
      b.onLoad({ filter: /.*/, namespace: "raw" }, async a => ({ contents: `export default ${JSON.stringify(await fs.readFile(a.path, "utf8"))};`, loader: "js" }));
    } }] });
  if (name === "gatekeeper") assert.ok(!Object.keys(result.metafile!.inputs).some(p => p.startsWith("auth/")), "Gatekeeper must not bundle OAuth or credential storage");
}
const base = { modules: true as const, compatibilityDate: "2026-10-16", compatibilityFlags: ["allow_irrevocable_stub_storage"] };
const audience = "test-access";
const auth = { ...base, name: "auth", scriptPath: ".local/access-test/auth.mjs",
  routes: ["auth.example.com/*"],
  access: { aud: audience, identity: { user_uuid: "owner" } },
  durableObjects: { ACCOUNTS: { className: "UserAccount", useSQLite: true } },
  bindings: { BASE_URL: "https://auth.example.com", ACCESS_AUDIENCE: audience, CANVA_CLIENT_ID: "test-client", CANVA_CLIENT_SECRET: "" }, outboundService: "canva" };
const gatekeeper = { ...base, name: "gatekeeper", scriptPath: ".local/access-test/gatekeeper.mjs", bindings: { ACCESS_AUDIENCE: audience },
  routes: ["gk.example.com/*"],
  durableObjects: { CanvaGatekeeper: { className: "CanvaGatekeeper", useSQLite: true } },
  serviceBindings: { CREDENTIALS: { name: "auth", entrypoint: "CredentialBroker" } } };
const controller = { ...base, name: "controller", scriptPath: ".local/access-test/controller.mjs",
  durableObjects: { STATE: { className: "State", useSQLite: true } },
  serviceBindings: { VENDOR: { name: "gatekeeper", entrypoint: "GatekeeperVendor" } } };
const canva = { ...base, name: "canva", script: `
let writes = 0;
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.hostname === "stats.test") return Response.json({ writes });
    if (url.origin !== "https://mcp.canva.com") throw new Error("Unexpected outbound request");
    if (url.pathname === "/token") return Response.json({ access_token: "test-provider-token", refresh_token: "test-refresh", token_type: "Bearer", expires_in: 3600, scope: "design:meta:read" });
    if (request.headers.get("authorization") !== "Bearer test-provider-token") throw new Error("Wrong provider credentials");
    const body = await request.json();
    if (!body.id) return new Response(null, { status: 202 });
    let result = {};
    if (body.method === "tools/call") {
      const name = body.params.name;
      if (name === "comment-on-design") { writes++; result = { thread: { id: "comment1" } }; }
      else if (name === "get-design") result = { design: { id: "Dabcdefghij", title: "Fixture", urls: { edit_url: "https://www.canva.com/design/Dabcdefghij/edit" } } };
      else throw new Error("Unexpected tool");
      result = { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
    return Response.json({ jsonrpc: "2.0", id: body.id, result });
  }
};` };
const resourcePersistencePath = ".local/access-test/state-" + crypto.randomUUID();
const options = () => ({ ...convertV4MiniflareOptions({ workers: [controller, gatekeeper, auth, canva] }), resourcePersistencePath });
const mf = new Miniflare(options());
let checks = 0;
try {
  let host: any = await mf.getWorker("controller");
  const browser = { fetch: (url: string, init?: Parameters<typeof mf.dispatchFetch>[1]) => mf.dispatchFetch(url, init) };
  const gk = browser;
  let provider = await mf.getWorker("canva");
  const asUser = async (userId: string) => {
    auth.access.identity.user_uuid = userId;
    await mf.setOptions(options());
    host = await mf.getWorker("controller"); provider = await mf.getWorker("canva");
  };
  assert.equal((await gk.fetch("https://gk.example.com/health", { headers: { "Cf-Access-Jwt-Assertion": "forged", "Cf-Access-Authenticated-User-Email": "owner@example.com" } })).status, 403); checks++;
  assert.equal((await browser.fetch("https://auth.example.com/health")).status, 200); checks++;
  const link = await host.start();
  assert.ok(link.url.startsWith("https://auth.example.com/connect/")); checks++;
  const authorize = await browser.fetch(link.url, { redirect: "manual" });
  assert.equal(authorize.status, 302); checks++;
  const upstream = new URL(authorize.headers.get("location")!);
  assert.equal(upstream.origin, "https://mcp.canva.com");
  assert.equal(upstream.searchParams.get("code_challenge_method"), "S256"); checks++;
  assert.equal((await browser.fetch(link.url)).status, 400); checks++;
  const callback = "https://auth.example.com/callback?" + new URLSearchParams({ state: upstream.searchParams.get("state")!, code: "fixture-code" });
  await asUser("other-user");
  assert.equal((await browser.fetch(callback)).status, 400); checks++;
  await asUser("owner");
  assert.equal((await browser.fetch(callback)).status, 200); checks++;
  assert.equal((await browser.fetch(callback)).status, 400); checks++;
  assert.equal((await host.read()).id, "Dabcdefghij"); checks++;
  await host.deny(true); await assert.rejects(async () => { await host.read(); }, /denied/); checks++;
  await host.deny(false);
  await host.submit();
  assert.equal((await (await provider.fetch("https://stats.test/")).json() as any).writes, 0); checks++;
  await host.apply();
  assert.equal((await (await provider.fetch("https://stats.test/")).json() as any).writes, 1); checks++;
  const reconnectUrl = (await host.reconnect()).url;
  await asUser("other-user");
  assert.equal((await browser.fetch(reconnectUrl)).status, 400); checks++;
  await asUser("owner");
  const reconnectResponse = await browser.fetch(reconnectUrl, { redirect: "manual" });
  assert.equal(reconnectResponse.status, 302);
  const reconnectUpstream = new URL(reconnectResponse.headers.get("location")!);
  assert.equal((await browser.fetch("https://auth.example.com/callback?" + new URLSearchParams({ state: reconnectUpstream.searchParams.get("state")!, code: "reconnect" }))).status, 200); checks++;
  await host.commitReconnect(); assert.equal((await host.read()).id, "Dabcdefghij"); checks++;
  await host.revoke(); await assert.rejects(async () => { await host.read(); }, /revoked/); checks++;
  console.log(`Access integration: ${checks} checks passed across separate Gatekeeper and credential Workers (mock Access identity and Canva).`);
} finally { await mf.dispose(); }
