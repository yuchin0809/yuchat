/* =========================================================
   🥷 スリ（総資産が多い人のところに、ときどき泥棒が来る）と、防犯の強化

   ・この表と計算は、アプリ（script.js）・毎日13:00の処理（derby-runner/economy.mjs）が使う。Worker（notify-worker/worker.js）には、
     防犯グッズの買い物のために、同じ表（THEFT_GUARDS・guardPriceOf・weekStartOf）を写してある（同じであることは notify-worker/test/theft.test.mjs が確かめる）。
   ・来るかどうかは、毎日13:00の処理が、秘密の値と日付とユーザーから決める（ずるい予想ができない）。結果は、users の theft・手持ち・預金・株に書く。
   ・総資産15,000コイン以上の人が対象。総資産が多いほど、また最近一気に増えた人ほど、来やすい。1週間（月〜日）に最大7回（毎日来ることもある）。
   ・奪うのは、総資産の 5〜15%（整数のパーセントを、どれも同じ確率で）。手持ちコイン → 預金 → 株（時価で売った扱い）の順に取る。借入は取られない。取られたものは消える（コインの総量が減る）。
   ・防犯グッズ（毎週買い直し・暦の週が対象）：来た泥棒を追い払う確率と、取られる額を減らす割合。
========================================================= */

export const THEFT_MIN_TOTAL = 15000;                     // この総資産から対象
export const THEFT_WEEK_MAX = 7;                          // 1週間（月〜日）に来る回数の上限（追い払った回も数える）
export const THEFT_RATE_TABLE = [[15000, 2.5], [30000, 3.5], [60000, 4.5], [100000, 5.5], [200000, 6.0]];   // [総資産, 防犯なしの週の平均回数]
export const THEFT_SURGE = { minGain: 3000, ratio: 1.5, extra: 1.0 };   // 先週の総資産から +3,000 以上かつ 1.5倍以上：週の平均回数に +1.0
export const THEFT_DAMAGE = { minPct: 5, maxPct: 15, cap: 10000 };    // 1回に取られる額：総資産の 5〜15%（整数のパーセントを、どれも同じ確率で。上限10,000）
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

/* 防犯なしの、週の平均回数（総資産が多いほど増える。表のあいだは直線でつなぐ）。surge：最近一気に増えたとき */
export function theftWeeklyRate(total, surge = false) {
  if (!(total >= THEFT_MIN_TOTAL)) return 0;
  let rate = THEFT_RATE_TABLE[THEFT_RATE_TABLE.length - 1][1];
  for (let i = 0; i < THEFT_RATE_TABLE.length - 1; i++) {
    const [a, ra] = THEFT_RATE_TABLE[i], [b, rb] = THEFT_RATE_TABLE[i + 1];
    if (total < b) { rate = ra + ((total - a) / (b - a)) * (rb - ra); break; }
  }
  return Math.min(THEFT_WEEK_MAX, rate + (surge ? THEFT_SURGE.extra : 0));
}

/* 一気に増えたか（先週の総資産 base と今 total から） */
export const isSurge = (total, base) => Number.isFinite(base) && base >= 0 && total - base >= THEFT_SURGE.minGain && total >= base * THEFT_SURGE.ratio;

/* 取る：手持ち → 預金 → 株の順。株は時価の高い会社から、必要な額に足りる株数だけ売った扱いにして、取った額を超えた分は手持ちに戻す。
   coins・deposit・stocks（{ code: { qty, cost, … } }）は変えずに、新しい値を返す。 */
export function takeFromAssets({ coins, deposit, stocks }, amount, prices) {
  let need = Math.max(0, Math.floor(amount));
  const out = { coins: Number(coins) || 0, deposit: Math.max(0, Math.floor(Number(deposit) || 0)), stocks: structuredClone(stocks && typeof stocks === "object" ? stocks : {}), from: { coins: 0, deposit: 0, stock: 0 }, sold: [], taken: 0 };
  const c = Math.min(Math.max(0, Math.floor(out.coins)), need);
  out.coins -= c; need -= c; out.from.coins = c;
  const d = Math.min(out.deposit, need);
  out.deposit -= d; need -= d; out.from.deposit = d;
  if (need > 0) {
    const codes = Object.keys(out.stocks)
      .map((code) => ({ code, qty: Math.max(0, Math.floor(Number(out.stocks[code]?.qty) || 0)), price: Number(prices?.[code]) || 0 }))
      .filter((s) => s.qty > 0 && s.price > 0)
      .sort((a, b) => (b.qty * b.price - a.qty * a.price) || (a.code < b.code ? -1 : 1));
    for (const s of codes) {
      if (need <= 0) break;
      const sell = Math.min(s.qty, Math.ceil(need / s.price)), value = sell * s.price, take = Math.min(need, value);
      const h = out.stocks[s.code], left = s.qty - sell;
      out.stocks[s.code] = { ...h, qty: left, cost: left > 0 ? Math.round((Number(h.cost) || 0) * (left / s.qty)) : 0 };
      need -= take; out.from.stock += take; out.sold.push({ code: s.code, qty: sell });
      out.coins += value - take;   // 取った額を超えた分は、手持ちに戻す
    }
  }
  out.taken = out.from.coins + out.from.deposit + out.from.stock;
  return out;
}

/* 被害の種類（演出の名前） */
export function theftKind(from) {
  if (from.stock > 0) return { id: "stock", emoji: "📈", name: "株券泥棒" };
  if (from.deposit > 0) return { id: "bank", emoji: "🏦", name: "銀行強盗" };
  return { id: "pickpocket", emoji: "🥷", name: "スリ" };
}
