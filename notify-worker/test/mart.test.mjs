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
  const npc = st.listings.filter((x) => x.npc);
  assert.equal(npc.length, MART.npcSlots);
  for (const x of npc) {
    const ref = Math.round(KESHI_PARTS[x.slot].find((p) => p.id === x.part.replace("~u", "")).price * 0.75);
    assert.ok(x.part.endsWith("~u"));
    assert.ok(x.price >= ref - 5 && x.price <= ref * 1.5 + 5, `${x.part} ${x.price} / 相場 ${ref}`);
    assert.ok(x.price <= MART.npcMaxPay);
  }
  const again = await t.act(2, { action: "martStatus" });
  assert.deepEqual(again.listings.filter((x) => x.npc).map((x) => x.id), npc.map((x) => x.id), "同じ時刻なら誰が見ても同じ");
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
  assert.equal(later.listings.filter((x) => x.npc).length, MART.npcSlots, "時間がたつと入れ替わる");
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
