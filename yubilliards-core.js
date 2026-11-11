/* 🎱 ゆうワールド「ビリヤード」の、球の動きと8ボールのルール（決まった計算だけ。画面にも通信にも触れない。テストしやすいように別ファイル）
   ・コインは使わない。結果もコインに関わらない
   ・同じ入力（球の位置・打つ向き・強さ・押し引き）からは、いつでも同じ動きになる（乱数を使わない・決まった時間の刻みで進める）
   ・ルーム対戦を足すときは、この計算を、2人の画面とサーバーで同じように使う（消しバトと同じ考え方）
   ・台の大きさは 1000 × 500（本物の9フィート台と同じ 2:1。球の半径 12 は、台の幅の約21個ぶん）。ポケットは6つ */

export const TABLE = { w: 1000, h: 500, r: 12, pocketR: 26 };
export const POCKETS = [[0, 0], [TABLE.w / 2, -4], [TABLE.w, 0], [0, TABLE.h], [TABLE.w / 2, TABLE.h + 4], [TABLE.w, TABLE.h]];
export const POCKET_R = [26, 24, 26, 26, 24, 26];   // 四隅は少し大きく、真ん中は小さめ
export const PHYS = {
  roll: 0.9985,          // 1刻みごとに、速さがこの割合に減る（ころがり）
  decel: 0.02,           // 1刻みごとに、速さがこれだけ減る（ラシャとの摩擦。ゆっくりになるほど効く）
  stop: 0.06,            // これより遅い球は、止まる
  wall: 0.74,            // クッションに当たったときの、はね返りの強さ
  ball: 0.96,            // 球どうしのはね返りの強さ
  maxSpeed: 10,          // 1刻み（1/60秒）で進む距離の最大（球の直径 24 より小さいので、すり抜けない）
  spinGain: 0.5,         // 押し・引きの効きの強さ
  sideGain: 0.3,         // 左右のひねりが、クッションで曲がる強さ
  sideDecay: 0.998,      // ひねりが、ゆっくり弱まる割合（1刻みごと）
  fastPocket: 7.5        // これより速い球は、ポケットの口の真ん中近くでないと入らない
};
export const HEAD_SPOT = { x: 250, y: TABLE.h / 2 };   // 白い球（手球）を置く場所
export const FOOT_SPOT = { x: 740, y: TABLE.h / 2 };   // 15個の球を三角に並べる先頭の場所

/* 球の番号：0＝白い球（手球）、1〜7＝ソリッド（色1色）、8＝黒、9〜15＝ストライプ（しま） */
export const BALL_COLORS = ["#fafafa", "#f5c400", "#2f6bff", "#e5484d", "#8b3fd9", "#ff7a00", "#1f9d63", "#8a2b2b", "#15181f", "#f5c400", "#2f6bff", "#e5484d", "#8b3fd9", "#ff7a00", "#1f9d63", "#8a2b2b"];
export const groupOf = (id) => (id === 8 ? "eight" : id < 8 ? "solid" : "stripe");

/* 三角の並べ方（先頭から列ごと）：8番は真ん中、後ろの2つの角はソリッドとストライプ */
const RACK = [1, 10, 2, 3, 8, 11, 12, 4, 13, 5, 9, 6, 14, 15, 7];
const RACK_D = TABLE.r * 2 + 0.6;
function rackPos(col, row) { return { x: FOOT_SPOT.x + col * RACK_D * 0.866, y: FOOT_SPOT.y + (row - col / 2) * RACK_D }; }

/* ナインボールの並べ方：ダイヤの形（1-2-3-2-1列）。先頭が1番、真ん中が9番 */
const RACK9 = [[1], [2, 3], [4, 9, 5], [6, 7], [8]];
function rackPos9(col, n, row) { return { x: FOOT_SPOT.x + col * RACK_D * 0.866, y: FOOT_SPOT.y + (row - (n - 1) / 2) * RACK_D }; }

