// Test-only Worker. Never imported by the production entrypoint or Cloudflare config.
import { DurableObject, WorkerEntrypoint, RpcTarget, RpcStub } from "cloudflare:workers";
import { Engine, type Scope } from "../src/core";
import { createSession } from "../src/sessions";
import { validate, type Data } from "../src/protocol";
import { UserAccount } from "../auth/account";
import { JsonStore } from "../src/storage";
import { runScenarios } from "./scenarios";
export { CanvaUser, CanvaVerifier, CanvaGatekeeper, GatekeeperVendor } from "../src/index";
export { UserAccount };
const D = "Dabcdefghij", OTHER = "D1234567890";
const design = (key = D) => ({ id: key, title: "Fixture", urls: { edit_url: `https://www.canva.com/design/${key}/edit` }, page_count: 2 });
const page = (n: number) => ({ page_id: `page${n}`, page_number: n, is_responsive: false, is_empty: false, is_editable: true, dimension: { width: 100, height: 100 } });
const snapshot = () => ({ transaction: { transaction_id: "txn1", status: "open" }, pages: [page(1), page(2)], richtexts: [{ element_id: "text1", page_index: 1, regions: [{ type: "character", text: "Original" }] }], fills: [{ element_id: "image2", page_index: 2, type: "image", editable: true }] });

