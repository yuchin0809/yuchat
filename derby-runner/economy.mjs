/* =========================================================
   ゆう経済（ゆう株・ゆう銀行・総資産ランキング）の1日1回の処理
   derby-runner（GitHub Actions）から、日本時間 13:00 以降に1日1回だけ実行する。

   1. 株価の更新・ニュースの決定（market/current）
   2. 預金の利息（users/{名前}.bank）
   3. 返済期限を過ぎた借入の自動返済
   4. 追加ボーナス500コイン（まだ受け取っていない人だけ。以前は毎回の実行で行っていた）
   5. 総資産ランキングのまとめ（rankings/assets）

   読み取り：rankings/assets 1（今日の分が済んでいれば、ここで終わる）＋ market/current 1 ＋ users 全件 1回
             ＋ 書き込みが必要な人だけトランザクション（その人の users 1件）
   書き込み：market/current 1 ＋ 利息・期限切れ・ボーナスのある人だけ ＋ rankings/assets 1
   会社の設定・銀行の設定は script.js と同じにすること
========================================================= */

import crypto from "crypto";
import { FieldValue } from "firebase-admin/firestore";
import { STOCK_NEWS } from "./stock-news.mjs";

/* ----- 株価の秘密値（事前に計算されないように） -----
   株価・ニュース・急騰／暴落の乱数は「秘密値 ＋ 日付 ＋ 会社」から HMAC-SHA256 で作る。
   リポジトリは公開なので、秘密値が無いと翌日の株価を誰でも計算できてしまう。
   ・同じ秘密値・同じ日付なら必ず同じ結果（13:00 の処理を再実行しても変わらない）
   ・秘密値はブラウザにも Firestore にも置かない（derby-runner＝GitHub Actions の中だけで使う）
   秘密値の取り出し方（上から順に使う）：
     1. 環境変数 STOCK_SEED_SECRET（GitHub Secrets に登録した専用の秘密値。推奨）
     2. 環境変数 FIREBASE_SERVICE_ACCOUNT の秘密鍵から作った値（鍵そのものは使わず、ハッシュだけ使う）
     3. Emulator のテストのときだけ、テスト用の固定値
   どれも無いときは株価を更新しない（予測できる乱数では動かさない） */
const TEST_STOCK_SEED_SECRET = "emulator-test-stock-seed";

export function getStockSeedSecret(env = process.env) {
  if (env.STOCK_SEED_SECRET) return { secret: env.STOCK_SEED_SECRET, source: "STOCK_SEED_SECRET" };
  if (env.FIREBASE_SERVICE_ACCOUNT) {
    try {
      const key = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT).private_key;
      if (key) return { secret: crypto.createHash("sha256").update(`yuuchat-stock-seed:v1:${key}`).digest("hex"), source: "FIREBASE_SERVICE_ACCOUNT" };
    } catch {}
  }
  if (env.FIRESTORE_EMULATOR_HOST) return { secret: TEST_STOCK_SEED_SECRET, source: "test" };
  return null;
}

/* 秘密値と見出し（日付・会社など）から、乱数の種を作る */
function secretSeed(secret, label) {
  if (typeof secret !== "string" || secret.length === 0) throw new Error("STOCK_SEED_SECRET が必要です（株価の秘密値が無いため、株価を更新しません）");
  return crypto.createHmac("sha256", secret).update(label).digest("hex");
}

/* ----- script.js と同じ設定 ----- */
export const STOCK_COMPANIES = [
  { code: "YGM", emoji: "🎮", name: "ユウゲームズ", sector: "ゲーム・エンタメ", initialPrice: 180 },
  { code: "YMT", emoji: "🛒", name: "ユウマート", sector: "小売・通販", initialPrice: 240 },
  { code: "YFD", emoji: "🍔", name: "ユウフーズ", sector: "食品・飲食", initialPrice: 150 },
  { code: "YEN", emoji: "⚡", name: "ユウエナジー", sector: "エネルギー", initialPrice: 280 },
  { code: "YPY", emoji: "💳", name: "ユウペイ", sector: "決済・金融", initialPrice: 210 }
];
export const STOCK_MIN_PRICE = 10;
export const DAILY_JOB_HOUR = 13;
export const DAILY_JOB_MINUTE = 0;
export const BANK_INTEREST_RATE = 0.01;
export const BANK_INTEREST_MAX = 100;
const YUU_BONUS_COINS = 500;

