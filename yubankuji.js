/* =========================================================
   🎊 ゆう番くじ（yuworld.js から呼ばれる）

   ・いまは「発売前のお知らせ」の画面だけ。くじの買い方・本数・値段は、発売日に発表する（まだ決めていない）。
   ・見せるのは、ちょっとだけの中身（A賞・B賞・ラストワン賞のヒント）。C賞以下は「ひみつ」のまま。
   ・サーバー（Worker）にも Firestore にも触れない。発売日までのカウントダウンは端末の時計で計算する。
   ・発売日：2026-10-26（月）8:00 JST（宝くじと同じ時刻）。
========================================================= */

export const BANKUJI_SALE_MS = new Date("2026-10-26T08:00:00+09:00").getTime();

let ctx = null, timer = null, stylesDone = false;

export function stopBankuji() {
  if (timer) { clearInterval(timer); timer = null; }
  ctx = null;
}

const pad = (n) => String(n).padStart(2, "0");
/* 発売までの残り時間の表示。発売時刻を過ぎたら null */
export function bankujiRemain(nowMs) {
  const ms = BANKUJI_SALE_MS - nowMs;
  if (ms <= 0) return null;
  const s = Math.floor(ms / 1000);
  return { days: Math.floor(s / 86400), hh: pad(Math.floor((s % 86400) / 3600)), mm: pad(Math.floor((s % 3600) / 60)), ss: pad(s % 60) };
}

export function renderBankuji(c) {
  stopBankuji();
  ctx = c;
  injectStyles();
  draw();
  timer = setInterval(tick, 1000);
}

function draw() {
  ctx.root.innerHTML = `<div class="yb-head"><button type="button" class="yw-back" id="ybBack">← ゆうくじ売り場</button><h2>🎊 ゆう番くじ</h2></div>
    <div class="yb-hero">
      <div class="yb-new">NEW</div>
      <div class="yb-title">ゆう番くじ<br>まもなく初登場！</div>
      <div class="yb-sale">発売：10月26日（月）8:00</div>
      <div class="yb-count" id="ybCount"></div>
      <div class="yb-lead">初回は、とくべつ豪華！<br>ひとあし先に、ちょっとだけ中身をおしえちゃいます👀</div>
    </div>
    <div class="yb-card"><h3>🎁 こんな賞があるよ（いまわかっているのは、ここまで）</h3>
      <div class="yb-prize yb-a"><b>A賞</b><span><em>✨ 自分の会社をもてる権利…！？</em><small>会社の名前をつけて、自分で会社を育てられる…らしい</small></span></div>
      <div class="yb-prize yb-b"><b>B賞</b><span><em>📈 ゆう株がもらえる</em><small>ゆう経済の株が、まとめて手に入る！</small></span></div>
      <div class="yb-prize yb-last"><b>ラストワン賞</b><span><em>👑 とてつもなく豪華なセット</em><small>最後の1枚を引いた人だけがもらえる、特別な賞</small></span></div>
      <div class="yb-prize yb-secret"><b>C賞〜</b><span><em>🔒 ひみつ…</em><small>当たってからのお楽しみ。ほかにもいろいろ入っています</small></span></div>
    </div>
    <div class="yb-card yb-note"><h3>📣 くわしいことは発売日に発表！</h3>
      <p>くじの引きかた・本数・値段は、発売日（月曜 8:00）にここで発表します。宝くじ売り場の宝くじと同じ時刻に発売の予定です。</p>
      <p class="yb-small">※中身は変わることがあります。</p></div>`;
  ctx.root.querySelector("#ybBack")?.addEventListener("click", () => { const back = ctx && ctx.onBack; stopBankuji(); if (back) back(); });
  tick();
}

function tick() {
  const el = ctx && ctx.root.querySelector("#ybCount");
  if (!el) return;
  const r = bankujiRemain(typeof ctx.now === "function" ? ctx.now() : Date.now());
  el.innerHTML = r
    ? `<small>発売まで</small><span>${r.days > 0 ? `${r.days}<i>日</i> ` : ""}${r.hh}<i>:</i>${r.mm}<i>:</i>${r.ss}</span>`
    : `<span class="yb-soon">🎉 まもなく発売！</span>`;
}

