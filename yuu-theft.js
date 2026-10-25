/* =========================================================
   🥷 スリ（総資産が多い人のところに、平日、授業のない時間にランダムで泥棒が来る）と、防犯の強化

   ・この表と計算は、アプリ（script.js）が使う。スリを実行するのは、通知サーバー（notify-worker/worker.js の runTheftTick）。
     Worker には、防犯グッズの買い物とスリのために、同じ表（防犯グッズ・週の月曜）を写してある（同じであることは notify-worker/test/theft.test.mjs が確かめる）。
   ・総資産15,000コイン以上の人が対象。月〜金のほぼ毎日、ランダムな時刻に来る（授業中は来ない・土日は来ない）。
   ・奪うのは、総資産の 5〜15%（整数のパーセントを、どれも同じ確率で）。手持ちコイン → 預金 → 株（時価で売った扱い）の順に取る。借入は取られない。取られたものは消える（コインの総量が減る）。
   ・防犯グッズ（毎週買い直し・暦の週が対象）：来た泥棒を追い払う確率と、取られる額を減らす割合。
========================================================= */

export const THEFT_MIN_TOTAL = 15000;                     // この総資産から対象
/* 防犯グッズを買えるようになる時刻（2026-10-26（月）0:00 JST）。スリが始まった日が週の途中なので、キリのよい週のはじめから */
export const THEFT_GUARD_SALE_START_MS = Date.UTC(2026, 9, 25, 15, 0, 0);

/* 防犯グッズ。rate：1週間の値段＝総資産 × rate（最低 min）／repel：来た泥棒を追い払う確率／dmg：追い払えなかったときの被害を減らす割合 */
export const THEFT_GUARDS = [
  null,
  { lv: 1, name: "丈夫な鍵", emoji: "🔒", rate: 0.008, min: 60, repel: 0.2, dmg: 0 },
  { lv: 2, name: "防犯ブザー", emoji: "📢", rate: 0.02, min: 150, repel: 0.4, dmg: 0 },
  { lv: 3, name: "防犯カメラ", emoji: "📹", rate: 0.04, min: 350, repel: 0.6, dmg: 0.3 },
  { lv: 4, name: "警備員", emoji: "💂", rate: 0.07, min: 700, repel: 0.75, dmg: 0.5 },
  { lv: 5, name: "大金庫", emoji: "🏦", rate: 0.10, min: 1200, repel: 0.9, dmg: 0.7 }
];

/* 1週間の値段（総資産に応じて、増える） */
export function guardPriceOf(lv, total) {
  const g = THEFT_GUARDS[lv];
  if (!g) return 0;
  return Math.max(g.min, Math.round(Math.max(0, Number(total) || 0) * g.rate));
}

/* その日の日付（YYYY-MM-DD）が含まれる週の、月曜の日付（暦の週は月曜はじまり） */
export function weekStartOf(dateText) {
  const t = Date.parse(`${dateText}T00:00:00Z`);
  const dow = new Date(t).getUTCDay();   // 0＝日曜
  return new Date(t - ((dow + 6) % 7) * 86400000).toISOString().slice(0, 10);
}
export const nextWeekStartOf = (dateText) => new Date(Date.parse(`${weekStartOf(dateText)}T00:00:00Z`) + 7 * 86400000).toISOString().slice(0, 10);