/* ----- 株価の動き方 ----- */
const STOCK_DRIFT = 0.002;          /* 長期的な上昇傾向（1日 +0.2%） */
const STOCK_VOLATILITY = 0.025;     /* 通常の値動きのばらつき（だいたい ±5% に収まる） */
const STOCK_PULL = 0.05;            /* 傾向線（初期値 × 1.002^経過日数）へ毎日5%ずつ戻す */
const STOCK_EVENT_CHANCE = 0.03;    /* 急騰・暴落はそれぞれ 3% */
const STOCK_EVENT_MIN = 0.15, STOCK_EVENT_MAX = 0.30;
const NEWS_GOOD_CHANCE = 0.55;
const NEWS_EFFECT_MIN = 0.04, NEWS_EFFECT_MAX = 0.10;
const STOCK_DAY_MIN_CHANGE = -0.5, STOCK_DAY_MAX_CHANGE = 0.6;
const HISTORY_DAYS = 30;
const RECENT_NEWS_KEEP = 60;

const JST_OFFSET_MS = 9 * 3600 * 1000;

/* 日本時間の日付（YYYY-MM-DD） */
export function jstDateString(date) {
  return new Date(date.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/* その日（日本時間）の 13:00 */
export function getDailyJobTime(now) {
  const [y, m, d] = jstDateString(now).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, DAILY_JOB_HOUR - 9, DAILY_JOB_MINUTE, 0));
}

