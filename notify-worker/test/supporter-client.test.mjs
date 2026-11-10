/* ⭐ サポーターの見た目の候補（yusupporter-core.js）が、Worker の候補の表（SUPPORTER_PRESETS）と同じこと。画面の部品が同じ版の名前で読み込まれていること */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { SUPPORTER_PRESETS } from "../worker.js";
import { PRESET_IDS, isFeatureOpen, setMySupporter, EARLY_ACCESS_MS } from "../../yusupporter-core.js";

test("候補の id が、Worker と画面で同じ（種類ごと・順番も）", () => {
  assert.deepEqual(PRESET_IDS, SUPPORTER_PRESETS);
});

test("新機能の先行：サポーターは公開日時から、そうでない人は1週間あと", () => {
  const openAt = 1_000_000;
  setMySupporter(null);
  assert.equal(isFeatureOpen(openAt, openAt + 1000), false);
  assert.equal(isFeatureOpen(openAt, openAt + EARLY_ACCESS_MS), true);
  setMySupporter({ prefs: {} });
  assert.equal(isFeatureOpen(openAt, openAt + 1000), true);
  assert.equal(isFeatureOpen(openAt, openAt - 1), false);
  setMySupporter(null);
});

test("サポーターの部品は、script.js・yusupporter.js・yuworld.js のすべてが同じ版の名前で読み込む（別の名前だと、状態が別々になる）", () => {
  const re = /yusupporter-core\.js\?v=([\w-]+)/g;
  const versions = new Set();
  for (const f of ["script.js", "yusupporter.js", "yuworld.js"]) {
    const text = fs.readFileSync(new URL(`../../${f}`, import.meta.url), "utf8");
    const found = [...text.matchAll(re)].map((m) => m[1]);
    assert.ok(found.length > 0, f);
    found.forEach((v) => versions.add(v));
  }
  assert.equal(versions.size, 1);
});
