/* 🔄 サイトの更新のお知らせ（yuupdate.js）：版の比べ方のテスト */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { htmlSig, needsUpdate } from "../../yuupdate.js";

const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");

test("index.html から部品の版が取れる（スクリプト・スタイル・更新のお知らせ自身）", () => {
  const sig = htmlSig(html);
  assert.ok(sig.includes("script.js?v="), "アプリ本体の版");
  assert.ok(sig.includes("style.css?v="), "スタイルの版");
  assert.ok(sig.includes("yuupdate.js?v="), "更新のお知らせの部品");
});

test("版が同じなら出さない。ちがえば出す。どちらかが空なら、判断しない", () => {
  const a = htmlSig(html);
  assert.equal(needsUpdate(a, htmlSig(html)), false);
  assert.equal(needsUpdate(a, htmlSig(html.replace("script.js?v=", "script.js?v=x"))), true);
  assert.equal(needsUpdate("", a), false); assert.equal(needsUpdate(a, ""), false);
  assert.equal(htmlSig("<p>?v=1 は、属性の外なので数えない</p>"), "");
});

test("版以外の書き換え（本文）では、出さない", () => {
  const a = htmlSig(html);
  assert.equal(needsUpdate(a, htmlSig(html.replace("<body", "<!-- x --><body"))), false);
});
