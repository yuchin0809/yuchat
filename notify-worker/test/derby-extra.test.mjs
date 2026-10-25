/* 🏇 ゆうダービーの演出（derby-show.js の写真判定・ラスト200m・derby-extra.js・derby-sound.js）のテスト
   実行：node --test "notify-worker/test/*.test.mjs" */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { buildRaceShow, getCameraTarget, RACE_FINAL_SECONDS, PHOTO_FINISH_GAP_SECONDS, RACE_MAIN_SECONDS } from "../../derby-show.js";
import { evaluateBetWin, betTrack, describeMiss, myMoves, totalPayout } from "../../derby-extra.js";
import { createRaceSound } from "../../derby-sound.js";

const horses = Array.from({ length: 10 }, (_, i) => ({ number: i + 1, name: `馬${i + 1}` }));
let seed = 12345;
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const shuffled = () => horses.map((h) => h.number).sort(() => rnd() - 0.5);
/* derby-runner の buildRaceCheckpoints と同じ作り（脚質の曲線だけ省いた） */
function checkpoints(order) {
  const step = 0.015 + rnd() * 0.025, fin = {};
  order.forEach((h, r) => { fin[h] = Math.max(0.7, 1 - r * step); });
  fin[order[0]] = 1;
  const w = {};
  horses.forEach((h) => { const a = Array.from({ length: 12 }, () => 0.3 + rnd()), tot = a.reduce((x, y) => x + y, 0); w[h.number] = a.map((x) => (x * fin[h.number]) / tot); });
  const cum = Object.fromEntries(horses.map((h) => [h.number, 0]));
  return Array.from({ length: 12 }, (_, s) => Object.fromEntries(horses.map((h) => { cum[h.number] += w[h.number][s]; return [h.number, Math.min(1, Number(cum[h.number].toFixed(4)))]; })));
}
const makeShow = (i) => { const order = shuffled(); return buildRaceShow({ resultOrder: order, checkpoints: checkpoints(order) }, { horses, raceId: `2026-10-${i}` }); };

test("derby-extra の evaluateBetWin は、script.js の判定と同じ（全部の馬券の種類・順位の組み合わせ）", () => {
  const src = fs.readFileSync(new URL("../../script.js", import.meta.url), "utf8");
  const m = /function evaluateBetWin\(bet, resultOrder\) \{[\s\S]*?\n\}\n/.exec(src);
  assert.ok(m, "script.js に evaluateBetWin がある");
  const original = new Function(`${m[0]}; return evaluateBetWin;`)();
  const pick = (k) => { const a = shuffled(); return a.slice(0, k); };
  let hits = 0;
  for (let i = 0; i < 3000; i++) {
    const order = shuffled();
    const bets = [{ type: "win", horses: pick(1) }, { type: "place", horses: pick(1) }, { type: "quinella", horses: pick(2) }, { type: "trio", horses: pick(3) }, { type: "trifecta", horses: pick(3) }, { type: "trifecta", horses: order.slice(0, 3) }, { type: "trio", horses: [order[2], order[0], order[1]] }];
    for (const b of bets) { assert.equal(evaluateBetWin(b, order), original(b, order), JSON.stringify([b, order.slice(0, 3)])); if (evaluateBetWin(b, order)) hits++; }
  }
  assert.ok(hits > 0);
});

test("レース中の馬券の様子：当たりの並びなら good、あと一歩なら near。順位は「いま○位」", () => {
  const order = [3, 5, 1, 7, 2, 4, 6, 8, 9, 10];
  assert.deepEqual(betTrack({ type: "win", horses: [3] }, order), { state: "good", ranks: [1], text: "いま1位" });
  assert.equal(betTrack({ type: "win", horses: [5] }, order).state, "near");
  assert.equal(betTrack({ type: "win", horses: [1] }, order).state, "off");
  assert.equal(betTrack({ type: "place", horses: [1] }, order).state, "good");
  assert.equal(betTrack({ type: "place", horses: [7] }, order).state, "near", "4位は、あと一歩");
  assert.equal(betTrack({ type: "quinella", horses: [5, 3] }, order).state, "good");
  assert.equal(betTrack({ type: "quinella", horses: [3, 1] }, order).state, "near");
  assert.equal(betTrack({ type: "trifecta", horses: [3, 5, 1] }, order).state, "good");
  assert.equal(betTrack({ type: "trifecta", horses: [5, 3, 1] }, order).state, "near", "3頭は上位でも、順番が違う");
  assert.equal(betTrack({ type: "trio", horses: [1, 5, 3] }, order).text, "いま 3・2・1位");
  assert.equal(betTrack({ type: "win", horses: [99] }, order).state, "off");
});

