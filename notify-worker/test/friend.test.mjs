/* 👥 友達申請（worker.js の handleFriendAction）のテスト */
import test from "node:test";
import assert from "node:assert/strict";
import { handleFriendAction, handleAdminAction } from "../worker.js";

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
    async queryIn(collection, field, values) { return [...docs.entries()].filter(([p]) => p.startsWith(collection + "/")).map(([p, d]) => ({ id: p.split("/").slice(1).join("/"), ...decF(d.fields) })).filter((r) => values.includes(r[field])); },
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


function setup() {
  const base = {};
  for (let i = 0; i < 4; i++) base[`users/u${i}`] = { uid: `id${i}`, name: `u${i}`, coins: 0, profileImage: `img${i}` };
  const fs = fakeFs(base);
  fs.put("fcmTokens/t1", encF({ uid: "id1" }));
  const sent = [];
  const deps = { firestore: fs, adminUid: "adminUid", now: () => Date.UTC(2026, 10, 11, 3), random: () => 0.1, slotSecret: "s", sendFcm: async (t, d) => { sent.push([t, d.title]); return { ok: true }; } };
  const act = (i, body) => handleFriendAction(deps, `id${i}`, { username: `u${i}`, ...body });
  return { fs, deps, act, sent };
}

test("申請：名前を入れても、すぐには友達にならない。相手に申請が届き（通知も）、友達の書類はまだ無い", async () => {
  const c = setup();
  const r = await c.act(0, { action: "request", name: "u1" });
  assert.equal(r.ok, true); assert.equal(r.requested, true);
  assert.deepEqual(c.fs.plain("friendRequests/id0_id1").toUid, "id1");
  assert.equal(c.fs.plain("friends/u0_u1"), null, "まだ友達ではない");
  assert.deepEqual(c.sent, [["t1", "👋 友達申請が届きました"]]);
});

test("申請できない場合：自分・いない人・すでに友達・すでに申請ずみ・申請しすぎ", async () => {
  const c = setup();
  assert.equal((await c.act(0, { action: "request", name: "u0" })).error, "self");
  assert.equal((await c.act(0, { action: "request", name: "nobody" })).error, "not_found");
  assert.equal((await c.act(0, { action: "request", name: "bad/name" })).error, "bad_name");
  await c.act(0, { action: "request", name: "u1" });
  assert.equal((await c.act(0, { action: "request", name: "u1" })).error, "already_requested");
  c.fs.put("friends/u0_u2", encF({ user1: "u0", user2: "u2" }));
  assert.equal((await c.act(0, { action: "request", name: "u2" })).error, "already_friends");
  const d = setup();
  for (let i = 0; i < 30; i++) d.fs.put(`friendRequests/id0_x${i}`, encF({ fromUid: "id0", toUid: `x${i}` }));
  assert.equal((await d.act(0, { action: "request", name: "u1" })).error, "too_many");
});

test("承認：申請された人が承認すると、友達の書類ができる（これまでと同じ形）。申請は消える。申請された人以外は承認できない", async () => {
  const c = setup();
  await c.act(0, { action: "request", name: "u1" });
  assert.equal((await c.act(2, { action: "respond", id: "id0_id1", accept: true })).error, "gone", "ほかの人は承認できない");
  assert.equal((await c.act(0, { action: "respond", id: "id0_id1", accept: true })).error, "gone", "申請した本人も承認できない");
  const r = await c.act(1, { action: "respond", id: "id0_id1", accept: true });
  assert.equal(r.accepted, true);
  const f = c.fs.plain("friends/u0_u1");
  assert.deepEqual([f.user1, f.user2, f.user1Uid, f.user2Uid, f.user1Photo, f.user2Photo], ["u0", "u1", "id0", "id1", "img0", "img1"]);
  assert.equal(c.fs.plain("friendRequests/id0_id1"), null);
});

test("断る・取り消す：断ると友達にならず申請が消える。取り消せるのは申請した本人だけ", async () => {
  const c = setup();
  await c.act(0, { action: "request", name: "u1" });
  assert.equal((await c.act(1, { action: "cancel", id: "id0_id1" })).error, "gone");
  assert.equal((await c.act(1, { action: "respond", id: "id0_id1", accept: false })).accepted, false);
  assert.equal(c.fs.plain("friendRequests/id0_id1"), null); assert.equal(c.fs.plain("friends/u0_u1"), null);
  await c.act(0, { action: "request", name: "u1" });
  assert.equal((await c.act(0, { action: "cancel", id: "id0_id1" })).ok, true);
  assert.equal(c.fs.plain("friendRequests/id0_id1"), null);
});

test("お互いに申請したら、そのまま友達になる", async () => {
  const c = setup();
  await c.act(0, { action: "request", name: "u1" });
  const r = await c.act(1, { action: "request", name: "u0" });
  assert.equal(r.accepted, true); assert.ok(c.fs.plain("friends/u0_u1")); assert.equal(c.fs.plain("friendRequests/id0_id1"), null);
});

