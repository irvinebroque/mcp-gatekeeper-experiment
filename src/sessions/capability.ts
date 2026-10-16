import { RpcTarget, type RpcStub } from "cloudflare:workers";
import type { ApprovalQueue } from "../host/gatekeeper";
import type { Engine } from "../engine";
import type { ResourceRef, Target } from "../engine/types";
import { clean, items, string, type Data } from "../json";
import type * as T from "../types";

export type Context = { engine: Engine; queue: RpcStub<ApprovalQueue> };
const contexts = new WeakMap<object, Context>();

// A protected/public getter would become part of every capability's RPC surface.
export function contextOf(capability: object): Context {
  const context = contexts.get(capability);
  if (!context) throw new Error("Capability has been disposed");
  return context;
}

export class Capability extends RpcTarget {
  constructor(context: Context) {
    super();
    contexts.set(this, { engine: context.engine, queue: context.queue.dup() });
  }
  [Symbol.dispose]() {
    contextOf(this).queue[Symbol.dispose]();
    contexts.delete(this);
  }
}

export const target = (kind: Target["kind"], id: ResourceRef): Target[] => [{ kind, id }];

export class Cursor<Result> extends Capability implements T.Cursor<Result> {
  #done = false;
  #busy = false;
  #continuation?: string;
  #offset = 1;
  #seen = new Set<string>();
  #operation: string;
  #input: Data;
  #targets: Target[];
  #map: (value: Data, context: Context) => Result;
  #offsetMode: boolean;

  constructor(
    context: Context,
    operation: string,
    input: Data,
    targets: Target[],
    map: (value: Data, context: Context) => Result,
    offsetMode = false,
  ) {
    super(context);
    this.#operation = operation;
    this.#input = clean(input);
    this.#targets = targets;
    this.#map = map;
    this.#offsetMode = offsetMode;
  }

  async next(): Promise<Result[] | null> {
    if (this.#busy) throw new Error("Read cursor pages sequentially");
    const { engine, queue } = contextOf(this);
    if (this.#done) {
      await engine.client.ensureActive?.();
      for (const resource of this.#targets) await engine.checkTarget(resource);
      await queue.authorizeObservation({
        title: "End of Canva results",
        description: "No further results.",
      });
      return null;
    }
    this.#busy = true;
    try {
      const query = {
        ...this.#input.query,
        ...(this.#offsetMode
          ? { offset: this.#offset, limit: 100 }
          : { continuation: this.#continuation }),
      };
      const data = await engine.observe(
        queue,
        this.#operation,
        clean({ ...this.#input, query }),
        this.#targets,
      );
      const values = items(data.items);
      const result = values.map((value) => this.#map(value, contextOf(this)));
      const continuation = data.continuation;
      if (continuation && this.#seen.has(continuation)) throw new Error("Repeated Canva cursor");
      this.#offset += values.length;
      this.#done = this.#offsetMode ? values.length < 100 || this.#offset > 500 : !continuation;
      this.#continuation = continuation;
      if (continuation) this.#seen.add(string(continuation));
      return result;
    } finally {
      this.#busy = false;
    }
  }
}

export class Job<Result> extends Capability implements T.Job<Result> {
  #action: number;
  #map: (data: Data, context: Context) => Result;
  constructor(context: Context, action: number, map: (data: Data, context: Context) => Result) {
    super(context);
    this.#action = action;
    this.#map = map;
  }
  async getStatus(): Promise<T.JobStatus<Result>> {
    const context = contextOf(this);
    const data = await context.engine.poll(context.queue, this.#action);
    if (!data || data.job?.status === "in_progress")
      return { status: "processing", retryAfterSeconds: 3 };
    if (data.job?.status === "failed")
      return {
        status: "failed",
        code: string(data.job.error?.code ?? "canva_error"),
        message: string(data.job.error?.message ?? "Canva could not complete the operation"),
      };
    return { status: "completed", result: this.#map(data, context) };
  }
}

export async function submitJob<Result>(
  context: Context,
  operation: string,
  input: Data,
  targets: Target[],
  map: (data: Data, context: Context) => Result,
): Promise<Job<Result>> {
  const action = await context.engine.submit(context.queue, operation, clean(input), targets, {
    awaitDecision: true,
  });
  return new Job(context, action, map);
}