test("外れの説明：あと一歩（2着・4着・1頭だけ当たり・順番違い）がわかる", () => {
  const order = [3, 5, 1, 7, 2, 4, 6, 8, 9, 10];
  assert.deepEqual(describeMiss({ type: "win", horses: [5] }, order), { close: true, text: "5番は2着…あと一歩でした！" });
  assert.equal(describeMiss({ type: "win", horses: [9] }, order).close, false);
  assert.equal(describeMiss({ type: "place", horses: [7] }, order).close, true);
  assert.equal(describeMiss({ type: "quinella", horses: [3, 7] }, order).close, true);
  assert.equal(describeMiss({ type: "quinella", horses: [7, 2] }, order).close, false);
  assert.equal(describeMiss({ type: "trio", horses: [3, 5, 7] }, order).close, true);
  assert.match(describeMiss({ type: "trifecta", horses: [5, 3, 1] }, order).text, /順番だけ/);
  assert.match(describeMiss({ type: "trifecta", horses: [3, 5, 7] }, order).text, /2頭は順番どおり/);
});

test("自分の馬の順位の変化：先頭に立った・3位以内に上がった・落とした・先頭を明け渡した", () => {
  const texts = (prev, now) => myMoves(prev, now, [4]).map((m) => m.key);
  assert.deepEqual(texts({ 4: 2 }, { 4: 1 }), ["lead-4"]);
  assert.deepEqual(texts({ 4: 5 }, { 4: 3 }), ["top3-4"]);
  assert.deepEqual(texts({ 4: 3 }, { 4: 5 }), ["drop-4"]);
  assert.deepEqual(texts({ 4: 1 }, { 4: 2 }), ["lost-4"]);
  assert.deepEqual(texts({ 4: 6 }, { 4: 5 }), [], "小さな変化は出さない");
  assert.deepEqual(myMoves({ 4: 2 }, { 4: 1 }, [9]), [], "自分の馬でなければ出さない");
  assert.equal(totalPayout([{ payout: 300 }, { payout: 1200 }, {}]), 1500);
});

test("レースの演出：同じ入力なら同じ実況・同じ展開。ラスト200mは実況が増える。1着の実況はゴールの時刻から出る", () => {
  seed = 777;
  const order = shuffled(), cps = checkpoints(order);
  const a = buildRaceShow({ resultOrder: order, checkpoints: cps }, { horses, raceId: "x" }), b = buildRaceShow({ resultOrder: order, checkpoints: cps }, { horses, raceId: "x" });
  assert.deepEqual(a.events, b.events);
  const finalEvents = (s) => s.events.filter((e) => e.time >= RACE_FINAL_SECONDS && e.time < s.endTime).length;
  let total = 0, n = 60;
  for (let i = 0; i < n; i++) total += finalEvents(makeShow(i));
  assert.ok(total / n >= 5, `ラスト200mの実況が多い（平均 ${(total / n).toFixed(1)} 回）`);
  assert.ok(a.events.some((e) => /残り200|ラスト200/.test(e.text)), "ラスト200m の実況");
});

