/* 🧽 消しバトの装備（本体・ふち・そこ・おもり）を、買う・付けるのテスト
   とくに、ゆうマートで買った「中古」のパーツを選んだまま、ショップで新品を買ってまとめて付けられること
   実行：node --test "notify-worker/test/*.test.mjs" */
import test from "node:test";
import assert from "node:assert/strict";
import { handleYuslotAction, resetYuslotCacheForTest, KESHI_PARTS, KESHI_SLOTS, KESHI_DEFAULT_EQ, keshiStats } from "../worker.js";

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


function setup({ coins = 100000, keshi = null } = {}) {
  resetYuslotCacheForTest();
  const base = { "worldConfig/yuslot": { yuslotPublished: true, keshiPublished: true }, "users/u0": { uid: "id0", name: "u0", coins } };
  if (keshi) base["yuslotKeshi/id0"] = keshi;
  const fs = fakeFs(base);
  const deps = { firestore: fs, adminUid: "a", now: () => Date.now(), random: Math.random, slotSecret: "s" };
  return { fs, act: (b) => handleYuslotAction(deps, "id0", { username: "u0", ...b }), keshi: () => fs.plain("yuslotKeshi/id0"), coins: () => fs.plain("users/u0").coins };
}
const USED = { owned: ["body:titan~u", "weight:lead~u", "edge:metal~u", "sole:wax"], eq: { ...KESHI_DEFAULT_EQ }, color: 0, n: "u0" };

test("どの枠（本体・ふち・そこ・おもり）のどのパーツも、1個ずつ買って付けられる。買ったあとは、いつでも付け替えられる", async () => {
  const t = setup();
  let spent = 0;
  for (const slot of KESHI_SLOTS) {
    for (const p of KESHI_PARTS[slot].filter((x) => x.price > 0)) {
      const r = await t.act({ action: "keshiBuy", slot, part: p.id });
      assert.equal(r.error, undefined, `${slot}:${p.id}`); assert.equal(r.eq[slot], p.id); spent += p.price;
      assert.ok(r.have[slot].includes(p.id));
    }
    for (const p of KESHI_PARTS[slot]) { const r = await t.act({ action: "keshiEquip", eq: { [slot]: p.id } }); assert.equal(r.error, undefined, `付ける ${slot}:${p.id}`); assert.equal(r.eq[slot], p.id); }
  }
  assert.equal(t.coins(), 100000 - spent);
  assert.deepEqual((await t.act({ action: "keshiEquip", eq: { body: "titan", edge: "crystal", sole: "air", weight: "gold" } })).eq, { body: "titan", edge: "crystal", sole: "air", weight: "gold" });
});

test("まとめて買う：4か所ぜんぶの新品を、1回で買って付けられる。合計だけコインが減る。足りなければ1個も買わない", async () => {
  const t = setup({ coins: 10000 });
  const items = [{ slot: "body", part: "pro" }, { slot: "edge", part: "band" }, { slot: "sole", part: "wax" }, { slot: "weight", part: "bolt" }];
  const r = await t.act({ action: "keshiBuyMany", items });
  assert.deepEqual([r.error, r.spent, r.eq.weight, r.eq.body, t.coins()], [undefined, 600 + 200 + 250 + 300, "bolt", "pro", 10000 - 1350]);
  const poor = setup({ coins: 1000 });
  assert.equal((await poor.act({ action: "keshiBuyMany", items })).error, "insufficient_coins");
  assert.deepEqual([poor.keshi(), poor.coins()], [null, 1000], "足りないときは、何も変わらない");
});

test("中古のパーツ（ゆうマートで買ったもの）を選んだまま、新品のおもりを買って、まとめて付けられる（以前は bad_request になっていた）", async () => {
  const t = setup({ coins: 5000, keshi: USED });
  const r = await t.act({ action: "keshiBuyMany", items: [{ slot: "body", part: "titan~u" }, { slot: "weight", part: "bolt" }] });
  assert.equal(r.error, undefined);
  assert.deepEqual([r.eq.body, r.eq.weight, r.spent, t.coins()], ["titan~u", "bolt", 300, 4700], "中古は無料で付く・新品のおもりだけ買う");
  assert.deepEqual(r.bought, [{ slot: "weight", part: "bolt", price: 300 }]);
  assert.ok(t.keshi().owned.includes("weight:bolt") && t.keshi().owned.includes("body:titan~u"));
  // 中古だけを選んで、まとめて付ける（買うものがない）
  const only = await t.act({ action: "keshiBuyMany", items: [{ slot: "edge", part: "metal~u" }, { slot: "weight", part: "lead~u" }] });
  assert.deepEqual([only.error, only.eq.edge, only.eq.weight, only.spent, t.coins()], [undefined, "metal~u", "lead~u", 0, 4700]);
  // 新品のおもり・そこ・中古の本体・ふちを、4か所いっしょに
  const all = await t.act({ action: "keshiBuyMany", items: [{ slot: "body", part: "titan~u" }, { slot: "edge", part: "metal~u" }, { slot: "sole", part: "teflon" }, { slot: "weight", part: "gold" }] });
  assert.deepEqual([all.error, all.spent, all.eq], [undefined, 1000 + 3000, { body: "titan~u", edge: "metal~u", sole: "teflon", weight: "gold" }]);
  assert.equal(all.stats.rating, keshiStats(all.eq).rating);
});

test("中古は、持っていなければ付けられない（ショップでは買えない）。持っていない中古を混ぜたら、何も買わない", async () => {
  const t = setup({ coins: 5000, keshi: USED });
  for (const body of [{ action: "keshiBuyMany", items: [{ slot: "weight", part: "gold~u" }] }, { action: "keshiBuyMany", items: [{ slot: "weight", part: "bolt" }, { slot: "body", part: "pro~u" }] }]) {
    assert.equal((await t.act(body)).error, "not_owned");
  }
  assert.equal(t.coins(), 5000); assert.deepEqual(t.keshi().eq, USED.eq);
  assert.equal((await t.act({ action: "keshiBuy", slot: "weight", part: "lead~u" })).error, "bad_request", "1個ずつ買う入口でも、中古は買えない");
  assert.equal((await t.act({ action: "keshiEquip", eq: { weight: "gold~u" } })).error, "not_owned");
  assert.equal((await t.act({ action: "keshiBuyMany", items: [{ slot: "weight", part: "none~u" }] })).error, "bad_request", "無料のパーツに中古はない");
  assert.equal((await t.act({ action: "keshiBuyMany", items: [{ slot: "weight", part: "bolt" }, { slot: "weight", part: "coin" }] })).error, "bad_request", "同じ枠は1個だけ");
});
