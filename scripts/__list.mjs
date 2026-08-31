import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
const ROOT = "/home/vlad/Projects/mongo_optimizer";
const SKIP = new Set(["node_modules",".git","dist",".output",".turbo","graphify-out"]);
const out = [];
const walk = (d) => { for (const e of readdirSync(d,{withFileTypes:true})) { if (SKIP.has(e.name)) continue;
  const p = join(d,e.name); if (e.isDirectory()) walk(p); else if (/\.tsx?$/.test(e.name) && !/\.gen\./.test(e.name)) {
    const rel = relative(ROOT,p);
    const sf = ts.createSourceFile(rel, readFileSync(p,"utf8"), ts.ScriptTarget.Latest, true, rel.endsWith(".tsx")?ts.ScriptKind.TSX:ts.ScriptKind.TS);
    const v = (n) => { if (ts.isAsExpression(n)) { const t = n.type.getText().replace(/\s+/g," "); if (t !== "const") {
      const { line } = sf.getLineAndCharacterOfPosition(n.getStart());
      out.push(`${rel}:${line+1}|${n.getText().replace(/\s+/g," ").slice(0,64)}`); } }
      ts.forEachChild(n,v); };
    v(sf); } } };
for (const r of ["apps","packages","scripts"]) walk(join(ROOT,r));
console.log(out.join("\n"));
