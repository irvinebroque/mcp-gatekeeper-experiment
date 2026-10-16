import { Capability, contextOf, submitJob, target, type Context } from "./capability";
import { object, type Data } from "../json";
import { resultId } from "../resources";
import * as decode from "../decode";
import type * as T from "../types";

const assetIds = new WeakMap<object, string>();
export const assetResult = (data: Data, context: Context) =>
  new Asset(context, resultId(data, "asset"));
export const generatedImageResult = (data: Data, context: Context) =>
  new Asset(context, resultId(object(data.job.result.image), "asset"));

export class AssetReader extends Capability implements T.CanvaAssetReader {
  constructor(context: Context, assetId: string) {
    super(context);
    assetIds.set(this, assetId);
  }
  async getInfo() {
    const { engine, queue } = contextOf(this),
      assetId = assetIds.get(this)!;
    const data = await engine.observe(
      queue,
      "getAsset",
      { path: { assetId } },
      target("image", assetId),
      { cache: true },
    );
    return decode.asset(object(data.asset));
  }
}
export class Asset extends AssetReader implements T.CanvaAssetSession {
  async removeBackground() {
    const assetId = assetIds.get(this)!;
    return submitJob(
      contextOf(this),
      "createImageTransformationJob",
      { body: { asset_id: assetId, transformations: [{ type: "background_removal" }] } },
      target("image", assetId),
      assetResult,
    );
  }
}
