import fs from "node:fs/promises";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import standaloneCode from "ajv/dist/standalone/index.js";
const { tools } = JSON.parse(await fs.readFile("research/tools.json", "utf8"));
const { tools: map } = JSON.parse(await fs.readFile("research/tool-map.json", "utf8"));
const ajv = new Ajv({ code: { source: true, esm: true }, strict: false, allErrors: true });
addFormats(ajv);
const exports = {};
for (const t of tools) {
  if (map.find(m => m.name === t.name).classification === "excluded") continue;
  ajv.addSchema(t.inputSchema, t.name);
  exports[t.name.replaceAll("-", "_")] = t.name;
  if (t.outputSchema) {
    ajv.addSchema(t.outputSchema, t.name + ":output");
    exports[t.name.replaceAll("-", "_") + "_output"] = t.name + ":output";
  }
}
await fs.mkdir("src/generated", { recursive: true });
let code = standaloneCode(ajv, exports);
const modules = new Map();
code = code.replace(/require\("([^"]+)"\)/g, (_, name) => {
  if (!modules.has(name)) modules.set(name, `runtime${modules.size}`);
  return modules.get(name);
});
const imports = [...modules].map(([name, symbol]) => `import ${symbol} from ${JSON.stringify(name + ".js")};`).join("\n");
await fs.writeFile("src/generated/validators.js", "// Generated from the reviewed, pinned MCP catalog. Do not hand edit.\n" + imports + "\n" + code);