function injectStyles() {
  if (stylesDone && document.getElementById("yubankuji-styles")) return;
  stylesDone = true;
  const css = `
  .yb-head { margin-bottom: 8px; } .yb-head h2 { margin: 4px 0 0; font-size: 20px; }
  .yb-hero { position: relative; overflow: hidden; text-align: center; color: #fff; border-radius: 18px; padding: 22px 14px 20px; margin: 10px 0 14px;
    background: linear-gradient(135deg, #7b2ff7, #ff2d78 55%, #ff8a00); box-shadow: 0 8px 26px rgba(123,47,247,.35); }
  .yb-hero::before { content: ""; position: absolute; left: 50%; top: 50%; width: 200%; aspect-ratio: 1; margin: -100% 0 0 -100%; opacity: .16; pointer-events: none;
    background: repeating-conic-gradient(from 0deg, #fff 0 8deg, transparent 8deg 24deg); animation: yb-spin 24s linear infinite; }
  @keyframes yb-spin { to { transform: rotate(360deg); } }
  .yb-hero > * { position: relative; }
  .yb-new { display: inline-block; background: #ffe14a; color: #7a3a00; font-weight: 900; font-size: 12px; letter-spacing: .1em; padding: 3px 12px; border-radius: 999px; animation: yb-pulse 1.4s ease-in-out infinite; }
  @keyframes yb-pulse { 0%,100% { transform: scale(1); } 50% { transform: scale(1.12); } }
  .yb-title { font-size: 30px; font-weight: 900; line-height: 1.3; margin: 10px 0 6px; text-shadow: 0 2px 10px rgba(0,0,0,.35), 0 0 16px rgba(255,225,74,.8); }
  .yb-sale { font-size: 15px; font-weight: 800; }
  .yb-count { margin: 12px auto 10px; display: inline-block; background: rgba(0,0,0,.3); border-radius: 14px; padding: 8px 18px; min-width: 200px; }
  .yb-count small { display: block; font-size: 12px; opacity: .9; }
  .yb-count span { font-size: 30px; font-weight: 900; font-variant-numeric: tabular-nums; color: #ffe14a; text-shadow: 0 0 12px rgba(255,225,74,.8); }
  .yb-count i { font-style: normal; font-size: 16px; margin: 0 2px; }
  .yb-count .yb-soon { font-size: 22px; }
  .yb-lead { font-size: 13.5px; line-height: 1.8; }
  .yb-card { background: #fff; border-radius: 16px; padding: 14px 14px 12px; margin: 12px 0; box-shadow: 0 4px 16px rgba(0,0,0,.07); }
  .yb-card h3 { margin: 0 0 10px; font-size: 15px; }
  .yb-prize { display: grid; grid-template-columns: 78px 1fr; gap: 10px; align-items: center; padding: 10px; border-radius: 12px; margin-bottom: 8px; border: 1px solid #eee; }
  .yb-prize b { text-align: center; font-size: 15px; font-weight: 900; padding: 8px 4px; border-radius: 10px; color: #fff; background: #7b2ff7; }
  .yb-prize em { display: block; font-style: normal; font-weight: 800; font-size: 14.5px; } .yb-prize small { display: block; color: #666; font-size: 12px; line-height: 1.6; margin-top: 2px; }
  .yb-a { background: linear-gradient(90deg, #fff7d6, #fff); border-color: #ffd24a; } .yb-a b { background: linear-gradient(135deg, #ffb300, #ff6a00); }
  .yb-b b { background: linear-gradient(135deg, #17b6ff, #4a6bff); }
  .yb-last { background: linear-gradient(90deg, #ffe9f2, #fff); border-color: #ff9bbd; } .yb-last b { background: linear-gradient(135deg, #ff2d78, #b14cff); font-size: 12.5px; }
  .yb-secret { background: #f5f4fa; } .yb-secret b { background: #8c86a8; } .yb-secret em { color: #5b5675; }
  .yb-note p { margin: 0 0 6px; font-size: 13px; line-height: 1.8; color: #444; } .yb-note .yb-small { font-size: 11.5px; color: #888; }
  @media (prefers-reduced-motion: reduce) { .yb-hero::before, .yb-new { animation: none; } }
  `;
  const style = document.createElement("style");
  style.id = "yubankuji-styles";
  style.textContent = css;
  document.head.appendChild(style);
}
