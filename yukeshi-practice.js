/* =========================================================
   消しバト 試し打ち（ショップから開く、ひとり用の練習）
   ・試合と同じ3Dの机で、自分の消しゴムを弾いてみる。真ん中には、初期装備の消しゴムが置いてあるだけ（操作はできない）。
     どれくらい飛ばせるか・机から落とせるかを試せる。落としたら、真ん中に新しい消しゴムが出てくる。
   ・すべてこの端末の中だけで動く（通信・コイン・記録はなし）。動きの計算は、試合と同じ（yukeshi-core.js の keshiSimStepper）。
   ・ショップで選んでいるパーツのまま試せるので、買う前に試せる。
========================================================= */
import { createBattleStage } from "./yukeshi-room.js?v=20261024-mart8";
import { keshiSimStepper, keshiPhysView, keshiLaunchSpeedView, keshiStatsView, keshiPunchView, KESHI_DESK, KESHI_DT, eraserIcon } from "./yukeshi-core.js?v=20261024-mart8";

const START_YAW = [Math.PI / 2, -Math.PI / 2];
const yawOf = (dx, dz) => Math.atan2(-dz, dx);
const r3 = (x) => Math.round(x * 1000) / 1000;
const DEFAULT_EQ = { body: "plain", edge: "paper", sole: "bare", weight: "none" };
const DUMMY_COLOR = 6;   // 置いてあるだけの消しゴムは、黒いカバー
const MINE_AT = [0, 5.0], CENTER = [0, 0];   // 自分は、真ん中の消しゴムから少し離れた手前に置く（落ちたときは、ここにもどる）
let stylesDone = false, run = 0, stage = null;

export function stopPractice() { run++; if (stage) { try { stage.dispose(); } catch (_) {} stage = null; } }

