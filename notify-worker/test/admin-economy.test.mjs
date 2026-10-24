/* 📊 管理者：経済の状態（インフレの目安。worker.js の economyReport）のテスト
   実行：node --test "notify-worker/test/*.test.mjs" */
import test from "node:test";
import assert from "node:assert/strict";
import { handleAdminAction, economySummary, economyTrend, BANKUJI } from "../worker.js";

console.warn = () => {};

const ROOT = "projects/p/databases/(default)/documents";
const enc = (v) => v === null || v === undefined ? { nullValue: null } : v instanceof Date ? { timestampValue: v.toISOString() } : typeof v === "boolean" ? { booleanValue: v } : typeof v === "number" ? (Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v }) : Array.isArray(v) ? { arrayValue: { values: v.map(enc) } } : typeof v === "object" ? { mapValue: { fields: encF(v) } } : { stringValue: String(v) };
const encF = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const dec = (v) => !v ? undefined : "nullValue" in v ? null : "integerValue" in v ? Number(v.integerValue) : "doubleValue" in v ? v.doubleValue : "booleanValue" in v ? v.booleanValue : "timestampValue" in v ? v.timestampValue : "stringValue" in v ? v.stringValue : v.arrayValue ? (v.arrayValue.values || []).map(dec) : v.mapValue ? decF(v.mapValue.fields) : undefined;
const decF = (f) => Object.fromEntries(Object.entries(f || {}).map(([k, v]) => [k, dec(v)]));

function fakeFs(initial = {}) {
  const docs = new Map(); let ver = 1;
  const put = (p, f) => docs.set(p, { fields: structuredClone(f), updateTime: `t${ver++}` });
  Object.entries(initial).forEach(([p, d]) => put(p, encF(d)));
  const counts = { get: 0, getRaw: 0, query: 0, batchGet: 0, commit: 0 };
  const plain = (p) => { const d = docs.get(p); return d ? decF(d.fields) : null; };
  const fs = {
    docs, counts, put, plain,
    docName: (p) => `${ROOT}/${p}`,
    async get(p) { counts.get++; return plain(p); },
    async getRaw(p) { counts.getRaw++; const d = docs.get(p); return d ? structuredClone(d) : null; },
    async batchGet(paths) { counts.batchGet++; return paths.map(plain); },
    async query(collection, filters = []) {
      counts.query++;
      return [...docs.entries()].filter(([p]) => p.startsWith(collection + "/"))
        .map(([p, d]) => ({ id: p.split("/").slice(1).join("/"), path: p, updateTime: d.updateTime, data: decF(d.fields) }))
        .filter((r) => filters.every(([f, op, v]) => op === "EQUAL" && r.data[f] === v));
    },
    async set(p, data) { put(p, encF(data)); },
    async delete(p) { docs.delete(p); },
    async createIfAbsent(p, data) { if (docs.has(p)) return false; put(p, encF(data)); return true; },
    async update(p, data) { const cur = docs.get(p)?.fields || {}; put(p, { ...cur, ...encF(data) }); },
    async commit(writes) {
      counts.commit++;
      for (const w of writes) {
        const path = (w.update?.name || w.delete).slice(ROOT.length + 1);
        const cur = docs.get(path);
        if (w.currentDocument?.updateTime && cur?.updateTime !== w.currentDocument.updateTime) throw Object.assign(new Error("firestore commit 400 FAILED_PRECONDITION"), { status: 400 });
        if (w.currentDocument?.exists === false && cur) throw Object.assign(new Error("409 ALREADY_EXISTS"), { status: 409 });
        if (w.currentDocument?.exists === true && !cur) throw Object.assign(new Error("404 NOT_FOUND"), { status: 404 });
      }
      for (const w of writes) {
        if (w.delete) { docs.delete(w.delete.slice(ROOT.length + 1)); continue; }
        const path = w.update.name.slice(ROOT.length + 1);
        const cur = docs.get(path)?.fields || {};
        const next = w.updateMask ? { ...cur } : { ...w.update.fields };
        if (w.updateMask) for (const fp of w.updateMask.fieldPaths) { if (w.update.fields[fp] !== undefined) next[fp] = w.update.fields[fp]; else delete next[fp]; }
        (w.updateTransforms || []).forEach((t) => {
          if (t.appendMissingElements) { const cur2 = next[t.fieldPath]?.arrayValue?.values || []; const have = new Set(cur2.map((v) => JSON.stringify(v))); next[t.fieldPath] = { arrayValue: { values: [...cur2, ...t.appendMissingElements.values.filter((v) => !have.has(JSON.stringify(v)))] } }; }
          if (t.increment) next[t.fieldPath] = { integerValue: String((Number(next[t.fieldPath]?.integerValue) || 0) + Number(t.increment.integerValue)) }; 
        });
        put(path, next);
      }
    }
  };
  return fs;
}

const ADMIN = "adminUid";
const NOW = Date.UTC(2026, 10, 3, 3, 0, 0); // 2026-11-03 12:00 JST（火）
const e = (total, extra = {}) => ({ coins: total, deposit: 0, stockValue: 0, loan: 0, total, ...extra });
const mk = (extra = {}) => { const fs = fakeFs(extra); return { fs, deps: { firestore: fs, adminUid: ADMIN, now: () => NOW, random: Math.random }, report: () => handleAdminAction({ firestore: fs, adminUid: ADMIN, now: () => NOW, random: Math.random }, ADMIN, { action: "economyReport" }) }; };

