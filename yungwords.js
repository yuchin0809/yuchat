/* 不適切なことば（暴言・性的な表現・差別語）の自動チェック。チャット・グループ名・名前・YuSnap のひとことで使う。
   ・「死ね」「殺す」など、とくにひどいものだけ。ふつうの会話（「ばか」など）は止めない。
   ・かたちをそろえてから調べる（全角→半角・かたかな→ひらがな・すきま/記号を除く）。
   ・Worker（notify-worker/worker.js）にも同じ一覧を持つ。変えるときは両方（test/ngwords.test.mjs が、同じかを確かめる）。 */
// NG-LIST-BEGIN
const NG_JA = ["死ね", "しねよ", "殺す", "殺せ", "殺して", "ころす", "ころせ", "ころして", "ぶっころ", "自殺しろ", "じさつしろ", "消えろ", "きえろ", "くたばれ", "きちがい", "気違い", "がいじ", "ガイジ", "かたわ", "れいぷ", "強姦", "ごうかん", "ちんこ", "ちんぽ", "まんこ", "うんこまん", "ふぇら", "ぱいずり", "ちょんこ", "にがー"];
const NG_EN = ["fuck", "fucking", "shit", "bitch", "cunt", "nigger", "nigga", "rape", "rapist", "kys", "kill yourself"];
// NG-LIST-END
const NG_EN_RE = new RegExp(`(^|[^a-z])(${NG_EN.map((w) => w.replace(/ /g, "[^a-z]*")).join("|")})([^a-z]|$)`);
function normalize(s) {
  return String(s || "").normalize("NFKC").toLowerCase()
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))   // かたかな→ひらがな
    .replace(/[\s​・ー\-_.,!?~、。「」『』（）()\[\]*/\\|]+/g, "");
}
function normalizeKeepSpace(s) {
  return String(s || "").normalize("NFKC").toLowerCase();
}
const JA_NORM = NG_JA.map((w) => normalize(w));
export function hasNgWord(text) {
  const t = String(text || "");
  if (!t) return false;
  const n = normalize(t);
  if (JA_NORM.some((w) => w && n.includes(w))) return true;
  return NG_EN_RE.test(normalizeKeepSpace(t));
}
export const NG_MESSAGE = "使えないことばが含まれています。やさしいことばで書き直してください。";
