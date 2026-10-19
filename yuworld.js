/* =========================================================
   🎡 ゆうワールド（ゆうスロなどのお店）クライアント

   【役割】
   ・「お店の一覧（ショップ）」→「ゆうスロのロビー（6台）」→「台での遊び」を描く。
   ・残高・抽選結果・公開/非公開・営業時間・FEVER開始はすべて通知 Worker（/yuslot）に任せる。
     クライアントは Worker が返した「署名セッション」と「中央ラインの絵柄」を受け取って見せるだけ。
   ・Firebase には一切触れない（Firestore の読み書きは 0）。
     スピン中・FEVER開始・演出中も Worker 側は Firestore を読み書きしない。コインの反映は約15秒ごとの flush と退出時の settle だけ。
   ・公開範囲の判定は Worker が行う（非公開のときは最上位管理者以外は遊べない）。取得/権限の失敗は「非公開（準備中）」扱い。
   ・画面倍率・音ON/OFF・演出の強弱は端末内（localStorage）だけに保存する。Firebase には保存しない。
     演出・音・倍率・演出強弱は抽選結果を一切変えない（結果は常に Worker が決める）。
========================================================= */

/* 6台（料金・特別役は worker.js の SLOT_MACHINES と同じ。表示用の名前・説明・絵文字・豪華さ(tier)を足す） */
const MACHINES = [
  { id: "yubasic",    name: "ゆうベーシック",     price: 1, special: "orig",    emoji: "🔰", tag: "入門",   tier: 1, desc: "いちばん遊びやすい入門台。オリジナル絵柄が揃うと大当たり＆FEVER！" },
  { id: "yurush",     name: "ゆうラッシュ",       price: 2, special: "orig",    emoji: "💨", tag: "軽快",   tier: 2, desc: "テンポよく回せる金色の台。オリジナル絵柄が揃うと大当たり＆FEVER！" },
  { id: "yuchance",   name: "ゆうチャンス",       price: 3, special: "triple7", emoji: "🎯", tag: "777",    tier: 3, desc: "強い発光と粒子が華やかな台。777が揃えば大当たり＆FEVER！" },
  { id: "yutreasure", name: "ゆうトレジャー",     price: 5, special: "triple7", emoji: "🧰", tier: 4, tag: "宝箱", desc: "宝箱と金貨がうれしい中級台。7も狙える。" },
  { id: "yurainbow",  name: "ゆうレインボー",     price: 7, special: "triple7", emoji: "🌈", tier: 5, tag: "虹",   desc: "虹色ときらめきが爽快な上級台。7とFEVER！" },
  { id: "yujackpot",  name: "ゆうジャックポット", price: 9, special: "triple7", emoji: "👑", tier: 6, tag: "最高額", desc: "最も豪華な台。金・虹の光と特別大当たり演出。7で大当たり＆FEVER！" }
];
const MACHINE_BY_ID = Object.fromEntries(MACHINES.map((m) => [m.id, m]));
const specialSymOf = (m) => (m.special === "orig" ? "orig" : "triple7");

const ORIG_IMAGES = { yubasic: "./assets/yuworld/symbol-yubasic.png", yurush: "./assets/yuworld/symbol-yurush.png" };
const SYMBOL_EMOJI = { cherry: "🍒", bell: "🔔", watermelon: "🍉", replay: "🔄", star: "⭐", treasure: "🎁" };
const FLUSH_INTERVAL_MS = 15000;     // Worker の SLOT_FLUSH_INTERVAL_MS と合わせる
const SPIN_POOL = ["cherry", "bell", "watermelon", "replay", "star", "treasure"]; // リール回転中に流す絵柄（見た目だけ）
const AUTO_TIME = 1 / 0.75;          // 自動スピンの時間倍率（速度0.75倍＝時間は約1.333倍ゆっくり）
const BASE_W = 460;
const LS_SCALE = "yuworld_scale", LS_SOUND = "yuworld_sound", LS_FX = "yuworld_fx";

let deps = null;
let rootEl = null;
let stylesInjected = false;
let audioCtx = null, masterGain = null;

function reduced() { try { return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (_) { return false; } }
function lsGet(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (_) {} }
/* 演出を派手に出すか（演出強め かつ 動きを減らす設定でない） */
function fxHigh() { return state.fxLevel === "high" && !reduced(); }

const state = {
  screen: "loading",
  published: false, isTopAdmin: false, open: true,
  clockOffset: 0,
  session: null, machine: null,
  balance: 0, freeSpins: 0,
  stats: { spins: 0, wins: 0, streak: 0 },
  feverUntil: 0,
  spinning: false, auto: false, busy: false,
  reels: [null, null, null], target: null, stopped: [false, false, false],
  reaching: false, awaitingFever: false, autoDriven: false,
  soundOn: lsGet(LS_SOUND) !== "off",
  fxLevel: lsGet(LS_FX) === "low" ? "low" : "high",
  scale: (() => { const v = lsGet(LS_SCALE); if (v === null || v === "fit") return "fit"; const n = parseFloat(v); return isFinite(n) ? n : "fit"; })(),
  effScale: 1,
  flushTimer: null, feverTimer: null, lobbyTimer: null, reelAnim: null
};
const $ = (sel) => rootEl && rootEl.querySelector(sel);

/* ---------- 起動・画面切り替え（script.js から呼ぶ） ---------- */
export function initYuWorld(options) { deps = options; rootEl = document.getElementById("yuworldRoot"); injectStyles(); }
export async function openYuWorldView() { if (!rootEl) return; if (state.screen !== "game") await loadConfigAndRender(); }
export async function stopYuWorldView() {
  stopFlushTimer(); stopFeverTimer(); stopLobbyTimer();
  if (state.session) { try { await settle(); } catch (_) {} }
}

/* ---------- Worker 呼び出し ---------- */
async function api(action, payload = {}) {
  const token = await deps.getToken();
  const res = await fetch(deps.endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ action, username: deps.getUsername(), ...payload })
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) { const e = new Error(json.error || `http_${res.status}`); e.code = json.error || `http_${res.status}`; e.detail = json; throw e; }
  return json;
}
function settleBeacon() {
  if (!state.session) return;
  try {
    const token = state.cachedToken; if (!token) return;
    fetch(deps.endpoint, { method: "POST", keepalive: true, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ action: "settle", username: deps.getUsername(), session: state.session }) }).catch(() => {});
  } catch (_) {}
}
function serverNow() { return Date.now() + state.clockOffset; }

/* ---------- 設定取得 → 画面を決める ---------- */
async function loadConfigAndRender() {
  state.screen = "loading"; render();
  let cfg;
  try { cfg = await api("config"); } catch (_) { cfg = { published: false, isTopAdmin: false, open: false }; }
  state.published = cfg.published === true;
  state.isTopAdmin = cfg.isTopAdmin === true;
  state.open = cfg.open !== false;
  if (typeof cfg.serverNowMs === "number") state.clockOffset = cfg.serverNowMs - Date.now();
  if (!state.published && !state.isTopAdmin) { state.screen = "preparing"; render(); return; }
  state.screen = "shop"; render();
}

