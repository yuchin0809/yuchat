/* 🎱 ゆうワールド「ビリヤード」の、球の動き（決まった計算だけ。画面にも通信にも触れない。テストしやすいように別ファイル）
   ・コインは使わない。結果もコインに関わらない
   ・同じ入力（球の位置・打つ向き・強さ）からは、いつでも同じ動きになる（乱数を使わない・決まった時間の刻みで進める）
   ・ルーム対戦を足すときは、この計算を、2人の画面とサーバーで同じように使う（消しバトと同じ考え方）
   ・台の大きさは 1000 × 500（単位は自由）。球の半径 12。ポケットは6つ（四隅と、長い辺の真ん中） */

export const TABLE = { w: 1000, h: 500, r: 12, pocketR: 27 };
export const POCKETS = [[0, 0], [TABLE.w / 2, -4], [TABLE.w, 0], [0, TABLE.h], [TABLE.w / 2, TABLE.h + 4], [TABLE.w, TABLE.h]];
export const PHYS = {
  friction: 0.991,       // 1刻みごとに、速さがこの割合に減る
  stop: 0.04,            // これより遅い球は、止まる
  wall: 0.78,            // 壁（クッション）に当たったときの、はね返りの強さ
  ball: 0.96,            // 球どうしのはね返りの強さ
  maxSpeed: 16           // 1刻みで進む距離の最大（球の直径 24 より小さいので、すり抜けない）
};
export const HEAD_SPOT = { x: 250, y: TABLE.h / 2 };   // 白い球（手球）を置く場所
export const FOOT_SPOT = { x: 740, y: TABLE.h / 2 };   // 15個の球を三角に並べる先頭の場所

/* 球の番号：0＝白い球（手球）、1〜15＝的の球 */
export const BALL_COLORS = ["#ffffff", "#f5c400", "#2f6bff", "#e5484d", "#8b3fd9", "#ff8a00", "#1f9d63", "#8a2b2b", "#1d2433", "#f5c400", "#2f6bff", "#e5484d", "#8b3fd9", "#ff8a00", "#1f9d63", "#8a2b2b"];

/* 新しいゲーム：手球と、三角に並べた15個の的の球 */
export function newGame() {
  const balls = [{ id: 0, x: HEAD_SPOT.x, y: HEAD_SPOT.y, vx: 0, vy: 0, on: true }];
  const d = TABLE.r * 2 + 0.6;   // 球どうしのすき間をほんの少しあける
  let id = 1;
  for (let col = 0; col < 5; col++) {
    for (let row = 0; row <= col; row++) {
      balls.push({ id: id++, x: FOOT_SPOT.x + col * d * 0.866, y: FOOT_SPOT.y + (row - col / 2) * d, vx: 0, vy: 0, on: true });
    }
  }
  return { balls, shots: 0, fouls: 0, pocketed: [] };
}

export const cueBall = (game) => game.balls[0];
export const isRest = (game) => game.balls.every((b) => !b.on || (b.vx === 0 && b.vy === 0));
export const remaining = (game) => game.balls.filter((b) => b.id > 0 && b.on).length;
export const isCleared = (game) => remaining(game) === 0;

/* 打つ：向き（ラジアン）と強さ（0〜1）。止まっているときだけ。戻り値：打てたか */
export function shoot(game, angle, power) {
  if (!isRest(game) || !cueBall(game).on) return false;
  const p = Math.max(0.03, Math.min(1, Number(power) || 0));
  const cue = cueBall(game);
  cue.vx = Math.cos(angle) * PHYS.maxSpeed * p;
  cue.vy = Math.sin(angle) * PHYS.maxSpeed * p;
  game.shots += 1;
  return true;
}