/* c：{ root（描く場所）, esc, table（パーツの表）, eq（試す消しゴムのパーツ）, color, title（試している組み合わせの説明）, onBack } */
export function renderPractice(c) {
  stopPractice();
  injectStyles();
  const my = run, esc = c.esc;
  const stats = keshiStatsView(c.table, c.eq), punch = keshiPunchView(c.table, c.eq), P = [keshiPhysView(stats), keshiPhysView(keshiStatsView(c.table, DEFAULT_EQ))];
  c.root.innerHTML = `<div class="kp-head"><button type="button" class="yw-back" id="kpBack">← 消しゴムの改造へ</button><h2>🎯 試し打ち</h2></div>
    <p class="kp-note">試合と同じ机で、自分の消しゴムを弾いてみよう。真ん中の黒い消しゴムは、初期装備のまま置いてあるだけで、動きません。机から落とすと、また真ん中に出てきます。</p>
    <div class="kp-gear">${eraserIcon("ker-inline")} 試している消しゴム <b>総合力 ${stats.rating}</b><b>攻撃力 ×${punch.atk.toFixed(1)}</b><b>守り ×${punch.def.toFixed(1)}</b>${c.title ? `<span>${esc(c.title)}</span>` : ""}</div>
    <div class="kp-stage" id="kpStage"><div class="kp-loading">${eraserIcon("kp-ico")}<span>机を準備しています…</span></div><div class="kp-power" id="kpPower"><i></i></div></div>
    <div class="kp-score"><div><small>ふっとび距離</small><b id="kpDist">—</b></div><div><small>落とした回数</small><b id="kpDrops">0</b></div><div><small>弾いた回数</small><b id="kpShots">0</b></div></div>
    <p class="kp-hint" id="kpHint">画面を指で後ろに引っ張って、はなして弾こう（弱く引くと弱く、強く引くと強く弾く）。自分の消しゴムは、机から落ちるまで、止まった場所から続けて弾けます。</p>
    <button type="button" class="yw-btn kp-reset" id="kpReset">もとの位置にもどす</button>`;
  c.root.querySelector("#kpBack")?.addEventListener("click", () => { stopPractice(); c.onBack(); });
  const q = (s) => c.root.querySelector(s);
  const S = { poses: [{ x: MINE_AT[0], z: MINE_AT[1], yaw: START_YAW[0] }, { x: CENTER[0], z: CENTER[1], yaw: START_YAW[1] }], busy: false, shots: 0, drops: 0 };
  const say = (t) => { const h = q("#kpHint"); if (h) h.textContent = t; };

  createBattleStage(q("#kpStage"), { me: 0, eq: [c.eq, DEFAULT_EQ], color: [c.color, DUMMY_COLOR] }).then((st) => {
    if (my !== run || !q("#kpStage")) { if (st) st.dispose(); return; }
    if (!st) { q(".kp-loading")?.replaceChildren(document.createTextNode("この端末では3Dが使えないため、試し打ちはできません。")); return; }
    stage = st; q(".kp-loading")?.remove();
    const power = q("#kpPower");
    const show = (i, extra = {}) => st.pose(i, { ...S.poses[i], ...extra });
    const place = (pops = []) => { [0, 1].forEach((i) => { show(i); if (pops.includes(i)) st.pop(i); }); st.render(); };
    const home = (i) => { S.poses[i] = { x: i === 0 ? MINE_AT[0] : CENTER[0], z: i === 0 ? MINE_AT[1] : CENTER[1], yaw: START_YAW[i] }; };
    place();
    st.hooks.canAim = () => !S.busy;
    st.hooks.onAim = (a) => { if (power) { power.classList.toggle("on", !!a); const i = power.querySelector("i"); if (i && a) i.style.width = Math.round(a.p * 100) + "%"; } };
    st.hooks.onCancel = () => { show(0); st.render(); };
    st.hooks.pose = (a, back) => { const n = Math.hypot(a.dx, a.dz) || 1; S.poses[0].yaw = yawOf(a.dx, a.dz); show(0, { ox: -a.dx / n * back, oz: -a.dz / n * back }); };
    st.hooks.onFire = (a) => fire(a);

    function fire(a) {
      S.busy = true; S.shots++; q("#kpShots").textContent = String(S.shots);
      const n = Math.hypot(a.dx, a.dz) || 1, v = keshiLaunchSpeedView(P[0], a.p), vx = r3(a.dx / n * v), vz = r3(a.dz / n * v);
      const from = [[S.poses[0].x, S.poses[0].z], [S.poses[1].x, S.poses[1].z]];
      S.poses[0].yaw = yawOf(vx, vz); show(0);
      const s = keshiSimStepper(P, from, 0, vx, vz);
      let acc = 0, more = true; const fallT = [-1, -1];
      st.setTicker((dt) => {
        acc += dt;
        while (more && acc >= KESHI_DT) { more = s.step(); acc -= KESHI_DT; [0, 1].forEach((i) => { if (s.out[i] && fallT[i] < 0) fallT[i] = 0; }); }
        let falling = false;
        [0, 1].forEach((i) => {
          if (fallT[i] >= 0) {
            fallT[i] += dt; const t = fallT[i], sp = Math.hypot(s.vx[i], s.vz[i]) || 1, ux = s.vx[i] / sp, uz = s.vz[i] / sp;
            st.pose(i, { x: s.x[i] + s.vx[i] * t * .6, z: s.z[i] + s.vz[i] * t * .6, y: -9 * t * t, yaw: S.poses[i].yaw - s.th[i], tx: uz * Math.min(t * 3.2, 1.7), tz: -ux * Math.min(t * 3.2, 1.7), visible: -9 * t * t > -8 });
            if (t < 1) falling = true;
          } else st.pose(i, { x: s.x[i], z: s.z[i], yaw: S.poses[i].yaw - s.th[i] });
        });
        if (more || falling) return true;
        finish(s, from); return false;
      });
    }
    function finish(s, from) {
      [0, 1].forEach((i) => { S.poses[i].yaw -= s.th[i]; });   // 回ったままの向きで止まる
      const dummyMoved = Math.hypot(s.x[1] - from[1][0], s.z[1] - from[1][1]);
      S.poses[1] = { ...S.poses[1], x: s.x[1], z: s.z[1] };
      const hit = dummyMoved > 0.02;
      if (s.out[1]) { S.drops++; q("#kpDrops").textContent = String(S.drops); q("#kpDist").textContent = "落とした！"; say("机から落としました！ 真ん中に新しい消しゴムが出てきます。"); home(1); }
      else if (hit) { q("#kpDist").textContent = dummyMoved.toFixed(1); say("当たりました。ふっとび距離は、机の幅を 7.2 としたときの長さです。"); }
      else { q("#kpDist").textContent = "当たらず"; say(s.out[0] ? "自分が机から落ちてしまいました。スタートの位置にもどします。弾く強さを少し弱めてみよう。" : "当たりませんでした。向きと強さを変えて、もう一度。"); }
      S.poses[0] = { ...S.poses[0], x: s.x[0], z: s.z[0] };   // 自分の消しゴムは、止まった場所のまま（机から落ちたときだけ、スタートの位置にもどる）
      if (s.out[0]) home(0);
      const pops = [...(s.out[0] ? [0] : []), ...(s.out[1] ? [1] : [])];   // 新しく出てくる消しゴムだけ、ぽんと出す
      setTimeout(() => { if (my !== run) return; place(pops); S.busy = false; }, 900);
    }
    q("#kpReset")?.addEventListener("click", () => { if (S.busy) return; home(0); home(1); place([0, 1]); say("もとの位置にもどしました。"); });
  }).catch(() => { if (my === run) q(".kp-loading")?.replaceChildren(document.createTextNode("3Dの準備に失敗しました。開き直してください。")); });
}

