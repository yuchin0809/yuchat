/* 経済の状態のまとめ（summarizeEconomy）と、毎日の記録（runDailyJobs が economyStats/history に1日1点を書く）のテスト（モック Firestore）
   実行：node --test derby-runner/economy-stats.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import { summarizeEconomy, runDailyJobs, ECONOMY_HISTORY_DAYS } from "./economy.mjs";

const e = (total, coins = total) => ({ coins, deposit: 0, stockValue: 0, loan: 0, total });

test("まとめ：総量・平均・中央値・上位の割合・格差（ジニ係数）・金額の帯", () => {
  const s = summarizeEconomy([e(100), e(100), e(100), e(100)]);
  assert.equal(s.users, 4); assert.equal(s.total, 400); assert.equal(s.avg, 100); assert.equal(s.median, 100);
  assert.equal(s.gini, 0, "みんな同じなら格差なし"); assert.equal(s.top1Share, 0.25);
  const t = summarizeEconomy([e(1), e(1), e(1), e(9997)]);
  assert.ok(t.gini > 0.7, "1人が持っていれば格差は大きい"); assert.ok(t.top1Share > 0.99); assert.equal(t.median, 1);
  assert.deepEqual(t.bands.map((b) => b.users), [3, 0, 1, 0, 0]);
  const m = summarizeEconomy([{ coins: 50, deposit: 100, stockValue: 200, loan: 30, total: 320 }]);
  assert.equal(m.coins, 50); assert.equal(m.deposit, 100); assert.equal(m.stockValue, 200); assert.equal(m.loan, 30); assert.equal(m.total, 320);
  const z = summarizeEconomy([]); assert.equal(z.users, 0); assert.equal(z.total, 0); assert.equal(z.median, 0); assert.equal(z.top10Share, 0);
  const neg = summarizeEconomy([e(-100), e(300)]); assert.equal(neg.top1Share, 1, "マイナスの人は 0 として数える");
});

function mockDb({ users, history = null }) {
  const docs = new Map([["market/current", null], ["rankings/assets", null]]);
  if (history) docs.set("economyStats/history", { points: history });
  const writes = [];
  const userDocs = Object.entries(users).map(([id, data]) => ({ id, data: () => structuredClone(data), ref: { path: `users/${id}` } }));
  const ref = (path) => ({
    path,
    async get() { const d = docs.get(path); return { exists: d !== undefined && d !== null, data: () => d }; },
    async set(v) { writes.push({ path, v }); docs.set(path, v); },
    async update(v) { writes.push({ path, v }); }
  });
  return {
    writes, docs,
    collection(name) { return { doc: (id) => ref(`${name}/${id}`), select: () => ({ async get() { return { size: userDocs.length, docs: userDocs }; } }) }; },
    async runTransaction(fn) {
      const t = { async get(r) { return r.path.startsWith("users/") ? { exists: true, data: () => structuredClone(users[r.path.slice(6)]) } : r.get(); }, update() {}, set(r, v) { writes.push({ path: r.path, v }); docs.set(r.path, v); } };
      return fn(t);
    }
  };
}

test("毎日の記録：13:00 の処理のあと economyStats/history に今日の1点を足す。同じ日の再実行は置き換え。古い点は残す。最大の日数まで", async () => {
  const now = new Date(Date.UTC(2026, 9, 24, 4, 5, 0)); // 2026-10-24 13:05 JST
  const old = Array.from({ length: ECONOMY_HISTORY_DAYS + 5 }, (_, i) => ({ date: `old-${i}`, total: i }));
  const db = mockDb({ users: { a: { uid: "ua", coins: 1000, bank: { deposit: 200, interestBase: 200, loan: 0 } }, b: { uid: "ub", coins: 50, bonus500Granted: true } }, history: [...old, { date: "2026-10-24", total: 1 }] });
  const r = await runDailyJobs({ db, now, log: () => {}, stockSecret: { secret: "s", source: "test" } });
  assert.equal(r.status, "ok");
  const w = db.writes.filter((x) => x.path === "economyStats/history");
  assert.equal(w.length, 1);
  const pts = w[0].v.points;
  assert.equal(pts.length, ECONOMY_HISTORY_DAYS); assert.equal(pts.at(-1).date, "2026-10-24"); assert.equal(pts.filter((p) => p.date === "2026-10-24").length, 1);
  const today = pts.at(-1);
  assert.equal(today.users, 2); assert.ok(today.total > 1000); assert.equal(typeof today.interestTotal, "number"); assert.equal(typeof today.gini, "number"); assert.ok(Array.isArray(today.bands));
  assert.equal(pts[0].date, `old-${old.length - (ECONOMY_HISTORY_DAYS - 1)}`, "古い点から捨てる");
});

/* ---- ゆう税（累進課税） ---- */
import { yuuTaxOf, applyDailyUserUpdate, YUU_TAX_FREE } from "./economy.mjs";

