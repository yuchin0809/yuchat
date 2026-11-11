/* 🎱 ゆうワールド「ビリヤード」の画面。コインは使わない
   ・「CPUと対戦」：本物の8ボールのルール（グループ・反則・手球を置く・8番で勝ち負け）。「1人で練習」：15個を少ない打数で全部落とす
   ・打ち方：白い球から、指を引っぱって離す（引いた向きの反対へ飛ぶ。長く引くほど強い）。押し・引きも選べる
   ・球の動きは yubilliards-core.js（決まった計算）。CPUは yubilliards-ai.js。通信はしない
   ・ベストの記録（練習）は、この端末だけに残す */
import { TABLE, POCKETS, POCKET_R, BALL_COLORS, HEAD_SPOT, FOOT_SPOT, groupLeft, lowestBall, groupOf, restore, newGame, shoot, step, isRest, settle, endShot, remaining, isCleared, cueBall, aimLine, canPlace, placeCue } from "./yubilliards-core.js?v=20261111-bl5";
import { chooseShot, choosePlacement, bestShot } from "./yubilliards-ai.js?v=20261111-bl5";

const M = 40;                          // 台の木の縁の幅（台の単位）
const BEST_KEY = "yuBilliardsBest";
const REC_KEY = "yuBilliardsRec";
const LEVELS = { easy: 3.5, normal: 1.2, hard: 0.25 };
const LEVEL_NAME = { easy: "かんたん", normal: "ふつう", hard: "つよい" };
const MODE_NAME = { eight: "8ボール", nine: "9ボール" };
const DT = 1 / 60;                     // 球の動きは、1/60秒ごとの刻みで進める（画面の速さによらず、同じ速さ）
const W = TABLE.w + M * 2, H = TABLE.h + M * 2;
let raf = 0, cleanup = null;

export function stopBilliards() {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  if (cleanup) { cleanup(); cleanup = null; }
}

function readRec() { try { return JSON.parse(localStorage.getItem(REC_KEY)) || {}; } catch (_) { return {}; } }
function addRec(key, win) { try { const r = readRec(); const v = r[key] || [0, 0]; v[win ? 0 : 1] += 1; r[key] = v; localStorage.setItem(REC_KEY, JSON.stringify(r)); } catch (_) { /* 保存できなくても遊べる */ } }
function readBest() { try { const n = Number(localStorage.getItem(BEST_KEY)); return Number.isFinite(n) && n > 0 ? n : null; } catch (_) { return null; } }
function writeBest(n) { try { localStorage.setItem(BEST_KEY, String(n)); } catch (_) { /* 保存できなくても遊べる */ } }

const STYLE = `
html.bl-lock,body.bl-lock{overflow:hidden!important;overscroll-behavior:none;height:100%}
.bl-wrap{max-width:1000px;margin:0 auto;padding:6px 10px calc(8px + env(safe-area-inset-bottom,0px));display:flex;flex-direction:column;gap:6px;max-height:calc(100dvh - 8px);overflow-y:auto;overscroll-behavior:contain;color:#1d2433;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}
.bl-top{display:flex;align-items:center;gap:8px}
.bl-top .bl-btn{min-height:38px;padding:0 11px}
.bl-btn{min-height:40px;padding:0 13px;border:1px solid #d6dbe6;border-radius:12px;background:#fff;font-size:13.5px;font-weight:700;color:#1d2433}
.bl-btn.on{background:#1d2433;border-color:#1d2433;color:#fff}
.bl-btn.pri{background:#2f6bff;border-color:#2f6bff;color:#fff}
.bl-note{margin:0;padding:6px 10px;border-radius:10px;background:#fff6d6;color:#6b5200;font-size:12px}
.bl-modes{display:flex;gap:6px;flex:1;min-width:0}
.bl-modes .bl-btn{flex:1}
.bl-hud{display:flex;gap:6px}
.bl-hud>div{flex:1;min-width:0;background:#fff;border:2px solid #e7e9ed;border-radius:12px;padding:3px 8px;text-align:center}
.bl-hud>div.turn{border-color:#2f6bff;background:#eef3ff}
.bl-hud span{display:block;font-size:11px;color:#667089;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bl-hud b{font-size:18px}
.bl-msg{margin:0;min-height:18px;text-align:center;font-size:13.5px;font-weight:700;color:#1d2433}
.bl-msg.foul{color:#d9423a}
.bl-stage{position:relative;touch-action:none;display:flex;justify-content:center}
.bl-stage canvas{display:block;border-radius:14px;touch-action:none;box-shadow:0 6px 18px rgba(0,0,0,.25)}
.bl-power{height:10px;border-radius:5px;background:#e7e9ed;overflow:hidden}
.bl-power i{display:block;height:100%;width:0;background:linear-gradient(90deg,#4cc38a,#f5c400,#e5484d)}
.bl-spin{display:flex;gap:6px;align-items:center;font-size:12px;color:#667089}
.bl-spin .bl-btn{min-height:34px;padding:0 10px;font-size:12.5px}
.bl-over{position:absolute;inset:0;display:none;align-items:center;justify-content:center;background:rgba(10,20,40,.55);border-radius:14px}
.bl-over.on{display:flex}
.bl-over div{background:#fff;border-radius:18px;padding:20px 24px;text-align:center;display:flex;flex-direction:column;gap:10px;max-width:80%}
.bl-over b{font-size:22px}
.bl-lv{display:flex;gap:6px;align-items:center;font-size:12px;color:#667089}
.bl-lv .bl-btn{min-height:32px;padding:0 10px;font-size:12.5px}
.bl-tray{display:flex;gap:4px;align-items:center;flex-wrap:wrap}.bl-tray:empty{display:none}
.bl-tray i{width:22px;height:22px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:10px;font-style:normal;font-weight:700;color:#fff;border:1px solid rgba(0,0,0,.35);box-shadow:inset -2px -2px 3px rgba(0,0,0,.3)}
.bl-ctl{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.bl-eng{width:68px;height:68px;border-radius:50%;touch-action:none;flex:none;background:#fff;border:2px solid #1d2433}
.bl-ctl .col{display:flex;flex-direction:column;gap:6px;flex:1;min-width:160px}
.bl-ctl .row{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.bl-ctl .bl-btn{min-height:36px;padding:0 10px;font-size:12.5px}
.bl-ctl input[type=range]{flex:1;min-width:90px}
.bl-ctl small{color:#667089;font-size:11.5px}
.bl-rec{margin:0;text-align:center;font-size:11.5px;color:#667089}
`;
let styled = false;
function ensureStyle() {
  if (styled || typeof document === "undefined") return;
  styled = true;
  const el = document.createElement("style");
  el.textContent = STYLE;
  document.head.appendChild(el);
}

