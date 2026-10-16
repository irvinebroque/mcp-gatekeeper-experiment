import type { Data } from "../src/json";

export const DESIGN_ID = "Dabcdefghij";
export const OTHER_DESIGN_ID = "D1234567890";
const timestamps = { created_at: 1_700_000_000, updated_at: 1_700_000_001 };
const owner = { user_id: "user1", team_id: "team1" };
export const design = (id = DESIGN_ID) => ({
  id,
  title: "Fixture",
  owner,
  ...timestamps,
  design_types: ["presentation"],
  page_count: 2,
  urls: {
    edit_url: `https://www.canva.com/design/${id}/edit`,
    view_url: `https://www.canva.com/design/${id}/view`,
  },
});
export const folder = (id: string, name = "Folder") => ({ id, name, ...timestamps });
export const asset = (id = "asset1") => ({
  id,
  name: "Image",
  type: "image",
  tags: [],
  owner,
  ...timestamps,
});
export const template = () => ({
  id: "template1",
  title: "Template",
  view_url: "https://www.canva.com/brand-template/template1",
  create_url: "https://www.canva.com/design/create",
  ...timestamps,
});
export const thread = (id = "comment1", text = "Draft comment") => ({
  id,
  design_id: DESIGN_ID,
  ...timestamps,
  thread_type: { type: "comment", content: { plaintext: text }, mentions: {} },
});
export const reply = (text = "Draft reply") => ({
  id: "reply1",
  design_id: DESIGN_ID,
  thread_id: "comment1",
  content: { plaintext: text },
  mentions: {},
  ...timestamps,
});

export function completedJob(operation: string, input: Data, jobId: string): Data {
  const job: Data = { id: jobId, status: "success" };
  switch (operation) {
    case "createDesignGenerationJobV2":
    case "createDesignMergeJob":
    case "createDesignResizeJob":
      job.result = { design: design(input.body?.design_id) };
      break;
    case "createUrlImportJob":
      job.result = { designs: [design()] };
      break;
    case "createUrlAssetUploadJob":
      job.asset = asset();
      break;
    case "createDesignExportJob":
      job.urls = ["https://example.com/export.pdf"];
      break;
    case "createImageGenerationJob":
      job.result = {
        image: {
          url: "https://example.com/generated.png",
          width: 100,
          height: 100,
          asset: asset(),
        },
      };
      break;
    case "createImageTransformationJob":
      job.result = { asset: asset() };
      break;
    default:
      throw new Error(`No fixture for ${operation}`);
  }
  return { job };
}
