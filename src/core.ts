import { clean, items, object, policy, string, validate, type Data, type ToolClient } from "./protocol";
import type { ApprovalQueue } from "./host/gatekeeper";

export type Scope = { kind: "library" } | { kind: "folder"; id: string; ancestors?: string[] } | { kind: "design"; id: string; locator: string };
export type Ref = string | { action: number; kind: "folder" | "comment" | "design" };
export type Target = { kind: "design" | "folder" | "image" | "template"; id: Ref };
export interface Store {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
  delete(key: string): unknown;
  list<T>(options: { prefix: string }): Iterable<[string, T]>;
}
export type Queue = Pick<ApprovalQueue, "authorizeObservation" | "submitAction">;
export interface Action {
  id: number; tool: string; args: Data; targets: Target[]; depends: number[];
  state: "queued" | "applying" | "applied" | "rejected" | "unknown" | "failed";
  result?: Data; nextPoll?: number;
  scope: Scope;
  overlay?: { kind: string; [key: string]: any };
}
export const RESOURCES = [
  { urlPattern: "https://www.canva.com/", title: "Canva library", description: "Search, create, and work with accessible library content." },
  { urlPattern: "https://www.canva.com/folder/:folderId", title: "Canva folder", description: "Work within one folder and its current descendants." },
  { urlPattern: "https://www.canva.com/design/:designId/*", title: "Canva design", description: "Read and edit one design." },
];
export function id(value: unknown): string {
  const s = string(value);
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(s)) throw new Error("Invalid resource ID");
  return s;
}
export function designLocator(value: string): { id: string; locator: string } {
  if (!value.includes(":")) { id(value); return { id: value, locator: value }; }
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "www.canva.com" || url.port || url.username || url.password) throw new Error("Expected a Canva design URL");
  const match = /^\/design\/([\w-]+)(?:\/.*)?$/.exec(url.pathname);
  if (!match) throw new Error("Expected a Canva design URL");
  return { id: id(match[1]), locator: url.href };
}
export function parseResource(value: string): Scope {
  const url = new URL(value);
  if (url.origin !== "https://www.canva.com" || url.username || url.password) throw new Error("Unsupported resource URL");
  if (url.pathname === "/" && !url.search && !url.hash) return { kind: "library" };
  const folder = /^\/folder\/([\w-]+)\/?$/.exec(url.pathname);
  if (folder && !url.search && !url.hash) return { kind: "folder", id: id(folder[1]) };
  return { kind: "design", ...designLocator(value) };
}
export function scopeUrl(scope: Scope): string {
  return scope.kind === "library" ? RESOURCES[0].urlPattern : scope.kind === "folder" ? `https://www.canva.com/folder/${scope.id}` : `https://www.canva.com/design/${scope.id}/edit`;
}
export function resourceFor(scope: Scope) { return RESOURCES[scope.kind === "library" ? 0 : scope.kind === "folder" ? 1 : 2]; }
export function publicSource(value: string): string {
  const u = new URL(value);
  if (u.protocol !== "https:" || u.username || u.password || u.port && u.port !== "443" || !u.hostname.includes(".") ||
      u.hostname === "localhost" || /(?:\.localhost|\.local|\.internal)$/.test(u.hostname) || /^[\d.]+$/.test(u.hostname) || u.hostname.includes(":")) {
    throw new Error("A public HTTPS source URL is required");
  }
  return u.href;
}
export function resultId(result: Data, kind: string): string {
  const base = result.job?.result ?? result.job ?? result;
  const value = base[kind] ?? (kind === "comment" ? base.thread : undefined) ?? (kind === "design" && base.designs?.length === 1 ? base.designs[0] : undefined) ?? base;
  return id(value[`${kind}_id`] ?? value.id);
}

