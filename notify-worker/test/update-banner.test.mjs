/* 🔄 サイトの更新のお知らせ（yuupdate.js）：版の比べ方のテスト */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { htmlSig, needsUpdate, shouldCheck } from "../../yuupdate.js";

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

test("調べる時間：日本時間の 8:00〜15:00 のあいだだけ、前から3時間以上たっているとき", () => {
  const jst = (h, m = 0) => Date.UTC(2026, 10, 11, h - 9, m);   // 日本時間 h:m
  assert.equal(shouldCheck(jst(7, 59), NaN), false, "8時より前");
  assert.equal(shouldCheck(jst(8, 0), NaN), true, "はじめて・8時ちょうど");
  assert.equal(shouldCheck(jst(14, 59), NaN), true);
  assert.equal(shouldCheck(jst(15, 0), NaN), false, "15時から");
  assert.equal(shouldCheck(jst(23), NaN), false);
  assert.equal(shouldCheck(jst(11), jst(9)), false, "2時間前に調べた");
  assert.equal(shouldCheck(jst(12, 1), jst(9)), true, "3時間以上たった");
  assert.equal(shouldCheck(jst(10), jst(11)), true, "時計が戻っていたら、調べる");
});
