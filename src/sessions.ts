import { RpcTarget, type RpcStub } from "cloudflare:workers";
import type { ApprovalQueue } from "./host/gatekeeper";
import type * as T from "./types";
import { Engine, designLocator, id, publicSource, resultId, retrySeconds, type Ref, type Target } from "./core";
import { clean, items, object, string, type Data } from "./protocol";
import * as decode from "./decode";

export type Context = { engine: Engine; queue: RpcStub<ApprovalQueue> };
const contexts = new WeakMap<object, Context>();
const c = (self: object) => contexts.get(self)!;
class Capability extends RpcTarget {
  constructor(ctx: Context) { super(); contexts.set(this, { engine: ctx.engine, queue: ctx.queue.dup() }); }
  [Symbol.dispose]() { c(this).queue[Symbol.dispose](); contexts.delete(this); }
}
const target = (kind: Target["kind"], resource: Ref): Target[] => [{ kind, id: resource }];

class Cursor<X> extends Capability implements T.Cursor<X> {
  #done = false; #busy = false; #continuation?: string; #offset = 1; #seen = new Set<string>();
  #tool: string; #args: Data; #targets: Target[]; #map: (value: Data, ctx: Context) => X; #offsetMode: boolean;
  constructor(ctx: Context, tool: string, args: Data, targets: Target[], map: (value: Data, ctx: Context) => X, offsetMode = false) {
    super(ctx); this.#tool = tool; this.#args = clean(args); this.#targets = targets; this.#map = map; this.#offsetMode = offsetMode;
  }
  async next(): Promise<X[] | null> {
    if (this.#busy) throw new Error("Read cursor pages sequentially");
    if (this.#done) {
      await c(this).engine.client.ensureActive?.();
      for (const t of this.#targets) await c(this).engine.check(t);
      await c(this).queue.authorizeObservation({ title: "End of Canva results", description: "No further results." }); return null;
    }
    this.#busy = true;
    try {
      const args = { ...this.#args, ...(this.#offsetMode ? { offset: this.#offset, limit: 100 } : { continuation: this.#continuation }) };
      const data = await c(this).engine.read(c(this).queue, this.#tool, clean(args), this.#targets);
      const values = items(data.items);
      const result = values.map(v => this.#map(v, c(this)));
      const continuation = data.continuation;
      if (continuation && this.#seen.has(continuation)) throw new Error("Repeated Canva cursor");
      this.#done = this.#offsetMode ? values.length < 100 : !continuation;
      this.#offset += values.length;
      this.#continuation = continuation;
      if (continuation) this.#seen.add(string(continuation));
      return result;
    } finally { this.#busy = false; }
  }
}
class Job<X> extends Capability implements T.Job<X> {
  #action: number; #result: (data: Data, ctx: Context) => X;
  constructor(ctx: Context, action: number, result: (data: Data, ctx: Context) => X) { super(ctx); this.#action = action; this.#result = result; }
  async getStatus(): Promise<T.JobStatus<X>> {
    const envelope = await c(this).engine.poll(c(this).queue, this.#action);
    if (!envelope) return { status: "processing", retryAfterSeconds: 3 };
    const data = envelope.job ?? envelope;
    const status = String(data.status ?? "completed").toLowerCase();
    if (["pending", "in_progress", "polled_too_early"].includes(status)) {
      if (envelope.job) return { status: "failed", code: "result_not_ready", message: "Canva did not finish this operation within its server wait. Inspect Canva; this tool has no polling method and will not be retried automatically." };
      return { status: "processing", retryAfterSeconds: retrySeconds(data) };
    }
    if (["failed", "failure"].includes(status)) return { status: "failed", code: string(data.failure?.code ?? data.failureType ?? data.error?.code ?? "canva_error"), message: string(data.failure?.message ?? data.failureMessage ?? data.error?.message ?? "Canva could not complete the operation") };
    if (!["completed", "success"].includes(status) && !data.results && !data.jobId) throw new Error("Unknown Canva job status");
    if (data.jobId && !data.status) return { status: "processing", retryAfterSeconds: 3 };
    return { status: "completed", result: this.#result(envelope, c(this)) };
  }
}
async function job<X>(ctx: Context, tool: string, args: Data, targets: Target[], result: (data: Data, ctx: Context) => X): Promise<Job<X>> {
  const n = await ctx.engine.submit(ctx.queue, tool, clean(args), targets, undefined, true);
  return new Job(ctx, n, result);
}
const designResult = (data: Data, ctx: Context) => new Design(ctx, resultId(data, "design"));
const assetResult = (data: Data, ctx: Context) => new Asset(ctx, resultId(data, "asset"));
const assetResults = (data: Data, ctx: Context) => items(data.result?.results ?? data.results).map(r => {
  if (r.type !== "MEDIA") throw new Error("Unexpected generated media kind");
  return new Asset(ctx, id(r.id));
});

export class Library extends Capability implements T.CanvaLibrarySession {
  async searchDesigns(options: T.DesignSearch = {}) {
    return new Cursor(c(this), "search-designs", clean({ query: options.query, ownership: options.ownership, sort_by: options.sort, design_types: options.types, limit: 50 }), [],
      (v, ctx) => ({ summary: decode.design(v), design: new Design(ctx, id(v.id ?? v.design_id)) }));
  }
  async searchFolders(options: T.FolderSearch = {}) {
    return new Cursor(c(this), "search-folders", clean({ query: options.query, ownership: options.ownership, limit: 50 }), [],
      (v, ctx) => ({ summary: decode.folder(v), folder: new Folder(ctx, id(v.id)) }));
  }
  async openDesign(value: string) {
    let locator = string(value);
    if (locator.startsWith("https://canva.link/")) {
      const u = new URL(locator);
      if (u.search || u.hash || u.username || u.password || !/^\/[\w-]+$/.test(u.pathname)) throw new Error("Invalid Canva shortlink");
      const r = await c(this).engine.raw("resolve-shortlink", { shortlink_id: u.pathname.slice(1) });
      locator = string(r.target_url);
    }
    const parsed = designLocator(locator);
    const result = await c(this).engine.raw("get-design", { design_id: parsed.locator });
    if (result.design?.id !== parsed.id) throw new Error("Canva returned a different design");
    return new Design(c(this), parsed.id, parsed.locator);
  }
  async openFolder(value: string) { const key = id(value); await c(this).engine.raw("list-folder-items", { folder_id: key }); return new Folder(c(this), key); }
  async openAsset(value: string) { const key = id(value); await c(this).engine.raw("get-assets", { asset_ids: [key] }); return new Asset(c(this), key); }
  async searchBrandTemplates(options: T.BrandTemplateSearch = {}) {
    return new Cursor(c(this), "search-brand-templates", clean({ query: options.query, brand_kit_id: options.brandKitId, limit: 50 }), [],
      (v, ctx) => ({ summary: { id: id(v.id), title: string(v.title), viewUrl: v.view_url }, template: new BrandTemplate(ctx, id(v.id)) }));
  }
  async openBrandTemplate(value: string) { const key = id(value); await c(this).engine.raw("get-brand-template-dataset", { template_id: key }); return new BrandTemplate(c(this), key); }
  async listBrandKits() { return new Cursor(c(this), "list-brand-kits", {}, [], v => ({ id: id(v.id), name: string(v.name ?? "") })); }
  async createDesign(input: T.DesignBrief) {
    const outline = input.outline && { sections: input.outline.sections.map(s => ({ title: s.title, points: [...(s.description ? [s.description] : []), ...(s.points ?? [])] })) };
    return job(c(this), "create-design", { brief: input.brief, format: input.format, outline }, [], designResult);
  }
  async importDesign(input: { url: string; name: string }) { return job(c(this), "import-design-from-url", { url: publicSource(input.url), name: input.name }, [], designResult); }
  async uploadAsset(input: { url: string; name: string }) { return job(c(this), "upload-asset-from-url", { url: publicSource(input.url), name: input.name }, [], assetResult); }
  async generateImage(input: T.ImageBrief) {
    const ratios: Data = { "1:1": "SQUARE_1_1", "16:9": "LANDSCAPE_16_9", "5:4": "LANDSCAPE_5_4", "4:3": "LANDSCAPE_4_3", "3:2": "LANDSCAPE_3_2", "2:1": "LANDSCAPE_2_1", "9:16": "PORTRAIT_9_16", "4:5": "PORTRAIT_4_5", "3:4": "PORTRAIT_3_4", "2:3": "PORTRAIT_2_3", "1:2": "PORTRAIT_1_2" };
    if (input.aspectRatio && !ratios[input.aspectRatio]) throw new Error("Unsupported aspect ratio");
    const refs = input.referenceAssetIds?.map(x => ({ type: "MEDIA", id: id(x) }));
    if (refs?.length) await c(this).engine.raw("get-assets", { asset_ids: refs.map(r => r.id) });
    return job(c(this), "generate-image", { prompt: input.prompt, imageReferences: refs, aspectRatio: input.aspectRatio && ratios[input.aspectRatio] }, refs?.map(r => ({ kind: "image", id: r.id })) ?? [], assetResults);
  }
  async combineDesigns(input: { title: string; sources: T.DesignPageSource[] }) {
    const operations = input.sources.map(s => ({ type: "insert_pages", source: clean({ type: "design", design_id: id(s.designId), page_numbers: s.pages }) }));
    if (!operations.length || operations.length > 100) throw new Error("Choose between 1 and 100 source designs");
    const first = await c(this).engine.submit(c(this).queue, "merge-designs", { type: "create_new_design", title: input.title, operations: [operations[0]] }, target("design", input.sources[0].designId), undefined, true);
    let last = first;
    for (let i = 1; i < operations.length; i++) {
      const destination: Ref = { action: first, kind: "design" };
      last = await c(this).engine.submit(c(this).queue, "merge-designs", { type: "modify_existing_design", design_id: destination, operations: [operations[i]] }, [{ kind: "design", id: destination }, { kind: "design", id: input.sources[i].designId }], undefined, true);
    }
    return new Job(c(this), last, designResult);
  }
  async moveItem(input: { itemId: string; destinationFolderId: string }) {
    await c(this).engine.submit(c(this).queue, "move-item-to-folder", { item_id: id(input.itemId), to_folder_id: id(input.destinationFolderId) }, [], undefined, true);
  }
}

export class Folder extends Capability implements T.CanvaFolderSession {
  #id: Ref;
  constructor(ctx: Context, key: Ref) { super(typeof key === "string" ? { ...ctx, engine: ctx.engine.narrowFolder(key) } : ctx); this.#id = key; }
  #ready(allowPending = false) {
    const ctx = c(this);
    if (typeof this.#id !== "string") {
      if (allowPending && ctx.engine.action(this.#id.action).state === "queued") return;
      const key = ctx.engine.resolve(this.#id);
      ctx.engine = ctx.engine.narrowFolder(key); this.#id = key;
    }
  }
  async listItems(options: { types?: ("design" | "folder" | "image")[]; sort?: T.FolderSort } = {}) {
    this.#ready(true);
    const key = this.#id;
    return new Cursor<T.FolderItem>(c(this), "list-folder-items", clean({ folder_id: key, item_types: options.types, sort_by: options.sort }), target("folder", key), (v, ctx) => {
      if (v.type === "design") return { type: "design", summary: decode.design(object(v.design)), design: new DesignEditor(ctx, id(v.design.id)) };
      if (v.type === "folder") return { type: "folder", summary: decode.folder(object(v.folder)), folder: new Folder(ctx, v._provisional ?? id(v.folder.id)) };
      if (v.type === "image") return { type: "image", summary: decode.asset(object(v.image)), asset: new AssetReader(ctx, id(v.image.id)) };
      throw new Error("Unreviewed folder item type");
    });
  }
  async openDesign(key: string) { this.#ready(); id(key); await c(this).engine.check({ kind: "design", id: key }); return new DesignEditor(c(this), key); }
  async openFolder(key: string) { this.#ready(); id(key); await c(this).engine.check({ kind: "folder", id: key }); return new Folder(c(this), key); }
  async openAsset(key: string) { this.#ready(); id(key); await c(this).engine.check({ kind: "image", id: key }); return new AssetReader(c(this), key); }
  async createFolder(name: string) {
    this.#ready(true);
    const n = await c(this).engine.submit(c(this).queue, "create-folder", { name: string(name), parent_folder_id: this.#id }, target("folder", this.#id), { kind: "folder", parent: this.#id, name });
    return new Folder(c(this), { action: n, kind: "folder" });
  }
  async moveItem(input: { itemId: string; destinationFolderId: string }) {
    this.#ready();
    const source = id(input.itemId), destination = id(input.destinationFolderId);
    let kind: Target["kind"] | undefined;
    for (const k of ["design", "folder", "image"] as const) { try { await c(this).engine.check({ kind: k, id: source }); kind = k; break; } catch {} }
    if (!kind) throw new Error("Item is outside this folder tree");
    // Moving the root itself would make the grant's extent ambiguous.
    const scope = c(this).engine.scope;
    if (source === destination) throw new Error("Invalid move");
    if (scope.kind === "folder" && source === scope.id) throw new Error("Cannot move the granted folder");
    await c(this).engine.submit(c(this).queue, "move-item-to-folder", { item_id: source, to_folder_id: destination }, [{ kind, id: source }, { kind: "folder", id: destination }], undefined, true);
  }
}

const designKeys = new WeakMap<object, { id: string; locator: string }>();
const d = (self: object) => designKeys.get(self)!;
export class DesignReader extends Capability implements T.CanvaDesignReader {
  constructor(ctx: Context, key: string, locator = key) { super(ctx); designKeys.set(this, { id: key, locator }); }
  async getInfo() {
    const data = await c(this).engine.read(c(this).queue, "get-design", { design_id: d(this).locator }, target("design", d(this).id), true);
    const info = decode.design(object(data.design));
    for (const a of c(this).engine.visibleEdits()) if (a.overlay?.designId === d(this).id) {
      for (const op of a.overlay.operations) if (op.type === "setTitle") info.title = op.title;
    }
    return info;
  }
  async listPages() { return new Pages(c(this), d(this).id, d(this).locator); }
  async getText(options: { pages?: number[] } = {}) {
    const data = await c(this).engine.read(c(this).queue, "get-design-content", clean({ design_id: d(this).locator, content_types: ["richtexts"], pages: options.pages }), target("design", d(this).id), true);
    let text = string(data.text);
    for (const a of c(this).engine.visibleEdits()) if (a.overlay?.designId === d(this).id) {
      const before: T.EditableText[] = clean(a.overlay.before ?? []);
      for (const op of a.overlay.operations as T.EditOperation[]) {
        if (!("elementId" in op)) continue;
        const element = before.find(e => e.id === op.elementId);
        if (!element || options.pages && !options.pages.includes(element.pageNumber)) continue;
        const old = element.text;
        const replacement = op.type === "replaceText" ? op.text : op.type === "findAndReplaceText" ? old.split(op.find).join(op.replace) : op.type === "deleteElement" ? "" : old;
        if (replacement === old) continue;
        if (!old || text.split(old).length !== 2) throw new Error("Text is still processing. Read the editing draft snapshot for the exact text elements.");
        text = text.replace(old, () => replacement); element.text = replacement;
      }
    }
    return { text };
  }
  async getPresenterNotes(options: { pages?: number[] } = {}) {
    const data = await c(this).engine.read(c(this).queue, "get-presenter-notes", clean({ design_id: d(this).id, pages: options.pages }), target("design", d(this).id));
    return items(data.notes ?? data.items).map(n => ({ pageNumber: n.page_number ?? n.page_index, text: string(n.text ?? n.notes) }));
  }
  async getExportFormats() {
    const data = await c(this).engine.read(c(this).queue, "get-export-formats", { design_id: d(this).id }, target("design", d(this).id), true);
    return Object.entries(object(data.formats)).map(([format, value]) => {
      if (!["pdf", "png", "jpg", "gif", "pptx", "mp4", "csv"].includes(format)) throw new Error("Unreviewed export format");
      return { format: format as T.ExportFormat, pages: object(value).pages };
    });
  }
  async listComments() {
    const key = d(this).id;
    return new Cursor(c(this), "list-comments", { design_id: key }, target("design", key), (v, ctx) => ({ info: decode.comment(v), comment: new Comment(ctx, key, v._provisional ?? id(v.id)) }));
  }
  async getDataset() { return decode.dataset(await c(this).engine.read(c(this).queue, "get-design-dataset", { design_id: d(this).id }, target("design", d(this).id), true)); }
}
export class DesignEditor extends DesignReader implements T.CanvaDesignEditor {
  async export(input: T.ExportOptions) {
    const x = input as T.ExportOptions & Data;
    const availability = await c(this).engine.raw("get-export-formats", { design_id: d(this).id });
    if (!Object.hasOwn(object(availability.formats), input.format)) throw new Error("This design does not support that export format");
    const format = clean({ type: x.format, pages: x.pages, export_quality: x.quality, size: x.paperSize, width: x.width, height: x.height,
      lossless: x.lossless, transparent_background: x.transparentBackground, as_single_image: x.singleImage, quality: x.format === "mp4" ? x.videoQuality : x.compressionQuality });
    return job(c(this), "export-design", { design_id: d(this).id, format }, target("design", d(this).id), data => {
      const urls = data.job?.urls ?? data.urls;
      if (!Array.isArray(urls)) throw new Error("Unexpected export result");
      return { format: input.format, files: urls.map(url => ({ url: string(url) })) };
    });
  }
  async beginEdit() {
    const key = d(this).id, ctx = c(this);
    const n = await ctx.engine.submit(ctx.queue, "start-editing-transaction", { design_id: key }, target("design", key), undefined, true);
    return new Job(ctx, n, (data, next) => {
      const txn = string(data.transaction?.transaction_id ?? data.transaction_id);
      if (!next.engine.store.get(`draft:${txn}`)) next.engine.store.put(`draft:${txn}`, { designId: key, data, closed: false });
      return new Editing(next, key, txn);
    });
  }
  async changePages(operations: T.PageOperation[]) {
    const mapped = operations.map(op => {
      if (op.type === "move") return { type: "move_pages", from_page_numbers: op.pages, to_after_page_number: op.afterPage };
      if (op.type === "delete") return { type: "delete_pages", page_numbers: op.pages };
      throw new Error("Unsupported page operation");
    });
    if (!mapped.length || mapped.length > 100) throw new Error("Choose between 1 and 100 page operations");
    for (let i = 0; i < mapped.length; i++) await c(this).engine.submit(c(this).queue, "merge-designs", { type: "modify_existing_design", design_id: d(this).id, operations: [mapped[i]] }, target("design", d(this).id), { kind: "pages", designId: d(this).id, operations: [operations[i]] });
  }
  async addComment(text: string) {
    const key = d(this).id;
    const n = await c(this).engine.submit(c(this).queue, "comment-on-design", { design_id: key, message_plaintext: text }, target("design", key), { kind: "comment", designId: key, text });
    return new Comment(c(this), key, { action: n, kind: "comment" });
  }
}

class Pages extends Capability implements T.Cursor<T.DesignPage> {
  #id: string; #locator: string; #offset = 0; #busy = false;
  constructor(ctx: Context, key: string, locator: string) { super(ctx); this.#id = key; this.#locator = locator; }
  async next(): Promise<T.DesignPage[] | null> {
    if (this.#busy) throw new Error("Read cursor pages sequentially");
    this.#busy = true;
    try {
      const ctx = c(this), engine = ctx.engine;
      await engine.check({ kind: "design", id: this.#id });
      const key = `cache:page-order:${this.#locator}`;
      const cache = engine.store.get<{ at: number; pages: T.DesignPage[] }>(key);
      let pages: T.DesignPage[] = [];
      if (cache && Date.now() - cache.at < 15_000) pages = clean(cache.pages);
      else {
        for (let offset = 1; ; offset += 100) {
          if (offset > 1001) throw new Error("Design has too many pages to verify page operations");
          const result = await engine.raw("get-design-pages", { design_id: this.#locator, offset, limit: 100 });
          const batch = items(result.items).map(decode.page); pages.push(...batch);
          if (batch.length < 100) break;
        }
        engine.store.put(key, { at: Date.now(), pages: clean(pages) });
      }
      for (const a of engine.pending()) if (a.overlay?.kind === "pages" && a.overlay.designId === this.#id) {
        for (const op of a.overlay.operations as T.PageOperation[]) {
          const indexes = new Set(op.pages);
          if (indexes.size !== op.pages.length || op.pages.some(n => !Number.isInteger(n) || n < 1 || n > pages.length)) throw new Error("Page operation refers to an unavailable page");
          const selected = pages.filter((_, i) => indexes.has(i + 1));
          const remaining = pages.filter((_, i) => !indexes.has(i + 1));
          if (op.type === "move") {
            if (!Number.isInteger(op.afterPage) || op.afterPage < 0 || op.afterPage > pages.length || indexes.has(op.afterPage)) throw new Error("Invalid page move destination");
            const anchor = op.afterPage === 0 ? undefined : pages[op.afterPage - 1];
            remaining.splice(anchor ? remaining.indexOf(anchor) + 1 : 0, 0, ...selected);
          }
          pages = remaining;
        }
      }
      pages = pages.map((p, i) => ({ ...p, pageNumber: i + 1 }));
      await engine.check({ kind: "design", id: this.#id });
      await ctx.queue.authorizeObservation({ title: "Read design pages", description: "Read page summaries including local page order changes." });
      if (this.#offset >= pages.length) return this.#offset === 0 && pages.length === 0 ? (this.#offset++, []) : null;
      const result = pages.slice(this.#offset, this.#offset + 100); this.#offset += result.length;
      return result;
    } finally { this.#busy = false; }
  }
}
export class Design extends DesignEditor implements T.CanvaDesignSession {
  async copy(options: { pages?: number[] } = {}) { return job(c(this), "copy-design", { design_id: d(this).id, page_numbers: options.pages }, target("design", d(this).id), designResult); }
  async resize(size: T.CanvasSize) {
    const design_type = "preset" in size ? { type: "preset", name: size.preset } : { type: "custom", width: size.width, height: size.height };
    return job(c(this), "resize-design", { design_id: d(this).id, design_type }, target("design", d(this).id), designResult);
  }
  async publishBrandTemplate() { return job(c(this), "publish-brand-template", { design_id: d(this).id }, target("design", d(this).id), (data, ctx) => new BrandTemplate(ctx, resultId(data, "brand_template"))); }
}

export class Comment extends Capability implements T.CanvaCommentSession {
  #design: string; #id: Ref;
  constructor(ctx: Context, design: string, key: Ref) { super(ctx); this.#design = design; this.#id = key; }
  async getInfo(): Promise<T.CommentInfo> {
    await c(this).engine.check({ kind: "design", id: this.#design });
    if (typeof this.#id !== "string") {
      const a = c(this).engine.action(this.#id.action);
      if (a.state === "queued") {
        await c(this).queue.authorizeObservation({ title: "Read comment", description: "Read locally staged comment." });
        return { id: `pending-${a.id}`, text: string(a.args.message_plaintext) };
      }
    }
    const key = c(this).engine.resolve(this.#id);
    let continuation: string | undefined;
    for (let n = 0; n < 100; n++) {
      const data = await c(this).engine.raw("list-comments", clean({ design_id: this.#design, continuation }));
      const value = items(data.items).find(x => x.id === key);
      if (value) {
        await c(this).engine.check({ kind: "design", id: this.#design });
        await c(this).queue.authorizeObservation({ title: "Read comment", description: "Read one Canva comment thread." });
        return decode.comment(value);
      }
      continuation = data.continuation; if (!continuation) break;
    }
    throw new Error("Comment no longer available");
  }
  async listReplies() { return new Cursor(c(this), "list-replies", { design_id: this.#design, comment_id: this.#id }, target("design", this.#design), decode.comment); }
  async reply(text: string) { await c(this).engine.submit(c(this).queue, "reply-to-comment", { design_id: this.#design, comment_id: this.#id, message_plaintext: text }, target("design", this.#design), { kind: "reply", commentId: this.#id, text }); }
}
const assetIds = new WeakMap<object, string>();
export class AssetReader extends Capability implements T.CanvaAssetReader {
  constructor(ctx: Context, key: string) { super(ctx); assetIds.set(this, key); }
  async getInfo() {
    const key = assetIds.get(this)!;
    const data = await c(this).engine.read(c(this).queue, "get-assets", { asset_ids: [key] }, target("image", key), true);
    const values = items(data.assets ?? data.items);
    const v = values.find(x => (x.id ?? x.asset_id) === key);
    if (!v) throw new Error("Asset unavailable");
    return decode.asset(v);
  }
}
export class Asset extends AssetReader implements T.CanvaAssetSession {
  async removeBackground() { const key = assetIds.get(this)!; return job(c(this), "remove-background", { sourceMedia: { type: "MEDIA", id: key } }, target("image", key), assetResults); }
  async separateLayers(options: { title?: string } = {}) { const key = assetIds.get(this)!; return job(c(this), "separate-image-layers", { asset_id: key, title: options.title }, target("image", key), designResult); }
}
export class BrandTemplate extends Capability implements T.CanvaBrandTemplateSession {
  #id: string;
  constructor(ctx: Context, key: string) { super(ctx); this.#id = key; }
  async getDataset() { return decode.dataset(await c(this).engine.read(c(this).queue, "get-brand-template-dataset", { template_id: this.#id }, target("template", this.#id), true)); }
  async createDesign(options: { pages?: number[] } = {}) { return job(c(this), "create-design-from-brand-template", { brand_template_id: this.#id, page_numbers: options.pages }, target("template", this.#id), designResult); }
  async openDraft() { return job(c(this), "create-brand-template-draft", { brand_template_id: this.#id }, target("template", this.#id), designResult); }
}

export class Editing extends Capability implements T.CanvaEditingSession {
  #design: string; #transaction: string;
  constructor(ctx: Context, design: string, transaction: string) { super(ctx); this.#design = design; this.#transaction = transaction; }
  #state(): Data {
    const state = c(this).engine.store.get<Data>(`draft:${this.#transaction}`);
    if (!state || state.closed) throw new Error("Draft is closed");
    for (const a of c(this).engine.actions()) if (a.args.transaction_id === this.#transaction && a.state !== "rejected") {
      if (["commit-editing-transaction", "cancel-editing-transaction"].includes(a.tool)) throw new Error("Draft is closed");
      if (a.state === "unknown" || a.state === "failed") throw new Error("Draft operation did not complete; inspect it in Canva");
      if (a.state === "applied" && a.tool === "perform-editing-operations" && a.result?.pages) state.data = { ...state.data, ...a.result };
    }
    return state;
  }
  #snapshot(): T.EditingSnapshot {
    const snapshot = decode.snapshot(this.#state().data);
    for (const a of c(this).engine.pending()) if (a.overlay?.kind === "edit" && a.args.transaction_id === this.#transaction) {
      for (const op of a.overlay.operations as T.EditOperation[]) {
        if (!("elementId" in op)) continue;
        const t = snapshot.textElements.find(e => e.id === op.elementId);
        if (op.type === "replaceText" && t) t.text = op.text;
        if (op.type === "findAndReplaceText" && t) t.text = t.text.split(op.find).join(op.replace);
        if (op.type === "deleteElement") { snapshot.textElements = snapshot.textElements.filter(e => e.id !== op.elementId); snapshot.mediaElements = snapshot.mediaElements.filter(e => e.id !== op.elementId); }
      }
    }
    return snapshot;
  }
  async getSnapshot() {
    await c(this).engine.check({ kind: "design", id: this.#design });
    const result = this.#snapshot();
    await c(this).queue.authorizeObservation({ title: "Read editing draft", description: "Read the current editable pages and elements, including local changes." });
    return result;
  }
  async apply(operations: T.EditOperation[]) {
    const snapshot = this.#snapshot(), state = this.#state();
    let firstPage: number | undefined;
    const mapped = operations.map(op => {
      if (op.type === "setTitle") return { type: "update_title", title: op.title };
      const element = [...snapshot.textElements, ...snapshot.mediaElements].find(e => e.id === op.elementId);
      if (!element) throw new Error("Element is outside the current draft");
      firstPage ??= element.pageNumber;
      const page = snapshot.pages.find(p => p.pageNumber === element.pageNumber);
      if (!page?.editable || ("editable" in element && !element.editable)) throw new Error("Element is not editable");
      if (page.responsive && ["replaceText", "formatText", "positionElement", "resizeElement", "setAutofillField"].includes(op.type)) throw new Error("Operation is unsupported on responsive pages");
      if (["replaceText", "findAndReplaceText", "formatText"].includes(op.type) && !("text" in element)) throw new Error("This operation needs a text element");
      const element_id = op.elementId;
      switch (op.type) {
        case "replaceText": return { type: "replace_text", element_id, text: op.text };
        case "findAndReplaceText": if (!op.find) throw new Error("Find text cannot be empty"); return { type: "find_and_replace_text", element_id, find_text: op.find, replace_text: op.replace };
        case "deleteElement": return { type: "delete_element", element_id };
        case "positionElement": return { type: "position_element", element_id, top: op.top, left: op.left };
        case "resizeElement": {
          const s = op.size;
          return { type: "resize_element", element_id, width: "textWidth" in s ? s.textWidth : "width" in s ? s.width : undefined, height: "height" in s ? s.height : undefined, preserve_aspect_ratio: "preserveAspectRatio" in s ? s.preserveAspectRatio : false };
        }
        case "formatText": {
          const f = op.formatting;
          return { type: "format_text", element_id, formatting: clean({ font_size: f.fontSize, text_align: f.align, color: f.color, font_weight: f.weight, font_style: f.style,
            decoration: f.decoration, strikethrough: f.strikethrough === undefined ? undefined : f.strikethrough ? "strikethrough" : "none", link: f.link, list_level: f.listLevel, list_marker: f.listMarker, line_height: f.lineHeight }) };
        }
        case "setAutofillField": return { type: "update_autofill_field", element_id, autofill_field_label: op.label };
        default: throw new Error("Unsupported edit operation");
      }
    });
    await c(this).engine.submit(c(this).queue, "perform-editing-operations", clean({ transaction_id: this.#transaction, operations: mapped, page_index: firstPage ?? 1, pages: state.data.pages }), target("design", this.#design), { kind: "edit", designId: this.#design, operations: clean(operations), before: snapshot.textElements });
  }
  async getPreview(pageNumber: number) {
    const snapshot = this.#snapshot();
    if (!snapshot.pages.some(p => p.pageNumber === pageNumber)) throw new Error("Unknown page");
    if (c(this).engine.pending().some(a => a.args.transaction_id === this.#transaction)) throw new Error("Preview is still processing; retry after the draft changes finish");
    const data = await c(this).engine.read(c(this).queue, "get-design-thumbnail", { transaction_id: this.#transaction, page_index: pageNumber }, target("design", this.#design));
    const result = decode.preview(data.thumbnail ?? data.thumbnails?.[0] ?? data);
    if (!result) throw new Error("Preview unavailable");
    return result;
  }
  async commit() { this.#state(); await c(this).engine.submit(c(this).queue, "commit-editing-transaction", { transaction_id: this.#transaction }, target("design", this.#design), undefined, true); }
  async cancel() { this.#state(); await c(this).engine.submit(c(this).queue, "cancel-editing-transaction", { transaction_id: this.#transaction }, target("design", this.#design)); }
}

export function createSession(ctx: Context): T.CanvaLibrarySession | T.CanvaFolderSession | T.CanvaDesignEditor {
  const scope = ctx.engine.scope;
  return scope.kind === "library" ? new Library(ctx) : scope.kind === "folder" ? new Folder(ctx, scope.id) : new DesignEditor(ctx, scope.id, scope.locator);
}
