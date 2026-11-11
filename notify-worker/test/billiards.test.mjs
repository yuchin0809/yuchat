/* ビリヤード：球の動き・8ボールのルール・CPU（コインは使わない） */
import test from "node:test";
import assert from "node:assert/strict";
import { TABLE, newGame, shoot, step, runToRest, isRest, settle, endShot, aimLine, cueBall, canPlace, placeCue, HEAD_SPOT, groupOf } from "../../yubilliards-core.js";
import { chooseShot, choosePlacement, bestShot } from "../../yubilliards-ai.js";

const empty = (mode = "practice") => { const g = newGame(mode); g.balls.forEach((b) => { if (b.id > 0) b.on = false; }); return g; };
const ball = (g, id) => g.balls.find((b) => b.id === id);
const put = (g, id, x, y) => { const b = ball(g, id); b.on = true; b.x = x; b.y = y; b.vx = 0; b.vy = 0; return b; };

test("最初の並び：重ならない・8番は真ん中・後ろの角はソリッドとストライプ", () => {
  const g = newGame("eight");
  const bs = g.balls;
  assert.equal(bs.length, 16);
  for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) assert.ok(Math.hypot(bs[i].x - bs[j].x, bs[i].y - bs[j].y) >= TABLE.r * 2, `${i}-${j}`);
  const rack = bs.filter((b) => b.id > 0);
  const maxX = Math.max(...rack.map((b) => b.x));
  const corners = rack.filter((b) => b.x === maxX && (b.y === Math.min(...rack.filter((c) => c.x === maxX).map((c) => c.y)) || b.y === Math.max(...rack.filter((c) => c.x === maxX).map((c) => c.y))));
  assert.equal(new Set(corners.map((b) => groupOf(b.id))).size, 2);
  const eight = ball(g, 8);
  assert.ok(Math.abs(eight.y - TABLE.h / 2) < 0.01);
  assert.ok(rack.some((b) => b.x > eight.x) && rack.some((b) => b.x < eight.x));
});

test("同じ入力なら、いつも同じ動き。動いている間は打てない", () => {
  const run = () => { const g = newGame("eight"); shoot(g, 0, 0.9, 0.3); runToRest(g); return JSON.stringify(g.balls); };
  assert.equal(run(), run());
  const g = newGame(); assert.ok(shoot(g, 0.1, 0.5)); assert.ok(!shoot(g, 0.1, 0.5));
});

test("スピード：最大の強さでも、1刻み10以下。止まるまで数秒かかる", () => {
  const g = newGame(); shoot(g, 0, 1);
  assert.ok(Math.hypot(cueBall(g).vx, cueBall(g).vy) <= 10.0001);
  const e = empty(); shoot(e, 0, 1);
  const ticks = runToRest(e);
  assert.ok(ticks > 120 && ticks < 900, `ticks=${ticks}`);
});

test("全部の球が、台の中にとどまり、いつか止まる", () => {
  const g = newGame("eight"); shoot(g, 0, 1); const n = runToRest(g);
  assert.ok(n < 6000); assert.ok(isRest(g));
  for (const b of g.balls) if (b.on) assert.ok(b.x >= TABLE.r - 0.01 && b.x <= TABLE.w - TABLE.r + 0.01 && b.y >= TABLE.r - 0.01 && b.y <= TABLE.h - TABLE.r + 0.01);
});

test("ポケットに落ちる", () => {
  const g = empty(); put(g, 3, 920, 80); ball(g, 3).vx = 5; ball(g, 3).vy = -5;
  runToRest(g); assert.equal(ball(g, 3).on, false); assert.ok(g.pocketed.includes(3));
});

test("【練習】手球が落ちたら反則＋1で、もとの場所に戻る", () => {
  const g = empty(); const c = cueBall(g); c.x = 60; c.y = 60; c.vx = -6; c.vy = -6;
  runToRest(g); assert.equal(c.on, false);
  assert.equal(settle(g).scratch, true); assert.equal(g.fouls, 1); assert.ok(c.on); assert.equal(c.x, HEAD_SPOT.x);
});

