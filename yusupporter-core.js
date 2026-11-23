/* ⭐ ゆうChat サポーター（有料プラン）：見た目の候補と、目印・色・背景を付ける部品（画面の読み込みのたびに使う小さい部分）
   ・サポーターかどうか・好みの設定は Worker（/supporter）が決めて保存する。ここは「候補の id → 見た目」と、画面に反映する部分だけ
   ・候補の id の表は notify-worker/worker.js の SUPPORTER_PRESETS と同じ（同じであることは notify-worker/test/supporter-client.test.mjs が確かめる）
   ・どれも見た目だけ。ゲームの当たりやすさ・結果・コインには関わらない
   ・設定・マイ記録・要望の画面は yusupporter.js（開くときに読み込む） */

/* 名前の色：{ label, css（その名前に付ける style） } */
const grad = (g) => `background:${g};-webkit-background-clip:text;background-clip:text;color:transparent;`;
export const NAME_COLORS = {
  default: { label: "ふつう", css: "" },
  gold: { label: "ゴールド", css: "color:#b8820f;" },
  rose: { label: "ローズ", css: "color:#d6336c;" },
  red: { label: "レッド", css: "color:#d9423a;" },
  orange: { label: "オレンジ", css: "color:#e8710a;" },
  lime: { label: "ライム", css: "color:#6f9a0c;" },
  green: { label: "グリーン", css: "color:#1f9d63;" },
  teal: { label: "ターコイズ", css: "color:#0e9494;" },
  sky: { label: "スカイ", css: "color:#1b8fd6;" },
  blue: { label: "ブルー", css: "color:#2f6bff;" },
  indigo: { label: "インディゴ", css: "color:#4c46d6;" },
  violet: { label: "バイオレット", css: "color:#8b3fd9;" },
  pink: { label: "ピンク", css: "color:#e0449c;" },
  brown: { label: "ブラウン", css: "color:#8a5a2b;" },
  slate: { label: "スレート", css: "color:#4a5568;" },
  rainbow: { label: "レインボー", css: grad("linear-gradient(90deg,#ff4d6d,#ff9f1c,#e5c100,#2bb673,#2f9bff,#8b5cf6)") }
};

/* 吹き出しの色：{ label, css（その吹き出しに付ける style。文字の色も決める） } */
export const BUBBLE_COLORS = {
  default: { label: "ふつう", css: "" },
  sky: { label: "スカイ", css: "background:#dff0ff;color:#16324a;" },
  mint: { label: "ミント", css: "background:#d9f6e8;color:#12392a;" },
  lemon: { label: "レモン", css: "background:#fff6c9;color:#4a3d00;" },
  peach: { label: "ピーチ", css: "background:#ffe3d3;color:#4d2410;" },
  rose: { label: "ローズ", css: "background:#ffdde6;color:#51162a;" },
  lavender: { label: "ラベンダー", css: "background:#e8e0ff;color:#2d1f5e;" },
  gold: { label: "ゴールド", css: "background:linear-gradient(135deg,#ffe9a8,#f0c25a);color:#4a3600;" },
  slate: { label: "スレート", css: "background:#d9dee8;color:#1d2433;" },
  night: { label: "ナイト", css: "background:#1d2433;color:#ffffff;" },
  sunset: { label: "サンセット", css: "background:linear-gradient(135deg,#ff9a76,#ff5e8a);color:#ffffff;" },
  ocean: { label: "オーシャン", css: "background:linear-gradient(135deg,#4facfe,#2f6bff);color:#ffffff;" },
  forest: { label: "フォレスト", css: "background:linear-gradient(135deg,#43b97f,#1f7a56);color:#ffffff;" }
};

/* チャットの背景（自分の画面だけ）：{ label, css } */
export const CHAT_BACKGROUNDS = {
  default: { label: "ふつう", css: "" },
  cream: { label: "クリーム", css: "background:#fbf5e6;" },
  sky: { label: "スカイ", css: "background:#e8f3ff;" },
  mint: { label: "ミント", css: "background:#e6f8ef;" },
  rose: { label: "ローズ", css: "background:#fff0f3;" },
  lavender: { label: "ラベンダー", css: "background:#f1ecff;" },
  night: { label: "ナイト", css: "background:#141926;" },
  dots: { label: "ドット", css: "background:#f7f9fd radial-gradient(#cfd8ea 1.5px,transparent 1.6px) 0 0/18px 18px;" },
  stripes: { label: "ストライプ", css: "background:repeating-linear-gradient(135deg,#f4f7fb 0 14px,#e9eef7 14px 28px);" },
  grid: { label: "方眼", css: "background:#fbfcff linear-gradient(#e3e9f5 1px,transparent 1px) 0 0/22px 22px,linear-gradient(90deg,#e3e9f5 1px,transparent 1px) 0 0/22px 22px;" },
  sunset: { label: "夕焼け", css: "background:linear-gradient(180deg,#ffe3d1,#ffc2d4 60%,#d9b8ff);" },
  ocean: { label: "海", css: "background:linear-gradient(180deg,#d9f1ff,#a9d9ff 70%,#7fc0f5);" },
  forest: { label: "森", css: "background:linear-gradient(180deg,#e3f6e8,#bfe6cc 70%,#9fd3b2);" },
  aurora: { label: "オーロラ", css: "background:radial-gradient(circle at 20% 10%,#b8f5df,transparent 45%),radial-gradient(circle at 80% 30%,#c9b8ff,transparent 50%),#eaf3ff;" },
  sakura: { label: "さくら", css: "background:radial-gradient(circle at 15% 20%,#ffd1e0 6px,transparent 7px) 0 0/60px 60px,radial-gradient(circle at 70% 60%,#ffd1e0 5px,transparent 6px) 0 0/60px 60px,#fff5f8;" },
  stars: { label: "星空", css: "background:radial-gradient(#ffffff 1px,transparent 1.5px) 0 0/40px 40px,radial-gradient(#9fb2ff 1px,transparent 1.5px) 20px 20px/60px 60px,#141b33;" }
};

