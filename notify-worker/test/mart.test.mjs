/* 🏪 ゆうマート（worker.js の mart*・中古パーツ）のテスト
   実行：node --test "notify-worker/test/*.test.mjs" */
import test from "node:test";
import assert from "node:assert/strict";
import { KESHI_PARTS, KESHI_SLOTS, KESHI_DEFAULT_EQ, KESHI_USED_RATE, MART, keshiStats, resetYuslotCacheForTest, handleYuslotAction } from "../worker.js";

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

/* 出品の id を毎回同じ並びにする（NPC が買う／値下げ依頼を出すかは id から決まるので、テストの結果を固定する） */
let uuidSeq = 0;
Object.defineProperty(globalThis, "crypto", { value: { ...globalThis.crypto, randomUUID: () => `${String(++uuidSeq).padStart(8, "0")}-0000-4000-8000-${String(uuidSeq * 7919).padStart(12, "0")}`, getRandomValues: (a) => globalThis.crypto.getRandomValues(a), subtle: globalThis.crypto.subtle }, configurable: true });
const JST = (y, mo, d, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h - 9, mi, 0);
const ADMIN = "adminUid";
const ALL_OWNED = KESHI_SLOTS.flatMap((s) => KESHI_PARTS[s].filter((p) => p.price > 0).map((p) => `${s}:${p.id}`));

function setup({ coins = 20000, now = JST(2026, 10, 25, 12), owned = [] } = {}) {
  resetYuslotCacheForTest();
  const base = { "worldConfig/yuslot": { yuslotPublished: true, keshiPublished: true } };
  for (let i = 0; i < 3; i++) base[`users/u${i}`] = { uid: `id${i}`, name: `u${i}`, coins };
  base["yuslotKeshi/id0"] = { owned, eq: { ...KESHI_DEFAULT_EQ }, color: 0, n: "u0" };
  const fs = fakeFs(base);
  const state = { now };
  const deps = { firestore: fs, adminUid: ADMIN, now: () => state.now, random: () => 0.5, slotSecret: "s", slotNpc: false, sendFcm: async () => ({ ok: true }) };
  const act = (i, body) => handleYuslotAction(deps, i === "admin" ? ADMIN : `id${i}`, { username: i === "admin" ? undefined : `u${i}`, ...body });
  return { fs, deps, state, act, coinsOf: (i) => fs.plain(`users/u${i}`).coins, ownedOf: (i) => fs.plain(`yuslotKeshi/id${i}`)?.owned || [], total: () => [0, 1, 2].reduce((a, i) => a + fs.plain(`users/u${i}`).coins, 0) };
}
const MIN = 60000;

test("中古のパーツ：ショップの新品より、増える点数がほんの少しだけ低い。減る点数はそのまま。無料のパーツに中古はない", () => {
  const fresh = keshiStats({ ...KESHI_DEFAULT_EQ, body: "titan" }), used = keshiStats({ ...KESHI_DEFAULT_EQ, body: "titan~u" });
  assert.ok(used.rating < fresh.rating && used.rating >= fresh.rating - 6, `中古 ${used.rating} / 新品 ${fresh.rating}`);
  assert.equal(used.z, fresh.z, "減る点数（大きさ -2）はそのまま");
  assert.deepEqual(keshiStats({ ...KESHI_DEFAULT_EQ, body: "plain~u" }), keshiStats(KESHI_DEFAULT_EQ), "無料パーツの中古は無効＝初期のまま");
  assert.ok(KESHI_USED_RATE < 1 && KESHI_USED_RATE > 0.85);
});

test("出品→購入：パーツは預かりになり、売れたら中古で買った人へ。手数料10%は消える。付けていたパーツははずれる", async () => {
  const t = setup({ owned: ["body:titan"] });
  await t.act(0, { action: "keshiEquip", eq: { body: "titan" } });
  const before = t.total();
  const l = await t.act(0, { action: "martList", slot: "body", part: "titan", price: 1000 });
  assert.equal(l.ok, true);
  assert.deepEqual(t.ownedOf(0), [], "預かり");
  assert.equal(t.fs.plain("yuslotKeshi/id0").eq.body, "plain", "付けていたら外れる");
  const st = await t.act(1, { action: "martStatus" });
  const mine = st.listings.find((x) => x.id === l.id);
  assert.ok(mine && mine.price === 1000 && mine.part === "titan~u");
  const r = await t.act(1, { action: "martBuy", id: l.id });
  assert.equal(r.ok, true); assert.equal(r.fee, 100);
  assert.equal(t.coinsOf(1), 19000); assert.equal(t.coinsOf(0), 20900);
  assert.ok(t.ownedOf(1).includes("body:titan~u"));
  assert.equal(t.total(), before - 100, "手数料のぶんだけ世の中のコインが減る");
  assert.equal((await t.act(2, { action: "martBuy", id: l.id })).error, "gone", "売れたら買えない");
  const eq = await t.act(1, { action: "keshiEquip", eq: { body: "titan~u" } });
  assert.equal(eq.eq.body, "titan~u");
  const s = await t.act(1, { action: "keshiState" });
  assert.ok(s.table.parts.body.some((p) => p.id === "titan~u"), "持っている中古は一覧に出る");
  assert.ok(s.have.body.includes("titan~u"));
  const again = await t.act(1, { action: "martList", slot: "body", part: "titan~u", price: 700 });
  assert.equal(again.ok, true, "中古もまた売れる");
});

test("買えない場合：自分の出品・コイン不足・同じ中古をすでに持っている・ゆうスロの席に着いている", async () => {
  const t = setup({ owned: ["body:titan", "edge:metal"] });
  const a = await t.act(0, { action: "martList", slot: "body", part: "titan", price: 500 });
  assert.equal((await t.act(0, { action: "martBuy", id: a.id })).error, "own_listing");
  t.fs.putP("users/u1", { uid: "id1", name: "u1", coins: 100 });
  assert.equal((await t.act(1, { action: "martBuy", id: a.id })).error, "insufficient_coins");
  t.fs.putP("users/u1", { uid: "id1", name: "u1", coins: 5000 });
  t.fs.putP("yuslotKeshi/id1", { owned: ["body:titan~u"], eq: { ...KESHI_DEFAULT_EQ }, color: 0, n: "u1" });
  assert.equal((await t.act(1, { action: "martBuy", id: a.id })).error, "already_owned");
  t.fs.putP("yuslotKeshi/id1", { owned: [], eq: { ...KESHI_DEFAULT_EQ }, color: 0, n: "u1" });
  t.fs.putP("yuslotSeats/m1", { uid: "id1", graceUntilMs: t.state.now + 60000 });
  assert.equal((await t.act(1, { action: "martBuy", id: a.id })).error, "seated");
  assert.equal((await t.act(0, { action: "martList", slot: "body", part: "plain", price: 5 })).error, "bad_request", "無料のパーツは出品できない");
  assert.equal((await t.act(0, { action: "martList", slot: "edge", part: "crystal", price: 5 })).error, "not_owned");
  assert.equal((await t.act(0, { action: "martList", slot: "edge", part: "metal", price: 0 })).error, "bad_price");
});

