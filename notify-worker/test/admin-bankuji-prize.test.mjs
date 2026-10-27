/* 🎊 管理者：ゆう番くじの景品の取り消し（worker.js の bankujiPrize）のテスト
   実行：node --test "notify-worker/test/*.test.mjs" */
import test from "node:test";
import assert from "node:assert/strict";
import { BANKUJI, handleAdminAction, resetBankujiCacheForTest, resetLotteryCacheForTest, resetMartCacheForTest } from "../worker.js";

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
    docs, counts, put, plain, putP: (p, d) => put(p, encF(d)),
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
        if (w.updateMask) for (const fp of w.updateMask.fieldPaths) {
          if (fp.includes(".")) { const [top, key] = fp.split("."); const child = w.update.fields[top]?.mapValue?.fields?.[key]; const m = { ...(next[top]?.mapValue?.fields || {}) }; if (child) m[key] = child; else delete m[key]; next[top] = { mapValue: { fields: m } }; continue; }
          if (w.update.fields[fp] !== undefined) next[fp] = w.update.fields[fp]; else delete next[fp];
        }
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


const START = BANKUJI.saleStartMs;                         // 2026-10-26（月）8:00 JST
const DAY2 = START + 86400000;                              // 2026-10-27（火）8:00 JST
const MIN = 60000;
const ADMIN = "adminUid";
function setup() {
  resetLotteryCacheForTest(); resetBankujiCacheForTest(); resetMartCacheForTest();
  const left = Object.fromEntries(BANKUJI.prizes.map((p) => [p.id, p.count])); left.A = 0; left.H -= 1;   // A賞と H賞1本が引かれた
  const bits = Array.from({ length: BANKUJI.pool }, (_, i) => (i === 7 || i === 20 ? "1" : "0")).join("");
  const base = {
    "users/たろう": { uid: "uT", name: "たろう", coins: 1000 }, "users/はなこ": { uid: "uH", name: "はなこ", coins: 1000 },
    "bankujiRounds/r1": { round: "r1", soldBits: bits, sold: 2, left, status: "selling" },
    "bankujiEntries/r1_uT": { uid: "uT", name: "たろう", round: "r1", tickets: [7], prizes: [{ n: 7, id: "A", kind: "company", at: 1 }], dayKey: "2026-10-26", dayCount: 1 },
    "bankujiEntries/r1_uH": { uid: "uH", name: "はなこ", round: "r1", tickets: [20], prizes: [{ n: 20, id: "H", kind: "coin", amount: 100, at: 2 }], dayKey: "2026-10-26", dayCount: 1 }
  };
  const fs = fakeFs(base), logs = [];
  const deps = { firestore: { ...fs, async add(c, d) { logs.push({ c, d }); } }, adminUid: ADMIN, now: () => Date.UTC(2026, 9, 27, 3, 0), random: () => 0.5 };
  return { fs, logs, run: (body, uid = ADMIN) => handleAdminAction(deps, uid, { action: "bankujiPrize", ...body }) };
}

test("A賞を持っている人を探す：持ち主・券の番号・マートで買ったか・使ったかが分かる。管理者だけ", async () => {
  const t = setup();
  const r = await t.run({ prizeId: "A" });
  assert.equal(r.ok, true); assert.equal(r.holders.length, 1);
  assert.deepEqual([r.holders[0].name, r.holders[0].n, r.holders[0].bought, r.holders[0].used], ["たろう", 7, false, false]);
  assert.deepEqual(r.listed, []);
  assert.equal((await t.run({ prizeId: "A" }, "uT")).error, "not_admin");
  assert.equal((await t.run({ prizeId: "Z" })).error, "invalid_prize");
});

test("取り消してくじに戻す：景品を持ちものから消し、券の番号を売れていないに戻し、景品を箱に戻す。券代200コインを返す。操作の記録が残る", async () => {
  const t = setup();
  const r = await t.run({ mode: "revoke", prizeId: "A", uid: "uT", n: 7 });
  assert.equal(r.ok, true); assert.equal(r.refund, 200); assert.equal(r.name, "たろう");
  const e = t.fs.plain("bankujiEntries/r1_uT");
  assert.deepEqual(e.prizes, []); assert.deepEqual(e.tickets, []);
  const round = t.fs.plain("bankujiRounds/r1");
  assert.equal(round.soldBits[7], "0"); assert.equal(round.soldBits[20], "1"); assert.equal(round.sold, 1); assert.equal(round.left.A, 1);
  assert.equal(round.left.H, BANKUJI.prizes.find((p) => p.id === "H").count - 1, "ほかの景品は変わらない");
  assert.equal(t.fs.plain("users/たろう").coins, 1200);
  assert.equal(t.fs.plain("users/はなこ").coins, 1000);
  assert.equal(t.fs.plain("bankujiEntries/r1_uH").prizes.length, 1, "ほかの人の持ちものは変わらない");
  assert.equal((await t.run({ mode: "revoke", prizeId: "A", uid: "uT", n: 7 })).error, "not_found", "2回目はできない（二重に戻さない）");
  assert.equal(t.fs.plain("bankujiRounds/r1").left.A, 1);
  assert.equal((await t.run({ prizeId: "A" })).holders.length, 0);
});

test("券代を返さない選択。マートで買った・使った・出品中の景品・完売後は取り消せない", async () => {
  const t = setup();
  assert.equal((await t.run({ mode: "revoke", prizeId: "A", uid: "uT", n: 7, refund: false })).refund, 0);
  assert.equal(t.fs.plain("users/たろう").coins, 1000, "返さない");
  const b = setup(); b.fs.put("bankujiEntries/r1_uT", encF({ uid: "uT", name: "たろう", round: "r1", tickets: [], prizes: [{ n: 7, id: "A", kind: "company", at: 1, bt: 1 }] }));
  assert.equal((await b.run({ mode: "revoke", prizeId: "A", uid: "uT", n: 7 })).error, "bought");
  const u = setup(); u.fs.put("bankujiEntries/r1_uT", encF({ uid: "uT", name: "たろう", round: "r1", tickets: [7], prizes: [{ n: 7, id: "A", kind: "company", at: 1, used: 1 }] }));
  assert.equal((await u.run({ mode: "revoke", prizeId: "A", uid: "uT", n: 7 })).error, "used");
  const d = setup(); d.fs.put("bankujiRounds/r1", { ...d.fs.docs.get("bankujiRounds/r1").fields, status: { stringValue: "done" } });
  assert.equal((await d.run({ mode: "revoke", prizeId: "A", uid: "uT", n: 7 })).error, "sold_out");
  const l = setup(); l.fs.put("martIndex/open", encF({ json: JSON.stringify({ L: [{ i: "m1", k: "prize", pid: "A", u: "uT", n: "たろう", pz: { n: 7, id: "A" }, e: 9e15, t: 1 }], done: [], log: [], npcSold: [], NA: {}, ND: {}, paused: false }) }));
  assert.equal((await l.run({ prizeId: "A" })).listed.length, 1, "出品中のものも一覧に出る");
  assert.equal((await l.run({ mode: "revoke", prizeId: "A", uid: "uT", n: 7 })).error, "listed");
  assert.equal((await t.run({ mode: "revoke", prizeId: "A", uid: "uH", n: 20 })).error, "not_found", "A賞ではない景品は動かない");
});
