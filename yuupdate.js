/* 🔄 サイトの更新のお知らせ
   ・サイトが新しくなったら、画面の上に「新しいバージョンがあります［アップデート］」を出す（自動では読み込み直さない。入力の途中で消えないように、押したときだけ）
   ・調べ方：開いているページが読み込んだ部品の版（?v=…）と、いまサイトにある index.html の版を比べる。ちがえば、新しい版がある
     （サイトを更新するときは、index.html の版の文字列を上げる決まり。部品を変えたら、index.html の版も上げる）
   ・調べるタイミング：開いたあと・ほかの画面から戻ってきたとき・開いている間は5分おき。index.html を1回読むだけ（Firebase にはさわらない）
   ・アプリ版（Capacitor）は、アプリの中の部品を使うので、出さない */
const CHECK_MS = 5 * 60 * 1000;
const SNOOZE_MS = 30 * 60 * 1000;

const sigOf = (list) => [...new Set(list)].sort().join("|");
/* いま開いているページが読み込んだ部品の版 */
export function runningSig(doc) {
  const out = [];
  doc.querySelectorAll('link[href*="?v="],script[src*="?v="],script[data-app-src]').forEach((el) => {
    for (const a of ["href", "src", "data-app-src"]) { const v = el.getAttribute(a); if (v && v.includes("?v=")) out.push(v); }
  });
  return sigOf(out);
}
/* index.html の文字列にある、部品の版 */
export function htmlSig(text) {
  const out = [];
  for (const m of String(text).matchAll(/(?:href|src|data-app-src)\s*=\s*"([^"]*\?v=[^"]*)"/g)) out.push(m[1]);
  return sigOf(out);
}
/* 新しい版があるか（どちらかの版の一覧が空のときは、判断しない） */
export function needsUpdate(running, latest) { return !!running && !!latest && running !== latest; }

function ensureBanner() {
  let el = document.getElementById("yuUpdateBanner");
  if (el) return el;
  const style = document.createElement("style");
  style.textContent = `#yuUpdateBanner{position:fixed;left:0;right:0;top:0;z-index:100000;display:flex;gap:10px;align-items:center;justify-content:center;flex-wrap:nowrap;padding:calc(8px + env(safe-area-inset-top,0px)) 12px 8px;background:#2f6bff;color:#fff;font-size:13px;font-weight:700;box-shadow:0 2px 10px rgba(0,0,0,.25)}
#yuUpdateBanner button{min-height:36px;border:0;border-radius:10px;padding:0 10px;font-size:13px;white-space:nowrap;font-weight:700;cursor:pointer}
#yuUpdateBanner .go{background:#fff;color:#2f6bff}
#yuUpdateBanner .later{background:rgba(255,255,255,.2);color:#fff}`;
  document.head.appendChild(style);
  el = document.createElement("div");
  el.id = "yuUpdateBanner"; el.setAttribute("role", "status");
  el.innerHTML = '<span>🔄 新しいバージョンがあります</span><button type="button" class="go">アップデート</button><button type="button" class="later">あとで</button>';
  el.querySelector(".go").addEventListener("click", async (ev) => {
    const b = ev.currentTarget; b.disabled = true; b.textContent = "更新中…";
    try { await fetch(location.href.split("#")[0], { cache: "reload" }); } catch (_) { /* 取れなくても、読み込み直す */ }
    location.reload();
  });
  el.querySelector(".later").addEventListener("click", () => { el.remove(); snoozeUntil = Date.now() + SNOOZE_MS; });
  document.body.appendChild(el);
  return el;
}

let snoozeUntil = 0, busy = false;
async function check() {
  if (busy || document.hidden || Date.now() < snoozeUntil || document.getElementById("yuUpdateBanner")) return;
  busy = true;
  try {
    // 分ごとに変わる文字を付けて、途中のキャッシュに古いものが残っていても、1分以内に新しいものが届くようにする（同じ分の人どうしは、同じものを使う）
    const url = `${location.pathname}?_u=${Math.floor(Date.now() / 60000)}`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return;
    if (needsUpdate(runningSig(document), htmlSig(await res.text()))) ensureBanner();
  } catch (_) { /* 通信できないときは、何も出さない */ }
  finally { busy = false; }
}

function start() {
  if (typeof document === "undefined") return;
  if (!/^https?:$/.test(location.protocol)) return;
  if (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) return;
  setTimeout(check, 8000);
  setInterval(check, CHECK_MS);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) check(); });
  window.addEventListener("online", check);
}
start();