/* 確変台の見た目：{ label, vars（CSS 変数。style.css の [data-kk-theme] が使う）, swatch（候補の見本の色） } */
export const KAKU_THEMES = {
  default: { label: "ふつう", swatch: "linear-gradient(90deg,#ff2d78,#ffe14a,#17b6ff,#b14cff)" },
  gold: { label: "ゴールド", swatch: "linear-gradient(90deg,#ffe08a,#e8b230,#b8820f)" },
  neon: { label: "ネオン", swatch: "linear-gradient(90deg,#00f5d4,#00bbf9,#9b5de5)" },
  sakura: { label: "さくら", swatch: "linear-gradient(90deg,#ffd1e0,#ff8fb1,#ffb3c7)" },
  ocean: { label: "海", swatch: "linear-gradient(90deg,#7ad7ff,#2f6bff,#1b3fa8)" },
  fire: { label: "炎", swatch: "linear-gradient(90deg,#ffd34d,#ff7a1a,#d9291c)" },
  forest: { label: "森", swatch: "linear-gradient(90deg,#9be37e,#2bb673,#0f6b4a)" },
  night: { label: "夜", swatch: "linear-gradient(90deg,#6c63ff,#3b2fb8,#141b33)" }
};

/* 確変台の当たり演出：{ label, emoji（降らせる絵文字） } */
export const KAKU_EFFECTS = {
  default: { label: "ふつう", emoji: [] },
  confetti: { label: "紙吹雪", emoji: ["🎉", "🎊", "✨"] },
  stars: { label: "星", emoji: ["⭐", "🌟", "✨"] },
  coins: { label: "コイン", emoji: ["🪙", "💰"] },
  hearts: { label: "ハート", emoji: ["💖", "💗", "💕"] }
};

/* 種類ごとの候補の id（Worker の SUPPORTER_PRESETS と同じ。テストで確かめる） */
export const PRESET_IDS = {
  nameColor: Object.keys(NAME_COLORS),
  bubbleColor: Object.keys(BUBBLE_COLORS),
  chatBg: Object.keys(CHAT_BACKGROUNDS),
  kakuTheme: Object.keys(KAKU_THEMES),
  kakuFx: Object.keys(KAKU_EFFECTS)
};

/* ---------- いまの状態（画面全体で1つ） ---------- */
const state = { byUid: {}, me: null, loadedAt: 0 };
export const supporterState = state;
export function setSupporterIndex(byUid) { state.byUid = byUid && typeof byUid === "object" ? byUid : {}; state.loadedAt = Date.now(); }
/* 自分の状態：{ source, since, early, prefs } か null */
export function setMySupporter(me) { state.me = me || null; }
export const getSupporter = (uid) => (uid ? state.byUid[uid] || null : null);
export const isMeSupporter = () => Boolean(state.me);
export const myPrefs = () => state.me?.prefs || null;

/* ---------- 目印（金色の六角形に「Y」） ---------- */
const MARK_DEFS = `<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false"><defs><linearGradient id="yuSupGrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffe08a"/><stop offset=".55" stop-color="#e8b230"/><stop offset="1" stop-color="#b8820f"/></linearGradient><symbol id="yuSupMark" viewBox="0 0 104 104"><path d="M52 6 L90 28 Q94 30.5 94 35 L94 69 Q94 73.5 90 76 L52 98 Q48 100 44 98 L14 76 Q10 73.5 10 69 L10 35 Q10 30.5 14 28 L48 6 Q50 5 52 6 Z" fill="url(#yuSupGrad)"/><path d="M37 32 L52 56 L67 32 M52 56 L52 76" stroke="#fff" stroke-width="10" stroke-linecap="round" stroke-linejoin="round" fill="none"/></symbol></defs></svg>`;
let defsInjected = false;
export function ensureMarkDefs() {
  if (defsInjected || typeof document === "undefined") return;
  defsInjected = true;
  const holder = document.createElement("div");
  holder.innerHTML = MARK_DEFS;
  document.body.appendChild(holder.firstChild);
}