/* ---------- 描画 ---------- */
function render() {
  if (!rootEl) return;
  if (state.screen === "loading") return renderMessage("読み込み中…", "");
  if (state.screen === "preparing") return renderMessage("🚧 現在準備中です", "このお店はまだ公開されていません。公開までもうしばらくお待ちください。");
  if (state.screen === "shop") return renderShop();
  if (state.screen === "lobby") return renderLobby();
  if (state.screen === "game") return renderGame();
}
function renderMessage(title, body) {
  rootEl.innerHTML = `<div class="yw-head"><h2>🎡 ゆうワールド</h2></div>
    <div class="yw-notice"><div class="yw-notice-title">${esc(title)}</div>${body ? `<p>${esc(body)}</p>` : ""}</div>`;
}
function renderShop() {
  const adminPanel = state.isTopAdmin ? `<div class="yw-admin"><span>管理者メニュー：ゆうスロの公開状態 <b>${state.published ? "公開中" : "非公開（準備中）"}</b></span>
      <button type="button" id="ywToggle" class="yw-btn yw-btn-sub">${state.published ? "非公開にする" : "公開する"}</button></div>` : "";
  rootEl.innerHTML = `<div class="yw-head"><h2>🎡 ゆうワールド</h2><p>お店をえらんで遊べます。コインはゆうChat共通です。</p></div>
    ${adminPanel}
    <div class="yw-shop-grid">
      <button type="button" class="yw-shop-card" id="ywOpenSlot">
        <div class="yw-shop-banner yw-slot-banner"><span>🎰</span></div>
        <div class="yw-shop-body"><div class="yw-shop-name">ゆうスロ${state.published ? "" : " <span class=\"yw-badge\">準備中</span>"}</div>
          <div class="yw-shop-desc">6台のスロット。777やオリジナル絵柄で大当たり＆FEVER！営業時間 7:00〜21:00。</div></div>
      </button>
    </div>`;
  $("#ywOpenSlot")?.addEventListener("click", () => { unlockAudio(); openLobby(); });
  $("#ywToggle")?.addEventListener("click", onTogglePublish);
}
async function onTogglePublish() {
  const next = !state.published;
  if (!confirm(next ? "ゆうスロを公開しますか？（一般ユーザーも遊べるようになります）" : "ゆうスロを非公開にしますか？（一般ユーザーは遊べなくなります）")) return;
  try { const r = await api("setConfig", { published: next }); state.published = r.published === true; render(); }
  catch (e) { alert("変更できませんでした（" + (e.code || "エラー") + "）"); }
}

/* ---------- ロビー ---------- */
async function openLobby() { state.screen = "lobby"; render(); await refreshLobby(); startLobbyTimer(); }
async function refreshLobby() {
  let lobby;
  try { lobby = await api("lobby"); }
  catch (e) { if (e.code === "not_published") { state.published = false; state.screen = "preparing"; render(); return; } renderLobbyError(); return; }
  state.open = lobby.open !== false;
  if (typeof lobby.serverNowMs === "number") state.clockOffset = lobby.serverNowMs - Date.now();
  state.lobbySeats = lobby.seats || {};
  if (state.screen === "lobby") render();
}
function renderLobby() {
  const seats = state.lobbySeats || {};
  const closedNote = state.open ? "" : `<div class="yw-notice-strip">⏰ ただいま営業時間外です（遊べるのは 7:00〜21:00）。</div>`;
  const cards = MACHINES.map((m) => {
    const s = seats[m.id] || { occupied: false };
    const busy = s.occupied && !s.mine;
    const label = busy ? `満席（${esc(s.name || "だれか")}）` : (s.mine ? "あなたが着席中" : "空いています");
    const canSit = state.open && !busy;
    return `<div class="yw-machine yw-tier${m.tier} ${busy ? "is-busy" : ""}">
        <div class="yw-machine-top"><span class="yw-machine-emoji">${m.emoji}</span><span class="yw-machine-tag">${esc(m.tag)}</span></div>
        <div class="yw-machine-name">${esc(m.name)}</div>
        <div class="yw-machine-price">1回 ${m.price} コイン</div>
        <div class="yw-machine-desc">${esc(m.desc)}</div>
        <div class="yw-machine-seat ${busy ? "busy" : s.mine ? "mine" : "free"}">${label}</div>
        <button type="button" class="yw-btn ${canSit ? "" : "yw-btn-disabled"}" data-sit="${m.id}" ${canSit ? "" : "disabled"}>${s.mine ? "続きから遊ぶ" : "この台で遊ぶ"}</button>
      </div>`;
  }).join("");
  rootEl.innerHTML = `<div class="yw-head"><button type="button" class="yw-back" id="ywBackShop">← お店の一覧</button><h2>🎰 ゆうスロ</h2>
      <p>台をえらんで着席してください。1台に1人まで、同時に6人まで遊べます。料金が高い台ほど演出が豪華です。</p></div>
    ${closedNote}<div class="yw-lobby-grid">${cards}</div>`;
  $("#ywBackShop")?.addEventListener("click", () => { stopLobbyTimer(); state.screen = "shop"; render(); });
  rootEl.querySelectorAll("[data-sit]").forEach((b) => b.addEventListener("click", () => { unlockAudio(); seat(b.getAttribute("data-sit")); }));
}
function renderLobbyError() {
  rootEl.innerHTML = `<div class="yw-head"><button type="button" class="yw-back" id="ywBackShop">← お店の一覧</button><h2>🎰 ゆうスロ</h2></div>
    <div class="yw-notice"><div class="yw-notice-title">読み込みに失敗しました</div><p>通信環境をご確認のうえ、もう一度お試しください。</p>
      <button type="button" class="yw-btn" id="ywRetry">もう一度</button></div>`;
  $("#ywBackShop")?.addEventListener("click", () => { state.screen = "shop"; render(); });
  $("#ywRetry")?.addEventListener("click", refreshLobby);
}

/* ---------- 着席 ---------- */
async function seat(machineId) {
  if (state.busy) return;
  state.busy = true;
  try {
    state.cachedToken = await deps.getToken();
    const r = await api("seat", { machine: machineId });
    state.session = r.session;
    state.machine = MACHINE_BY_ID[machineId];
    state.balance = Number(r.balance || r.startCoins || 0);
    state.freeSpins = Number(r.freeSpins || 0);
    state.stats = { spins: 0, wins: 0, streak: 0 };
    state.feverUntil = 0; state.auto = false; state.spinning = false;
    state.reaching = false; state.awaitingFever = false;
    state.reels = [null, null, null]; state.target = null; state.stopped = [false, false, false];
    if (typeof r.serverNowMs === "number") state.clockOffset = r.serverNowMs - Date.now();
    stopLobbyTimer();
    state.screen = "game"; render(); startFlushTimer();
  } catch (e) {
    if (e.code === "seat_taken") alert("ほかの人が先に着席しました。別の台をお選びください。");
    else if (e.code === "not_published") { state.published = false; state.screen = "preparing"; render(); }
    else if (e.code === "closed") { state.open = false; alert("ただいま営業時間外です（7:00〜21:00）。"); refreshLobby(); }
    else alert("着席できませんでした（" + (e.code || "エラー") + "）");
  } finally { state.busy = false; }
}