test("取り消し・期限切れ：パーツは元の状態（新品は新品）のまま戻る。1人10件まで", async () => {
  const t = setup({ owned: ALL_OWNED });
  const a = await t.act(0, { action: "martList", slot: "body", part: "titan", price: 900 });
  assert.equal((await t.act(1, { action: "martCancel", id: a.id })).error, "gone", "他人は取り消せない");
  assert.equal((await t.act(0, { action: "martCancel", id: a.id })).ok, true);
  assert.ok(t.ownedOf(0).includes("body:titan"));
  const ids = [];
  for (let i = 0; i < MART.maxOpen; i++) { const p = ALL_OWNED[i].split(":"); const r = await t.act(0, { action: "martList", slot: p[0], part: p[1], price: 99999 }); assert.equal(r.ok, true); ids.push(r.id); }
  const p = ALL_OWNED[MART.maxOpen].split(":");
  assert.equal((await t.act(0, { action: "martList", slot: p[0], part: p[1], price: 99999 })).error, "too_many");
  t.state.now += MART.listMs + MIN;
  const st = await t.act(1, { action: "martStatus" });
  assert.equal(st.listings.filter((x) => !x.npc).length, 0, "期限切れは一覧から消える");
  const mine = await t.act(0, { action: "martMine" });
  assert.equal(mine.listings.length, MART.maxOpen); assert.ok(mine.listings.every((x) => x.expired));
  assert.equal((await t.act(0, { action: "martCancel", id: ids[0] })).ok, true, "期限切れも取り消して戻せる");
});

test("値下げ依頼：買いたい人が値段を出し、出品者が受けると、その値段で売れる。1人1件・安すぎる値段は出せない", async () => {
  const t = setup({ owned: ["body:titan"] });
  const a = await t.act(0, { action: "martList", slot: "body", part: "titan", price: 2000 });
  assert.equal((await t.act(1, { action: "martOffer", id: a.id, price: 2000 })).error, "bad_price");
  assert.equal((await t.act(1, { action: "martOffer", id: a.id, price: 500 })).error, "bad_price");
  assert.equal((await t.act(1, { action: "martOffer", id: a.id, price: 1500 })).ok, true);
  assert.equal((await t.act(1, { action: "martOffer", id: a.id, price: 1400 })).error, "already_offered");
  assert.equal((await t.act(2, { action: "martOffer", id: a.id, price: 1200 })).ok, true);
  const mine = await t.act(0, { action: "martMine" });
  assert.deepEqual(mine.listings[0].offers.map((o) => o.q).sort(), [1200, 1500]);
  assert.equal((await t.act(1, { action: "martMine" })).myOffers[0].q, 1500);
  assert.equal((await t.act(1, { action: "martAnswer", id: a.id, who: "id2", accept: true })).error, "gone", "出品者以外は答えられない");
  const r = await t.act(0, { action: "martAnswer", id: a.id, who: "id1", accept: true });
  assert.equal(r.ok, true); assert.equal(r.price, 1500); assert.equal(r.fee, 150);
  assert.equal(t.coinsOf(1), 18500); assert.equal(t.coinsOf(0), 20000 + 1350);
  assert.ok(t.ownedOf(1).includes("body:titan~u"));
  assert.equal(t.fs.plain("martIndex/open") && JSON.parse(t.fs.plain("martIndex/open").json).L.length, 0, "ほかの依頼も一緒に消える");
});

test("値下げ依頼を断る／買う人のコインが足りない・すでに持っているときは、依頼だけ消える", async () => {
  const t = setup({ owned: ["body:titan", "edge:metal"] });
  const a = await t.act(0, { action: "martList", slot: "body", part: "titan", price: 2000 });
  await t.act(1, { action: "martOffer", id: a.id, price: 1500 });
  assert.equal((await t.act(0, { action: "martAnswer", id: a.id, who: "id1", accept: false })).ok, true);
  assert.equal((await t.act(0, { action: "martMine" })).listings[0].offers.length, 0);
  await t.act(1, { action: "martOffer", id: a.id, price: 1500 });
  t.fs.putP("users/u1", { uid: "id1", name: "u1", coins: 10 });
  assert.equal((await t.act(0, { action: "martAnswer", id: a.id, who: "id1", accept: true })).error, "buyer_no_coins");
  assert.equal((await t.act(0, { action: "martMine" })).listings[0].offers.length, 0);
  assert.ok(t.ownedOf(0).length === 1, "パーツは売れずに預かりのまま");
});

test("NPC の出品：いつも14件ほど。値段は相場（ショップの値段×0.75）の1.0〜1.5倍で、NPC から買うとコインは減るだけ", async () => {
  const t = setup();
  const st = await t.act(1, { action: "martStatus" });
  const npc = st.listings.filter((x) => x.npc && !x.au);
  assert.equal(npc.length, MART.npcSlots);
  for (const x of npc) {
    const ref = Math.round(KESHI_PARTS[x.slot].find((p) => p.id === x.part.replace("~u", "")).price * 0.75);
    assert.ok(x.part.endsWith("~u"));
    assert.ok(x.price >= ref - 5 && x.price <= ref * 1.5 + 5, `${x.part} ${x.price} / 相場 ${ref}`);
    assert.ok(x.price <= MART.npcMaxPay);
  }
  const again = await t.act(2, { action: "martStatus" });
  assert.deepEqual(again.listings.filter((x) => x.npc && !x.au).map((x) => x.id), npc.map((x) => x.id), "同じ時刻なら誰が見ても同じ");
  const reads = t.fs.counts.getRaw;
  await t.act(2, { action: "martStatus" });
  assert.equal(t.fs.counts.getRaw, reads, "一覧は数秒のあいだメモリから返す（読み取りなし）");
  const target = npc.find((x) => !t.ownedOf(1).includes(`${x.slot}:${x.part}`));
  const before = t.coinsOf(1);
  const r = await t.act(1, { action: "martBuy", id: target.id });
  assert.equal(r.ok, true);
  assert.equal(t.coinsOf(1), before - target.price, "NPC には手数料もなく、払ったコインは世の中から消える");
  assert.ok(t.ownedOf(1).includes(`${target.slot}:${target.part}`));
  assert.equal((await t.act(2, { action: "martBuy", id: target.id })).error, "gone");
  assert.equal((await t.act(2, { action: "martStatus" })).listings.some((x) => x.id === target.id), false);
  t.state.now += 13 * 3600000;
  const later = await t.act(2, { action: "martStatus" });
  assert.equal(later.listings.filter((x) => x.npc && !x.au).length, MART.npcSlots, "時間がたつと入れ替わる");
});

