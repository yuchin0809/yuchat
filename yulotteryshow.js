/* =========================================================
   🎬 ゆう宝くじ「抽選会ショー」（yulottery.js から呼ばれる）

   ・Worker が確定した前回の結果（st.last）を、約30秒の演出で発表するだけ。結果はサーバーが決めていて、ここでは何も決めない。
   ・流れ：オープニング → 7〜4等の本数 → 3等 → 2等 → 1等 → 前後賞 → あなたの結果。等級の前には「つづいては…」でじらし、2等・1等は最後の1桁でゆっくり回って、惜しい番号で止まってから本当の番号に決まる。
   ・1等は豪華：数字が決まったら 金色の光・花火・コインの雨・紙吹雪・ファンファーレ・カットイン → 「当選者は…」でためてから、名前をどーんと出す。
   ・opts.preview＝管理者の「仮の結果発表」（画面に「仮」の札が出る）
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
      ${opts.preview ? `<div class="yls-ribbon">🧪 仮の結果（管理者のテスト）</div>` : ""}
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
    const heartbeat = (ms) => { for (let t = 0; t < ms; t += 640) { tone([62, 0.16], 0.12, "sine", t / 1000 / speed); tone([62, 0.12], 0.09, "sine", (t + 190) / 1000 / speed); } };
    const fanfare = (big) => {
      const mel = big
        ? [[523, 0.15, 0], [659, 0.15, 0.15], [784, 0.15, 0.3], [1047, 0.45, 0.45], [784, 0.15, 0.95], [1047, 0.15, 1.1], [1319, 0.8, 1.25], [1568, 1.1, 2.1]]
        : [[784, 0.15, 0], [988, 0.15, 0.15], [1175, 0.5, 0.3]];
      mel.forEach(([f, d, w]) => { tone([f, d], 0.07, "square", w / speed); tone([f / 2, d], 0.05, "triangle", w / speed); });
    };
    const fireworks = (n) => {
      if (rm) return;
      for (let k = 0; k < n; k++) setTimeout(() => {
        const cx = 10 + Math.random() * 80, cy = 10 + Math.random() * 50, col = COLORS[Math.floor(Math.random() * 6)];
        for (let j = 0; j < 18; j++) {
          const a = (Math.PI * 2 * j) / 18, r = 70 + Math.random() * 60, sp = document.createElement("span");
          sp.className = "yls-spark";
          sp.style.cssText = `left:${cx}%;top:${cy}%;--dx:${Math.cos(a) * r}px;--dy:${Math.sin(a) * r}px;background:${j % 3 === 0 ? "#fff" : col}`;
          mask.appendChild(sp); setTimeout(() => sp.remove(), 1500);
        }
        tone([300 + Math.random() * 500, 0.14], 0.05, "sawtooth");
      }, ((k * 280) + Math.random() * 160) / speed);
    };
    const coinRain = (n) => {
      if (rm) return;
      for (let k = 0; k < n; k++) {
        const c = document.createElement("span");
        c.className = "yls-coin"; c.textContent = k % 5 === 0 ? "👑" : "🪙";
        c.style.left = Math.random() * 100 + "%"; c.style.animationDelay = (Math.random() * 1.4).toFixed(2) + "s"; c.style.fontSize = 18 + Math.floor(Math.random() * 16) + "px";
        mask.appendChild(c); setTimeout(() => c.remove(), 4600);
      }
    };
    const cutin = (html, ms) => {
      const cut = document.createElement("div"); cut.className = "yls-cutin"; cut.innerHTML = `<span>${html}</span>`;
      cut.style.animationDuration = (ms / 1000 / speed) + "s"; mask.appendChild(cut);
      setTimeout(() => cut.remove(), ms / speed + 100);
    };
    const tease = async (html, ms) => { // 「つづいては…」：暗くして、ドラムロールでじらす
      clearBody(); mask.classList.add("tense");
      show(`<div class="yls-tease">${html}</div>`, "pop");
      drum(ms, 80, 200); heartbeat(ms);
      await sleep(ms);
      mask.classList.remove("tense");
    };

    /* 番号のリール（数字が回って、左から1桁ずつ止まる） */
    const makeReel = (n, cls) => {
      const g = String(Math.floor(n / 100) + 1).padStart(2, "0"), b = String(n % 100).padStart(3, "0");
      const cells = [...g, "組", ...b, "番"];
      const box = document.createElement("div");
      box.className = "yls-reel " + (cls || "");
      box.innerHTML = cells.map((c) => (c === "組" || c === "番") ? `<span class="yls-u">${c}</span>` : `<span class="yls-d" data-v="${c}">${rm ? c : Math.floor(Math.random() * 10)}</span>`).join("");
      const ds = [...box.querySelectorAll(".yls-d")];
      const spin = () => ds.forEach((d) => { if (!d.classList.contains("lock") && !d.classList.contains("miss")) d.textContent = Math.floor(Math.random() * 10); });
      box._rate = (ms) => { if (rm) return; if (box._iv) { clearInterval(box._iv); ints.delete(box._iv); } box._iv = setInterval(spin, ms); ints.add(box._iv); };
      box._rate(55);
      box._ds = ds;
      return box;
    };
    /* 1桁ずつ止める。gaps＝止まるまでの待ち（配列なら桁ごと）。fake＝最後の1桁は、ゆっくり回って、惜しい番号で止まってから、本当の番号に決まる（じらし） */
    const lockReel = async (box, gaps, pitch, fake) => {
      const n = box._ds.length;
      for (let i = 0; i < n; i++) {
        const last = i === n - 1;
        if (last && fake && !rm) box._rate(150); // スローモーション
        await sleep(Array.isArray(gaps) ? (gaps[i] ?? gaps[gaps.length - 1]) : gaps);
        const d = box._ds[i];
        if (last && fake && !skipped && !rm) {
          const v = Number(d.dataset.v), wrong = (v + 1 + Math.floor(Math.random() * 8)) % 10;
          d.textContent = String(wrong); d.classList.add("miss");
          tone([185, 0.35], 0.07, "sawtooth"); tone([147, 0.45], 0.07, "sawtooth", 0.2 / speed);
          await sleep(1000);
          d.classList.remove("miss"); // 「あれっ？」また回り出す
          tone([330, 0.12], 0.05, "triangle");
          await sleep(1000);
        }
        d.textContent = d.dataset.v; d.classList.add("lock");
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
      drum(3200, 90, 160); heartbeat(3200);
      await sleep(3300);
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
        await sleep(1100);
      }
      await sleep(700);
    };

    const revealTier = async (name, title, gap, fakeLast) => {
      clearBody();
      const t = tierOf(name);
      const items = numbersOf(name);
      const compact = items.length > 4; // 本数が多い等級（3等10本など）は、2列にならべて、短めに決める
      const box = show(`<div class="yls-tier">${title || esc(name)}<small>${fmt(t.prize)} コイン${items.length > 1 ? ` × ${items.length}本` : ""}</small></div><div class="yls-reels${compact ? " compact" : ""}"></div>`);
      const wrap = box.querySelector(".yls-reels");
      const reels = items.map((it) => { const r = makeReel(it.number, compact ? "sm" : ""); const cell = document.createElement("div"); cell.className = "yls-cell"; cell.appendChild(r); wrap.appendChild(cell); return { r, cell, it }; });
      const gaps = compact ? [70, 70, 90, 110, 160] : [gap, gap, Math.round(gap * 1.2), Math.round(gap * 1.8), Math.round(gap * 2.8)]; // だんだん遅く：最後の1桁がいちばん長い
      drum(700 + reels.length * gaps.reduce((a, b) => a + b, 0), 100, 200);
      for (let k = 0; k < reels.length; k++) {
        const x = reels[k];
        if (skipped) return;
        await lockReel(x.r, gaps, 520, !!fakeLast && k === reels.length - 1);
        x.cell.insertAdjacentHTML("beforeend", whoHtml(x.it));
        tone([880, 0.2], 0.06, "triangle");
        await sleep(compact ? 120 : 450);
      }
      await sleep(900);
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
      await sleep(600);
      heartbeat(6400); drum(6400, 70, 300);
      await sleep(2600);
      mask.classList.add("tense");
      await lockReel(reel, [800, 900, 1100, 1500, 1700], 600, true); // 1桁ずつ、だんだん遅く。最後は惜しい番号で止まってから…
      if (skipped) return;
      // 全部止まった！
      mask.classList.remove("tense"); mask.classList.add("boom", "gold", "shake");
      lights.classList.add("fast", "mega");
      flash(); confetti(130); fireworks(5); coinRain(26); fanfare(true);
      cutin("👑 1等 当選番号！", 2800);
      setTimeout(() => mask.classList.remove("shake"), 1000 / speed);
      await sleep(3000);
      if (skipped) return;
      if (!it.name) { cell.insertAdjacentHTML("beforeend", whoHtml(it)); await sleep(2200); mask.classList.remove("boom", "gold"); return; }
      // 当選者は…（ためる）
      cell.insertAdjacentHTML("beforeend", `<div class="yls-who suspense">当選者は… <span class="yls-dots"><i>●</i><i>●</i><i>●</i></span></div>`);
      drum(2600, 120, 340); heartbeat(2600);
      await sleep(2800);
      if (skipped) return;
      cell.querySelector(".yls-who.suspense")?.remove();
      mask.classList.add("shake");
      cell.insertAdjacentHTML("beforeend", `<div class="yls-winner"><span class="crown">👑</span><span class="nm">${esc(it.name)} さん</span><span class="sub">おめでとう！</span></div>`);
      flash(); confetti(170); fireworks(8); coinRain(38); fanfare(true);
      cutin(`🎉 ${esc(it.name)} さん 1等 おめでとう！ 🎉`, 3200);
      setTimeout(() => mask.classList.remove("shake"), 1000 / speed);
      await sleep(5600);
      mask.classList.remove("boom", "gold");
    };

    const adjacent = async () => {
      if (!numbersOf("前後賞").length) return;
      await tease("おっと… 🎀 前後賞も発表！", 1600);
      await revealTier("前後賞", "🎀 前後賞", 300);
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
        const box = show(`<div class="yls-tier">${mega ? `<span class="yls-megatitle">👑 1等 おめでとう！ 👑</span>` : "🎉 あなたの結果"}</div>
          <div class="yls-mywins">${wins.map((w) => `<div class="yls-mywin${w.tier === "1等" ? " top" : ""}"><b>${esc(w.tier)}</b><span>${fmtNo(w.number)}</span><em>+${fmt(w.amount)}</em></div>`).join("")}</div>
          <div class="yls-total">合計 <span id="ylsTotal">0</span> <small>コイン</small></div><div class="yls-hint">賞金はもう あなたのコインに入っています。</div>`, "pop");
        flash(); confetti(mega ? 160 : 70);
        if (mega) { mask.classList.add("gold", "boom"); lights.classList.add("fast"); fireworks(10); coinRain(40); fanfare(true); }
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
        if (!skipped) await tease("つづいては… 🥉 3等！", 2200);
        if (!skipped) await revealTier("3等", "🥉 3等", 260);
        if (!skipped) await tease("まだまだ… 🥈 2等！", 2600);
        if (!skipped) await revealTier("2等", "🥈 2等", 380, true);
        if (!skipped) await tease("いよいよ…<br>👑 1等の発表です！", 3600);
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
  .yls-ribbon { position: absolute; top: 10px; left: 50%; transform: translateX(-50%); z-index: 9; background: rgba(255,255,255,.92); color: #6a3a00; font-size: 12px; font-weight: 800; padding: 4px 12px; border-radius: 999px; white-space: nowrap; }
  .yls-tease { font-size: 30px; font-weight: 900; line-height: 1.5; text-shadow: 0 0 16px #ff2d78, 0 0 6px #fff; animation: yls-throb .64s ease-in-out infinite; }
  @keyframes yls-throb { 0%,100% { transform: scale(1); } 50% { transform: scale(1.07); } }
  .yls-d.miss { color: #ff4d4d; text-shadow: 0 0 12px #ff0000; animation: yls-shake .12s linear 6; }
  .yls-reels.compact { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 10px; justify-items: center; }
  .yls-reel.sm { padding: 4px 8px; gap: 1px; border-width: 1px; } .yls-reel.sm .yls-d { font-size: 19px; min-width: 14px; } .yls-reel.sm .yls-u { font-size: 11px; margin: 0 2px; }
  .yls-reels.compact .yls-who { font-size: 12px; } .yls-reels.compact .yls-cell { gap: 1px; }
  .yls-mask.gold .yls-burst { background: repeating-conic-gradient(from 0deg, #ffd700 0 10deg, #fff6a8 10deg 20deg, #ff9900 20deg 30deg, #fff 30deg 36deg); }
  .yls-mask.gold .yls-bg { background: radial-gradient(ellipse at 50% 40%, #8a5a00 0%, #3a2200 55%, #140b00 100%); }
  .yls-mask.shake .yls-stage { animation: yls-shake .1s linear infinite; }
  @keyframes yls-shake { 0% { transform: translate(0,0); } 25% { transform: translate(-5px,3px); } 50% { transform: translate(4px,-4px); } 75% { transform: translate(-3px,-2px); } 100% { transform: translate(0,0); } }
  .yls-who.suspense { font-size: 22px; color: #ffe14a; text-shadow: 0 0 12px #ff8a00; }
  .yls-dots i { font-style: normal; display: inline-block; margin: 0 2px; animation: yls-dot .9s ease-in-out infinite; } .yls-dots i:nth-child(2) { animation-delay: .2s; } .yls-dots i:nth-child(3) { animation-delay: .4s; }
  @keyframes yls-dot { 0%,100% { opacity: .15; transform: translateY(0); } 50% { opacity: 1; transform: translateY(-6px); } }
  .yls-winner { display: flex; flex-direction: column; align-items: center; margin-top: 6px; animation: yls-pop .8s cubic-bezier(.2,1.5,.4,1); }
  .yls-winner .crown { font-size: 54px; line-height: 1; animation: yls-bob .9s ease-in-out infinite; filter: drop-shadow(0 0 14px #ffd700); }
  .yls-winner .nm { max-width: 92vw; font-size: 36px; font-weight: 900; word-break: break-all; line-height: 1.25; background: linear-gradient(90deg,#fff6a8,#ffd700,#fff,#ffb300,#fff6a8); background-size: 300% 100%; -webkit-background-clip: text; background-clip: text; color: transparent; -webkit-text-fill-color: transparent; animation: yls-shim 2s linear infinite; filter: drop-shadow(0 0 10px #ffb300); }
  .yls-winner .sub { margin-top: 4px; font-size: 16px; font-weight: 800; letter-spacing: .3em; color: #ffe14a; }
  @keyframes yls-bob { 0%,100% { transform: translateY(0) rotate(-6deg); } 50% { transform: translateY(-10px) rotate(6deg); } }
  @keyframes yls-shim { from { background-position: 0% 0; } to { background-position: 300% 0; } }
  .yls-megatitle { background: linear-gradient(90deg,#fff6a8,#ffd700,#fff,#ffb300,#fff6a8); background-size: 300% 100%; -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; color: transparent; animation: yls-shim 2s linear infinite; filter: drop-shadow(0 0 10px #ffb300); }
  .yls-spark { position: absolute; z-index: 6; width: 7px; height: 7px; margin: -3px 0 0 -3px; border-radius: 50%; pointer-events: none; box-shadow: 0 0 8px 2px currentColor; animation: yls-spark 1.3s ease-out forwards; }
  @keyframes yls-spark { 0% { transform: translate(0,0) scale(1); opacity: 1; } 100% { transform: translate(var(--dx), calc(var(--dy) + 40px)) scale(.2); opacity: 0; } }
  .yls-coin { position: absolute; top: -40px; z-index: 5; pointer-events: none; animation: yls-fall 3.6s linear forwards; }
  @media (prefers-reduced-motion: reduce) { .yls-ring, .yls-burst, .yls-bulb, .yls-step.pop, .yls-row.in, .yls-confetti, .yls-d.lock, .yls-cutin, .yls-tease, .yls-winner, .yls-winner .crown, .yls-winner .nm, .yls-megatitle, .yls-mask.shake .yls-stage, .yls-dots i, .yls-spark, .yls-coin { animation: none; } .yls-cutin { transform: skewY(-4deg); } }
  `;
  const style = document.createElement("style");
  style.id = "yulotteryshow-styles";
  style.textContent = css;
  document.head.appendChild(style);
}
