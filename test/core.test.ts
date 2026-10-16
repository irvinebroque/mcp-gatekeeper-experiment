import test from "node:test";
import assert from "node:assert/strict";
import { Engine, parseResource, publicSource, type Store, type Action } from "../src/core";
import { McpClient, rpcResponse, validate, type Data } from "../src/protocol";
import { connectHandoffPageHtml } from "../src/connect-pages";
import { JsonStore } from "../src/storage";

class Memory implements Store {
  data = new Map<string, any>();
  get<T>(key: string): T | undefined { return structuredClone(this.data.get(key)); }
  put(key: string, value: unknown) { this.data.set(key, structuredClone(value)); }
  delete(key: string) { return this.data.delete(key); }
  list<T>({ prefix }: { prefix: string }): Map<string, T> { return new Map([...this.data].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v)])); }
}
const D = "Dabcdefghij";
const queue = { authorizeObservation: async () => {}, submitAction: async () => {} };
const actionArgs = { design_id: D, message_plaintext: "hello" };
const targets = [{ kind: "design" as const, id: D }];

test("submission performs no write; application is idempotent and uses captured arguments", async () => {
  const sent: Data[] = [], store = new Memory();
  const engine = new Engine(store, { call: async (tool, args) => { sent.push({ tool, args }); return { thread: { id: "comment1" } }; } }, { kind: "library" });
  const args = { ...actionArgs };
  const n = await engine.submit(queue, "comment-on-design", args, targets);
  args.message_plaintext = "tampered";
  assert.equal(sent.length, 0);
  await engine.apply(n); await engine.apply(n);
  assert.equal(sent.length, 1); assert.equal(sent[0].args.message_plaintext, "hello");
});
test("ambiguous network failure and crash recovery never replay writes", async () => {
  const store = new Memory(); let calls = 0;
  const client = { call: async () => { calls++; throw new Error("timeout after write"); } };
  const e = new Engine(store, client, { kind: "library" });
  const n = await e.submit(queue, "comment-on-design", actionArgs, targets);
  await assert.rejects(e.apply(n), /unknown/); await assert.rejects(e.apply(n), /cannot be replayed/);
  assert.equal(calls, 1);
  store.put(`action:${n}`, { ...e.action(n), state: "applying" });
  const restarted = new Engine(store, client, { kind: "library" });
  assert.equal(restarted.action(n).state, "unknown"); await assert.rejects(restarted.apply(n));
  assert.equal(calls, 1);
});
test("new actions depend on in-flight writes across concurrent sessions", async () => {
  let release!: () => void;
  const e = new Engine(new Memory(), { call: async () => { await new Promise<void>(r => { release = r; }); return {}; } }, { kind: "library" });
  const first = await e.submit(queue, "comment-on-design", actionArgs, targets);
  const applying = e.apply(first);
  await new Promise(r => setTimeout(r, 0));
  const second = await e.submit(queue, "comment-on-design", actionArgs, targets);
  assert.deepEqual(e.action(second).depends, [first]);
  await assert.rejects(e.apply(second), /dependencies/);
  release(); await applying;
});
test("folder membership is rechecked at application and after a read", async () => {
  let member = true, writes = 0;
  const client = { call: async (name: string) => {
    if (name === "list-folder-items") return { items: member ? [{ type: "design", design: { id: D } }] : [] };
    if (name === "get-design-content") { member = false; return { text: "private" }; }
    writes++; return {};
  } };
  const e = new Engine(new Memory(), client, { kind: "folder", id: "folder" });
  const n = await e.submit(queue, "comment-on-design", actionArgs, targets);
  member = false; await assert.rejects(e.apply(n), /outside/); assert.equal(writes, 0);
  member = true; let observed = false;
  await assert.rejects(e.read({ ...queue, authorizeObservation: async () => { observed = true; } }, "get-design-content", { design_id: D, content_types: ["richtexts"] }, targets), /outside/);
  assert.equal(observed, false);
});
test("a narrowed folder cannot open siblings or survive removal from its ancestor", async () => {
  let attached = true;
  const client = { call: async (_name: string, a: Data) => ({ items: a.folder_id === "parent" ? (attached ? [{ type: "folder", folder: { id: "child" } }, { type: "design", design: { id: "sibling" } }] : []) : [{ type: "design", design: { id: D } }] }) };
  const child = new Engine(new Memory(), client, { kind: "folder", id: "parent" }).narrowFolder("child");
  await child.check(targets[0]); await assert.rejects(child.check({ kind: "design", id: "sibling" }));
  attached = false; await assert.rejects(child.check(targets[0]));
});
test("provisional dependencies resolve privately; rejection invalidates dependants", async () => {
  const sent: Data[] = [], store = new Memory();
  const e = new Engine(store, { call: async (name, args) => { sent.push(args); return name === "comment-on-design" ? { thread: { id: "c1" } } : {}; } }, { kind: "library" });
  const a = await e.submit(queue, "comment-on-design", actionArgs, targets);
  const b = await e.submit(queue, "reply-to-comment", { ...actionArgs, comment_id: { action: a, kind: "comment" } }, targets);
  await assert.rejects(e.apply(b), /dependencies/);
  await e.apply(a); await e.apply(b); assert.equal(sent[1].comment_id, "c1");
  const x = await e.submit(queue, "comment-on-design", actionArgs, targets);
  const y = await e.submit(queue, "comment-on-design", actionArgs, targets);
  e.reject(x); assert.equal(e.action(y).state, "rejected"); await assert.rejects(e.apply(y));
});
test("reject racing with membership verification prevents the write", async () => {
  let hold: (() => void) | undefined, delay = false, writes = 0;
  const e = new Engine(new Memory(), { call: async (name) => {
    if (name === "list-folder-items") { if (delay) await new Promise<void>(r => { hold = r; }); return { items: [{ type: "design", design: { id: D } }] }; }
    writes++; return {};
  } }, { kind: "folder", id: "f" });
  const n = await e.submit(queue, "comment-on-design", actionArgs, targets);
  delay = true; const applying = e.apply(n);
  await new Promise(r => setTimeout(r, 0)); e.reject(n); hold!();
  await assert.rejects(applying, /changed/); assert.equal(writes, 0);
});
test("unknown tools, invalid schema variants and cross-grant IDs fail closed", async () => {
  assert.throws(() => validate("track-event-lifecycle", {}), /Unreviewed/);
  assert.throws(() => validate("comment-on-design", { ...actionArgs, unexpected: true }));
  const e = new Engine(new Memory(), { call: async () => ({}) }, { kind: "design", id: D, locator: D });
  await assert.rejects(e.check({ kind: "design", id: "Dotherother" }));
  await assert.rejects(e.raw("export-design", {}));
  for (const url of ["https://www.canva.com.evil/design/x", "https://user@www.canva.com/", "https://www.canva.com/folder/f?scope=all"]) assert.throws(() => parseResource(url));
  for (const url of ["http://example.com/a", "https://127.0.0.1/a", "https://[::1]/a", "https://intranet.local/a", "https://x:y@example.com/a"]) assert.throws(() => publicSource(url));
});
test("authorization denial prevents observation; cache hits still authorize", async () => {
  const e = new Engine(new Memory(), { call: async () => ({ design: { id: D } }) }, { kind: "library" });
  await e.read(queue, "get-design", { design_id: D }, targets, true);
  await assert.rejects(e.read({ ...queue, authorizeObservation: async () => { throw new Error("denied"); } }, "get-design", { design_id: D }, targets, true), /denied/);
});
test("SSE reader stops on matching ID without waiting for stream closure", async () => {
  let cancelled = false;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"jsonrpc":"2.0","id":2,"result":{"ok":true}}\n\n')); }, cancel() { cancelled = true; } });
  assert.equal((await rpcResponse(new Response(stream, { headers: { "content-type": "text/event-stream" } }), 2)).result.ok, true);
  assert.equal(cancelled, true);
});
test("MCP transport handles multi-block assets and excludes bearer metadata", async () => {
  const client = new McpClient(async () => "test-token", "https://mcp.canva.com/mcp", async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
    const result = request.method === "initialize" ? {} : { content: [ { type: "text", text: JSON.stringify({ asset: { id: "one", name: "one" } }) }, { type: "image", data: "not-returned" }, { type: "text", text: JSON.stringify({ asset: { id: "two", name: "two" } }) } ], _meta: { token: "never-return" } };
    return Response.json({ jsonrpc: "2.0", id: request.id, result });
  });
  assert.deepEqual(await client.call("get-assets", { asset_ids: ["one", "two"] }), { assets: [{ id: "one", name: "one" }, { id: "two", name: "two" }] });
});
test("handoff destination is an exact origin and script data cannot escape", () => {
  assert.throws(() => connectHandoffPageHtml({ targetOrigin: "https://example.com/steal", ticket: "x" }));
  const html = connectHandoffPageHtml({ targetOrigin: "https://example.com", ticket: '</script><script>alert(1)</script>' });
  assert.ok(!html.includes('</script><script>')); assert.ok(html.includes("/connect/handoff#"));
});
test("large JSON records are chunked, replaced, and deleted without orphan records", () => {
  const backing = new Memory(), store = new JsonStore(backing);
  const value = { text: "🦊".repeat(100000) };
  store.put("large", value);
  assert.deepEqual(store.get("large"), value);
  for (const data of backing.data.values()) assert.ok(Buffer.byteLength(JSON.stringify(data)) < 128 * 1024);
  store.put("large", { text: "small" });
  assert.equal(backing.data.size, 2); store.delete("large"); assert.equal(backing.data.size, 0);
});
test("revocation prevents cached reads and locally staged actions", async () => {
  let revoked = false;
  const e = new Engine(new Memory(), { call: async () => ({ design: { id: D } }), ensureActive: async () => { if (revoked) throw new Error("revoked"); } }, { kind: "library" });
  await e.read(queue, "get-design", { design_id: D }, targets, true); revoked = true;
  await assert.rejects(e.read(queue, "get-design", { design_id: D }, targets, true), /revoked/);
  await assert.rejects(e.submit(queue, "comment-on-design", actionArgs, targets), /revoked/);
});
test("a caller cannot inject provisional references through ordinary text fields", async () => {
  const e = new Engine(new Memory(), { call: async () => ({}) }, { kind: "library" });
  const n = await e.submit(queue, "comment-on-design", actionArgs, targets);
  await assert.rejects(e.submit(queue, "reply-to-comment", { design_id: D, comment_id: { action: n, kind: "comment" }, message_plaintext: { action: n, kind: "comment" } }, targets), /reference location/);
});
test("partial editing failure is recorded and blocks dependent commits", async () => {
  const e = new Engine(new Memory(), { call: async () => ({ edit_operation_results: [{ status: "failed" }] }) }, { kind: "library" });
  const n = await e.submit(queue, "perform-editing-operations", { transaction_id: "txn", page_index: 1, operations: [{ type: "update_title", title: "new" }] }, targets);
  const commit = await e.submit(queue, "commit-editing-transaction", { transaction_id: "txn" }, targets);
  await assert.rejects(e.apply(n), /failure/); assert.equal(e.action(n).state, "failed");
  await assert.rejects(e.apply(commit), /dependencies/);
});
test("live-style flattened design text is normalized without parsing errors", async () => {
  const client = new McpClient(async () => "fixture", undefined, async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
    return Response.json({ id: request.id, result: request.method === "initialize" ? {} : { content: [{ type: "text", text: "Plain design text" }] } });
  });
  assert.deepEqual(await client.call("get-design-content", { design_id: D, content_types: ["richtexts"] }), { text: "Plain design text" });
});