test("写真判定：1着と2着のゴールが1秒以内なら、判定の実況・字幕・カメラになる。結果の順番はそのまま。実況は時刻の順で、発表より前に収まる", () => {
  let photos = 0, shows = 0;
  for (let i = 0; i < 400; i++) {
    const s = makeShow(i); shows++;
    const ev = s.events;
    for (let k = 1; k < ev.length; k++) assert.ok(ev[k].time >= ev[k - 1].time, "時刻の順");
    assert.equal(ev[ev.length - 1].time, s.revealTime);
    assert.ok(ev[ev.length - 2].time <= s.revealTime - 0.79);
    const gap = s.finishTimes[s.resultOrder[1]] - s.finishTimes[s.resultOrder[0]];
    assert.equal(Boolean(s.photo), gap <= PHOTO_FINISH_GAP_SECONDS, "写真判定の条件");
    if (!s.photo) { assert.equal(s.calloutAt(s.finishTimes[s.resultOrder[0]] + 0.1).kind, "goal"); continue; }
    photos++;
    const first = ev.find((e) => e.photo), result = ev.find((e) => e.photo && /1着/.test(e.text));
    assert.ok(first && result && result.time > first.time && result.time < s.revealTime - 0.8);
    assert.ok(/写真判定|判定/.test(first.text) || /どっちだ/.test(first.text));
    assert.match(result.text, new RegExp(`${s.resultOrder[0]}番`));
    assert.ok(ev.filter((e) => e.kind === "finish" && !e.photo && e.time < result.time).length === 0, "3着以降は、判定の結果のあと");
    assert.equal(s.calloutAt(s.photo.from + 0.2).kind, "photo");
    assert.equal(s.calloutAt(s.photo.resultAt + 0.2).kind, "photoResult");
    const cam = getCameraTarget(s, s.photo.from + 0.3);
    assert.ok(cam.zoom >= 5 && cam.center > 0.9, "ゴール板の前で、2頭を大きく");
  }
  assert.ok(photos / shows > 0.05 && photos / shows < 0.4, `写真判定は、1〜3割ほど（${photos}/${shows}）`);
});

test("字幕の一言・画面の効き・カメラ：スタート／ラスト200m／1着。揺れは0〜1、ゴールで光る。カメラの値は有限", () => {
  const s = makeShow(1), goal = s.finishTimes[s.resultOrder[0]];
  assert.equal(s.calloutAt(0.5).kind, "start");
  assert.equal(s.calloutAt(RACE_FINAL_SECONDS + 0.1).kind, "final");
  assert.equal(s.calloutAt(20), null);
  assert.equal(s.effectsAt(10).shake, 0);
  assert.ok(s.effectsAt(RACE_FINAL_SECONDS + 0.5).shake > 0 && s.effectsAt(RACE_FINAL_SECONDS + 0.5).intense);
  assert.ok(s.effectsAt(goal + 0.1).flash > 0.5 && s.effectsAt(goal + 1).flash === 0);
  for (let t = -2; t < s.revealTime + 5; t += 0.25) {
    const fx = s.effectsAt(t), cam = getCameraTarget(s, t);
    assert.ok(fx.shake >= 0 && fx.shake <= 1 && fx.flash >= 0 && fx.flash <= 1);
    assert.ok(Number.isFinite(cam.center) && Number.isFinite(cam.zoom) && cam.zoom > 0, `t=${t}`);
    s.commentaryAt(t);
  }
  assert.equal(RACE_FINAL_SECONDS, RACE_MAIN_SECONDS * 0.85);
});

test("レースの音：ブラウザ（AudioContext）がなくても、呼んでも落ちない。初めは切。入／切を覚える（覚えられなくても動く）", () => {
  const store = {};
  globalThis.localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; } };
  try {
    const snd = createRaceSound();
    assert.equal(snd.enabled, false, "初めは切");
    snd.cue("fanfare"); snd.update({ crowd: 1, hooves: 1 }); snd.pause();
    let seen = null; snd.onChange((on) => { seen = on; });
    snd.setEnabled(true);
    assert.equal(snd.enabled, true); assert.equal(seen, true); assert.equal(store.derbySound, "on");
    snd.cue("win"); snd.update({ crowd: 0.5, hooves: 0.5 });
    assert.equal(snd.toggle(), false); assert.equal(store.derbySound, "off");
    assert.equal(createRaceSound().enabled, false);
    store.derbySound = "on";
    assert.equal(createRaceSound().enabled, true, "覚えていた状態");
  } finally { delete globalThis.localStorage; }
  const noStore = createRaceSound(); noStore.setEnabled(true); noStore.cue("goal");
});
