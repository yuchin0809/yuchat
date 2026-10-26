/* 🌈 管理者：確変台の予約チケット（1回ぶん）を配る（worker.js の grantKakuTicket）のテスト
   実行：node --test "notify-worker/test/*.test.mjs" */
import test from "node:test";
import assert from "node:assert/strict";
import { handleAdminAction, kakuTicketsOf, kakuTicketLeft, BANKUJI } from "../worker.js";

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
const NOW = Date.UTC(2026, 9, 27, 3);
const DAY = 86400000;
const entryPath = (u) => `bankujiEntries/${BANKUJI.round}_${u}`;

function setup() {
  const base = {
    "users/ゆうた": { uid: "uYuta", name: "ゆうた", coins: 1 }, "users/はなこ": { uid: "uHana", name: "はなこ", coins: 1 }, "users/かんりしゃ": { uid: ADMIN, name: "かんりしゃ", coins: 1 },
    [entryPath("uHana")]: { uid: "uHana", name: "はなこ", round: BANKUJI.round, tickets: [3], prizes: [{ n: 3, id: "H", kind: "coin", at: 1, amount: 100 }, { n: 1005, id: "D", kind: "kaku1", at: 1, until: NOW + DAY, used: 1 }], dayKey: "x", dayCount: 1 }
  };
  const fs = fakeFs(base);
  const logs = [];
  const deps = { firestore: { ...fs, async add(c, d) { logs.push({ c, d }); } }, adminUid: ADMIN, now: () => NOW };
  return { fs, logs, run: (body, uid = ADMIN) => handleAdminAction(deps, uid, { action: "grantKakuTicket", grantId: "grant-abcdef01", ...body }) };
}

test("1人に渡す：持ちものが無い人は新しく作り、60日有効の1回チケット（D賞と同じ種類・マートで売れない）が入る", async () => {
  const c = setup();
  const r = await c.run({ uid: "uYuta" });
  assert.equal(r.ok, true); assert.equal(r.granted, 1); assert.equal(r.name, "ゆうた");
  const e = c.fs.plain(entryPath("uYuta"));
  assert.equal(e.uid, "uYuta"); assert.deepEqual(e.tickets, []);
  assert.equal(e.prizes.length, 1);
  assert.deepEqual(e.prizes[0], { n: 1001, id: "D", kind: "kaku1", at: NOW, until: NOW + 60 * DAY, bt: 1, g: "grant-abcdef01" });
  const usable = kakuTicketsOf(e.prizes, NOW);
  assert.equal(usable.length, 1); assert.equal(kakuTicketLeft(usable[0]), 1);
  assert.equal(c.logs.length, 1); assert.equal(c.logs[0].d.type, "grantKakuTicket");
});

test("持ちものがある人には、景品を消さずに足す（番号は重ならない）。枚数も指定できる", async () => {
  const c = setup();
  const r = await c.run({ uid: "uHana", count: 3 });
  assert.equal(r.granted, 1);
  const e = c.fs.plain(entryPath("uHana"));
  assert.equal(e.prizes.length, 5); assert.deepEqual(e.prizes.slice(0, 2).map((p) => p.n), [3, 1005]);
  assert.deepEqual(e.prizes.slice(2).map((p) => p.n), [1006, 1007, 1008]);
  assert.equal(e.dayKey, "x"); assert.deepEqual(e.tickets, [3]);
  assert.equal(kakuTicketsOf(e.prizes, NOW).length, 3, "使い切った1005は数えない");
});

test("同じ grantId の2回目は何もしない（二重に配らない）。別の grantId なら、もう1枚", async () => {
  const c = setup();
  await c.run({ uid: "uYuta" });
  const again = await c.run({ uid: "uYuta" });
  assert.equal(again.granted, 0); assert.equal(again.already, 1);
  assert.equal(c.fs.plain(entryPath("uYuta")).prizes.length, 1);
  assert.equal(c.logs.length, 1);
  await c.run({ uid: "uYuta", grantId: "grant-second01" });
  assert.equal(c.fs.plain(entryPath("uYuta")).prizes.length, 2);
});

test("全員に配る：ユーザーが全員（管理者も）対象。途中まで配った操作を押し直しても、配った人には配らない", async () => {
  const c = setup();
  await c.run({ uid: "uYuta" });
  const r = await c.run({ all: true });
  assert.equal(r.ok, true); assert.equal(r.total, 3); assert.equal(r.granted, 2); assert.equal(r.already, 1);
  for (const u of ["uYuta", "uHana", ADMIN]) assert.equal(kakuTicketsOf(c.fs.plain(entryPath(u)).prizes, NOW).length, 1, u);
  const r2 = await c.run({ all: true });
  assert.equal(r2.granted, 0); assert.equal(r2.already, 3);
});

test("管理者以外は断る。枚数・印・対象の入力を確かめる", async () => {
  const c = setup();
  assert.equal((await c.run({ uid: "uYuta" }, "uHana")).error, "not_admin");
  assert.equal((await c.run({ uid: "uYuta", count: 0 })).error, "invalid_count");
  assert.equal((await c.run({ uid: "uYuta", count: 6 })).error, "invalid_count");
  assert.equal((await c.run({ uid: "uYuta", count: 1.5 })).error, "invalid_count");
  assert.equal((await c.run({ uid: "uYuta", grantId: "short" })).error, "invalid_grant_id");
  assert.equal((await c.run({})).error, "invalid_uid");
  assert.equal((await c.run({ uid: "uNobody" })).error, "user_not_found");
  assert.equal(c.fs.docs.has(entryPath("uYuta")), false);
});
