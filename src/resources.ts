import { string, type Data } from "./json";
export type Scope =
  | { kind: "library" }
  | { kind: "folder"; id: string; ancestors?: string[] }
  | { kind: "design"; id: string; locator: string };

export const RESOURCES = [
  {
    urlPattern: "https://www.canva.com/",
    title: "Canva library",
    description: "Search, create, and work with accessible library content.",
  },
  {
    urlPattern: "https://www.canva.com/folder/:folderId",
    title: "Canva folder",
    description: "Work within one folder and its current descendants.",
  },
  {
    urlPattern: "https://www.canva.com/design/:designId/*",
    title: "Canva design",
    description: "Read and edit one design.",
  },
];
export function id(value: unknown): string {
  const s = string(value);
  if (!/^[a-zA-Z0-9_-]{1,50}$/.test(s)) throw new Error("Invalid resource ID");
  return s;
}
export function designLocator(value: string): { id: string; locator: string } {
  if (!value.includes(":")) {
    id(value);
    return { id: value, locator: value };
  }
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "www.canva.com" ||
    url.port ||
    url.username ||
    url.password
  )
    throw new Error("Expected a Canva design URL");
  const match = /^\/design\/([\w-]+)(?:\/.*)?$/.exec(url.pathname);
  if (!match) throw new Error("Expected a Canva design URL");
  return { id: id(match[1]), locator: url.href };
}
export function parseResource(value: string): Scope {
  const url = new URL(value);
  if (url.origin !== "https://www.canva.com" || url.username || url.password)
    throw new Error("Unsupported resource URL");
  if (url.pathname === "/" && !url.search && !url.hash) return { kind: "library" };
  const folder = /^\/folder\/([\w-]+)\/?$/.exec(url.pathname);
  if (folder && !url.search && !url.hash) return { kind: "folder", id: id(folder[1]) };
  return { kind: "design", ...designLocator(value) };
}
export function scopeUrl(scope: Scope): string {
  return scope.kind === "library"
    ? RESOURCES[0].urlPattern
    : scope.kind === "folder"
      ? `https://www.canva.com/folder/${scope.id}`
      : `https://www.canva.com/design/${scope.id}/edit`;
}
export function resourceFor(scope: Scope) {
  return RESOURCES[scope.kind === "library" ? 0 : scope.kind === "folder" ? 1 : 2];
}
export function publicSource(value: string): string {
  const u = new URL(value);
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    (u.port && u.port !== "443") ||
    !u.hostname.includes(".") ||
    u.hostname === "localhost" ||
    /(?:\.localhost|\.local|\.internal)$/.test(u.hostname) ||
    /^[\d.]+$/.test(u.hostname) ||
    u.hostname.includes(":")
  ) {
    throw new Error("A public HTTPS source URL is required");
  }
  return u.href;
}
export function resultId(result: Data, kind: string): string {
  const base = result.job?.result ?? result.job ?? result;
  const value = kind === "comment" ? base.thread : base[kind];
  return id(value?.id);
}