/* ---------- 台での遊び画面 ---------- */
function renderGame() {
  const m = state.machine;
  rootEl.innerHTML = `
    <div class="yw-topbar">
      <div class="yw-zoombar">
        <button type="button" class="yw-ctl" id="ywZoomOut" aria-label="縮小">－</button>
        <button type="button" class="yw-ctl yw-ctl-fit" id="ywZoomFit">画面に合わせる</button>
        <button type="button" class="yw-ctl" id="ywZoomIn" aria-label="拡大">＋</button>
      </div>
      <div class="yw-optbar">
        <button type="button" class="yw-ctl yw-fx ${state.fxLevel}" id="ywFx">${state.fxLevel === "high" ? "✨ 演出 強" : "🍃 演出 弱"}</button>
        <button type="button" class="yw-ctl yw-sound ${state.soundOn ? "on" : "off"}" id="ywSound">${state.soundOn ? "🔊 音 ON" : "🔇 音 OFF"}</button>
      </div>
    </div>
    <div class="yw-zoomwrap" id="ywZoomWrap">
      <div class="yw-zoom" id="ywZoom">
        <div class="yw-game yw-tier${m.tier} yw-m-${m.id} ${isFever() ? "is-fever" : ""}" id="ywGame">
          <div class="yw-game-head">
            <button type="button" class="yw-exit" id="ywExit">やめる</button>
            <div class="yw-game-title">${m.emoji} ${esc(m.name)}</div>
            <div class="yw-balance">💰 <span id="ywBalance">${state.balance.toLocaleString()}</span></div>
          </div>
          <div class="yw-fever-banner" id="ywFever">🌈 FEVER 🌈</div>
          <div class="yw-reels" id="ywReels">
            ${[0, 1, 2].map((i) => `<div class="yw-reel" id="ywReel${i}"><div class="yw-cell top" id="ywT${i}"></div><div class="yw-cell center" id="ywC${i}"></div><div class="yw-cell bot" id="ywB${i}"></div></div>`).join("")}
            <div class="yw-payline"></div>
          </div>
          <div class="yw-msg" id="ywMsg"></div>
          <div class="yw-feverstart-slot" id="ywFeverStartSlot"></div>
          <div class="yw-stops">
            ${[0, 1, 2].map((i) => `<button type="button" class="yw-stop" id="ywStop${i}" disabled>STOP</button>`).join("")}
          </div>
          <div class="yw-controls">
            <button type="button" class="yw-spin" id="ywSpin">スピン（${m.price}）</button>
            <button type="button" class="yw-auto" id="ywAuto">自動：OFF</button>
          </div>
          <div class="yw-free" id="ywFree"></div>
          <div class="yw-stats">
            <div><span>今日の回数</span><b id="ywStatSpins">0</b></div>
            <div><span>当たり</span><b id="ywStatWins">0</b></div>
            <div><span>連勝</span><b id="ywStatStreak">0</b></div>
          </div>
        </div>
      </div>
    </div>`;
  for (let i = 0; i < 3; i++) { setCell(i, state.reels[i] || SPIN_POOL[i]); setNeighbors(i); }
  $("#ywExit")?.addEventListener("click", onExit);
  $("#ywSpin")?.addEventListener("click", () => { unlockAudio(); startSpin(false); });
  $("#ywAuto")?.addEventListener("click", toggleAuto);
  $("#ywSound")?.addEventListener("click", toggleSound);
  $("#ywFx")?.addEventListener("click", toggleFx);
  $("#ywZoomOut")?.addEventListener("click", () => nudgeScale(-0.1));
  $("#ywZoomIn")?.addEventListener("click", () => nudgeScale(0.1));
  $("#ywZoomFit")?.addEventListener("click", () => { state.scale = "fit"; lsSet(LS_SCALE, "fit"); applyScale(); });
  for (let i = 0; i < 3; i++) $("#ywStop" + i)?.addEventListener("click", () => stopReel(i));
  updateStats(); updateFreeLabel(); updateFeverUI();
  applyScale(); requestAnimationFrame(applyScale);
}

/* ---------- 拡大・縮小 ---------- */
function applyScale() {
  const zoom = $("#ywZoom"), wrap = $("#ywZoomWrap");
  if (!zoom || !wrap) return;
  const avail = wrap.clientWidth || BASE_W;
  let s = state.scale === "fit" ? avail / BASE_W : state.scale;
  s = Math.max(0.6, Math.min(2.4, s));
  state.effScale = s;
  zoom.style.transform = `scale(${s})`;
  wrap.style.height = Math.ceil(zoom.offsetHeight * s) + "px";
}
function nudgeScale(d) { const cur = state.effScale || 1; state.scale = Math.max(0.6, Math.min(2.4, Math.round((cur + d) * 100) / 100)); lsSet(LS_SCALE, String(state.scale)); applyScale(); }

function symbolInner(sym, machineId) {
  if (sym === "orig") { const src = ORIG_IMAGES[machineId]; return src ? `<img src="${src}" alt="オリジナル絵柄" class="yw-sym-img">` : "🎴"; }
  if (sym === "triple7") return `<span class="yw-sym-7">7</span>`;
  if (sym === "replay") return `<span class="yw-sym-replay">RE<br>PLAY</span>`;
  return `<span class="yw-sym-emoji">${SYMBOL_EMOJI[sym] || "❔"}</span>`;
}
function setCell(i, sym) { const el = $("#ywC" + i); if (el) el.innerHTML = symbolInner(sym, state.machine.id); }
function randSym() { return SPIN_POOL[Math.floor(Math.random() * SPIN_POOL.length)]; }
function setNeighbors(i) { const t = $("#ywT" + i), b = $("#ywB" + i); if (t) t.innerHTML = symbolInner(randSym(), state.machine.id); if (b) b.innerHTML = symbolInner(randSym(), state.machine.id); }
function resetReelFx() {
  for (let i = 0; i < 3; i++) { const r = $("#ywReel" + i); if (r) r.classList.remove("yw-reach", "yw-reach-strong", "yw-specialhit"); }
  const reels = $("#ywReels"); if (reels) reels.classList.remove("yw-reach-dim", "yw-zoomfx", "yw-win");
}

function canAfford() { return state.freeSpins > 0 || state.balance >= state.machine.price; }

async function startSpin(autoDriven) {
  if (state.spinning || state.busy || state.awaitingFever) return;
  if (!state.open) { showMsg("営業時間外です（7:00〜21:00）。", "warn"); stopAuto(); return; }
  if (!canAfford()) { showMsg("コインが足りません。", "warn"); stopAuto(); return; }
  state.spinning = true; state.busy = true; state.reaching = false;
  state.autoDriven = !!(autoDriven || state.auto);
  resetReelFx();
  showMsg("", "");
  setSpinEnabled(false);
  startReelAnimation();
  let r;
  try { r = await api("spin", { session: state.session }); }
  catch (e) { stopReelAnimation(); state.spinning = false; state.busy = false; handleSpinError(e); return; }
  state.session = r.session;
  const spin = r.spin;
  state.target = spin.center; state.stopped = [false, false, false]; state.busy = false;
  for (let i = 0; i < 3; i++) { const b = $("#ywStop" + i); if (b) b.disabled = false; }
  state.pendingSpin = spin;
  sfxSpinStart();
  if (state.auto) scheduleAutoStops();
}
function handleSpinError(e) {
  if (e.code === "no_funds") { showMsg("コインが足りません。", "warn"); stopAuto(); setSpinEnabled(true); return; }
  if (e.code === "closed") { state.open = false; showMsg("営業時間が終了しました（21:00）。精算して退出します。", "warn"); stopAuto(); finishAndExitSoon(); return; }
  if (e.code === "day_rollover" || e.code === "session_expired") { showMsg("セッションが切り替わりました。精算して退出します。", "warn"); stopAuto(); finishAndExitSoon(); return; }
  if (e.code === "not_published") { showMsg("ただいま非公開になりました。精算して退出します。", "warn"); stopAuto(); finishAndExitSoon(); return; }
  if (e.code === "bad_session") { showMsg("セッションが無効です。もう一度着席してください。", "warn"); stopAuto(); backToLobbySoon(); return; }
  showMsg("通信エラーです。もう一度お試しください。", "warn"); stopAuto(); setSpinEnabled(true);
}

function startReelAnimation() {
  stopReelAnimation();
  const interval = Math.round(70 * (state.autoDriven ? AUTO_TIME : 1));
  state.reelAnim = setInterval(() => { for (let i = 0; i < 3; i++) if (!state.stopped[i]) { setCell(i, randSym()); setNeighbors(i); } }, interval);
}
function stopReelAnimation() { if (state.reelAnim) { clearInterval(state.reelAnim); state.reelAnim = null; } }
function scheduleAutoStops() { const k = AUTO_TIME; [0, 1, 2].forEach((i) => setTimeout(() => stopReel(i), Math.round((350 + i * 300) * k))); }

function stopReel(i) {
  if (!state.spinning || state.stopped[i] || !state.target || state.reaching) return;
  const others = [0, 1, 2].filter((x) => x !== i);
  const isLast = others.every((x) => state.stopped[x]);
  // 最後の1リールで、止まった2つが同じ絵柄＝リーチ（FEVER中は果物が毎回揃うので演出しない）
  if (isLast && !isFever()) {
    const a = state.reels[others[0]], b = state.reels[others[1]];
    if (a != null && a === b) { state.reaching = true; runReachReveal(i, a === specialSymOf(state.machine), a); return; }
  }
  finalizeStop(i);
}

