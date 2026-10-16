import { Capability, Cursor, contextOf, target, type Context } from "./capability";
import { DesignEditor } from "./design";
import { AssetReader } from "./asset";
import { clean, object, string } from "../json";
import { id } from "../resources";
import type { ResourceRef, Target } from "../engine/types";
import * as decode from "../decode";
import type * as T from "../types";

export class Folder extends Capability implements T.CanvaFolderSession {
  #id: ResourceRef;
  constructor(context: Context, folderId: ResourceRef) {
    super(
      typeof folderId === "string"
        ? { ...context, engine: context.engine.narrowFolder(folderId) }
        : context,
    );
    this.#id = folderId;
  }
  #ready(allowPending = false) {
    const context = contextOf(this);
    if (typeof this.#id === "string") return;
    if (allowPending && context.engine.action(this.#id.action).state === "queued") return;
    const folderId = context.engine.resolve(this.#id);
    context.engine = context.engine.narrowFolder(folderId);
    this.#id = folderId;
  }
  async listItems(
    options: { types?: ("design" | "folder" | "image")[]; sort?: T.FolderSort } = {},
  ) {
    this.#ready(true);
    return new Cursor<T.FolderItem>(
      contextOf(this),
      "listFolderItems",
      clean({
        path: { folderId: this.#id },
        query: { item_types: options.types, sort_by: options.sort },
      }),
      target("folder", this.#id),
      (item, context) => {
        if (item.type === "design")
          return {
            type: "design",
            summary: decode.design(object(item.design)),
            design: new DesignEditor(context, id(item.design.id)),
          };
        if (item.type === "folder")
          return {
            type: "folder",
            summary: decode.folder(object(item.folder)),
            folder: new Folder(context, item._provisional ?? id(item.folder.id)),
          };
        if (item.type === "image")
          return {
            type: "image",
            summary: decode.asset(object(item.image)),
            asset: new AssetReader(context, id(item.image.id)),
          };
        throw new Error("Unreviewed folder item type");
      },
    );
  }
  async openDesign(value: string) {
    this.#ready();
    const designId = id(value);
    await contextOf(this).engine.checkTarget({ kind: "design", id: designId });
    return new DesignEditor(contextOf(this), designId);
  }
  async openFolder(value: string) {
    this.#ready();
    const folderId = id(value);
    await contextOf(this).engine.checkTarget({ kind: "folder", id: folderId });
    return new Folder(contextOf(this), folderId);
  }
  async openAsset(value: string) {
    this.#ready();
    const assetId = id(value);
    await contextOf(this).engine.checkTarget({ kind: "image", id: assetId });
    return new AssetReader(contextOf(this), assetId);
  }
  async createFolder(name: string) {
    this.#ready(true);
    const context = contextOf(this);
    const action = await context.engine.submit(
      context.queue,
      "createFolder",
      { body: { name: string(name), parent_folder_id: this.#id } },
      target("folder", this.#id),
      { overlay: { kind: "folder", parent: this.#id, name } },
    );
    return new Folder(context, { action, kind: "folder" });
  }
  async moveItem(input: { itemId: string; destinationFolderId: string }) {
    this.#ready();
    const { engine, queue } = contextOf(this);
    const source = id(input.itemId),
      destination = id(input.destinationFolderId);
    let kind: Target["kind"] | undefined;
    for (const candidate of ["design", "folder", "image"] as const) {
      try {
        await engine.checkTarget({ kind: candidate, id: source });
        kind = candidate;
        break;
      } catch {}
    }
    if (!kind) throw new Error("Item is outside this folder tree");
    if (source === destination) throw new Error("Invalid move");
    if (engine.scope.kind === "folder" && source === engine.scope.id)
      throw new Error("Cannot move the granted folder");
    await engine.submit(
      queue,
      "moveFolderItem",
      { body: { item_id: source, to_folder_id: destination } },
      [
        { kind, id: source },
        { kind: "folder", id: destination },
      ],
      { awaitDecision: true },
    );
  }
}