/* 1刻み進める。戻り値：この刻みでポケットに落ちた球の番号の一覧 */
export function step(game) {
  const { w, h, r, pocketR } = TABLE;
  const dropped = [];
  for (const b of game.balls) {
    if (!b.on) continue;
    b.x += b.vx; b.y += b.vy;
    b.vx *= PHYS.friction; b.vy *= PHYS.friction;
    if (b.vx * b.vx + b.vy * b.vy < PHYS.stop * PHYS.stop) { b.vx = 0; b.vy = 0; }
    // ポケット
    for (const [px, py] of POCKETS) {
      const dx = b.x - px, dy = b.y - py;
      if (dx * dx + dy * dy < pocketR * pocketR) { b.on = false; b.vx = 0; b.vy = 0; dropped.push(b.id); break; }
    }
    if (!b.on) continue;
    // 壁
    if (b.x < r) { b.x = r; b.vx = Math.abs(b.vx) * PHYS.wall; }
    else if (b.x > w - r) { b.x = w - r; b.vx = -Math.abs(b.vx) * PHYS.wall; }
    if (b.y < r) { b.y = r; b.vy = Math.abs(b.vy) * PHYS.wall; }
    else if (b.y > h - r) { b.y = h - r; b.vy = -Math.abs(b.vy) * PHYS.wall; }
  }
  // 球どうし
  const bs = game.balls;
  for (let i = 0; i < bs.length; i++) {
    const a = bs[i];
    if (!a.on) continue;
    for (let j = i + 1; j < bs.length; j++) {
      const c = bs[j];
      if (!c.on) continue;
      const dx = c.x - a.x, dy = c.y - a.y;
      const dist2 = dx * dx + dy * dy;
      const min = r * 2;
      if (dist2 >= min * min) continue;
      const dist = Math.sqrt(dist2) || 0.0001;
      const nx = dx / dist, ny = dy / dist;
      const push = (min - dist) / 2;
      a.x -= nx * push; a.y -= ny * push; c.x += nx * push; c.y += ny * push;
      const rel = (a.vx - c.vx) * nx + (a.vy - c.vy) * ny;   // 近づく速さ（正＝近づいている）
      if (rel <= 0) continue;
      const imp = (1 + PHYS.ball) / 2 * rel;
      a.vx -= imp * nx; a.vy -= imp * ny; c.vx += imp * nx; c.vy += imp * ny;
    }
  }
  for (const id of dropped) game.pocketed.push(id);
  return dropped;
}

/* 止まるまで（または上限まで）進める。テスト・ルーム対戦のサーバー側の確認用。戻り値：刻みの数 */
export function runToRest(game, maxTicks = 4000) {
  let n = 0;
  while (!isRest(game) && n < maxTicks) { step(game); n++; }
  return n;
}

/* 止まったあとの決まり：手球がポケットに落ちていたら、反則（+1）で、手球を戻す（頭の場所。ほかの球があれば、ずらす） */
export function settle(game) {
  const cue = cueBall(game);
  if (cue.on) return { scratch: false };
  game.fouls += 1;
  const free = (x, y) => game.balls.every((b) => !b.on || Math.hypot(b.x - x, b.y - y) >= TABLE.r * 2 + 1);
  let x = HEAD_SPOT.x, y = HEAD_SPOT.y;
  for (let k = 0; k < 40 && !free(x, y); k++) { y = HEAD_SPOT.y + (k % 2 ? 1 : -1) * Math.ceil((k + 1) / 2) * (TABLE.r * 2 + 2); if (y < TABLE.r || y > TABLE.h - TABLE.r) { y = HEAD_SPOT.y; x -= TABLE.r * 2 + 2; } }
  cue.x = x; cue.y = y; cue.vx = 0; cue.vy = 0; cue.on = true;
  return { scratch: true };
}

/* 狙いの線（まっすぐ進んだとき、最初に当たる球までの線）：画面の狙いの表示用。球の動きは使わない（線だけの計算） */
export function aimLine(game, angle) {
  const cue = cueBall(game);
  const dx = Math.cos(angle), dy = Math.sin(angle);
  let best = { t: Infinity, hit: null };
  for (const b of game.balls) {
    if (!b.on || b.id === 0) continue;
    const ox = b.x - cue.x, oy = b.y - cue.y;
    const proj = ox * dx + oy * dy;
    if (proj <= 0) continue;
    const perp2 = ox * ox + oy * oy - proj * proj;
    const rr = (TABLE.r * 2) ** 2;
    if (perp2 >= rr) continue;
    const t = proj - Math.sqrt(rr - perp2);
    if (t < best.t) best = { t, hit: b.id };
  }
  // 壁までの長さ
  let wall = Infinity;
  if (dx > 0) wall = Math.min(wall, (TABLE.w - TABLE.r - cue.x) / dx); else if (dx < 0) wall = Math.min(wall, (TABLE.r - cue.x) / dx);
  if (dy > 0) wall = Math.min(wall, (TABLE.h - TABLE.r - cue.y) / dy); else if (dy < 0) wall = Math.min(wall, (TABLE.r - cue.y) / dy);
  const t = Math.min(best.t, wall);
  return { x1: cue.x, y1: cue.y, x2: cue.x + dx * t, y2: cue.y + dy * t, hit: best.t <= wall ? best.hit : null };
}