test("ブロック：相手にブロックされていると「見つからない」。自分がブロックしている相手には申請できない。承認のときも確かめる", async () => {
  const c = setup();
  c.fs.put("blocks/id1_id0", encF({ blockerUid: "id1", blockedUid: "id0" }));
  assert.equal((await c.act(0, { action: "request", name: "u1" })).error, "not_found");
  assert.equal((await c.act(1, { action: "request", name: "u0" })).error, "you_blocked");
  const d = setup();
  await d.act(0, { action: "request", name: "u1" });
  d.fs.put("blocks/id1_id0", encF({ blockerUid: "id1", blockedUid: "id0" }));
  assert.equal((await d.act(1, { action: "respond", id: "id0_id1", accept: true })).error, "blocked");
  assert.equal(d.fs.plain("friends/u0_u1"), null);
});

test("ブロック：友達関係と申請が消え、相手は申請しても「見つからない」になる。解除できる。自分や、いない人はブロックできない", async () => {
  const c = setup();
  c.fs.put("friends/u0_u1", encF({ user1: "u0", user2: "u1" })); c.fs.put("friendRequests/id1_id0", encF({ fromUid: "id1", toUid: "id0" }));
  assert.equal((await c.act(0, { action: "block", name: "u0" })).error, "self");
  assert.equal((await c.act(0, { action: "block", name: "nobody" })).error, "not_found");
  assert.equal((await c.act(0, { action: "block", name: "u1" })).ok, true);
  assert.equal(c.fs.plain("friends/u0_u1"), null); assert.equal(c.fs.plain("friendRequests/id1_id0"), null);
  assert.equal(c.fs.plain("blocks/id0_id1").blockedUid, "id1");
  assert.equal((await c.act(1, { action: "request", name: "u0" })).error, "not_found");
  assert.equal((await c.act(0, { action: "request", name: "u1" })).error, "you_blocked");
  assert.equal((await c.act(0, { action: "unblock", uid: "id1" })).ok, true);
  assert.equal(c.fs.plain("blocks/id0_id1"), null);
});

test("通報：メッセージ・YuSnapの投稿・ユーザーを通報できる。内容は控えられ、管理者に通知が行く。同じものは1件だけ。自分は通報できない", async () => {
  const c = setup();
  c.fs.put("fcmTokens/tadmin", encF({ uid: "adminUid" }));
  c.fs.put("messages/msg1234567890", encF({ sender: "u1", senderUid: "id1", text: "ひどいことば", type: "friend" }));
  c.fs.put("yurealPosts/20261111_id1", encF({ uid: "id1", name: "u1", caption: "ひとこと" }));
  assert.equal((await c.act(0, { action: "report", kind: "message", refId: "msg1234567890", reason: "harassment", note: "やめて" })).ok, true);
  const r = c.fs.plain("reports/id0_message_msg1234567890");
  assert.deepEqual([r.targetUid, r.targetName, r.snippet, r.reason, r.status], ["id1", "u1", "ひどいことば", "harassment", "open"]);
  assert.deepEqual(c.sent, [["tadmin", "🚩 通報が届きました"]], "管理者の端末にだけ通知が行く");
  assert.equal((await c.act(0, { action: "report", kind: "snap", refId: "20261111_id1", reason: "inappropriate" })).ok, true);
  assert.equal((await c.act(0, { action: "report", kind: "user", name: "u2", reason: "spam" })).ok, true);
  assert.equal((await c.act(0, { action: "report", kind: "user", name: "u0", reason: "spam" })).error, "self");
  assert.equal((await c.act(0, { action: "report", kind: "message", refId: "msg1234567890", reason: "bad" })).error, "bad_request");
  assert.equal((await c.act(0, { action: "report", kind: "message", refId: "nomsg123456789", reason: "spam" })).error, "gone");
  const before = Object.keys([...c.fs.docs.keys()].filter((k) => k.startsWith("reports/"))).length;
  await c.act(0, { action: "report", kind: "message", refId: "msg1234567890", reason: "spam" });
  assert.equal(Object.keys([...c.fs.docs.keys()].filter((k) => k.startsWith("reports/"))).length, before, "同じ対象は、1件だけ");
});

test("管理者：通報の一覧が新しい順に見え、「対応した」にすると消える。一般の人は呼べない", async () => {
  const c = setup();
  c.fs.put("messages/msg1234567890", encF({ sender: "u1", senderUid: "id1", text: "x" }));
  await c.act(0, { action: "report", kind: "message", refId: "msg1234567890", reason: "other" });
  const list = await handleAdminAction(c.deps, "adminUid", { action: "reportList" });
  assert.equal(list.reports.length, 1); assert.equal(list.reports[0].reporter, "u0"); assert.equal(list.reports[0].target, "u1");
  assert.equal((await handleAdminAction(c.deps, "adminUid", { action: "reportDone", id: list.reports[0].id })).ok, true);
  assert.equal((await handleAdminAction(c.deps, "adminUid", { action: "reportList" })).reports.length, 0);
  assert.ok((await handleAdminAction(c.deps, "id0", { action: "reportList" })).error, "管理者以外は使えない");
});
