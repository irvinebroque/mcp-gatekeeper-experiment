import { build } from "esbuild";
import fs from "node:fs/promises";
const result = await build({
  entryPoints: ["src/configurator/client.ts"],
  bundle: true,
  write: false,
  format: "iife",
  minify: true,
  platform: "browser",
});
const js = result.outputFiles[0].text.replaceAll("</script", "<\\/script");
await fs.mkdir("src/generated", { recursive: true });
await fs.writeFile(
  "src/generated/configurator.txt",
  `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Select Canva resource</title><style>body{font:14px system-ui;margin:16px;color:CanvasText;background:Canvas;color-scheme:light dark}label{display:block;margin-bottom:8px}input{box-sizing:border-box;width:100%;padding:10px;border:1px solid #888;border-radius:6px;font:inherit}p{font-size:12px}</style><label for="url">Canva resource URL</label><input id="url" type="url" autocomplete="off"><p role="status">Choose a library, folder, or design.</p><script>${js}</script></html>`,
);
