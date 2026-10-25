/* 🥷 スリ対策（防犯グッズの購入・通知の設定）のテスト
   実行：node --test "notify-worker/test/*.test.mjs" */
import test from "node:test";
import assert from "node:assert/strict";
import { handleEconomyAction, THEFT_GUARD_TABLE, theftGuardPrice, theftWeekStart } from "../worker.js";
import { THEFT_GUARDS, guardPriceOf, weekStartOf } from "../../yuu-theft.js";

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
function setup({ now = JST(2026, 10, 27, 12), coins = 20000, extra = {} } = {}) {
  const fs = fakeFs({ "users/u0": { uid: "id0", name: "u0", coins, ...extra } });
  const state = { now };
  const deps = { firestore: fs, now: () => state.now, random: () => 0.5 };
  const act = (body) => handleEconomyAction(deps, "id0", { username: "u0", ...body });
  return { fs, state, act, user: () => fs.plain("users/u0") };
}

test("表：Worker の防犯グッズの値段・週の月曜は、yuu-theft.js（アプリ・毎日の処理）と同じ", () => {
  assert.equal(THEFT_GUARD_TABLE.length, THEFT_GUARDS.length);
  for (let lv = 1; lv <= 5; lv++) {
    assert.deepEqual(THEFT_GUARD_TABLE[lv], { rate: THEFT_GUARDS[lv].rate, min: THEFT_GUARDS[lv].min });
    for (const total of [0, 100, 5000, 15000, 20958, 123456, 1e7]) assert.equal(theftGuardPrice(lv, total), guardPriceOf(lv, total), `lv${lv} ${total}`);
  }
  for (let i = 0; i < 400; i++) { const d = new Date(Date.UTC(2026, 0, 1) + i * 86400000).toISOString().slice(0, 10); assert.equal(theftWeekStart(d), weekStartOf(d), d); }
});

test("防犯グッズを買う：総資産に応じた値段のコインが引かれ、今週の分が付く（コインは消える）。上のレベルへは差額だけ", async () => {
  const t = setup();   // 10/27（火）・総資産20,000
  const r = await t.act({ action: "guardBuy", lv: 3 });
  assert.equal(r.ok, true); assert.equal(r.price, 500); assert.equal(r.week, "2026-10-26"); assert.equal(r.lv, 3);
  assert.equal(t.user().coins, 19500);
  assert.deepEqual(t.user().guards, { "2026-10-26": { lv: 3, paid: 500 } });
  assert.equal((await t.act({ action: "guardBuy", lv: 3 })).error, "ALREADY_HAVE");
  assert.equal((await t.act({ action: "guardBuy", lv: 2 })).error, "ALREADY_HAVE", "下のレベルは買えない");
  const up = await t.act({ action: "guardBuy", lv: 5 });   // 総資産19,500 × 6% ＝ 1,170 から、払った500を引く
  assert.equal(up.price, 670); assert.equal(t.user().coins, 18830);
  assert.deepEqual(t.user().guards, { "2026-10-26": { lv: 5, paid: 1170 } });
});

test("値段は、手持ち・預金・株を合わせた総資産（借入を引く）で決まる。コインが足りないと買えない。レベルの範囲外は不可", async () => {
  const t = setup({ coins: 500, extra: { bank: { deposit: 9000, interestBase: 9000, loan: 0 }, stocks: { YEN: { qty: 20, cost: 5000 } } } });   // 総資産 500＋9,000＋5,600＝15,100
  assert.equal((await t.act({ action: "guardBuy", lv: 5 })).error, "NOT_ENOUGH_COINS", "906 コイン必要（手持ちは500）");
  const ok = await t.act({ action: "guardBuy", lv: 3 });
  assert.equal(ok.price, 378); assert.equal(t.user().coins, 122);
  for (const lv of [0, 6, 1.5, "x", null]) assert.equal((await t.act({ action: "guardBuy", lv })).error, "invalid_lv");
  const loaned = setup({ coins: 20000, extra: { bank: { deposit: 0, interestBase: 0, loan: 10000 } } });
  assert.equal((await loaned.act({ action: "guardBuy", lv: 5 })).price, 700, "借入を引いた総資産 10,000 × 6%＝600 だが、最低額は700");
  assert.equal((await setup({ coins: 20000, extra: { bank: { deposit: 0, interestBase: 0, loan: 2000 } } }).act({ action: "guardBuy", lv: 4 })).price, 720, "18,000 × 4%");
});

test("来週の分は、金曜から買える（それ以前は買えない）。今週の分と別々に持てる。過ぎた週の分は、買うときに消える", async () => {
  const t = setup({ now: JST(2026, 10, 29, 12) });   // 木曜
  assert.equal((await t.act({ action: "guardBuy", lv: 2, which: "next" })).error, "TOO_EARLY");
  t.state.now = JST(2026, 10, 30, 12);   // 金曜
  const r = await t.act({ action: "guardBuy", lv: 2, which: "next" });
  assert.equal(r.ok, true); assert.equal(r.week, "2026-11-02");
  assert.equal((await t.act({ action: "guardBuy", lv: 1 })).week, "2026-10-26", "今週の分も買える");
  assert.deepEqual(Object.keys(t.user().guards).sort(), ["2026-10-26", "2026-11-02"]);
  t.state.now = JST(2026, 11, 3, 12);   // 次の週の火曜（先に買っていたレベル2が、今週の分になる）
  assert.equal((await t.act({ action: "guardBuy", lv: 2 })).error, "ALREADY_HAVE");
  assert.equal((await t.act({ action: "guardBuy", lv: 3 })).week, "2026-11-02");
  assert.deepEqual(Object.keys(t.user().guards), ["2026-11-02"], "過ぎた週（10/26）の分は消える");
});

test("スリの通知の入／切：初めは未設定（切）。本人が入にして、切にできる。値は真偽だけ", async () => {
  const t = setup();
  assert.equal(t.user().theftPush, undefined);
  assert.equal((await t.act({ action: "theftPush", on: true })).theftPush, true); assert.equal(t.user().theftPush, true);
  assert.equal((await t.act({ action: "theftPush", on: false })).theftPush, false); assert.equal(t.user().theftPush, false);
  assert.equal((await t.act({ action: "theftPush", on: "yes" })).error, "invalid_request");
});
