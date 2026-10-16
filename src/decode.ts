import { items, object, string, type Data } from "./protocol";
import { id } from "./core";
import type * as T from "./types";

const optionalString = (x: unknown) => typeof x === "string" ? x : undefined;
const optionalNumber = (x: unknown) => typeof x === "number" && Number.isFinite(x) ? x : undefined;
export function timestamp(x: unknown): string | undefined {
  if (typeof x === "number") return new Date(x * 1000).toISOString();
  return optionalString(x);
}
export function preview(x: unknown): T.ImagePreview | undefined {
  if (!x) return undefined;
  const v = object(x);
  const url = new URL(string(v.url));
  if (url.protocol !== "https:") throw new Error("Invalid preview URL");
  return { url: url.href, width: optionalNumber(v.width), height: optionalNumber(v.height) };
}
export function design(v: Data): T.DesignInfo {
  const key = id(v.id ?? v.design_id);
  return { id: key, title: string(v.title ?? ""), editUrl: string(v.edit_url ?? v.urls?.edit_url ?? `https://www.canva.com/design/${key}/edit`),
    viewUrl: optionalString(v.view_url ?? v.urls?.view_url), pageCount: optionalNumber(v.page_count),
    designTypes: Array.isArray(v.design_types) ? v.design_types.map(string) : undefined,
    createdAt: timestamp(v.created_at), updatedAt: timestamp(v.updated_at), thumbnail: preview(v.thumbnail) };
}
export function folder(v: Data): T.FolderSummary { return { id: id(v.id), name: string(v.name) }; }
export function asset(v: Data): T.AssetInfo {
  const type = String(v.type ?? "image").toLowerCase();
  if (type !== "image" && type !== "video") throw new Error("Unsupported asset kind");
  return { id: id(v.id ?? v.asset_id), name: string(v.name ?? ""), type, tags: (v.tags ?? []).map(string), thumbnail: preview(v.thumbnail) };
}
export function page(v: Data): T.DesignPage {
  const n = v.page_number ?? v.index;
  if (!Number.isInteger(n) || n < 1) throw new Error("Invalid page number");
  return { id: optionalString(v.id), pageNumber: n, width: optionalNumber(v.dimensions?.width), height: optionalNumber(v.dimensions?.height), thumbnail: preview(v.thumbnail) };
}
export function comment(v: Data): T.CommentInfo {
  return { id: string(v.id), text: string(v.thread_type?.content?.plaintext ?? v.content?.plaintext ?? v.message_plaintext ?? v.text),
    author: v.author ? { id: string(v.author.id), displayName: optionalString(v.author.display_name) } : undefined,
    createdAt: timestamp(v.created_at), updatedAt: timestamp(v.updated_at) };
}
export function dataset(v: Data): T.DatasetField[] {
  return Object.entries(object(v.dataset ?? v)).map(([name, value]) => {
    const type = String(object(value).type ?? "unknown").toLowerCase();
    return { name, type: ["text", "image", "chart"].includes(type) ? type as "text" | "image" | "chart" : "unknown" };
  });
}
export function snapshot(v: Data): T.EditingSnapshot {
  return {
    pages: items(v.pages).map(p => ({ id: string(p.page_id), pageNumber: p.page_number, responsive: !!p.is_responsive,
      editable: p.is_editable !== false, empty: !!p.is_empty, width: optionalNumber(p.dimension?.width), height: optionalNumber(p.dimension?.height) })),
    textElements: items(v.richtexts ?? []).map(t => ({ id: string(t.element_id), pageNumber: t.page_index,
      text: items(t.regions).map(r => typeof r.text === "string" ? r.text : "").join("") })),
    mediaElements: items(v.fills ?? []).map(f => {
      if (f.type !== "image" && f.type !== "video") throw new Error("Unsupported fill kind");
      return { id: string(f.element_id), pageNumber: f.page_index, type: f.type, editable: f.editable !== false };
    }),
  };
}
