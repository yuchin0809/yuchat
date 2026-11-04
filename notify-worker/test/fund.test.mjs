/* 🏦 ゆう基金（スリ・ゆう税でたまったコインを、毎日 9:15 に、総資産の少ない人から順に配る）のテスト
   実行：node --test "notify-worker/test/*.test.mjs" */
import test from "node:test";
import assert from "node:assert/strict";
import { fundPlan, runFundDistribute, runFundTick, resetFundForTest, handleAdminAction, fundBackfill, runFundBackfillTick, resetFundBackfillForTest } from "../worker.js";

console.log = () => {};
console.warn = () => {};
const JST = (y, mo, d, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h - 9, mi, 0);
const NOW = JST(2026, 11, 4, 9, 15);
const ROOT = "projects/p/databases/(default)/documents/";

/* ---- 小さな Firestore のにせもの（REST の形：fields・updateMask・updateTransforms（increment）・更新時刻の条件） ---- */
const enc = (v) => v === null ? { nullValue: null } : typeof v === "boolean" ? { booleanValue: v } : typeof v === "number" ? (Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v }) : typeof v === "string" ? { stringValue: v } : Array.isArray(v) ? { arrayValue: { values: v.map(enc) } } : { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])) } };
const dec = (v) => "stringValue" in v ? v.stringValue : "integerValue" in v ? Number(v.integerValue) : "doubleValue" in v ? v.doubleValue : "booleanValue" in v ? v.booleanValue : "timestampValue" in v ? v.timestampValue : "nullValue" in v ? null : "arrayValue" in v ? (v.arrayValue.values || []).map(dec) : Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, dec(x)]));
const decF = (f) => Object.fromEntries(Object.entries(f || {}).map(([k, v]) => [k, dec(v)]));

function makeFs(seed = {}, { failOnce = [] } = {}) {
  const docs = new Map();
  let clock = 1;
  const put = (path, fields) => docs.set(path, { fields, updateTime: `t${clock++}` });
  Object.entries(seed).forEach(([path, data]) => put(path, Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v && v.__ts ? { timestampValue: v.__ts } : enc(v)]))));
  const log = { commits: [], reads: 0, queries: 0 };
  const failed = new Set();
  const fs = {
    docName: (p) => ROOT + p,
    async getRaw(path) { log.reads++; const d = docs.get(path); return d ? { fields: structuredClone(d.fields), updateTime: d.updateTime } : null; },
    async get(path) { log.reads++; const d = docs.get(path); return d ? decF(d.fields) : null; },
    async add(collection, data) { log.audit = (log.audit || []).concat({ collection, data }); },
    async query(collection) { log.queries++; return [...docs.entries()].filter(([p]) => p.startsWith(collection + "/") && p.split("/").length === 2).map(([p, d]) => ({ id: p.split("/")[1], path: p, updateTime: d.updateTime, data: decF(d.fields) })); },
    async commit(writes) {
      for (const w of writes) {
        const path = w.update.name.slice(ROOT.length), cur = docs.get(path);
        for (const user of failOnce) if (path === `users/${user}` && !failed.has(user)) { failed.add(user); cur.updateTime = `t${clock++}`; }   // 配る直前に、別の書き込みが入った
        if (w.currentDocument?.updateTime && (!cur || cur.updateTime !== w.currentDocument.updateTime)) throw Object.assign(new Error("firestore commit 409 FAILED_PRECONDITION"), { status: 409 });
      }
      log.commits.push(writes);
      for (const w of writes) {
        const path = w.update.name.slice(ROOT.length), cur = docs.get(path);
        const fields = cur ? { ...cur.fields } : {};
        for (const fp of w.updateMask?.fieldPaths || []) fields[fp] = w.update.fields[fp];
        for (const t of w.updateTransforms || []) if (t.increment) fields[t.fieldPath] = { integerValue: String((Number(fields[t.fieldPath]?.integerValue) || 0) + Number(t.increment.integerValue)) };
        put(path, fields);
      }
    }
  };
  return { fs, get: (p) => (docs.has(p) ? decF(docs.get(p).fields) : null), log, docs };
}

const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();
const user = (name, coins, extra = {}) => [`users/${name}`, { uid: `uid-${name}`, name, coins, updatedAt: { __ts: iso(NOW - 3600000) }, createdAt: { __ts: iso(NOW - 30 * DAY) }, ...extra }];
const world = (pool, users, fund = {}) => makeFs({
  "market/current": { companies: { YGM: { price: 200 }, YMT: { price: 250 }, YFD: { price: 150 }, YEN: { price: 300 }, YPY: { price: 210 } } },
  "economyStats/fund": { balance: pool, date: "2026-11-03", status: "done", ...fund },
  ...Object.fromEntries(users.map((u) => user(...u)))
});

