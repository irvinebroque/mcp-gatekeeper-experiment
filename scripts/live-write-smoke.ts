/** Explicit opt-in: live writes through Workers RPC sessions and the production action executor. */
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { resultId } from "../src/core";

if (!process.argv.includes("--execute")) throw new Error("Creates Canva fixtures; pass --execute only with the account owner's authorization.");
const root = ".local/live-write";
await fs.mkdir(root, { recursive: true, mode: 0o700 });
const tokens = JSON.parse(await fs.readFile(".local/oauth-write-tokens.json", "utf8"));
const expires_at = (await fs.stat(".local/oauth-write-tokens.json")).mtimeMs + tokens.expires_in * 1000;
for (const s of ["design:content:write", "folder:write", "comment:write"]) assert.ok(tokens.scope.split(" ").includes(s), "Authorize write scopes first");
assert.ok(expires_at > Date.now() + 300000, "Authorize a fresh write test token");
const resume = process.argv.includes("--resume");
const manifest: any = resume ? JSON.parse(await fs.readFile(root + "/manifest.json", "utf8")) : {
  runId: new Date().toISOString().replace(/[:.]/g, "-"), resources: [], passed: [], cleanup: { status: "pending", method: "Canva UI trash; no delete MCP tool exists" },
};
if (manifest.cleanup.status === "completed") throw new Error("These fixtures have already been cleaned up; archive the private manifest/state before a new authorized run.");
manifest.label ??= `Gatekeeper write test ${manifest.runId}`;
const save = () => fs.writeFile(root + "/manifest.json", JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
if (!resume) {
  try { await fs.access(root + "/manifest.json"); throw new Error("Existing fixture manifest found; review it and use --resume instead of duplicating writes"); }
  catch (e: any) { if (e.code !== "ENOENT") throw e; }
}
await build({ entryPoints: ["test/live-harness.ts"], outfile: root + "/worker.mjs", bundle: true, format: "esm", platform: "browser", target: "es2022", external: ["cloudflare:workers"] });
const mf = new Miniflare({ ...convertV4MiniflareOptions({ workers: [{ name: "live-canva", modules: true, scriptPath: root + "/worker.mjs", compatibilityDate: "2026-10-16", compatibilityFlags: ["allow_irrevocable_stub_storage"], durableObjects: { LIVE: { className: "LiveHarness", useSQLite: true } } }] }), resourcePersistencePath: path.resolve(root + "/state") });
let h: any;
const checkpoint = async () => { const state = await h.checkpoint(); await fs.writeFile(root + "/transcript.json", JSON.stringify(state, null, 2), { mode: 0o600 }); return state; };
try {
  const worker: any = await mf.getWorker("live-canva"); h = await worker.harness(manifest.runId);
  await h.setup({ access_token: tokens.access_token, expires_at });
  if (resume) await h.restore(JSON.parse(await fs.readFile(root + "/transcript.json", "utf8")));
  const mark = async (name: string) => { if (!manifest.passed.includes(name)) manifest.passed.push(name); await checkpoint(); await save(); console.log(`Live write check passed: ${name}`); };
  // Bootstrap reads only once across resumes. The reviewed journal reconstructs IDs.
  let state = await checkpoint();
  if (!state.actions.some((a: any) => a.tool === "create-folder")) {
    const library = await h.session(), parent = await library.openFolder("root");
    await parent.createFolder(manifest.label);
    state = await checkpoint(); assert.equal(state.actions.at(-1).state, "queued");
    await h.apply(state.actions.at(-1).id);
  }
  state = await checkpoint(); const folderId = resultId(state.actions.find((a: any) => a.tool === "create-folder").result, "folder");
  if (!manifest.resources.some((x: any) => x.id === folderId)) manifest.resources.push({ kind: "folder", id: folderId, url: `https://www.canva.com/folder/${folderId}` });
  await mark("create-folder approval boundary");
  if (!state.actions.some((a: any) => a.tool === "import-design-from-url")) {
    const library = await h.session(); await library.importDesign({ url: "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf", name: manifest.label });
    state = await checkpoint(); await h.apply(state.actions.at(-1).id);
  }
  state = await checkpoint(); const importedId = resultId(state.actions.find((a: any) => a.tool === "import-design-from-url").result, "design");
  if (!manifest.resources.some((x: any) => x.id === importedId)) manifest.resources.push({ kind: "design", id: importedId, url: `https://www.canva.com/design/${importedId}/edit` });
  await mark("import-design-from-url");
  const copied = await worker.step(manifest.runId, "copy", { source: importedId });
  assert.notEqual(copied.id, importedId);
  if (!manifest.resources.some((x: any) => x.id === copied.id)) manifest.resources.push({ kind: "design", id: copied.id, url: copied.editUrl });
  await mark("copy-design");
  for (const step of ["move", "comments", "edit", "cancel", "export"]) {
    if (manifest.passed.includes(step)) continue;
    const result = await worker.step(manifest.runId, step, { design: copied.id, designs: [importedId, copied.id], folder: folderId, title: manifest.label + " verified" });
    if (result.preview) manifest.preview = result.preview.url;
    if (step === "edit") manifest.textEdited = result.textEdited;
    await mark(step);
  }
  delete manifest.failed; manifest.completedAt = new Date().toISOString(); await save();
  console.log("Live write sequence complete. Private fixture manifest: .local/live-write/manifest.json");
} catch (error) {
  manifest.failed = error instanceof Error ? error.message : "Live test failed"; await save();
  if (h) await checkpoint();
  console.error("Live test stopped; inspect private manifest/transcript before resuming. Ambiguous writes must not be replayed.");
  throw error;
} finally { await mf.dispose(); }