/* リーチのスロー演出。strong＝特別絵柄（777/オリジナル）のリーチは大きくゆっくり。結果（確定値）は変えない */
function runReachReveal(i, strong, pairSym) {
  const reel = $("#ywReel" + i), reels = $("#ywReels");
  const b = $("#ywStop" + i); if (b) b.disabled = true;
  if (reel) reel.classList.add(strong ? "yw-reach-strong" : "yw-reach");
  if (reels) reels.classList.add("yw-reach-dim");
  stopReelAnimation();
  const rdc = reduced();
  const base = strong ? 1500 : (fxHigh() ? 380 : 240);
  const dur = rdc ? (strong ? 450 : 160) : base;
  const slowMs = strong ? (rdc ? 150 : 190) : 90;
  const slow = setInterval(() => { setCell(i, randSym()); setNeighbors(i); }, slowMs);
  if (!rdc) {
    if (strong) { sfxReachTicks(dur); burstSparkles(reel, fxHigh() ? 12 : 6, "reach"); if (reels && fxHigh()) reels.classList.add("yw-zoomfx"); if (fxHigh()) screenFlash(dur, "fever"); }
    else sfxReachTick1();
  }
  setTimeout(() => {
    clearInterval(slow);
    if (reel) reel.classList.remove("yw-reach", "yw-reach-strong");
    if (reels) reels.classList.remove("yw-reach-dim", "yw-zoomfx");
    finalizeStop(i);
  }, dur);
}

function finalizeStop(i) {
  state.stopped[i] = true;
  state.reels[i] = state.target[i];
  setCell(i, state.target[i]); setNeighbors(i);
  const cell = $("#ywC" + i);
  if (cell) { cell.classList.remove("yw-bounce"); void cell.offsetWidth; cell.classList.add("yw-bounce"); }
  const b = $("#ywStop" + i); if (b) b.disabled = true;
  sfxReelStop(i);
  const sp = specialSymOf(state.machine);
  const stoppedCount = state.stopped.filter(Boolean).length;
  if (state.target[i] === sp && stoppedCount < 3 && !isFever()) {
    // 特別絵柄が止まった（まだ最後でない）→ 1つ目・2つ目と段階的に期待演出を強める
    const reel = $("#ywReel" + i); if (reel) reel.classList.add("yw-specialhit");
    if (!reduced()) { burstSparkles($("#ywReel" + i), fxHigh() ? 8 : 4, "big"); sfxSpecialTease(stoppedCount); }
  } else if (!reduced()) {
    burstSparkles($("#ywReel" + i), fxHigh() ? 4 : 2, "stop");
  }
  if (state.stopped[0] && state.stopped[1] && state.stopped[2]) finishSpin();
}

function finishSpin() {
  stopReelAnimation();
  state.spinning = false; state.reaching = false;
  const spin = state.pendingSpin; state.pendingSpin = null;
  if (!spin) { setSpinEnabled(true); return; }
  state.stats = { spins: spin.spins, wins: spin.wins, streak: spin.streak };
  state.freeSpins = spin.freeSpins;
  state.feverUntil = spin.feverUntil || 0;
  animateBalance(state.balance, spin.balance);
  state.balance = spin.balance;
  updateStats(); updateFreeLabel();

  if (spin.feverPending) {
    // 特別役の当たり。自動を止めて余韻を楽しみ、自分で FEVER を開始する
    stopAuto();
    sfxSpecial();
    showMsg(spin.center[0] === "triple7" ? "🎉 7 7 7 大当たり！" : "🎉 オリジナル絵柄で大当たり！", "big");
    celebrate("special");
    state.awaitingFever = true;
    renderFeverStartButton();
    setSpinEnabled(false);
    return;
  }
  updateFeverUI();
  if (isFever()) { showMsg("", ""); if (fxHigh()) burstSparkles($("#ywReels"), 4, "fever"); }
  else if (spin.result === "treasure") { sfxTreasure(); showMsg(`🎁 宝箱から ${spin.prize} コイン！`, "win"); treasureOpen(spin.prize); }
  else if (spin.result === "star") { sfxStar(); showMsg("⭐ 星が揃った！無料スピン +5", "win"); if (!reduced()) burstSparkles($("#ywReels"), fxHigh() ? 10 : 5, "stop"); }
  else if (spin.result === "replay") { sfxReplay(); showMsg("🔄 REPLAY！無料でもう1回", "win"); }
  else if (spin.coinWin) { sfxWin(); showMsg(`やったね！+${spin.payout}`, "win"); celebrate("win"); }
  else { /* ハズレ */ }

  const autoDriven = state.auto;
  const keepGoing = autoDriven || state.freeSpins > 0;
  setSpinEnabled(true);
  if (keepGoing && state.open && canAfford()) {
    const base = isFever() ? 260 : 420;
    scheduleNextSpin(autoDriven ? Math.round(base * AUTO_TIME) : base);
  } else if (!canAfford()) { stopAuto(); if (state.freeSpins === 0) showMsg("コインが足りません。", state.balance > 0 ? "" : "warn"); }
}

function scheduleNextSpin(delay) {
  setTimeout(() => {
    if (state.screen !== "game" || state.spinning || state.awaitingFever) return;
    if (!(state.auto || state.freeSpins > 0)) return;
    if (!state.open || !canAfford()) { if (!canAfford()) stopAuto(); return; }
    if (state.busy) { scheduleNextSpin(120); return; }
    startSpin(true);
  }, delay);
}

function setSpinEnabled(on) {
  const b = $("#ywSpin"); if (!b) return;
  const usable = on && !state.spinning && !state.awaitingFever && state.open && canAfford();
  b.disabled = !usable;
  b.textContent = state.freeSpins > 0 ? `スピン（無料 残り${state.freeSpins}）` : `スピン（${state.machine.price}）`;
}
function toggleAuto() {
  if (state.awaitingFever) return;
  state.auto = !state.auto;
  const b = $("#ywAuto"); if (b) { b.textContent = "自動：" + (state.auto ? "ON" : "OFF"); b.classList.toggle("on", state.auto); }
  if (state.auto && !state.spinning && state.open && canAfford()) scheduleNextSpin(0);
}
function stopAuto() { state.auto = false; const b = $("#ywAuto"); if (b) { b.textContent = "自動：OFF"; b.classList.remove("on"); } }
function toggleFx() {
  state.fxLevel = state.fxLevel === "high" ? "low" : "high";
  lsSet(LS_FX, state.fxLevel);
  const b = $("#ywFx"); if (b) { b.textContent = state.fxLevel === "high" ? "✨ 演出 強" : "🍃 演出 弱"; b.classList.toggle("high", state.fxLevel === "high"); b.classList.toggle("low", state.fxLevel === "low"); }
}

/* ---------- FEVER 開始（ユーザー操作。サーバーがタイマーを立てる。連打しても二重開始しない） ---------- */
function renderFeverStartButton() {
  const slot = $("#ywFeverStartSlot"); if (!slot) return;
  slot.innerHTML = `<button type="button" class="yw-feverstart" id="ywFeverStartBtn">✨ FEVER START！ ✨</button>`;
  slot.querySelector("#ywFeverStartBtn")?.addEventListener("click", onFeverStart);
}
function removeFeverStartButton() { const slot = $("#ywFeverStartSlot"); if (slot) slot.innerHTML = ""; }
async function onFeverStart() {
  if (state.busy || !state.session) return;
  const btn = $("#ywFeverStartBtn"); if (btn) btn.disabled = true; // 連打防止（サーバーも feverPending を一度だけ消費）
  state.busy = true; unlockAudio();
  let r;
  try { r = await api("feverStart", { session: state.session }); }
  catch (e) { state.busy = false; if (btn) btn.disabled = false; showMsg("もう一度お試しください。", "warn"); return; }
  state.session = r.session;
  if (typeof r.serverNowMs === "number") state.clockOffset = r.serverNowMs - Date.now();
  state.feverUntil = r.feverUntil || 0;
  state.busy = false; state.awaitingFever = false;
  removeFeverStartButton();
  sfxFever();
  updateFeverUI();
  if (!reduced()) celebrate("fever");
  showMsg("🌈 FEVER！ 自動回転ボタンでもどうぞ", "fever");
  setSpinEnabled(true);
}

