/* 📋 デイリーミッション・連続ログインボーナス（worker.js の mission* / econLoginBonus）のテスト
   実行：node --test "notify-worker/test/*.test.mjs" */
import test from "node:test";
import assert from "node:assert/strict";
import { MISSIONS, MISSION_ALL_BONUS, LOGIN_STREAK_EXTRA, loginStreakExtra, missionHook, handleYuslotAction, handleEconomyAction, resetYuslotCacheForTest } from "../worker.js";

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


const JST = (y, mo, d, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h - 9, mi, 0);
function setup({ coins = 1000, now = JST(2026, 11, 18, 12), user = {} } = {}) {
  resetYuslotCacheForTest();
  const base = { "worldConfig/yuslot": { yuslotPublished: true, keshiPublished: true } };
  for (let i = 0; i < 2; i++) base[`users/u${i}`] = { uid: `id${i}`, name: `u${i}`, coins, ...user };
  const fs = fakeFs(base), state = { now };
  const deps = { firestore: fs, adminUid: "adminUid", now: () => state.now, random: () => 0.5, slotSecret: "s", sendFcm: async () => ({ ok: true }) };
  const act = (i, body) => handleYuslotAction(deps, `id${i}`, { username: `u${i}`, ...body });
  const eco = (i, body) => handleEconomyAction(deps, `id${i}`, { username: `u${i}`, ...body });
  const day = () => new Date(state.now + 9 * 3600000).toISOString().slice(0, 10);
  return { fs, deps, state, act, eco, day, coinsOf: (i) => fs.plain(`users/u${i}`).coins, doc: (i) => fs.plain(`yuslotMission/id${i}_${day()}`) };
}

test("ミッション：行動が成功すると記録され、失敗した行動や関係ない行動は記録されない。1日1つにつき1回だけ", async () => {
  const t = setup();
  assert.deepEqual((await t.act(0, { action: "missionState" })).list.map((m) => [m.id, m.done, m.claimed]), [["snap", false, false], ["yacht", false, false], ["mart", false, false], ["stock", false, false]]);
  await missionHook(t.deps, "id0", "yuslot", { action: "yachtScore" }, { ok: true });
  await missionHook(t.deps, "id0", "yuslot", { action: "yachtScore" }, { ok: true });   // 2回目は、重ならない
  await missionHook(t.deps, "id0", "yuslot", { action: "martBuy" }, { status: 409, error: "gone" });   // 失敗は記録しない
  await missionHook(t.deps, "id0", "yuslot", { action: "keshiBuy" }, { ok: true });   // 関係ない行動
  await missionHook(t.deps, "id0", "yureal", { action: "post", test: true }, { ok: true });   // 管理者のテスト投稿は数えない
  await missionHook(t.deps, "id0", "economy", { action: "bankDeposit" }, { ok: true });   // 銀行は数えない
  assert.deepEqual(t.doc(0).done, ["yacht"]);
  await missionHook(t.deps, "id0", "yureal", { action: "post" }, { ok: true });
  await missionHook(t.deps, "id0", "yuslot", { action: "martList" }, { ok: true });
  await missionHook(t.deps, "id0", "economy", { action: "stockTrade" }, { ok: true });
  assert.deepEqual([...t.doc(0).done].sort(), ["mart", "snap", "stock", "yacht"]);
  const s = await t.act(0, { action: "missionState" });
  assert.ok(s.list.every((m) => m.done && !m.claimed));
  assert.equal(await t.fs.get("yuslotMission/id1_" + t.day()), null, "ほかの人には記録されない");
});