test("計画：順位の低い人ほど多い（重み K, K−1, …, 1）。基金の分を超えない", () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ name: `u${String(i).padStart(2, "0")}`, total: 100 + i * 10 }));
  const plan = fundPlan(rows, 5500);
  assert.equal(plan.length, 10, "下位半分（20人のうち10人）");
  assert.deepEqual(plan.map((e) => e.a), [1000, 900, 800, 700, 600, 500, 400, 300, 200, 100]);
  assert.deepEqual(plan.map((e) => e.r), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(plan[0].n, "u00", "いちばん少ない人が最多");
});

test("計画：同額の人は同じ順位・同じ額／1 人あたりは基金の 30% まで／10 コイン未満の日は配らない／少ない人から順に配る", () => {
  const tie = fundPlan([{ name: "a", total: 0 }, { name: "b", total: 0 }, { name: "c", total: 50 }, { name: "d", total: 90 }], 1000);
  assert.deepEqual(tie.map((e) => [e.n, e.a, e.r]), [["a", 300, 1], ["b", 300, 1]], "対象は 4 人の半分（2 人）。同額なので同じ額・同じ順位");
  const one = fundPlan([{ name: "a", total: 5 }], 1000);
  assert.deepEqual(one.map((e) => e.a), [300], "1 人だけでも、基金の 30% まで（残りは次の日に回る）");
  assert.deepEqual(fundPlan([{ name: "a", total: 5 }], 9), [], "10 コイン未満は配らない");
  const rows = Array.from({ length: 20 }, (_, i) => ({ name: `u${String(i).padStart(2, "0")}`, total: i }));
  const small = fundPlan(rows, 12);
  assert.ok(small.length < 10 && small.length >= 1); assert.deepEqual(small.map((e) => e.r), small.map((_, i) => i + 1), "足りない日は、少ない人から順に");
  for (let pool = 10; pool < 5000; pool += 97) { const p = fundPlan(rows, pool); assert.ok(p.reduce((s, e) => s + e.a, 0) <= pool, `pool ${pool}`); }
});

test("配る：直近 3 日にログインしていない人・作って 3 日たっていない人は対象外。総資産（手持ち＋預金＋株−借入）の少ない下位半分に、少ない順に多く配る", async () => {
  const w = world(1000, [
    ["a", 0], ["b", 100], ["c", 400, { bank: { deposit: 100, interestBase: 100, loan: 0 } }], ["d", 800], ["e", 5000],
    ["old", 0, { updatedAt: { __ts: iso(NOW - 4 * DAY) } }],              // 4 日ログインしていない
    ["new", 0, { createdAt: { __ts: iso(NOW - DAY) } }],                    // 作って 1 日
    ["debt", 300, { bank: { deposit: 0, interestBase: 0, loan: 400 } }]     // 総資産 −100：いちばん少ない
  ]);
  const out = await runFundDistribute({ firestore: w.fs }, NOW);
  assert.equal(out.status, "done");
  // 対象は a, b, c(500), d, e, debt(−100) の 6 人 → 下位 3 人：debt(−100)・a(0)・b(100)。重み 3・2・1
  assert.deepEqual(["debt", "a", "b"].map((n) => w.get(`users/${n}`).fundGrant.amount), [300, 300, 166], "debt：min(基金の30%=300, 500)・a：333→上限 300・b：166");
  assert.equal(w.get("users/debt").coins, 600); assert.equal(w.get("users/a").coins, 300); assert.equal(w.get("users/b").coins, 266);
  assert.equal(w.get("users/debt").bank.loan, 400, "借入は減らない");
  assert.deepEqual(w.get("users/a").fundGrant, { date: "2026-11-04", amount: 300, rank: 2, of: 3 });
  for (const n of ["c", "d", "e", "old", "new"]) assert.equal(w.get(`users/${n}`).fundGrant, undefined, n);
  const fund = w.get("economyStats/fund");
  assert.equal(fund.status, "done"); assert.equal(fund.date, "2026-11-04"); assert.equal(fund.count, 3); assert.equal(fund.paid, 766);
  assert.equal(fund.balance, 1000 - 766, "配った分だけ減り、余りは次の日に回る");
});

