import { Capability, Cursor, contextOf, submitJob } from "./capability";
import { Design, designResult, importedDesigns } from "./design";
import { Folder } from "./folder";
import { Asset, assetResult, generatedImageResult } from "./asset";
import { BrandTemplate } from "./brand-template";
import { clean, string } from "../json";
import { designLocator, id, publicSource } from "../resources";
import * as decode from "../decode";
import type * as T from "../types";

export class Library extends Capability implements T.CanvaLibrarySession {
  async searchDesigns(options: T.DesignSearch = {}) {
    return new Cursor(
      contextOf(this),
      "listDesigns",
      clean({
        query: {
          query: options.query,
          ownership: options.ownership,
          sort_by: options.sort,
          limit: 50,
        },
      }),
      [],
      (design, context) => ({
        summary: decode.design(design),
        design: new Design(context, id(design.id)),
      }),
    );
  }
  async openDesign(value: string) {
    const designId = designLocator(string(value)).id;
    const data = await contextOf(this).engine.readInternal("getDesign", { path: { designId } });
    if (data.design?.id !== designId) throw new Error("Canva returned a different design");
    return new Design(contextOf(this), designId);
  }
  async openFolder(value: string) {
    const folderId = id(value);
    await contextOf(this).engine.readInternal("getFolder", { path: { folderId } });
    return new Folder(contextOf(this), folderId);
  }
  async openAsset(value: string) {
    const assetId = id(value);
    await contextOf(this).engine.readInternal("getAsset", { path: { assetId } });
    return new Asset(contextOf(this), assetId);
  }
  async searchBrandTemplates(options: T.BrandTemplateSearch = {}) {
    return new Cursor(
      contextOf(this),
      "listBrandTemplates",
      clean({ query: { query: options.query, ownership: options.ownership, limit: 50 } }),
      [],
      (template, context) => ({
        summary: { id: id(template.id), title: string(template.title), viewUrl: template.view_url },
        template: new BrandTemplate(context, id(template.id)),
      }),
    );
  }
  async openBrandTemplate(value: string) {
    const brandTemplateId = id(value);
    await contextOf(this).engine.readInternal("getBrandTemplate", { path: { brandTemplateId } });
    return new BrandTemplate(contextOf(this), brandTemplateId);
  }
  async createDesign(input: T.DesignBrief) {
    return submitJob(
      contextOf(this),
      "createDesignGenerationJobV2",
      {
        body: {
          brief: input.brief,
          design_type: { type: "preset", name: input.format },
          outline: input.outline,
        },
      },
      [],
      designResult,
    );
  }
  async importDesign(input: { url: string; name: string }) {
    return submitJob(
      contextOf(this),
      "createUrlImportJob",
      { body: { url: publicSource(input.url), title: input.name } },
      [],
      importedDesigns,
    );
  }
  async uploadAsset(input: { url: string; name: string }) {
    return submitJob(
      contextOf(this),
      "createUrlAssetUploadJob",
      { body: { url: publicSource(input.url), name: input.name } },
      [],
      assetResult,
    );
  }
  async generateImage(input: T.ImageBrief) {
    const ratios = { "1:1": "square", "16:9": "landscape", "9:16": "portrait" };
    if (input.aspectRatio && !ratios[input.aspectRatio])
      throw new Error("Unsupported aspect ratio");
    return submitJob(
      contextOf(this),
      "createImageGenerationJob",
      {
        body: {
          prompt: input.prompt,
          aspect_ratio: input.aspectRatio && ratios[input.aspectRatio],
          idempotency_key: crypto.randomUUID(),
          asset_upload: { type: "upload" },
        },
      },
      [],
      generatedImageResult,
    );
  }
  async combineDesigns(input: { title: string; sources: T.DesignPageSource[] }) {
    if (!input.sources.length || input.sources.length > 100)
      throw new Error("Choose between 1 and 100 source designs");
    const operations = input.sources.map((source) => ({
      type: "insert_pages",
      source: clean({ type: "design", design_id: id(source.designId), page_numbers: source.pages }),
    }));
    const targets = input.sources.map((source) => ({
      kind: "design" as const,
      id: source.designId,
    }));
    return submitJob(
      contextOf(this),
      "createDesignMergeJob",
      { body: { type: "create_new_design", title: input.title, operations } },
      targets,
      designResult,
    );
  }
  async moveItem(input: { itemId: string; destinationFolderId: string }) {
    const { engine, queue } = contextOf(this);
    await engine.submit(
      queue,
      "moveFolderItem",
      { body: { item_id: id(input.itemId), to_folder_id: id(input.destinationFolderId) } },
      [],
      { awaitDecision: true },
    );
  }
}
