/* 🎰 ゆうスロの演出の判断（前兆・ステップアップ・連チャン）のテスト。見た目だけで、結果は変えない
   実行：node --test "notify-worker/test/*.test.mjs" */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { OMEN_STEP_MS, isWinLike, planOmen, omenWaitMs, nextChain, chainTier, chainLabel, chainBadge } from "../../yuworld-fx.js";

const mulberry = (seed) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const BIG = { feverPending: true, coinWin: true, result: "special" };
const WIN = { coinWin: true, result: "win" }, TREASURE = { result: "treasure", coinWin: true }, STAR = { result: "star" }, REPLAY = { result: "replay" }, LOSE = { result: "lose" };

test("当たりの種類：特別役・コインの当たり・宝箱・星は当たり。REPLAY・ハズレは違う", () => {
  for (const s of [BIG, WIN, TREASURE, STAR]) assert.equal(isWinLike(s), true);
  for (const s of [REPLAY, LOSE, null, undefined]) assert.equal(isWinLike(s), false);
});

test("前兆：FEVER 中・結果がないときは出さない。当たりそうな回ほど出やすい。ハズレにもたまに出る（ガセ）", () => {
  const rand = mulberry(7);
  assert.equal(planOmen(BIG, { fever: true, rand }), null); assert.equal(planOmen(null, { rand }), null);
  const rate = (spin, n = 20000) => { let k = 0; for (let i = 0; i < n; i++) if (planOmen(spin, { rand })) k++; return k / n; };
  const big = rate(BIG), mid = rate(WIN), replay = rate(REPLAY), lose = rate(LOSE);
  assert.ok(big > 0.66 && big < 0.74, `大当たり ${big}`); assert.ok(mid > 0.22 && mid < 0.28, `コインの当たり ${mid}`);
  assert.ok(replay > 0.06 && replay < 0.1, `REPLAY ${replay}`); assert.ok(lose > 0.08 && lose < 0.12, `ハズレ ${lose}`);
  assert.ok(big > mid && mid > lose && lose > 0);
});

test("前兆：いちばん強い予告（レベル3・ランプの金）は、本物の大当たりのときだけ。どちらの種類も出る", () => {
  const rand = mulberry(11), seen = { big: { rumble: new Set(), step: new Set() }, other: { rumble: new Set(), step: new Set() } };
  for (let i = 0; i < 30000; i++) {
    for (const [spin, key] of [[BIG, "big"], [WIN, "other"], [STAR, "other"], [TREASURE, "other"], [REPLAY, "other"], [LOSE, "other"]]) {
      const o = planOmen(spin, { rand }); if (o) seen[key][o.type].add(o.level);
    }
  }
  assert.deepEqual([...seen.big.rumble].sort(), [1, 2, 3]); assert.deepEqual([...seen.big.step].sort(), [1, 2, 3]);
  assert.deepEqual([...seen.other.rumble].sort(), [1, 2], "ハズレや小さい当たりでは、レベル3は出ない"); assert.deepEqual([...seen.other.step].sort(), [1, 2], "ランプは赤まで。金は出ない");
});

test("前兆：大当たりのときは、強い予告ほど出やすい（レベル1：2割・2：4割・3：4割）", () => {
  const rand = mulberry(3), c = { 1: 0, 2: 0, 3: 0 }; let n = 0;
  for (let i = 0; i < 60000; i++) { const o = planOmen(BIG, { rand }); if (o) { c[o.level]++; n++; } }
  assert.ok(Math.abs(c[1] / n - 0.2) < 0.02 && Math.abs(c[2] / n - 0.4) < 0.02 && Math.abs(c[3] / n - 0.4) < 0.02, JSON.stringify(c));
});

test("自動回転が待つ時間：ステップアップはランプの数ぶん、前兆はレベルが高いほど長い", () => {
  assert.equal(omenWaitMs(null), 0);
  assert.equal(omenWaitMs({ type: "step", level: 1 }), OMEN_STEP_MS + 300); assert.equal(omenWaitMs({ type: "step", level: 3 }), 3 * OMEN_STEP_MS + 300);
  assert.deepEqual([1, 2, 3].map((level) => omenWaitMs({ type: "rumble", level })), [500, 800, 1100]);
});

test("連チャン：当たりで +1、ハズレで 0、REPLAY は変わらない。FEVER 中の回は数えない", () => {
  let n = 0;
  n = nextChain(n, WIN, false); assert.equal(n, 1);
  n = nextChain(n, TREASURE, false); assert.equal(n, 2);
  n = nextChain(n, REPLAY, false); assert.equal(n, 2, "REPLAY は数えず、切れもしない");
  n = nextChain(n, STAR, false); assert.equal(n, 3);
  n = nextChain(n, WIN, true); assert.equal(n, 3, "FEVER 中は果物が毎回揃うので、数えない");
  n = nextChain(n, BIG, false); assert.equal(n, 4);
  n = nextChain(n, LOSE, true); assert.equal(n, 4, "FEVER 中の回では、切れもしない");
  n = nextChain(n, LOSE, false); assert.equal(n, 0);
});

test("連チャンの表示：2連から。数が増えるほど派手（段階 1・2・3）", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map(chainTier), [0, 0, 1, 2, 2, 3, 3]);
  assert.equal(chainLabel(2), "2連チャン！"); assert.equal(chainLabel(3), "3連チャン!!"); assert.equal(chainLabel(5), "5連チャン!!!");
  assert.equal(chainBadge(1), ""); assert.equal(chainBadge(0), ""); assert.equal(chainBadge(4), "🔥 4連チャン中");
});

test("画面（yuworld.js）は、この判断の部品を使い、結果（Worker）を変えない：読み込む名前と、バージョンつきの読み込み", () => {
  const src = fs.readFileSync(fileURLToPath(new URL("../../yuworld.js", import.meta.url)), "utf8");
  assert.match(src, /from "\.\/yuworld-fx\.js\?v=[\w-]+"/);
  for (const name of ["planOmen", "omenWaitMs", "nextChain", "chainLabel", "chainBadge", "isWinLike"]) assert.ok(src.includes(name), name);
  assert.ok(!/state\.(balance|freeSpins)\s*=\s*[^;]*(omen|chain)/i.test(src), "演出が残高などを書き換えない");
});