/* 新しいゲーム。mode："eight"（8ボール）／"nine"（9ボール）／"practice"（1人で、全部落とす練習） */
export function newGame(mode = "practice") {
  const balls = [{ id: 0, x: HEAD_SPOT.x, y: HEAD_SPOT.y, vx: 0, vy: 0, w: 0, on: true }];
  if (mode === "nine") RACK9.forEach((ids, col) => ids.forEach((id, row) => { const p = rackPos9(col, ids.length, row); balls.push({ id, x: p.x, y: p.y, vx: 0, vy: 0, w: 0, on: true }); }));
  else { let i = 0; for (let col = 0; col < 5; col++) for (let row = 0; row <= col; row++) { const p = rackPos(col, row); balls.push({ id: RACK[i++], x: p.x, y: p.y, vx: 0, vy: 0, w: 0, on: true }); } }
  balls.sort((a, b) => a.id - b.id);
  return { mode, balls, shots: 0, fouls: 0, pocketed: [], events: [], shot: null, cueSpin: 0, spinUsed: false,
    turn: 0, groups: [null, null], inHand: false, breakShot: true, over: false, winner: null };
}

export const cueBall = (game) => game.balls[0];
export const isRest = (game) => game.balls.every((b) => !b.on || (b.vx === 0 && b.vy === 0));
export const remaining = (game) => game.balls.filter((b) => b.id > 0 && b.on).length;
export const isCleared = (game) => remaining(game) === 0;
export const lowestBall = (game) => game.balls.filter((b) => b.on && b.id > 0).sort((a, b) => a.id - b.id)[0] || null;
export const groupLeft = (game, group) => game.balls.filter((b) => b.on && b.id > 0 && groupOf(b.id) === group).length;

/* ルーム対戦で、Firestore に保存する形（Firestore は配列の中に配列を入れられないので、平らな数字の列。落ちた球は -1）。b＝球0〜の x,y を順に／g＝グループ／t＝番／h＝手球を置く権利／k＝最初のショット */
const r3 = (n) => Math.round(n * 1000) / 1000;
export function snapshot(game) {
  const b = [];
  for (const ball of game.balls) { if (ball.on) b.push(r3(ball.x), r3(ball.y)); else b.push(-1, -1); }
  return { b, g: [game.groups[0] || "", game.groups[1] || ""], t: game.turn, h: game.inHand ? 1 : 0, k: game.breakShot ? 1 : 0 };
}
export function restore(mode, st) {
  const game = newGame(mode);
  game.balls.forEach((ball, i) => {
    const x = Number(st.b[i * 2]), y = Number(st.b[i * 2 + 1]);
    ball.vx = 0; ball.vy = 0; ball.w = 0;
    if (x < 0 || y < 0) { ball.on = false; game.pocketed.push(ball.id); } else { ball.on = true; ball.x = x; ball.y = y; }
  });
  game.groups = [st.g?.[0] || null, st.g?.[1] || null];
  game.turn = st.t === 1 ? 1 : 0; game.inHand = st.h === 1; game.breakShot = st.k === 1;
  return game;
}

/* 打つ：向き（ラジアン）・強さ（0〜1）・押し引き（−1〜1。＋＝押し（当たったあとも進む）、−＝引き（当たったあと戻る））。止まっているときだけ */
export function shoot(game, angle, power, spin = 0, side = 0) {
  if (game.over || game.inHand || !isRest(game) || !cueBall(game).on) return false;
  const p = Math.max(0.03, Math.min(1, Number(power) || 0));
  const cue = cueBall(game);
  cue.vx = Math.cos(angle) * PHYS.maxSpeed * p;
  cue.vy = Math.sin(angle) * PHYS.maxSpeed * p;
  game.cueSpin = Math.max(-1, Math.min(1, Number(spin) || 0));
  cue.w = -Math.max(-1, Math.min(1, Number(side) || 0));   // 右ひねり＝反時計まわり（画面で見て）
  game.spinUsed = false;
  game.shots += 1;
  const g = game.groups[game.turn];
  game.shot = { first: null, pocketed: [], rail: false, who: game.turn, groupBefore: g, onEightBefore: !!g && groupLeft(game, g) === 0, lowestBefore: lowestBall(game)?.id ?? null };
  return true;
}

