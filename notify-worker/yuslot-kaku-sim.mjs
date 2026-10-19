/* ゆうスロ「確変台」の倍率を決めるシミュレーション（worker.js の権威ロジックをそのまま使う）。
   台ごとに、倍率 k を変えながら「自動スピンで30分（約900回）遊んだときの収支」を多数回シミュレーションして、
   平均・下位10%・+400コイン以上になる割合を報告する。
   実行：node notify-worker/yuslot-kaku-sim.mjs [セッション数] [スピン間隔ms]
   ・FEVER は、開始待ちになったらすぐ始めたものとして、20秒のあいだ（スピン間隔ごとに）FEVER 扱いで回す。 */
import { SLOT_MACHINES, SLOT_KAKU_RATE, slotApplySpin } from "./worker.js";

const SESSIONS = Number(process.argv[2] || 4000);
const SPIN_MS = Number(process.argv[3] || 2000);
const SPINS = Math.round(30 * 60 * 1000 / SPIN_MS);
function rngOf(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

export function simulate(machine, k, rng, sessions = SESSIONS, spinMs = SPIN_MS, spins = SPINS) {
  const out = [];
  for (let n = 0; n < sessions; n++) {
    let session = { machine, price: SLOT_MACHINES[machine].price, startCoins: 1e9, delta: 0, freeSpins: 0, feverUntil: 0, feverPending: false, spins: 0, wins: 0, streak: 0, kaku: k > 0 };
    let now = 0;
    for (let i = 0; i < spins; i++) {
      const r = slotApplySpin(session, now, rng, k);
      if (r.error) break;
      session = r.session || r.next || session;
      if (session.feverPending) { session = { ...session, feverUntil: now + 20000, feverPending: false }; }
      now += spinMs;
    }
    out.push(session.delta);
  }
  out.sort((a, b) => a - b);
  const mean = out.reduce((s, x) => s + x, 0) / out.length;
  const q = (p) => out[Math.min(out.length - 1, Math.floor(p * out.length))];
  return { mean, p10: q(0.1), p50: q(0.5), p90: q(0.9), ge400: out.filter((x) => x >= 400).length / out.length, ge0: out.filter((x) => x >= 0).length / out.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rng = rngOf(20261020);
  console.log(`30分＝${SPINS}スピン（${SPIN_MS}ms間隔）／各${SESSIONS}セッション`);
  for (const m of Object.keys(SLOT_MACHINES)) {
    const base = simulate(m, 0, rng, Math.min(SESSIONS, 1500));
    const kk = SLOT_KAKU_RATE[m];
    const r = simulate(m, kk, rng);
    const staked = SLOT_MACHINES[m].price * SPINS;
    console.log(`${m.padEnd(11)} 料金${SLOT_MACHINES[m].price}  通常:平均${base.mean.toFixed(0)}  確変(k=${kk}): 平均${r.mean.toFixed(0)} p10=${r.p10} 中央=${r.p50} p90=${r.p90}  +400以上=${(r.ge400 * 100).toFixed(0)}%  プラス=${(r.ge0 * 100).toFixed(0)}%  還元率≈${((staked + r.mean) / staked * 100).toFixed(0)}%`);
  }
}
