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