function note(game, e) { if (game.events.length < 200) game.events.push(e); }

/* 1刻み進める。戻り値：この刻みでポケットに落ちた球の番号の一覧 */
export function step(game) {
  const { w, h, r } = TABLE;
  const dropped = [];
  const shot = game.shot;
  for (const b of game.balls) {
    if (!b.on) continue;
    b.x += b.vx; b.y += b.vy;
    const sp = Math.hypot(b.vx, b.vy);
    if (sp > 0) {
      const ns = sp * PHYS.roll - PHYS.decel;
      if (ns < PHYS.stop) { b.vx = 0; b.vy = 0; } else { const k = ns / sp; b.vx *= k; b.vy *= k; }
    }
    // ポケット
    for (let i = 0; i < POCKETS.length; i++) {
      const dx = b.x - POCKETS[i][0], dy = b.y - POCKETS[i][1];
      const pr = POCKET_R[i] * (sp > PHYS.fastPocket ? 0.82 : 1);   // 速すぎる球は、縁にはじかれて入りにくい
      if (dx * dx + dy * dy < pr * pr) { b.on = false; b.vx = 0; b.vy = 0; dropped.push(b.id); break; }
    }
    if (!b.on) continue;
    // クッション
    let hit = 0;
    if (b.x < r) { hit = Math.abs(b.vx); b.x = r; b.vx = Math.abs(b.vx) * PHYS.wall; }
    else if (b.x > w - r) { hit = Math.abs(b.vx); b.x = w - r; b.vx = -Math.abs(b.vx) * PHYS.wall; }
    if (b.y < r) { hit = Math.max(hit, Math.abs(b.vy)); b.y = r; b.vy = Math.abs(b.vy) * PHYS.wall; }
    else if (b.y > h - r) { hit = Math.max(hit, Math.abs(b.vy)); b.y = h - r; b.vy = -Math.abs(b.vy) * PHYS.wall; }
    if (b.w) {
      if (hit > 0.05) { const nx = b.x <= r + 0.01 ? -1 : b.x >= w - r - 0.01 ? 1 : 0, ny = b.y <= r + 0.01 ? -1 : b.y >= h - r - 0.01 ? 1 : 0; b.vx += b.w * hit * PHYS.sideGain * ny; b.vy -= b.w * hit * PHYS.sideGain * nx; b.w *= 0.55; }
      else b.w *= PHYS.sideDecay;
    }
    if (hit > 0.05) { note(game, { k: "rail", v: hit }); if (shot && shot.first !== null) shot.rail = true; }
  }
  // 球どうし
  const bs = game.balls;
  for (let i = 0; i < bs.length; i++) {
    const a = bs[i];
    if (!a.on) continue;
    for (let j = i + 1; j < bs.length; j++) {
      const c = bs[j];
      if (!c.on) continue;
      let dx = c.x - a.x, dy = c.y - a.y;
      const dist2 = dx * dx + dy * dy;
      const min = r * 2;
      if (dist2 >= min * min) continue;
      // めりこんだ分だけ時間をもどして、ちょうど触れた瞬間の向きで、はね返りを計算する（刻みが粗くても、狙いどおりに飛ぶ）
      const rvx = c.vx - a.vx, rvy = c.vy - a.vy, v2 = rvx * rvx + rvy * rvy, dv = dx * rvx + dy * rvy;
      let tau = 0;
      if (v2 > 1e-9 && dv < 0) { const disc = dv * dv - v2 * (dist2 - min * min); if (disc >= 0) tau = Math.max(0, Math.min(1, (dv + Math.sqrt(disc)) / v2)); }
      if (tau > 0) { a.x -= a.vx * tau; a.y -= a.vy * tau; c.x -= c.vx * tau; c.y -= c.vy * tau; dx = c.x - a.x; dy = c.y - a.y; }
      const dist = Math.sqrt(dx * dx + dy * dy) || 0.0001;
      const nx = dx / dist, ny = dy / dist;
      const rel = (a.vx - c.vx) * nx + (a.vy - c.vy) * ny;   // 近づく速さ（正＝近づいている）
      if (rel <= 0) { if (tau > 0) { a.x += a.vx * tau; a.y += a.vy * tau; c.x += c.vx * tau; c.y += c.vy * tau; } if (dist < min) { const push = (min - dist) / 2; a.x -= nx * push; a.y -= ny * push; c.x += nx * push; c.y += ny * push; } continue; }
      const preVx = a.vx, preVy = a.vy;
      const imp = (1 + PHYS.ball) / 2 * rel;
      a.vx -= imp * nx; a.vy -= imp * ny; c.vx += imp * nx; c.vy += imp * ny;
      if (tau > 0) { a.x += a.vx * tau; a.y += a.vy * tau; c.x += c.vx * tau; c.y += c.vy * tau; }
      note(game, { k: "ball", v: rel });
      if (a.id === 0 && shot && shot.first === null) shot.first = c.id;
      if (a.id === 0 && !game.spinUsed) {   // 手球が最初に当たったとき、押し引きが効く
        game.spinUsed = true;
        const pre = Math.hypot(preVx, preVy);
        if (game.cueSpin && pre > 0) { const k = game.cueSpin * PHYS.spinGain; a.vx += preVx / pre * pre * k; a.vy += preVy / pre * pre * k; }
      }
    }
  }
  for (const id of dropped) { game.pocketed.push(id); if (shot) shot.pocketed.push(id); note(game, { k: "pocket", id }); }
  return dropped;
}

