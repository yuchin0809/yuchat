/* ⭐ ゆうChat サポーター（worker.js の handleSupporterAction・admin supporterSet/supporterList） */
import test from "node:test";
import assert from "node:assert/strict";
import { handleSupporterAction, handleAdminAction, SUPPORTER_PRESETS, supporterPrefsClean, resetSupporterCacheForTest, SUPPORTER_EARLY_DAYS, runSupporterAnnounceTick, resetSupporterAnnounceForTest, SUPPORTER_ANNOUNCE_MS } from "../worker.js";

const ROOT = "projects/p/databases/(default)/documents";
const enc = (v) => v instanceof Date ? { timestampValue: v.toISOString() } : Array.isArray(v) ? { arrayValue: { values: v.map(enc) } } : v && typeof v === "object" ? { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])) } } : typeof v === "boolean" ? { booleanValue: v } : typeof v === "number" ? { integerValue: String(v) } : { stringValue: String(v) };
const dec = (v) => v.mapValue ? Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, dec(x)])) : v.arrayValue ? (v.arrayValue.values || []).map(dec) : v.timestampValue ? new Date(v.timestampValue) : v.booleanValue !== undefined ? v.booleanValue : v.integerValue !== undefined ? Number(v.integerValue) : v.stringValue;
function fakeFs(seed = {}) {
  const docs = new Map(Object.entries(seed).map(([p, d]) => [p, structuredClone(d)]));
  let t = 1; const times = new Map();
  const touch = (p) => times.set(p, `t${t++}`);
  return {
    docs,
    docName: (p) => `${ROOT}/${p}`,
    async get(p) { return docs.has(p) ? structuredClone(docs.get(p)) : null; },
    async getRaw(p) { return docs.has(p) ? { fields: Object.fromEntries(Object.entries(docs.get(p)).map(([k, v]) => [k, enc(v)])), updateTime: times.get(p) || "t0" } : null; },
    async set(p, d) { docs.set(p, structuredClone(d)); touch(p); },
    async createIfAbsent(p, d) { if (docs.has(p)) return false; docs.set(p, structuredClone(d)); touch(p); return true; },
    async commit(writes) { for (const w of writes) { const p = w.update.name.slice(ROOT.length + 1); const cur = docs.get(p) || {}; for (const f of w.updateMask.fieldPaths) cur[f] = dec(w.update.fields[f]); docs.set(p, cur); touch(p); } },
    async query(c, filters) { return [...docs.entries()].filter(([p]) => p.startsWith(`${c}/`)).filter(([, d]) => filters.every(([f, , v]) => d[f] === v)).map(([p, d]) => ({ id: p.split("/")[1], path: p, data: structuredClone(d) })); },
    async queryIn(c, field, values) { return [...docs.entries()].filter(([p, d]) => p.startsWith(`${c}/`) && values.includes(d[field])).map(([p]) => ({ id: p.split("/")[1] })); },
    async delete(p) { docs.delete(p); },
    async update(p, d) { docs.set(p, { ...(docs.get(p) || {}), ...d }); },
    async add() {}
  };
}
const ADMIN = "adminUid";
function world() {
  const fs = fakeFs({ "users/たろう": { uid: "uT", name: "たろう", coins: 500, slotSpins: 7 }, "users/はなこ": { uid: "uH", name: "はなこ", coins: 100 } });
  let now = Date.UTC(2026, 10, 10);
  resetSupporterCacheForTest();
  const sent = [];
  return { fs, sent, deps: { firestore: fs, adminUid: ADMIN, now: () => now, sendFcm: async (token, data) => { sent.push({ token, data }); return { ok: true }; } }, tick: (ms) => { now += ms; } };
}
const admin = (w, body, uid = ADMIN) => handleAdminAction(w.deps, uid, body);
const sup = (w, uid, body) => handleSupporterAction(w.deps, uid, body);