test("ミッションの受け取り：達成したものだけ、1回だけ。全部受け取るとボーナス。上限は合計150コイン", async () => {
  const t = setup({ coins: 1000 });
  assert.equal((await t.act(0, { action: "missionClaim", mission: "snap" })).error, "not_done");
  assert.equal((await t.act(0, { action: "missionClaim", mission: "nope" })).error, "bad_request");
  await missionHook(t.deps, "id0", "yureal", { action: "post" }, { ok: true });
  const r = await t.act(0, { action: "missionClaim", mission: "snap" });
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.reward, 30); assert.equal(r.coins, 1030); assert.equal(t.coinsOf(0), 1030);
  assert.equal(r.list.find((m) => m.id === "snap").claimed, true);
  assert.equal((await t.act(0, { action: "missionClaim", mission: "snap" })).error, "already_claimed", "二重には受け取れない");
  assert.equal(t.coinsOf(0), 1030);
  assert.equal((await t.act(0, { action: "missionClaim", mission: "all" })).error, "not_all_claimed");
  for (const [kind, action] of [["yuslot", "yachtScore"], ["yuslot", "martBuy"], ["economy", "stockTrade"]]) await missionHook(t.deps, "id0", kind, { action }, { ok: true });
  for (const m of ["yacht", "mart", "stock"]) assert.equal((await t.act(0, { action: "missionClaim", mission: m })).ok, true);
  const all = await t.act(0, { action: "missionClaim", mission: "all" });
  assert.equal(all.ok, true); assert.equal(all.reward, MISSION_ALL_BONUS);
  assert.equal(t.coinsOf(0), 1000 + 4 * 30 + 30, "合計150コイン");
  assert.equal((await t.act(0, { action: "missionClaim", mission: "all" })).error, "already_claimed");
  assert.equal(Object.values(MISSIONS).reduce((a, m) => a + m.reward, 0) + MISSION_ALL_BONUS, 150);
});

test("ミッションは、日本時間の0時でリセットされる。きのうの記録は、きょうの受け取りに使えない", async () => {
  const t = setup({ now: JST(2026, 11, 18, 23, 50) });
  await missionHook(t.deps, "id0", "yuslot", { action: "yachtScore" }, { ok: true });
  assert.equal((await t.act(0, { action: "missionState" })).list.find((m) => m.id === "yacht").done, true);
  t.state.now = JST(2026, 11, 19, 0, 5);
  assert.equal((await t.act(0, { action: "missionState" })).list.find((m) => m.id === "yacht").done, false, "新しい日");
  assert.equal((await t.act(0, { action: "missionClaim", mission: "yacht" })).error, "not_done");
});

test("連続ログインボーナス：きのうも受け取っていれば＋1日。とぎれたら1日目。3・7・14・30日目におまけ。同じ日は1回だけ", async () => {
  assert.deepEqual([loginStreakExtra(1), loginStreakExtra(3), loginStreakExtra(7), loginStreakExtra(14), loginStreakExtra(30), loginStreakExtra(31), loginStreakExtra(60)], [0, 30, 100, 150, 300, 0, 300]);
  const t = setup({ coins: 1000, now: JST(2026, 11, 10, 9) });
  let r = await t.eco(0, { action: "loginBonus" });
  assert.deepEqual([r.granted, r.amount, r.extra, r.streak], [true, 50, 0, 1]);
  assert.equal((await t.eco(0, { action: "loginBonus" })).granted, false, "同じ日は1回だけ");
  t.state.now = JST(2026, 11, 11, 9); r = await t.eco(0, { action: "loginBonus" }); assert.equal(r.streak, 2); assert.equal(r.amount, 50);
  t.state.now = JST(2026, 11, 12, 9); r = await t.eco(0, { action: "loginBonus" }); assert.deepEqual([r.streak, r.extra, r.amount], [3, 30, 80]);
  assert.equal(t.fs.plain("users/u0").loginStreak, 3);
  t.state.now = JST(2026, 11, 14, 9); r = await t.eco(0, { action: "loginBonus" });   // 1日あいた
  assert.deepEqual([r.streak, r.extra, r.amount], [1, 0, 50], "とぎれたら1日目");
  assert.equal(t.coinsOf(0), 1000 + 50 + 50 + 80 + 50);
  const s = await t.act(0, { action: "missionState" });
  assert.equal(s.streak, 1); assert.equal(s.streakNext, 3);
  t.state.now = JST(2026, 11, 20, 9);
  assert.equal((await t.act(0, { action: "missionState" })).streak, 0, "6日あいたら、表示も0");
});

test("連続ログイン：古いユーザー（loginStreak がない人）も、1日目から数え始める", async () => {
  const t = setup({ coins: 500, now: JST(2026, 11, 10, 9), user: { lastLoginBonusDate: "2026-11-09" } });
  const r = await t.eco(0, { action: "loginBonus" });
  assert.deepEqual([r.granted, r.streak, r.amount], [true, 1, 50]);
});
