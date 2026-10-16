// Test-only Worker: local, credential-seeded, never referenced by production config.
import { DurableObject, WorkerEntrypoint, RpcTarget, RpcStub } from "cloudflare:workers";
import { Engine, type Scope } from "../src/core";
import { JsonStore } from "../src/storage";
import { McpClient, boundedText, type Data } from "../src/protocol";
import { createSession } from "../src/sessions";
import { resultId } from "../src/core";
import type { ApprovalQueue } from "../research/upstream/gatekeeper";

class Queue extends RpcTarget implements ApprovalQueue {
  constructor(private readonly store: JsonStore) { super(); }
  async submitAction(id: number, description: Data) { this.store.put(`submitted:${id}`, description); }
  async authorizeObservation(description: Data) {
    this.store.put("observations", (this.store.get<number>("observations") ?? 0) + 1);
  }
  async getGitCache(): Promise<never> { throw new Error("Canva does not use the host Git cache"); }
  async bindHook(): Promise<never> { throw new Error("Canva hooks are not supported"); }
}
export class LiveHarness extends DurableObject {
  #engine?: Engine;
  #store = new JsonStore(this.ctx.storage.kv);
  #getEngine() {
    if (!this.#engine) {
      const client = new McpClient(async () => {
        const value = this.#store.get<{ access_token: string; expires_at: number }>("credentials");
        if (!value || value.expires_at <= Date.now()) throw new Error("Live test token expired");
        return value.access_token;
      }, undefined, async (url, init) => {
        const response = await fetch(url, init);
        if (response.headers.get("content-type")?.includes("application/json")) {
          const n = (this.#store.get<number>("http-sequence") ?? 0) + 1;
          this.#store.put("http-sequence", n);
          this.#store.put(`http:${n}`, { request: JSON.parse(String(init?.body)), status: response.status, body: await boundedText(response.clone(), 8 * 1024 * 1024) });
        }
        return response;
      });
      this.#engine = new Engine(this.#store, client, this.#store.get<Scope>("scope")!);
    }
    return this.#engine;
  }
  async setup(credentials: { access_token: string; expires_at: number }, scope: Scope = { kind: "library" }) {
    this.#store.put("credentials", credentials); this.#store.put("scope", scope);
  }
  async restore(snapshot: any) {
    if (this.#store.get("sequence") !== undefined) return;
    for (const action of snapshot.actions) this.#store.put(`action:${action.id}`, action);
    this.#store.put("sequence", Math.max(0, ...snapshot.actions.map((a: any) => a.id)));
    for (const [key, value] of snapshot.submitted) this.#store.put(key, value);
    for (const [key, value] of snapshot.http) this.#store.put(key, value);
    this.#store.put("http-sequence", snapshot.http.length);
  }
  async session() {
    using queue = new RpcStub(new Queue(this.#store));
    return createSession({ engine: this.#getEngine(), queue });
  }
  async apply(id: number) { await this.#getEngine().apply(id); }
  async reject(id: number) { return this.#getEngine().reject(id); }
  async checkpoint() {
    return { actions: this.#getEngine().actions(), submitted: [...this.#store.list({ prefix: "submitted:" })],
      http: [...this.#store.list({ prefix: "http:" })], observations: this.#store.get("observations") ?? 0 };
  }
}
export default class extends WorkerEntrypoint<any> {
  async harness(name: string) { return this.env.LIVE.getByName(name); }
  async step(name: string, step: string, input: any) {
    const h = this.env.LIVE.getByName(name), library: any = await h.session();
    const require = (value: any, message: string) => { if (!value) throw new Error(message); };
    const flush = async () => {
      for (const a of (await h.checkpoint()).actions) {
        if (["unknown", "failed", "applying"].includes(a.state)) throw new Error("Inspect an unresolved previous write before continuing");
        if (a.state === "queued") await h.apply(a.id);
      }
    };
    const complete = async (job: any) => {
      for (let attempt = 0; attempt < 30; attempt++) {
        const state = await job.getStatus();
        if (state.status === "completed") return state.result;
        if (state.status === "failed") throw new Error("Canva job failed: " + state.code);
        await scheduler.wait(Math.min(10, Math.max(1, state.retryAfterSeconds)) * 1000);
      }
      throw new Error("Canva job did not finish; inspect before repeating");
    };
    if (step === "copy") {
      let action = (await h.checkpoint()).actions.find((a: any) => a.tool === "copy-design");
      if (!action) {
        const source = await library.openDesign(input.source);
        const job = await source.copy();
        require((await job.getStatus()).status === "processing", "Copy executed before application");
        await flush();
        const copied = await complete(job);
        return await copied.getInfo();
      }
      await flush(); action = (await h.checkpoint()).actions.find((a: any) => a.id === action.id);
      return await (await library.openDesign(resultId(action.result, "design"))).getInfo();
    }
    if (step === "move") {
      for (const itemId of input.designs) {
        if (!(await h.checkpoint()).actions.some((a: any) => a.tool === "move-item-to-folder" && a.args.item_id === itemId)) await library.moveItem({ itemId, destinationFolderId: input.folder });
        await flush();
      }
      const folder = await library.openFolder(input.folder);
      const items = await (await folder.listItems()).next();
      require(input.designs.every((id: string) => items.some((x: any) => x.type === "design" && x.summary.id === id)), "Moved designs absent from scoped listing");
      return { verified: true };
    }
    const design = await library.openDesign(input.design);
    if (step === "comments") {
      if (!(await h.checkpoint()).actions.some((a: any) => a.tool === "comment-on-design")) {
        const comment = await design.addComment("Disposable Gatekeeper live write verification.");
        await comment.reply("Reply created through a dependent queued action.");
        require((await comment.getInfo()).text === "Disposable Gatekeeper live write verification.", "Comment simulation failed");
      }
      await flush();
      const comments = await (await design.listComments()).next();
      const comment = comments.find((x: any) => x.info.text === "Disposable Gatekeeper live write verification.");
      require(comment, "Saved comment was not returned");
      require((await (await comment.comment.listReplies()).next()).length > 0, "Saved reply missing");
      return { verified: true };
    }
    if (step === "edit" || step === "cancel") {
      const job = await design.beginEdit(); await flush();
      const draft = await complete(job), snapshot = await draft.getSnapshot();
      require(snapshot.pages.length, "Missing editable pages");
      const operations: any[] = [{ type: "setTitle", title: step === "edit" ? input.title : "This title must be cancelled" }];
      if (step === "edit" && snapshot.textElements[0]) operations.push({ type: "replaceText", elementId: snapshot.textElements[0].id, text: "Gatekeeper live write verified" });
      await draft.apply(operations);
      if (step === "edit" && snapshot.textElements[0]) require((await draft.getSnapshot()).textElements[0].text === "Gatekeeper live write verified", "Draft simulation failed");
      await flush();
      let preview;
      if (step === "edit") { preview = await draft.getPreview(snapshot.pages[0].pageNumber); await draft.commit(); }
      else await draft.cancel();
      await flush();
      require((await design.getInfo()).title === input.title, "Saved title mismatch");
      if (step === "edit" && snapshot.textElements[0]) require((await design.getText()).text.includes("Gatekeeper live write verified"), "Saved text mismatch");
      return { verified: true, preview, textEdited: !!snapshot.textElements[0] };
    }
    if (step === "export") {
      const job = await design.export({ format: "pdf" }); await flush();
      const result = await complete(job); require(result.files.length, "No export files");
      const response = await fetch(result.files[0].url, { signal: AbortSignal.timeout(30000) });
      require(response.ok, "Export download failed");
      const reader = response.body!.getReader(); const first = await reader.read(); await reader.cancel();
      require(new TextDecoder().decode(first.value?.slice(0, 5)) === "%PDF-", "Not a PDF export");
      return { verified: true };
    }
    throw new Error("Unknown live test step");
  }
}