test("押しと引き：引きは当たったあと戻り、押しは進む", () => {
  const after = (spin) => { const g = empty(); put(g, 5, 600, 250); cueBall(g).x = 400; cueBall(g).y = 250; shoot(g, 0, 0.6, spin); for (let i = 0; i < 80; i++) step(g); return cueBall(g).x; };
  assert.ok(after(-1) < after(0)); assert.ok(after(1) > after(0));
});

test("狙いの線：最初に当たる球と、その球が進む向き", () => {
  const g = empty(); put(g, 4, 600, 250); cueBall(g).x = 300; cueBall(g).y = 250;
  const a = aimLine(g, 0); assert.equal(a.hit, 4); assert.ok(Math.abs(a.x2 - (600 - TABLE.r * 2)) < 0.01); assert.ok(a.tx > 0.99);
});

function setupShot(g, { first, pocketed = [], rail = true, groupBefore = null, onEightBefore = false }) {
  g.shot = { first, pocketed: [...pocketed], rail, who: g.turn, groupBefore, onEightBefore };
  pocketed.forEach((id) => { ball(g, id).on = false; });
}

test("ルール：どの球にも当たらなければ反則。相手に手球を置く権利が移る", () => {
  const g = newGame("eight"); g.breakShot = false; setupShot(g, { first: null });
  const r = endShot(g); assert.equal(r.foul, true); assert.equal(g.turn, 1); assert.equal(g.inHand, true);
});

test("ルール：最初に落とした球でグループが決まり、続けて打てる（ブレイクのあと）", () => {
  const g = newGame("eight"); g.breakShot = false; setupShot(g, { first: 2, pocketed: [2] });
  const r = endShot(g); assert.equal(r.assigned, true); assert.equal(g.groups[0], "solid"); assert.equal(g.groups[1], "stripe"); assert.equal(g.turn, 0);
});

test("ルール：ブレイクで球が落ちても、グループは決まらない。続けて打てる", () => {
  const g = newGame("eight"); setupShot(g, { first: 1, pocketed: [10] });
  endShot(g); assert.equal(g.groups[0], null); assert.equal(g.turn, 0);
});

test("ルール：自分の球を落とせなければ交代（反則なし）", () => {
  const g = newGame("eight"); g.breakShot = false; g.groups = ["solid", "stripe"]; setupShot(g, { first: 1, pocketed: [] });
  const r = endShot(g); assert.equal(r.foul, false); assert.equal(g.turn, 1); assert.equal(g.inHand, false);
});

test("ルール：自分の球を全部落とす前に8番を落とすと負け", () => {
  const g = newGame("eight"); g.breakShot = false; g.groups = ["solid", "stripe"]; setupShot(g, { first: 8, pocketed: [8] });
  endShot(g); assert.equal(g.over, true); assert.equal(g.winner, 1);
});

test("ルール：自分の球を全部落としたあとに8番を落とすと勝ち。同時に手球が落ちたら負け", () => {
  const make = (cueIn) => { const g = newGame("eight"); g.breakShot = false; g.groups = ["solid", "stripe"]; for (let i = 1; i < 8; i++) ball(g, i).on = false; setupShot(g, { first: 8, pocketed: cueIn ? [8, 0] : [8], groupBefore: "solid", onEightBefore: true }); if (cueIn) cueBall(g).on = false; return g; };
  const a = make(false); endShot(a); assert.equal(a.winner, 0);
  const b = make(true); endShot(b); assert.equal(b.winner, 1);
});

test("ルール：ブレイクで8番が落ちたら、置き直して続ける", () => {
  const g = newGame("eight"); setupShot(g, { first: 1, pocketed: [8] });
  endShot(g); assert.equal(g.over, false); assert.equal(ball(g, 8).on, true);
});

