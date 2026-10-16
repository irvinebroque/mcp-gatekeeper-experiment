// Test-only Worker. Never imported by production entrypoints.
import { DurableObject, WorkerEntrypoint, RpcTarget, RpcStub } from "cloudflare:workers";
import { Engine } from "../src/engine";
import type { Scope } from "../src/resources";
import { createSession } from "../src/sessions";
import { operationFor, validateOperation } from "../src/canva/operations";
import type { Data } from "../src/json";
import { UserAccount } from "../auth/account";
import { JsonStore } from "../src/storage";
import { runScenarios } from "./scenarios";
import {
  DESIGN_ID,
  OTHER_DESIGN_ID,
  design,
  folder,
  asset,
  thread,
  reply,
  template,
  completedJob,
} from "./fixtures";
export { CanvaUser, CanvaVerifier, CanvaGatekeeper, GatekeeperVendor } from "../src/index";
export { UserAccount };

class Queue extends RpcTarget {
  #store: any;
  constructor(store: any) {
    super();
    this.#store = store;
  }
  async authorizeObservation(_description: Data) {
    if (this.#store.get("deny")) throw new Error("Observation denied");
    this.#store.put("observations", (this.#store.get("observations") ?? 0) + 1);
  }
  async submitAction(id: number, description: Data) {
    this.#store.put(`submitted:${id}`, description);
  }
}

export class Harness extends DurableObject {
  #engine?: Engine;
  async #call(name: string, input: Data): Promise<Data> {
    validateOperation(name, input);
    const calls = this.ctx.storage.kv.get<Data[]>("calls") ?? [];
    calls.push({ name, input });
    this.ctx.storage.kv.put("calls", calls);
    const result = this.#response(name, input, calls);
    validateOperation(name, result, true);
    return result;
  }
  #response(name: string, input: Data, calls: Data[]): Data {
    const operation = operationFor(name);
    if (operation.poll) {
      const jobId = `job${calls.length}`;
      this.ctx.storage.kv.put(`job:${jobId}`, completedJob(name, input, jobId));
      return { job: { id: jobId, status: "in_progress" } };
    }
    if (name.startsWith("get") && /Job/.test(name)) {
      const jobId = Object.values(input.path)[0];
      return this.ctx.storage.kv.get<Data>(`job:${jobId}`)!;
    }
    switch (name) {
      case "getDesign":
        return { design: design(input.path.designId) };
      case "listDesigns":
        return {
          items: [design()],
          ...(input.query?.continuation ? {} : { continuation: "next" }),
        };
      case "getFolder":
        return { folder: folder(input.path.folderId) };
      case "listFolderItems": {
        const folderId = input.path.folderId;
        const newFolders = calls
          .filter(
            (call) => call.name === "createFolder" && call.input.body.parent_folder_id === folderId,
          )
          .map((call) => ({
            type: "folder",
            folder: folder(
              `newfolder${calls.filter((c) => c.name === "createFolder").indexOf(call)}`,
              call.input.body.name,
            ),
          }));
        const existing =
          folderId === "folder"
            ? [
                { type: "folder", folder: folder("child", "Child") },
                { type: "design", design: design(OTHER_DESIGN_ID) },
              ]
            : folderId === "child" && !this.ctx.storage.kv.get("detached")
              ? [
                  { type: "design", design: design() },
                  { type: "image", image: asset() },
                ]
              : [];
        return { items: [...existing, ...newFolders] };
      }
      case "getDesignPages":
        return {
          items: [1, 2].map((n) => ({
            index: n,
            page_number: n,
            design_type: "presentation",
            dimensions: { width: 100, height: 100 },
          })),
        };
      case "getDesignExportFormats":
        return { formats: { pdf: { page_numbers: [1, 2] }, png: {}, svg: {} } };
      case "getDesignDataset":
      case "getBrandTemplateDataset":
        return { dataset: { label: { type: "text" } } };
      case "getThread":
        return { thread: thread(input.path.threadId) };
      case "listReplies":
        return {
          items: calls
            .filter((call) => call.name === "createReply")
            .map((call) => reply(call.input.body.message_plaintext)),
        };
      case "getAsset":
        return { asset: asset(input.path.assetId) };
      case "listBrandTemplates":
        return { items: [template()] };
      case "getBrandTemplate":
        return { brand_template: template() };
      case "createFolder":
        return {
          folder: folder(
            `newfolder${calls.filter((call) => call.name === name).length - 1}`,
            input.body.name,
          ),
        };
      case "createThread":
        return { thread: thread("comment1", input.body.message_plaintext) };
      case "createReply":
        return { reply: reply(input.body.message_plaintext) };
      case "moveFolderItem":
        return {};
      case "createDesign":
        return { design: design() };
      case "publishBrandTemplate":
        return { brand_template: template() };
      default:
        throw new Error(`Unmocked operation: ${name}`);
    }
  }
  async open(scope: Scope) {
    this.#engine ??= new Engine(
      new JsonStore(this.ctx.storage.kv),
      { call: (name, input) => this.#call(name, input) },
      scope,
    );
    using queue = new RpcStub(new Queue(this.ctx.storage.kv));
    return createSession({ engine: this.#engine, queue });
  }
  async applyAll() {
    for (const action of this.#engine!.pending()) await this.#engine!.apply(action.id);
  }
  async readyJobs() {
    for (const action of this.#engine!.actions())
      this.#engine!.store.put(`action:${action.id}`, { ...action, nextPoll: 0 });
  }
  async control(key: string, value: boolean) {
    this.ctx.storage.kv.put(key, value);
  }
  async stats() {
    return {
      calls: this.ctx.storage.kv.get("calls") ?? [],
      observations: this.ctx.storage.kv.get("observations") ?? 0,
      actions: this.#engine?.actions() ?? [],
    };
  }
}
export class OAuthHarness extends UserAccount {
  async seed(value: Data) {
    for (const [k, v] of Object.entries(value)) this.ctx.storage.kv.put(k, v);
  }
  async inspect(key: string) {
    return this.ctx.storage.kv.get(key);
  }
  async runCleanupAlarm() {
    await this.alarm();
  }
}
export default class extends WorkerEntrypoint<any> {
  async run() {
    return runScenarios(this);
  }
  async session(name: string, scope: Scope) {
    return this.env.TEST.getByName(name).open(scope);
  }
  async applyAll(name: string) {
    await this.env.TEST.getByName(name).applyAll();
  }
  async readyJobs(name: string) {
    await this.env.TEST.getByName(name).readyJobs();
  }
  async stats(name: string) {
    return this.env.TEST.getByName(name).stats();
  }
  async control(name: string, key: string, value: boolean) {
    await this.env.TEST.getByName(name).control(key, value);
  }
  async oauth() {
    return this.env.OAUTH.getByName("test");
  }
}
