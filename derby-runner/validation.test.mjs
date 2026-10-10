/* derby-runner の不正対策（締切後・不正な馬券を払わない／サーバー以外のレース結果を信用しない）のテスト
   実行：node --test derby-runner/validation.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import { betRejectReason, isTrustedRaceResult } from "./run.mjs";

const close = new Date("2026-10-20T02:20:00Z"); /* 11:20 JST（11:30 の回の締切） */
const okBet = { raceId: "2026-10-20-1130", type: "win", horses: [5], amount: 100, createdAt: new Date("2026-10-20T02:19:59Z"), placedBy: "worker" };

test("精算してよい馬券：中身が正しく、締切前（サーバーの記録時刻）に作られたもの", () => {
  assert.equal(betRejectReason(okBet, close), null);
  assert.equal(betRejectReason({ ...okBet, type: "trifecta", horses: [5, 3, 1] }, close), null);
});

test("締切後に作られた馬券は払わない", () => {
  assert.equal(betRejectReason({ ...okBet, createdAt: new Date("2026-10-20T02:20:01Z") }, close), "after_close");
  assert.equal(betRejectReason({ ...okBet, createdAt: undefined }, close), "after_close");
  assert.equal(betRejectReason(okBet, undefined), "after_close");
});

test("中身が正しくない馬券は払わない（券種・馬・金額）", () => {
  for (const over of [{ type: "jackpot" }, { horses: [11] }, { horses: [5, 5] }, { type: "trio", horses: [1, 2] }, { amount: 9 }, { amount: -100 }, { amount: 1.5 }]) {
    assert.equal(betRejectReason({ ...okBet, ...over }, close), "invalid_bet", JSON.stringify(over));
  }
});

test("移行後（SERVER_RESULTS_FROM 以降）は Worker で買われた馬券だけ払う", () => {
  assert.equal(betRejectReason({ ...okBet, placedBy: undefined }, close, null), null, "確かめる日付が無いときは今まで通り");
  assert.equal(betRejectReason({ ...okBet, placedBy: undefined }, close, "2026-10-15"), "not_server_placed");
  assert.equal(betRejectReason({ ...okBet, raceId: "2026-10-14-1130", createdAt: new Date("2026-10-14T02:19:00Z"), placedBy: undefined }, new Date("2026-10-14T02:20:00Z"), "2026-10-15"), null, "それより前のレースはそのまま");
});

test("信用できるレース結果：着順が10頭そろっていて、確かめる日付以降はサーバーが作ったものだけ", () => {
  const order = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(isTrustedRaceResult("2026-10-20", null), false);
  assert.equal(isTrustedRaceResult("2026-10-20", { resultOrder: [1, 2, 3] }), false);
  assert.equal(isTrustedRaceResult("2026-10-20", { resultOrder: order, generatedBy: "client" }, null), true, "確かめる日付が無いときは今まで通り");
  assert.equal(isTrustedRaceResult("2026-10-20", { resultOrder: order, generatedBy: "client" }, "2026-10-15"), false);
  assert.equal(isTrustedRaceResult("2026-10-14", { resultOrder: order, generatedBy: "client" }, "2026-10-15"), true, "それより前のレースはそのまま");
  assert.equal(isTrustedRaceResult("2026-10-20", { resultOrder: order, generatedBy: "github-actions" }, "2026-10-15"), true);
  assert.equal(isTrustedRaceResult("2026-10-20", { resultOrder: order, generatedBy: "worker" }, "2026-10-15"), true);
});

test("Firestore の Timestamp（toMillis）・Date・文字列のどれでも締切を判定できる", () => {
  const ts = { toMillis: () => Date.parse("2026-10-20T02:19:00Z") };
  assert.equal(betRejectReason({ ...okBet, createdAt: ts }, { toMillis: () => close.getTime() }), null);
  assert.equal(betRejectReason({ ...okBet, createdAt: "2026-10-20T02:25:00Z" }, close), "after_close");
});
