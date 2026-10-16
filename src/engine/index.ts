import { operationFor, validateOperation } from "../canva/operations";
import type { ApiClient } from "../canva/client";
import { clean, items, object, string, type Data } from "../json";
import { id, resultId, scopeUrl, type Scope } from "../resources";
import type { Action, Overlay, Queue, ResourceRef, Store, Target } from "./types";

const CACHE_LIFETIME_MS = 15_000;
const POLL_INTERVAL_MS = 3_000;
const MAX_FOLDER_PAGES = 300;
const MAX_ACTION_LENGTH = 200_000;

/** Internal policy engine. Never return it, its client, or its store over RPC. */
export class Engine {
  #locks = new Set<number>();

  constructor(
    readonly store: Store,
    readonly client: ApiClient,
    readonly scope: Scope,
    recover = true,
  ) {
    if (!recover) return;
    const actions = this.actions();
    // Old journals refer to MCP tools and cannot safely be replayed against REST.
    if (actions.length && store.get("journal-version") !== 2)
      throw new Error(
        "This resource uses an old action journal. Create a fresh resource connection.",
      );
    store.put("journal-version", 2);
    for (const action of actions) {
      if (action.state === "applying") this.#save({ ...action, state: "unknown" });
    }
  }

  action(actionId: number): Action {
    const action = this.store.get<Action>(`action:${actionId}`);
    if (!action) throw new Error("Unknown action");
    return action;
  }

  actions(): Action[] {
    return [...this.store.list<Action>({ prefix: "action:" })]
      .map(([, action]) => action)
      .sort((a, b) => a.id - b.id);
  }

  pending(): Action[] {
    return this.actions().filter((action) => action.state === "queued");
  }

  narrowFolder(folderId: string): Engine {
    if (this.scope.kind === "design") throw new Error("Cannot derive a folder from a design");
    const ancestors =
      this.scope.kind === "folder"
        ? [...(this.scope.ancestors ?? []), this.scope.id].filter((id) => id !== folderId)
        : [];
    return new Engine(this.store, this.client, { kind: "folder", id: folderId, ancestors }, false);
  }

  resolve(reference: ResourceRef): string {
    if (typeof reference === "string") return reference;
    const action = this.action(reference.action);
    if (action.state !== "applied" || !action.result)
      throw new Error("Resource is not ready or has been rejected");
    return resultId(action.result, reference.kind);
  }