/* ---------- FEVER 表示 ---------- */
function isFever() { return state.feverUntil > serverNow(); }
function updateFeverUI() {
  const g = $("#ywGame"), fb = $("#ywFever");
  const on = isFever();
  if (g) g.classList.toggle("is-fever", on);
  if (fb) fb.style.display = on ? "block" : "none";
  feverOverlay(on); // FEVER中は画面全体を虹色に（演出強めのときだけ）
  stopFeverTimer();
  if (on) state.feverTimer = setInterval(() => { if (!isFever()) { stopFeverTimer(); const gg = $("#ywGame"); if (gg) gg.classList.remove("is-fever"); const f = $("#ywFever"); if (f) f.style.display = "none"; feverOverlay(false); } }, 400);
}

/* ---------- 退出・精算 ---------- */
async function onExit() { if (!confirm("この台をやめますか？（コインは反映されます）")) return; await finishAndExit(); }
function finishAndExitSoon() { setTimeout(() => finishAndExit(), 1200); }
function backToLobbySoon() { clearScreenFx(); setTimeout(async () => { state.session = null; await openLobby(); }, 1200); }
async function finishAndExit() {
  stopAuto(); stopFlushTimer(); stopFeverTimer(); clearScreenFx();
  state.awaitingFever = false;
  const sess = state.session; state.session = null;
  if (sess) { try { const r = await api("settle", { session: sess }); if (typeof r.finalBalance === "number") state.balance = r.finalBalance; } catch (_) {} }
  if (typeof deps.onSettled === "function") { try { deps.onSettled(state.balance); } catch (_) {} }
  await openLobby();
}
async function settle() {
  clearScreenFx();
  const sess = state.session; state.session = null; state.screen = "shop"; state.awaitingFever = false;
  if (sess) { try { await api("settle", { session: sess }); } catch (_) {} }
  if (typeof deps.onSettled === "function") { try { deps.onSettled(state.balance); } catch (_) {} }
}

/* ---------- 約15秒ごとの flush ---------- */
function startFlushTimer() { stopFlushTimer(); state.flushTimer = setInterval(doFlush, FLUSH_INTERVAL_MS); }
function stopFlushTimer() { if (state.flushTimer) { clearInterval(state.flushTimer); state.flushTimer = null; } }
async function doFlush() {
  if (!state.session || state.busy) return; // スピン/FEVER開始の Worker 呼び出しと同時に session を書き換えない（排他）
  state.busy = true;
  try {
    state.cachedToken = await deps.getToken();
    const r = await api("flush", { session: state.session });
    state.session = r.session;
  } catch (e) {
    if (e.code === "seat_lost") { stopFlushTimer(); stopAuto(); showMsg("席が解放されました。ロビーに戻ります。", "warn"); backToLobbySoon(); }
  } finally { state.busy = false; }
}
function startLobbyTimer() { stopLobbyTimer(); state.lobbyTimer = setInterval(() => { if (state.screen === "lobby") refreshLobby(); }, 8000); }
function stopLobbyTimer() { if (state.lobbyTimer) { clearInterval(state.lobbyTimer); state.lobbyTimer = null; } }
function stopFeverTimer() { if (state.feverTimer) { clearInterval(state.feverTimer); state.feverTimer = null; } }

/* ---------- 小さな表示ヘルパー ---------- */
function updateStats() { const s = state.stats; const a = $("#ywStatSpins"); if (a) a.textContent = s.spins; const b = $("#ywStatWins"); if (b) b.textContent = s.wins; const c = $("#ywStatStreak"); if (c) c.textContent = s.streak; }
function updateFreeLabel() { const el = $("#ywFree"); if (el) el.textContent = state.freeSpins > 0 ? `無料スピン 残り ${state.freeSpins} 回` : ""; }
function showMsg(text, kind) { const el = $("#ywMsg"); if (!el) return; el.textContent = text || ""; el.className = "yw-msg" + (kind ? " " + kind : ""); }
function flashWin() { const g = $("#ywReels"); if (g) { g.classList.remove("yw-win"); void g.offsetWidth; g.classList.add("yw-win"); } }
function animateBalance(from, to) {
  const el = $("#ywBalance"); if (!el) return;
  if (from === to) { el.textContent = to.toLocaleString(); return; }
  const start = performance.now(), dur = 500;
  const step = (t) => { const k = Math.min(1, (t - start) / dur); el.textContent = Math.round(from + (to - from) * k).toLocaleString(); if (k < 1) requestAnimationFrame(step); };
  requestAnimationFrame(step);
  setTimeout(() => { el.textContent = to.toLocaleString(); }, dur + 80);
}
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

/* ---------- キラキラ演出（CSS・JavaScriptだけ。Firebase通信は増やさない。演出強弱・reduced-motion を尊重） ---------- */
function burstSparkles(container, n, kind) {
  if (!container || reduced()) return;
  const count = Math.min(fxHigh() ? n : Math.ceil(n / 2), 20);
  for (let k = 0; k < count; k++) {
    const sp = document.createElement("span");
    sp.className = "yw-spark yw-spark-" + (kind || "stop");
    sp.style.left = (6 + Math.random() * 88) + "%";
    sp.style.top = (6 + Math.random() * 88) + "%";
    sp.style.animationDelay = (Math.random() * 0.2).toFixed(2) + "s";
    container.appendChild(sp);
    setTimeout(() => sp.remove(), 1000);
  }
}
function coinRain(n) {
  const g = $("#ywGame"); if (!g || reduced()) return;
  const count = Math.min(fxHigh() ? n : Math.ceil(n / 2), 28);
  for (let k = 0; k < count; k++) {
    const c = document.createElement("span");
    c.className = "yw-coin"; c.textContent = "🪙";
    c.style.left = (6 + Math.random() * 88) + "%";
    c.style.animationDelay = (Math.random() * 0.5).toFixed(2) + "s";
    c.style.fontSize = (16 + Math.random() * 14) + "px";
    g.appendChild(c);
    setTimeout(() => c.remove(), 1600);
  }
}
function celebrate(kind) {
  flashWin();
  if (reduced()) return;
  const reels = $("#ywReels"), g = $("#ywGame"), tier = state.machine.tier;
  const big = kind === "special" || kind === "fever";
  const n = (kind === "fever" ? 20 : kind === "special" ? 18 : 10) + (fxHigh() ? tier * 3 : 0);
  burstSparkles(reels, n, kind === "fever" ? "fever" : "big");
  coinRain((kind === "special" ? 14 : kind === "fever" ? 16 : 8) + tier * 2);
  if (g) { g.classList.remove("yw-celebrate"); void g.offsetWidth; g.classList.add("yw-celebrate"); setTimeout(() => g.classList.remove("yw-celebrate"), 1300); }
  // 演出強め：画面全体を虹色でチカチカ＋画面シェイク（光過敏の配慮で reduced-motion／演出弱めでは出さない）
  if (fxHigh()) {
    screenFlash(big ? (kind === "fever" ? 1400 : 1100) : 600, kind === "fever" ? "fever" : "win");
    if (big) screenShake();
    if (kind === "special" && tier >= 6) { burstSparkles(reels, 16, "fever"); coinRain(14); } // ジャックポットは別格
  }
}
function treasureOpen(prize) {
  if (reduced()) return;
  burstSparkles($("#ywReels"), fxHigh() ? 14 : 5, "big");
  coinRain(Math.min(24, 8 + Math.round((prize || 3) / 2)));
  if (fxHigh()) screenFlash(800, "win");
}