test("同じ日に 2 回目は配らない。基金が少ない日は配らず、そのまま回る", async () => {
  const w = world(1000, [["a", 0], ["b", 100]]);
  await runFundDistribute({ firestore: w.fs }, NOW);
  const commits = w.log.commits.length, coins = w.get("users/a").coins;
  assert.equal((await runFundDistribute({ firestore: w.fs }, NOW + 60000)).reason, "done");
  assert.equal(w.log.commits.length, commits); assert.equal(w.get("users/a").coins, coins);
  const small = world(9, [["a", 0], ["b", 100]]);
  assert.equal((await runFundDistribute({ firestore: small.fs }, NOW)).reason, "small_pool");
  assert.equal(small.get("economyStats/fund").balance, 9); assert.equal(small.get("users/a").fundGrant, undefined);
  assert.equal((await runFundDistribute({ firestore: world(0, []).fs }, NOW)).reason, "small_pool");
});

test("配る時刻（9:15）の前は配らない。tick は 9:15 などの決まった分だけ動き、決まった分以外は何も読まない", async () => {
  resetFundForTest();
  const w = world(1000, [["a", 0], ["b", 100]]);
  assert.equal((await runFundDistribute({ firestore: w.fs }, JST(2026, 11, 4, 9, 14))).reason, "before_time");
  for (const [h, m] of [[0, 0], [9, 14], [9, 18], [13, 0], [22, 0]]) assert.equal((await runFundTick({}, JST(2026, 11, 4, h, m), { firestore: w.fs })).skipped, "outside", `${h}:${m}`);
  assert.equal(w.log.reads, 0, "決まった分以外・9:15 より前は、Firestore に何も読まない");
  const out = await runFundTick({}, NOW, { firestore: w.fs });
  assert.equal(out.status, "done");
  assert.equal((await runFundTick({}, NOW + 60000, { firestore: w.fs })).skipped, "done", "済んだ日は、もう読まない");
});

test("途中で止まっても、続きから配る（二重に配らない）。配れなかった分は基金に戻る", async () => {
  const plan = [{ n: "a", a: 300, r: 1 }, { n: "b", a: 200, r: 2 }, { n: "gone", a: 100, r: 3 }];
  const w = world(400, [["a", 300, { fundGrant: { date: "2026-11-04", amount: 300, rank: 1, of: 3 } }], ["b", 100]], { date: "2026-11-04", status: "paying", plan, total: 600, count: 3 });
  const out = await runFundDistribute({ firestore: w.fs }, NOW + 5 * 60000);
  assert.equal(out.status, "done"); assert.equal(out.count, 2); assert.equal(out.unpaid, 100);
  assert.equal(w.get("users/a").coins, 300, "もう配った人には、もう一度配らない");
  assert.equal(w.get("users/b").coins, 300); assert.equal(w.get("users/b").fundGrant.amount, 200);
  assert.equal(w.get("economyStats/fund").balance, 400 + 100, "配れなかった分は戻る");
});

test("配る直前に別の書き込みが入った人は、読み直して配る（増えた分は消えない）", async () => {
  const w = makeFs({
    "market/current": { companies: {} },
    "economyStats/fund": { balance: 1000, date: "2026-11-03", status: "done" },
    ...Object.fromEntries([user("a", 0), user("b", 100)])
  }, { failOnce: ["a"] });
  const out = await runFundDistribute({ firestore: w.fs }, NOW);
  assert.equal(out.status, "done"); assert.equal(out.count, 1, "対象は 2 人の半分（1 人）");
  assert.equal(w.get("users/a").coins, 300); assert.equal(w.get("users/a").fundGrant.amount, 300);
});

test("管理者：今すぐ 1 回配る（9:15 の前でも・時刻に関係なく）。1 日 1 回。管理者だけ。操作の記録を残す", async () => {
  const ADMIN = "admin-uid";
  const w = world(1000, [["a", 0], ["b", 100]]);
  const deps = { firestore: w.fs, now: () => JST(2026, 11, 4, 14, 0), adminUid: ADMIN };
  assert.equal((await handleAdminAction(deps, "someone", { action: "fundDistribute" })).error, "not_admin");
  const r = await handleAdminAction(deps, ADMIN, { action: "fundDistribute" });
  assert.equal(r.ok, true); assert.equal(r.status, "done"); assert.equal(r.count, 1); assert.equal(r.total, 300);
  assert.equal(w.get("users/a").fundGrant.amount, 300); assert.equal(w.get("economyStats/fund").date, "2026-11-04");
  assert.equal(w.log.audit.at(-1).data.type, "fundDistribute");
  const again = await handleAdminAction(deps, ADMIN, { action: "fundDistribute" });
  assert.equal(again.status, "skipped"); assert.equal(again.reason, "done", "同じ日に 2 回目は配らない");
  assert.equal(w.get("users/a").coins, 300);
  const early = world(1000, [["a", 0], ["b", 100]]);
  const r2 = await handleAdminAction({ firestore: early.fs, now: () => JST(2026, 11, 4, 7, 0), adminUid: ADMIN }, ADMIN, { action: "fundDistribute" });
  assert.equal(r2.status, "done", "9:15 より前でも、管理者は配れる");
});

