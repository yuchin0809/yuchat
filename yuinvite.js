/* 📨 友達に紹介ボタン（ヘッダーのゆうコインの右）
   ・押すと、端末の共有画面（LINE・メッセージなど）で「ゆうChatで一緒に遊ぼう！」とアプリのリンクを送れる。
   ・共有画面が使えない端末では、文とリンクをコピーして「コピーしました」と出す。
   ・リンクは誰が押しても同じ（名前・ID など個人を特定できるものは入れない）。Firebase には触れない。 */

export const INVITE_URL = "https://yuchin0809.github.io/yuchat/";
export const INVITE_TEXT = "ゆうChatで一緒に遊ぼう！（チャット・ゲーム・ゆうスロもあるよ）";

async function copyText(text) {
  try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; } } catch (_) { /* 次の方法へ */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text; ta.setAttribute("readonly", ""); ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;";
    document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy"); ta.remove(); return ok;
  } catch (_) { return false; }
}

/* ボタンを押したときの動き。toast(title, body) で結果を知らせる。戻り値：shared / copied / cancelled / failed */
export async function inviteFriends(toast) {
  if (typeof navigator.share === "function") {
    try { await navigator.share({ title: "ゆうChat", text: INVITE_TEXT, url: INVITE_URL }); return "shared"; }
    catch (error) { if (error && error.name === "AbortError") return "cancelled"; /* 共有できなかったときは、コピーに切り替える */ }
  }
  if (await copyText(`${INVITE_TEXT}\n${INVITE_URL}`)) { toast("📨 友達に紹介", "リンクをコピーしました。LINEなどに貼って送ってね！"); return "copied"; }
  window.prompt("このリンクをコピーして、友達に送ってね", INVITE_URL);
  return "failed";
}

export function inviteInit(button, toast) {
  if (!button) return;
  button.addEventListener("click", () => { inviteFriends(toast); });
}
