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

/* 消しゴムの絵（絵文字には消しゴムがないので、自分で描く）。cls：大きさなどを決める class */
export const eraserIcon = (cls = "ker-svg") => `<svg class="${cls}" viewBox="0 0 100 70" aria-hidden="true"><g transform="rotate(-16 50 35)"><rect x="6" y="20" width="88" height="34" rx="8" fill="#f7f4ed" stroke="#c9c2ae" stroke-width="2"/><rect x="10" y="22" width="80" height="8" rx="4" fill="#fff" opacity=".7"/><rect x="31" y="14" width="42" height="46" rx="3" fill="#2f6fe0"/><rect x="31" y="14" width="42" height="6" fill="#fff"/><rect x="31" y="54" width="42" height="6" fill="#fff"/><text x="52" y="42" text-anchor="middle" font-size="12" font-weight="900" fill="#fff" font-family="sans-serif">消しゴム</text></g></svg>`;

/* =========================================================
   2人対戦の「弾いたあとの動き」の計算（画面の再生用）。サーバー（notify-worker/worker.js の keshiSim）と同じ計算。
   ・勝ち負け・最後の位置を決めるのはサーバー。ここは、サーバーが決めた動きを、画面で1コマずつ再生するためだけに使う。
   ・足し算・かけ算・割り算・平方根だけで作ってあるので、どの端末でも同じ答えになる。同じ答えになることは、notify-worker/test/keshi-room.test.mjs が確かめる。
========================================================= */
export const KESHI_DESK = { hw: 3.6, hd: 5.6, startZ: 2.6, startX: 1.1 };
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
        if (vn < 0) { const e = (P[0].e + P[1].e) / 2, j = -(1 + e) * vn / (ia + ib); vX[0] -= j * ia * nx; vZ[0] -= j * ia * nz; vX[1] += j * ib * nx; vZ[1] += j * ib * nz; moving = true; }
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
  return { m: r4(st.m / 50), a: r4(8 * (1 - 0.55 * clamp((st.s - 50) / 60, -0.3, 1))), e: r4(clamp(0.5 + (st.b - 50) / 120, 0.3, 0.95)), r: r4(0.78 * (1 + (st.z - 50) / 300)) };
}
export const keshiLaunchSpeedView = (P, power) => 12.5 * power / Math.sqrt(Math.sqrt(P.m));
