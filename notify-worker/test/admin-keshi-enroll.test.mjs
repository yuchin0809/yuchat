/* 🥊 管理者：最近ログインした人を、最強決定戦に、まとめてエントリーさせる（worker.js の keshiLeagueEnroll）のテスト
   実行：node --test "notify-worker/test/*.test.mjs" */
import test from "node:test";
import assert from "node:assert/strict";
import { handleAdminAction, resetYuslotCacheForTest, handleYuslotAction } from "../worker.js";

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
const NOW = Date.UTC(2026, 9, 24, 3);   // 2026-10-24 12:00 JST
const DAY = 86400000;

function setup({ keshi = true } = {}) {
  resetYuslotCacheForTest();
  const base = { "worldConfig/yuslot": { yuslotPublished: true, keshiPublished: keshi } };
  const users = [["ゆうた", "uYuta"], ["はなこ", "uHana"], ["けんと", "uKento"], ["ふるい", "uOld"], ["とめ", "uStop"], ["きえた", "uGone"], ["すでに", "uAlready"], ["ひさしぶり", "uDormant"]];
  users.forEach(([n, u]) => { base[`users/${n}`] = { uid: u, name: n, coins: 1000 }; });
  base["users/かんりしゃ"] = { uid: ADMIN, name: "かんりしゃ", coins: 1 };
  base["yuslotKeshi/uAlready"] = { owned: ["body:pro"], eq: { body: "pro" }, color: 2, league: true, leagueAt: NOW - 5 * DAY, n: "すでに" };
  base["yuslotKeshi/_league"] = { count: 1 };
  base["suspendedUsers/uStop"] = { reason: "x" };
  const fs = fakeFs(base);
  const au = (localId, ago, extra = {}) => ({ localId, lastLoginAt: String(NOW - ago), providerUserInfo: [{ providerId: "password" }], ...extra });
  const authUsers = [
    au("uYuta", 1 * DAY), au("uHana", 6.9 * DAY), au("uKento", 2 * DAY, { lastLoginAt: String(NOW - 30 * DAY), lastRefreshAt: new Date(NOW - 1 * DAY).toISOString() }),   // 最後のログインは古いが、トークンの更新が最近
    au("uOld", 8 * DAY), au("uStop", 1 * DAY), au("uGone", 1 * DAY, { disabled: true }), au("uAlready", 1 * DAY), au("uDormant", 60 * DAY),
    au("uNoDoc", 1 * DAY), au(ADMIN, 0)
  ];
  const deps = { firestore: { ...fs, async add() {} }, adminUid: ADMIN, now: () => NOW, authAdmin: { async listAll() { return authUsers; } } };
  return { fs, deps, run: (body, uid = ADMIN) => handleAdminAction(deps, uid, { action: "keshiLeagueEnroll", ...body }) };
}

test("確認だけ：直近7日にログインした（ログイン・トークン更新のどちらでも）人を数える。停止中・古い人・名前の無い人は除く。何も書かない", async () => {
  const ctx = setup();
  const r = await ctx.run({});
  assert.equal(r.ok, true); assert.equal(r.applied, false);
  assert.deepEqual([r.days, r.active, r.already, r.willEnroll], [7, 5, 1, 4], "ゆうた・はなこ・けんと・かんりしゃ・すでに（済）");
  assert.deepEqual([...r.names].sort(), ["かんりしゃ", "ゆうた", "けんと", "はなこ"].sort());
  assert.equal(ctx.fs.counts.commit, 0, "確認だけでは書かない");
  assert.equal(ctx.fs.plain("yuslotKeshi/uYuta"), null);
});

test("実行：対象の人だけ league・leagueAt・名前を書く（パーツ・装備は変えない）。人数に足す。すでにエントリー済みの人は触らない。もう一度やっても増えない", async () => {
  const ctx = setup();
  const r = await ctx.run({ apply: true });
  assert.deepEqual([r.applied, r.enrolled, r.willEnroll], [true, 4, 4]);
  for (const [uid, name] of [["uYuta", "ゆうた"], ["uHana", "はなこ"], ["uKento", "けんと"], [ADMIN, "かんりしゃ"]]) {
    const d = ctx.fs.plain(`yuslotKeshi/${uid}`);
    assert.deepEqual([d.league, d.leagueAt, d.n], [true, NOW, name]);
  }
  for (const uid of ["uOld", "uStop", "uGone", "uDormant", "uNoDoc"]) assert.equal(ctx.fs.plain(`yuslotKeshi/${uid}`), null, `${uid} は対象外`);
  assert.deepEqual(ctx.fs.plain("yuslotKeshi/uAlready"), { owned: ["body:pro"], eq: { body: "pro" }, color: 2, league: true, leagueAt: NOW - 5 * DAY, n: "すでに" }, "済の人は、そのまま");
  assert.equal(ctx.fs.plain("yuslotKeshi/_league").count, 1 + 4, "人数に足す");
  const again = await ctx.run({ apply: true });
  assert.deepEqual([again.enrolled, again.willEnroll, again.already], [0, 0, 5], "2回目は増えない");
  assert.equal(ctx.fs.plain("yuslotKeshi/_league").count, 5);
});

test("実行：すでにパーツを買っている人の書類は、パーツ・装備・色を残したままエントリーだけ足す。エントリーの画面でも、エントリー済みになる", async () => {
  const ctx = setup();
  ctx.fs.put("yuslotKeshi/uYuta", encF({ owned: ["body:titan"], eq: { body: "titan", edge: "paper", sole: "bare", weight: "none" }, color: 4 }));
  await ctx.run({ apply: true });
  const d = ctx.fs.plain("yuslotKeshi/uYuta");
  assert.deepEqual([d.owned, d.eq.body, d.color, d.league], [["body:titan"], "titan", 4, true]);
  const st = await handleYuslotAction(ctx.deps, "uYuta", { action: "keshiLeagueState", username: "ゆうた" });
  assert.equal(st.ok, true); assert.equal(st.entered, true); assert.equal(st.count, 5);
  const s2 = await handleYuslotAction(ctx.deps, "uYuta", { action: "keshiLeagueEntry", username: "ゆうた", enter: false });
  assert.equal(s2.entered, false, "本人は、あとからやめられる");
});

test("日数を変えられる（1〜60）。範囲外は断る。管理者以外は使えない", async () => {
  const ctx = setup();
  const wide = await ctx.run({ days: 60 }), narrow = await ctx.run({ days: 1 });
  assert.ok(wide.active >= narrow.active && wide.active > 5, "日数を増やすと、対象が増える（60日以内の ひさしぶり も入る）");
  for (const days of [0, 61, 1.5, "7"]) assert.equal((await ctx.run({ days })).error, "invalid_days", String(days));
  const notAdmin = await ctx.run({}, "uYuta");
  assert.equal(notAdmin.status, 403); assert.equal(notAdmin.error, "not_admin");
});