test("NPC の買い取り：相場の1.05倍以下の出品は約半分が買われる。受け取るのは売値−手数料。精算は出品者が開いたとき", async () => {
  const t = setup({ owned: ALL_OWNED });
  const items = ALL_OWNED.slice(0, MART.maxOpen).map((o) => o.split(":"));
  const ids = [];
  for (const [slot, part] of items) {
    const ref = Math.round(KESHI_PARTS[slot].find((p) => p.id === part).price * 0.75);
    const r = await t.act(0, { action: "martList", slot, part, price: ref });
    assert.equal(r.ok, true); ids.push(r.id);
  }
  const before = t.coinsOf(0), totalBefore = t.total();
  t.state.now += 95 * MIN;
  const st = await t.act(1, { action: "martStatus" });
  const stillOpen = ids.filter((id) => st.listings.some((x) => x.id === id));
  const mine = await t.act(0, { action: "martMine" });
  const soldN = ids.length - mine.listings.length;
  assert.ok(soldN >= 1 && soldN < ids.length, `約半分が NPC に売れる（${soldN}/${ids.length}）`);
  assert.equal(mine.done.filter((d) => d.npc).length, soldN);
  assert.equal(stillOpen.length, mine.listings.length, "買われた出品は、一覧からも消えている");
  const gain = mine.done.reduce((a, d) => a + d.q - d.fee, 0);
  assert.equal(t.coinsOf(0), before + gain);
  assert.ok(mine.done.every((d) => d.q <= MART.npcMaxPay && d.fee === Math.floor(d.q / 10)));
  assert.ok(t.total() > totalBefore, "NPC に売ると、コインが入る（買ったときの値段以下）");
  assert.ok(gain <= items.reduce((a, [slot, part]) => a + KESHI_PARTS[slot].find((p) => p.id === part).price, 0), "ショップで買った値段より多くはならない");
});

test("NPC の値下げ依頼：相場より高い出品に、高い確率で来る。額は相場の0.8〜1.0倍で、4,000コインまで。受けるのは出品者しだい", async () => {
  const t = setup({ owned: ALL_OWNED });
  const ids = [];
  for (const o of ALL_OWNED.slice(0, MART.maxOpen)) { const [slot, part] = o.split(":"); const r = await t.act(0, { action: "martList", slot, part, price: 100000 }); ids.push(r.id); }
  t.state.now += 4 * 3600000;
  const mine = await t.act(0, { action: "martMine" });
  const withOffer = mine.listings.filter((x) => x.npcOffer);
  assert.ok(withOffer.length >= 5, `結構な確率で来る（${withOffer.length}/10）`);
  for (const x of withOffer) {
    const ref = Math.round(KESHI_PARTS[x.slot].find((p) => p.id === x.part.replace("~u", "")).price * 0.75);
    assert.ok(x.npcOffer.q >= Math.round(ref * 0.8 / 10) * 10 && x.npcOffer.q <= Math.round(ref / 10) * 10 && x.npcOffer.q <= MART.npcMaxPay, `${x.part} ${x.npcOffer.q}`);
  }
  const x = withOffer[0], before = t.coinsOf(0);
  const r = await t.act(0, { action: "martAnswer", id: x.id, who: "npc", accept: true });
  assert.equal(r.ok, true); assert.equal(r.price, x.npcOffer.q);
  assert.equal(t.coinsOf(0), before + r.price - Math.floor(r.price / 10));
  const y = withOffer[1];
  assert.equal((await t.act(0, { action: "martAnswer", id: y.id, who: "npc", accept: false })).ok, true);
  assert.equal((await t.act(0, { action: "martMine" })).listings.find((l) => l.id === y.id).npcOffer, null, "断ったら、同じ出品には来ない");
  t.state.now += 30 * 3600000;
  const late = await t.act(0, { action: "martMine" });
  assert.ok(late.listings.every((l) => l.npcOffer === null || l.expired === false) , "依頼は24時間で消える");
});

test("NPC の1件の支払いは4,000コインまで（高額の出品に値下げ依頼が来ても、4,000を超えない）", async () => {
  const t = setup({ owned: ["weight:gold"] });
  const r = await t.act(0, { action: "martList", slot: "weight", part: "gold", price: 9999999 });
  assert.equal(r.ok, true);
  for (let h = 1; h <= 3; h++) { t.state.now += 2 * 3600000; const m = await t.act(0, { action: "martMine" }); const x = m.listings[0]; if (x.npcOffer) assert.ok(x.npcOffer.q <= MART.npcMaxPay); }
});

test("管理者：売れた記録に印（高額・相場の3倍以上・同じ2人の繰り返し）。一時停止・強制取り下げができる。一般の人は使えない", async () => {
  const t = setup({ owned: ALL_OWNED });
  assert.equal((await t.act(1, { action: "martAdmin" })).error, "not_top_admin");
  for (let i = 0; i < 3; i++) {
    const [slot, part] = ALL_OWNED[i].split(":");
    const a = await t.act(0, { action: "martList", slot, part, price: 6000 });
    assert.equal((await t.act(1, { action: "martBuy", id: a.id })).ok, true);
  }
  const rep = await t.act("admin", { action: "martAdmin", op: "report" });
  assert.equal(rep.log.length, 3);
  assert.ok(rep.log.every((e) => e.flags.includes("高額") && e.flags.includes("同じ2人の繰り返し")));
  assert.ok(rep.log.some((e) => e.flags.includes("相場の3倍以上")));
  const b = await t.act(0, { action: "martList", slot: "edge", part: "metal", price: 100 });
  assert.equal((await t.act("admin", { action: "martAdmin", op: "pause", paused: true })).paused, true);
  assert.equal((await t.act(1, { action: "martBuy", id: b.id })).error, "paused");
  assert.equal((await t.act(0, { action: "martList", slot: "edge", part: "crystal", price: 100 })).error, "paused");
  assert.equal((await t.act(1, { action: "martStatus" })).paused, true);
  await t.act("admin", { action: "martAdmin", op: "pause", paused: false });
  assert.equal((await t.act("admin", { action: "martAdmin", op: "remove", id: b.id })).ok, true);
  assert.ok(t.ownedOf(0).includes("edge:metal"), "強制取り下げ：持ち主に戻る");
});

test("消しバトが非公開のあいだは、ふつうの人は使えない", async () => {
  const t = setup();
  t.fs.putP("worldConfig/yuslot", { yuslotPublished: true, keshiPublished: false });
  resetYuslotCacheForTest();
  assert.equal((await t.act(1, { action: "martStatus" })).error, "not_published");
  assert.equal((await t.act(1, { action: "martBuy", id: "n0-1" })).error, "not_published");
});