function daysBetween(fromDate, toDate) {
  if (!fromDate) return 0;
  return Math.max(0, Math.round((Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / 86400000));
}

/* 決定的な乱数（同じ文字列からは、いつ・何回実行しても同じ並びになる） */
export function seededRandom(seedText) {
  let h = 1779033703 ^ seedText.length;
  for (let i = 0; i < seedText.length; i++) {
    h = Math.imul(h ^ seedText.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand) {
  const u = Math.max(rand(), 1e-12), v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/* 株価のまとめの初期値（まだ一度も更新していない状態） */
export function createInitialMarket() {
  const companies = {};
  STOCK_COMPANIES.forEach((c) => {
    companies[c.code] = { price: c.initialPrice, prevPrice: c.initialPrice, changePct: 0, history: [c.initialPrice] };
  });
  return { date: "", startDate: "", companies, todayNews: [], events: [], recentNewsIds: [] };
}

/* その日のニュース（1〜3社・平均2社）。日付から決まる */
export function pickDailyNews(dateText, recentNewsIds = [], secret) {
  const rand = seededRandom(secretSeed(secret, `${dateText}:news`));
  const roll = rand();
  const count = roll < 0.25 ? 1 : roll < 0.75 ? 2 : 3;
  const codes = STOCK_COMPANIES.map((c) => c.code);
  for (let i = codes.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [codes[i], codes[j]] = [codes[j], codes[i]]; }
  const recent = new Set(recentNewsIds);
  return codes.slice(0, count).map((code) => {
    const kind = rand() < NEWS_GOOD_CHANCE ? "good" : "bad";
    const list = STOCK_NEWS[code][kind].map((text, i) => ({ id: `${code}-${kind[0]}${String(i + 1).padStart(2, "0")}`, text }));
    const fresh = list.filter((n) => !recent.has(n.id));
    const pool = fresh.length ? fresh : list;
    const chosen = pool[Math.floor(rand() * pool.length)];
    const size = NEWS_EFFECT_MIN + (NEWS_EFFECT_MAX - NEWS_EFFECT_MIN) * rand();
    return { id: chosen.id, code, kind, text: chosen.text, effectPct: Math.round((kind === "good" ? size : -size) * 1000) / 10 };
  });
}

/* 前日の株価のまとめから、その日の株価を計算する（純粋な関数。同じ入力なら必ず同じ結果） */
export function computeDailyMarket(previous, dateText, secret) {
  const prev = previous && previous.companies ? previous : createInitialMarket();
  const startDate = prev.startDate || dateText;
  const days = daysBetween(startDate, dateText);
  const news = pickDailyNews(dateText, prev.recentNewsIds || [], secret);
  const companies = {};
  const events = [];

  STOCK_COMPANIES.forEach((c) => {
    const before = prev.companies[c.code] || { price: c.initialPrice, history: [c.initialPrice] };
    const price = Math.max(STOCK_MIN_PRICE, Number(before.price) || c.initialPrice);
    const rand = seededRandom(secretSeed(secret, `${dateText}:${c.code}`));
    const trend = c.initialPrice * Math.pow(1 + STOCK_DRIFT, days);
    let change = STOCK_DRIFT + gaussian(rand) * STOCK_VOLATILITY + STOCK_PULL * Math.log(trend / price);

    const eventRoll = rand();
    const eventSize = STOCK_EVENT_MIN + (STOCK_EVENT_MAX - STOCK_EVENT_MIN) * rand();
    if (eventRoll < STOCK_EVENT_CHANCE) { change += eventSize; events.push({ code: c.code, kind: "surge", pct: Math.round(eventSize * 1000) / 10 }); }
    else if (eventRoll < STOCK_EVENT_CHANCE * 2) { change -= eventSize; events.push({ code: c.code, kind: "crash", pct: Math.round(-eventSize * 1000) / 10 }); }

    news.filter((n) => n.code === c.code).forEach((n) => { change += n.effectPct / 100; });
    change = Math.min(STOCK_DAY_MAX_CHANGE, Math.max(STOCK_DAY_MIN_CHANGE, change));

    const next = Math.max(STOCK_MIN_PRICE, Math.round(price * (1 + change)));
    const history = [...(Array.isArray(before.history) ? before.history : [price]), next].slice(-HISTORY_DAYS);
    companies[c.code] = { price: next, prevPrice: price, changePct: Math.round(((next - price) / price) * 1000) / 10, history };
  });

  return {
    date: dateText,
    startDate,
    companies,
    todayNews: news,
    events,
    recentNewsIds: [...(prev.recentNewsIds || []), ...news.map((n) => n.id)].slice(-RECENT_NEWS_KEEP)
  };
}

/* ----- 銀行・資産 ----- */

export function normalizeBank(bank) {
  const b = bank && typeof bank === "object" ? bank : {};
  return {
    ...b,
    deposit: Math.max(0, Math.floor(Number(b.deposit) || 0)),
    interestBase: Math.max(0, Math.floor(Number(b.interestBase) || 0)),
    loan: Math.max(0, Math.floor(Number(b.loan) || 0))
  };
}

export function stockValueOf(stocks, prices) {
  return Object.entries(stocks && typeof stocks === "object" ? stocks : {})
    .reduce((sum, [code, h]) => sum + Math.max(0, Math.floor(Number(h?.qty) || 0)) * (Number(prices[code]) || 0), 0);
}

/* 総資産 = 手持ちコイン + 銀行預金 + 保有株の評価額 − 借入残高 */
export function totalAssetsOf(data, prices) {
  const bank = normalizeBank(data.bank);
  const coins = Number(data.coins) || 0;
  const stockValue = stockValueOf(data.stocks, prices);
  return { coins, deposit: bank.deposit, stockValue, loan: bank.loan, total: coins + bank.deposit + stockValue - bank.loan };
}

/* ゆう税（累進課税）：総資産のうち、YUU_TAX_FREE を超えた部分だけに、段階ごとの税率で毎日13:00にかける。
   ・総資産＝手持ち＋預金＋株の評価額−借入（利息・自動返済のあとの値）。YUU_TAX_FREE 以下の人にはかからない。
   ・手持ちコインから先に引き、足りなければ預金から。株は売らない。集めたコインは消える（コインの総量が減る）。
   ・同じ日に2回かけない（bank.taxDate）。税が0の人には何も書かない（書き込みを増やさない）。 */
export const YUU_TAX_FREE = 5000;
export const YUU_TAX_BRACKETS = [{ upTo: 10000, rate: 0.01 }, { upTo: 30000, rate: 0.02 }, { upTo: Infinity, rate: 0.03 }];
export function yuuTaxOf(total) {
  let tax = 0, lo = YUU_TAX_FREE;
  for (const b of YUU_TAX_BRACKETS) {
    if (total <= lo) break;
    tax += (Math.min(total, b.upTo) - lo) * b.rate;
    lo = b.upTo;
  }
  return Math.floor(tax);
}

/* 1人分の1日1回の処理（利息 → 返済期限切れの自動返済 → ゆう税 → 追加ボーナス）。変更が無ければ null。prices が無ければ、税はかけない */
export function applyDailyUserUpdate(data, today, now, prices = null) {
  const bank = normalizeBank(data.bank);
  let coins = typeof data.coins === "number" ? data.coins : null;
  const update = {};
  let interest = 0, repaid = null, bonus = false;

  /* 利息：前回の利息のあとの残高（interestBase）と今の残高の少ない方に 1%（上限100）。
     13:00 の直前に預けても、その日の利息は付かない */
  if ((bank.deposit > 0 || bank.interestBase > 0) && bank.interestDate !== today) {
    interest = Math.min(Math.floor(Math.min(bank.deposit, bank.interestBase) * BANK_INTEREST_RATE), BANK_INTEREST_MAX);
    bank.deposit += interest;
    bank.interestDate = today;
    bank.lastInterest = interest;
    update.bank = true;
  }

  /* 返済期限を過ぎた借入：預金 → 手持ちコインの順に、返せる分だけ返す。残りは借入のまま */
  const due = bank.loanDueAt && typeof bank.loanDueAt.toDate === "function" ? bank.loanDueAt.toDate() : null;
  if (bank.loan > 0 && due && due <= now && bank.overdueDate !== today) {
    const fromDeposit = Math.min(bank.deposit, bank.loan);
    bank.deposit -= fromDeposit;
    bank.loan -= fromDeposit;
    const fromCoins = coins === null ? 0 : Math.min(Math.max(0, Math.floor(coins)), bank.loan);
    if (coins !== null) coins -= fromCoins;
    bank.loan -= fromCoins;
    repaid = { date: today, amount: fromDeposit + fromCoins, fromDeposit, fromCoins, remaining: bank.loan };
    bank.lastAutoRepay = repaid;
    bank.overdueDate = today;
    bank.overdue = bank.loan > 0;
    if (bank.loan === 0) { bank.loanDueAt = null; bank.loanTakenAt = null; }
    update.bank = true;
    if (fromCoins > 0) update.coins = true;
  }

  /* ゆう税（利息・自動返済のあとの総資産で計算）。手持ち → 預金の順に引く */
  let tax = 0;
  if (prices && bank.taxDate !== today) {
    const cash = coins === null ? 0 : Math.max(0, Math.floor(coins));
    const total = (coins === null ? 0 : coins) + bank.deposit + stockValueOf(data.stocks, prices) - bank.loan;
    tax = Math.min(yuuTaxOf(total), cash + bank.deposit);
    if (tax > 0) {
      const fromCoins = Math.min(cash, tax), fromDeposit = tax - fromCoins;
      if (fromCoins > 0) { coins -= fromCoins; update.coins = true; }
      bank.deposit -= fromDeposit;
      bank.taxDate = today;
      bank.lastTax = tax;
      update.bank = true;
    }
  }

  if (update.bank) bank.interestBase = bank.deposit; /* 次の利息の対象は、今日の処理のあとの残高 */

  if (coins !== null && data.bonus500Granted !== true) {
    coins += YUU_BONUS_COINS;
    bonus = true;
    update.coins = true;
  }

  if (!update.bank && !update.coins) return null;
  const fields = {};
  if (update.bank) fields.bank = bank;
  if (update.coins) fields.coins = coins;
  if (bonus) { fields.bonus500Granted = true; fields.bonus500GrantedAt = FieldValue.serverTimestamp(); }
  return { fields, interest, repaid, bonus, tax };
}

/* 総資産ランキング（同額は同じ順位。並びは総資産の多い順、同額は名前の順） */
export function buildAssetRanking(entries) {
  const sorted = [...entries].sort((a, b) => (b.total - a.total) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  let rank = 0, prev = null;
  return sorted.map((e, i) => {
    if (e.total !== prev) { rank = i + 1; prev = e.total; }
    return { ...e, rank };
  });
}

/* ----- 経済の状態のまとめ（インフレの目安。管理者の「経済の状態」画面と、毎日の記録に使う） -----
   entries＝[{ coins, deposit, stockValue, loan, total }]。同じ計算が notify-worker/worker.js の economySummary にもある（同じ結果になること）。
   ・total＝コイン総量の目安：手持ち＋預金＋株の評価額−借入（借入は引く）。coins＝手持ちだけ。
   ・top1/top10Share＝総資産の合計のうち、上位1人／上位10人が持っている割合（マイナスの人は 0 として数える）。 gini＝0（みんな同じ）〜1（1人が全部）。 */
export function summarizeEconomy(entries) {
  const list = entries.map((e) => ({ coins: Number(e.coins) || 0, deposit: Number(e.deposit) || 0, stockValue: Number(e.stockValue) || 0, loan: Number(e.loan) || 0, total: Number(e.total) || 0 }));
  const n = list.length;
  const sum = (k) => list.reduce((s, e) => s + e[k], 0);
  const totals = list.map((e) => Math.max(0, e.total)).sort((a, b) => b - a);
  const all = totals.reduce((s, v) => s + v, 0);
  const asc = [...totals].reverse();
  let gini = 0;
  if (n > 1 && all > 0) { let w = 0; asc.forEach((v, i) => { w += (i + 1) * v; }); gini = Math.max(0, Math.min(1, (2 * w) / (n * all) - (n + 1) / n)); }
  const median = n === 0 ? 0 : (asc.length % 2 ? asc[(asc.length - 1) / 2] : (asc[asc.length / 2 - 1] + asc[asc.length / 2]) / 2);
  const bands = [[0, 500], [500, 2000], [2000, 10000], [10000, 50000], [50000, Infinity]].map(([lo, hi]) => ({ lo, hi: hi === Infinity ? null : hi, users: totals.filter((v) => v >= lo && v < hi).length }));
  return {
    users: n, coins: sum("coins"), deposit: sum("deposit"), stockValue: sum("stockValue"), loan: sum("loan"), total: sum("total"),
    avg: n ? Math.round(sum("total") / n) : 0, median: Math.round(median),
    top1: totals[0] || 0, top1Share: all ? totals[0] / all : 0, top10Share: all ? totals.slice(0, 10).reduce((s, v) => s + v, 0) / all : 0,
    gini: Math.round(gini * 1000) / 1000, bands
  };
}
export const ECONOMY_HISTORY_DAYS = 120;

/* ----- 総資産ランキングだけの更新（日本時間 9:00〜16:59 に1時間おき。ranking-hourly.mjs から） -----
   ・1日1回の処理（runDailyJobs）とは別。株価・利息・ボーナスには触れない（その日の処理が済んだかを見る date・complete は変えない。update で必要な項目だけ書く）。
   ・株価は毎日 13:00 にしか変わらないので、途中の更新で動くのは、コイン・預金・株の保有数・借入が変わった人の順位だけ。
   ・読み取り：users 全件 1回 ＋ market/current 1。書き込み：rankings/assets 1（無ければ何もしない＝最初の13:00の処理が作る）。 */
export const RANKING_LIVE_FROM_HOUR = 9;
export const RANKING_LIVE_TO_HOUR = 17; /* 17時より前（16:59 まで） */
export async function refreshAssetRanking({ db, now = new Date(), log = console.log }) {
  const hour = new Date(now.getTime() + 9 * 3600000).getUTCHours();
  if (hour < RANKING_LIVE_FROM_HOUR || hour >= RANKING_LIVE_TO_HOUR) return { status: "skipped", reason: "outside" };
  const marketSnap = await db.collection("market").doc("current").get();
  if (!marketSnap.exists) return { status: "skipped", reason: "no_market" };
  const companies = marketSnap.data().companies || {};
  const prices = Object.fromEntries(Object.entries(companies).map(([code, c]) => [code, c.price]));
  const usersSnap = await db.collection("users").select("uid", "coins", "bank", "stocks").get();
  const entries = usersSnap.docs.map((d) => ({ name: d.id, data: d.data() })).filter((e) => typeof e.data.coins === "number").map((e) => ({ name: e.name, ...totalAssetsOf(e.data, prices) }));
  const ranking = buildAssetRanking(entries);
  try {
    await db.collection("rankings").doc("assets").update({ users: ranking, userCount: ranking.length, liveUpdatedAt: FieldValue.serverTimestamp() });
  } catch (error) {
    if (error && (error.code === 5 || /NOT_FOUND/.test(String(error.message)))) return { status: "skipped", reason: "no_ranking" };
    throw error;
  }
  log(JSON.stringify({ rankingRefresh: { users: ranking.length } }));
  return { status: "ok", users: ranking.length };
}

/* ----- 1日1回の処理（13:00 以降。同じ日は1回だけ） ----- */
export async function runDailyJobs({ db, now = new Date(), log = console.log, stockSecret = getStockSeedSecret() }) {
  const today = jstDateString(now);
  const result = { date: today, status: "skipped", errors: [] };
  if (now < getDailyJobTime(now)) { result.reason = "13:00 前"; return result; }

  const rankingRef = db.collection("rankings").doc("assets");
  const done = await rankingRef.get();
  if (done.exists && done.data().date === today && done.data().complete === true) { result.reason = "今日の処理は済み"; return result; }

  /* 1. 株価の更新（トランザクションで、同じ日に2回計算しない） */
  const marketRef = db.collection("market").doc("current");
  const market = await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(marketRef);
    const current = snap.exists ? snap.data() : null;
    if (current && current.date === today) return { data: current, updated: false };
    if (!stockSecret?.secret) throw new Error("株価の秘密値（STOCK_SEED_SECRET）がありません。株価を更新できません");
    const next = computeDailyMarket(current, today, stockSecret.secret);
    transaction.set(marketRef, { ...next, updatedAt: FieldValue.serverTimestamp(), updatedBy: "github-actions" });
    return { data: next, updated: true };
  });
  result.marketUpdated = market.updated;
  if (market.updated) result.stockSeedSource = stockSecret.source; /* どの秘密値を使ったか（値そのものは出さない） */
  result.news = market.data.todayNews || [];
  result.events = market.data.events || [];
  const prices = Object.fromEntries(Object.entries(market.data.companies).map(([code, c]) => [code, c.price]));

  /* 2〜4. 利息・返済期限切れ・追加ボーナス（必要な人だけ書き込む） */
  const usersSnap = await db.collection("users").select("uid", "coins", "bank", "stocks", "bonus500Granted").get();
  const finalData = new Map();
  Object.assign(result, { users: usersSnap.size, interestUsers: 0, interestTotal: 0, autoRepaid: 0, autoRepaidTotal: 0, bonusGranted: 0, taxUsers: 0, taxTotal: 0 });

  for (const userDoc of usersSnap.docs) {
    const data = userDoc.data();
    finalData.set(userDoc.id, data);
    if (!applyDailyUserUpdate(data, today, now, prices)) continue;
    try {
      const outcome = await db.runTransaction(async (transaction) => {
        const fresh = await transaction.get(userDoc.ref);
        if (!fresh.exists) return null;
        const freshData = fresh.data();
        const change = applyDailyUserUpdate(freshData, today, now, prices);
        if (change) transaction.update(userDoc.ref, change.fields);
        return { change, data: { ...freshData, ...(change ? change.fields : {}) } };
      });
      if (!outcome) { finalData.delete(userDoc.id); continue; }
      finalData.set(userDoc.id, outcome.data);
      const change = outcome.change;
      if (!change) continue;
      if (change.interest > 0) { result.interestUsers++; result.interestTotal += change.interest; }
      if (change.repaid) { result.autoRepaid++; result.autoRepaidTotal += change.repaid.amount; }
      if (change.bonus) result.bonusGranted++;
      if (change.tax > 0) { result.taxUsers++; result.taxTotal += change.tax; }
    } catch (error) {
      result.errors.push(`user ${userDoc.id}: ${error.message || error}`);
    }
  }

  /* 5. 総資産ランキング（ここまでの最新の値で計算。全員が対象） */
  const entries = [...finalData.entries()]
    .filter(([, data]) => typeof data.coins === "number")
    .map(([name, data]) => ({ name, ...totalAssetsOf(data, prices) }));
  const ranking = buildAssetRanking(entries);
  await rankingRef.set({
    date: today,
    complete: result.errors.length === 0, /* 失敗した人がいれば、次の実行でもう一度（1人ずつの処理は二重にならない） */
    prices,
    users: ranking,
    userCount: ranking.length,
    updatedAt: FieldValue.serverTimestamp(),
    liveUpdatedAt: FieldValue.serverTimestamp(), /* 画面に出す「最終更新」。9:00〜16:00 の1時間おきの更新（refreshAssetRanking）でも更新する */
    updatedBy: "github-actions"
  });
  result.rankingUsers = ranking.length;
  /* 経済の状態の毎日の記録（1日1点。管理者の画面の推移に使う。失敗しても、今日の処理は止めない） */
  try {
    const histRef = db.collection("economyStats").doc("history");
    const snap = await histRef.get();
    const points = (snap.exists && Array.isArray(snap.data().points) ? snap.data().points : []).filter((p) => p && p.date !== today);
    points.push({ date: today, ...summarizeEconomy(ranking), interestUsers: result.interestUsers, interestTotal: result.interestTotal, autoRepaidTotal: result.autoRepaidTotal, bonusGranted: result.bonusGranted, taxUsers: result.taxUsers, taxTotal: result.taxTotal });
    await histRef.set({ points: points.slice(-ECONOMY_HISTORY_DAYS), updatedAt: FieldValue.serverTimestamp(), updatedBy: "github-actions" });
  } catch (error) {
    result.errors.push(`economyStats: ${error.message || error}`);
  }
  result.status = result.errors.length ? "error" : "ok";
  log(JSON.stringify({ dailyJobs: { ...result, news: result.news.map((n) => `${n.code}:${n.kind}`), events: result.events.map((e) => `${e.code}:${e.kind}`) } }));
  return result;
}

