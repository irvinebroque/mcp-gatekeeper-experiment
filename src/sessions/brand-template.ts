import { Capability, contextOf, submitJob, target, type Context } from "./capability";
import { designResult } from "./design";
import * as decode from "../decode";
import type * as T from "../types";

export class BrandTemplate extends Capability implements T.CanvaBrandTemplateSession {
  #id: string;
  constructor(context: Context, templateId: string) {
    super(context);
    this.#id = templateId;
  }
  async getDataset() {
    const { engine, queue } = contextOf(this);
    return decode.dataset(
      await engine.observe(
        queue,
        "getBrandTemplateDataset",
        { path: { brandTemplateId: this.#id } },
        target("template", this.#id),
        { cache: true },
      ),
    );
  }
  async createDesign(options: { pages?: number[] } = {}) {
    return submitJob(
      contextOf(this),
      "createDesign",
      {
        body: { type: "brand_template", brand_template_id: this.#id, page_numbers: options.pages },
      },
      target("template", this.#id),
      designResult,
    );
  }
}