/* 止まるまで（または上限まで）進める。テスト・ルーム対戦のサーバー側の確認用。戻り値：刻みの数 */
export function runToRest(game, maxTicks = 6000) {
  let n = 0;
  while (!isRest(game) && n < maxTicks) { step(game); n++; }
  return n;
}

/* 球を置ける場所か（台の中で、ほかの球と重ならない） */
export function canPlace(game, x, y, ignoreId = 0) {
  const r = TABLE.r;
  if (x < r || x > TABLE.w - r || y < r || y > TABLE.h - r) return false;
  return game.balls.every((b) => !b.on || b.id === ignoreId || Math.hypot(b.x - x, b.y - y) >= r * 2 + 1);
}
export function placeCue(game, x, y) {
  if (!canPlace(game, x, y)) return false;
  const c = cueBall(game); c.x = x; c.y = y; c.vx = 0; c.vy = 0; c.on = true;
  return true;
}
function freeSpotNear(game, sx, sy, ignoreId) {
  if (canPlace(game, sx, sy, ignoreId)) return { x: sx, y: sy };
  for (let k = 1; k < 60; k++) {
    const x = sx + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * (TABLE.r * 2 + 2);
    if (canPlace(game, x, sy, ignoreId)) return { x, y: sy };
  }
  return { x: sx, y: sy };
}

/* 【1人で練習】止まったあとの決まり：手球がポケットに落ちていたら、反則（+1）で、手球を戻す */
export function settle(game) {
  const cue = cueBall(game);
  if (cue.on) return { scratch: false };
  game.fouls += 1;
  let x = HEAD_SPOT.x, y = HEAD_SPOT.y;
  for (let k = 0; k < 40 && !canPlace(game, x, y); k++) { y = HEAD_SPOT.y + (k % 2 ? 1 : -1) * Math.ceil((k + 1) / 2) * (TABLE.r * 2 + 2); if (y < TABLE.r || y > TABLE.h - TABLE.r) { y = HEAD_SPOT.y; x -= TABLE.r * 2 + 2; } }
  cue.x = x; cue.y = y; cue.vx = 0; cue.vy = 0; cue.on = true;
  return { scratch: true };
}