test("商品の絵：有料パーツの全部に、そのパーツの絵がある（中古でも同じ絵）", async () => {
  const { partArt, MART_ART_KEYS } = await import("../../yumart-art.js");
  const keys = KESHI_SLOTS.flatMap((s) => KESHI_PARTS[s].filter((p) => p.price > 0).map((p) => `${s}:${p.id}`));
  assert.deepEqual([...MART_ART_KEYS].sort(), [...keys].sort());
  for (const k of keys) { const [s, i] = k.split(":"); assert.equal(partArt(s, `${i}~u`), partArt(s, i)); assert.ok(!partArt(s, i).includes("📦")); }
});

/* ---------- 確変枠・番くじ景品 ---------- */
import { kakuInitialSlots, kakuMachineFor, resetKakuCacheForTest, martNpcFloor, BANKUJI } from "../worker.js";
const DAY = "2026-10-26", SLOT0 = kakuInitialSlots(DAY)[0];   // 8:00〜8:30
function setupKaku(over = {}) {
  resetKakuCacheForTest();
  const t = setup({ now: JST(2026, 10, 26, 6), ...over });
  const slots = kakuInitialSlots(DAY).map((x) => (x.i === 0 ? { ...x, uid: "id0", name: "u0" } : x.i === 1 ? { ...x, uid: "id2", name: "u2" } : x.i === 2 ? { ...x, npc: true, name: "ほしぞら" } : x));
  t.fs.putP(`yuslotKaku/${DAY}`, { day: DAY, machine: "yubasic", mode: "full", slots, app1: [], app2: [], draw1Done: true, draw2Done: true });
  return t;
}
const slotsOf = (t) => t.fs.plain(`yuslotKaku/${DAY}`).slots;

test("確変枠：自分が当てた枠だけ出品できる（NPC の枠・他人の枠・買った枠・始まる10分前をすぎた枠は出せない）", async () => {
  const t = setupKaku();
  const mine = await t.act(0, { action: "martSellable" });
  assert.deepEqual(mine.slots.map((x) => [x.day, x.si, x.ref]), [[DAY, 0, 1500 * 1.5 >= 0 ? mine.slots[0].ref : 0]].map(([d, s]) => [d, s, mine.slots[0].ref]));
  assert.equal(mine.slots[0].ref, 1500 * (new Date(`${DAY}T00:00:00Z`).getUTCDay() % 6 === 0 ? 1.5 : 1));
  assert.equal((await t.act(1, { action: "martSellable" })).slots.length, 0);
  assert.equal((await t.act(0, { action: "martList", kind: "kaku", day: DAY, si: 1, price: 1000 })).error, "not_owned", "他人の枠");
  assert.equal((await t.act(0, { action: "martList", kind: "kaku", day: DAY, si: 2, price: 1000 })).error, "not_owned", "NPC の枠");
  assert.equal((await t.act(0, { action: "martList", kind: "kaku", day: "2026-10-30", si: 0, price: 1000 })).error, "bad_request");
  t.state.now = SLOT0.s - 9 * MIN;
  assert.equal((await t.act(0, { action: "martList", kind: "kaku", day: DAY, si: 0, price: 1000 })).error, "too_late", "始まる10分前をすぎたら出せない");
});

test("確変枠：売れたら枠の持ち主が買った人に変わる。買った枠はまた売れない。NPC は売り買いしない。期限は枠の始まりの10分前", async () => {
  const t = setupKaku();
  const l = await t.act(0, { action: "martList", kind: "kaku", day: DAY, si: 0, price: 2000 });
  assert.equal(l.ok, true);
  assert.equal((await t.act(0, { action: "martList", kind: "kaku", day: DAY, si: 0, price: 1800 })).error, "already_listed");
  assert.equal((await t.act(0, { action: "martSellable" })).slots.length, 0, "出品中の枠は出品する一覧から消える");
  const st = await t.act(1, { action: "martStatus" });
  const x = st.listings.find((v) => v.id === l.id);
  assert.equal(x.k, "kaku"); assert.equal(x.machine, kakuMachineFor(DAY)); assert.equal(x.e, SLOT0.s - 10 * MIN);
  t.state.now += 3 * 3600000;
  const mine = await t.act(0, { action: "martMine" });
  assert.equal(mine.listings[0].npcOffer, null, "NPC は枠を買わず、値下げ依頼も出さない");
  t.state.now = JST(2026, 10, 26, 6);
  const before = t.total();
  const r = await t.act(1, { action: "martBuy", id: l.id });
  assert.equal(r.ok, true); assert.equal(r.fee, 200);
  const s0 = slotsOf(t).find((v) => v.i === 0);
  assert.equal(s0.uid, "id1"); assert.equal(s0.name, "u1"); assert.equal(s0.bt, 1);
  assert.equal(t.coinsOf(0), 20000 + 1800); assert.equal(t.total(), before - 200);
  assert.equal((await t.act(1, { action: "martList", kind: "kaku", day: DAY, si: 0, price: 2500 })).error, "not_owned", "買った枠はまた売れない");
  assert.equal((await t.act(1, { action: "martSellable" })).slots.length, 0);
});

test("確変枠：出品したあとに持ち主でなくなっていたら売れない／買う人は1日3枠まで／期限がすぎたら一覧から消える", async () => {
  const t = setupKaku();
  const l = await t.act(0, { action: "martList", kind: "kaku", day: DAY, si: 0, price: 800 });
  const slots = slotsOf(t).map((x) => (x.i === 0 ? { ...x, uid: "idX", name: "x" } : x));
  t.fs.putP(`yuslotKaku/${DAY}`, { day: DAY, machine: "yubasic", mode: "full", slots, app1: [], app2: [], draw1Done: true, draw2Done: true });
  resetYuslotCacheForTest();
  assert.equal((await t.act(1, { action: "martBuy", id: l.id })).error, "gone");
  const t2 = setupKaku();
  const l2 = await t2.act(0, { action: "martList", kind: "kaku", day: DAY, si: 0, price: 800 });
  const full = slotsOf(t2).map((x) => (x.i >= 3 && x.i <= 5 ? { ...x, uid: "id1", name: "u1" } : x));
  t2.fs.putP(`yuslotKaku/${DAY}`, { day: DAY, machine: "yubasic", mode: "full", slots: full, app1: [], app2: [], draw1Done: true, draw2Done: true });
  resetYuslotCacheForTest();
  assert.equal((await t2.act(1, { action: "martBuy", id: l2.id })).error, "slot_limit");
  t2.state.now = SLOT0.s - 10 * MIN + 1;
  assert.equal((await t2.act(2, { action: "martStatus" })).listings.some((v) => v.id === l2.id), false);
});

const PRIZES = [{ n: 5, id: "E", kind: "gear", code: "body", at: 1 }, { n: 6, id: "C", kind: "kaku3", until: JST(2027, 1, 1), at: 1 }, { n: 7, id: "B", kind: "stock", code: "X", qty: 25, at: 1 }, { n: 8, id: "H", kind: "coin", amount: 100, at: 1 },
  { n: 9, id: "L", kind: "last", at: 1 }, { n: 10, id: "F", kind: "color", code: "gold", at: 1 }, { n: 11, id: "A", kind: "company", at: 1 }, { n: 12, id: "D", kind: "kaku1", until: JST(2027, 1, 1), at: 1 }];
