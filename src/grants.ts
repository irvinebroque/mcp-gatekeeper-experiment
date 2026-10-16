import { RESOURCES } from "./core";

export function patterns(value?: string[]): string[] {
  const p = value === undefined ? RESOURCES.map(r => r.urlPattern) : value;
  if (!Array.isArray(p) || p.some(x => !RESOURCES.some(r => r.urlPattern === x))) throw new Error("Unknown resource grant");
  return [...new Set(p)];
}
