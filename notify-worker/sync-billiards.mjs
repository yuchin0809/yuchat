/* ビリヤードの球の動き・ルール（../yubilliards-core.js）を、Worker（worker.js）に写す。
   Worker は1つのファイルで動くため、画面の部品を読み込めない。同じ計算を2か所に持つので、ずれないように、写しはこの道具で作る。
   使い方：node notify-worker/sync-billiards.mjs（worker.js の「billiards-core」の印のあいだを作り直す）。テスト（billiards-room.test.mjs）が、ずれていないか確かめる */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
export const BEGIN = "/* ===== billiards-core: begin（yubilliards-core.js の写し。node notify-worker/sync-billiards.mjs で作る。手で直さない） ===== */";
export const END = "/* ===== billiards-core: end ===== */";
export function buildBlock() {
  const src = readFileSync(path.join(here, "..", "yubilliards-core.js"), "utf8");
  const names = [...src.matchAll(/^export (?:const|function) (\w+)/gm)].map((m) => m[1]);
  const body = src.replace(/^export /gm, "").trimEnd();
  return `${BEGIN}\nconst BILLIARDS = (() => {\n${body}\nreturn { ${names.join(", ")} };\n})();\n${END}`;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = path.join(here, "worker.js");
  const w = readFileSync(file, "utf8");
  const a = w.indexOf(BEGIN), b = w.indexOf(END);
  if (a < 0 || b < 0) { console.error("worker.js に印がありません"); process.exit(1); }
  writeFileSync(file, w.slice(0, a) + buildBlock() + w.slice(b + END.length));
  console.log("worker.js の billiards-core を更新しました");
}
