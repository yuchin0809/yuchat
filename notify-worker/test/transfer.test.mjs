/* 💸 コインの送金（管理者の承認制）のテスト（worker.js の transfer*）
   実行：node --test "notify-worker/test/*.test.mjs" */
import test from "node:test";
import assert from "node:assert/strict";
import { handleEconomyAction, handleAdminAction, runTransferExpiryTick, resetTransferCacheForTest, resetYuslotCacheForTest } from "../worker.js";

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
const DAY = 24 * 3600000;
const T0 = Date.UTC(2026, 9, 21, 1, 0, 0);

function setup({ now = T0, coins = { alice: 1000, bob: 50, carol: 0 }, extra = {} } = {}) {
  resetTransferCacheForTest(); resetYuslotCacheForTest();
  const base = { ...extra };
  Object.entries(coins).forEach(([n, c]) => { base[`users/${n}`] = { uid: `id_${n}`, name: n, coins: c }; });
  const fs = fakeFs(base);
  const sent = [];
  const state = { now };
  for (const n of Object.keys(coins)) fs.put(`fcmTokens/tok_${n}`, encF({ uid: `id_${n}` }));
  const deps = { firestore: fs, adminUid: ADMIN, now: () => state.now, random: Math.random, slotSecret: "s",
    sendFcm: async (token, data) => { sent.push({ token, data }); return { ok: true }; },
    authAdmin: { lookup: async (uid) => ({ localId: uid, createdAt: String(T0 - 40 * DAY), lastLoginAt: String(T0 - DAY), providerUserInfo: [] }) } };
  const eco = (who, body) => handleEconomyAction(deps, `id_${who}`, { username: who, ...body });
  const admin = (body, uid = ADMIN) => handleAdminAction(deps, uid, body);
  const coinsOf = (n) => fs.plain(`users/${n}`).coins;
  const pending = () => [...fs.docs.keys()].filter((p) => p.startsWith("coinTransfers/")).map((p) => ({ id: p.split("/")[1], ...fs.plain(p) }));
  return { fs, deps, state, eco, admin, coinsOf, pending, sent };
}

test("申請：送る人のコインを先に預かる。申請は承認待ちになり、相手にはまだ届かない", async () => {
  const { eco, coinsOf, pending } = setup();
  const r = await eco("alice", { action: "transferRequest", to: "bob", amount: 300 });
  assert.equal(r.ok, true); assert.equal(r.coins, 700);
  assert.equal(coinsOf("alice"), 700, "預かった");
  assert.equal(coinsOf("bob"), 50, "相手にはまだ届かない");
  const p = pending();
  assert.equal(p.length, 1); assert.deepEqual([p[0].status, p[0].senderName, p[0].receiverName, p[0].amount], ["pending", "alice", "bob", 300]);
});

test("申請できない：自分宛・存在しない人・0や小数・残高不足・ゆうスロ着席中。何も変わらない", async () => {
  const { eco, coinsOf, pending, fs, state } = setup();
  assert.equal((await eco("alice", { action: "transferRequest", to: "alice", amount: 10 })).error, "self");
  assert.equal((await eco("alice", { action: "transferRequest", to: "nobody", amount: 10 })).error, "user_not_found");
  assert.equal((await eco("alice", { action: "transferRequest", to: "bob", amount: 0 })).error, "invalid_amount");
  assert.equal((await eco("alice", { action: "transferRequest", to: "bob", amount: 1.5 })).error, "invalid_amount");
  assert.equal((await eco("alice", { action: "transferRequest", to: "bob", amount: -5 })).error, "invalid_amount");
  assert.equal((await eco("alice", { action: "transferRequest", to: "bob", amount: "100" })).error, "invalid_amount");
  assert.equal((await eco("alice", { action: "transferRequest", to: "bob", amount: 1001 })).error, "insufficient_coins");
  assert.equal((await eco("alice", { action: "transferRequest", to: "a/b", amount: 1 })).error, "invalid_receiver");
  fs.put("yuslotSeats/yubasic", encF({ uid: "id_alice", name: "alice", graceUntilMs: state.now + 60000 }));
  assert.equal((await eco("alice", { action: "transferRequest", to: "bob", amount: 10 })).error, "seated");
  assert.equal(coinsOf("alice"), 1000); assert.equal(pending().length, 0);
});

test("金額の上限はない：持っているコインを全部でも申請できる。2回に分けて同じコインを二重に預けることはできない", async () => {
  const { eco, coinsOf } = setup();
  assert.equal((await eco("alice", { action: "transferRequest", to: "bob", amount: 1000 })).ok, true);
  assert.equal(coinsOf("alice"), 0);
  assert.equal((await eco("alice", { action: "transferRequest", to: "bob", amount: 1 })).error, "insufficient_coins");
});