test("サポーター：管理者が選んだ人を、お金なしでサポーターにできる。管理者だけ。一覧とマークの目印に出る", async () => {
  const w = world();
  assert.equal((await admin(w, { action: "supporterSet", uid: "uT", on: true }, "someone")).error, "not_admin");
  const r = await admin(w, { action: "supporterSet", uid: "uT", on: true });
  assert.equal(r.ok, true); assert.equal(r.name, "たろう"); assert.equal(r.early, true, "最初の1か月は初期サポーター");
  assert.deepEqual((await admin(w, { action: "supporterList" })).supporters.map((x) => x.name), ["たろう"]);
  const idx = await sup(w, "uH", { action: "index" });
  assert.equal(idx.byUid.uT.m, 1); assert.equal(idx.byUid.uT.n, "たろう"); assert.equal(idx.byUid.uT.e, 1);
  assert.equal((await sup(w, "uT", { action: "me" })).supporter.source, "admin");
  assert.equal((await sup(w, "uH", { action: "me" })).supporter, null, "サポーターでない人は null");
  assert.equal((await admin(w, { action: "supporterSet", uid: "nobody", on: true })).error, "user_not_found");
});

test("サポーター：最初のサポーターから30日をすぎて加えた人は、初期サポーターにならない。やめさせると目印から消える（記録は残る）", async () => {
  const w = world();
  await admin(w, { action: "supporterSet", uid: "uT", on: true });
  w.tick((SUPPORTER_EARLY_DAYS + 1) * 86400000);
  const r = await admin(w, { action: "supporterSet", uid: "uH", on: true });
  assert.equal(r.early, false);
  resetSupporterCacheForTest();
  assert.equal((await sup(w, "uT", { action: "index" })).byUid.uH.e, 0);
  await admin(w, { action: "supporterSet", uid: "uH", on: false });
  resetSupporterCacheForTest();
  assert.equal((await sup(w, "uT", { action: "index" })).byUid.uH, undefined);
  assert.equal(w.fs.docs.get("supporters/uH").active, false);
});

test("サポーター：好みは候補の id だけ。サポーターでない人は変えられない。変えると、ほかの人に見える目印にも反映される", async () => {
  const w = world();
  await admin(w, { action: "supporterSet", uid: "uT", on: true });
  assert.equal((await sup(w, "uH", { action: "setPrefs", prefs: { nameColor: "gold" } })).error, "not_supporter");
  assert.equal((await sup(w, "uT", { action: "setPrefs", prefs: { nameColor: "ぜんぜん違う" } })).error, "invalid_prefs");
  const ok = await sup(w, "uT", { action: "setPrefs", prefs: { nameColor: "rainbow", bubbleColor: "sunset", chatBg: "stars", kakuTheme: "neon", kakuFx: "coins" } });
  assert.equal(ok.prefs.chatBg, "stars");
  const idx = await sup(w, "uH", { action: "index" });
  assert.equal(idx.byUid.uT.nc, "rainbow"); assert.equal(idx.byUid.uT.bc, "sunset");
  assert.equal((await sup(w, "uT", { action: "me" })).supporter.prefs.kakuFx, "coins");
});

test("サポーター：要望（1分に1回・500字まで）とマイ記録（スロ・ダービー）", async () => {
  const w = world();
  await admin(w, { action: "supporterSet", uid: "uT", on: true });
  assert.equal((await sup(w, "uT", { action: "request", text: "" })).error, "invalid_text");
  assert.equal((await sup(w, "uT", { action: "request", text: "あ".repeat(501) })).error, "invalid_text");
  assert.equal((await sup(w, "uT", { action: "request", text: "新しいゲームがほしい" })).ok, true);
  assert.equal((await sup(w, "uT", { action: "request", text: "もう1つ" })).error, "too_fast");
  assert.equal([...w.fs.docs.keys()].filter((k) => k.startsWith("featureRequests/")).length, 1);
  w.fs.docs.set("raceBets/b1", { uid: "uT", settled: true, win: true, amount: 100, payout: 500 });
  w.fs.docs.set("raceBets/b2", { uid: "uT", settled: true, win: false, amount: 100, payout: 0 });
  w.fs.docs.set("raceBets/b3", { uid: "uT", settled: false, amount: 100 });
  const rec = await sup(w, "uT", { action: "records" });
  assert.equal(rec.coins, 500); assert.equal(rec.slot.spins, 7);
  assert.deepEqual(rec.derby, { bets: 2, wins: 1, wagered: 200, paid: 500 });
});