const entryOf = (t, i) => t.fs.plain(`bankujiEntries/${BANKUJI.round}_id${i}`);
function setupPrize() {
  const t = setup();
  t.fs.putP(`bankujiEntries/${BANKUJI.round}_id0`, { uid: "id0", name: "u0", round: BANKUJI.round, tickets: [5, 6], prizes: PRIZES, dayKey: "2026-10-26", dayCount: 8 });
  return t;
}

test("番くじ景品：A・C・D・E・F だけ出品できる（株・コイン・ラストワン賞は売れない）。出品中は預かり、取り消すと戻る", async () => {
  const t = setupPrize();
  const s = await t.act(0, { action: "martSellable" });
  assert.deepEqual(s.prizes.map((x) => x.pid).sort(), ["A", "C", "D", "E", "F"]);
  for (const n of [7, 8, 9]) assert.equal((await t.act(0, { action: "martList", kind: "prize", n, price: 100 })).error, "not_owned");
  const l = await t.act(0, { action: "martList", kind: "prize", n: 5, price: 500 });
  assert.equal(l.ok, true);
  assert.ok(!entryOf(t, 0).prizes.some((x) => x.n === 5), "預かり");
  assert.equal((await t.act(0, { action: "martList", kind: "prize", n: 5, price: 500 })).error, "not_owned", "同じ景品は二重に出せない");
  assert.equal((await t.act(0, { action: "martCancel", id: l.id })).ok, true);
  assert.ok(entryOf(t, 0).prizes.some((x) => x.n === 5), "戻る");
  assert.equal(entryOf(t, 0).prizes.length, PRIZES.length);
});

test("番くじ景品：売れたら買った人の景品の記録に入る（書類がなくても作る）。確変台の予約権は、買ったものをまた売れない。ほかは売れる", async () => {
  const t = setupPrize();
  const e = await t.act(0, { action: "martList", kind: "prize", n: 5, price: 700 });
  const c = await t.act(0, { action: "martList", kind: "prize", n: 6, price: 1500 });
  assert.equal(entryOf(t, 1), null);
  assert.equal((await t.act(1, { action: "martBuy", id: e.id })).ok, true);
  assert.equal((await t.act(1, { action: "martBuy", id: c.id })).ok, true);
  const mine = entryOf(t, 1);
  assert.deepEqual(mine.prizes.map((x) => [x.n, x.id, x.bt]), [[5, "E", 1], [6, "C", 1]]);
  assert.equal(t.coinsOf(0), 20000 + 630 + 1350);
  assert.equal((await t.act(1, { action: "martList", kind: "prize", n: 6, price: 2000 })).error, "no_resale");
  assert.equal((await t.act(1, { action: "martList", kind: "prize", n: 5, price: 800 })).ok, true, "E賞は買ったものもまた売れる");
  assert.ok(!(await t.act(1, { action: "martSellable" })).prizes.some((x) => x.pid === "C"));
});

test("番くじ景品：期限切れの予約権は出せない。NPC が景品に出す額は相場の0.5〜0.65倍まで（景品を NPC に売ってコインが増えすぎない）", async () => {
  const t = setupPrize();
  t.state.now = JST(2027, 1, 2);
  assert.equal((await t.act(0, { action: "martList", kind: "prize", n: 12, price: 500 })).error, "right_expired");
  t.state.now = JST(2026, 10, 26, 6);
  const ids = [];
  for (const [n, price] of [[5, 100000], [10, 100000], [11, 100000], [6, 100000], [12, 100000]]) { const r = await t.act(0, { action: "martList", kind: "prize", n, price }); assert.equal(r.ok, true); ids.push(r.id); }
  t.state.now += 6 * 3600000;
  const m = await t.act(0, { action: "martMine" });
  const REF = { E: 600, F: 300, A: 8000, C: 1500, D: 900 };
  for (const x of m.listings.filter((v) => v.npcOffer)) { assert.ok(x.npcOffer.q <= Math.min(4000, Math.round(REF[x.pid] * 0.65 / 10) * 10), `${x.pid} ${x.npcOffer.q}`); assert.ok(x.npcOffer.q >= Math.min(4000, Math.round(REF[x.pid] * 0.5 / 10) * 10)); }
  const lowId = (await t.act(0, { action: "martList", kind: "prize", n: 5, price: 100000 })).error;
  assert.ok(lowId === "not_owned", "出品中のものは出せない");
});

/* ---------- オークション ---------- */
const H = 3600000;
const idxOf = (t) => JSON.parse(t.fs.plain("martIndex/open").json);
const aucList = (t, i, o = {}) => t.act(i, { action: "martList", kind: "part", slot: "body", part: "titan", price: 2000, auction: true, hours: 6, ...o });

test("オークションの出品：期間は1・6・24・72時間だけ。確変枠はオークションにできない。固定価格の購入・値下げ依頼はできない", async () => {
  const t = setupKaku({ owned: ["body:titan", "body:pro"] });
  assert.equal((await aucList(t, 0, { hours: 5 })).error, "bad_request");
  assert.equal((await t.act(0, { action: "martList", kind: "kaku", day: DAY, si: 0, price: 500, auction: true, hours: 6 })).error, "no_auction");
  const a = await aucList(t, 0);
  assert.equal(a.ok, true);
  assert.equal((await t.act(1, { action: "martBuy", id: a.id })).error, "auction_only");
  assert.equal((await t.act(1, { action: "martOffer", id: a.id, price: 1500 })).error, "auction_only");
  const x = (await t.act(1, { action: "martStatus" })).listings.find((v) => v.id === a.id);
  assert.equal(x.au.cur, 2000); assert.equal(x.au.nb, 0); assert.equal(x.au.min, 2000); assert.equal(x.e - x.t, 6 * H);
  assert.equal((await t.act(0, { action: "martCancel", id: a.id })).ok, true, "入札がなければ取り下げられる");
});