/* ---------- 全画面のド派手演出（演出強めのときだけ・reduced-motion では出さない） ---------- */
function screenFxEl() {
  let el = document.getElementById("yw-screen-fx");
  if (!el) { el = document.createElement("div"); el.id = "yw-screen-fx"; (document.body || document.documentElement).appendChild(el); }
  return el;
}
let screenFlashTimer = null;
function screenFlash(ms, kind) {
  if (!fxHigh() || reduced()) return;
  const el = screenFxEl();
  el.classList.remove("flash-win", "flash-fever");
  void el.offsetWidth;
  el.classList.add(kind === "fever" ? "flash-fever" : "flash-win");
  clearTimeout(screenFlashTimer);
  screenFlashTimer = setTimeout(() => { el.classList.remove("flash-win", "flash-fever"); }, ms);
}
function screenShake() {
  if (!fxHigh() || reduced()) return;
  const g = $("#ywGame"); if (!g) return;
  g.classList.remove("yw-shake"); void g.offsetWidth; g.classList.add("yw-shake");
  setTimeout(() => g.classList.remove("yw-shake"), 700);
}
function feverOverlay(on) {
  const el = screenFxEl();
  if (on && fxHigh() && !reduced()) el.classList.add("fever-on"); else el.classList.remove("fever-on");
}
function clearScreenFx() {
  const el = document.getElementById("yw-screen-fx");
  if (el) el.classList.remove("flash-win", "flash-fever", "fever-on");
  clearTimeout(screenFlashTimer);
}

/* ---------- 音（オリジナル。既存の有名スロットの音はコピーしない。iOSは操作後に解禁） ---------- */
function ensureAudio() {
  try {
    if (!audioCtx) { const C = window.AudioContext || window.webkitAudioContext; if (!C) return; audioCtx = new C(); masterGain = audioCtx.createGain(); masterGain.connect(audioCtx.destination); }
    masterGain.gain.value = state.soundOn ? 1 : 0;
    if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
  } catch (_) { audioCtx = null; masterGain = null; }
}
function unlockAudio() { if (state.soundOn) ensureAudio(); }
function playTone(noteDur, vol, type, when) {
  if (!state.soundOn) return;
  ensureAudio();
  if (!audioCtx || !masterGain) return;
  try {
    const [freq, dur] = noteDur;
    const osc = audioCtx.createOscillator(), gain = audioCtx.createGain();
    osc.type = type || "sine"; osc.frequency.value = freq;
    const t0 = audioCtx.currentTime + (when || 0);
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(vol == null ? 0.03 : vol, t0 + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain); gain.connect(masterGain);
    osc.start(t0); osc.stop(t0 + dur + 0.02);
  } catch (_) {}
}
function playSeq(notes, vol, type, spacing) { const sp = spacing == null ? 0.09 : spacing; notes.forEach((nd, i) => playTone(nd, vol, type, i * sp)); }
function tierVol(base) { return base + (state.machine ? state.machine.tier : 1) * 0.002; }
function sfxSpinStart() { playTone([440, 0.05], 0.018, "sine"); }
function sfxReelStop(i) { const t = state.machine ? state.machine.tier : 1; playTone([360 - i * 25, 0.05], 0.014 + t * 0.001, t >= 4 ? "triangle" : "sine"); }
function sfxReplay() { playSeq([[520, 0.09], [660, 0.11]], 0.02, "sine", 0.08); }
function sfxStar() { playSeq([[700, 0.1], [900, 0.12], [1120, 0.16]], 0.026, "triangle", 0.1); }
function sfxWin() { const t = state.machine.tier; const notes = [[660, 0.12], [880, 0.14]]; if (t >= 3) notes.push([1046, 0.16]); if (t >= 5) notes.push([1318, 0.18]); playSeq(notes, tierVol(0.028), "triangle", 0.09); }
function sfxTreasure() { playSeq([[500, 0.1], [700, 0.12], [950, 0.16], [1200, 0.2]], tierVol(0.03), "triangle", 0.1); }
function sfxSpecial() { const t = state.machine.tier; const notes = [[523, 0.12], [659, 0.12], [784, 0.14], [1047, 0.24]]; if (t >= 3) notes.push([1319, 0.24]); if (t >= 5) notes.push([1568, 0.3]); playSeq(notes, tierVol(0.037), "square", 0.12); }
function sfxFever() { playSeq([[392, 0.12], [523, 0.12], [659, 0.14], [784, 0.16], [988, 0.18], [1175, 0.3]], tierVol(0.042), "square", 0.1); }
function sfxReachTick1() { playTone([620, 0.08], 0.02, "square"); }
function sfxSpecialTease(level) { playTone([700 + level * 160, 0.12], 0.024 + level * 0.006, "square"); }
function sfxReachTicks(durMs) { const t = state.machine.tier, beats = Math.max(4, Math.floor(durMs / 230)); for (let k = 0; k < beats; k++) playTone([480 + k * 75, 0.09], 0.02 + t * 0.001, "square", k * (durMs / 1000 / beats)); }

function toggleSound() {
  state.soundOn = !state.soundOn;
  lsSet(LS_SOUND, state.soundOn ? "on" : "off");
  if (state.soundOn) ensureAudio();
  else if (masterGain && audioCtx) { try { masterGain.gain.cancelScheduledValues(audioCtx.currentTime); masterGain.gain.value = 0; } catch (_) {} }
  const b = $("#ywSound");
  if (b) { b.textContent = state.soundOn ? "🔊 音 ON" : "🔇 音 OFF"; b.classList.toggle("on", state.soundOn); b.classList.toggle("off", !state.soundOn); }
}