test("管理者だけが呼べる。ふつうの人は 403", async () => {
  const { deps } = mk();
  assert.equal((await handleAdminAction(deps, "uX", { action: "economyReport" })).error, "not_admin");
});

test("まとめ：総量・平均・中央値・上位の割合・格差・金額の帯（derby-runner の summarizeEconomy と同じ）", () => {
  const s = economySummary([e(100), e(100), e(100), e(100)]);
  assert.equal(s.total, 400); assert.equal(s.avg, 100); assert.equal(s.median, 100); assert.equal(s.gini, 0); assert.equal(s.top1Share, 0.25);
  const t = economySummary([e(1), e(1), e(1), e(9997)]);
  assert.ok(t.gini > 0.7); assert.deepEqual(t.bands.map((b) => b.users), [3, 0, 1, 0, 0]);
  const m = economySummary([{ coins: 50, deposit: 100, stockValue: 200, loan: 30, total: 320 }]);
  assert.deepEqual([m.coins, m.deposit, m.stockValue, m.loan, m.total], [50, 100, 200, 30, 320]);
  assert.equal(economySummary([]).users, 0);
});

test("増え方の判定：1人あたり（平均）が7日で +10% 以上＝要対策、+3% 以上＝ゆるやかなインフレ、それ未満は安定。点が足りなければ null", () => {
  const pts = (avgs) => avgs.map((avg, i) => ({ date: `d${i}`, users: 10, avg, total: avg * 10, median: avg }));
  assert.equal(economyTrend([]), null); assert.equal(economyTrend(pts([100])), null);
  assert.equal(economyTrend(pts([100, 100, 100, 100, 100, 100, 100, 101])).level, "low");
  assert.equal(economyTrend(pts([100, 101, 102, 103, 104, 105, 106, 105])).level, "mid");
  assert.equal(economyTrend(pts([100, 105, 110, 112, 115, 118, 120, 125])).level, "high");
  assert.equal(economyTrend(pts([100, 98, 96, 95, 94, 93, 92, 90])).level, "deflation");
  const t = economyTrend(pts([100, 100, 100, 100, 100, 100, 100, 100, 200]));
  assert.equal(t.from, "d1", "7日ぶん（8点のうち古い方）を比べる"); assert.ok(t.avgPct > 0.9);
});

test("報告：現在の分布・上位5人・日ごとの推移・宝くじの収支・番くじ。読み取りは少ない回数", async () => {
  const users = [e(50000, { name: "おかね" }), e(300, { name: "ふつう" }), e(100, { name: "びんぼう" })].map((u, i) => ({ ...u, rank: i + 1 }));
  const { fs, report } = mk({
    "rankings/assets": { date: "2026-11-03", users, userCount: 3, liveUpdatedAt: new Date(NOW - 3600000) },
    "economyStats/history": { points: [{ date: "2026-11-02", users: 3, avg: 100, total: 300, median: 100 }, { date: "2026-11-03", users: 3, avg: 120, total: 360, median: 110 }] },
    "lotteryRounds/2026-10-30": { status: "done", tickets: 1000, sales: 10000, paid: 21600 },
    "lotteryRounds/2026-11-06": { status: "selling", tickets: 40, sales: 400, paid: 0 },
    "bankujiRounds/r1": { sold: 100, status: "selling", left: { A: 1, B: 4, C: 6, D: 10, E: 30, F: 70, G: 70, H: 7 } }
  });
  const r = await report();
  assert.equal(r.ok, true);
  assert.equal(r.current.users, 3); assert.equal(r.current.total, 50400); assert.equal(r.current.date, "2026-11-03"); assert.ok(r.current.top1Share > 0.99);
  assert.deepEqual(r.top.map((u) => u.name), ["おかね", "ふつう", "びんぼう"]);
  assert.equal(r.history.length, 2); assert.equal(r.trend.level, "high");
  const done = r.lotteries.find((l) => l.id === "2026-10-30"), open = r.lotteries.find((l) => l.id === "2026-11-06");
  assert.equal(done.done, true); assert.equal(done.sales, 10000); assert.equal(done.paid, 21600); assert.equal(Math.round(done.rtp * 100), 216);
  assert.equal(open.done, false); assert.equal(open.rtp, null);
  assert.equal(r.bankuji.sold, 100); assert.equal(r.bankuji.sales, 100 * BANKUJI.price); assert.equal(r.bankuji.coinPrizes, 100 * 100); assert.deepEqual(r.bankuji.stockPrizes, { B: 1, G: 0 });
  assert.ok(r.notes.length >= 1);
  assert.ok(fs.counts.get + fs.counts.batchGet <= 4, "読み取りは少ない回数");
});

test("データが何も無くても落ちない（最初の13:00の前など）", async () => {
  const { report } = mk();
  const r = await report();
  assert.equal(r.ok, true); assert.equal(r.current.users, 0); assert.deepEqual(r.history, []); assert.equal(r.trend, null); assert.deepEqual(r.lotteries, []); assert.equal(r.bankuji, null);
});
