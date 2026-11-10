/* 📨 友達に紹介ボタン（ヘッダーのゆうコインの右）
   ・押すと、端末の共有画面（LINE・メッセージなど）で「ゆうChatで一緒に遊ぼう！」とアプリのリンクを送れる。
   ・共有画面が使えない端末では、文とリンクをコピーして「コピーしました」と出す。
   ・リンクには、自分の招待コード（8文字。名前・ID は入れない）を付ける。コードは Worker（/invite）から取る。取れないときは、ふつうのリンク。 */

export const INVITE_URL = "https://yuchin0809.github.io/yuchat/";
/* 友達に送るリンク：ダウンロードのページ（invite.html）。招待コードが取れたときは、コードつき */
export const INVITE_PAGE_URL = "https://yuchin0809.github.io/yuchat/invite.html";
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
export async function inviteFriends(toast, getCode) {
  let url = INVITE_URL;
  try { const code = getCode ? await getCode() : ""; if (code) url = `${INVITE_PAGE_URL}?code=${encodeURIComponent(code)}`; } catch (_) { /* コードが取れなければ、ふつうのリンク */ }
  if (typeof navigator.share === "function") {
    try { await navigator.share({ title: "ゆうChat", text: INVITE_TEXT, url }); return "shared"; }
    catch (error) { if (error && error.name === "AbortError") return "cancelled"; /* 共有できなかったときは、コピーに切り替える */ }
  }
  if (await copyText(`${INVITE_TEXT}\n${url}`)) { toast("📨 友達に紹介", "リンクをコピーしました。LINEなどに貼って送ってね！"); return "copied"; }
  window.prompt("このリンクをコピーして、友達に送ってね", url);
  return "failed";
}

export function inviteInit(button, toast, getCode) {
  if (!button) return;
  button.addEventListener("click", () => { inviteFriends(toast, getCode); });
}