/* ---- 音（小さな「コツッ」。WebAudio。端末が対応していなければ無音） ---- */
let actx = null;
function initAudio() { try { if (!actx) { const C = window.AudioContext || window.webkitAudioContext; if (C) actx = new C(); } if (actx && actx.state === "suspended") actx.resume(); } catch (_) { actx = null; } }
function blip(freq, dur, gain, type = "triangle") {
  if (!actx) return;
  try {
    const t = actx.currentTime, o = actx.createOscillator(), g = actx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t); o.frequency.exponentialRampToValueAtTime(Math.max(40, freq * 0.5), t + dur);
    g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(actx.destination); o.start(t); o.stop(t + dur + 0.02);
  } catch (_) { /* 鳴らせなくても遊べる */ }
}

/* root：描き込む先の要素。esc：文字の安全化。onBack：もどる。adminNote：管理者だけに見せている間の説明 */
export function renderBilliards({ root, esc = (s) => String(s), onBack, adminNote = "", online = null, openRooms = null }) {
  stopBilliards();
  ensureStyle();
  const ON = !!online;                   // ルーム対戦（人と人）。球の動きの結果は Worker が決める
  if (!ON) { document.documentElement.classList.add("bl-lock"); document.body.classList.add("bl-lock"); }   // 引っぱるときに、画面がスクロールしないように固定する
  root.innerHTML = `<div class="bl-wrap" id="blWrap">
    <div class="bl-top">${ON ? `<div class="bl-modes"><b id="blTitle" style="padding:8px 4px">🎱 ビリヤード対戦</b></div><button type="button" class="bl-btn" id="blSound" aria-label="音">🔊</button>` : `<button type="button" class="bl-btn" id="blBack" aria-label="もどる">‹</button><div class="bl-modes"><button type="button" class="bl-btn on" data-mode="eight">8ボール</button><button type="button" class="bl-btn" data-mode="nine">9ボール</button><button type="button" class="bl-btn" data-mode="practice">練習</button></div><button type="button" class="bl-btn" id="blSound" aria-label="音">🔊</button><button type="button" class="bl-btn" id="blReset" aria-label="はじめから">↺</button>`}</div>
    ${adminNote ? `<p class="bl-note">${esc(adminNote)}</p>` : ""}
    <div class="bl-lv" id="blLv"${ON ? ' style="display:none"' : ""}><span>CPU</span><button type="button" class="bl-btn" data-level="easy">かんたん</button><button type="button" class="bl-btn on" data-level="normal">ふつう</button><button type="button" class="bl-btn" data-level="hard">つよい</button></div>
    <div class="bl-hud" id="blHud"></div>
    <div class="bl-tray" id="blTray"></div>
    <p class="bl-msg" id="blMsg"></p>
    <div class="bl-stage" id="blStage"><canvas id="blCanvas" aria-label="ビリヤード台"></canvas><div class="bl-over" id="blStart"><div id="blStartBox"></div></div><div class="bl-over" id="blOver"><div><b id="blOverTitle"></b><span id="blOverText"></span><button type="button" class="bl-btn pri" id="blAgain">もう一度</button></div></div></div>
    <div class="bl-power" aria-hidden="true"><i id="blPower"></i></div>
    <div class="bl-ctl">
      <canvas class="bl-eng" id="blEng" width="152" height="152" aria-label="手球を突く位置（上＝押し、下＝引き、左右＝ひねり）"></canvas>
      <div class="col">
        <div class="row"><button type="button" class="bl-btn on" data-aim="pull">引っぱって打つ</button><button type="button" class="bl-btn" data-aim="tap">タップで狙う</button>${ON ? "" : '<button type="button" class="bl-btn" id="blHint">💡ヒント</button>'}${!ON && openRooms ? '<button type="button" class="bl-btn pri" id="blRoomBtn">👥 友達と対戦</button>' : ""}</div>
        <div class="row" id="blTapRow" style="display:none"><button type="button" class="bl-btn" id="blL">◀</button><button type="button" class="bl-btn" id="blR">▶</button><input type="range" id="blPow" min="8" max="100" value="55" aria-label="強さ"><button type="button" class="bl-btn pri" id="blFire">打つ</button></div>
        <small id="blTip">白い球から指を引っぱって離すと打てます。左の丸で、球を突く位置（押し・引き・ひねり）を選べます</small>
      </div>
    </div>
    <p class="bl-rec" id="blRec"></p>
  </div>`;
  const $ = (id) => root.querySelector(id);
  const canvas = $("#blCanvas"), ctx = canvas.getContext("2d");
  const stage = $("#blStage");
  let mode = "eight", game = newGame("eight");
  let srv = null, offset = 0, playedN = -1, myIdx = -1, pendingY = null, placedAt = null, timerId = 0, timeoutKey = "";
  const seat = () => (ON ? myIdx : 0);
  let phase = "aim";                     // aim（打つ前）／anim（キューを引いて打つ）／moving（球が動いている）／cpu（相手の番）／over
  let aim = null, muted = false, level = "normal", aimMode = "pull";
  let eng = { x: 0, y: 0 };               // 手球を突く位置（−1〜1。上＝押し、下＝引き、右＝右ひねり）
  const drops = [];                       // ポケットに落ちていく球の動き（見た目だけ）
  let layer = null;                       // 台の絵（いちど描いて使いまわす）
  let pulling = false, dragCue = false, anim = null;
  let vertical = false, scale = 1;
  let acc = 0, lastTs = 0;
  const timers = [];
  const roll = new Map();                // 球ごとの回転（見た目だけ）
  const later = (fn, ms) => { const id = setTimeout(() => { const i = timers.indexOf(id); if (i >= 0) timers.splice(i, 1); fn(); }, ms); timers.push(id); };

  /* ---- 大きさ：スマホのたてでは、台をたてにして大きく使う ---- */
  function resize() {
    const wrapEl = $("#blWrap");
    const wrapW = Math.max(240, (canvas.parentElement.clientWidth || 600));
    const wr = wrapEl.getBoundingClientRect(), chrome = wr.height - stage.getBoundingClientRect().height;   // 台の上下にある操作部分の高さ
    const availH = Math.max(200, (window.innerHeight || 700) - Math.max(0, wr.top) - chrome - 10);
    const sL = Math.min(wrapW / W, availH / H), sP = Math.min(wrapW / H, availH / W);
    vertical = sP > sL * 1.02;
    const s = vertical ? sP : sL;
    const cssW = (vertical ? H : W) * s, cssH = (vertical ? W : H) * s;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.style.width = `${cssW}px`; canvas.style.height = `${cssH}px`;
    canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
    scale = canvas.width / (vertical ? H : W);
    layer = document.createElement("canvas"); layer.width = Math.round(W * scale); layer.height = Math.round(H * scale);
    const lc = layer.getContext("2d"); lc.setTransform(scale, 0, 0, scale, 0, 0); drawTable(lc);
    draw();
  }

  /* ---- 画面の座標 ⇔ 台の座標 ---- */
  function toTable(ev) {
    const rect = canvas.getBoundingClientRect();
    const ux = (ev.clientX - rect.left) / rect.width * (vertical ? H : W), uy = (ev.clientY - rect.top) / rect.height * (vertical ? W : H);
    return vertical ? { x: uy - M, y: H - ux - M } : { x: ux - M, y: uy - M };
  }

  /* ---- 表示 ---- */
  function setMsg(t, foul = false) { const el = $("#blMsg"); el.textContent = t; el.classList.toggle("foul", foul); }
  function recText() {
    if (ON) return onlineInfo();
    if (mode === "practice") return "";
    const v = readRec()[`${mode}-${level}`] || [0, 0];
    return `戦績（${MODE_NAME[mode]}・${LEVEL_NAME[level]}）：${v[0]}勝 ${v[1]}敗`;
  }
  function tray() {
    const el = $("#blTray");
    el.innerHTML = mode === "practice" ? "" : game.pocketed.filter((id) => id > 0).map((id) => `<i style="background:${id > 8 ? `linear-gradient(${BALL_COLORS[id]} 0 30%,#fff 30% 70%,${BALL_COLORS[id]} 70%)` : BALL_COLORS[id]};${id > 8 ? "color:#1d2433" : ""}">${id}</i>`).join("");
  }
  const nameOf = (p) => (ON ? (p === myIdx ? "あなた" : esc(srv?.names?.[p] || "相手")) : p === 0 ? "あなた" : "CPU");
  function hud() {
    const el = $("#blHud");
    $("#blRec").textContent = recText();
    tray();
    if (mode === "practice") {
      const best = readBest();
      el.innerHTML = `<div><span>残りの球</span><b>${remaining(game)}</b></div><div><span>打った回数</span><b>${game.shots}</b></div><div><span>反則</span><b>${game.fouls}</b></div><div><span>ベスト</span><b>${best ? best + "打" : "－"}</b></div>`;
      return;
    }
    const turn = (p) => (game.turn === p && !game.over ? "turn" : "");
    if (mode === "nine") {
      const low = lowestBall(game);
      el.innerHTML = `<div class="${turn(0)}"><span>${nameOf(0)}</span><b>${game.turn === 0 ? "打つ番" : "待ち"}</b></div><div class="${turn(1)}"><span>${nameOf(1)}</span><b>${game.turn === 1 ? "打つ番" : "待ち"}</b></div><div><span>次に当てる球</span><b>${low ? low.id + "番" : "－"}</b></div>`;
      return;
    }
    const lab = (g) => (g === "solid" ? "ソリッド（無地）" : g === "stripe" ? "ストライプ（しま）" : "グループ未定");
    const left = (p) => { const g = game.groups[p]; if (!g) return "－"; const n = groupLeft(game, g); return n === 0 ? "8番" : `残り${n}`; };
    el.innerHTML = [0, 1].map((p) => `<div class="${turn(p)}"><span>${nameOf(p)}・${esc(lab(game.groups[p]))}</span><b>${left(p)}</b></div>`).join("");
  }
  function setMode(m) {
    mode = m; root.querySelectorAll("[data-mode]").forEach((b) => b.classList.toggle("on", b.dataset.mode === m));
    reset();
  }
  function reset() {
    timers.splice(0).forEach(clearTimeout);
    game = newGame(mode); aim = null; anim = null; pulling = false; dragCue = false; phase = "aim"; roll.clear(); drops.length = 0;
    if (!ON) $("#blLv").style.display = mode === "practice" ? "none" : "";
    $("#blOver").classList.remove("on"); $("#blPower").style.width = "0";
    setMsg(mode === "practice" ? "15個の球を、少ない打数で全部落とそう" : "あなたのブレイク（最初の一発）です。強く打って、球を散らそう");
    hud(); draw(); setTimeout(resize, 0);
  }

  /* ---- 描く ---- */
  function drawBall(b) {
    const rr = TABLE.r, id = b.id, color = BALL_COLORS[id];
    ctx.save(); ctx.translate(b.x, b.y);
    ctx.fillStyle = "rgba(0,0,0,.28)"; ctx.beginPath(); ctx.ellipse(3, 4, rr, rr * 0.9, 0, 0, Math.PI * 2); ctx.fill();   // かげ
    ctx.beginPath(); ctx.arc(0, 0, rr, 0, Math.PI * 2); ctx.save(); ctx.clip();
    const stripe = id > 8;
    ctx.fillStyle = stripe ? "#f6f6f2" : color; ctx.fillRect(-rr, -rr, rr * 2, rr * 2);
    const ph = roll.get(id) || { a: id * 1.7, h: 0 };
    if (stripe) { ctx.save(); ctx.rotate(ph.h + Math.PI / 2); ctx.fillStyle = color; ctx.fillRect(-rr, -rr * 0.5, rr * 2, rr); ctx.restore(); }
    if (id > 0 && Math.cos(ph.a) > -0.1) {   // ころがると、番号の丸が動く
      const off = Math.sin(ph.a) * rr * 0.55;
      ctx.save(); ctx.translate(Math.cos(ph.h) * off, Math.sin(ph.h) * off);
      ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(0, 0, rr * 0.5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#15181f"; ctx.font = `700 ${rr * 0.62}px sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      if (vertical) ctx.rotate(-Math.PI / 2);
      ctx.fillText(String(id), 0, 0.5); ctx.restore();
    }
    const sh = ctx.createRadialGradient(-rr * 0.35, -rr * 0.4, rr * 0.1, 0, 0, rr);   // 立体感
    sh.addColorStop(0, "rgba(255,255,255,.35)"); sh.addColorStop(0.5, "rgba(255,255,255,0)"); sh.addColorStop(1, "rgba(0,0,0,.5)");
    ctx.fillStyle = sh; ctx.fillRect(-rr, -rr, rr * 2, rr * 2);
    ctx.restore();
    ctx.fillStyle = "rgba(255,255,255,.8)"; ctx.beginPath(); ctx.ellipse(-rr * 0.35, -rr * 0.42, rr * 0.28, rr * 0.16, -0.6, 0, Math.PI * 2); ctx.fill();   // つや
    ctx.restore();
  }
  function drawStick(cue, angle, back) {
    const len = 330, tipX = cue.x - Math.cos(angle) * (TABLE.r + back), tipY = cue.y - Math.sin(angle) * (TABLE.r + back);
    const ex = tipX - Math.cos(angle) * len, ey = tipY - Math.sin(angle) * len;
    const nx = -Math.sin(angle), ny = Math.cos(angle);
    const g = ctx.createLinearGradient(tipX, tipY, ex, ey); g.addColorStop(0, "#f2dca8"); g.addColorStop(0.12, "#e8c88a"); g.addColorStop(0.13, "#3b2a1a"); g.addColorStop(1, "#6b4423");
    ctx.save(); ctx.shadowColor = "rgba(0,0,0,.4)"; ctx.shadowBlur = 6; ctx.fillStyle = g;
    ctx.beginPath(); ctx.moveTo(tipX + nx * 2.2, tipY + ny * 2.2); ctx.lineTo(ex + nx * 5.5, ey + ny * 5.5); ctx.lineTo(ex - nx * 5.5, ey - ny * 5.5); ctx.lineTo(tipX - nx * 2.2, tipY - ny * 2.2); ctx.closePath(); ctx.fill();
    ctx.fillStyle = "#4a8ad8"; ctx.beginPath(); ctx.arc(tipX, tipY, 2.4, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  }
  function drawTable(ctx) {
    const wood = ctx.createLinearGradient(0, 0, 0, H); wood.addColorStop(0, "#7a4a22"); wood.addColorStop(0.5, "#5c3517"); wood.addColorStop(1, "#7a4a22");
    ctx.fillStyle = wood; ctx.beginPath(); ctx.roundRect(0, 0, W, H, 28); ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,.14)"; ctx.lineWidth = 2; ctx.beginPath(); ctx.roundRect(3, 3, W - 6, H - 6, 26); ctx.stroke();
    ctx.fillStyle = "#f3e6c8";   // 目印のダイヤ
    const dia = (x, y) => { ctx.save(); ctx.translate(x, y); ctx.rotate(Math.PI / 4); ctx.fillRect(-4, -4, 8, 8); ctx.restore(); };
    for (let i = 1; i < 8; i++) { if (i === 4) continue; const x = M + TABLE.w * i / 8; dia(x, M / 2); dia(x, H - M / 2); }
    for (let i = 1; i < 4; i++) { const y = M + TABLE.h * i / 4; dia(M / 2, y); dia(W - M / 2, y); }
    ctx.save(); ctx.translate(M, M);
    ctx.fillStyle = "#125c38"; ctx.fillRect(-12, -12, TABLE.w + 24, TABLE.h + 24);   // クッション
    const felt = ctx.createRadialGradient(TABLE.w / 2, TABLE.h / 2, 60, TABLE.w / 2, TABLE.h / 2, TABLE.w * 0.62);
    felt.addColorStop(0, "#2b9a63"); felt.addColorStop(1, "#1b7a4b");
    ctx.fillStyle = felt; ctx.fillRect(0, 0, TABLE.w, TABLE.h);
    const nz = document.createElement("canvas"); nz.width = nz.height = 64;   // ラシャの細かい織り目
    const nctx = nz.getContext("2d"), id = nctx.createImageData(64, 64);
    for (let i = 0; i < id.data.length; i += 4) { const v = 128 + ((i * 7919 + (i >> 2) * 104729) % 97) - 48; id.data[i] = id.data[i + 1] = id.data[i + 2] = v; id.data[i + 3] = 255; }
    nctx.putImageData(id, 0, 0);
    ctx.save(); ctx.globalAlpha = 0.09; ctx.globalCompositeOperation = "overlay"; ctx.fillStyle = ctx.createPattern(nz, "repeat"); ctx.fillRect(0, 0, TABLE.w, TABLE.h); ctx.restore();
    const lamp = ctx.createRadialGradient(TABLE.w * 0.5, TABLE.h * 0.45, 40, TABLE.w * 0.5, TABLE.h * 0.5, TABLE.w * 0.6);   // 上からの照明
    lamp.addColorStop(0, "rgba(255,255,230,.12)"); lamp.addColorStop(1, "rgba(0,0,0,.28)");
    ctx.fillStyle = lamp; ctx.fillRect(0, 0, TABLE.w, TABLE.h);
    for (const [x, y, w, h, gx, gy] of [[0, 0, TABLE.w, 14, 0, 1], [0, TABLE.h - 14, TABLE.w, 14, 0, -1], [0, 0, 14, TABLE.h, 1, 0], [TABLE.w - 14, 0, 14, TABLE.h, -1, 0]]) {   // クッションのゴム
      const g = ctx.createLinearGradient(x, y, x + gx * 14 + (gx ? 0 : 0), y + gy * 14); g.addColorStop(0, "rgba(0,0,0,.45)"); g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g; ctx.fillRect(x, y, w, h);
    }
    ctx.strokeStyle = "rgba(0,0,0,.28)"; ctx.lineWidth = 3; ctx.strokeRect(0, 0, TABLE.w, TABLE.h);
    ctx.strokeStyle = "rgba(255,255,255,.2)"; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(HEAD_SPOT.x, 0); ctx.lineTo(HEAD_SPOT.x, TABLE.h); ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,.3)"; for (const p of [HEAD_SPOT, FOOT_SPOT, { x: TABLE.w / 2, y: TABLE.h / 2 }]) { ctx.beginPath(); ctx.arc(p.x, p.y, 2.6, 0, Math.PI * 2); ctx.fill(); }
    POCKETS.forEach(([px, py], i) => {   // ポケット
      const g = ctx.createRadialGradient(px, py, 3, px, py, POCKET_R[i] + 6); g.addColorStop(0, "#000"); g.addColorStop(0.75, "#10141a"); g.addColorStop(1, "#3a2a1a");
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(px, py, POCKET_R[i] + 4, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "#c9a24a"; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(px, py, POCKET_R[i] + 6, 0, Math.PI * 2); ctx.stroke();   // 金具のふち
      ctx.strokeStyle = "rgba(255,240,190,.5)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(px, py, POCKET_R[i] + 7.5, -2.6, -1.1); ctx.stroke();
    });
    ctx.restore();
  }
  function draw() {
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    if (vertical) { ctx.translate(H, 0); ctx.rotate(Math.PI / 2); }
    if (layer) ctx.drawImage(layer, 0, 0, W, H);
    ctx.save(); ctx.translate(M, M);
    const cue = cueBall(game);
    const aiming = aim && cue.on && !game.inHand && (phase === "aim" || phase === "cpu");
    if (aiming) {
      const ln = aimLine(game, aim.angle);
      ctx.setLineDash([9, 7]); ctx.strokeStyle = "rgba(255,255,255,.9)"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(ln.x1, ln.y1); ctx.lineTo(ln.x2, ln.y2); ctx.stroke(); ctx.setLineDash([]);
      ctx.beginPath(); ctx.arc(ln.x2, ln.y2, TABLE.r, 0, Math.PI * 2); ctx.stroke();
      if (ln.hit !== null) {
        const L = TABLE.r * 2 + 50 + aim.power * 130;
        ctx.strokeStyle = "rgba(255,230,120,.95)"; ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.moveTo(ln.x2 + ln.tx * TABLE.r * 2, ln.y2 + ln.ty * TABLE.r * 2); ctx.lineTo(ln.x2 + ln.tx * L, ln.y2 + ln.ty * L); ctx.stroke();
        if (ln.cx || ln.cy) { ctx.strokeStyle = "rgba(255,255,255,.55)"; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(ln.x2, ln.y2); ctx.lineTo(ln.x2 + ln.cx * 60, ln.y2 + ln.cy * 60); ctx.stroke(); }
      }
    }
    for (const b of game.balls) if (b.on && b.id !== 0) drawBall(b);
    if (cue.on) {
      if (game.inHand && phase === "aim" && game.turn === seat()) { ctx.globalAlpha = 0.85; drawBall(cue); ctx.globalAlpha = 1; ctx.strokeStyle = "#ffe27a"; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(cue.x, cue.y, TABLE.r + 5, 0, Math.PI * 2); ctx.stroke(); }
      else drawBall(cue);
    }
    for (const d of drops) { const k = Math.min(1, d.t), sc = 1 - k * 0.7; ctx.save(); ctx.globalAlpha = 1 - k * 0.6; ctx.translate(d.x + (d.px - d.x) * k, d.y + (d.py - d.y) * k); ctx.scale(sc, sc); drawBall({ id: d.id, x: 0, y: 0 }); ctx.restore(); }
    if (aiming) drawStick(cue, aim.angle, 6 + aim.power * 110);
    if (anim && cue.on) drawStick(cue, anim.angle, anim.back);
    ctx.restore();
  }

  /* ---- 進める ---- */
  function track() {   // 見た目の回転
    for (const b of game.balls) {
      if (!b.on) continue;
      const sp = Math.hypot(b.vx, b.vy); if (sp < 0.02) continue;
      const ph = roll.get(b.id) || { a: b.id * 1.7, h: 0 };
      ph.h = Math.atan2(b.vy, b.vx); ph.a += sp / TABLE.r; roll.set(b.id, ph);
    }
  }
  function sounds() {
    const ev = game.events.splice(0);
    for (const e of ev) if (e.k === "pocket") {
      const b = game.balls.find((x) => x.id === e.id); if (!b) continue;
      let best = POCKETS[0]; for (const q of POCKETS) if (Math.hypot(q[0] - b.x, q[1] - b.y) < Math.hypot(best[0] - b.x, best[1] - b.y)) best = q;
      drops.push({ id: e.id, x: b.x, y: b.y, px: best[0], py: best[1], t: 0 });
    }
    if (muted || !ev.length) return;
    let n = 0;
    for (const e of ev) {
      if (n++ > 4) break;
      if (e.k === "ball") blip(380 + Math.min(500, e.v * 70), 0.07, Math.min(0.5, 0.08 + e.v * 0.05));
      else if (e.k === "rail") blip(140, 0.09, Math.min(0.35, 0.05 + e.v * 0.04), "sine");
      else if (e.k === "pocket") blip(110, 0.22, 0.4, "sine");
    }
  }
  function frame(ts) {
    raf = 0;
    if (!root.isConnected) { stopBilliards(); return; }
    const dt = Math.min(0.1, (ts - (lastTs || ts)) / 1000); lastTs = ts;
    let again = false;
    if (drops.length) { for (const d of drops) d.t += dt / 0.3; for (let i = drops.length - 1; i >= 0; i--) if (drops[i].t >= 1) drops.splice(i, 1); again = true; }
    if (phase === "anim" && anim) {
      anim.back = Math.max(4, anim.back - anim.back0 / 7);
      if (anim.back <= 4) { const a = anim; anim = null; doShoot(a); } else again = true;
    }
    if (phase === "moving") {
      acc += dt;
      let n = 0;
      while (acc >= DT && n++ < 6) { acc -= DT; step(game); track(); }
      sounds();
      if (isRest(game)) { acc = 0; if (ON) afterReplay(); else afterShot(); } else again = true;
    }
    draw();
    if (again) raf = requestAnimationFrame(frame);
  }
  function loop() { if (!raf) { lastTs = 0; acc = 0; raf = requestAnimationFrame(frame); } }

  const engSpin = () => -eng.y * 0.9, engSide = () => eng.x * 0.9;
  function startShot(angle, power, sp, side = 0) {
    phase = "anim"; $("#blPower").style.width = "0";
    anim = { angle, power, spin: sp, side, back0: 6 + power * 110, back: 6 + power * 110 };
    loop();
  }
  function doShoot(a) {
    if (ON) return submit(a);
    if (shoot(game, a.angle, a.power, a.spin, a.side)) { aim = null; phase = "moving"; hud(); loop(); }
    else { phase = "aim"; draw(); }
  }

  function afterShot() {
    if (mode === "practice") {
      const r = settle(game); hud();
      if (isCleared(game)) return finishPractice();
      phase = "aim"; setMsg(r.scratch ? "反則：手球が落ちたので、もとの場所に戻しました" : "つぎの一発をどうぞ", r.scratch); draw(); return;
    }
    const prev = game.turn;
    const r = endShot(game); hud();
    const who = prev === 0 ? "あなた" : "CPU", other = prev === 0 ? "CPU" : "あなた";
    if (game.over) return finishEight();
    let t;
    if (r.foul) t = `${who}の反則（${r.reason}）。${other}は手球を好きな場所に置けます`;
    else if (r.assigned) t = `${who}は${game.groups[prev] === "solid" ? "ソリッド（無地）" : "ストライプ（しま）"}に決まりました`;
    else if (!r.switched) t = `${who}は続けて打てます`;
    else t = `${other}の番です`;
    if (game.turn === 1) { phase = "cpu"; setMsg(t, r.foul); draw(); later(cpuTurn, 900); }
    else { phase = "aim"; setMsg(t + (game.inHand ? "　白い球を、好きな場所にドラッグして置こう" : ""), r.foul); draw(); }
  }
  function cpuTurn() {
    if (game.over) return;
    if (game.inHand) { const p = choosePlacement(game); placeCue(game, p.x, p.y); game.inHand = false; }
    const s = chooseShot(game, { error: LEVELS[level] });
    aim = { angle: s.angle, power: s.power };
    setMsg("CPUが狙っています…"); draw();
    later(() => startShot(s.angle, s.power, 0, 0), 800);
  }
  function finishEight() {
    phase = "over";
    const win = game.winner === 0;
    addRec(`${mode}-${level}`, win); hud();
    $("#blOverTitle").textContent = win ? "あなたの勝ち！" : "CPUの勝ち";
    $("#blOverText").textContent = win ? (mode === "nine" ? "9番を落として勝ちました" : "8番を落として勝ちました") : "もう一度挑戦しよう";
    $("#blOver").classList.add("on"); setMsg(win ? "勝ち！" : "負け…"); draw();
  }
  function finishPractice() {
    phase = "over";
    const total = game.shots, best = readBest(), isBest = !best || total < best;
    if (isBest) writeBest(total);
    $("#blOverTitle").textContent = "クリア！";
    $("#blOverText").textContent = `${total}打でクリア（反則 ${game.fouls}回）${isBest ? " ベスト更新！" : ""}`;
    $("#blOver").classList.add("on"); hud(); draw();
  }


  /* ---- ルーム対戦（人と人）：球の動きの結果は Worker が決める。画面は、同じ計算で動きを再生して、終わったら Worker の位置にそろえる ---- */
  const nowMs = () => Date.now() + offset;
  const lastN = (y) => (y && y.last ? y.last.n : 0);
  const busy = () => phase === "moving" || phase === "busy" || phase === "anim";
  function onlineInfo() {
    if (!srv) return "";
    const sc = Array.isArray(srv.score) ? `　${srv.score[myIdx] ?? 0}勝 − ${srv.score[1 - myIdx] ?? 0}勝` : "";
    if (srv.done) return `対戦は終わりました${sc}`;
    const sec = Math.max(0, Math.ceil((srv.deadline - nowMs()) / 1000));
    return `${srv.cur === myIdx ? "あなたの持ち時間" : "相手の持ち時間"}：あと${sec}秒${sc}`;
  }
  function describe(y) {
    const l = y.last; if (!l) return "";
    const who = l.by === myIdx ? "あなた" : "相手", other = l.by === myIdx ? "相手" : "あなた";
    if (l.timeout) return `${who}は時間切れ。${other}は手球を好きな場所に置けます`;
    if (l.foul) return `${who}の反則（${l.reason}）。${other}は手球を好きな場所に置けます`;
    if (l.assigned) return `${who}は${y.st.g[l.by] === "solid" ? "ソリッド（無地）" : "ストライプ（しま）"}に決まりました`;
    if (!l.switched) return `${who}は続けて打てます`;
    return `${other}の番です`;
  }
  function showStart(html) { const el = $("#blStart"); $("#blStartBox").innerHTML = html; el.classList.toggle("on", !!html); }
  function onlineUpdate(room) {
    online.room = room;
    const y = room.billiards || null;
    myIdx = (room.memberUids || []).indexOf(online.uid);
    if (!y) {
      srv = null; playedN = -1; phase = "wait";
      const members = Array.isArray(room.members) ? room.members : [];
      if (members.length < 2 || room.status !== "playing") { showStart("<b>相手を待っています…</b><span>友達を招待するか、ほかの人が入るのを待とう</span>"); return; }
      if (room.ownerUid === online.uid) {
        showStart('<b>ルールをえらぼう</b><span>コインは使いません</span><button type="button" class="bl-btn pri" data-start="eight">8ボール</button><button type="button" class="bl-btn pri" data-start="nine">9ボール</button>');
        $("#blStartBox").querySelectorAll("[data-start]").forEach((b) => b.addEventListener("click", () => startGame(b.dataset.start)));
      } else showStart("<b>ルームを作った人が、ルールを選んでいます…</b>");
      return;
    }
    myIdx = y.order.indexOf(online.uid);
    showStart("");
    if (srv && srv.gid !== y.gid) { playedN = -1; $("#blOver").classList.remove("on"); }
    if (busy()) { pendingY = y; return; }   // 動いている間は、終わってから
    consume(y);
  }
  async function startGame(m, rematchFlag = false) {
    try { const r = await online.api("billiardsRoomStart", { roomId: online.room.id, mode: m, rematch: rematchFlag }); offset = (r.serverNowMs || Date.now()) - Date.now(); showStart(""); consume(r.billiards); }
    catch (e) {
      const c = e?.code || e?.message || "エラー";
      showStart(`<b>始められませんでした</b><span>${esc(c === "supporter_only" ? "ビリヤードは、ゆうChatサポーター限定です" : c === "opponent_not_supporter" ? "相手がサポーターではないため、始められません（ビリヤードはサポーター限定です）" : c === "not_published" ? "ビリヤードは、いま準備中です" : c)}</span>`);
    }
  }
  function rematch() { startGame(srv?.mode || "eight", true); }
  function consume(y) {
    const prev = srv; srv = y; mode = y.mode;
    const n = lastN(y);
    if (n > playedN && playedN >= 0 && y.last && y.last.angle !== undefined && !y.last.timeout && !(prev && prev.gid !== y.gid)) { playedN = n; replay(y); return; }
    playedN = n;
    applyState(y, y.last && n > 0 ? describe(y) : "");
  }
  function replay(y) {
    const l = y.last;
    game = restore(y.mode, l.pre);
    if (l.place) { const c = cueBall(game); c.x = l.place.x; c.y = l.place.y; c.on = true; }
    game.inHand = false; game.shot = null;
    shoot(game, l.angle, l.power, l.spin, l.side);
    aim = null; anim = null; phase = "moving"; roll.clear(); hud(); loop();
  }
  function afterReplay() {
    const a = pendingY, b = srv;
    const y = a && lastN(a) >= lastN(b) ? a : b; pendingY = null;
    srv = y; playedN = lastN(y);
    applyState(y, describe(y));
  }
  function applyState(y, text) {
    game = restore(y.mode, y.st);
    hud();
    if (y.done) {
      phase = "over";
      const win = y.winner === myIdx;
      $("#blOverTitle").textContent = win ? "あなたの勝ち！" : "相手の勝ち";
      $("#blOverText").textContent = y.reason === "timeout" ? "時間切れで決まりました" : (y.mode === "nine" ? "9番が落ちて決まりました" : "8番が決まって終わりました");
      $("#blOver").classList.add("on"); setMsg(win ? "勝ち！" : "負け…");
    } else {
      $("#blOver").classList.remove("on");
      const mine = y.cur === myIdx;
      phase = mine ? "aim" : "wait";
      const first = !y.last ? (mine ? "あなたのブレイク（最初の一発）です。強く打って、球を散らそう" : "相手のブレイクです") : (text ? "" : mine ? "あなたの番です" : "相手の番です");
      setMsg([text, first].filter(Boolean).join("　") + (mine && game.inHand ? "　白い球を、好きな場所にドラッグして置こう" : ""), !!(y.last && (y.last.foul || y.last.timeout)));
    }
    placedAt = null; aim = null;
    draw(); startTimer(); setTimeout(resize, 0);
  }
  function startTimer() {
    clearInterval(timerId);
    timerId = setInterval(() => {
      if (!root.isConnected) { clearInterval(timerId); return; }
      if (!srv) return;
      $("#blRec").textContent = onlineInfo();
      if (srv.done || busy()) return;
      if (nowMs() > srv.deadline + 1500) {
        const key = `${srv.gid}:${lastN(srv)}:${srv.cur}`;
        if (key === timeoutKey) return;
        timeoutKey = key;
        online.api("billiardsRoomTimeout", { roomId: online.room.id, gid: srv.gid, n: lastN(srv), turn: srv.cur })
          .then((r) => { offset = (r.serverNowMs || Date.now()) - Date.now(); if (r.billiards) { if (busy()) pendingY = r.billiards; else consume(r.billiards); } })
          .catch(() => { setTimeout(() => { timeoutKey = ""; }, 5000); });
      }
    }, 500);
  }
  async function submit(a) {
    phase = "busy"; setMsg("送信中…"); draw();
    try {
      const r = await online.api("billiardsRoomShoot", { roomId: online.room.id, gid: srv.gid, angle: a.angle, power: a.power, spin: a.spin, side: a.side, ...(placedAt ? { place: placedAt } : {}) });
      offset = (r.serverNowMs || Date.now()) - Date.now();
      phase = "wait"; consume(r.billiards);
    } catch (e) {
      const code = e?.code || e?.message || "エラー";
      phase = "aim"; placedAt = null;
      applyState(srv, code === "not_your_turn" ? "いまはあなたの番ではありません" : code === "timeout" ? "時間切れです" : code === "stale" ? "ゲームが新しくなりました" : `打てませんでした（${code}）`);
    }
  }

  /* ---- 操作 ---- */
  function placeAt(p) {
    const r = TABLE.r, x = Math.max(r, Math.min(TABLE.w - r, p.x)), y = Math.max(r, Math.min(TABLE.h - r, p.y));
    if (canPlace(game, x, y)) { const c = cueBall(game); c.x = x; c.y = y; c.on = true; }
    draw();
  }
  const powVal = () => Number($("#blPow").value) / 100;
  function tapAim(p) {
    const cue = cueBall(game), dx = p.x - cue.x, dy = p.y - cue.y;
    if (Math.hypot(dx, dy) < 10) return;
    aim = { angle: Math.atan2(dy, dx), power: powVal() };
    $("#blPower").style.width = `${Math.round(aim.power * 100)}%`; draw();
  }
  function setAimMode(m) {
    aimMode = m; aim = null; pulling = false;
    root.querySelectorAll("[data-aim]").forEach((b) => b.classList.toggle("on", b.dataset.aim === m));
    $("#blTapRow").style.display = m === "tap" ? "" : "none"; setTimeout(resize, 0);
    $("#blTip").textContent = m === "tap" ? "台をタップで向き→◀▶で微調整→強さを決めて「打つ」。左の丸＝突く位置" : "白い球から指を引っぱって離す。左の丸＝突く位置（押し・引き・ひねり）";
    draw();
  }
  function fire() {
    if (aim && phase === "aim" && game.turn === seat() && !game.inHand && !game.over && aim.power >= 0.04) startShot(aim.angle, aim.power, engSpin(), engSide());
  }
  function hint() {
    if (ON || phase !== "aim" || game.turn !== 0 || game.inHand || game.over) return;
    const h = chooseShot(game, { error: 0, rng: () => 0.5 });
    setAimMode("tap"); $("#blPow").value = String(Math.round(h.power * 100));
    aim = { angle: h.angle, power: h.power }; $("#blPower").style.width = `${Math.round(h.power * 100)}%`;
    setMsg("ヒント：この向きがおすすめ。「打つ」で打てます"); draw();
  }
  function drawEng() {
    const c = $("#blEng"), g = c.getContext("2d"), R = c.width / 2;
    g.clearRect(0, 0, c.width, c.height);
    const gr = g.createRadialGradient(R * 0.7, R * 0.6, 8, R, R, R); gr.addColorStop(0, "#fff"); gr.addColorStop(1, "#cfd6e4");
    g.fillStyle = gr; g.beginPath(); g.arc(R, R, R - 3, 0, Math.PI * 2); g.fill();
    g.strokeStyle = "rgba(29,36,51,.25)"; g.lineWidth = 2; g.beginPath(); g.moveTo(R, 8); g.lineTo(R, c.width - 8); g.moveTo(8, R); g.lineTo(c.width - 8, R); g.stroke();
    g.fillStyle = "#667089"; g.font = "700 20px sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText("押", R, 20); g.fillText("引", R, c.width - 20);
    g.fillStyle = "#e5484d"; g.beginPath(); g.arc(R + eng.x * (R - 12), R + eng.y * (R - 12), 11, 0, Math.PI * 2); g.fill();
    g.strokeStyle = "#fff"; g.lineWidth = 3; g.stroke();
  }
  function engAt(ev) {
    const c = $("#blEng"), rect = c.getBoundingClientRect();
    let x = ((ev.clientX - rect.left) / rect.width) * 2 - 1, y = ((ev.clientY - rect.top) / rect.height) * 2 - 1;
    const l = Math.hypot(x, y); if (l > 0.85) { x = x / l * 0.85; y = y / l * 0.85; }
    if (Math.hypot(x, y) < 0.12) { x = 0; y = 0; }
    eng = { x, y }; drawEng();
  }
  function updateAim(p) {
    const cue = cueBall(game), dx = cue.x - p.x, dy = cue.y - p.y, dist = Math.hypot(dx, dy);
    if (dist < 24) { aim = null; $("#blPower").style.width = "0"; draw(); return; }
    aim = { angle: Math.atan2(dy, dx), power: Math.min(1, (dist - 14) / 210) };
    $("#blPower").style.width = `${Math.round(aim.power * 100)}%`;
    draw();
  }
  function onDown(ev) {
    initAudio();
    ev.preventDefault();
    if (phase !== "aim" || game.over || game.turn !== seat()) return;
    try { canvas.setPointerCapture(ev.pointerId); } catch (_) { /* なくてもよい */ }
    const p = toTable(ev);
    if (game.inHand) { dragCue = true; placeAt(p); return; }
    pulling = true; if (aimMode === "tap") tapAim(p); else updateAim(p);
  }
  function onMove(ev) {
    if (dragCue) { ev.preventDefault(); placeAt(toTable(ev)); }
    else if (pulling) { ev.preventDefault(); if (aimMode === "tap") tapAim(toTable(ev)); else updateAim(toTable(ev)); }
  }
  function onUp() {
    if (dragCue) { dragCue = false; if (ON) { const c = cueBall(game); placedAt = { x: c.x, y: c.y }; } game.inHand = false; setMsg("白い球を置きました。引っぱって打とう"); draw(); return; }
    if (!pulling) return;
    pulling = false;
    if (aimMode === "tap") return;   // タップで狙うときは、「打つ」ボタンで打つ
    const a = aim;
    if (a && a.power >= 0.04) startShot(a.angle, a.power, engSpin(), engSide()); else { aim = null; $("#blPower").style.width = "0"; draw(); }
  }
  const stopScroll = (e) => { if (e.cancelable) e.preventDefault(); };
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", () => { pulling = false; dragCue = false; aim = null; draw(); });
  stage.addEventListener("touchstart", stopScroll, { passive: false });
  stage.addEventListener("touchmove", stopScroll, { passive: false });
  stage.addEventListener("contextmenu", stopScroll);
  $("#blBack")?.addEventListener("click", () => { stopBilliards(); if (onBack) onBack(); });
  $("#blReset")?.addEventListener("click", reset);
  $("#blAgain").addEventListener("click", () => { if (ON) rematch(); else reset(); });
  $("#blRoomBtn")?.addEventListener("click", () => { stopBilliards(); if (openRooms) openRooms(); });
  $("#blSound").addEventListener("click", () => { muted = !muted; $("#blSound").textContent = muted ? "🔇" : "🔊"; });
  root.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
  root.querySelectorAll("[data-level]").forEach((b) => b.addEventListener("click", () => { level = b.dataset.level; root.querySelectorAll("[data-level]").forEach((x) => x.classList.toggle("on", x === b)); hud(); }));
  root.querySelectorAll("[data-aim]").forEach((b) => b.addEventListener("click", () => setAimMode(b.dataset.aim)));
  $("#blHint")?.addEventListener("click", hint);
  $("#blFire").addEventListener("click", fire);
  $("#blPow").addEventListener("input", () => { if (aim) { aim.power = powVal(); $("#blPower").style.width = `${Math.round(aim.power * 100)}%`; draw(); } });
  let rot = 0;
  const rotStart = (d) => (ev) => { ev.preventDefault(); const go = () => { if (aim && phase === "aim") { aim.angle += d; draw(); } }; go(); clearInterval(rot); rot = setInterval(go, 70); };
  const rotStop = () => { clearInterval(rot); rot = 0; };
  for (const [id, d] of [["#blL", -0.005], ["#blR", 0.005]]) { const el = $(id); el.addEventListener("pointerdown", rotStart(d)); el.addEventListener("pointerup", rotStop); el.addEventListener("pointerleave", rotStop); el.addEventListener("pointercancel", rotStop); }
  const engEl = $("#blEng"); let engDown = false;
  engEl.addEventListener("pointerdown", (ev) => { ev.preventDefault(); engDown = true; try { engEl.setPointerCapture(ev.pointerId); } catch (_) { /* なくてもよい */ } engAt(ev); });
  engEl.addEventListener("pointermove", (ev) => { if (engDown) engAt(ev); });
  engEl.addEventListener("pointerup", () => { engDown = false; });
  engEl.addEventListener("touchstart", stopScroll, { passive: false });
  window.addEventListener("resize", resize);
  cleanup = () => {
    window.removeEventListener("resize", resize); timers.splice(0).forEach(clearTimeout); clearInterval(timerId); clearInterval(rot);
    document.documentElement.classList.remove("bl-lock"); document.body.classList.remove("bl-lock");
  };
  drawEng();
  if (!ON) reset(); else { hud(); onlineUpdate(online.room); }
  resize();
  setTimeout(resize, 60);   // 画面の並びが落ち着いてから、もう一度大きさを合わせる
  return ON ? { update: onlineUpdate } : undefined;
}

/* 🎱 ビリヤードの2人対戦（ゲームルーム）：script.js の renderCurrentGame から、ルームが更新されるたびに呼ばれる。
   同じルームなら、作り直さず、いまの画面に新しい状態を渡す（動きの再生を止めないため） */
export function renderBilliardsRoom(boardEl, room, { api, uid, esc }) {
  const inst = boardEl.__billiards;
  if (inst && inst.roomId === room.id && boardEl.firstElementChild && boardEl.firstElementChild.id === "blWrap" && boardEl.isConnected) { inst.update(room); return; }
  const handle = renderBilliards({ root: boardEl, esc, online: { room, api, uid } });
  boardEl.__billiards = { roomId: room.id, update: handle.update };
}
