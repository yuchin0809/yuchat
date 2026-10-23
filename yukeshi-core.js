/* 消しバト：消しゴムの強さの計算（画面の表示用）。サーバー（notify-worker/worker.js の keshiStats）と同じ計算。
   ・実際の強さ（総合力）を決めるのはサーバー。ここは、パーツを選んだときの「付けたらこうなる」を、通信せずに見せるためだけに使う。
   ・同じ計算であることは、notify-worker/test/keshi.test.mjs が全部の組み合わせで確かめる。 */
const soft = (d) => (d >= 0 ? 60 * Math.tanh(d / 60) : d);
export function keshiStatsView(table, eq) {
  const d = { m: 0, s: 0, b: 0, z: 0 };
  table.slots.forEach((slot) => {
    const list = table.parts[slot];
    const p = list.find((x) => x.id === eq[slot]) || list[0];
    d.m += p.m; d.s += p.s; d.b += p.b; d.z += p.z;
  });
  const base = table.base;
  const st = { m: Math.round(base + soft(d.m)), s: Math.round(base + soft(d.s)), b: Math.round(base + soft(d.b)), z: Math.round(base + soft(d.z)) };
  st.rating = Math.round(0.35 * st.m + 0.25 * st.s + 0.30 * st.b + 0.10 * st.z);
  return st;
}

/* 最強決定戦（リーグ戦）の開催の状態（日付だけで決まる。通信しない）。毎週：月曜 0:00 JST 〜 金曜 15:10 JST が開催期間。第1回は firstMs（月曜 0:00 JST）から。
   戻り値：{ phase: "before"（まだ第1回の前）| "live"（開催中）| "between"（金曜15:10〜日曜：次は来週の月曜）, startMs（今回／次回の月曜 0:00）, endMs（金曜 15:10）, no（第何回）, days（開始まで／終わりまでの日数） } */