// Plain internal engine: never returned over RPC. The only outbound write is in apply().
export class Engine {
  #locks = new Set<number>();
  constructor(readonly store: Store, readonly client: ToolClient, readonly scope: Scope, recover = true) {
    if (!recover) return;
    for (const [key, action] of store.list<Action>({ prefix: "action:" })) {
      if (action.state === "applying") store.put(key, { ...action, state: "unknown" });
    }
  }
  action(n: number): Action {
    const value = this.store.get<Action>(`action:${n}`);
    if (!value) throw new Error("Unknown action");
    return value;
  }
  actions(): Action[] { return [...this.store.list<Action>({ prefix: "action:" })].map(([, a]) => a).sort((a, b) => a.id - b.id); }
  narrowFolder(key: string): Engine {
    if (this.scope.kind === "design") throw new Error("Cannot derive a folder from a design");
    return new Engine(this.store, this.client, { kind: "folder", id: key,
      ancestors: this.scope.kind === "folder" ? [...(this.scope.ancestors ?? []), this.scope.id].filter(x => x !== key) : [] }, false);
  }
  pending(): Action[] { return this.actions().filter(a => a.state === "queued"); }
  visibleEdits(): Action[] {
    const all = this.actions();
    return all.filter(a => a.overlay?.kind === "edit" && ["queued", "applied"].includes(a.state) &&
      !all.some(b => b.args.transaction_id === a.args.transaction_id &&
        (b.tool === "commit-editing-transaction" && b.state === "applied" || b.tool === "cancel-editing-transaction" && ["queued", "applied"].includes(b.state))));
  }
  resolve(ref: Ref): string {
    if (typeof ref === "string") return ref;
    const action = this.action(ref.action);
    if (action.state !== "applied" || !action.result) throw new Error("Resource is not ready or has been rejected");
    return resultId(action.result, ref.kind);
  }
  #resolveArgs(value: any, path: string[] = [], placeholders = false): any {
    if (Array.isArray(value)) return value.map((x, i) => this.#resolveArgs(x, [...path, String(i)], placeholders));
    if (value && typeof value === "object") {
      if (Object.keys(value).length === 2 && Number.isInteger(value.action) && ["folder", "comment", "design"].includes(value.kind)) {
        const allowed: Data = { parent_folder_id: "folder", comment_id: "comment", design_id: "design" };
        if (path.length !== 1 || allowed[path[0]] !== value.kind) throw new Error("Invalid provisional reference location");
        if (placeholders && this.action(value.action).state === "queued") return value.kind === "design" ? "D0000000000" : "pending";
        return this.resolve(value);
      }
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.#resolveArgs(v, [...path, k], placeholders)]));
    }
    return value;
  }
  async raw(tool: string, args: Data): Promise<Data> {
    await this.client.ensureActive?.();
    if (policy.get(tool) !== "observation") throw new Error("Writes require the action executor");
    const resolved = clean(this.#resolveArgs(args));
    validate(tool, resolved);
    return this.client.call(tool, resolved);
  }
  async check(target: Target, provisional = false): Promise<void> {
    await this.client.ensureActive?.();
    if (this.scope.kind === "library") return;
    if (typeof target.id !== "string" && provisional) {
      const a = this.action(target.id.action);
      if (a.state === "queued" && a.tool === "create-folder" && target.kind === "folder") {
        for (const t of a.targets) await this.check(t, true);
        return;
      }
    }
    const value = this.resolve(target.id);
    if (this.scope.kind === "design") {
      if (target.kind !== "design" || value !== this.scope.id) throw new Error("Outside the design grant");
      return;
    }
    for (const ancestor of this.scope.ancestors ?? []) {
      await new Engine(this.store, this.client, { kind: "folder", id: ancestor }, false).check({ kind: "folder", id: this.scope.id });
    }
    if (target.kind === "folder" && value === this.scope.id) return;
    const folders = [this.scope.id], seen = new Set<string>();
    let count = 0;
    while (folders.length) {
      const folder = folders.shift()!;
      if (seen.has(folder)) continue;
      seen.add(folder);
      let continuation: string | undefined;
      const cursors = new Set<string>();
      do {
        if (++count > 300) throw new Error("Folder tree exceeds verification limit");
        const data = await this.raw("list-folder-items", clean({ folder_id: folder, continuation }));
        for (const item of items(data.items)) {
          const child = object(item[item.type]);
          if (item.type === target.kind && child.id === value) return;
          if (item.type === "folder") folders.push(id(child.id));
        }
        continuation = data.continuation;
        if (continuation) {
          string(continuation);
          if (cursors.has(continuation)) throw new Error("Repeated folder cursor");
          cursors.add(continuation);
        }
      } while (continuation);
    }
    throw new Error("Resource is outside the current folder tree");
  }
  async read(queue: Queue, tool: string, args: Data, targets: Target[], cache = false): Promise<Data> {
    await this.client.ensureActive?.();
    // Canva does not provide a reliable source-folder snapshot for an arbitrary
    // move. Avoid disclosing an old listing as if the pending move had finished.
    if (tool === "list-folder-items" && this.pending().some(a => a.tool === "move-item-to-folder")) {
      throw new Error("Folder contents are still processing. Try again when the move finishes.");
    }
    const ref = tool === "list-folder-items" ? args.folder_id : tool === "list-replies" ? args.comment_id : undefined;
    const provisional = ref && typeof ref !== "string" && this.action(ref.action).state === "queued";
    for (const t of targets) await this.check(t, !!provisional);
    const resolved = provisional ? clean(args) : clean(this.#resolveArgs(args));
    const key = "cache:" + tool + ":" + JSON.stringify(resolved);
    const cached = cache ? this.store.get<{ at: number; data: Data }>(key) : undefined;
    let data = provisional ? { items: [] } : cached && Date.now() - cached.at < 15_000 ? cached.data : await this.raw(tool, resolved);
    // Check again after the read; do not disclose content from a detached child.
    for (const t of targets) await this.check(t, !!provisional);
    await queue.authorizeObservation({ title: tool.replaceAll("-", " "), description: `Read Canva ${targets.map(t => t.kind).join(", ") || "library"} content.` });
    if (cache && !provisional) this.store.put(key, { at: Date.now(), data });
    data = clean(data);
    // Append local creations on the final page; their capabilities carry private references.
    if (!data.continuation && Array.isArray(data.items)) for (const a of this.pending()) {
      const o = a.overlay;
      if (tool === "list-folder-items" && o?.kind === "folder" && JSON.stringify(o.parent) === JSON.stringify(args.folder_id) && (!args.item_types || args.item_types.includes("folder"))) {
        data.items.push({ type: "folder", folder: { id: `pending-${a.id}`, name: o.name }, _provisional: { action: a.id, kind: "folder" } });
      }
      if (tool === "list-comments" && o?.kind === "comment" && o.designId === args.design_id) {
        data.items.push({ id: `pending-${a.id}`, text: o.text, _provisional: { action: a.id, kind: "comment" } });
      }
      if (tool === "list-replies" && o?.kind === "reply" && JSON.stringify(o.commentId) === JSON.stringify(args.comment_id)) {
        data.items.push({ id: `pending-${a.id}`, text: o.text });
      }
    }
    return data;
  }
  async submit(queue: Queue, tool: string, args: Data, targets: Target[], overlay?: Action["overlay"], awaitDecision = false): Promise<number> {
    await this.client.ensureActive?.();
    if (policy.get(tool) !== "action") throw new Error("Unreviewed action");
    args = clean(args);
    if (JSON.stringify(args).length > 200_000) throw new Error("Action is too large");
    for (const t of targets) await this.check(t, true);
    // Provisional references are engine-created and resolved/revalidated at application.
    validate(tool, this.#resolveArgs(args, [], true));
    const n = (this.store.get<number>("sequence") ?? 0) + 1;
    this.store.put("sequence", n);
    // Include in-flight and indeterminate attempts so concurrent sessions cannot
    // race past a write whose outcome has not yet been established.
    const depends = this.actions().filter(a => !["applied", "rejected"].includes(a.state)).map(a => a.id);
    const action: Action = { id: n, tool, args, targets: clean(targets), depends, state: "queued", overlay, scope: clean(this.scope) };
    this.store.put(`action:${n}`, action);
    try {
      await queue.submitAction(n, {
        title: tool.replaceAll("-", " "),
        description: `Perform this Canva operation on ${scopeUrl(this.scope)}. References to prior actions resolve only to their results.`,
        fields: [{ label: "Exact tool arguments", kind: "json", value: JSON.stringify(args, null, 2) }],
        descriptionIsComplete: true, implementsRevert: false, awaitDecision,
        actionKind: { tag: tool, label: tool.replaceAll("-", " ") },
      });
    } catch (e) {
      if (this.action(n).state === "queued") this.store.put(`action:${n}`, { ...action, state: "rejected" });
      throw e;
    }
    return n;
  }
  async apply(n: number): Promise<void> {
    await this.client.ensureActive?.();
    const action = this.action(n);
    if (action.state === "applied") return;
    if (this.#locks.has(n) || action.state !== "queued") throw new Error(`Action is ${action.state}; it cannot be replayed`);
    this.#locks.add(n);
    try {
      for (const d of action.depends) if (this.action(d).state !== "applied") throw new Error("Apply dependencies first");
      const boundary = new Engine(this.store, this.client, action.scope, false);
      for (const target of action.targets) await boundary.check(target);
      const args = clean(this.#resolveArgs(action.args));
      validate(action.tool, args);
      if (this.action(n).state !== "queued") throw new Error("Action changed during validation");
      for (const d of action.depends) if (this.action(d).state !== "applied") throw new Error("Action dependency changed");
      this.store.put(`action:${n}`, { ...action, state: "applying" });
      try {
        const result = await this.client.call(action.tool, args);
        const failed = explicitFailure(action.tool, result);
        this.store.put(`action:${n}`, { ...action, state: failed ? "failed" : "applied", result, nextPoll: Date.now() + retrySeconds(result) * 1000 });
        for (const [key] of this.store.list({ prefix: "cache:" })) this.store.delete(key);
        if (failed) throw new Error("Canva reported that the operation failed; inspect its result before continuing");
      } catch {
        if (this.action(n).state === "failed") throw new Error("Canva reported an operation failure; dependent actions are blocked");
        this.store.put(`action:${n}`, { ...action, state: "unknown" });
        throw new Error("Canva outcome is unknown. Inspect Canva before retrying; this action will not be replayed.");
      }
    } finally { this.#locks.delete(n); }
  }
  reject(n: number): { restart: true } {
    const action = this.action(n);
    if (!["queued", "rejected"].includes(action.state)) throw new Error("Cannot reject an attempted action");
    for (const a of this.actions()) if (a.id === n || a.depends.includes(n)) {
      if (a.state === "queued") this.store.put(`action:${a.id}`, { ...a, state: "rejected" });
    }
    return { restart: true };
  }
  async poll(queue: Queue, n: number): Promise<Data | undefined> {
    await this.client.ensureActive?.();
    let action = this.action(n);
    for (const t of action.targets) await this.check(t);
    if (action.state === "queued") return undefined;
    if (action.state !== "applied" && action.state !== "failed") throw new Error(`Operation ${action.state}`);
    let data = object(action.result);
    const pollingTool = ({ "create-design": "get-create-design-async-job", "separate-image-layers": "get-separate-image-layers-job", "generate-image": "get-generate-image-job" } as Data)[action.tool];
    const status = String(data.status ?? "").toLowerCase();
    if (pollingTool && !["completed", "success", "failed", "failure"].includes(status) && Date.now() >= (action.nextPoll ?? 0)) {
      if (this.#locks.has(n)) return data;
      this.#locks.add(n);
      try {
        const args = action.tool === "generate-image" ? { jobId: string(data.jobId) } : { job_id: string(data.job_id), continuation_token: string(data.continuation_token) };
        const update = await this.raw(pollingTool, args);
        data = { ...data, ...update };
        action = { ...action, result: data, nextPoll: Date.now() + retrySeconds(data) * 1000 };
        this.store.put(`action:${n}`, action);
      } finally { this.#locks.delete(n); }
    }
    for (const t of action.targets) await this.check(t);
    await queue.authorizeObservation({ title: "Read Canva operation result", description: action.tool.replaceAll("-", " ") });
    return clean(data);
  }
}
function explicitFailure(tool: string, data: Data): boolean {
  if (data.error || ["failed", "failure"].includes(String(data.job?.status ?? data.status).toLowerCase())) return true;
  if (tool === "perform-editing-operations") {
    if (!Array.isArray(data.edit_operation_results)) throw new Error("Missing operation results");
    return data.edit_operation_results.some((r: Data) => r.status !== "success");
  }
  if (tool === "commit-editing-transaction" && data.transaction?.status !== "committed") throw new Error("Commit was not confirmed");
  if (tool === "cancel-editing-transaction" && !["cancelled", "canceled"].includes(data.transaction?.status)) throw new Error("Cancellation was not confirmed");
  return false;
}
export function retrySeconds(data: Data): number {
  const n = data.polling_policy?.wait_seconds;
  return typeof n === "number" && Number.isFinite(n) ? Math.min(3600, Math.max(1, n)) : 3;
}
