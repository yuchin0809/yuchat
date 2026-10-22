/* クライアント（../../yuworld.js）の台設定が、Worker（worker.js）の権威設定とずれていないことを確かめる。
   ブラウザ無しで動く軽いチェック。狙いは「料金・特別役の対応がクライアントとサーバーで一致」していること。
   とくに「オリジナル絵柄の画像は ゆうベーシック／ゆうラッシュ だけ」という絶対条件をクライアント側でも守る。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { SLOT_MACHINES, SLOT_ASSET_MIN } from "../worker.js";

const clientSrc = fs.readFileSync(fileURLToPath(new URL("../../yuworld.js", import.meta.url)), "utf8");

/* yuworld.js の MACHINES 配列から各台の id/price/special を取り出す（単純な正規表現で十分） */
function parseClientMachines(src) {
  const block = src.match(/const MACHINES = \[([\s\S]*?)\];/);
  assert.ok(block, "yuworld.js に MACHINES 配列が見つからない");
  const machines = {};
  const re = /\{\s*id:\s*"([^"]+)",[^}]*?price:\s*(\d+),\s*special:\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(block[1]))) machines[m[1]] = { price: Number(m[2]), special: m[3] };
  return machines;
}

/* ORIG_IMAGES（オリジナル絵柄の画像）に登録されている台を取り出す */
function parseOrigImageMachines(src) {
  const block = src.match(/const ORIG_IMAGES = \{([\s\S]*?)\};/);
  assert.ok(block, "yuworld.js に ORIG_IMAGES が見つからない");
  return [...block[1].matchAll(/(\w+):\s*"/g)].map((x) => x[1]);
}

test("クライアントの台設定が Worker と一致（id・料金・特別役）", () => {
  const client = parseClientMachines(clientSrc);
  const serverIds = Object.keys(SLOT_MACHINES).sort();
  assert.deepEqual(Object.keys(client).sort(), serverIds, "台の一覧がサーバーと違う");
  for (const id of serverIds) {
    assert.equal(client[id].price, SLOT_MACHINES[id].price, `${id} の料金がサーバーと違う`);
    assert.equal(client[id].special, SLOT_MACHINES[id].special, `${id} の特別役がサーバーと違う`);
  }
});

test("オリジナル絵柄の画像は orig 台（ゆうベーシック／ゆうラッシュ）だけに登録されている", () => {
  const origImageMachines = parseOrigImageMachines(clientSrc).sort();
  const origServerMachines = Object.keys(SLOT_MACHINES).filter((id) => SLOT_MACHINES[id].special === "orig").sort();
  assert.deepEqual(origImageMachines, origServerMachines, "オリジナル絵柄の画像を持つ台が orig 台と一致しない");
  // triple7 台にはオリジナル画像を絶対に割り当てない
  for (const id of Object.keys(SLOT_MACHINES)) {
    if (SLOT_MACHINES[id].special !== "orig") assert.ok(!origImageMachines.includes(id), `${id}（777台）にオリジナル絵柄の画像があってはいけない`);
  }
});

test("オリジナル絵柄の画像ファイルが実在する（置き換え・捏造でないこと）", () => {
  const origImageMachines = parseOrigImageMachines(clientSrc);
  for (const id of origImageMachines) {
    const p = fileURLToPath(new URL(`../../assets/yuworld/symbol-${id}.png`, import.meta.url));
    assert.ok(fs.existsSync(p), `画像が無い: assets/yuworld/symbol-${id}.png`);
    assert.ok(fs.statSync(p).size > 1000, `画像が小さすぎる（壊れている可能性）: symbol-${id}.png`);
  }
});

test("クライアントの「遊ぶのに必要な総資産」が Worker と一致（assetMin と SLOT_ASSET_MIN）", () => {
  const block = clientSrc.match(/const MACHINES = \[([\s\S]*?)\];/)[1];
  const client = {};
  for (const m of block.matchAll(/\{\s*id:\s*"([^"]+)"[^\n]*?assetMin:\s*(\d+)/g)) client[m[1]] = Number(m[2]);
  assert.deepEqual(client, SLOT_ASSET_MIN, "台ごとの必要な総資産がサーバーと違う");
});