test("同時に同じコインで2件申請しても、預けられるのは残高の範囲だけ", async () => {
  const { eco, coinsOf, pending } = setup();
  const rs = await Promise.all([1, 2, 3, 4].map(() => eco("alice", { action: "transferRequest", to: "bob", amount: 400 })));
  assert.equal(rs.filter((r) => r.ok).length, 2, "1000コインから400ずつ＝2件まで");
  assert.equal(coinsOf("alice"), 200); assert.equal(pending().length, 2);
});

test("管理者のOK：相手に届く。送った人・相手に通知。もう一度押しても二重に送られない。監査ログが残る", async () => {
  const { eco, admin, coinsOf, pending, sent, fs } = setup();
  const { id } = await eco("alice", { action: "transferRequest", to: "bob", amount: 300 });
  const r = await admin({ action: "transferApprove", id });
  assert.equal(r.ok, true);
  assert.equal(coinsOf("bob"), 350); assert.equal(coinsOf("alice"), 700);
  assert.equal(pending()[0].status, "approved");
  assert.equal((await admin({ action: "transferApprove", id })).error, "not_pending", "二重承認はできない");
  assert.equal((await admin({ action: "transferReject", id })).error, "not_pending", "承認後に却下して二重に戻すこともできない");
  assert.equal(coinsOf("bob"), 350); assert.equal(coinsOf("alice"), 700);
  const tos = sent.map((s) => s.token).sort();
  assert.deepEqual(tos, ["tok_alice", "tok_bob"]);
  assert.match(sent.find((s) => s.token === "tok_bob").data.body, /alice.*300/);
  const logs = [...fs.docs.keys()].filter((p) => p.startsWith("adminAuditLogs/"));
  assert.equal(logs.length, 1); assert.equal(fs.plain(logs[0]).action, "coinTransferApprove");
});

test("管理者の却下：送った人に全額戻る。送った人にだけ通知。二重に戻らない", async () => {
  const { eco, admin, coinsOf, pending, sent } = setup();
  const { id } = await eco("alice", { action: "transferRequest", to: "bob", amount: 300 });
  const r = await admin({ action: "transferReject", id });
  assert.equal(r.ok, true); assert.equal(r.refunded, true);
  assert.equal(coinsOf("alice"), 1000); assert.equal(coinsOf("bob"), 50);
  assert.equal(pending()[0].status, "rejected");
  assert.equal((await admin({ action: "transferReject", id })).error, "not_pending");
  assert.equal(coinsOf("alice"), 1000);
  assert.deepEqual(sent.map((s) => s.token), ["tok_alice"]);
});

test("同時にOKと却下・OKを2回押しても、コインが動くのは1回だけ", async () => {
  const { eco, admin, coinsOf } = setup();
  const { id } = await eco("alice", { action: "transferRequest", to: "bob", amount: 300 });
  const rs = await Promise.all([admin({ action: "transferApprove", id }), admin({ action: "transferReject", id }), admin({ action: "transferApprove", id })]);
  assert.equal(rs.filter((r) => r.ok).length, 1);
  assert.equal(coinsOf("alice") + coinsOf("bob"), 1050, "合計は変わらない（コインが増えも消えもしない）");
});

test("管理者以外は、承認・却下・一覧ができない", async () => {
  const { eco, admin } = setup();
  const { id } = await eco("alice", { action: "transferRequest", to: "bob", amount: 300 });
  for (const action of ["transferApprove", "transferReject", "transferList"]) assert.equal((await admin({ action, id }, "id_bob")).error, "not_admin");
  assert.equal((await admin({ action: "transferApprove", id }, "id_alice")).error, "not_admin", "送った本人でも承認できない");
});

test("送った人は、承認前なら自分で取り消せる（全額戻る）。他人の申請は取り消せない", async () => {
  const { eco, coinsOf } = setup();
  const { id } = await eco("alice", { action: "transferRequest", to: "bob", amount: 300 });
  assert.equal((await eco("bob", { action: "transferCancel", id })).error, "not_found", "相手や他人は取り消せない");
  assert.equal((await eco("carol", { action: "transferCancel", id })).error, "not_found");
  assert.equal(coinsOf("alice"), 700);
  assert.equal((await eco("alice", { action: "transferCancel", id })).ok, true);
  assert.equal(coinsOf("alice"), 1000);
  assert.equal((await eco("alice", { action: "transferCancel", id })).error, "not_pending");
  assert.equal(coinsOf("alice"), 1000);
});

