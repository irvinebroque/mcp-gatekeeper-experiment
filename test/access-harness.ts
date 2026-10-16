// Test-only controller for the real two-Worker connection and resource path.
import { WorkerEntrypoint, DurableObject, RpcTarget, RpcStub } from "cloudflare:workers";
import type { GatekeeperUser, Gatekeeper, ApprovalQueue } from "../research/upstream/gatekeeper";
import type { CanvaDesignEditor } from "../src/types";
// Canva's implementation omits the unused Git cache argument, as the host contract permits.
type CanvaFacet = Omit<Gatekeeper<CanvaDesignEditor>, "applyAction"> & { applyAction(action: number): Promise<void> };

export class State extends DurableObject {
  async put(key: string, value: unknown) { this.ctx.storage.kv.put(key, value); }
  async get(key: string) { return this.ctx.storage.kv.get(key); }
  #instance(resourceClass: DurableObjectClass<CanvaFacet>) { return this.ctx.facets.get<CanvaFacet>("resource", () => ({ class: resourceClass })); }
  async read(resourceClass: DurableObjectClass<CanvaFacet>) {
    using queue = new RpcStub(new Queue(this));
    let stage = "instantiate";
    try {
      const instance = this.#instance(resourceClass);
      stage = "session";
      const session = await instance.startSession(queue);
      stage = "getInfo";
      return await session.getInfo();
    } catch (error) { throw new Error(`${stage}: ${error instanceof Error ? error.stack : error}`); }
  }
  async submit(resourceClass: DurableObjectClass) {
    using queue = new RpcStub(new Queue(this));
    await (await this.#instance(resourceClass).startSession(queue)).addComment("Test");
  }
  async apply(resourceClass: DurableObjectClass) { await this.#instance(resourceClass).applyAction(1); }
}
export class Callback extends WorkerEntrypoint<any> {
  async complete(user: Fetcher<GatekeeperUser>) {
    await this.env.STATE.getByName("test").put("user", user);
    return { ticket: "test-handoff", targetOrigin: "https://host.example.com" };
  }
  async reconnectComplete(stage: string) {
    await this.env.STATE.getByName("test").put("stage", stage);
    return { ticket: "test-reconnect", targetOrigin: "https://host.example.com" };
  }
  async credentialsExpired() {}
  async credentialsRestored() {}
}
class Queue extends RpcTarget implements ApprovalQueue {
  constructor(private state: any) { super(); }
  async authorizeObservation() {
    if (await this.state.get("deny")) throw new Error("Observation denied");
  }
  async submitAction() { await this.state.put("submitted", true); }
  async getGitCache(): Promise<never> { throw new Error("Not used by Canva"); }
  async bindHook(): Promise<never> { throw new Error("Not used by Canva"); }
}
export default class extends WorkerEntrypoint<any> {
  async start() {
    // Production-generated globals describe the Gatekeeper; this test entrypoint exports Callback.
    const exports = this.ctx.exports as typeof this.ctx.exports & { Callback(options: { props: Record<string, never> }): Fetcher<Callback> };
    return this.env.VENDOR.connectAccount(exports.Callback({ props: {} }), { resourceUrlPatterns: ["https://www.canva.com/design/:designId/*"] });
  }
  async reconnect() { return (await this.env.STATE.getByName("test").get("user")).reconnect(); }
  async read() {
    let stage = "load user";
    try {
      const user = await this.env.STATE.getByName("test").get("user");
      stage = "get class";
      const { class: gatekeeper } = await user.getGatekeeperClassFor("https://www.canva.com/design/Dabcdefghij/edit");
      stage = "read facet";
      return await this.env.STATE.getByName("test").read(gatekeeper);
    } catch (error) { throw new Error(`${stage}: ${error instanceof Error ? error.stack : error}`); }
  }
  async deny(value: boolean) { await this.env.STATE.getByName("test").put("deny", value); }
  async submit() {
    const user = await this.env.STATE.getByName("test").get("user");
    const { class: gatekeeper } = await user.getGatekeeperClassFor("https://www.canva.com/design/Dabcdefghij/edit");
    await this.env.STATE.getByName("test").submit(gatekeeper);
  }
  async apply() {
    const user = await this.env.STATE.getByName("test").get("user");
    const { class: gatekeeper } = await user.getGatekeeperClassFor("https://www.canva.com/design/Dabcdefghij/edit");
    await this.env.STATE.getByName("test").apply(gatekeeper);
  }
  async revoke() { await (await this.env.STATE.getByName("test").get("user")).revoke(); }
  async commitReconnect() {
    const state = this.env.STATE.getByName("test");
    await (await state.get("user")).commitReconnect(await state.get("stage"));
  }
}
