import assert from "node:assert/strict";
import catalog from "../schemas/canva-rest.json";
import { DESIGN_ID as D } from "./fixtures";

export async function runScenarios(worker: any) {
  let checks = 0;
  const scoped: any = await worker.session("design", { kind: "design", id: D, locator: D });
  for (const name of [
    "searchDesigns",
    "copy",
    "resize",
    "publishBrandTemplate",
    "call",
    "raw",
    "applyAction",
    "engine",
    "getText",
    "getPresenterNotes",
    "beginEdit",
    "listComments",
  ]) {
    await assert.rejects(async () => {
      await scoped[name]();
    });
    checks++;
  }
  assert.equal((await scoped.getInfo()).id, D);
  checks++;
  await worker.control("design", "deny", true);
  await assert.rejects(async () => scoped.getInfo(), /denied/);
  checks++;
  await worker.control("design", "deny", false);
  const comment = await scoped.addComment("Draft comment");
  assert.equal((await comment.getInfo()).text, "Draft comment");
  await comment.reply("Draft reply");
  assert.equal((await (await comment.listReplies()).next())[0].text, "Draft reply");
  let stats = await worker.stats("design");
  assert.equal(
    stats.calls.filter((call: any) => ["createThread", "createReply"].includes(call.name)).length,
    0,
  );
  checks++;
  await worker.applyAll("design");
  assert.equal((await comment.getInfo()).text, "Draft comment");
  assert.equal((await (await comment.listReplies()).next())[0].text, "Draft reply");
  checks++;
  assert.equal((await (await scoped.openComment("comment1")).getInfo()).id, "comment1");
  checks++;

  async function finish(name: string, job: any) {
    assert.equal((await job.getStatus()).status, "processing");
    await worker.applyAll(name);
    await worker.readyJobs(name);
    const status = await job.getStatus();
    assert.equal(status.status, "completed");
    checks++;
    return status.result;
  }
  const exported = await finish("design", await scoped.export({ format: "pdf" }));
  assert.equal(exported.files.length, 1);
  const pagesJob = await scoped.changePages([
    { type: "move", pages: [2], afterPage: 0 },
    { type: "delete", pages: [2] },
  ]);
  await assert.rejects(async () => (await scoped.listPages()).next(), /processing/);
  checks++;
  await finish("design", pagesJob);
  await scoped.getDataset();
  assert.deepEqual(await scoped.getExportFormats(), [
    { format: "pdf", pages: [1, 2] },
    { format: "png", pages: undefined },
  ]);
  const pages = await scoped.listPages();
  assert.equal((await pages.next()).length, 2);
  assert.equal(await pages.next(), null);
  checks++;

  const lib: any = await worker.session("library", { kind: "library" });
  for (const name of ["searchFolders", "listBrandKits", "raw", "engine"]) {
    await assert.rejects(async () => lib[name]());
    checks++;
  }
  await assert.rejects(async () => lib.openDesign("https://canva.link/example"));
  checks++;
  const folder = await lib.openFolder("folder"),
    child = await folder.openFolder("child");
  await assert.rejects(async () => child.openDesign("D1234567890"), /outside/);
  checks++;
  const narrowDesign = await child.openDesign(D);
  await assert.rejects(async () => narrowDesign.copy());
  checks++;
  const narrowAsset = await child.openAsset("asset1");
  await assert.rejects(async () => narrowAsset.removeBackground());
  checks++;
  await narrowAsset.getInfo();
  const newFolder = await folder.createFolder("New folder");
  await newFolder.createFolder("Nested");
  const localItems = await (await newFolder.listItems()).next();
  assert.equal(localItems[0].summary.name, "Nested");
  checks++;
  await worker.applyAll("library");
  await worker.control("library", "detached", true);
  await assert.rejects(async () => narrowDesign.getInfo(), /outside/);
  checks++;
  await worker.control("library", "detached", false);
  await folder.moveItem({ itemId: D, destinationFolderId: "folder" });
  await assert.rejects(async () => (await folder.listItems()).next(), /processing/);
  checks++;
  await worker.applyAll("library");
  await lib.moveItem({ itemId: D, destinationFolderId: "root" });
  await worker.applyAll("library");
  const cursor = await lib.searchDesigns({ query: "Fixture" });
  await cursor.next();
  await cursor.next();
  assert.equal(await cursor.next(), null);
  checks++;
  await worker.control("library", "deny", true);
  await assert.rejects(async () => cursor.next(), /denied/);
  checks++;
  await worker.control("library", "deny", false);
  await (await lib.searchBrandTemplates()).next();
  const design = await lib.openDesign(`https://www.canva.com/design/${D}/edit`);
  const template = await lib.openBrandTemplate("template1"),
    asset = await lib.openAsset("asset1");
  await template.getDataset();
  await asset.getInfo();
  await finish(
    "library",
    await lib.createDesign({
      brief: "Fixture",
      format: "presentation",
      outline: { sections: [{ title: "Title", description: "Description" }] },
    }),
  );
  assert.equal(
    (
      await finish(
        "library",
        await lib.importDesign({ url: "https://example.com/file.pdf", name: "Import" }),
      )
    ).length,
    1,
  );
  await finish(
    "library",
    await lib.uploadAsset({ url: "https://example.com/picture.png", name: "Image" }),
  );
  await finish("library", await lib.generateImage({ prompt: "Fixture", aspectRatio: "1:1" }));
  await finish(
    "library",
    await lib.combineDesigns({ title: "Combined", sources: [{ designId: D }, { designId: D }] }),
  );
  await finish("library", await design.copy());
  await finish("library", await design.resize({ width: 500, height: 500 }));
  await finish("library", await design.publishBrandTemplate());
  await finish("library", await template.createDesign());
  await finish("library", await asset.removeBackground());
  for (const [capability, method] of [
    [asset, "separateLayers"],
    [template, "openDraft"],
  ]) {
    await assert.rejects(async () => capability[method]());
    checks++;
  }
  // Returned children own independent approval-queue references.
  lib[Symbol.dispose]();
  assert.equal((await design.getInfo()).id, D);
  checks++;
  const calls = [...(await worker.stats("design")).calls, ...(await worker.stats("library")).calls];
  const used = new Set(calls.map((call: any) => call.name));
  assert.deepEqual(
    catalog.operations
      .filter((operation) => !used.has(operation.name))
      .map((operation) => operation.name),
    [],
  );
  checks++;

  const oauth = await worker.oauth();
  const principal = { audience: "test-audience", userId: "test-user" };
  const link = await oauth.begin([]);
  const nonce = new URL(link.url).pathname.split("/").at(-1);
  const redirect = await oauth.authorize(nonce, principal);
  const authorization = new URL(redirect.headers.get("location"));
  assert.equal(authorization.origin, "https://www.canva.com");
  assert.equal(authorization.pathname, "/api/oauth/authorize");
  assert.equal(authorization.searchParams.get("scope"), "profile:read");
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authorization.searchParams.has("resource"), false);
  await assert.rejects(async () => oauth.authorize(nonce, principal), /Invalid/);
  checks++;
  await oauth.seed({
    credentials: {
      provider: "canva-rest",
      access_token: "old-test-token",
      refresh_token: "old-refresh",
      expires_at: 0,
      scope: "profile:read",
    },
    patterns: [],
  });
  assert.deepEqual(await oauth.getPatterns(), []);
  assert.deepEqual(await Promise.all([oauth.getAccessToken(), oauth.getAccessToken()]), [
    "new-test-token-1",
    "new-test-token-1",
  ]);
  checks++;
  await oauth.seed({
    stage: {
      stageId: "a".repeat(64),
      credentials: {
        provider: "canva-rest",
        access_token: "staged-test-token",
        expires_at: Date.now() + 3600000,
        scope: "profile:read",
      },
      patterns: [],
      expires: Date.now() + 10000,
    },
  });
  await assert.rejects(async () => oauth.commitReconnect("b".repeat(64)));
  assert.equal(await oauth.getAccessToken(), "new-test-token-1");
  await oauth.commitReconnect("a".repeat(64));
  assert.equal(await oauth.getAccessToken(), "staged-test-token");
  checks++;
  await oauth.revoke();
  await assert.rejects(async () => oauth.getAccessToken(), /revoked/);
  checks++;
  await oauth.runCleanupAlarm();
  await assert.rejects(async () => oauth.begin([]), /revoked/);
  assert.equal(await oauth.inspect("credentials"), undefined);
  checks++;
  return { checks, operations: used.size };
}