/* ---------- スタイル ---------- */
function injectStyles() {
  if (stylesInjected) return; stylesInjected = true;
  const css = `
  .yuworld-root { padding: 12px 14px 28px; max-width: 760px; margin: 0 auto; }
  .yw-head h2 { margin: 6px 0 4px; font-size: 20px; }
  .yw-head p { margin: 0 0 10px; color: #666; font-size: 13px; }
  .yw-back { background: none; border: none; color: #4a7; font-size: 14px; cursor: pointer; padding: 4px 0; }
  .yw-notice { background: #fff; border-radius: 14px; padding: 28px 18px; text-align: center; box-shadow: 0 6px 24px rgba(0,0,0,.06); }
  .yw-notice-title { font-size: 20px; font-weight: 800; margin-bottom: 8px; }
  .yw-notice p { color: #666; font-size: 14px; line-height: 1.8; margin: 0 0 12px; }
  .yw-notice-strip { background: #fff3e0; color: #a65; border-radius: 10px; padding: 8px 12px; font-size: 13px; margin: 8px 0; text-align: center; }
  .yw-admin { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: space-between; background: #f3f6ff; border: 1px solid #dde6ff; border-radius: 12px; padding: 10px 12px; margin-bottom: 12px; font-size: 13px; }
  .yw-shop-grid, .yw-lobby-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; }
  .yw-shop-card { text-align: left; border: none; background: #fff; border-radius: 16px; overflow: hidden; box-shadow: 0 6px 24px rgba(0,0,0,.08); cursor: pointer; padding: 0; }
  .yw-shop-banner { height: 110px; display: flex; align-items: center; justify-content: center; font-size: 54px; }
  .yw-slot-banner { background: linear-gradient(135deg, #7b2ff7, #f107a3); }
  .yw-shop-body { padding: 12px 14px 16px; }
  .yw-shop-name { font-weight: 800; font-size: 16px; margin-bottom: 4px; }
  .yw-shop-desc { color: #666; font-size: 12.5px; line-height: 1.6; }
  .yw-badge { background: #ff3b30; color: #fff; font-size: 11px; border-radius: 6px; padding: 1px 6px; vertical-align: middle; }
  .yw-machine { background: #fff; border-radius: 14px; padding: 14px; box-shadow: 0 4px 16px rgba(0,0,0,.06); display: flex; flex-direction: column; border-top: 4px solid #cfd6e4; }
  .yw-machine.is-busy { opacity: .7; }
  .yw-machine.yw-tier2 { border-top-color: #e3b341; }
  .yw-machine.yw-tier3 { border-top-color: #9b6cff; }
  .yw-machine.yw-tier4 { border-top-color: #e0902f; }
  .yw-machine.yw-tier5 { border-top: 4px solid transparent; border-image: linear-gradient(90deg,#ff0080,#ff8c00,#ffee00,#00c853,#00b0ff,#aa00ff) 1; }
  .yw-machine.yw-tier6 { border-top: 4px solid transparent; border-image: linear-gradient(90deg,#ffd700,#ff0080,#00b0ff,#ffd700) 1; box-shadow: 0 6px 22px rgba(224,144,47,.25); }
  .yw-machine-top { display: flex; justify-content: space-between; align-items: center; }
  .yw-machine-emoji { font-size: 30px; }
  .yw-machine-tag { background: #eef; color: #557; font-size: 11px; border-radius: 6px; padding: 2px 7px; }
  .yw-machine-name { font-weight: 800; font-size: 16px; margin: 6px 0 2px; }
  .yw-machine-price { color: #4a7; font-weight: 700; font-size: 13px; }
  .yw-machine-desc { color: #777; font-size: 12px; line-height: 1.6; margin: 6px 0 10px; flex: 1; }
  .yw-machine-seat { font-size: 12px; border-radius: 8px; padding: 4px 8px; text-align: center; margin-bottom: 8px; }
  .yw-machine-seat.free { background: #e8f8ee; color: #2a7; }
  .yw-machine-seat.busy { background: #fdeceb; color: #c44; }
  .yw-machine-seat.mine { background: #fff6e0; color: #a80; }
  .yw-btn { border: none; border-radius: 10px; background: #4a7; color: #fff; font-weight: 700; padding: 10px; cursor: pointer; font-size: 14px; }
  .yw-btn-sub { background: #667; }
  .yw-btn-disabled, .yw-btn:disabled { background: #bbb; cursor: not-allowed; }

  .yw-topbar { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
  .yw-zoombar, .yw-optbar { display: flex; gap: 6px; }
  .yw-ctl { border: 1px solid #d5d9e4; background: #fff; color: #334; border-radius: 9px; padding: 7px 10px; font-size: 13px; font-weight: 700; cursor: pointer; min-width: 40px; }
  .yw-ctl:active { transform: translateY(1px); }
  .yw-ctl-fit { min-width: auto; }
  .yw-fx.high { background: #fff3d6; color: #a76a00; border-color: #ffdf9e; }
  .yw-fx.low { background: #eef7ee; color: #3a7; border-color: #cfe8cf; }
  .yw-sound.on { background: #e8f8ee; color: #2a7; border-color: #bfe8cf; }
  .yw-sound.off { background: #f1f1f4; color: #999; }
  .yw-zoomwrap { overflow-x: auto; overflow-y: hidden; display: flex; justify-content: center; }
  .yw-zoom { width: ${BASE_W}px; transform-origin: top center; flex: 0 0 auto; }

  .yw-game { position: relative; overflow: hidden; background: linear-gradient(180deg, #1b1b2e, #2a2a44); border-radius: 18px; padding: 14px; color: #fff; --yw-accent: #9fb3d6; --yw-glow: rgba(255,210,74,.9); }
  .yw-game.yw-tier2 { background: linear-gradient(180deg,#2a2412,#3a2f16); --yw-accent: #ffcf5a; --yw-glow: rgba(255,207,90,.95); box-shadow: inset 0 0 0 2px rgba(255,207,90,.35); }
  .yw-game.yw-tier3 { background: linear-gradient(180deg,#201438,#2f1d5a); --yw-accent: #b98bff; --yw-glow: rgba(185,139,255,.95); box-shadow: inset 0 0 0 2px rgba(185,139,255,.4); }
  .yw-game.yw-tier4 { background: linear-gradient(180deg,#2c1d0c,#4a3115); --yw-accent: #ffb13b; --yw-glow: rgba(255,177,59,.95); box-shadow: inset 0 0 0 2px rgba(255,177,59,.45); }
  .yw-game.yw-tier5 { background: linear-gradient(135deg,#2a0f3a,#0f2a4a,#0f3a2a); --yw-accent: #76e0ff; --yw-glow: rgba(120,224,255,.95); box-shadow: inset 0 0 0 2px rgba(255,255,255,.18); }
  .yw-game.yw-tier6 { background: linear-gradient(135deg,#3a2a00,#1a0f3a,#00263a); --yw-accent: #ffd700; --yw-glow: rgba(255,215,0,.95); box-shadow: inset 0 0 0 3px rgba(255,215,0,.5), 0 8px 30px rgba(255,215,0,.15); }
  .yw-game.is-fever { background: linear-gradient(135deg,#ff0080,#ff8c00,#ffee00,#00c853,#00b0ff,#aa00ff); background-size: 400% 400%; animation: yw-rainbow 3s ease infinite; }
  @keyframes yw-rainbow { 0%{background-position:0% 50%} 50%{background-position:100% 50%} 100%{background-position:0% 50%} }
  .yw-game.yw-celebrate { animation: yw-celebrate .5s ease 2; }
  @keyframes yw-celebrate { 0%,100%{box-shadow:inset 0 0 0 2px var(--yw-accent)} 50%{box-shadow:inset 0 0 0 5px var(--yw-accent), 0 0 36px 8px var(--yw-glow)} }
  .yw-game-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
  .yw-game-title { font-weight: 800; font-size: 15px; }
  .yw-balance { font-weight: 800; font-size: 16px; }
  .yw-exit { background: rgba(255,255,255,.15); border: none; color: #fff; border-radius: 8px; padding: 6px 12px; cursor: pointer; font-size: 13px; }
  .yw-fever-banner { display: none; text-align: center; font-weight: 900; font-size: 20px; letter-spacing: 3px; text-shadow: 0 0 10px #fff; margin-bottom: 8px; }
  .yw-reels { position: relative; display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; background: #0d0d1a; border-radius: 12px; padding: 10px; box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--yw-accent) 50%, transparent); transition: transform .2s; }
  .yw-reels.yw-zoomfx { transform: scale(1.05); }
  .yw-reel { position: relative; background: #fff; border-radius: 8px; overflow: hidden; transition: box-shadow .2s; }
  .yw-reel.yw-specialhit { box-shadow: 0 0 16px 3px var(--yw-glow); }
  .yw-reel.yw-reach { box-shadow: 0 0 14px 3px var(--yw-glow); }
  .yw-reel.yw-reach-strong { box-shadow: 0 0 26px 8px var(--yw-glow); animation: yw-reachpulse .45s ease infinite alternate; }
  @keyframes yw-reachpulse { from{box-shadow:0 0 12px 3px var(--yw-glow)} to{box-shadow:0 0 30px 12px var(--yw-glow)} }
  .yw-reels.yw-reach-dim .yw-reel:not(.yw-reach):not(.yw-reach-strong) { opacity: .5; }
  .yw-cell { height: 56px; display: flex; align-items: center; justify-content: center; font-size: 34px; }
  .yw-cell.top, .yw-cell.bot { opacity: .35; height: 34px; font-size: 24px; }
  .yw-cell.center { border-top: 2px solid var(--yw-accent); border-bottom: 2px solid var(--yw-accent); background: #fffdf2; }
  .yw-sym-img { max-height: 48px; max-width: 48px; object-fit: contain; }
  .yw-sym-7 { color: #e22; font-weight: 900; font-size: 38px; text-shadow: 0 1px 0 #fff, 0 0 8px rgba(255,80,80,.6); }
  .yw-sym-replay { color: #26c; font-weight: 900; font-size: 15px; line-height: 1; text-align: center; }
  .yw-sym-emoji { font-size: 34px; }
  .yw-payline { position: absolute; left: 6px; right: 6px; top: 50%; height: 2px; background: color-mix(in srgb, var(--yw-accent) 60%, transparent); transform: translateY(-1px); pointer-events: none; }
  .yw-bounce { animation: yw-bounce .28s ease; }
  @keyframes yw-bounce { 0%{transform:translateY(-14px);opacity:.4} 60%{transform:translateY(3px)} 100%{transform:translateY(0);opacity:1} }
  .yw-reels.yw-win { animation: yw-winflash .5s ease 2; }
  @keyframes yw-winflash { 0%,100%{box-shadow:inset 0 0 0 2px color-mix(in srgb, var(--yw-accent) 50%, transparent)} 50%{box-shadow:0 0 26px 6px var(--yw-glow)} }
  .yw-spark { position: absolute; width: 10px; height: 10px; pointer-events: none; border-radius: 50%; background: radial-gradient(circle, #fff 0%, var(--yw-glow) 60%, transparent 70%); animation: yw-sparkle .85s ease forwards; z-index: 5; }
  .yw-spark-win, .yw-spark-big { width: 14px; height: 14px; }
  .yw-spark-big { background: radial-gradient(circle, #fff 0%, #ffd700 60%, transparent 72%); }
  .yw-spark-fever { background: radial-gradient(circle, #fff 0%, #ff6bd6 60%, transparent 72%); }
  @keyframes yw-sparkle { 0%{transform:scale(.2);opacity:0} 30%{opacity:1} 100%{transform:scale(1.6) translateY(-12px);opacity:0} }
  .yw-coin { position: absolute; bottom: 18%; pointer-events: none; z-index: 6; animation: yw-coinfly 1.4s ease-out forwards; }
  @keyframes yw-coinfly { 0%{transform:translateY(0) rotate(0);opacity:0} 15%{opacity:1} 100%{transform:translateY(-150px) rotate(340deg);opacity:0} }
  .yw-msg { min-height: 22px; text-align: center; font-weight: 700; margin: 8px 0; font-size: 14px; }
  .yw-msg.win { color: #ffe08a; } .yw-msg.big, .yw-msg.fever { color: #fff; text-shadow: 0 0 8px var(--yw-glow); font-size: 16px; } .yw-msg.warn { color: #ffb4a8; }
  .yw-feverstart-slot { min-height: 0; }
  .yw-feverstart { display: block; width: 100%; margin: 4px 0 10px; border: none; border-radius: 12px; padding: 16px; font-size: 18px; font-weight: 900; color: #3a2a00; cursor: pointer;
    background: linear-gradient(135deg,#ffd700,#ff8c00,#ff0080,#00b0ff,#ffd700); background-size: 300% 300%; animation: yw-rainbow 2.2s ease infinite, yw-feverpulse 1s ease infinite;
    box-shadow: 0 0 24px 4px rgba(255,215,0,.8); text-shadow: 0 1px 0 rgba(255,255,255,.5); }
  @keyframes yw-feverpulse { 0%,100%{transform:scale(1)} 50%{transform:scale(1.04)} }
  .yw-feverstart:disabled { opacity: .7; cursor: default; }
  .yw-stops { display: grid; grid-template-columns: repeat(3,1fr); gap: 8px; margin-bottom: 8px; }
  .yw-stop { background: #e63946; border: none; color: #fff; font-weight: 800; border-radius: 10px; padding: 12px; cursor: pointer; font-size: 15px; }
  .yw-stop:disabled { background: #555; opacity: .6; cursor: default; }
  .yw-controls { display: grid; grid-template-columns: 2fr 1fr; gap: 8px; }
  .yw-spin { background: var(--yw-accent); border: none; color: #222; font-weight: 900; border-radius: 10px; padding: 14px; cursor: pointer; font-size: 16px; text-shadow: 0 1px 0 rgba(255,255,255,.4); }
  .yw-spin:disabled { background: #776; color: #ccc; cursor: default; text-shadow: none; }
  .yw-auto { background: rgba(255,255,255,.15); border: none; color: #fff; font-weight: 700; border-radius: 10px; padding: 14px; cursor: pointer; font-size: 14px; }
  .yw-auto.on { background: #4a7; }
  .yw-free { text-align: center; color: #ffe08a; font-size: 13px; min-height: 18px; margin: 8px 0 0; }
  .yw-stats { display: grid; grid-template-columns: repeat(3,1fr); gap: 8px; margin-top: 10px; }
  .yw-stats > div { background: rgba(255,255,255,.1); border-radius: 10px; padding: 8px; text-align: center; }
  .yw-stats span { display: block; font-size: 11px; color: #bbc; }
  .yw-stats b { font-size: 18px; }
  /* 当たり時の画面シェイク（演出強め） */
  .yw-game.yw-shake { animation: yw-shake .5s ease; }
  @keyframes yw-shake { 0%,100%{transform:translate(0,0)} 15%{transform:translate(-6px,3px) rotate(-.6deg)} 30%{transform:translate(5px,-4px) rotate(.6deg)} 45%{transform:translate(-5px,-2px)} 60%{transform:translate(4px,3px) rotate(-.4deg)} 75%{transform:translate(-3px,2px)} }
  /* 全画面のド派手演出（演出強めのときだけ JS が on にする・reduced-motion では付けない） */
  #yw-screen-fx { position: fixed; inset: 0; pointer-events: none; z-index: 2147483000; opacity: 0; }
  #yw-screen-fx.flash-win { animation: yw-screenwin .5s ease; background: linear-gradient(135deg,#ff0080,#ff8c00,#ffee00,#00c853,#00b0ff,#aa00ff); background-size: 300% 300%; }
  #yw-screen-fx.flash-fever { animation: yw-screenfever .22s steps(2) 6; background: linear-gradient(135deg,#ff0080,#ff8c00,#ffee00,#00c853,#00b0ff,#aa00ff); background-size: 300% 300%; }
  @keyframes yw-screenwin { 0%{opacity:0} 20%{opacity:.5} 100%{opacity:0} }
  @keyframes yw-screenfever { 0%{opacity:.05; background-position:0% 50%} 50%{opacity:.5; background-position:100% 50%} 100%{opacity:.05; background-position:0% 50%} }
  #yw-screen-fx.fever-on { opacity: 1; animation: yw-screenfeveron 1.1s ease-in-out infinite; background:
      radial-gradient(120% 90% at 50% 50%, transparent 52%, rgba(255,0,128,.0) 55%, rgba(255,0,128,.28) 78%, rgba(0,176,255,.42) 100%); }
  @keyframes yw-screenfeveron { 0%,100%{filter:hue-rotate(0deg); opacity:.55} 50%{filter:hue-rotate(320deg); opacity:.9} }
  @media (prefers-reduced-motion: reduce) {
    .yw-game.is-fever, .yw-feverstart { animation: none; }
    .yw-bounce, .yw-reels.yw-win, .yw-reel.yw-reach, .yw-reel.yw-reach-strong, .yw-game.yw-celebrate, .yw-game.yw-shake, .yw-spark, .yw-coin, .yw-reels.yw-zoomfx { animation: none; transform: none; }
    #yw-screen-fx { display: none; }
  }
  `;
  const style = document.createElement("style");
  style.id = "yuworld-styles";
  style.textContent = css;
  document.head.appendChild(style);
  window.addEventListener("pagehide", settleBeacon);
  window.addEventListener("beforeunload", settleBeacon);
  const unlock = () => { if (state.soundOn) ensureAudio(); };
  window.addEventListener("pointerdown", unlock, { passive: true });
  window.addEventListener("keydown", unlock);
  window.addEventListener("resize", () => { if (state.screen === "game") applyScale(); });
}
