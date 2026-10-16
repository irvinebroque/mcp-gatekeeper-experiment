import { Capability, Cursor, contextOf, submitJob, target, type Context } from "./capability";
import { BrandTemplate } from "./brand-template";
import { Comment } from "./comment";
import { clean, items, object, string, type Data } from "../json";
import { id, resultId } from "../resources";
import * as decode from "../decode";
import type * as T from "../types";

const designIds = new WeakMap<object, string>();
const designIdOf = (capability: object) => designIds.get(capability)!;

export const designResult = (data: Data, context: Context) =>
  new Design(context, resultId(data, "design"));
export const importedDesigns = (data: Data, context: Context) =>
  items(data.job.result.designs).map((design) => new Design(context, id(design.id)));

export class DesignReader extends Capability implements T.CanvaDesignReader {
  constructor(context: Context, designId: string) {
    super(context);
    designIds.set(this, designId);
  }
  async getInfo() {
    const { engine, queue } = contextOf(this);
    const designId = designIdOf(this);
    const data = await engine.observe(
      queue,
      "getDesign",
      { path: { designId } },
      target("design", designId),
      { cache: true },
    );
    return decode.design(object(data.design));
  }
  async listPages() {
    const designId = designIdOf(this);
    return new Cursor(
      contextOf(this),
      "getDesignPages",
      { path: { designId } },
      target("design", designId),
      decode.page,
      true,
    );
  }
  async getExportFormats() {
    const { engine, queue } = contextOf(this);
    const designId = designIdOf(this);
    const data = await engine.observe(
      queue,
      "getDesignExportFormats",
      { path: { designId } },
      target("design", designId),
      { cache: true },
    );
    return Object.entries(object(data.formats))
      .filter(([format]) =>
        [
          "pdf",
          "png",
          "jpg",
          "gif",
          "pptx",
          "mp4",
          "csv",
          "html_bundle",
          "html_standalone",
        ].includes(format),
      )
      .map(([format, value]) => {
        return { format: format as T.ExportFormat, pages: object(value).page_numbers };
      });
  }
  async getDataset() {
    const { engine, queue } = contextOf(this);
    const designId = designIdOf(this);
    return decode.dataset(
      await engine.observe(
        queue,
        "getDesignDataset",
        { path: { designId } },
        target("design", designId),
        { cache: true },
      ),
    );
  }
  async openComment(value: string) {
    const designId = designIdOf(this),
      threadId = id(value);
    const { engine } = contextOf(this);
    await engine.checkTarget({ kind: "design", id: designId });
    await engine.readInternal("getThread", { path: { designId, threadId } });
    return new Comment(contextOf(this), designId, threadId);
  }
}

/** Folder-derived capabilities stop here; only library-derived Design has copy/resize/publish. */
export class DesignEditor extends DesignReader implements T.CanvaDesignEditor {
  async export(input: T.ExportOptions) {
    const context = contextOf(this),
      designId = designIdOf(this);
    const availability = await context.engine.readInternal("getDesignExportFormats", {
      path: { designId },
    });
    if (!Object.hasOwn(object(availability.formats), input.format))
      throw new Error("This design does not support that export format");
    const options = input as T.ExportOptions & Data;
    const format = clean({
      type: options.format,
      pages: options.pages,
      export_quality: options.quality,
      size: options.paperSize,
      width: options.width,
      height: options.height,
      lossless: options.lossless,
      transparent_background: options.transparentBackground,
      as_single_image: options.singleImage,
      quality: options.format === "mp4" ? options.videoQuality : options.compressionQuality,
    });
    return submitJob(
      context,
      "createDesignExportJob",
      { body: { design_id: designId, format } },
      target("design", designId),
      (data) => {
        return { format: input.format, files: itemsOrUrls(data.job.urls) };
      },
    );
  }
  async changePages(operations: T.PageOperation[]) {
    const designId = designIdOf(this);
    if (!operations.length || operations.length > 100)
      throw new Error("Choose between 1 and 100 page operations");
    const mapped = operations.map((operation) => {
      if (operation.type === "move")
        return {
          type: "move_pages",
          from_page_numbers: operation.pages,
          to_after_page_number: operation.afterPage,
        };
      if (operation.type === "delete")
        return { type: "delete_pages", page_numbers: operation.pages };
      throw new Error("Unsupported page operation");
    });
    return submitJob(
      contextOf(this),
      "createDesignMergeJob",
      { body: { type: "modify_existing_design", design_id: designId, operations: mapped } },
      target("design", designId),
      (data, context) => {
        const resultIdValue = resultId(data, "design");
        if (resultIdValue !== designId) throw new Error("Canva returned a different design");
        return new DesignEditor(context, designId);
      },
    );
  }
  async addComment(text: string) {
    const context = contextOf(this),
      designId = designIdOf(this);
    const action = await context.engine.submit(
      context.queue,
      "createThread",
      { path: { designId }, body: { message_plaintext: text } },
      target("design", designId),
      { overlay: { kind: "comment", designId, text } },
    );
    return new Comment(context, designId, { action, kind: "comment" });
  }
}

function itemsOrUrls(value: unknown): { url: string }[] {
  if (!Array.isArray(value)) throw new Error("Unexpected export result");
  return value.map((url) => ({ url: string(url) }));
}

export class Design extends DesignEditor implements T.CanvaDesignSession {
  async copy(options: { pages?: number[] } = {}) {
    const designId = designIdOf(this);
    return submitJob(
      contextOf(this),
      "createDesign",
      { body: { type: "design", design_id: designId, page_numbers: options.pages } },
      target("design", designId),
      designResult,
    );
  }
  async resize(size: T.CanvasSize) {
    const designId = designIdOf(this);
    const designType =
      "preset" in size
        ? { type: "preset", name: size.preset }
        : { type: "custom", width: size.width, height: size.height };
    return submitJob(
      contextOf(this),
      "createDesignResizeJob",
      { body: { design_id: designId, design_type: designType } },
      target("design", designId),
      designResult,
    );
  }
  async publishBrandTemplate() {
    const designId = designIdOf(this);
    return submitJob(
      contextOf(this),
      "publishBrandTemplate",
      { body: { design_id: designId } },
      target("design", designId),
      (data, context) => new BrandTemplate(context, resultId(data, "brand_template")),
    );
  }
}
