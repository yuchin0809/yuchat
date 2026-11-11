/* 👥 友達申請（worker.js の handleFriendAction）のテスト */
import test from "node:test";
import assert from "node:assert/strict";
import { handleFriendAction } from "../worker.js";

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
