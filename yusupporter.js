/* ⭐ ゆうChat サポーターの画面（開くときに読み込む）
   ・サポーターでない人：プランの案内（月額250円・年間2,400円・特典の一覧）。購入は、アプリ（App Store）の公開後に使えるようになる。いまは「準備中」
   ・サポーターの人：見た目の設定（名前の色・吹き出しの色・チャットの背景・確変台の見た目と演出）・マイ記録・要望・特典の説明
   ・保存は Worker（/supporter）。ここは画面だけ */
import {
  NAME_COLORS, BUBBLE_COLORS, CHAT_BACKGROUNDS, KAKU_THEMES, KAKU_EFFECTS, supporterState, setMySupporter, ensureMarkDefs
} from "./yusupporter-core.js?v=20261110-sup1";

let cfg = null;          // { api(action, payload), esc, onChange() }
let overlay = null;
const view = { tab: "look", plan: "year", draft: null, saving: false, msg: "", records: null, recordsAt: 0 };

export function supporterUiInit(options) { cfg = options; }

const esc = (s) => (cfg?.esc ? cfg.esc(s) : String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])));
const fmt = (n) => Number(n || 0).toLocaleString("ja-JP");
const isNativeApp = () => Boolean(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
const markSvg = (size) => `<svg width="${size}" height="${size}" viewBox="0 0 104 104" aria-hidden="true"><use href="#yuSupMark"></use></svg>`;

const PERKS = [
  ["名前の横に金色の「Y」マーク", ""],
  ["名前・吹き出しの色と、チャットの背景を変えられる", ""],
  ["確変台の演出と見た目を自由に設定", "当たりやすさは変わりません"],
  ["マイ記録ページ", "スロの回数・ダービーの的中率など"],
  ["新しい機能を、約1週間早く遊べる", ""],
  ["「こんな機能がほしい」を優先して聞きます", ""],
  ["初期サポーター称号", "最初の1か月に加入した人だけにつきます"]
];

export function openSupporterScreen() {
  if (!cfg) return;
  ensureMarkDefs();
  close();
  overlay = document.createElement("div");
  overlay.className = "sup-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "ゆうChat サポーター");
  document.body.appendChild(overlay);
  overlay.addEventListener("click", onClick);
  view.tab = "look"; view.msg = ""; view.draft = supporterState.me ? { ...supporterState.me.prefs } : null;
  render();
}

function close() { overlay?.remove(); overlay = null; }

function render() {
  if (!overlay) return;
  overlay.innerHTML = `<div class="sup-sheet"><button type="button" class="sup-close" data-sup="close" aria-label="閉じる">×</button>${supporterState.me ? settingsHtml() : planHtml()}</div>`;
}

/* ---------- プランの案内（サポーターでない人） ---------- */
function planHtml() {
  const year = view.plan === "year";
  const cta = isNativeApp()
    ? "アプリ内での購入は、準備中です。もうすぐ使えるようになります。"
    : "購入は、アプリ（App Store）の公開後に、アプリから行えます。いまは準備中です。";
  return `
    <div class="sup-hero">${markSvg(88)}<h2>ゆうChat サポーター</h2><p>名前の横に金色のマークがついて、<br>もっと自分らしく楽しめます。</p></div>
    <div class="sup-plans" role="group" aria-label="プランを選ぶ">
      <button type="button" class="sup-plan ${year ? "on" : ""}" data-sup="plan-year" aria-pressed="${year}"><span class="sup-plan-tag">おすすめ</span>
        <span><b>年間プラン</b><small>月あたり200円・月額より600円おトク</small></span><span class="sup-price">2,400円<small> / 年</small></span></button>
      <button type="button" class="sup-plan ${year ? "" : "on"}" data-sup="plan-month" aria-pressed="${!year}">
        <span><b>月額プラン</b><small>いつでもやめられます</small></span><span class="sup-price">250円<small> / 月</small></span></button>
    </div>
    <ul class="sup-perks"><li class="sup-perks-head">サポーターの特典</li>${PERKS.map(([a, b]) => `<li><span class="sup-check" aria-hidden="true">✓</span><span>${esc(a)}${b ? `<small>${esc(b)}</small>` : ""}</span></li>`).join("")}<li class="sup-perks-more">特典は、これからも追加していく予定です。</li></ul>
    <button type="button" class="sup-cta" data-sup="buy" disabled>サポーターになる（${year ? "年間 2,400円" : "月額 250円"}）</button>
    <p class="sup-note">${esc(cta)}</p>
    <p class="sup-fine">${year ? "年間プランは、1年ごとに自動で更新されます。" : "月額プランは、1か月ごとに自動で更新されます。"}解約は、iPhone・iPadの「設定」のサブスクリプションから、いつでもできます。</p>`;
}

/* ---------- 設定（サポーターの人） ---------- */
function pickerHtml(key, table, title, kind) {
  const cur = view.draft?.[key] || "default";
  return `<div class="sup-group"><div class="sup-group-title">${esc(title)}</div><div class="sup-chips" role="radiogroup" aria-label="${esc(title)}">${Object.entries(table).map(([id, v]) => {
    const swatch = kind === "name" ? `<span class="sup-sw-text" style="${v.css || ""}">あ</span>` : kind === "bubble" ? `<span class="sup-sw" style="${v.css || "background:#eef0f3;"}"></span>` : kind === "bg" ? `<span class="sup-sw sup-sw-bg" style="${v.css || "background:#f5f7fa;"}"></span>` : kind === "kaku" ? `<span class="sup-sw" style="background:${v.swatch}"></span>` : `<span class="sup-sw-text">${esc((v.emoji && v.emoji[0]) || "－")}</span>`;
    return `<button type="button" class="sup-chip ${cur === id ? "on" : ""}" role="radio" aria-checked="${cur === id}" data-pick="${key}" data-id="${id}">${swatch}<small>${esc(v.label)}</small></button>`;
  }).join("")}</div></div>`;
}

function previewHtml() {
  const d = view.draft || {};
  const bg = CHAT_BACKGROUNDS[d.chatBg]?.css || "";
  const nameCss = NAME_COLORS[d.nameColor]?.css || "";
  const bubCss = BUBBLE_COLORS[d.bubbleColor]?.css || "";
  return `<div class="sup-preview" style="${bg}"><div class="sup-prev-row"><span class="sup-prev-name" style="${nameCss}">あなたの名前</span><span class="sup-mark">${markSvg(15)}</span></div><div class="sup-prev-bubble" style="${bubCss}">こんなふうに見えます</div></div>`;
}

function settingsHtml() {
  const me = supporterState.me;
  const tabs = [["look", "見た目"], ["records", "マイ記録"], ["request", "要望"], ["perks", "特典"]];
  const head = `<div class="sup-hero sup-hero-sm">${markSvg(52)}<div><h2>ゆうChat サポーター</h2><p>${me.early ? "🏅 初期サポーター" : "サポーターです。ありがとうございます！"}${me.source === "admin" ? "（運営からの招待）" : ""}</p></div></div>
    <div class="sup-tabs" role="tablist">${tabs.map(([id, l]) => `<button type="button" role="tab" aria-selected="${view.tab === id}" class="${view.tab === id ? "on" : ""}" data-sup="tab-${id}">${l}</button>`).join("")}</div>`;
  let body = "";
  if (view.tab === "look") {
    body = `${previewHtml()}
      ${pickerHtml("nameColor", NAME_COLORS, "名前の色", "name")}
      ${pickerHtml("bubbleColor", BUBBLE_COLORS, "吹き出しの色", "bubble")}
      ${pickerHtml("chatBg", CHAT_BACKGROUNDS, "チャットの背景（自分の画面だけ）", "bg")}
      ${pickerHtml("kakuTheme", KAKU_THEMES, "確変台の見た目（自分の画面だけ）", "kaku")}
      ${pickerHtml("kakuFx", KAKU_EFFECTS, "確変台の当たり演出（自分の画面だけ）", "fx")}
      <p class="sup-note">見た目だけで、ゲームの当たりやすさや結果は変わりません。名前の色と吹き出しの色は、ほかの人にも見えます。</p>
      <button type="button" class="sup-cta" data-sup="save" ${view.saving ? "disabled" : ""}>${view.saving ? "保存しています…" : "この見た目で保存する"}</button>`;
  } else if (view.tab === "records") {
    const r = view.records;
    body = !r ? `<p class="sup-note">読み込んでいます…</p>` : r.error ? `<p class="sup-err">読み込めませんでした。しばらくしてから、もう一度お試しください。</p>` : `
      <div class="sup-cards">
        <div class="sup-card"><span>いまのコイン</span><b>🪙 ${fmt(r.coins)}</b></div>
        <div class="sup-card"><span>ゆうスロの回転数</span><b>${fmt(r.slot.spins)} 回</b><small>確変台 ${fmt(r.slot.kakuSpins)} 回</small></div>
        <div class="sup-card"><span>ゆうスロで使ったコイン</span><b>${fmt(r.slot.wagered)}</b><small>確変台 ${fmt(r.slot.kakuWagered)}</small></div>
        <div class="sup-card"><span>ゆうダービー（精算ずみ）</span><b>${fmt(r.derby.bets)} 枚</b><small>的中 ${fmt(r.derby.wins)} 枚${r.derby.bets ? `（${Math.round(r.derby.wins / r.derby.bets * 100)}%）` : ""}</small></div>
        <div class="sup-card"><span>ダービーで使った → もらった</span><b>${fmt(r.derby.wagered)} → ${fmt(r.derby.paid)}</b><small>${r.derby.paid - r.derby.wagered >= 0 ? "＋" : "−"}${fmt(Math.abs(r.derby.paid - r.derby.wagered))}</small></div>
      </div>`;
  } else if (view.tab === "request") {
    body = `<p class="sup-note">「こんな機能がほしい」「ここを直してほしい」を送ってください。サポーターのものを、優先して読みます。</p>
      <textarea id="supRequestText" class="sup-textarea" maxlength="500" rows="5" placeholder="500文字までです"></textarea>
      <button type="button" class="sup-cta" data-sup="send-request">送る</button>`;
  } else {
    body = `<ul class="sup-perks"><li class="sup-perks-head">サポーターの特典</li>${PERKS.map(([a, b]) => `<li><span class="sup-check" aria-hidden="true">✓</span><span>${esc(a)}${b ? `<small>${esc(b)}</small>` : ""}</span></li>`).join("")}<li class="sup-perks-more">特典は、これからも追加していく予定です。</li></ul>`;
  }
  return `${head}<div class="sup-body">${body}${view.msg ? `<p class="${view.msg.startsWith("✅") ? "sup-ok" : "sup-err"}" role="status">${esc(view.msg)}</p>` : ""}</div>`;
}

/* ---------- 操作 ---------- */
async function onClick(event) {
  const t = event.target.closest("[data-sup],[data-pick]");
  if (!t) { if (event.target === overlay) close(); return; }
  if (t.dataset.pick) { view.draft = { ...(view.draft || {}), [t.dataset.pick]: t.dataset.id }; view.msg = ""; keepScroll(render); return; }
  const a = t.dataset.sup;
  if (a === "close") return close();
  if (a === "plan-year" || a === "plan-month") { view.plan = a === "plan-year" ? "year" : "month"; return keepScroll(render); }
  if (a && a.startsWith("tab-")) {
    view.tab = a.slice(4); view.msg = "";
    render();
    if (view.tab === "records") loadRecords();
    return;
  }
  if (a === "save") return savePrefs();
  if (a === "send-request") return sendRequest();
}
function keepScroll(fn) {
  const sheet = overlay?.querySelector(".sup-sheet"); const y = sheet ? sheet.scrollTop : 0;
  fn();
  const next = overlay?.querySelector(".sup-sheet"); if (next) next.scrollTop = y;
}

async function savePrefs() {
  if (view.saving) return;
  view.saving = true; view.msg = ""; keepScroll(render);
  try {
    const r = await cfg.api("setPrefs", { prefs: view.draft });
    setMySupporter({ ...supporterState.me, prefs: r.prefs });
    view.draft = { ...r.prefs };
    view.msg = "✅ 保存しました。";
    cfg.onChange?.();
  } catch (error) {
    console.error("サポーターの設定の保存エラー:", error);
    view.msg = "保存できませんでした。しばらくしてから、もう一度お試しください。";
  }
  view.saving = false; keepScroll(render);
}

async function loadRecords() {
  if (view.records && Date.now() - view.recordsAt < 120000) return;
  view.records = null; render();
  try { view.records = await cfg.api("records", {}); } catch (error) { console.error("マイ記録の読み込みエラー:", error); view.records = { error: true }; }
  view.recordsAt = Date.now();
  if (overlay && view.tab === "records") render();
}

async function sendRequest() {
  const box = overlay.querySelector("#supRequestText");
  const text = (box?.value || "").trim();
  if (!text) { view.msg = "内容を入力してください。"; return keepScroll(render); }
  try {
    await cfg.api("request", { text });
    view.msg = "✅ 送りました。ありがとうございます！";
  } catch (error) {
    view.msg = error.code === "too_fast" ? "続けて送れません。1分ほどあけて、もう一度お試しください。" : "送れませんでした。しばらくしてから、もう一度お試しください。";
  }
  keepScroll(render);
}
