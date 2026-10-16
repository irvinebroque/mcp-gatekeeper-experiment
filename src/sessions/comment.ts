import { Capability, Cursor, contextOf, target, type Context } from "./capability";
import type { ResourceRef } from "../engine/types";
import { object, string } from "../json";
import * as decode from "../decode";
import type * as T from "../types";

export class Comment extends Capability implements T.CanvaCommentSession {
  #designId: string;
  #threadId: ResourceRef;
  constructor(context: Context, designId: string, threadId: ResourceRef) {
    super(context);
    this.#designId = designId;
    this.#threadId = threadId;
  }
  async getInfo(): Promise<T.CommentInfo> {
    const { engine, queue } = contextOf(this);
    await engine.checkTarget({ kind: "design", id: this.#designId });
    if (typeof this.#threadId !== "string") {
      const action = engine.action(this.#threadId.action);
      if (action.state === "queued") {
        await queue.authorizeObservation({
          title: "Read comment",
          description: "Read locally staged comment.",
        });
        return { id: `pending-${action.id}`, text: string(action.input.body.message_plaintext) };
      }
    }
    const data = await engine.observe(
      queue,
      "getThread",
      { path: { designId: this.#designId, threadId: engine.resolve(this.#threadId) } },
      target("design", this.#designId),
    );
    return decode.comment(object(data.thread));
  }
  async listReplies() {
    return new Cursor(
      contextOf(this),
      "listReplies",
      { path: { designId: this.#designId, threadId: this.#threadId } },
      target("design", this.#designId),
      decode.comment,
    );
  }
  async reply(text: string) {
    const { engine, queue } = contextOf(this);
    await engine.submit(
      queue,
      "createReply",
      {
        path: { designId: this.#designId, threadId: this.#threadId },
        body: { message_plaintext: text },
      },
      target("design", this.#designId),
      { overlay: { kind: "reply", commentId: this.#threadId, text } },
    );
  }
}