test("入札：開始価格以上・最高額の5%以上上乗せ。自分の出品・最高入札中の人・コイン不足は不可。入札があると取り下げられない", async () => {
  const t = setup({ owned: ["body:titan"] });
  const a = await aucList(t, 0);
  assert.equal((await t.act(0, { action: "martBid", id: a.id, price: 3000 })).error, "own_listing");
  assert.deepEqual([(await t.act(1, { action: "martBid", id: a.id, price: 1999 })).error, (await t.act(1, { action: "martBid", id: a.id, price: 1999 })).min], ["bid_too_low", 2000]);
  assert.equal((await t.act(1, { action: "martBid", id: a.id, price: 2000 })).ok, true);
  assert.equal((await t.act(1, { action: "martBid", id: a.id, price: 2500 })).error, "already_top");
  assert.equal((await t.act(2, { action: "martBid", id: a.id, price: 2099 })).error, "bid_too_low", "2000 の5%＝100 以上");
  t.fs.putP("users/u2", { uid: "id2", name: "u2", coins: 2000 });
  assert.equal((await t.act(2, { action: "martBid", id: a.id, price: 2100 })).error, "insufficient_coins");
  t.fs.putP("users/u2", { uid: "id2", name: "u2", coins: 20000 });
  assert.equal((await t.act(2, { action: "martBid", id: a.id, price: 2100 })).ok, true);
  const x = (await t.act(1, { action: "martStatus" })).listings.find((v) => v.id === a.id);
  assert.deepEqual([x.au.cur, x.au.nb, x.au.top, x.au.min], [2100, 2, "u2", 2205]);
  assert.equal((await t.act(1, { action: "martMine" })).myBids[0].top, false, "追い越された");
  assert.equal((await t.act(0, { action: "martCancel", id: a.id })).error, "has_bids");
  assert.equal(t.coinsOf(1), 20000, "入札では、コインは引かれない");
});

test("終了の5分前以降の入札は、終了が5分のびる", async () => {
  const t = setup({ owned: ["body:titan"] });
  const a = await aucList(t, 0, { hours: 1 });
  const e0 = t.state.now + H;
  t.state.now = e0 - 30 * MIN; await t.act(1, { action: "martBid", id: a.id, price: 2000 });
  assert.equal((await t.act(2, { action: "martStatus" })).listings.find((v) => v.id === a.id).e, e0, "まだ早い");
  t.state.now = e0 - 2 * MIN; await t.act(2, { action: "martBid", id: a.id, price: 2200 });
  assert.equal((await t.act(1, { action: "martStatus" })).listings.find((v) => v.id === a.id).e, e0 - 2 * MIN + 5 * MIN);
});

test("落札：終わったら、いちばん高い人が自分の入札額を払う。手数料10%。パーツは中古で届く。精算は誰かが開いたときに行う", async () => {
  const t = setup({ owned: ["body:titan"] });
  const a = await aucList(t, 0, { hours: 1 });
  await t.act(1, { action: "martBid", id: a.id, price: 2000 });
  await t.act(2, { action: "martBid", id: a.id, price: 2500 });
  const before = t.total();
  t.state.now += H + MIN;
  const st = await t.act(1, { action: "martStatus" });
  assert.equal(st.listings.some((v) => v.id === a.id), false);
  assert.equal(t.coinsOf(2), 17500); assert.equal(t.coinsOf(1), 20000); assert.equal(t.coinsOf(0), 20000 + 2250);
  assert.ok(t.ownedOf(2).includes("body:titan~u")); assert.equal(t.ownedOf(0).length, 0);
  assert.equal(t.total(), before - 250);
  const mine = await t.act(2, { action: "martMine" });
  assert.equal(mine.done[0].q, 2500);
  assert.equal(idxOf(t).L.length, 0);
});

test("落札：払えない人・すでに同じ中古を持っている人は飛ばして、次の人へ。誰も払えなければ出品者に戻る。入札がなければそのまま戻る", async () => {
  const t = setup({ owned: ["body:titan", "body:pro", "edge:metal"] });
  const a = await aucList(t, 0, { hours: 1 });
  await t.act(1, { action: "martBid", id: a.id, price: 2000 });
  await t.act(2, { action: "martBid", id: a.id, price: 2500 });
  t.fs.putP("users/u2", { uid: "id2", name: "u2", coins: 100 });
  t.state.now += H + MIN;
  await t.act(1, { action: "martStatus" });
  assert.ok(t.ownedOf(1).includes("body:titan~u")); assert.equal(t.coinsOf(1), 18000, "次に高い人が、自分の入札額を払う");
  const b = await t.act(0, { action: "martList", kind: "part", slot: "body", part: "pro", price: 500, auction: true, hours: 1 });
  await t.act(1, { action: "martBid", id: b.id, price: 500 });
  t.fs.putP("users/u1", { uid: "id1", name: "u1", coins: 10 });
  const c = await t.act(0, { action: "martList", kind: "part", slot: "edge", part: "metal", price: 500, auction: true, hours: 1 });
  t.state.now += H + MIN;
  await t.act(2, { action: "martStatus" });
  assert.ok(t.ownedOf(0).includes("body:pro"), "誰も払えなかった：戻る");
  assert.ok(t.ownedOf(0).includes("edge:metal"), "入札なし：戻る");
  assert.equal(idxOf(t).L.length, 0);
  assert.ok(b.ok && c.ok);
});

test("落札：ゆうスロの席に着いている人は、少し待つ（1時間まで）。それをすぎたら次の人へ", async () => {
  const t = setup({ owned: ["body:titan"] });
  const a = await aucList(t, 0, { hours: 1 });
  await t.act(1, { action: "martBid", id: a.id, price: 2500 });
  await t.act(2, { action: "martBid", id: a.id, price: 3000 });
  t.state.now += H + MIN;
  t.fs.putP("yuslotSeats/m1", { uid: "id2", graceUntilMs: t.state.now + 3 * H });
  await t.act(0, { action: "martStatus" });
  assert.equal(idxOf(t).L.length, 1, "まだ精算しない");
  t.state.now += 61 * MIN;
  await t.act(0, { action: "martStatus" });
  assert.equal(idxOf(t).L.length, 0); assert.ok(t.ownedOf(1).includes("body:titan~u"));
});

test("人のオークションへの NPC の入札：小さく1〜2回、相場の1.1倍・4,000コインまで。NPC が落札したら、出品者に払われる", async () => {
  const t = setup({ owned: ALL_OWNED });
  const ids = [];
  for (const o of ALL_OWNED.slice(0, MART.maxOpen)) { const [slot, part] = o.split(":"); const r = await t.act(0, { action: "martList", kind: "part", slot, part, price: 10, auction: true, hours: 24 }); ids.push([r.id, slot, part]); }
  t.state.now += 25 * H;
  const before = t.coinsOf(0), totalBefore = t.total();
  await t.act(1, { action: "martStatus" });
  const m = await t.act(0, { action: "martMine" });
  const sold = m.done.filter((d) => d.bu === "" && d.bn);
  assert.ok(sold.length >= 5 && sold.length <= ids.length, `約8割に NPC が入札（${sold.length}/10）`);
  for (const d of sold) {
    const [slot, id] = d.i.split(":"), ref = Math.round(KESHI_PARTS[slot].find((p) => p.id === id).price * 0.75);
    assert.ok(d.q <= MART.npcMaxPay && d.q <= Math.round(ref * 1.1 / 10) * 10, `${d.i} ${d.q} / 相場 ${ref}`);
  }
  assert.equal(t.coinsOf(0), before + sold.reduce((a, d) => a + d.q - d.fee, 0));
  assert.equal(m.listings.length, 0, "落札されなかったものも、戻っている");
  assert.equal(t.ownedOf(0).length + sold.length, ALL_OWNED.length);
  assert.ok(t.total() > totalBefore, "NPC が払うぶん、コインが増える（相場の範囲）");
});

