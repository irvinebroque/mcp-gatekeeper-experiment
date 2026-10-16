import assert from "node:assert/strict";
import catalog from "../research/tool-map.json";
export async function runScenarios(worker: any) {
const D = "Dabcdefghij";
let checks = 0;
  const scoped: any = await worker.session("design", { kind: "design", id: D, locator: D });
  for (const name of ["searchDesigns", "copy", "resize", "publishBrandTemplate", "call", "raw", "applyAction", "engine"]) {
    await assert.rejects(async () => { await scoped[name](); }); checks++;
  }
  assert.equal((await scoped.getInfo()).id, D); checks++;
  await worker.control("design", "deny", true); await assert.rejects(async () => scoped.getInfo(), /denied/); checks++;
  await worker.control("design", "deny", false);
  const comment = await scoped.addComment("Draft comment");
  assert.equal((await comment.getInfo()).text, "Draft comment");
  await comment.reply("Draft reply");
  let stats = await worker.stats("design");
  assert.equal(stats.calls.filter((x: any) => ["comment-on-design", "reply-to-comment"].includes(x.name)).length, 0); checks++;
  const comments = await scoped.listComments(); assert.equal((await comments.next()).length, 1); checks++;
  await worker.applyAll("design"); assert.equal((await comment.getInfo()).text, "Draft comment"); await (await comment.listReplies()).next(); checks++;
  const editJob = await scoped.beginEdit(); assert.equal((await editJob.getStatus()).status, "processing");
  await worker.applyAll("design"); const editor = (await editJob.getStatus()).result;
  assert.equal((await editor.getSnapshot()).textElements[0].text, "Original");
  await assert.rejects(async () => editor.apply([{ type: "replaceText", elementId: "outside", text: "bad" }])); checks++;
  await editor.apply([{ type: "replaceText", elementId: "text1", text: "Changed" }, { type: "positionElement", elementId: "image2", top: 2, left: 3 }]);
  assert.equal((await editor.getSnapshot()).textElements[0].text, "Changed");
  assert.equal((await scoped.getText()).text, "Changed"); checks++;
  await assert.rejects(async () => editor.getPreview(1), /processing/); checks++;
  await worker.applyAll("design"); assert.equal((await editor.getPreview(1)).url, "https://example.com/preview.png");
  stats = await worker.stats("design"); assert.equal(stats.calls.find((x: any) => x.name === "perform-editing-operations").args.page_index, 1); checks++;
  await editor.commit(); await assert.rejects(async () => editor.getSnapshot(), /closed/); await worker.applyAll("design"); checks++;
  const exported = await scoped.export({ format: "pdf" }); await worker.applyAll("design"); assert.equal((await exported.getStatus()).result.files.length, 1); checks++;
  await scoped.changePages([{ type: "move", pages: [2], afterPage: 0 }, { type: "delete", pages: [2] }]); await worker.applyAll("design");
  await scoped.getText(); await scoped.getPresenterNotes(); await scoped.getDataset(); await scoped.getExportFormats(); await (await scoped.listPages()).next();

  const lib: any = await worker.session("library", { kind: "library" });
  const folder = await lib.openFolder("folder"), child = await folder.openFolder("child");
  await assert.rejects(async () => child.openDesign("D1234567890"), /outside/); checks++;
  const narrowDesign = await child.openDesign(D); await assert.rejects(async () => narrowDesign.copy()); checks++;
  const narrowAsset = await child.openAsset("asset1"); await assert.rejects(async () => narrowAsset.removeBackground()); checks++;
  await narrowAsset.getInfo();
  const newFolder = await folder.createFolder("New folder");
  const nested = await newFolder.createFolder("Nested");
  const localItems = await (await newFolder.listItems()).next(); assert.equal(localItems[0].summary.name, "Nested"); checks++;
  await worker.applyAll("library");
  await worker.control("library", "detached", true); await assert.rejects(async () => narrowDesign.getInfo(), /outside/); checks++;
  await worker.control("library", "detached", false);
  await folder.moveItem({ itemId: D, destinationFolderId: "folder" });
  await assert.rejects(async () => (await folder.listItems()).next(), /processing/); checks++;
  await worker.applyAll("library");
  await lib.moveItem({ itemId: D, destinationFolderId: "root" }); await worker.applyAll("library");
  const cursor = await lib.searchDesigns({ query: "Fixture" });
  await cursor.next(); await cursor.next(); assert.equal(await cursor.next(), null); checks++;
  await (await lib.searchFolders()).next(); await (await lib.searchBrandTemplates()).next(); await (await lib.listBrandKits()).next();
  const design = await lib.openDesign(`https://canva.link/example`);
  const template = await lib.openBrandTemplate("template1"), asset = await lib.openAsset("asset1");
  await template.getDataset(); await asset.getInfo();
  const jobs = [await lib.createDesign({ brief: "Fixture", outline: { sections: [{ title: "Title", description: "Description" }] } }),
    await lib.importDesign({ url: "https://example.com/file.pdf", name: "Import" }),
    await lib.uploadAsset({ url: "https://example.com/picture.png", name: "Image" }),
    await lib.generateImage({ prompt: "Fixture", aspectRatio: "1:1", referenceAssetIds: ["asset1"] }),
    await lib.combineDesigns({ title: "Combined", sources: [{ designId: D }, { designId: D }] }),
    await design.copy(), await design.resize({ width: 500, height: 500 }), await design.publishBrandTemplate(),
    await template.createDesign(), await template.openDraft(), await asset.removeBackground(), await asset.separateLayers()];
  await worker.applyAll("library"); await worker.readyJobs("library");
  for (const job of jobs) { const status = await job.getStatus(); assert.equal(status.status, "completed"); checks++; }
  const cancelJob = await narrowDesign.beginEdit(); await worker.applyAll("library"); const cancelEdit = (await cancelJob.getStatus()).result; await cancelEdit.cancel(); await worker.applyAll("library");
  // Releasing the parent does not revoke independently returned child capabilities.
  lib[Symbol.dispose](); assert.equal((await design.getInfo()).id, D); checks++;
  const allCalls = [...(await worker.stats("design")).calls, ...(await worker.stats("library")).calls];
  const used = new Set(allCalls.map((x: any) => x.name));
  const missing = catalog.tools.filter((x: any) => x.classification !== "excluded" && !used.has(x.name)).map((x: any) => x.name);
  assert.deepEqual(missing, []); checks++;

  const oauth = await worker.oauth();
  const link = await oauth.begin([]);
  const nonce = new URL(link.url).pathname.split("/").at(-1);
  const redirect = await oauth.authorize(nonce);
  const authorization = new URL(redirect.headers.get("location"));
  assert.equal(authorization.searchParams.get("scope"), "profile:read");
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
  await assert.rejects(async () => oauth.authorize(nonce), /Invalid/); checks++;
  await oauth.seed({ credentials: { access_token: "old-test-token", refresh_token: "old-refresh", expires_at: 0, scope: "profile:read" }, patterns: [] });
  assert.deepEqual(await oauth.getPatterns(), []);
  assert.deepEqual(await Promise.all([oauth.getAccessToken(), oauth.getAccessToken()]), ["new-test-token-1", "new-test-token-1"]);
  checks++;
  await oauth.seed({ stage: { stageId: "a".repeat(64), credentials: { access_token: "staged-test-token", expires_at: Date.now() + 3600000, scope: "profile:read" }, patterns: [], expires: Date.now() + 10000 } });
  await assert.rejects(async () => oauth.commitReconnect("b".repeat(64)));
  assert.equal(await oauth.getAccessToken(), "new-test-token-1");
  await oauth.commitReconnect("a".repeat(64)); assert.equal(await oauth.getAccessToken(), "staged-test-token"); checks++;
  await oauth.revoke(); await assert.rejects(async () => oauth.getAccessToken(), /revoked/); checks++;
  await oauth.runCleanupAlarm();
  await assert.rejects(async () => oauth.begin([]), /revoked/);
  assert.equal(await oauth.inspect("credentials"), undefined); checks++;
  return { checks, tools: used.size };
}
