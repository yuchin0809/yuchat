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
