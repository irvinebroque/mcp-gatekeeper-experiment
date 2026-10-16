import test from "node:test";
import assert from "node:assert/strict";
import { Engine } from "../src/engine";
import type { Store } from "../src/engine/types";
import { parseResource, publicSource } from "../src/resources";
import { CanvaRestClient } from "../src/canva/client";
import { validateOperation } from "../src/canva/operations";
import { boundedText, type Data } from "../src/json";
import { connectHandoffPageHtml } from "../src/connect-pages";
import { JsonStore } from "../src/storage";
import { DESIGN_ID as D, design, thread } from "./fixtures";

class Memory implements Store {
  data = new Map<string, any>();
  get<T>(key: string): T | undefined {
    return structuredClone(this.data.get(key));
  }
  put(key: string, value: unknown) {
    this.data.set(key, structuredClone(value));
  }
  delete(key: string) {
    return this.data.delete(key);
  }
  list<T>({ prefix }: { prefix: string }): Map<string, T> {
    return new Map(
      [...this.data].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v)]),
    );
  }
}
const queue = { authorizeObservation: async () => {}, submitAction: async () => {} };
const actionInput = () => ({ path: { designId: D }, body: { message_plaintext: "hello" } });
const targets = [{ kind: "design" as const, id: D }];
const library = { kind: "library" as const };

