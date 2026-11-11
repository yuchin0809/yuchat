/* 🎱 ビリヤードの CPU（相手）。決まった幾何の計算だけで、狙う球・ポケット・強さを選ぶ（画面には触れない）
   ・当てやすい（切り込みが浅い）・近い・間に球がない、組み合わせを選ぶ。少しだけ、わざとずらして人間らしくする
   ・コインは使わない */
import { TABLE, POCKETS, HEAD_SPOT, FOOT_SPOT, cueBall, groupOf, canPlace } from "./yubilliards-core.js?v=20261111-bl6";

const R = TABLE.r;

function distToSeg(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay, l2 = vx * vx + vy * vy;
  const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / l2)) : 0;
  return Math.hypot(px - (ax + vx * t), py - (ay + vy * t));
}

/* いま打てる（狙ってよい）球 */
export function legalTargets(game) {
  const on = game.balls.filter((b) => b.on && b.id > 0);
  if (game.mode === "nine") { const l = game.balls.filter((b) => b.on && b.id > 0).sort((a, b) => a.id - b.id)[0]; return l ? [l] : []; }
  const g = game.groups[game.turn];
  if (!g) return on.filter((b) => b.id !== 8);
  const mine = on.filter((b) => groupOf(b.id) === g);
  return mine.length ? mine : on.filter((b) => b.id === 8);
}

/* 手球が (cx, cy) にあるときの、いちばんよい一発。なければ null */
export function bestShot(game, cx, cy) {
  const others = game.balls.filter((b) => b.on && b.id > 0);
  let best = null;
  for (const t of legalTargets(game)) {
    for (const p of POCKETS) {
      const mx = TABLE.w / 2 - p[0], my = TABLE.h / 2 - p[1], ml = Math.hypot(mx, my) || 1;
      const px = p[0] + mx / ml * 8, py = p[1] + my / ml * 8;   // ポケットの少し内側をねらう
      const dx = px - t.x, dy = py - t.y, dl = Math.hypot(dx, dy);
      if (dl < 1) continue;
      const ux = dx / dl, uy = dy / dl;
      const gx = t.x - ux * R * 2, gy = t.y - uy * R * 2;    // 手球が当たる位置（ゴーストボール）
      if (gx < R || gx > TABLE.w - R || gy < R || gy > TABLE.h - R) continue;
      const cdx = gx - cx, cdy = gy - cy, cl = Math.hypot(cdx, cdy);
      if (cl < 1) continue;
      const cos = (cdx / cl) * ux + (cdy / cl) * uy;           // 1＝まっすぐ。小さいほど、切り込みが深い
      if (cos < 0.25) continue;
      let blocked = false;
      for (const o of others) {
        if (o.id === t.id) continue;
        if (distToSeg(o.x, o.y, cx, cy, gx, gy) < R * 2 - 1 || distToSeg(o.x, o.y, t.x, t.y, px, py) < R * 2 - 1) { blocked = true; break; }
      }
      if (blocked) continue;
      const score = cos * 2 - (cl + dl) / 1400;
      if (!best || score > best.score) best = { score, angle: Math.atan2(cdy, cdx), dist: cl + dl, cl, dl, cos, target: t.id };
    }
  }
  return best;
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const gauss = (rng) => Math.sqrt(-2 * Math.log(Math.max(1e-9, rng()))) * Math.cos(2 * Math.PI * rng());

/* CPUの一発：{ angle, power, spin }。error＝ずらしの大きさ（0でぴったり） */
export function chooseShot(game, { rng = Math.random, error = 1 } = {}) {
  const cue = cueBall(game);
  let angle, power;
  if (game.breakShot) {
    angle = Math.atan2(FOOT_SPOT.y - cue.y, FOOT_SPOT.x - cue.x); power = 0.95;
  } else {
    const b = bestShot(game, cue.x, cue.y);
    if (b) { angle = b.angle; const vHit = Math.sqrt(0.05 * b.dl) / b.cos;   // 当たった瞬間に必要な速さ（切り込みが深いほど、強く）
      power = clamp((Math.sqrt(vHit * vHit + 0.05 * b.cl) * 1.12 + 0.8) / 10, 0.25, 1); }
    else {   // 狙える形がないときは、いちばん近い球に、ふつうの強さで当てる
      const ts = legalTargets(game).sort((a, c) => Math.hypot(a.x - cue.x, a.y - cue.y) - Math.hypot(c.x - cue.x, c.y - cue.y));
      const t = ts[0] || game.balls.find((x) => x.on && x.id > 0);
      const d = Math.hypot(t.x - cue.x, t.y - cue.y);
      angle = Math.atan2(t.y - cue.y, t.x - cue.x); power = clamp((Math.sqrt(0.05 * d) * 1.2 + 1.5) / 10, 0.3, 0.8);   // 届く強さで（弱すぎて届かない、をなくす）
    }
  }
  angle += gauss(rng) * 0.008 * error;
  power = clamp(power * (1 + (rng() - 0.5) * 0.08 * error), 0.2, 1);
  return { angle, power, spin: 0 };
}

/* 手球を好きな場所に置けるとき：いちばんよい一発が打てる場所 */
export function choosePlacement(game) {
  let best = null;
  for (let x = 60; x <= TABLE.w - 60; x += 40) for (let y = 40; y <= TABLE.h - 40; y += 40) {
    if (!canPlace(game, x, y)) continue;
    const b = bestShot(game, x, y);
    if (b && (!best || b.score > best.score)) best = { score: b.score, x, y };
  }
  return best ? { x: best.x, y: best.y } : { x: HEAD_SPOT.x, y: HEAD_SPOT.y };
}