/* 第1回の始まり（月曜 0:00 JST）。サーバー（worker.js の KESHI_LEAGUE_FIRST_MS）と同じ。ゆうワールドのお店の札など、サーバーから受け取る前に使う */
export const KESHI_LEAGUE_FIRST_MS = Date.UTC(2026, 9, 25, 15, 0);
const mdOf = (ms) => { const d = new Date(ms + 9 * 3600000); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`; };
/* お店の札・バナーに出す短い文（開催の状態から） */
export function keshiLeagueTag(nowMs) {
  const p = keshiLeaguePhase(nowMs, KESHI_LEAGUE_FIRST_MS);
  return p.phase === "live" ? `第${p.no}回 開催中！` : p.phase === "before" ? `第1回 ${mdOf(p.startMs)}（月）スタート！` : `次回 ${mdOf(p.startMs)}（月）スタート`;
}
export function keshiLeaguePhase(nowMs, firstMs) {
  const DAY = 86400000, J = 9 * 3600000;
  const day = Math.floor((nowMs + J) / DAY), dow = new Date(day * DAY).getUTCDay();
  let mon = (day - ((dow + 6) % 7)) * DAY - J;
  if (mon < firstMs) mon = firstMs;
  const end = mon + 4 * DAY + 15 * 3600000 + 10 * 60000;
  if (nowMs < mon) return { phase: "before", startMs: mon, endMs: end, no: 1, days: Math.ceil((mon - nowMs) / DAY) };
  if (nowMs < end) return { phase: "live", startMs: mon, endMs: end, no: Math.round((mon - firstMs) / (7 * DAY)) + 1, days: Math.max(0, Math.ceil((end - nowMs) / DAY)) };
  const next = mon + 7 * DAY;
  return { phase: "between", startMs: next, endMs: next + 4 * DAY + 15 * 3600000 + 10 * 60000, no: Math.round((next - firstMs) / (7 * DAY)) + 1, days: Math.ceil((next - nowMs) / DAY) };
}

/* 消しゴムの絵（絵文字には消しゴムがないので、自分で描く）。cls：大きさなどを決める class */
export const eraserIcon = (cls = "ker-svg") => `<svg class="${cls}" viewBox="0 0 100 70" aria-hidden="true"><g transform="rotate(-16 50 35)"><rect x="6" y="20" width="88" height="34" rx="8" fill="#f7f4ed" stroke="#c9c2ae" stroke-width="2"/><rect x="10" y="22" width="80" height="8" rx="4" fill="#fff" opacity=".7"/><rect x="31" y="14" width="42" height="46" rx="3" fill="#2f6fe0"/><rect x="31" y="14" width="42" height="6" fill="#fff"/><rect x="31" y="54" width="42" height="6" fill="#fff"/><text x="52" y="42" text-anchor="middle" font-size="12" font-weight="900" fill="#fff" font-family="sans-serif">消しゴム</text></g></svg>`;

/* =========================================================
   2人対戦の「弾いたあとの動き」の計算（画面の再生用）。サーバー（notify-worker/worker.js の keshiSim）と同じ計算。
   ・勝ち負け・最後の位置を決めるのはサーバー。ここは、サーバーが決めた動きを、画面で1コマずつ再生するためだけに使う。
   ・足し算・かけ算・割り算・平方根だけで作ってあるので、どの端末でも同じ答えになる。同じ答えになることは、notify-worker/test/keshi-room.test.mjs が確かめる。
========================================================= */
export const KESHI_DESK = { hw: 4.4, hd: 7.4, startZ: 3.0, startX: 1.2 };
export const KESHI_DT = 1 / 120;
const KESHI_MAX_STEPS = 1200;
/* 1コマずつ進める。pos：[[x,z],[x,z]]、who：弾いた人、(vx,vz)：弾いた速さ。
   step() が false を返したら終わり。x,z,out,first は、進めるたびに更新される（out：机から落ちた人、first：最初に落ちた人。落ちていなければ -1） */
export function keshiSimStepper(P, pos, who, vx, vz) {
  const s = { x: [pos[0][0], pos[1][0]], z: [pos[0][1], pos[1][1]], vx: [0, 0], vz: [0, 0], out: [false, false], first: -1, steps: 0 };
  s.vx[who] = vx; s.vz[who] = vz;
  s.step = () => {
    if (s.steps >= KESHI_MAX_STEPS) return false;
    const { x, z, vx: vX, vz: vZ, out } = s;
    let moving = false;
    for (let i = 0; i < 2; i++) {
      if (out[i]) continue;
      const sp = Math.sqrt(vX[i] * vX[i] + vZ[i] * vZ[i]);
      if (sp > 0) { const ns = sp - P[i].a * KESHI_DT; if (ns <= 0.02) { vX[i] = 0; vZ[i] = 0; } else { vX[i] *= ns / sp; vZ[i] *= ns / sp; moving = true; } }
      x[i] += vX[i] * KESHI_DT; z[i] += vZ[i] * KESHI_DT;
    }
    if (!out[0] && !out[1]) {
      const dx = x[1] - x[0], dz = z[1] - z[0], rr = P[0].r + P[1].r, d2 = dx * dx + dz * dz;
      if (d2 < rr * rr) {
        const d = Math.sqrt(d2), nx = d > 1e-9 ? dx / d : 0, nz = d > 1e-9 ? dz / d : 1;
        const vn = (vX[1] - vX[0]) * nx + (vZ[1] - vZ[0]) * nz, ia = 1 / P[0].m, ib = 1 / P[1].m;
        if (vn < 0) { const e = vX[0] * vX[0] + vZ[0] * vZ[0] >= vX[1] * vX[1] + vZ[1] * vZ[1] ? P[0].e : P[1].e, j = -(1 + e) * vn / (ia + ib);   /* 反発は、勢いのあるほう（当てたほう）の消しゴムの数字 */ vX[0] -= j * ia * nx; vZ[0] -= j * ia * nz; vX[1] += j * ib * nx; vZ[1] += j * ib * nz; moving = true; }
        const k = (rr - d) / (ia + ib); x[0] -= k * ia * nx; z[0] -= k * ia * nz; x[1] += k * ib * nx; z[1] += k * ib * nz;
      }
    }
    const fell = [0, 1].filter((i) => !out[i] && (Math.abs(x[i]) > KESHI_DESK.hw || Math.abs(z[i]) > KESHI_DESK.hd));
    fell.forEach((i) => { out[i] = true; });
    if (fell.length && s.first < 0) s.first = fell.length === 2 ? who : fell[0];
    s.steps++;
    return moving;
  };
  return s;
}

/* 試し打ち（ひとりで机の上で弾いてみる画面）で使う、動きの計算用の数字。サーバーの keshiPhys / keshiLaunchSpeed と同じ計算 */
const r4 = (x) => Math.round(x * 10000) / 10000;
export function keshiPhysView(st) {
  const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
  const w = Math.max(st.m, 50) / 50, sl = clamp((Math.max(st.s, 50) - 50) / 60, 0, 1), bo = Math.max(st.b, 50);
  return { m: r4(w * w), a: 9, e: r4(clamp(0.45 + (bo - 50) / 60, 0.3, 0.85)), r: r4(0.7 * (1 + (st.z - 50) / 300)), k: r4(1 + 0.2 * sl) };
}
export const keshiLaunchSpeedView = (P, power) => 12.5 * power * (P.k || 1);

/* 買ったパーツで「どれくらい強くなったか」を、数字で見せる（ショップ用）。
   ・攻撃力：初期装備の消しゴムに、同じ強さでまっすぐ当てたとき、どれだけふっとばせるか（初期装備の消しゴムが当てたときを ×1.0 とする）
   ・守り：初期装備の消しゴムに当てられたとき、どれだけ動かされにくいか（初期装備の消しゴムが当てられたときを ×1.0 とする。大きいほど動かされない）
   実際の2人対戦と同じ動きの計算（keshiSimStepper）で測るので、試合・試し打ちの手ごたえと同じになる。 */
const PUNCH_DEFAULT = { body: "plain", edge: "paper", sole: "bare", weight: "none" };
function punchMove(Pa, Pb) {   // aがbに、まっすぐ当てる。bがどれだけ動くか
  const s = keshiSimStepper([Pa, Pb], [[0, 3], [0, 0]], 0, 0, -keshiLaunchSpeedView(Pa, 0.8));
  while (s.step()) { /* 止まるまで */ }
  return Math.hypot(s.x[1], s.z[1]);
}
export function keshiPunchView(table, eq) {
  const P0 = keshiPhysView(keshiStatsView(table, PUNCH_DEFAULT)), P = keshiPhysView(keshiStatsView(table, eq));
  const atk0 = punchMove(P0, P0), atk = punchMove(P, P0), def0 = punchMove(P0, P0), def = punchMove(P0, P);
  const round = (x) => Math.round(Math.min(9.9, x) * 10) / 10;
  return { atk: round(atk / Math.max(0.05, atk0)), def: round(def0 / Math.max(0.05, def)) };
}