test("サポーターの候補表：どの種類も、default を含み、id が重ならない", () => {
  for (const [k, list] of Object.entries(SUPPORTER_PRESETS)) { assert.ok(list.includes("default"), k); assert.equal(new Set(list).size, list.length, k); }
  assert.equal(supporterPrefsClean({ chatBg: "nope" }), null);
});

test("サポーター：同じログイン（uid）に名前が2つある人も、サポーターにできる（名前の指定があればそれ）", async () => {
  const w = world();
  w.fs.docs.set("users/けいと", { uid: "uK", name: "けいと", coins: 1 });
  w.fs.docs.set("users/毛糸と", { uid: "uK", name: "毛糸と", coins: 1 });
  const r = await admin(w, { action: "supporterSet", uid: "uK", on: true, name: "毛糸と" });
  assert.equal(r.ok, true); assert.equal(r.name, "毛糸と");
  const r2 = await admin(w, { action: "supporterSet", uid: "uK", on: true });
  assert.equal(r2.already, true);
});

test("サポーターの要望：管理者の端末にだけ通知が飛ぶ。管理者が一覧で読み、「読んだ」にできる", async () => {
  const w = world();
  w.fs.docs.set("fcmTokens/tAdmin", { uid: ADMIN }); w.fs.docs.set("fcmTokens/tOther", { uid: "uH" });
  await admin(w, { action: "supporterSet", uid: "uT", on: true });
  await sup(w, "uT", { action: "request", text: "新しい\nゲームがほしい" });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(w.sent.map((x) => x.token), ["tAdmin"], "管理者の端末だけ");
  assert.equal(w.sent[0].data.kind, "request");
  const list = await admin(w, { action: "supporterRequests" });
  assert.equal(list.requests.length, 1); assert.equal(list.requests[0].name, "たろう"); assert.equal(list.requests[0].priority, true);
  assert.equal((await admin(w, { action: "supporterRequests" }, "someone")).error, "not_admin");
  await admin(w, { action: "supporterRequestDone", id: list.requests[0].id });
  assert.equal((await admin(w, { action: "supporterRequests" })).requests.length, 0);
});

test("サポーター：アンロックの演出を見たことが、アカウントに残る（別の端末でも出ない）", async () => {
  const w = world();
  await admin(w, { action: "supporterSet", uid: "uT", on: true });
  assert.equal((await sup(w, "uT", { action: "me" })).supporter.unlockSeen, false);
  assert.equal((await sup(w, "uH", { action: "unlockSeen" })).error, "not_supporter");
  await sup(w, "uT", { action: "unlockSeen" });
  assert.equal((await sup(w, "uT", { action: "me" })).supporter.unlockSeen, true);
});

test("サポーターへのお知らせ：11/11 8:20〜8:30 に1回だけ。サポーターの端末にだけ。時間の外では何もしない", async () => {
  const w = world();
  resetSupporterAnnounceForTest();
  await admin(w, { action: "supporterSet", uid: "uT", on: true });
  w.fs.docs.set("fcmTokens/tT", { uid: "uT" }); w.fs.docs.set("fcmTokens/tH", { uid: "uH" });
  assert.deepEqual(await runSupporterAnnounceTick({}, SUPPORTER_ANNOUNCE_MS - 60000, w.deps), { skipped: "outside" });
  const r = await runSupporterAnnounceTick({}, SUPPORTER_ANNOUNCE_MS, w.deps);
  assert.equal(r.sent, 1); assert.deepEqual(w.sent.map((x) => x.token), ["tT"]);
  assert.deepEqual(await runSupporterAnnounceTick({}, SUPPORTER_ANNOUNCE_MS + 60000, w.deps), { skipped: "done" });
  resetSupporterAnnounceForTest();
  assert.equal((await runSupporterAnnounceTick({}, SUPPORTER_ANNOUNCE_MS + 120000, w.deps)).skipped, "duplicate", "別の実行でも二重に送らない");
  assert.deepEqual(await runSupporterAnnounceTick({}, SUPPORTER_ANNOUNCE_MS + 11 * 60000, w.deps), { skipped: "outside" });
});
