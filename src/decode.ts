import { object, string, type Data } from "./json";
import { id } from "./resources";
import type * as T from "./types";

const optionalString = (x: unknown) => (typeof x === "string" ? x : undefined);
const optionalNumber = (x: unknown) =>
  typeof x === "number" && Number.isFinite(x) ? x : undefined;
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
  const key = id(v.id);
  return {
    id: key,
    title: string(v.title ?? ""),
    editUrl: string(v.urls.edit_url),
    viewUrl: optionalString(v.urls.view_url),
    pageCount: optionalNumber(v.page_count),
    designTypes: Array.isArray(v.design_types) ? v.design_types.map(string) : undefined,
    createdAt: timestamp(v.created_at),
    updatedAt: timestamp(v.updated_at),
    thumbnail: preview(v.thumbnail),
  };
}
export function folder(v: Data): T.FolderSummary {
  return { id: id(v.id), name: string(v.name) };
}
export function asset(v: Data): T.AssetInfo {
  const type = v.type;
  if (type !== "image" && type !== "video") throw new Error("Unsupported asset kind");
  return {
    id: id(v.id),
    name: string(v.name),
    type,
    tags: itemsOfStrings(v.tags),
    thumbnail: preview(v.thumbnail),
  };
}
export function page(v: Data): T.DesignPage {
  const n = v.page_number;
  if (!Number.isInteger(n) || n < 1) throw new Error("Invalid page number");
  return {
    id: optionalString(v.id),
    pageNumber: n,
    width: optionalNumber(v.dimensions?.width),
    height: optionalNumber(v.dimensions?.height),
    thumbnail: preview(v.thumbnail),
  };
}
export function comment(v: Data): T.CommentInfo {
  return {
    id: string(v.id),
    text: string(v.thread_type?.content?.plaintext ?? v.content?.plaintext),
    author: v.author
      ? { id: string(v.author.id), displayName: optionalString(v.author.display_name) }
      : undefined,
    createdAt: timestamp(v.created_at),
    updatedAt: timestamp(v.updated_at),
  };
}
function itemsOfStrings(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("Expected asset tags");
  return value.map(string);
}
export function dataset(v: Data): T.DatasetField[] {
  return Object.entries(object(v.dataset ?? v)).map(([name, value]) => {
    const type = String(object(value).type ?? "unknown").toLowerCase();
    return {
      name,
      type: ["text", "image", "chart"].includes(type)
        ? (type as "text" | "image" | "chart")
        : "unknown",
    };
  });
}