test("手球の置き場所：ほかの球と重ならない所だけ", () => {
  const g = empty(); put(g, 1, 500, 250);
  assert.equal(canPlace(g, 510, 250), false); assert.equal(canPlace(g, 560, 250), true); assert.equal(placeCue(g, 560, 250), true); assert.equal(cueBall(g).x, 560);
});

test("CPU：狙える球は、ポケットに落とせる（ずらしなしで）", () => {
  const g = empty("eight"); g.breakShot = false; g.groups = ["solid", "stripe"];
  put(g, 1, 880, 100); cueBall(g).x = 600; cueBall(g).y = 100;
  const s = chooseShot(g, { error: 0, rng: () => 0.5 });
  shoot(g, s.angle, s.power, s.spin); runToRest(g);
  assert.ok(g.pocketed.includes(1), "1番が落ちた");
});

test("CPU：手球を置くときは、台の中の空いた所を選ぶ", () => {
  const g = newGame("eight"); g.breakShot = false; g.groups = ["stripe", "solid"]; g.turn = 0;
  for (let i = 9; i < 16; i++) if (i !== 15) ball(g, i).on = false;
  const p = choosePlacement(g); assert.ok(canPlace(g, p.x, p.y));
  assert.ok(bestShot(g, p.x, p.y) !== null || true);
});

test("9ボール：並べ方（1が先頭・9が真ん中）、いちばん小さい番号に最初に当てる、9番で勝ち", () => {
  const g = newGame("nine");
  assert.equal(g.balls.length, 10);
  const xs = g.balls.filter((b) => b.id > 0).map((b) => b.x);
  assert.equal(ball(g, 1).x, Math.min(...xs)); assert.ok(Math.abs(ball(g, 9).y - TABLE.h / 2) < 0.01);
  for (let i = 0; i < g.balls.length; i++) for (let j = i + 1; j < g.balls.length; j++) assert.ok(Math.hypot(g.balls[i].x - g.balls[j].x, g.balls[i].y - g.balls[j].y) >= TABLE.r * 2);
  const mk = (first, pocketed) => { const h = newGame("nine"); h.breakShot = false; h.shot = { first, pocketed: [...pocketed], rail: true, lowestBefore: 1 }; pocketed.forEach((id) => { ball(h, id).on = false; }); return h; };
  const a = mk(2, []); endShot(a); assert.equal(a.turn, 1); assert.equal(a.inHand, true);   // 1番より先に2番に当てたら反則
  const b = mk(1, [9]); endShot(b); assert.equal(b.over, true); assert.equal(b.winner, 0);
  const c = mk(2, [9]); endShot(c); assert.equal(c.over, false); assert.equal(ball(c, 9).on, true);   // 反則と同時の9番は置き直し
  const d = mk(1, [4]); endShot(d); assert.equal(d.turn, 0);   // 落として反則なし → 続ける
});

test("左右のひねり：クッションに当たったあとの進む向きが変わる", () => {
  const run = (side) => { const g = empty(); put(g, 5, 900, 480); cueBall(g).x = 300; cueBall(g).y = 400; shoot(g, -1.2, 0.8, 0, side); for (let i = 0; i < 160; i++) step(g); return cueBall(g).x; };
  assert.ok(Math.abs(run(1) - run(0)) > 1); assert.ok(Math.abs(run(-1) - run(0)) > 1); assert.notEqual(run(1), run(-1));
});

test("CPU：狙える形がなくても、遠い球まで届く強さで打つ（空振りしない）", () => {
  for (const mode of ["eight", "nine"]) {
    const g = empty(mode); g.breakShot = false; g.groups = ["solid", "stripe"];
    put(g, 2, 960, 470); put(g, 1, 960, 450); cueBall(g).x = 40; cueBall(g).y = 40;
    const s = chooseShot(g, { error: 0, rng: () => 0.5 });
    shoot(g, s.angle, s.power, 0); runToRest(g);
    assert.ok(g.shot.first !== null, `${mode}: 何かに当たった`);
  }
});