class Queue extends RpcTarget {
  #store: any;
  constructor(store: any) { super(); this.#store = store; }
  async authorizeObservation(description: Data) {
    if (this.#store.get("deny")) throw new Error("Observation denied");
    this.#store.put("observations", (this.#store.get("observations") ?? 0) + 1);
  }
  async submitAction(n: number, description: Data) { this.#store.put(`submitted:${n}`, description); }
}
export class Harness extends DurableObject {
  #engine?: Engine;
  async #call(name: string, args: Data): Promise<Data> {
    validate(name, args);
    const calls = this.ctx.storage.kv.get<Data[]>("calls") ?? [];
    calls.push({ name, args }); this.ctx.storage.kv.put("calls", calls);
    const scope = this.ctx.storage.kv.get<Scope>("scope")!;
    switch (name) {
      case "get-design": return { design: design(String(args.design_id).includes(OTHER) ? OTHER : D) };
      case "search-designs": return { items: [{ ...design(), design_id: D }], continuation: args.continuation ? undefined : "next" };
      case "search-folders": return { items: [{ id: "folder", name: "Folder" }] };
      case "list-folder-items": {
        const newFolders = calls.filter(c => c.name === "create-folder" && c.args.parent_folder_id === args.folder_id).map((c, i) => ({ type: "folder", folder: { id: `newfolder${i}`, name: c.args.name } }));
        return { items: [...(args.folder_id === "folder" ? [{ type: "folder", folder: { id: "child", name: "Child" } }, { type: "design", design: design(OTHER) }] : args.folder_id === "child" && !this.ctx.storage.kv.get("detached") ? [{ type: "design", design: design() }, { type: "image", image: { id: "asset1", name: "Image", type: "image", tags: [] } }] : []), ...newFolders] };
      }
      case "get-design-content": return { text: "Original" };
      case "get-design-pages": return { items: [1, 2].map(n => ({ id: `p${n}`, page_number: n, dimensions: { width: 100, height: 100 } })) };
      case "get-presenter-notes": return { notes: [{ page_number: 1, text: "Notes" }] };
      case "get-export-formats": return { formats: { pdf: {}, png: {} } };
      case "get-design-dataset": case "get-brand-template-dataset": return { dataset: { label: { type: "text" } } };
      case "list-comments": return { items: calls.filter(c => c.name === "comment-on-design").map((c, i) => ({ id: `comment${i}`, thread_type: { content: { plaintext: c.args.message_plaintext } } })) };
      case "list-replies": return { items: [] };
      case "get-assets": return { assets: args.asset_ids.map((id: string) => ({ id, name: "Image", type: "image", tags: [] })) };
      case "search-brand-templates": return { items: [{ id: "template1", title: "Template" }] };
      case "list-brand-kits": return { items: [{ id: "kit1", name: "Kit" }] };
      case "resolve-shortlink": return { target_url: `https://www.canva.com/design/${D}/token/edit` };
      case "create-folder": return { folder: { id: `newfolder${calls.filter(c => c.name === name).length - 1}`, name: args.name } };
      case "comment-on-design": return { thread: { id: `comment${calls.filter(c => c.name === name).length - 1}` } };
      case "reply-to-comment": case "move-item-to-folder": return {};
      case "copy-design": case "create-design-from-brand-template": case "create-brand-template-draft": return { design: design() };
      case "merge-designs": case "resize-design": return { job: { id: "job1", status: "success", result: { design: design() } } };
      case "import-design-from-url": return { job: { id: "job1", status: "success", result: { designs: [design()] } } };
      case "upload-asset-from-url": return { job: { id: "job1", status: "success", asset_id: "asset1" } };
      case "export-design": return { job: { id: "job1", status: "success", urls: ["https://example.com/export.pdf"] } };
      case "publish-brand-template": return { brand_template: { id: "template1" } };
      case "create-design": case "separate-image-layers": return { status: "pending", job_id: "job1", continuation_token: "private-token", polling_policy: { wait_seconds: 1, instructions: "Wait" } };
      case "get-create-design-async-job": case "get-separate-image-layers-job": return { status: "completed", job_id: "job1", design: { id: D, url: `https://www.canva.com/design/${D}/edit` } };
      case "generate-image": return { jobId: "imagejob1" };
      case "get-generate-image-job": return { status: "SUCCESS", result: { results: [{ id: "asset1", type: "MEDIA", accessToken: "private-token" }] } };
      case "remove-background": return { results: [{ id: "asset1", type: "MEDIA" }] };
      case "start-editing-transaction": return snapshot();
      case "perform-editing-operations": {
        const s = snapshot();
        for (const op of args.operations) if (op.type === "replace_text") s.richtexts[0].regions[0].text = op.text;
        return { ...s, edit_operation_results: args.operations.map((op: Data) => ({ status: "success", operation_info: op })) };
      }
      case "get-design-thumbnail": return { thumbnail: { url: "https://example.com/preview.png", width: 100, height: 100 } };
      case "commit-editing-transaction": return { transaction: { id: "txn1", status: "committed" } };
      case "cancel-editing-transaction": return { transaction: { id: "txn1", status: "cancelled" } };
      default: throw new Error(`Unmocked tool: ${name}`);
    }
  }
  async open(scope: Scope) {
    this.ctx.storage.kv.put("scope", scope);
    this.#engine ??= new Engine(new JsonStore(this.ctx.storage.kv), { call: (n, a) => this.#call(n, a) }, scope);
    using queue = new RpcStub(new Queue(this.ctx.storage.kv));
    return createSession({ engine: this.#engine, queue });
  }
  async applyAll() { for (const a of this.#engine!.pending()) await this.#engine!.apply(a.id); }
  async readyJobs() { for (const a of this.#engine!.actions()) this.#engine!.store.put(`action:${a.id}`, { ...a, nextPoll: 0 }); }
  async control(key: string, value: boolean) { this.ctx.storage.kv.put(key, value); }
  async stats() { return { calls: this.ctx.storage.kv.get("calls") ?? [], observations: this.ctx.storage.kv.get("observations") ?? 0, actions: this.#engine?.actions() ?? [] }; }
}
export class OAuthHarness extends UserAccount {
  async seed(value: Data) { for (const [k, v] of Object.entries(value)) this.ctx.storage.kv.put(k, v); }
  async inspect(key: string) { return this.ctx.storage.kv.get(key); }
  async runCleanupAlarm() { await this.alarm(); }
}
export default class extends WorkerEntrypoint<any> {
  async run() { return runScenarios(this); }
  async session(name: string, scope: Scope) { return this.env.TEST.getByName(name).open(scope); }
  async applyAll(name: string) { await this.env.TEST.getByName(name).applyAll(); }
  async readyJobs(name: string) { await this.env.TEST.getByName(name).readyJobs(); }
  async stats(name: string) { return this.env.TEST.getByName(name).stats(); }
  async control(name: string, key: string, value: boolean) { await this.env.TEST.getByName(name).control(key, value); }
  async oauth() { return this.env.OAUTH.getByName("test"); }
}
