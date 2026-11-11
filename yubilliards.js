/* 🎱 ゆうワールド「ビリヤード」の画面。コインは使わない
   ・「CPUと対戦」：本物の8ボールのルール（グループ・反則・手球を置く・8番で勝ち負け）。「1人で練習」：15個を少ない打数で全部落とす
   ・打ち方：白い球から、指を引っぱって離す（引いた向きの反対へ飛ぶ。長く引くほど強い）。押し・引きも選べる
   ・球の動きは yubilliards-core.js（決まった計算）。CPUは yubilliards-ai.js。通信はしない
   ・ベストの記録（練習）は、この端末だけに残す */
import { TABLE, POCKETS, POCKET_R, BALL_COLORS, HEAD_SPOT, FOOT_SPOT, groupLeft, newGame, shoot, step, isRest, settle, endShot, remaining, isCleared, cueBall, aimLine, canPlace, placeCue } from "./yubilliards-core.js?v=20261111-bl2";
import { chooseShot, choosePlacement } from "./yubilliards-ai.js?v=20261111-bl2";

const M = 40;                          // 台の木の縁の幅（台の単位）
const BEST_KEY = "yuBilliardsBest";
const DT = 1 / 60;                     // 球の動きは、1/60秒ごとの刻みで進める（画面の速さによらず、同じ速さ）
const W = TABLE.w + M * 2, H = TABLE.h + M * 2;
let raf = 0, cleanup = null;

export function stopBilliards() {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  if (cleanup) { cleanup(); cleanup = null; }
}

function readBest() { try { const n = Number(localStorage.getItem(BEST_KEY)); return Number.isFinite(n) && n > 0 ? n : null; } catch (_) { return null; } }
function writeBest(n) { try { localStorage.setItem(BEST_KEY, String(n)); } catch (_) { /* 保存できなくても遊べる */ } }

