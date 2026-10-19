/* =========================================================
   🎬 ゆう宝くじ「抽選会ショー」（yulottery.js から呼ばれる）

   ・Worker が確定した前回の結果（st.last）を、約30秒の演出で発表するだけ。結果はサーバーが決めていて、ここでは何も決めない。
   ・流れ：オープニング → 7〜4等の本数 → 3等 → 2等 → 1等（丸いライトがくるくる回る・虹色の爆発・カットイン）→ 前後賞 → あなたの結果
   ・動画ファイルは使わず、CSS と Web Audio（親の yuworld.js の音の設定に従う）だけ。Firebase には触れない。
   ・スキップ可。「動きを減らす」設定のときは、回転・紙吹雪をやめて短くする。
========================================================= */

const fmt = (n) => Number(n || 0).toLocaleString("ja-JP");
const reduced = () => { try { return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (_) { return false; } };
const fmtNo = (n) => `${String(Math.floor(n / 100) + 1).padStart(2, "0")}組${String(n % 100).padStart(3, "0")}番`;
const COLORS = ["#ff2d78", "#ff8a00", "#ffe14a", "#17e36a", "#17b6ff", "#b14cff", "#ffffff"];
let stylesDone = false;

export function stopLotteryShow() { document.querySelectorAll(".yls-mask").forEach((e) => { if (e._cancel) e._cancel(); else e.remove(); }); }

/* last＝Worker の lotteryStatus の last。opts.speed＝待ち時間を縮める倍率（テスト用）、opts.bought＝この回に買ったか */
export function playLotteryShow(ctx, last, opts = {}) {
  return new Promise((resolve) => {
    injectStyles();
    const speed = Math.max(0.1, Number(opts.speed) || (ctx && ctx.showSpeed) || 1);
    const rm = reduced();
    const esc = ctx.esc;
    const sfx = ctx.sfx || {};
    const tone = (n, vol, type, when) => { try { if (sfx.tone) sfx.tone(n, vol, type, when); } catch (_) { /* 音が出せなくても演出は続ける */ } };
    const tiers = last.tiers || [];
    const tierOf = (name) => tiers.find((t) => t.name === name) || { name, count: 0, prize: 0, hit: 0 };
    const numbersOf = (name) => (last.numbers || []).filter((n) => n.tier === name);

    const mask = document.createElement("div");
    mask.className = "yls-mask";
    mask.setAttribute("role", "dialog");
    mask.setAttribute("aria-label", "抽選会");
    mask.innerHTML = `<div class="yls-bg"></div><div class="yls-burst" aria-hidden="true"></div><div class="yls-lights" aria-hidden="true"></div>
      <div class="yls-stage"><div class="yls-title">🎟 ${esc(last.name)}</div><div class="yls-sub">抽選会</div><div class="yls-body"></div></div>
      <button type="button" class="yls-skip">スキップ ▶</button>`;
    document.body.appendChild(mask);
    const body = mask.querySelector(".yls-body");
    const skipBtn = mask.querySelector(".yls-skip");
    const lights = mask.querySelector(".yls-lights");

    let skipped = false, finished = false;
    const waiters = new Set(), ints = new Set();
    const sleep = (ms) => new Promise((res) => {
      if (skipped) return res();
      const t = setTimeout(() => { waiters.delete(done); res(); }, (ms / speed) * (rm ? 0.3 : 1));
      const done = () => { clearTimeout(t); res(); };
      waiters.add(done);
    });
    const skip = () => { skipped = true; waiters.forEach((f) => f()); waiters.clear(); };
    const finish = () => {
      if (finished) return; finished = true;
      ints.forEach((i) => clearInterval(i)); ints.clear();
      waiters.forEach((f) => f()); waiters.clear();
      mask.remove();
      resolve();
    };
    mask._cancel = finish;
    skipBtn.addEventListener("click", () => { if (skipBtn.dataset.mode === "close") finish(); else skip(); });

    const confetti = (n) => {
      if (rm) return;
      for (let k = 0; k < n; k++) {
        const c = document.createElement("span");
        c.className = "yls-confetti";
        c.style.left = Math.random() * 100 + "%";
        c.style.background = COLORS[k % COLORS.length];
        c.style.animationDelay = (Math.random() * 0.6).toFixed(2) + "s";
        mask.appendChild(c);
        setTimeout(() => c.remove(), 3200);
      }
    };
    const flash = () => { if (rm) return; const f = document.createElement("div"); f.className = "yls-flash"; mask.appendChild(f); setTimeout(() => f.remove(), 700); };
    const drum = (ms, from, to) => { // ドラムロール：低い音を細かく鳴らして、だんだん高く・大きく
      const beats = Math.max(6, Math.floor(ms / 75));
      for (let k = 0; k < beats; k++) tone([from + (to - from) * (k / beats), 0.07], 0.02 + 0.03 * (k / beats), "triangle", (k * ms) / 1000 / beats / speed);
    };
    const show = (html, cls) => { const d = document.createElement("div"); d.className = "yls-step " + (cls || ""); d.innerHTML = html; body.appendChild(d); return d; };
    const clearBody = () => { body.innerHTML = ""; };

    /* 番号のリール（数字が回って、左から1桁ずつ止まる） */
    const makeReel = (n, cls) => {
      const g = String(Math.floor(n / 100) + 1).padStart(2, "0"), b = String(n % 100).padStart(3, "0");
      const cells = [...g, "組", ...b, "番"];
      const box = document.createElement("div");
      box.className = "yls-reel " + (cls || "");
      box.innerHTML = cells.map((c) => (c === "組" || c === "番") ? `<span class="yls-u">${c}</span>` : `<span class="yls-d" data-v="${c}">${rm ? c : Math.floor(Math.random() * 10)}</span>`).join("");
      const ds = [...box.querySelectorAll(".yls-d")];
      if (!rm) { const iv = setInterval(() => ds.forEach((d) => { if (!d.classList.contains("lock")) d.textContent = Math.floor(Math.random() * 10); }), 55); ints.add(iv); box._iv = iv; }
      box._ds = ds;
      return box;
    };
    const lockReel = async (box, gap, pitch) => {
      for (let i = 0; i < box._ds.length; i++) {
        await sleep(gap);
        const d = box._ds[i]; d.textContent = d.dataset.v; d.classList.add("lock");
        tone([pitch + i * 90, 0.12], 0.05, "square");
      }
      if (box._iv) { clearInterval(box._iv); ints.delete(box._iv); }
    };
    const whoHtml = (it) => it.name ? `<div class="yls-who">${esc(it.name)} さん</div>` : `<div class="yls-who none">売れ残り…</div>`;

    const ringHtml = (d, n, t, rev) => `<div class="yls-ring${rev ? " rev" : ""}" style="--d:${d}px;--t:${t}s">${Array.from({ length: n }, (_, i) => `<i class="yls-bulb" style="--a:${(360 / n) * i}deg;--k:${i};--c:hsl(${Math.round((360 / n) * i)} 100% 60%)"></i>`).join("")}</div>`;
    const lightsOn = (mega) => {
      const w = Math.min(window.innerWidth * 0.9, 380);
      lights.innerHTML = ringHtml(Math.round(w), 28, 7) + ringHtml(Math.round(w * 0.72), 20, 5, true) + ringHtml(Math.round(w * 0.46), 12, 3);
      lights.classList.add("on"); lights.classList.toggle("mega", !!mega);
    };

    const intro = async () => {
      show(`<div class="yls-big">まもなく発表！</div><div class="yls-hint">販売 ${fmt(last.tickets)} 枚</div>`, "pop");
      drum(2200, 90, 150);
      await sleep(2300);
    };

    const lowTiers = async () => {
      clearBody();
      const box = show(`<div class="yls-rows"></div>`);
      const rows = box.querySelector(".yls-rows");
      for (const name of ["7等", "6等", "5等", "4等"]) {
        if (skipped) return;
        const t = tierOf(name);
        const row = document.createElement("div");
        row.className = "yls-row in";
        row.innerHTML = `<b>${esc(name)}</b><span>${fmt(t.prize)} コイン × ${fmt(t.count)}本</span><em>${t.hit > 0 ? `${fmt(t.hit)}口 当選` : "当選なし"}</em>`;
        rows.appendChild(row);
        tone([440 + rows.children.length * 90, 0.1], 0.05, "triangle");
        await sleep(850);
      }
      await sleep(500);
    };

    const revealTier = async (name, title, gap, withLights) => {
      clearBody();
      const t = tierOf(name);
      const items = numbersOf(name);
      const box = show(`<div class="yls-tier">${title || esc(name)}<small>${fmt(t.prize)} コイン</small></div><div class="yls-reels"></div>`);
      const wrap = box.querySelector(".yls-reels");
      const reels = items.map((it) => { const r = makeReel(it.number); const cell = document.createElement("div"); cell.className = "yls-cell"; cell.appendChild(r); wrap.appendChild(cell); return { r, cell, it }; });
      drum(700 + reels.length * 6 * gap, 100, 200);
      for (const x of reels) {
        if (skipped) return;
        await lockReel(x.r, gap, 520);
        x.cell.insertAdjacentHTML("beforeend", whoHtml(x.it));
        tone([880, 0.2], 0.06, "triangle");
        await sleep(300);
      }
      await sleep(700);
    };

    const tier1 = async () => {
      clearBody();
      const t = tierOf("1等");
      const it = numbersOf("1等")[0];
      lightsOn(false);
      const box = show(`<div class="yls-tier first">👑 1等<small>${fmt(t.prize)} コイン</small></div><div class="yls-reels"></div>`);
      if (!it) { box.insertAdjacentHTML("beforeend", `<div class="yls-who none">1等は出ませんでした</div>`); await sleep(1500); return; }
      const wrap = box.querySelector(".yls-reels");
      const cell = document.createElement("div"); cell.className = "yls-cell";
      const reel = makeReel(it.number, "big"); cell.appendChild(reel); wrap.appendChild(cell);
      await sleep(400);
      drum(3600, 80, 260);
      await sleep(2000);
      mask.classList.add("tense");
      await lockReel(reel, 520, 600);
      if (skipped) return;
      // 全部止まった！
      mask.classList.remove("tense"); mask.classList.add("boom");
      lights.classList.add("fast");
      flash(); confetti(110);
      tone([1047, 0.5], 0.08, "square"); tone([1319, 0.5], 0.08, "square", 0.12 / speed); tone([1568, 0.9], 0.09, "square", 0.24 / speed);
      const cut = document.createElement("div"); cut.className = "yls-cutin"; cut.innerHTML = `<span>👑 1等 当選番号！</span>`; mask.appendChild(cut);
      setTimeout(() => cut.remove(), 2400 / speed);
      cell.insertAdjacentHTML("beforeend", whoHtml(it));
      await sleep(3200);
      mask.classList.remove("boom");
    };

    const adjacent = async () => {
      if (!numbersOf("前後賞").length) return;
      await revealTier("前後賞", "🎀 前後賞", 220);
    };

    const countUp = async (el, to) => {
      const steps = rm ? 1 : 30;
      for (let k = 1; k <= steps; k++) { el.textContent = fmt(Math.round((to * k) / steps)); if (k < steps) await sleep(40); }
    };
    const resultScreen = async () => {
      skipped = true; waiters.forEach((f) => f()); waiters.clear(); // ここからは待ち時間なし（スキップ後も結果は見せる）
      ints.forEach((i) => clearInterval(i)); ints.clear();
      skipped = false;
      clearBody(); mask.classList.remove("tense", "boom");
      const wins = (last.myWins || []).slice().sort((a, b) => tiers.findIndex((t) => t.name === a.tier) - tiers.findIndex((t) => t.name === b.tier));
      const total = Number(last.myWin) || 0;
      const mega = wins.some((w) => w.tier === "1等");
      if (wins.length) {
        if (!lights.classList.contains("on")) lightsOn(mega);
        lights.classList.toggle("mega", mega);
        const box = show(`<div class="yls-tier">🎉 あなたの結果</div>
          <div class="yls-mywins">${wins.map((w) => `<div class="yls-mywin${w.tier === "1等" ? " top" : ""}"><b>${esc(w.tier)}</b><span>${fmtNo(w.number)}</span><em>+${fmt(w.amount)}</em></div>`).join("")}</div>
          <div class="yls-total">合計 <span id="ylsTotal">0</span> <small>コイン</small></div><div class="yls-hint">賞金はもう あなたのコインに入っています。</div>`, "pop");
        flash(); confetti(mega ? 140 : 70);
        if (sfx.tone) { tone([523, 0.12], 0.06, "square"); tone([659, 0.12], 0.06, "square", 0.12); tone([784, 0.14], 0.06, "square", 0.24); tone([1047, 0.12], 0.06, "square", 0.36); tone([1319, 0.4], 0.07, "square", 0.48); }
        await countUp(box.querySelector("#ylsTotal"), total);
      } else {
        lights.classList.remove("on");
        show(opts.bought === false
          ? `<div class="yls-tier">抽選会、おつかれさま！</div><div class="yls-hint">次の回は、あなたもぜひ参加してね🎟</div>`
          : `<div class="yls-tier">今回は残念…</div><div class="yls-hint">また来週の抽選をお楽しみに！<br>きっとツキが回ってくるよ✨</div>`, "pop");
        tone([392, 0.2], 0.04, "sine"); tone([523, 0.3], 0.04, "sine", 0.2);
      }
      skipBtn.textContent = "とじる"; skipBtn.dataset.mode = "close";
    };

    (async () => {
      try {
        await intro();
        if (!skipped) await lowTiers();
        if (!skipped) await revealTier("3等", "🥉 3等", 260);
        if (!skipped) await revealTier("2等", "🥈 2等", 300);
        if (!skipped) await tier1();
        if (!skipped) await adjacent();
      } catch (_) { /* どこかで失敗しても、結果は必ず見せる */ }
      if (!finished) await resultScreen();
    })();
  });
}

function injectStyles() {
  if (stylesDone) return; stylesDone = true;
  const css = `
  .yls-mask { position: fixed; inset: 0; z-index: 2147483300; overflow: hidden; display: flex; align-items: center; justify-content: center; color: #fff; font-family: inherit; }
  .yls-bg { position: absolute; inset: 0; background: radial-gradient(ellipse at 50% 40%, #3a1a8a 0%, #160a3a 55%, #07031a 100%); transition: filter .6s; }
  .yls-mask.tense .yls-bg { filter: brightness(.45) saturate(1.3); }
  .yls-mask.boom .yls-bg { filter: brightness(1.25) saturate(1.5); }
  .yls-burst { position: absolute; left: 50%; top: 50%; width: 220vmax; height: 220vmax; margin: -110vmax 0 0 -110vmax; opacity: 0; transition: opacity .4s; pointer-events: none;
    background: repeating-conic-gradient(from 0deg, #ff2d78 0 12deg, #ff8a00 12deg 24deg, #ffe14a 24deg 36deg, #17e36a 36deg 48deg, #17b6ff 48deg 60deg, #b14cff 60deg 72deg);
    -webkit-mask-image: radial-gradient(circle, rgba(0,0,0,.55) 0%, transparent 38%); mask-image: radial-gradient(circle, rgba(0,0,0,.55) 0%, transparent 38%); animation: yls-spin 9s linear infinite; }
  .yls-mask.boom .yls-burst { opacity: 1; }
  .yls-lights { position: absolute; left: 50%; top: 50%; width: 0; height: 0; opacity: 0; transition: opacity .5s; pointer-events: none; }
  .yls-lights.on { opacity: 1; }
  .yls-ring { position: absolute; left: 0; top: 0; width: 0; height: 0; animation: yls-spin calc(var(--t) * var(--spd, 1)) linear infinite; }
  .yls-ring.rev { animation-direction: reverse; }
  .yls-lights.fast { --spd: .35; }
  .yls-bulb { position: absolute; left: 0; top: 0; width: 16px; height: 16px; margin: -8px 0 0 -8px; border-radius: 50%;
    background: radial-gradient(circle at 35% 30%, #fff 0%, var(--c) 55%, rgba(0,0,0,.35) 100%); box-shadow: 0 0 12px 4px var(--c), 0 0 26px 8px var(--c);
    transform: rotate(var(--a)) translateY(calc(var(--d, 300px) / -2)); animation: yls-blink .7s ease-in-out infinite; animation-delay: calc(var(--k) * -0.06s); }
  .yls-ring { --d: 300px; } .yls-ring .yls-bulb { --d: inherit; }
  .yls-lights.mega .yls-bulb { background: radial-gradient(circle at 35% 30%, #fff 0%, #ffd700 55%, #a86a00 100%); box-shadow: 0 0 14px 5px #ffd700, 0 0 30px 10px #ffb300; }
  @keyframes yls-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
  @keyframes yls-blink { 0%,100% { opacity: .35; filter: brightness(.8); } 50% { opacity: 1; filter: brightness(1.5); } }
  .yls-stage { position: relative; z-index: 2; width: min(94vw, 430px); text-align: center; }
  .yls-title { font-size: 19px; font-weight: 900; text-shadow: 0 0 12px #ffe14a, 0 2px 6px rgba(0,0,0,.6); }
  .yls-sub { font-size: 12px; letter-spacing: .4em; opacity: .85; margin-bottom: 14px; }
  .yls-body { min-height: 300px; display: flex; flex-direction: column; justify-content: center; }
  .yls-step.pop { animation: yls-pop .5s cubic-bezier(.2,1.4,.4,1); }
  @keyframes yls-pop { from { transform: scale(.4); opacity: 0; } to { transform: scale(1); opacity: 1; } }
  .yls-big { font-size: 34px; font-weight: 900; text-shadow: 0 0 18px #ff2d78, 0 0 8px #fff; }
  .yls-hint { margin-top: 10px; font-size: 13px; opacity: .92; line-height: 1.8; }
  .yls-rows { display: flex; flex-direction: column; gap: 8px; }
  .yls-row { display: grid; grid-template-columns: 52px 1fr auto; gap: 8px; align-items: center; text-align: left; padding: 10px 12px; border-radius: 12px; background: rgba(255,255,255,.12); border: 1px solid rgba(255,255,255,.25); }
  .yls-row.in { animation: yls-slide .45s ease-out; } .yls-row b { font-size: 18px; } .yls-row em { font-style: normal; color: #ffe14a; font-weight: 800; }
  @keyframes yls-slide { from { transform: translateX(-60px); opacity: 0; } to { transform: none; opacity: 1; } }
  .yls-tier { font-size: 26px; font-weight: 900; text-shadow: 0 0 14px #ffe14a; } .yls-tier small { display: block; font-size: 14px; font-weight: 700; color: #ffe14a; margin-top: 2px; }
  .yls-tier.first { font-size: 32px; text-shadow: 0 0 18px #ffd700, 0 0 34px #ff8a00; }
  .yls-reels { display: flex; flex-direction: column; gap: 12px; margin-top: 14px; align-items: center; }
  .yls-cell { display: flex; flex-direction: column; align-items: center; gap: 4px; }
  .yls-reel { display: inline-flex; align-items: center; gap: 3px; padding: 8px 12px; border-radius: 12px; background: #0b0620; border: 2px solid #ffd24a; box-shadow: inset 0 0 14px rgba(255,210,74,.35), 0 0 14px rgba(255,210,74,.4); font-variant-numeric: tabular-nums; }
  .yls-d { display: inline-block; min-width: 24px; font-size: 32px; font-weight: 900; color: #9fb6ff; } .yls-d.lock { color: #ffe14a; text-shadow: 0 0 10px #ffd700; animation: yls-lock .3s ease-out; }
  .yls-u { font-size: 15px; font-weight: 800; margin: 0 4px 0 1px; opacity: .9; }
  .yls-reel.big { padding: 12px 16px; border-width: 3px; } .yls-reel.big .yls-d { font-size: 44px; min-width: 32px; } .yls-reel.big .yls-u { font-size: 20px; }
  @keyframes yls-lock { 0% { transform: scale(1.8); } 100% { transform: scale(1); } }
  .yls-who { font-size: 16px; font-weight: 800; color: #fff; text-shadow: 0 0 8px #ff2d78; animation: yls-pop .4s ease-out; } .yls-who.none { color: #b9b4d6; text-shadow: none; font-weight: 600; }
  .yls-cutin { position: absolute; left: 0; right: 0; top: 36%; z-index: 6; height: 84px; display: flex; align-items: center; justify-content: center; font-size: 30px; font-weight: 900; transform: skewY(-4deg);
    background: linear-gradient(90deg, rgba(255,45,120,.0), #ff2d78 15%, #ff8a00 45%, #ffe14a 65%, rgba(255,225,74,0)); text-shadow: 0 0 14px #fff, 0 2px 4px rgba(0,0,0,.5); animation: yls-cut 2.4s ease-out forwards; pointer-events: none; }
  @keyframes yls-cut { 0% { transform: translateX(-110%) skewY(-4deg); } 18% { transform: translateX(0) skewY(-4deg); } 82% { transform: translateX(0) skewY(-4deg); opacity: 1; } 100% { transform: translateX(110%) skewY(-4deg); opacity: 0; } }
  .yls-flash { position: absolute; inset: 0; z-index: 7; background: #fff; pointer-events: none; animation: yls-fl .7s ease-out forwards; }
  @keyframes yls-fl { from { opacity: .95; } to { opacity: 0; } }
  .yls-confetti { position: absolute; top: -14px; z-index: 5; width: 9px; height: 14px; border-radius: 2px; pointer-events: none; animation: yls-fall 3s linear forwards; }
  @keyframes yls-fall { 0% { transform: translateY(-10px) rotate(0); opacity: 0; } 8% { opacity: 1; } 100% { transform: translateY(110vh) rotate(900deg); opacity: .9; } }
  .yls-mywins { display: flex; flex-direction: column; gap: 6px; margin: 12px 0; }
  .yls-mywin { display: grid; grid-template-columns: 52px 1fr auto; gap: 8px; align-items: center; padding: 8px 12px; border-radius: 10px; background: rgba(255,255,255,.14); text-align: left; }
  .yls-mywin.top { background: linear-gradient(90deg, rgba(255,215,0,.45), rgba(255,138,0,.35)); border: 1px solid #ffd700; } .yls-mywin em { font-style: normal; font-weight: 900; color: #ffe14a; }
  .yls-total { font-size: 22px; font-weight: 900; } .yls-total span { font-size: 46px; color: #ffe14a; text-shadow: 0 0 16px rgba(255,225,74,.9); font-variant-numeric: tabular-nums; } .yls-total small { font-size: 15px; }
  .yls-skip { position: absolute; right: 12px; bottom: 14px; z-index: 9; border: 1px solid rgba(255,255,255,.5); background: rgba(0,0,0,.45); color: #fff; border-radius: 999px; padding: 9px 18px; font-size: 14px; font-weight: 800; cursor: pointer; }
  @media (prefers-reduced-motion: reduce) { .yls-ring, .yls-burst, .yls-bulb, .yls-step.pop, .yls-row.in, .yls-confetti, .yls-d.lock, .yls-cutin { animation: none; } .yls-cutin { transform: skewY(-4deg); } }
  `;
  const style = document.createElement("style");
  style.id = "yulotteryshow-styles";
  style.textContent = css;
  document.head.appendChild(style);
}