// These tests exercise the journal independently of RPC and network fixtures.
test("submission captures input without writing; application is idempotent", async () => {
  const sent: Data[] = [];
  const engine = new Engine(
    new Memory(),
    {
      call: async (operation, input) => {
        sent.push({ operation, input });
        return { thread: thread() };
      },
    },
    library,
  );
  const input = actionInput();
  const n = await engine.submit(queue, "createThread", input, targets);
  input.body.message_plaintext = "tampered";
  assert.equal(sent.length, 0);
  await engine.apply(n);
  await engine.apply(n);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].input.body.message_plaintext, "hello");
});
test("ambiguous failure and crash recovery never replay writes", async () => {
  const store = new Memory();
  let calls = 0;
  const client = {
    call: async () => {
      calls++;
      throw new Error("timeout after write");
    },
  };
  const engine = new Engine(store, client, library);
  const n = await engine.submit(queue, "createThread", actionInput(), targets);
  await assert.rejects(engine.apply(n), /unknown/);
  await assert.rejects(engine.apply(n), /cannot be replayed/);
  store.put(`action:${n}`, { ...engine.action(n), state: "applying" });
  const restarted = new Engine(store, client, library);
  assert.equal(restarted.action(n).state, "unknown");
  await assert.rejects(restarted.apply(n));
  assert.equal(calls, 1);
});
test("old MCP action journals require a fresh resource connection", () => {
  const store = new Memory();
  store.put("action:1", { id: 1, state: "queued", tool: "comment-on-design" });
  assert.throws(() => new Engine(store, { call: async () => ({}) }, library), /old action journal/);
});
test("new actions depend on concurrent in-flight writes", async () => {
  let release!: () => void;
  const engine = new Engine(
    new Memory(),
    {
      call: async () => {
        await new Promise<void>((r) => {
          release = r;
        });
        return { thread: thread() };
      },
    },
    library,
  );
  const first = await engine.submit(queue, "createThread", actionInput(), targets);
  const applying = engine.apply(first);
  await new Promise((r) => setTimeout(r, 0));
  const second = await engine.submit(queue, "createThread", actionInput(), targets);
  assert.deepEqual(engine.action(second).dependsOn, [first]);
  await assert.rejects(engine.apply(second), /dependencies/);
  release();
  await applying;
});
test("folder membership is rechecked at application and after a read", async () => {
  let member = true,
    writes = 0;
  const engine = new Engine(
    new Memory(),
    {
      call: async (operation) => {
        if (operation === "listFolderItems")
          return { items: member ? [{ type: "design", design: design() }] : [] };
        if (operation === "getDesign") {
          member = false;
          return { design: design() };
        }
        writes++;
        return {};
      },
    },
    { kind: "folder", id: "folder" },
  );
  const n = await engine.submit(queue, "createThread", actionInput(), targets);
  member = false;
  await assert.rejects(engine.apply(n), /outside/);
  assert.equal(writes, 0);
  member = true;
  let observed = false;
  await assert.rejects(
    engine.observe(
      {
        ...queue,
        authorizeObservation: async () => {
          observed = true;
        },
      },
      "getDesign",
      { path: { designId: D } },
      targets,
    ),
    /outside/,
  );
  assert.equal(observed, false);
});
test("a narrowed folder excludes siblings and checks its ancestor", async () => {
  let attached = true;
  const client = {
    call: async (_operation: string, input: Data) => ({
      items:
        input.path.folderId === "parent"
          ? attached
            ? [
                { type: "folder", folder: { id: "child" } },
                { type: "design", design: { id: "sibling" } },
              ]
            : []
          : [{ type: "design", design: design() }],
    }),
  };
  const child = new Engine(new Memory(), client, { kind: "folder", id: "parent" }).narrowFolder(
    "child",
  );
  await child.checkTarget(targets[0]);
  await assert.rejects(child.checkTarget({ kind: "design", id: "sibling" }));
  attached = false;
  await assert.rejects(child.checkTarget(targets[0]));
});
test("provisional references resolve privately; rejection invalidates dependents", async () => {
  const sent: Data[] = [];
  const engine = new Engine(
    new Memory(),
    {
      call: async (_name, input) => {
        sent.push(input);
        return { thread: thread("c1") };
      },
    },
    library,
  );
  const first = await engine.submit(queue, "createThread", actionInput(), targets);
  const second = await engine.submit(
    queue,
    "createReply",
    {
      path: { designId: D, threadId: { action: first, kind: "comment" } },
      body: { message_plaintext: "reply" },
    },
    targets,
  );
  await assert.rejects(engine.apply(second), /dependencies/);
  await engine.apply(first);
  await engine.apply(second);
  assert.equal(sent[1].path.threadId, "c1");
  const third = await engine.submit(queue, "createThread", actionInput(), targets);
  const fourth = await engine.submit(queue, "createThread", actionInput(), targets);
  engine.reject(third);
  assert.equal(engine.action(fourth).state, "rejected");
  await assert.rejects(engine.apply(fourth));
});
test("rejection racing with membership verification prevents the write", async () => {
  let release: (() => void) | undefined,
    delay = false,
    writes = 0;
  const engine = new Engine(
    new Memory(),
    {
      call: async (operation) => {
        if (operation === "listFolderItems") {
          if (delay)
            await new Promise<void>((r) => {
              release = r;
            });
          return { items: [{ type: "design", design: design() }] };
        }
        writes++;
        return {};
      },
    },
    { kind: "folder", id: "f" },
  );
  const n = await engine.submit(queue, "createThread", actionInput(), targets);
  delay = true;
  const applying = engine.apply(n);
  await new Promise((r) => setTimeout(r, 0));
  engine.reject(n);
  release!();
  await assert.rejects(applying, /changed/);
  assert.equal(writes, 0);
});
test("unreviewed operations, invalid inputs, and cross-grant IDs fail closed", async () => {
  assert.throws(() => validateOperation("tools/call", {}), /Unreviewed/);
  assert.throws(() =>
    validateOperation("getDesign", { path: { designId: D }, endpoint: "https://evil.test" }),
  );
  const engine = new Engine(
    new Memory(),
    { call: async () => ({}) },
    { kind: "design", id: D, locator: D },
  );
  await assert.rejects(engine.checkTarget({ kind: "design", id: "Dotherother" }));
  await assert.rejects(engine.readInternal("createThread", actionInput()), /Writes require/);
  for (const url of [
    "https://www.canva.com.evil/design/x",
    "https://user@www.canva.com/",
    "https://www.canva.com/folder/f?scope=all",
  ])
    assert.throws(() => parseResource(url));
  for (const url of [
    "http://example.com/a",
    "https://127.0.0.1/a",
    "https://[::1]/a",
    "https://intranet.local/a",
    "https://x:y@example.com/a",
  ])
    assert.throws(() => publicSource(url));
});
test("cache hits still authorize observations; revocation blocks reads and staging", async () => {
  let revoked = false,
    calls = 0;
  const engine = new Engine(
    new Memory(),
    {
      call: async () => {
        calls++;
        return { design: design() };
      },
      ensureActive: async () => {
        if (revoked) throw new Error("revoked");
      },
    },
    library,
  );
  const read = (q = queue) =>
    engine.observe(q, "getDesign", { path: { designId: D } }, targets, { cache: true });
  await read();
  await assert.rejects(
    read({
      ...queue,
      authorizeObservation: async () => {
        throw new Error("denied");
      },
    }),
    /denied/,
  );
  assert.equal(calls, 1);
  revoked = true;
  await assert.rejects(read(), /revoked/);
  await assert.rejects(engine.submit(queue, "createThread", actionInput(), targets), /revoked/);
});
test("ordinary text cannot contain provisional references", async () => {
  const engine = new Engine(new Memory(), { call: async () => ({}) }, library);
  const n = await engine.submit(queue, "createThread", actionInput(), targets);
  await assert.rejects(
    engine.submit(
      queue,
      "createReply",
      {
        path: { designId: D, threadId: { action: n, kind: "comment" } },
        body: { message_plaintext: { action: n, kind: "comment" } },
      },
      targets,
    ),
    /reference location/,
  );
});
test("REST jobs block dependent writes until success; failed jobs stay blocked", async () => {
  for (const status of ["success", "failed"]) {
    const store = new Memory();
    const engine = new Engine(
      store,
      {
        call: async (operation) =>
          operation === "createUrlImportJob"
            ? { job: { id: "job1", status: "in_progress" } }
            : { job: { id: "job1", status } },
      },
      library,
    );
    const n = await engine.submit(
      queue,
      "createUrlImportJob",
      { body: { url: "https://example.com/a.pdf", title: "Import" } },
      [],
    );
    const dependent = await engine.submit(queue, "createThread", actionInput(), targets);
    await engine.apply(n);
    assert.equal(engine.action(n).state, "running");
    await assert.rejects(engine.apply(n), /cannot be replayed/);
    await assert.rejects(engine.apply(dependent), /dependencies/);
    store.put(`action:${n}`, { ...engine.action(n), nextPoll: 0 });
    await engine.poll(queue, n);
    assert.equal(engine.action(n).state, status === "success" ? "applied" : "failed");
    if (status === "failed") await assert.rejects(engine.apply(dependent), /dependencies/);
    else await engine.apply(dependent);
  }
});
test("job polling uses the reviewed path and rejects another job's result", async () => {
  const store = new Memory();
  let sent: Data | undefined;
  const engine = new Engine(
    store,
    {
      call: async (operation, input) => {
        if (operation === "createDesignExportJob")
          return { job: { id: "export1", status: "in_progress" } };
        sent = input;
        return { job: { id: "other", status: "success" } };
      },
    },
    library,
  );
  const n = await engine.submit(
    queue,
    "createDesignExportJob",
    { body: { design_id: D, format: { type: "pdf" } } },
    targets,
  );
  await engine.apply(n);
  store.put(`action:${n}`, { ...engine.action(n), nextPoll: 0 });
  await assert.rejects(engine.poll(queue, n), /different job/);
  assert.deepEqual(sent, { path: { exportId: "export1" } });
  assert.equal(engine.action(n).state, "running");
});
test("REST transport uses fixed origin, encoded queries, bearer auth, and no redirects", async () => {
  const requests: { url: URL; init: RequestInit }[] = [];
  const client = new CanvaRestClient(
    async () => "test-token",
    async (url, init) => {
      requests.push({ url: new URL(String(url)), init: init! });
      return Response.json({ items: [] });
    },
  );
  await client.call("listFolderItems", {
    path: { folderId: "folder" },
    query: { item_types: ["design", "folder"] },
  });
  assert.equal(requests[0].url.origin, "https://api.canva.com");
  assert.equal(requests[0].url.pathname, "/rest/v1/folders/folder/items");
  assert.equal(requests[0].url.searchParams.get("item_types"), "design,folder");
  assert.equal(requests[0].init.redirect, "manual");
  assert.equal(new Headers(requests[0].init.headers).get("authorization"), "Bearer test-token");
});
test("REST transport sends JSON bodies, handles 204, and rejects malformed outputs", async () => {
  const client = new CanvaRestClient(
    async () => "token",
    async (_url, init) => {
      assert.deepEqual(JSON.parse(String(init?.body)), { item_id: D, to_folder_id: "root" });
      return new Response(null, { status: 204 });
    },
  );
  assert.deepEqual(
    await client.call("moveFolderItem", { body: { item_id: D, to_folder_id: "root" } }),
    {},
  );
  for (const response of [
    new Response(null, { status: 302, headers: { location: "https://evil.test" } }),
    Response.json({ design: { id: D } }),
  ]) {
    let calls = 0;
    const invalid = new CanvaRestClient(
      async () => "token",
      async () => {
        calls++;
        return response;
      },
    );
    await assert.rejects(invalid.call("getDesign", { path: { designId: D } }));
    assert.equal(calls, 1);
  }
});
test("bounded responses cancel oversized streams", async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(100));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(boundedText(new Response(stream), 10));
  assert.ok(cancelled);
});
test("handoff uses an exact origin and script data cannot escape", () => {
  assert.throws(() =>
    connectHandoffPageHtml({ targetOrigin: "https://example.com/steal", ticket: "x" }),
  );
  const html = connectHandoffPageHtml({
    targetOrigin: "https://example.com",
    ticket: "</script><script>alert(1)</script>",
  });
  assert.ok(!html.includes("</script><script>"));
  assert.ok(html.includes("/connect/handoff#"));
});
test("large JSON records are chunked and deleted without orphans", () => {
  const backing = new Memory(),
    store = new JsonStore(backing);
  const value = { text: "🦊".repeat(100000) };
  store.put("large", value);
  assert.deepEqual(store.get("large"), value);
  for (const data of backing.data.values())
    assert.ok(Buffer.byteLength(JSON.stringify(data)) < 128 * 1024);
  store.put("large", { text: "small" });
  assert.equal(backing.data.size, 2);
  store.delete("large");
  assert.equal(backing.data.size, 0);
});