/* 【8ボール】止まったあとの決まり（本物の主なルール）。
   ・最初のショット（ブレイク）のあとも、グループは決まらない。決まるのは、そのあとで最初に落とした球から（ソリッド／ストライプ）
   ・自分のグループの球を落として、反則がなければ、続けて打てる。そうでなければ交代
   ・反則（手球が落ちた／どの球にも当たらない／最初に当てた球が違う／何も落ちず、クッションにも当たらない）は、相手が手球を好きな場所に置ける
   ・自分の球を全部落としたあとに、8番を落とせば勝ち。それより前に8番を落とす、または8番と同時に反則をすると負け（ブレイクで8番が落ちたときは、置き直し） */
export function endShot(game) {
  if (game.mode === "nine") return endShotNine(game);
  const s = game.shot;
  const me = game.turn, opp = 1 - me;
  const cue = cueBall(game);
  const pocketed = s.pocketed.filter((id) => id !== 0);
  const scratch = !cue.on;
  const wasBreak = game.breakShot;
  let foul = false, reason = "";
  if (scratch) { foul = true; reason = "手球がポケットに落ちた"; }
  else if (s.first === null) { foul = true; reason = "どの球にも当たらなかった"; }
  else if (s.groupBefore) {
    const need = s.onEightBefore ? "eight" : s.groupBefore;
    if (groupOf(s.first) !== need) { foul = true; reason = s.onEightBefore ? "最初に8番に当てなかった" : "最初に自分の球に当てなかった"; }
  } else if (s.first === 8 && !wasBreak) { foul = true; reason = "グループが決まる前に8番に当てた"; }
  if (!foul && pocketed.length === 0 && !s.rail) { foul = true; reason = "どの球もクッションに当たらなかった"; }

  let assigned = false, winner = null;
  const eightIn = pocketed.includes(8);
  if (eightIn) {
    if (wasBreak) {   // ブレイクで8番が落ちたら、置き直し
      const p = rackPos(2, 1);
      const spot = freeSpotNear(game, p.x, p.y, 8);
      const e = game.balls.find((b) => b.id === 8); e.on = true; e.x = spot.x; e.y = spot.y; e.vx = 0; e.vy = 0;
      game.pocketed = game.pocketed.filter((id) => id !== 8);
    } else { winner = s.onEightBefore && !foul ? me : opp; }
  }
  if (!winner && !wasBreak && !foul && !game.groups[me]) {
    const first = pocketed.find((id) => id !== 8);
    if (first) { const g = groupOf(first); game.groups[me] = g; game.groups[opp] = g === "solid" ? "stripe" : "solid"; assigned = true; }
  }
  const mine = game.groups[me];
  const keep = !foul && !winner && pocketed.some((id) => id !== 8 && (wasBreak || !mine || groupOf(id) === mine));
  game.breakShot = false;
  game.shot = null;
  if (winner !== null) { game.over = true; game.winner = winner; return { foul, reason, switched: false, winner, assigned }; }
  if (foul) game.fouls += 1;
  if (scratch) { const spot = freeSpotNear(game, HEAD_SPOT.x, HEAD_SPOT.y, 0); cue.x = spot.x; cue.y = spot.y; cue.vx = 0; cue.vy = 0; cue.on = true; }
  const switched = !keep;
  if (switched) game.turn = opp;
  game.inHand = foul;
  return { foul, reason, switched, winner: null, assigned };
}

/* 【9ボール】止まったあとの決まり：
   ・いつも、盤の上でいちばん小さい番号の球に、最初に当てる（当てたあとなら、どの球を落としてもよい）
   ・反則（手球が落ちた／どの球にも当たらない／最初に当てた球が違う／何も落ちず、クッションにも当たらない）は、相手が手球を好きな場所に置ける
   ・9番を、反則なしで落とせば勝ち（ブレイクでも、あいだの球でも同じ）。反則と同時に9番が落ちたら、9番は置き直し
   ・球を落として反則がなければ、続けて打てる。そうでなければ交代 */