test("ゆう税の計算：5,000 以下は0。超えた部分だけに 5,000〜1万＝2%・1万〜1.5万＝4%・1.5万〜2万＝6%・2万〜＝8%（切り捨て）", () => {
  assert.equal(YUU_TAX_FREE, 5000);
  assert.equal(yuuTaxOf(0), 0); assert.equal(yuuTaxOf(2500), 0); assert.equal(yuuTaxOf(5000), 0); assert.equal(yuuTaxOf(5001), 0, "0.02 → 切り捨てで 0");
  assert.equal(yuuTaxOf(8000), 60, "(8000−5000)×2%");
  assert.equal(yuuTaxOf(10000), 100);
  assert.equal(yuuTaxOf(12286), 100 + Math.floor(2286 * 0.04), "10,000 を超えた部分は 4%");
  assert.equal(yuuTaxOf(20000), 100 + 200 + 300);
  assert.equal(yuuTaxOf(20958), 600 + Math.floor(958 * 0.08), "20,000 を超えた部分は 8%");
  assert.equal(yuuTaxOf(50000), 600 + 2400);
  assert.equal(yuuTaxOf(-100), 0);
});

const PRICES = { YGM: 100 };
const NOW = new Date(Date.UTC(2026, 9, 25, 4, 5, 0));
test("ゆう税の払い方：手持ちコインから先に引く。足りなければ預金から。株は売らない。借入は総資産から引く。5,000 以下の人には何も書かない", () => {
  const rich = applyDailyUserUpdate({ bonus500Granted: true, coins: 9000, bank: { deposit: 0, interestBase: 0, loan: 0 } }, "2026-10-25", NOW, PRICES);
  assert.equal(rich.tax, 80); assert.equal(rich.fields.coins, 8920); assert.equal(rich.fields.bank.taxDate, "2026-10-25"); assert.equal(rich.fields.bank.lastTax, 80);
  const poor = applyDailyUserUpdate({ bonus500Granted: true, coins: 2500, bank: { deposit: 0, interestBase: 0, loan: 0 } }, "2026-10-25", NOW, PRICES);
  assert.equal(poor, null, "税0の人は書き込まない");
  const edge = applyDailyUserUpdate({ bonus500Granted: true, coins: 5000, bank: { deposit: 0, interestBase: 0, loan: 0 } }, "2026-10-25", NOW, PRICES);
  assert.equal(edge, null, "ちょうど 5,000 はかからない");
  // 手持ちが足りない人：預金から引く（株は売らない）。総資産＝手持ち100＋預金0＋株 10,000×100…（株は評価額に入るが、引くのは手持ち・預金だけ）
  const stocky = applyDailyUserUpdate({ bonus500Granted: true, coins: 100, bank: { deposit: 0, interestBase: 0, loan: 0 }, stocks: { YGM: { qty: 200, cost: 0 } } }, "2026-10-25", NOW, PRICES);
  assert.equal(stocky.tax, 100, "総資産20,100の税は 608 だが、払えるのは手持ち100まで");
  assert.equal(stocky.fields.coins, 0);
  const dep = applyDailyUserUpdate({ bonus500Granted: true, coins: 10, bank: { deposit: 8000, interestBase: 8000, loan: 0 } }, "2026-10-25", NOW, PRICES);
  assert.equal(dep.interest, 80); // 利息が先
  assert.equal(dep.tax, yuuTaxOf(10 + 8080)); assert.equal(dep.fields.coins, 0); assert.equal(dep.fields.bank.deposit, 8080 - (dep.tax - 10), "手持ち10を引いたあと、残りは預金から");
  assert.equal(dep.fields.bank.interestBase, dep.fields.bank.deposit, "次の利息の対象は処理のあとの残高");
  const loaned = applyDailyUserUpdate({ bonus500Granted: true, coins: 7000, bank: { deposit: 0, interestBase: 0, loan: 2500 } }, "2026-10-25", NOW, PRICES);
  assert.equal(loaned, null, "借入を引くと総資産 4,500 → 税0 → 何も書かない");
});

test("ゆう税は同じ日に2回かからない。prices が無いとき（税の対象外の呼び出し）はかけない", () => {
  const first = applyDailyUserUpdate({ bonus500Granted: true, coins: 9000, bank: { deposit: 0, interestBase: 0, loan: 0 } }, "2026-10-25", NOW, PRICES);
  const again = applyDailyUserUpdate({ bonus500Granted: true, coins: first.fields.coins, bank: first.fields.bank }, "2026-10-25", NOW, PRICES);
  assert.equal(again, null, "同じ日の再実行は何もしない");
  const tomorrow = applyDailyUserUpdate({ bonus500Granted: true, coins: first.fields.coins, bank: first.fields.bank }, "2026-10-26", NOW, PRICES);
  assert.equal(tomorrow.tax, yuuTaxOf(8920), "次の日はまたかかる");
  assert.equal(applyDailyUserUpdate({ bonus500Granted: true, coins: 9000, bank: { deposit: 0, interestBase: 0, loan: 0 } }, "2026-10-25", NOW), null);
});

test("13:00 の処理：税の合計と人数が、毎日の記録（economyStats/history）に入る。税を引いたあとの値でランキングが作られる", async () => {
  const db = mockDb({ users: { a: { uid: "ua", coins: 9000, bonus500Granted: true, bank: { deposit: 0, interestBase: 0, loan: 0 } }, b: { uid: "ub", coins: 2500, bonus500Granted: true } } });
  const r = await runDailyJobs({ db, now: new Date(Date.UTC(2026, 9, 25, 4, 5, 0)), log: () => {}, stockSecret: { secret: "s", source: "test" } });
  assert.equal(r.taxUsers, 1); assert.equal(r.taxTotal, 80);
  const pts = db.writes.find((x) => x.path === "economyStats/history").v.points;
  assert.equal(pts.at(-1).taxTotal, 80); assert.equal(pts.at(-1).taxUsers, 1);
});