const backfillWorld = (fund) => makeFs({
  ...(fund ? { "economyStats/fund": fund } : {}),
  "economyStats/history": { points: [{ date: "2026-11-01", taxTotal: 300 }, { date: "2026-11-02", taxTotal: 0 }, { date: "2026-11-03", taxTotal: 450 }, { date: "2026-11-04", taxTotal: 999 }] },
  "users/a": { uid: "ua", coins: 1, theft: { day: "2026-11-02", last: { date: "2026-11-02", repelled: false, lost: 2000 } } },
  "users/b": { uid: "ub", coins: 1, theft: { day: "2026-11-03", last: { date: "2026-11-03", repelled: true, lost: 0 } } },
  "users/c": { uid: "uc", coins: 1, theft: { day: "2026-11-04", last: { date: "2026-11-04", repelled: false, lost: 700 } } },
  "users/d": { uid: "ud", coins: 1 }
});

test("これまでの分：基金ができる前のゆう税（毎日の記録）と、スリ（一人ひとりの最近の 1 回）を足す。基金ができた日の分・追い払った回は足さない", async () => {
  const w = backfillWorld({ balance: 120 });
  const pre = await fundBackfill({ firestore: w.fs, now: () => NOW });
  assert.deepEqual(pre, { status: "preview", tax: 750, taxDays: 2, theft: 2000, theftUsers: 1, total: 2750 });
  assert.equal(w.get("economyStats/fund").balance, 120, "見るだけでは足さない");
  const r = await fundBackfill({ firestore: w.fs, now: () => NOW }, { apply: true });
  assert.equal(r.status, "done"); assert.equal(r.total, 2750);
  assert.equal(w.get("economyStats/fund").balance, 120 + 2750, "いまたまっている分に足す");
  assert.equal(w.get("economyStats/fund").backfill.total, 2750);
  const again = await fundBackfill({ firestore: w.fs, now: () => NOW }, { apply: true });
  assert.equal(again.status, "already"); assert.equal(w.get("economyStats/fund").balance, 2870, "2 回目は足さない");
});

test("これまでの分：基金の書類がまだ無くても足せる。自動で足すのは 11/4〜11/5 の 10 分おき（3 分）だけ。済んだら何もしない", async () => {
  resetFundBackfillForTest();
  const w = backfillWorld(null);
  assert.equal((await runFundBackfillTick({}, JST(2026, 11, 4, 11, 5), { firestore: w.fs })).skipped, "outside");
  assert.equal((await runFundBackfillTick({}, JST(2026, 11, 6, 11, 3), { firestore: w.fs })).skipped, "outside", "11/6 からは動かない");
  assert.equal(w.log.reads + w.log.queries, 0);
  const r = await runFundBackfillTick({}, JST(2026, 11, 4, 11, 13), { firestore: w.fs });
  assert.equal(r.status, "done"); assert.equal(w.get("economyStats/fund").balance, 2750);
  assert.equal((await runFundBackfillTick({}, JST(2026, 11, 4, 11, 23), { firestore: w.fs })).skipped, "done");
});

test("管理者：これまでの分の内訳を見て、足す（管理者だけ・操作の記録）", async () => {
  const ADMIN = "admin-uid";
  const w = backfillWorld({ balance: 0 });
  const deps = { firestore: w.fs, now: () => NOW, adminUid: ADMIN };
  assert.equal((await handleAdminAction(deps, "x", { action: "fundBackfill" })).error, "not_admin");
  assert.equal((await handleAdminAction(deps, ADMIN, { action: "fundBackfill" })).status, "preview");
  const r = await handleAdminAction(deps, ADMIN, { action: "fundBackfill", apply: true });
  assert.equal(r.status, "done"); assert.equal(w.log.audit.at(-1).data.type, "fundBackfill");
});
