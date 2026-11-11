/* 🎱 ビリヤードの球の動き（yubilliards-core.js）：決まった計算・同じ入力なら同じ動き・ポケット・手球の反則 */
import test from "node:test";
import assert from "node:assert/strict";
import { newGame, shoot, step, runToRest, isRest, settle, remaining, isCleared, cueBall, aimLine, TABLE } from "../../yubilliards-core.js";

test("最初：手球1個と15個の的の球。止まっている。三角の球どうしは重なっていない", () => {
  const g = newGame();
  assert.equal(g.balls.length, 16); assert.equal(remaining(g), 15); assert.ok(isRest(g));
  for (let i = 0; i < g.balls.length; i++) for (let j = i + 1; j < g.balls.length; j++) assert.ok(Math.hypot(g.balls[i].x - g.balls[j].x, g.balls[i].y - g.balls[j].y) >= TABLE.r * 2, `${i}-${j}`);
});

test("同じ向き・強さで打てば、いつも同じ結果になる。動いている間は打てない", () => {
  const a = newGame(), b = newGame();
  assert.equal(shoot(a, 0.01, 1), true); assert.equal(shoot(b, 0.01, 1), true);
  assert.equal(shoot(a, 0.5, 1), false, "動いている間は打てない");
  runToRest(a); runToRest(b);
  assert.deepEqual(a.balls, b.balls);
  assert.equal(a.shots, 1);
  assert.ok(a.balls.some((x) => x.id > 0 && (Math.abs(x.x - 740) > 1)), "的の球が動いた");
});

test("球はテーブルの外に出ない。かならず止まる（上限の刻みの前に）", () => {
  const g = newGame();
  shoot(g, 0.3, 1);
  const n = runToRest(g, 6000);
  assert.ok(n < 6000); assert.ok(isRest(g));
  for (const b of g.balls) if (b.on) { assert.ok(b.x >= TABLE.r - 0.01 && b.x <= TABLE.w - TABLE.r + 0.01); assert.ok(b.y >= TABLE.r - 0.01 && b.y <= TABLE.h - TABLE.r + 0.01); }
});

test("ポケットに向かって転がした球は落ちる。落ちた球は数に入る", () => {
  const g = newGame();
  g.balls.forEach((b) => { if (b.id > 1) b.on = false; });
  const t = g.balls[1]; t.x = 940; t.y = 60; t.vx = 0; t.vy = 0;       // 右上の隅の近く
  shoot(g, -0.0, 0.0001);                                              // 手球を、ほとんど動かさない
  cueBall(g).vx = 0; cueBall(g).vy = 0;
  t.vx = 4; t.vy = -4;
  runToRest(g);
  assert.equal(t.on, false); assert.deepEqual(g.pocketed, [1]); assert.equal(remaining(g), 0); assert.equal(isCleared(g), true);
});

test("手球がポケットに落ちたら反則：反則が1つ増え、手球が戻る（球と重ならない）", () => {
  const g = newGame();
  g.balls[0].x = 60; g.balls[0].y = 60; g.balls[0].vx = -6; g.balls[0].vy = -6; g.shots = 1;
  runToRest(g);
  assert.equal(cueBall(g).on, false);
  const r = settle(g);
  assert.equal(r.scratch, true); assert.equal(g.fouls, 1); assert.equal(cueBall(g).on, true);
  for (const b of g.balls) if (b.on && b.id > 0) assert.ok(Math.hypot(b.x - cueBall(g).x, b.y - cueBall(g).y) >= TABLE.r * 2);
  assert.equal(settle(newGame()).scratch, false);
});

test("球どうしの衝突で、勢いが保たれる（エネルギーは増えない）", () => {
  const g = newGame();
  g.balls.forEach((b) => { if (b.id > 1) b.on = false; });
  g.balls[0].x = 300; g.balls[0].y = 250; g.balls[1].x = 340; g.balls[1].y = 250; g.balls[1].vx = 0;
  g.balls[0].vx = 5; g.balls[0].vy = 0;
  const e0 = 25;
  for (let i = 0; i < 12; i++) step(g);
  const e1 = g.balls.reduce((s, b) => s + (b.on ? b.vx * b.vx + b.vy * b.vy : 0), 0);
  assert.ok(e1 <= e0 + 1e-9);
  assert.ok(g.balls[1].vx > 3, "当たった球が、前に進む");
});

test("狙いの線：まっすぐ進んで、最初に当たる球が分かる", () => {
  const g = newGame();
  const line = aimLine(g, 0);   // 右へ
  assert.equal(line.hit, 1);
  assert.ok(line.x2 < 740 + 1 && line.x2 > 600);
  const up = aimLine(g, -Math.PI / 2);
  assert.equal(up.hit, null);
});