  #save(action: Action) {
    this.store.put(`action:${action.id}`, action);
  }

  #resolveInput(value: any, path: string[] = [], placeholders = false): any {
    if (Array.isArray(value))
      return value.map((item, index) =>
        this.#resolveInput(item, [...path, String(index)], placeholders),
      );
    if (!value || typeof value !== "object") return value;
    if (
      Object.keys(value).length === 2 &&
      Number.isInteger(value.action) &&
      ["folder", "comment", "design"].includes(value.kind)
    ) {
      const locations: Record<string, string> = {
        "body.parent_folder_id": "folder",
        "path.threadId": "comment",
        "body.design_id": "design",
      };
      if (locations[path.join(".")] !== value.kind)
        throw new Error("Invalid provisional reference location");
      if (placeholders && this.action(value.action).state === "queued") return "pending";
      return this.resolve(value);
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        this.#resolveInput(child, [...path, key], placeholders),
      ]),
    );
  }

  /** Reads used to verify authority or prepare an action disclose no content to the caller. */
  async readInternal(operation: string, input: Data): Promise<Data> {
    await this.client.ensureActive?.();
    if (operationFor(operation).classification !== "observation")
      throw new Error("Writes require the action executor");
    const resolved = clean(this.#resolveInput(input));
    validateOperation(operation, resolved);
    return this.client.call(operation, resolved);
  }

  async checkTarget(target: Target, allowPending = false): Promise<void> {
    await this.client.ensureActive?.();
    if (this.scope.kind === "library") return;
    if (typeof target.id !== "string" && allowPending) {
      const action = this.action(target.id.action);
      if (
        action.state === "queued" &&
        action.operation === "createFolder" &&
        target.kind === "folder"
      ) {
        for (const parent of action.targets) await this.checkTarget(parent, true);
        return;
      }
    }
    const resourceId = this.resolve(target.id);
    if (this.scope.kind === "design") {
      if (target.kind !== "design" || resourceId !== this.scope.id)
        throw new Error("Outside the design grant");
      return;
    }
    // Check every ancestor again so a returned child cannot outlive removal from its grant.
    for (const ancestor of this.scope.ancestors ?? []) {
      await new Engine(
        this.store,
        this.client,
        { kind: "folder", id: ancestor },
        false,
      ).checkTarget({ kind: "folder", id: this.scope.id });
    }
    if (target.kind === "folder" && resourceId === this.scope.id) return;
    const folders = [this.scope.id];
    const visited = new Set<string>();
    let pageCount = 0;
    while (folders.length) {
      const folderId = folders.shift()!;
      if (visited.has(folderId)) continue;
      visited.add(folderId);
      let continuation: string | undefined;
      const cursors = new Set<string>();
      do {
        if (++pageCount > MAX_FOLDER_PAGES)
          throw new Error("Folder tree exceeds verification limit");
        const data = await this.readInternal(
          "listFolderItems",
          clean({ path: { folderId }, query: { continuation } }),
        );
        for (const item of items(data.items)) {
          const child = object(item[item.type]);
          if (item.type === target.kind && child.id === resourceId) return;
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

  async observe(
    queue: Queue,
    operation: string,
    input: Data,
    targets: Target[],
    options: { cache?: boolean } = {},
  ): Promise<Data> {
    await this.client.ensureActive?.();
    this.#checkUnfinishedChanges(operation, targets);
    const reference =
      operation === "listFolderItems"
        ? input.path.folderId
        : operation === "listReplies"
          ? input.path.threadId
          : undefined;
    const provisional =
      reference &&
      typeof reference !== "string" &&
      this.action(reference.action).state === "queued";
    for (const target of targets) await this.checkTarget(target, !!provisional);
    const resolved = provisional ? clean(input) : clean(this.#resolveInput(input));
    const cacheKey = `cache:${operation}:${JSON.stringify(resolved)}`;
    const cached = options.cache ? this.store.get<{ at: number; data: Data }>(cacheKey) : undefined;
    const freshCache = cached && Date.now() - cached.at < CACHE_LIFETIME_MS;
    const data = provisional
      ? { items: [] }
      : freshCache
        ? cached.data
        : await this.readInternal(operation, resolved);
    for (const target of targets) await this.checkTarget(target, !!provisional);
    await queue.authorizeObservation({
      title: operation,
      description: `Read Canva ${targets.map((target) => target.kind).join(", ") || "library"} content.`,
    });
    if (options.cache && !provisional) this.store.put(cacheKey, { at: Date.now(), data });
    return this.#overlayCreations(operation, input, clean(data));
  }

  #checkUnfinishedChanges(operation: string, targets: Target[]) {
    const unfinished = this.actions().filter((action) =>
      ["queued", "applying", "running", "unknown"].includes(action.state),
    );
    if (
      operation === "listFolderItems" &&
      unfinished.some((action) => action.operation === "moveFolderItem")
    )
      throw new Error("Folder contents are still processing. Try again when the move finishes.");
    if (
      operation === "getDesignPages" &&
      unfinished.some(
        (action) =>
          action.operation === "createDesignMergeJob" &&
          targets.some((target) => target.id === action.input.body?.design_id),
      )
    )
      throw new Error("Page changes are still processing. Check the operation status first.");
  }

  #overlayCreations(operation: string, input: Data, data: Data): Data {
    if (data.continuation || !Array.isArray(data.items)) return data;
    for (const action of this.pending()) {
      const overlay = action.overlay;
      if (
        operation === "listFolderItems" &&
        overlay?.kind === "folder" &&
        JSON.stringify(overlay.parent) === JSON.stringify(input.path.folderId) &&
        (!input.query?.item_types || input.query.item_types.includes("folder"))
      )
        data.items.push({
          type: "folder",
          folder: { id: `pending-${action.id}`, name: overlay.name },
          _provisional: { action: action.id, kind: "folder" },
        });
      if (
        operation === "listReplies" &&
        overlay?.kind === "reply" &&
        JSON.stringify(overlay.commentId) === JSON.stringify(input.path.threadId)
      )
        data.items.push({ id: `pending-${action.id}`, content: { plaintext: overlay.text } });
    }
    return data;
  }

  async submit(
    queue: Queue,
    operation: string,
    input: Data,
    targets: Target[],
    options: { overlay?: Overlay; awaitDecision?: boolean } = {},
  ): Promise<number> {
    await this.client.ensureActive?.();
    if (operationFor(operation).classification !== "action") throw new Error("Unreviewed action");
    const captured = clean(input);
    if (JSON.stringify(captured).length > MAX_ACTION_LENGTH) throw new Error("Action is too large");
    for (const target of targets) await this.checkTarget(target, true);
    validateOperation(operation, this.#resolveInput(captured, [], true));
    const actionId = (this.store.get<number>("sequence") ?? 0) + 1;
    this.store.put("sequence", actionId);
    const dependsOn = this.actions()
      .filter((action) => !["applied", "rejected"].includes(action.state))
      .map((action) => action.id);
    const action: Action = {
      id: actionId,
      operation,
      input: captured,
      targets: clean(targets),
      dependsOn,
      state: "queued",
      overlay: clean(options.overlay ?? null) ?? undefined,
      scope: clean(this.scope),
    };
    this.#save(action);
    try {
      await queue.submitAction(actionId, {
        title: operation,
        description: `Perform this Canva REST operation on ${scopeUrl(this.scope)}. References to prior actions resolve only to their results.`,
        fields: [
          { label: "Exact API input", kind: "json", value: JSON.stringify(captured, null, 2) },
        ],
        descriptionIsComplete: true,
        implementsRevert: false,
        awaitDecision: options.awaitDecision ?? false,
        actionKind: { tag: operation, label: operation },
      });
    } catch (error) {
      if (this.action(actionId).state === "queued") this.#save({ ...action, state: "rejected" });
      throw error;
    }
    return actionId;
  }

  /** The only path that sends a mutation to Canva. */
  async apply(actionId: number): Promise<void> {
    await this.client.ensureActive?.();
    const action = this.action(actionId);
    if (action.state === "applied") return;
    if (this.#locks.has(actionId) || action.state !== "queued")
      throw new Error(`Action is ${action.state}; it cannot be replayed`);
    this.#locks.add(actionId);
    try {
      this.#checkDependencies(action);
      const boundary = new Engine(this.store, this.client, action.scope, false);
      for (const target of action.targets) await boundary.checkTarget(target);
      const input = clean(this.#resolveInput(action.input));
      validateOperation(action.operation, input);
      if (this.action(actionId).state !== "queued")
        throw new Error("Action changed during validation");
      this.#checkDependencies(action);
      this.#save({ ...action, state: "applying" });
      try {
        this.#recordResult(action, await this.client.call(action.operation, input));
      } catch {
        this.#save({ ...action, state: "unknown" });
        throw new Error(
          "Canva outcome is unknown. Inspect Canva before retrying; this action will not be replayed.",
        );
      }
      for (const [key] of this.store.list({ prefix: "cache:" })) this.store.delete(key);
      if (this.action(actionId).state === "failed")
        throw new Error("Canva reported an operation failure; dependent actions are blocked");
    } finally {
      this.#locks.delete(actionId);
    }
  }

  #checkDependencies(action: Action) {
    for (const dependency of action.dependsOn) {
      if (this.action(dependency).state !== "applied")
        throw new Error("Apply dependencies first and wait for their jobs to finish");
    }
  }

  #recordResult(action: Action, result: Data) {
    const status = result.job?.status;
    const pollable = operationFor(action.operation).poll;
    const failed = status === "failed";
    const running = !!pollable && status === "in_progress";
    if (running) id(result.job?.id);
    if (pollable && !["in_progress", "success", "failed"].includes(status))
      throw new Error("Unrecognized Canva job response");
    this.#save({
      ...action,
      result,
      state: failed ? "failed" : running ? "running" : "applied",
      nextPoll: Date.now() + POLL_INTERVAL_MS,
    });
  }

  reject(actionId: number): { restart: true } {
    const action = this.action(actionId);
    if (!["queued", "rejected"].includes(action.state))
      throw new Error("Cannot reject an attempted action");
    for (const dependent of this.actions()) {
      if (
        (dependent.id === actionId || dependent.dependsOn.includes(actionId)) &&
        dependent.state === "queued"
      )
        this.#save({ ...dependent, state: "rejected" });
    }
    return { restart: true };
  }

  async poll(queue: Queue, actionId: number): Promise<Data | undefined> {
    await this.client.ensureActive?.();
    let action = this.action(actionId);
    for (const target of action.targets) await this.checkTarget(target);
    if (action.state === "queued") return undefined;
    if (!["running", "applied", "failed"].includes(action.state))
      throw new Error(`Operation ${action.state}`);
    const pollingOperation = operationFor(action.operation).poll;
    if (
      action.state === "running" &&
      pollingOperation &&
      Date.now() >= (action.nextPoll ?? 0) &&
      !this.#locks.has(actionId)
    ) {
      this.#locks.add(actionId);
      try {
        const jobId = string(action.result?.job?.id);
        const [parameter] = operationFor(pollingOperation).pathParameters;
        const result = await this.readInternal(pollingOperation, { path: { [parameter]: jobId } });
        if (result.job?.id !== jobId) throw new Error("Canva returned a different job");
        this.#recordResult(action, result);
        action = this.action(actionId);
        if (action.state !== "running") {
          for (const [key] of this.store.list({ prefix: "cache:" })) this.store.delete(key);
        }
      } finally {
        this.#locks.delete(actionId);
      }
    }
    for (const target of action.targets) await this.checkTarget(target);
    await queue.authorizeObservation({
      title: "Read Canva operation result",
      description: action.operation,
    });
    return clean(object(action.result));
  }
}