function endShotNine(game) {
  const s = game.shot;
  const me = game.turn, opp = 1 - me;
  const cue = cueBall(game);
  const pocketed = s.pocketed.filter((id) => id !== 0);
  const scratch = !cue.on;
  let foul = false, reason = "";
  if (scratch) { foul = true; reason = "手球がポケットに落ちた"; }
  else if (s.first === null) { foul = true; reason = "どの球にも当たらなかった"; }
  else if (s.first !== s.lowestBefore) { foul = true; reason = `最初に${s.lowestBefore}番に当てなかった`; }
  if (!foul && pocketed.length === 0 && !s.rail) { foul = true; reason = "どの球もクッションに当たらなかった"; }
  let winner = null;
  if (pocketed.includes(9)) {
    if (!foul) winner = me;
    else {
      const spot = freeSpotNear(game, FOOT_SPOT.x + 2 * RACK_D * 0.866, FOOT_SPOT.y, 9);
      const e = game.balls.find((b) => b.id === 9); e.on = true; e.x = spot.x; e.y = spot.y; e.vx = 0; e.vy = 0;
      game.pocketed = game.pocketed.filter((id) => id !== 9);
    }
  }
  const keep = !foul && !winner && pocketed.length > 0;
  game.breakShot = false;
  game.shot = null;
  if (winner !== null) { game.over = true; game.winner = winner; return { foul, reason, switched: false, winner, assigned: false }; }
  if (foul) game.fouls += 1;
  if (scratch) { const spot = freeSpotNear(game, HEAD_SPOT.x, HEAD_SPOT.y, 0); cue.x = spot.x; cue.y = spot.y; cue.vx = 0; cue.vy = 0; cue.on = true; }
  const switched = !keep;
  if (switched) game.turn = opp;
  game.inHand = foul;
  return { foul, reason, switched, winner: null, assigned: false };
}

/* 狙いの線：まっすぐ進んだとき、最初に当たる球（またはクッション）までの線と、当たったあとの向き。画面の狙いの表示用（球の動きは使わない・線だけの計算） */
export function aimLine(game, angle) {
  const cue = cueBall(game);
  const dx = Math.cos(angle), dy = Math.sin(angle);
  let best = { t: Infinity, ball: null };
  for (const b of game.balls) {
    if (!b.on || b.id === 0) continue;
    const ox = b.x - cue.x, oy = b.y - cue.y;
    const proj = ox * dx + oy * dy;
    if (proj <= 0) continue;
    const perp2 = ox * ox + oy * oy - proj * proj;
    const rr = (TABLE.r * 2) ** 2;
    if (perp2 >= rr) continue;
    const t = proj - Math.sqrt(rr - perp2);
    if (t < best.t) best = { t, ball: b };
  }
  let wall = Infinity;
  if (dx > 0) wall = Math.min(wall, (TABLE.w - TABLE.r - cue.x) / dx); else if (dx < 0) wall = Math.min(wall, (TABLE.r - cue.x) / dx);
  if (dy > 0) wall = Math.min(wall, (TABLE.h - TABLE.r - cue.y) / dy); else if (dy < 0) wall = Math.min(wall, (TABLE.r - cue.y) / dy);
  const t = Math.min(best.t, wall);
  const out = { x1: cue.x, y1: cue.y, x2: cue.x + dx * t, y2: cue.y + dy * t, hit: null, tx: 0, ty: 0, cx: 0, cy: 0 };
  if (best.t <= wall && best.ball) {
    const b = best.ball;
    out.hit = b.id;
    const nx = b.x - out.x2, ny = b.y - out.y2, nl = Math.hypot(nx, ny) || 1;   // 当てた球が進む向き
    out.tx = nx / nl; out.ty = ny / nl;
    const dot = dx * out.tx + dy * out.ty;                                        // 手球が、横にそれる向き
    const px = dx - dot * out.tx, py = dy - dot * out.ty, pl = Math.hypot(px, py);
    if (pl > 0.02) { out.cx = px / pl; out.cy = py / pl; }
  }
  return out;
}