/* 名前の横に付ける目印の要素。size は px */
export function buildSupporterMark(entry, size = 15) {
  ensureMarkDefs();
  const span = document.createElement("span");
  span.className = "sup-mark";
  span.title = entry && entry.e ? "ゆうChat サポーター（初期サポーター）" : "ゆうChat サポーター";
  span.setAttribute("role", "img");
  span.setAttribute("aria-label", span.title);
  span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 104 104" aria-hidden="true"><use href="#yuSupMark"></use></svg>`;
  return span;
}

/* 名前の文字に、色を付ける（サポーターの名前の色） */
export function applyNameStyle(el, entry) {
  if (!el || !entry) return;
  const style = NAME_COLORS[entry.nc]?.css;
  if (style) el.style.cssText += style;
}
/* 吹き出しに、色を付ける */
export function applyBubbleStyle(el, entry) {
  if (!el || !entry) return;
  const style = BUBBLE_COLORS[entry.bc]?.css;
  if (style) { el.style.cssText += style; el.classList.add("sup-bubble"); }
}
/* 自分のチャットの背景（メッセージの一覧） */
export function applyChatBackground(el) {
  if (!el) return;
  const id = state.me?.prefs?.chatBg || "default";
  el.style.background = "";
  const css = CHAT_BACKGROUNDS[id]?.css || "";
  if (css) el.style.cssText += css;
  el.classList.toggle("sup-bg-dark", id === "night" || id === "stars");
}

/* ---------- ゆうスロの確変台：見た目と当たり演出（自分の画面だけ） ---------- */
export function applyKakuTheme(el, on) {
  if (!el) return;
  const id = on ? (state.me?.prefs?.kakuTheme || "default") : "default";
  if (id === "default") el.removeAttribute("data-kk-theme");
  else el.setAttribute("data-kk-theme", id);
}
export function playKakuEffect() {
  const fx = KAKU_EFFECTS[state.me?.prefs?.kakuFx || "default"];
  if (!fx || !fx.emoji.length || typeof document === "undefined") return;
  if (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  for (let i = 0; i < 18; i++) {
    const s = document.createElement("span");
    s.className = "sup-fx";
    s.textContent = fx.emoji[i % fx.emoji.length];
    s.style.left = `${4 + Math.random() * 92}%`;
    s.style.animationDelay = `${(Math.random() * 0.5).toFixed(2)}s`;
    s.style.fontSize = `${18 + Math.round(Math.random() * 14)}px`;
    document.body.appendChild(s);
    setTimeout(() => s.remove(), 2400);
  }
}

/* 新しい機能を、サポーターが先に遊べるか。featureId の公開日時（ミリ秒）を渡す：
   サポーターは公開日時から、そうでない人は、さらに EARLY_ACCESS_MS（1週間）あとから遊べる */
export const EARLY_ACCESS_MS = 7 * 86400000;
export function isFeatureOpen(openAtMs, now = Date.now()) {
  const at = Number(openAtMs);
  if (!Number.isFinite(at)) return true;
  return now >= (isMeSupporter() ? at : at + EARLY_ACCESS_MS);
}

/* ---------- 画面のレイアウト（サポーターは、Web版でもアプリ版のレイアウトを試せる。この端末だけの設定） ----------
   ・"std"＝ふつう（Web版）／"app"＝アプリ版のレイアウト（html に app-mode が付く。幅 700px 以下で、下のタブ5つ・会話の一覧など）
   ・アプリの中（Capacitor）や確認用の ?app=1 のときは、いつもアプリ版。サポーターでない人が app を選んでいたら、サポーターの情報が読めた時点で戻す */
const LAYOUT_KEY = "yuLayout";
export const isNativeApp = () => Boolean(typeof window !== "undefined" && window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
export function getLayoutChoice() { try { return localStorage.getItem(LAYOUT_KEY) === "app" ? "app" : "std"; } catch (_) { return "std"; } }
export function setLayoutChoice(choice) {
  try { if (choice === "app") localStorage.setItem(LAYOUT_KEY, "app"); else localStorage.removeItem(LAYOUT_KEY); } catch (_) { /* 保存できなくても、このまま使える */ }
  applyLayoutClass();
}
export function applyLayoutClass() {
  if (typeof document === "undefined") return;
  let forced = isNativeApp();
  try { forced = forced || sessionStorage.getItem("yuApp") === "1"; } catch (_) { /* そのまま */ }
  const want = forced || (isMeSupporter() && getLayoutChoice() === "app");
  document.documentElement.classList.toggle("app-mode", want);
  if (!want && !isMeSupporter() && getLayoutChoice() === "app") { try { localStorage.removeItem(LAYOUT_KEY); } catch (_) { /* そのまま */ } }
}