test("NPC どうしのオークション：いつも4件。NPC がどんどん釣り上げる（上限なし）。人は、最後の NPC の入札のあとに高く入れれば落札できる", async () => {
  const t = setup();
  const st = await t.act(1, { action: "martStatus" });
  const na = st.listings.filter((x) => x.au && x.npc);
  assert.equal(na.length, MART.auc.npcSlots);
  assert.ok(na.every((x) => x.price >= 10 && x.id.startsWith("na")));
  const x = na[0], start = x.au.s;
  t.state.now = x.e - 1000;
  const late = (await t.act(1, { action: "martStatus" })).listings.find((v) => v.id === x.id);
  assert.ok(late.au.cur >= start && late.au.nb >= 3, "NPC の入札が重なる");
  assert.ok(late.au.cur >= start * 1.12 ** 2, `釣り上げ ${start} → ${late.au.cur}`);
  const earlyId = x.id;
  const bid = await t.act(1, { action: "martBid", id: earlyId, price: late.au.min });
  assert.equal(bid.ok, true);
  assert.equal((await t.act(1, { action: "martMine" })).myBids[0].top, true);
  t.state.now = x.e + MIN;
  await t.act(2, { action: "martStatus" });
  assert.equal(t.coinsOf(1), 20000 - late.au.min);
  assert.ok(t.ownedOf(1).some((o) => o.endsWith("~u")), "中古パーツが届く");
  assert.equal(Object.keys(idxOf(t).NA).length, 0, "精算したら、入札の記録は消える");
  assert.equal((await t.act(1, { action: "martBid", id: earlyId, price: 999999 })).error, "gone", "終わったオークションには入札できない");
});

test("NPC どうしのオークション：早めに入れても、あとから NPC に追い越される（落札できない。コインも引かれない）", async () => {
  const t = setup();
  const x = (await t.act(1, { action: "martStatus" })).listings.find((v) => v.au && v.npc);
  assert.equal((await t.act(1, { action: "martBid", id: x.id, price: x.au.min })).ok, true);
  t.state.now = x.e + MIN;
  await t.act(2, { action: "martStatus" });
  assert.equal(t.coinsOf(1), 20000); assert.equal(t.ownedOf(1).length, 0);
  assert.equal(Object.keys(idxOf(t).NA).length, 0);
});

/* ---------- NPC との値下げ交渉 ---------- */
const refOf = (x) => Math.round(KESHI_PARTS[x.slot].find((p) => p.id === x.part.replace("~u", "")).price * 0.75);
const npcFirst = async (t, i = 1) => (await t.act(i, { action: "martStatus" })).listings.filter((x) => x.npc && !x.au).sort((a, b) => b.price - refOf(b) - (a.price - refOf(a)))[0];   // いちばん値下げの余地がある出品

test("NPC との値下げ交渉：下限以上なら納得して、出品の値段がその値段に変わる（みんなの画面でも）。下限に近ければ「この値段なら」と返す。相場より安くはならない", async () => {
  const t = setup();
  const x = await npcFirst(t), ref = refOf(x), floor = martNpcFloor(x);
  assert.ok(x.price > ref + 20 && floor >= ref && floor <= x.price, `相場 ${ref} ≦ 下限 ${floor} ≦ 出品 ${x.price}`);
  assert.equal((await t.act(1, { action: "martNegotiate", id: x.id, price: x.price })).error, "bad_price", "いまの値段以上は交渉にならない");
  let r = await t.act(1, { action: "martNegotiate", id: x.id, price: 10 });
  assert.equal(r.ok, true); assert.equal(r.accepted, false); assert.equal(r.counter, null, "安すぎると断られる");
  assert.equal(r.near, false);
  r = await t.act(2, { action: "martNegotiate", id: x.id, price: Math.floor(floor * 0.75) });
  assert.equal(r.accepted, false); assert.equal(r.near, true, "あと少しなら、もう少し上なら…と返す（金額は教えない）"); assert.equal(r.counter, null);
  r = await t.act(1, { action: "martNegotiate", id: x.id, price: Math.floor(floor * 0.9) });
  assert.equal(r.accepted, false); assert.equal(r.counter, floor, "もう少しで下限：この値段なら、と返す");
  r = await t.act(1, { action: "martNegotiate", id: x.id, price: floor });
  assert.equal(r.accepted, true); assert.equal(r.price, floor); assert.ok(r.price >= ref && r.price < x.price);
  const after = (await t.act(2, { action: "martStatus" })).listings.find((v) => v.id === x.id);
  assert.equal(after.price, floor, "ほかの人の画面でも、値段が変わる"); assert.equal(after.deal.from, x.price); assert.equal(after.deal.until, t.state.now + 10 * MIN);
  assert.equal((await t.act(1, { action: "martStatus" })).listings.find((v) => v.id === x.id).dealMine, true);
  assert.equal((await t.act(2, { action: "martStatus" })).listings.find((v) => v.id === x.id).dealMine, false);
});

test("交渉が成立したお客さんは10分のあいだ優先で買える（その値段で）。そのあとは、だれでもその値段で買える", async () => {
  const t = setup();
  const x = await npcFirst(t), floor = martNpcFloor(x);
  const r = await t.act(1, { action: "martNegotiate", id: x.id, price: floor });
  assert.equal(r.accepted, true);
  assert.equal((await t.act(2, { action: "martBuy", id: x.id })).error, "reserved");
  assert.equal((await t.act(2, { action: "martNegotiate", id: x.id, price: 1 })).error, "reserved");
  const before = t.coinsOf(1);
  const b = await t.act(1, { action: "martBuy", id: x.id });
  assert.equal(b.ok, true); assert.equal(b.price, floor);
  assert.equal(t.coinsOf(1), before - floor);
  const t2 = setup();
  const y = await npcFirst(t2), f2 = martNpcFloor(y);
  assert.equal((await t2.act(1, { action: "martNegotiate", id: y.id, price: f2 })).accepted, true);
  t2.state.now += 11 * MIN;
  const c = await t2.act(2, { action: "martBuy", id: y.id });
  assert.equal(c.ok, true); assert.equal(c.price, f2, "10分たったら、だれでもその値段で");
});