function injectStyles() {
  if (stylesDone) return; stylesDone = true;
  const css = `
  .kp-head { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; } .kp-head h2 { margin: 6px 0 4px; font-size: 20px; flex: 1; }
  .kp-note { color: #666; font-size: 12.5px; line-height: 1.7; margin: 4px 0 8px; }
  .kp-gear { background: #fff; border-radius: 12px; padding: 8px 12px; box-shadow: 0 2px 8px rgba(0,0,0,.07); font-size: 13px; margin-bottom: 8px; } .kp-gear b { margin-left: 6px; color: #14507a; } .kp-gear span { display: block; color: #777; font-size: 11.5px; margin-top: 2px; }
  .kp-stage { position: relative; width: 100%; max-width: 560px; margin: 0 auto; aspect-ratio: 5 / 7; max-height: 78vh; border-radius: 16px; overflow: hidden; background: radial-gradient(ellipse at 50% 40%, #b9cde0 0%, #8aa3bd 60%, #6a8099 100%); box-shadow: inset 0 0 30px rgba(0,0,0,.25); touch-action: none; -webkit-user-select: none; user-select: none; }
  .kb-gl { position: absolute; left: 0; top: 0; touch-action: none; }
  .kp-loading { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; color: #fff; font-weight: 700; font-size: 13px; text-align: center; padding: 0 16px; } .kp-ico { width: 74px; height: 52px; display: block; margin: 0 auto 6px; }
  .kp-power { position: absolute; left: 14%; right: 14%; bottom: 10px; height: 12px; border-radius: 999px; background: rgba(0,0,0,.35); opacity: 0; transition: opacity .15s; pointer-events: none; overflow: hidden; } .kp-power.on { opacity: 1; }
  .kp-power i { display: block; height: 100%; width: 0; background: linear-gradient(90deg, #33cc55, #f5d02b, #e0412f); background-size: 560px 100%; }
  .kp-score { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin: 10px 0 6px; } .kp-score > div { background: #fff; border-radius: 12px; padding: 8px 6px; text-align: center; box-shadow: 0 2px 8px rgba(0,0,0,.07); } .kp-score small { display: block; color: #888; font-size: 11px; } .kp-score b { font-size: 18px; color: #14507a; }
  .kp-hint { text-align: center; color: #555; font-size: 12px; line-height: 1.6; margin: 6px 4px; } .kp-reset { display: block; width: 100%; padding: 11px; font-size: 14px; background: #6b7280; }
  `;
  const el = document.createElement("style"); el.id = "kp-style"; el.textContent = css; document.head.appendChild(el);
}
