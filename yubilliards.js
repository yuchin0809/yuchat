/* 🎱 ゆうワールド「ビリヤード」の画面（いまは「1人で練習」だけ。コインは使わない）
   ・15個の球をできるだけ少ない打数ですべてポケットに落とす。手球が落ちたら反則（打数とは別に数える）
   ・打ち方：画面を、手球から引っぱって離す（引く向きの反対へ飛ぶ。引く長さが強さ）
   ・球の動きは yubilliards-core.js（決まった計算）。通信はしない
   ・ベストの記録は、この端末だけに残す */
import { TABLE, POCKETS, BALL_COLORS, newGame, shoot, step, isRest, settle, remaining, isCleared, cueBall, aimLine } from "./yubilliards-core.js?v=20261111-bl1";

const MARGIN = 40;                 // 台の木の縁（台の単位）
const BEST_KEY = "yuBilliardsBest";
let raf = 0, cleanup = null;

export function stopBilliards() {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  if (cleanup) { cleanup(); cleanup = null; }
}

function readBest() { try { const n = Number(localStorage.getItem(BEST_KEY)); return Number.isFinite(n) && n > 0 ? n : null; } catch (_) { return null; } }
function writeBest(n) { try { localStorage.setItem(BEST_KEY, String(n)); } catch (_) { /* 保存できなくても遊べる */ } }

const STYLE = `
.bl-wrap{max-width:860px;margin:0 auto;padding:12px 12px calc(20px + env(safe-area-inset-bottom,0px));display:flex;flex-direction:column;gap:10px;color:#1d2433}
.bl-top{display:flex;align-items:center;gap:10px}
.bl-top h2{margin:0;font-size:19px;flex:1}
.bl-btn{min-height:44px;padding:0 16px;border:1px solid #d6dbe6;border-radius:12px;background:#fff;font-size:14px;font-weight:700;color:#1d2433}
.bl-btn.pri{background:#2f6bff;border-color:#2f6bff;color:#fff}
.bl-note{margin:0;padding:8px 12px;border-radius:10px;background:#fff6d6;color:#6b5200;font-size:12.5px}
.bl-hud{display:flex;gap:8px;flex-wrap:wrap}
.bl-hud div{flex:1;min-width:84px;background:#fff;border:1px solid #e7e9ed;border-radius:12px;padding:8px 10px;text-align:center}
.bl-hud span{display:block;font-size:11px;color:#667089}
.bl-hud b{font-size:20px}
.bl-stage{position:relative;touch-action:none;user-select:none;-webkit-user-select:none}
.bl-stage canvas{width:100%;height:auto;display:block;border-radius:14px;touch-action:none}
.bl-power{height:10px;border-radius:5px;background:#e7e9ed;overflow:hidden}
.bl-power i{display:block;height:100%;width:0;background:linear-gradient(90deg,#4cc38a,#f5c400,#e5484d)}
.bl-help{margin:0;font-size:12.5px;color:#667089;line-height:1.7}
.bl-clear{position:absolute;inset:0;display:none;align-items:center;justify-content:center;background:rgba(10,20,40,.55);border-radius:14px}
.bl-clear.on{display:flex}
.bl-clear div{background:#fff;border-radius:18px;padding:22px 26px;text-align:center;display:flex;flex-direction:column;gap:10px;max-width:80%}
.bl-clear b{font-size:22px}
`;
let styled = false;
function ensureStyle() {
  if (styled || typeof document === "undefined") return;
  styled = true;
  const el = document.createElement("style");
  el.textContent = STYLE;
  document.head.appendChild(el);
}