test("交渉は1つの出品に3回まで／コインが足りない値段では交渉できない／出品が入れ替わったら交渉の記録も消える", async () => {
  const t = setup({ owned: ["body:titan"] });
  const x = await npcFirst(t);
  for (let i = 0; i < 3; i++) assert.equal((await t.act(1, { action: "martNegotiate", id: x.id, price: 1 })).ok, true);
  assert.equal((await t.act(1, { action: "martNegotiate", id: x.id, price: 1 })).error, "no_more");
  assert.equal((await t.act(2, { action: "martNegotiate", id: x.id, price: 1 })).ok, true, "ほかの人は別に3回");
  t.fs.putP("users/u0", { uid: "id0", name: "u0", coins: 5 });
  assert.equal((await t.act(0, { action: "martNegotiate", id: x.id, price: x.price - 10 })).error, "insufficient_coins");
  assert.equal((await t.act(1, { action: "martNegotiate", id: "x123", price: 5 })).error, "bad_request");
  t.state.now += 13 * 3600000;
  await t.act(1, { action: "martStatus" });
  await t.act(0, { action: "martList", kind: "part", slot: "body", part: "titan", price: 9999 });   // 書き込み（古い記録の掃除）
  assert.deepEqual(Object.keys(idxOf(t).ND || {}), [], "入れ替わったら、記録は消える");
});

test("NPC から買って NPC に売っても増えない：交渉で下げられる最安値でも、同じものを NPC に売った額（手数料後の最高）より高い", async () => {
  const t = setup();
  for (const x of (await t.act(1, { action: "martStatus" })).listings.filter((v) => v.npc && !v.au)) {
    const ref = refOf(x), lowest = martNpcFloor(x), npcPays = Math.floor(ref * MART.npcBuyMax);
    assert.ok(lowest >= ref - 5, `${x.part}: 下限 ${lowest} ≧ 相場 ${ref}`);
    assert.ok(npcPays - Math.floor(npcPays / 10) < lowest, `${x.part}: NPC への売値（手数料後の最高 ${npcPays - Math.floor(npcPays / 10)}）より高い`);
  }
});

/* ---------- 前日の抽選で NPC が取った確変枠の販売 ---------- */
import { kakuTimes } from "../worker.js";
const knList = async (t, i = 1) => (await t.act(i, { action: "martStatus" })).listings.filter((x) => x.id.startsWith("kn:"));

test("前日の抽選のあと・発表の前：NPC が取った30分枠が、ゆうマートで売られる。最初は高く（相場の2.6〜3.4倍）、発表に向けて、なめらかに安くなる", async () => {
  const t = setupKaku();
  const T = kakuTimes(DAY), ref = 1500;   // 10/26（月）の30分枠の相場
  t.state.now = T.preClose + 60000;
  let l = await knList(t);
  assert.deepEqual(l.map((x) => x.id), [`kn:${DAY}:2`], "NPC の枠だけ（人の枠・空き枠・当日分は出ない）");
  assert.equal(l[0].k, "kaku"); assert.equal(l[0].npc, true); assert.equal(l[0].e, T.resultAt);
  assert.ok(l[0].price >= ref * 2.55 && l[0].price <= ref * 3.45, `最初は高い ${l[0].price}`);
  let prev = l[0].price;
  for (const frac of [0.2, 0.4, 0.6, 0.8, 0.97]) {
    t.state.now = T.preClose + frac * (T.resultAt - T.preClose); resetYuslotCacheForTest(); resetKakuCacheForTest();
    l = await knList(t); assert.ok(l[0].price < prev, `どんどん下がる ${prev} → ${l[0].price}`); prev = l[0].price;
  }
  assert.ok(prev >= ref * 0.4 - 5 && prev < ref * 0.8, `最後は相場の0.4倍に近づく ${prev}`);
  t.state.now = T.resultAt; resetKakuCacheForTest();
  assert.deepEqual(await knList(t), [], "発表のあとは売らない");
  t.state.now = T.preClose - 60000; resetKakuCacheForTest();
  assert.deepEqual(await knList(t), [], "抽選の前は売らない");
});

test("前日の抽選の NPC 枠を買う：その時の値段を払い、枠の持ち主が買った人になる。買った枠はまた売れない。コインは世の中から減るだけ", async () => {
  const t = setupKaku();
  const T = kakuTimes(DAY);
  t.state.now = T.preClose + 5 * 3600000; resetKakuCacheForTest();
  const x = (await knList(t))[0], before = t.total();
  const r = await t.act(1, { action: "martBuy", id: x.id });
  assert.equal(r.ok, true); assert.equal(r.price, x.price); assert.equal(r.fee, Math.floor(x.price / 10));
  const s = slotsOf(t).find((v) => v.i === 2);
  assert.deepEqual([s.uid, s.name, s.npc, s.bt], ["id1", "u1", false, 1]);
  assert.equal(t.coinsOf(1), 20000 - x.price); assert.equal(t.total(), before - x.price);
  assert.equal((await t.act(2, { action: "martBuy", id: x.id })).error, "gone");
  assert.deepEqual(await knList(t), []);
  assert.equal((await t.act(1, { action: "martList", kind: "kaku", day: DAY, si: 2, price: 5000 })).error, "not_owned", "買った枠はまた売れない");
  assert.equal((await t.act(1, { action: "martNegotiate", id: x.id, price: 10 })).error, "bad_request");
});

test("前日の抽選の NPC 枠：1日3枠まで・コイン不足・席に着いている人は買えない。抽選が終わっていない・当日分の枠は売らない", async () => {
  const t = setupKaku();
  const T = kakuTimes(DAY); t.state.now = T.preClose + 3600000;
  const slots = slotsOf(t).map((x) => (x.i === 3 ? { ...x, npc: true, name: "みかん" } : x.i === 9 ? { ...x, kind: "lot", npc: true, name: "ももん" } : x.i >= 4 && x.i <= 6 ? { ...x, uid: "id1", name: "u1" } : x));
  t.fs.putP(`yuslotKaku/${DAY}`, { day: DAY, machine: "yubasic", mode: "full", slots, app1: [], app2: [], draw1Done: true, draw2Done: false });
  resetKakuCacheForTest();
  assert.deepEqual((await knList(t)).map((x) => x.id).sort(), [`kn:${DAY}:2`, `kn:${DAY}:3`], "当日分の抽選枠（lot）は売らない");
  assert.equal((await t.act(1, { action: "martBuy", id: `kn:${DAY}:2` })).error, "slot_limit");
  t.fs.putP("users/u2", { uid: "id2", name: "u2", coins: 50 });
  assert.equal((await t.act(2, { action: "martBuy", id: `kn:${DAY}:2` })).error, "insufficient_coins");
  t.fs.putP("users/u0", { uid: "id0", name: "u0", coins: 20000 });
  t.fs.putP("yuslotSeats/m1", { uid: "id0", graceUntilMs: t.state.now + 3600000 });
  assert.equal((await t.act(0, { action: "martBuy", id: `kn:${DAY}:2` })).error, "seated");
  const t2 = setupKaku();
  t2.state.now = T.preClose + 3600000;
  t2.fs.putP(`yuslotKaku/${DAY}`, { day: DAY, machine: "yubasic", mode: "full", slots: slotsOf(t2), app1: [], app2: [], draw1Done: false, draw2Done: false });
  resetKakuCacheForTest();
  assert.deepEqual(await knList(t2), [], "抽選がまだなら売らない");
});
