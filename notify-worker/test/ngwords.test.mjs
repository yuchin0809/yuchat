import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { hasNgWord } from "../../yungwords.js";
import { isNgText } from "../worker.js";

const between = (s) => s.slice(s.indexOf("// NG-LIST-BEGIN"), s.indexOf("// NG-LIST-END"));

test("不適切なことばの一覧は、画面側（yungwords.js）と Worker で同じ", () => {
  const a = between(readFileSync(new URL("../../yungwords.js", import.meta.url), "utf8"));
  const b = between(readFileSync(new URL("../worker.js", import.meta.url), "utf8"));
  assert.ok(a.length > 100);
  assert.equal(a, b);
});

test("ひどいことばは止め、ふつうの会話は止めない（画面側・Worker とも）", () => {
  const bad = ["死ね", "しねよ", "ころす", "コロス", "殺 す", "ｋｉｌｌ ｙｏｕｒｓｅｌｆ", "fuck you", "You are a BITCH!", "レイプ", "ちん・こ"];
  const ok = ["シネマに行こう", "ばかだなあ", "今日はあつい", "grape juice", "drape", "morning", "死ぬほど楽しい", "しねま", "こんにちは"];
  for (const t of bad) { assert.equal(hasNgWord(t), true, `止めるはず: ${t}`); assert.equal(isNgText(t), true, `Worker も止めるはず: ${t}`); }
  for (const t of ok) { assert.equal(hasNgWord(t), false, `止めないはず: ${t}`); assert.equal(isNgText(t), false, `Worker も止めないはず: ${t}`); }
});