/* root：描き込む先の要素。esc：文字の安全化。onBack：もどる。adminNote：管理者だけに見せている間の説明（なければ出さない） */
export function renderBilliards({ root, esc = (s) => String(s), onBack, adminNote = "" }) {
  stopBilliards();
  ensureStyle();
  root.innerHTML = `<div class="bl-wrap">
    <div class="bl-top"><button type="button" class="bl-btn" id="blBack">‹ もどる</button><h2>🎱 ビリヤード（1人で練習）</h2><button type="button" class="bl-btn" id="blReset">やり直す</button></div>
    ${adminNote ? `<p class="bl-note">${esc(adminNote)}</p>` : ""}
    <div class="bl-hud"><div><span>残りの球</span><b id="blLeft">15</b></div><div><span>打った回数</span><b id="blShots">0</b></div><div><span>反則</span><b id="blFouls">0</b></div><div><span>ベスト</span><b id="blBest">－</b></div></div>
    <div class="bl-stage" id="blStage"><canvas id="blCanvas" aria-label="ビリヤード台"></canvas>
      <div class="bl-clear" id="blClear"><div><b>クリア！</b><span id="blClearText"></span><button type="button" class="bl-btn pri" id="blAgain">もう一度</button></div></div></div>
    <div class="bl-power" aria-hidden="true"><i id="blPower"></i></div>
    <p class="bl-help">白い球から、指を引っぱって離すと打てます（引いた向きの反対へ飛びます。引く長さが強さ）。15個すべてをポケットに落とそう。白い球が落ちると反則です。</p>
  </div>`;
  const $ = (id) => root.querySelector(id);
  const canvas = $("#blCanvas"), ctx = canvas.getContext("2d");
  const totalW = TABLE.w + MARGIN * 2, totalH = TABLE.h + MARGIN * 2;
  let game = newGame();
  let aim = null;                         // { angle, power } 引っぱっている間だけ
  let moving = false, cleared = false;
  let scale = 1;

  function resize() {
    const cssW = Math.min(canvas.parentElement.clientWidth || 640, 860);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssW * dpr * totalH / totalW);
    scale = canvas.width / totalW;
    draw();
  }

  function hud() {
    $("#blLeft").textContent = remaining(game);
    $("#blShots").textContent = game.shots;
    $("#blFouls").textContent = game.fouls;
    const best = readBest();
    $("#blBest").textContent = best ? `${best}打` : "－";
  }

  function ballPath(b, rr) { ctx.beginPath(); ctx.arc((b.x + MARGIN) * scale, (b.y + MARGIN) * scale, rr * scale, 0, Math.PI * 2); }

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // 木の縁と、緑のフェルト
    ctx.fillStyle = "#6b3f1d"; ctx.beginPath(); ctx.roundRect(0, 0, canvas.width, canvas.height, 26 * scale); ctx.fill();
    ctx.fillStyle = "#1f7a4d"; ctx.fillRect(MARGIN * scale, MARGIN * scale, TABLE.w * scale, TABLE.h * scale);
    ctx.strokeStyle = "rgba(255,255,255,.18)"; ctx.lineWidth = 2 * scale;
    ctx.beginPath(); ctx.moveTo((MARGIN + 250) * scale, MARGIN * scale); ctx.lineTo((MARGIN + 250) * scale, (MARGIN + TABLE.h) * scale); ctx.stroke();
    // ポケット
    ctx.fillStyle = "#0b0f14";
    for (const [px, py] of POCKETS) { ctx.beginPath(); ctx.arc((px + MARGIN) * scale, (py + MARGIN) * scale, 25 * scale, 0, Math.PI * 2); ctx.fill(); }
    // 狙いの線と、キュー
    const cue = cueBall(game);
    if (aim && cue.on) {
      const line = aimLine(game, aim.angle);
      ctx.setLineDash([8 * scale, 7 * scale]); ctx.strokeStyle = "rgba(255,255,255,.85)"; ctx.lineWidth = 2 * scale;
      ctx.beginPath(); ctx.moveTo((line.x1 + MARGIN) * scale, (line.y1 + MARGIN) * scale); ctx.lineTo((line.x2 + MARGIN) * scale, (line.y2 + MARGIN) * scale); ctx.stroke(); ctx.setLineDash([]);
      const back = 16 + aim.power * 120;
      const cx = cue.x - Math.cos(aim.angle) * back, cy = cue.y - Math.sin(aim.angle) * back;
      ctx.strokeStyle = "#e8c88a"; ctx.lineWidth = 7 * scale; ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo((cx + MARGIN) * scale, (cy + MARGIN) * scale); ctx.lineTo((cx - Math.cos(aim.angle) * 260 + MARGIN) * scale, (cy - Math.sin(aim.angle) * 260 + MARGIN) * scale); ctx.stroke();
    }
    // 球
    for (const b of game.balls) {
      if (!b.on) continue;
      ballPath(b, TABLE.r); ctx.fillStyle = BALL_COLORS[b.id]; ctx.fill();
      if (b.id > 8) { ctx.save(); ballPath(b, TABLE.r); ctx.clip(); ctx.fillStyle = "#fff"; ctx.fillRect((b.x + MARGIN - TABLE.r) * scale, (b.y + MARGIN - 5) * scale, TABLE.r * 2 * scale, 10 * scale); ctx.restore(); }
      if (b.id > 0) { ctx.fillStyle = b.id > 8 ? "#1d2433" : "#fff"; ctx.font = `700 ${11 * scale}px sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(String(b.id), (b.x + MARGIN) * scale, (b.y + MARGIN + 0.5) * scale); }
      ballPath(b, TABLE.r); ctx.strokeStyle = "rgba(0,0,0,.35)"; ctx.lineWidth = 1 * scale; ctx.stroke();
      ctx.beginPath(); ctx.arc((b.x + MARGIN - 4) * scale, (b.y + MARGIN - 4.5) * scale, 3 * scale, 0, Math.PI * 2); ctx.fillStyle = "rgba(255,255,255,.55)"; ctx.fill();
    }
  }

  function toTable(ev) {
    const rect = canvas.getBoundingClientRect();
    return { x: (ev.clientX - rect.left) / rect.width * totalW - MARGIN, y: (ev.clientY - rect.top) / rect.height * totalH - MARGIN };
  }

  function onDown(ev) {
    if (moving || cleared || !cueBall(game).on) return;
    canvas.setPointerCapture?.(ev.pointerId);
    onMove(ev);
  }
  function onMove(ev) {
    if (moving || cleared || (ev.buttons === 0 && ev.pointerType === "mouse" && !aim)) return;
    const p = toTable(ev), cue = cueBall(game);
    const dx = cue.x - p.x, dy = cue.y - p.y, dist = Math.hypot(dx, dy);
    if (dist < 2) return;
    aim = { angle: Math.atan2(dy, dx), power: Math.min(1, dist / 220) };
    $("#blPower").style.width = `${Math.round(aim.power * 100)}%`;
    draw();
  }
  function onUp() {
    if (!aim) return;
    const a = aim; aim = null;
    $("#blPower").style.width = "0";
    if (a.power >= 0.04 && shoot(game, a.angle, a.power)) { moving = true; hud(); loop(); } else draw();
  }

  function loop() {
    for (let i = 0; i < 3; i++) step(game);
    draw();
    if (!isRest(game)) { raf = requestAnimationFrame(loop); return; }
    raf = 0; moving = false;
    settle(game);
    hud();
    if (isCleared(game)) finish();
    draw();
  }

  function finish() {
    cleared = true;
    const total = game.shots;
    const best = readBest();
    const isBest = !best || total < best;
    if (isBest) writeBest(total);
    $("#blClearText").textContent = `${total}打でクリア（反則 ${game.fouls}回）${isBest ? " ベスト更新！" : ""}`;
    $("#blClear").classList.add("on");
    hud();
  }

  function reset() { game = newGame(); aim = null; moving = false; cleared = false; if (raf) cancelAnimationFrame(raf); raf = 0; $("#blClear").classList.remove("on"); hud(); draw(); }

  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", () => { aim = null; draw(); });
  $("#blBack").addEventListener("click", () => { stopBilliards(); if (onBack) onBack(); });
  $("#blReset").addEventListener("click", reset);
  $("#blAgain").addEventListener("click", reset);
  window.addEventListener("resize", resize);
  cleanup = () => window.removeEventListener("resize", resize);
  hud(); resize();
}
