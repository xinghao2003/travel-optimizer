import { readFileSync } from "node:fs";
import ts from "../node_modules/typescript/lib/typescript.js";

const options = { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } };
const urls = new Map();

// Transpile a TypeScript module to a data URL; relative imports are inlined
// the same way because data URLs cannot resolve them.
function dataUrl(file) {
  if (!urls.has(file.href)) {
    const js = ts.transpileModule(readFileSync(file, "utf8"), options).outputText
      .replace(/from "(\.{1,2}\/[^"]+)"/g, (_, path) => `from "${dataUrl(new URL(`${path}.ts`, file))}"`);
    urls.set(file.href, "data:text/javascript;base64," + Buffer.from(js).toString("base64"));
  }
  return urls.get(file.href);
}

export const loadTs = path => import(dataUrl(new URL(path, import.meta.url)));