test("自分の承認待ちの申請の一覧（取り消し用）。他人の申請は載らない", async () => {
  const { eco, admin } = setup();
  const a = await eco("alice", { action: "transferRequest", to: "bob", amount: 10 });
  await eco("bob", { action: "transferRequest", to: "carol", amount: 5 });
  const m = await eco("alice", { action: "transferMine" });
  assert.deepEqual(m.requests.map((x) => [x.id, x.to, x.amount]), [[a.id, "bob", 10]]);
  await admin({ action: "transferApprove", id: a.id });
  assert.equal((await eco("alice", { action: "transferMine" })).requests.length, 0, "承認されたら載らない");
});

test("管理者の一覧：誰から誰へ・いくらと、判断の材料（二人のいまのコイン・アカウントを作った日・同じ相手への集中）", async () => {
  const { eco, admin } = setup();
  await eco("alice", { action: "transferRequest", to: "carol", amount: 100 });
  await eco("bob", { action: "transferRequest", to: "carol", amount: 20 });
  const r = await admin({ action: "transferList" });
  assert.equal(r.requests.length, 2);
  const x = r.requests.find((q) => q.senderName === "alice");
  assert.equal(x.receiverName, "carol"); assert.equal(x.amount, 100);
  assert.equal(x.sender.coins, 900); assert.equal(x.receiver.coins, 0);
  assert.ok(x.sender.createdAt && x.sender.lastLoginAt);
  assert.deepEqual(x.toReceiver, { count: 2, total: 120 }, "同じ相手に集まっている件数と合計");
});

test("相手がいなくなっていたらOKできない（却下すれば全額戻る）。送った人がいなくなっていたら返金なしで却下できる", async () => {
  const s1 = setup();
  const { id } = await s1.eco("alice", { action: "transferRequest", to: "bob", amount: 300 });
  s1.fs.docs.delete("users/bob");
  assert.equal((await s1.admin({ action: "transferApprove", id })).error, "receiver_missing");
  assert.equal((await s1.admin({ action: "transferReject", id })).ok, true);
  assert.equal(s1.coinsOf("alice"), 1000);
  const s2 = setup();
  const t = await s2.eco("alice", { action: "transferRequest", to: "bob", amount: 300 });
  s2.fs.docs.delete("users/alice");
  const r = await s2.admin({ action: "transferReject", id: t.id });
  assert.equal(r.ok, true); assert.equal(r.refunded, false);
});

test("名前を変えた人にも届く・戻る（uid で追う）", async () => {
  const { eco, admin, fs, coinsOf } = setup();
  const { id } = await eco("alice", { action: "transferRequest", to: "bob", amount: 300 });
  fs.put("users/bobNew", encF({ uid: "id_bob", name: "bobNew", coins: 50 })); fs.docs.delete("users/bob");
  assert.equal((await admin({ action: "transferApprove", id })).ok, true);
  assert.equal(coinsOf("bobNew"), 350);
});

test("3日たっても承認されない申請は、毎日3:07に自動で却下して返金し、送った人に通知する。新しい申請は残る。1日1回だけ", async () => {
  const { eco, state, coinsOf, pending, sent, deps } = setup({ now: Date.UTC(2026, 9, 17, 1, 0, 0) });
  const old = await eco("alice", { action: "transferRequest", to: "bob", amount: 300 });
  state.now = Date.UTC(2026, 9, 19, 12, 0, 0);
  const fresh = await eco("alice", { action: "transferRequest", to: "carol", amount: 100 });
  // 2026-10-20 3:07 JST ＝ 10/19 18:07 UTC（古い申請は 10/17 10:00 JST から約2.7日＝まだ）
  const early = Date.UTC(2026, 9, 19, 18, 7, 0);
  state.now = early;
  assert.equal((await runTransferExpiryTick({}, early, deps)).expired, 0);
  // 10/21 3:07 JST ＝ 10/20 18:07 UTC（3日以上たった）
  const t = Date.UTC(2026, 9, 20, 18, 7, 0);
  state.now = t;
  assert.equal((await runTransferExpiryTick({}, t, deps)).expired, 1);
  const byId = Object.fromEntries(pending().map((p) => [p.id, p.status]));
  assert.equal(byId[old.id], "expired"); assert.equal(byId[fresh.id], "pending");
  assert.equal(coinsOf("alice"), 1000 - 100);
  assert.ok(sent.some((x) => x.token === "tok_alice" && /期限切れ/.test(x.data.title)));
  assert.equal((await runTransferExpiryTick({}, t + 1000, deps)).skipped, "done");
  assert.equal((await runTransferExpiryTick({}, Date.UTC(2026, 9, 20, 12, 0, 0), deps)).skipped, "outside", "3:07以外は何も読まない");
});