const STYLE = `
html.bl-lock,body.bl-lock{overflow:hidden!important;overscroll-behavior:none;height:100%}
.bl-wrap{max-width:1000px;margin:0 auto;padding:8px 10px calc(12px + env(safe-area-inset-bottom,0px));display:flex;flex-direction:column;gap:8px;color:#1d2433;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}
.bl-top{display:flex;align-items:center;gap:8px}
.bl-top h2{margin:0;font-size:17px;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bl-btn{min-height:40px;padding:0 13px;border:1px solid #d6dbe6;border-radius:12px;background:#fff;font-size:13.5px;font-weight:700;color:#1d2433}
.bl-btn.on{background:#1d2433;border-color:#1d2433;color:#fff}
.bl-btn.pri{background:#2f6bff;border-color:#2f6bff;color:#fff}
.bl-note{margin:0;padding:6px 10px;border-radius:10px;background:#fff6d6;color:#6b5200;font-size:12px}
.bl-modes{display:flex;gap:6px}
.bl-modes .bl-btn{flex:1}
.bl-hud{display:flex;gap:6px}
.bl-hud>div{flex:1;min-width:0;background:#fff;border:2px solid #e7e9ed;border-radius:12px;padding:5px 8px;text-align:center}
.bl-hud>div.turn{border-color:#2f6bff;background:#eef3ff}
.bl-hud span{display:block;font-size:11px;color:#667089;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bl-hud b{font-size:18px}
.bl-msg{margin:0;min-height:20px;text-align:center;font-size:13.5px;font-weight:700;color:#1d2433}
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
export function renderBilliards({ root, esc = (s) => String(s), onBack, adminNote = "" }) {
  stopBilliards();
  ensureStyle();
  document.documentElement.classList.add("bl-lock"); document.body.classList.add("bl-lock");   // 引っぱるときに、画面がスクロールしないように固定する
  root.innerHTML = `<div class="bl-wrap">
    <div class="bl-top"><button type="button" class="bl-btn" id="blBack">‹ もどる</button><h2>🎱 ビリヤード</h2><button type="button" class="bl-btn" id="blSound" aria-label="音">🔊</button><button type="button" class="bl-btn" id="blReset">はじめから</button></div>
    ${adminNote ? `<p class="bl-note">${esc(adminNote)}</p>` : ""}
    <div class="bl-modes"><button type="button" class="bl-btn on" data-mode="eight">CPUと対戦（8ボール）</button><button type="button" class="bl-btn" data-mode="practice">1人で練習</button></div>
    <div class="bl-hud" id="blHud"></div>
    <p class="bl-msg" id="blMsg"></p>
    <div class="bl-stage" id="blStage"><canvas id="blCanvas" aria-label="ビリヤード台"></canvas><div class="bl-over" id="blOver"><div><b id="blOverTitle"></b><span id="blOverText"></span><button type="button" class="bl-btn pri" id="blAgain">もう一度</button></div></div></div>
    <div class="bl-power" aria-hidden="true"><i id="blPower"></i></div>
    <div class="bl-spin"><span>打ち方</span><button type="button" class="bl-btn" data-spin="1">押し</button><button type="button" class="bl-btn on" data-spin="0">ふつう</button><button type="button" class="bl-btn" data-spin="-1">引き</button><span style="flex:1;text-align:right">白い球から指を引っぱって離すと打てます</span></div>
  </div>`;
  const $ = (id) => root.querySelector(id);
  const canvas = $("#blCanvas"), ctx = canvas.getContext("2d");
  const stage = $("#blStage");
  let mode = "eight", game = newGame("eight");
  let phase = "aim";                     // aim（打つ前）／anim（キューを引いて打つ）／moving（球が動いている）／cpu（相手の番）／over
  let aim = null, spin = 0, muted = false;
  let pulling = false, dragCue = false, anim = null;
  let vertical = false, scale = 1;
  let acc = 0, lastTs = 0;
  const timers = [];
  const roll = new Map();                // 球ごとの回転（見た目だけ）
  const later = (fn, ms) => { const id = setTimeout(() => { const i = timers.indexOf(id); if (i >= 0) timers.splice(i, 1); fn(); }, ms); timers.push(id); };

  /* ---- 大きさ：スマホのたてでは、台をたてにして大きく使う ---- */
  function resize() {
    const wrapW = Math.max(240, (canvas.parentElement.clientWidth || 600));
    const top = canvas.getBoundingClientRect().top || 220;
    const availH = Math.max(220, (window.innerHeight || 700) - Math.max(150, top) - 78);
    const sL = Math.min(wrapW / W, availH / H), sP = Math.min(wrapW / H, availH / W);
    vertical = sP > sL * 1.02;
    const s = vertical ? sP : sL;
    const cssW = (vertical ? H : W) * s, cssH = (vertical ? W : H) * s;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.style.width = `${cssW}px`; canvas.style.height = `${cssH}px`;
    canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
    scale = canvas.width / (vertical ? H : W);
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
  function hud() {
    const el = $("#blHud");
    if (mode === "practice") {
      const best = readBest();
      el.innerHTML = `<div><span>残りの球</span><b>${remaining(game)}</b></div><div><span>打った回数</span><b>${game.shots}</b></div><div><span>反則</span><b>${game.fouls}</b></div><div><span>ベスト</span><b>${best ? best + "打" : "－"}</b></div>`;
      return;
    }
    const lab = (g) => (g === "solid" ? "ソリッド（無地）" : g === "stripe" ? "ストライプ（しま）" : "グループ未定");
    const left = (p) => { const g = game.groups[p]; if (!g) return "－"; const n = groupLeft(game, g); return n === 0 ? "8番" : `残り${n}`; };
    el.innerHTML = [0, 1].map((p) => `<div class="${game.turn === p && !game.over ? "turn" : ""}"><span>${p === 0 ? "あなた" : "CPU"}・${esc(lab(game.groups[p]))}</span><b>${left(p)}</b></div>`).join("");
  }
  function setMode(m) {
    mode = m; root.querySelectorAll("[data-mode]").forEach((b) => b.classList.toggle("on", b.dataset.mode === m));
    reset();
  }
  function reset() {
    timers.splice(0).forEach(clearTimeout);
    game = newGame(mode); aim = null; anim = null; pulling = false; dragCue = false; phase = "aim"; roll.clear();
    $("#blOver").classList.remove("on"); $("#blPower").style.width = "0";
    setMsg(mode === "eight" ? "あなたのブレイク（最初の一発）です。白い球から引っぱって、離そう" : "15個の球を、少ない打数で全部落とそう");
    hud(); draw();
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
  function drawTable() {
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
    ctx.strokeStyle = "rgba(0,0,0,.28)"; ctx.lineWidth = 3; ctx.strokeRect(0, 0, TABLE.w, TABLE.h);
    ctx.strokeStyle = "rgba(255,255,255,.2)"; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(HEAD_SPOT.x, 0); ctx.lineTo(HEAD_SPOT.x, TABLE.h); ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,.3)"; for (const p of [HEAD_SPOT, FOOT_SPOT, { x: TABLE.w / 2, y: TABLE.h / 2 }]) { ctx.beginPath(); ctx.arc(p.x, p.y, 2.6, 0, Math.PI * 2); ctx.fill(); }
    POCKETS.forEach(([px, py], i) => {   // ポケット
      const g = ctx.createRadialGradient(px, py, 3, px, py, POCKET_R[i] + 6); g.addColorStop(0, "#000"); g.addColorStop(0.75, "#10141a"); g.addColorStop(1, "#3a2a1a");
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(px, py, POCKET_R[i] + 4, 0, Math.PI * 2); ctx.fill();
    });
    ctx.restore();
  }
  function draw() {
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    if (vertical) { ctx.translate(H, 0); ctx.rotate(Math.PI / 2); }
    drawTable();
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
      if (game.inHand && phase === "aim" && game.turn === 0) { ctx.globalAlpha = 0.85; drawBall(cue); ctx.globalAlpha = 1; ctx.strokeStyle = "#ffe27a"; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(cue.x, cue.y, TABLE.r + 5, 0, Math.PI * 2); ctx.stroke(); }
      else drawBall(cue);
    }
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
    const dt = Math.min(0.1, (ts - (lastTs || ts)) / 1000); lastTs = ts;
    let again = false;
    if (phase === "anim" && anim) {
      anim.back = Math.max(4, anim.back - anim.back0 / 7);
      if (anim.back <= 4) { const a = anim; anim = null; doShoot(a); } else again = true;
    }
    if (phase === "moving") {
      acc += dt;
      let n = 0;
      while (acc >= DT && n++ < 6) { acc -= DT; step(game); track(); }
      sounds();
      if (isRest(game)) { acc = 0; afterShot(); } else again = true;
    }
    draw();
    if (again) raf = requestAnimationFrame(frame);
  }
  function loop() { if (!raf) { lastTs = 0; acc = 0; raf = requestAnimationFrame(frame); } }

  function startShot(angle, power, sp) {
    phase = "anim"; $("#blPower").style.width = "0";
    anim = { angle, power, spin: sp, back0: 6 + power * 110, back: 6 + power * 110 };
    loop();
  }
  function doShoot(a) {
    if (shoot(game, a.angle, a.power, a.spin)) { aim = null; phase = "moving"; hud(); loop(); }
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
    const s = chooseShot(game);
    aim = { angle: s.angle, power: s.power };
    setMsg("CPUが狙っています…"); draw();
    later(() => startShot(s.angle, s.power, 0), 800);
  }
  function finishEight() {
    phase = "over";
    const win = game.winner === 0;
    $("#blOverTitle").textContent = win ? "あなたの勝ち！" : "CPUの勝ち";
    $("#blOverText").textContent = win ? "8番を落として勝ちました" : "もう一度挑戦しよう";
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

  /* ---- 操作 ---- */
  function placeAt(p) {
    const r = TABLE.r, x = Math.max(r, Math.min(TABLE.w - r, p.x)), y = Math.max(r, Math.min(TABLE.h - r, p.y));
    if (canPlace(game, x, y)) { const c = cueBall(game); c.x = x; c.y = y; c.on = true; }
    draw();
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
    if (phase !== "aim" || game.over || game.turn !== 0) return;
    try { canvas.setPointerCapture(ev.pointerId); } catch (_) { /* なくてもよい */ }
    const p = toTable(ev);
    if (game.inHand) { dragCue = true; placeAt(p); return; }
    pulling = true; updateAim(p);
  }
  function onMove(ev) {
    if (dragCue) { ev.preventDefault(); placeAt(toTable(ev)); }
    else if (pulling) { ev.preventDefault(); updateAim(toTable(ev)); }
  }
  function onUp() {
    if (dragCue) { dragCue = false; game.inHand = false; setMsg("白い球を置きました。引っぱって打とう"); draw(); return; }
    if (!pulling) return;
    pulling = false;
    const a = aim;
    if (a && a.power >= 0.04) startShot(a.angle, a.power, spin); else { aim = null; $("#blPower").style.width = "0"; draw(); }
  }
  const stopScroll = (e) => { if (e.cancelable) e.preventDefault(); };
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", () => { pulling = false; dragCue = false; aim = null; draw(); });
  stage.addEventListener("touchstart", stopScroll, { passive: false });
  stage.addEventListener("touchmove", stopScroll, { passive: false });
  stage.addEventListener("contextmenu", stopScroll);
  $("#blBack").addEventListener("click", () => { stopBilliards(); if (onBack) onBack(); });
  $("#blReset").addEventListener("click", reset);
  $("#blAgain").addEventListener("click", reset);
  $("#blSound").addEventListener("click", () => { muted = !muted; $("#blSound").textContent = muted ? "🔇" : "🔊"; });
  root.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
  root.querySelectorAll("[data-spin]").forEach((b) => b.addEventListener("click", () => { spin = Number(b.dataset.spin) * 0.7; root.querySelectorAll("[data-spin]").forEach((x) => x.classList.toggle("on", x === b)); }));
  window.addEventListener("resize", resize);
  cleanup = () => {
    window.removeEventListener("resize", resize); timers.splice(0).forEach(clearTimeout);
    document.documentElement.classList.remove("bl-lock"); document.body.classList.remove("bl-lock");
  };
  reset(); resize();
  setTimeout(resize, 60);   // 画面の並びが落ち着いてから、もう一度大きさを合わせる
}
