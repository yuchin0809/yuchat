/* 🧽 消しバト（worker.js の keshi*）のテスト
   実行：node --test "notify-worker/test/*.test.mjs" */
import test from "node:test";
import assert from "node:assert/strict";
import { KESHI_PARTS, KESHI_SLOTS, KESHI_DEFAULT_EQ, keshiStats, resetYuslotCacheForTest, handleYuslotAction } from "../worker.js";

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

const JST = (y, mo, d, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h - 9, mi, 0);
const ADMIN = "adminUid";

function setup({ keshi = true, coins = 5000, now = JST(2026, 10, 23, 12) } = {}) {
  resetYuslotCacheForTest();
  const base = { "worldConfig/yuslot": { yuslotPublished: true, keshiPublished: keshi } };
  for (let i = 0; i < 3; i++) base[`users/u${i}`] = { uid: `id${i}`, name: `u${i}`, coins };
  const fs = fakeFs(base);
  const state = { now };
  const deps = { firestore: fs, adminUid: ADMIN, now: () => state.now, random: () => 0.5, slotSecret: "s", sendFcm: async () => ({ ok: true }) };
  const act = (i, body) => handleYuslotAction(deps, `id${i}`, { username: `u${i}`, ...body });
  return { fs, deps, state, act, coinsOf: (i) => fs.plain(`users/u${i}`).coins };
}

test("パーツの表：どの枠にも「無料の初期パーツ」があり、id は枠の中で重ならない。値段は0以上", () => {
  assert.deepEqual(KESHI_SLOTS, ["body", "edge", "sole", "weight"]);
  for (const slot of KESHI_SLOTS) {
    const ps = KESHI_PARTS[slot];
    assert.equal(new Set(ps.map((p) => p.id)).size, ps.length);
    assert.equal(ps.find((p) => p.id === KESHI_DEFAULT_EQ[slot]).price, 0, `${slot} の初期パーツは無料`);
    assert.equal(ps.filter((p) => p.price === 0).length, 1, "無料は初期パーツだけ");
    ps.forEach((p) => assert.ok(p.price >= 0 && Number.isInteger(p.price)));
    const prices = ps.map((p) => p.price); assert.deepEqual(prices, [...prices].sort((a, b) => a - b), "安い順に並ぶ");
  }
});

test("強さ：初期の消しゴムは、全部50・総合力50。足した点数は増えるほど効きが鈍くなり、減る分はそのまま", () => {
  assert.deepEqual(keshiStats(KESHI_DEFAULT_EQ), { m: 50, s: 50, b: 50, z: 50, rating: 50 });
  const sand = keshiStats({ ...KESHI_DEFAULT_EQ, body: "sand" });
  assert.deepEqual([sand.m, sand.s, sand.b], [54, 44, 52], "砂消し：重く・すべりにくい");
  const top = { body: "titan", edge: "crystal", sole: "air", weight: "gold" };
  const t = keshiStats(top);
  assert.ok(t.m > 50 && t.m < 50 + 14 + 12 - 6 + 32, "重さは足した合計（52）より小さく収まる");
  assert.ok(t.rating > 70 && t.rating < 100);
  let prev = 50;
  for (const w of ["none", "coin", "bolt", "lead", "gold"]) { const m = keshiStats({ ...KESHI_DEFAULT_EQ, weight: w }).m; assert.ok(m >= prev, "重いおもりほど重い"); prev = m; }
  const gold = keshiStats({ ...KESHI_DEFAULT_EQ, weight: "gold" }).m - 50, lead = keshiStats({ ...KESHI_DEFAULT_EQ, weight: "lead" }).m - 50;
  assert.ok(gold < 32 && lead < 24 && gold > lead, "鈍くなる");
});

test("公開：非公開のあいだは最上位管理者だけ。公開の切り替えは、ゆうスロ・ヨットの公開に触れない", async () => {
  const ctx = setup({ keshi: false });
  assert.equal((await ctx.act(1, { action: "keshiState" })).error, "not_published");
  assert.equal((await ctx.act(1, { action: "keshiBuy", slot: "body", part: "sand" })).error, "not_published");
  assert.equal((await ctx.act(1, { action: "keshiEquip", eq: {} })).error, "not_published");
  const cfg = await ctx.act(1, { action: "config" });
  assert.deepEqual([cfg.published, cfg.yachtPublished, cfg.keshiPublished], [true, false, false]);
  ctx.fs.put("users/admin", encF({ uid: ADMIN, name: "admin", coins: 100 }));
  const as = (body) => handleYuslotAction(ctx.deps, ADMIN, { username: "admin", ...body });
  assert.equal((await as({ action: "keshiState" })).ok, true, "最上位管理者は使える");
  assert.equal((await ctx.act(1, { action: "setConfig", keshiPublished: true })).error, "not_top_admin");
  const set = await as({ action: "setConfig", keshiPublished: true });
  assert.deepEqual([set.published, set.yachtPublished, set.keshiPublished], [true, false, true]);
  assert.equal(ctx.fs.plain("worldConfig/yuslot").yuslotPublished, true);
  assert.equal((await ctx.act(1, { action: "keshiState" })).ok, true, "公開後は誰でも");
  const y = await as({ action: "setConfig", yachtPublished: true });
  assert.deepEqual([y.published, y.yachtPublished, y.keshiPublished], [true, true, true], "ヨットの切り替えで、消しバトの公開は変わらない");
  const off = await as({ action: "setConfig", keshiPublished: false });
  assert.deepEqual([off.yachtPublished, off.keshiPublished], [true, false]);
});

test("はじめて開く：初期の消しゴム（コインと表を返す）。何も保存しない", async () => {
  const ctx = setup();
  const st = await ctx.act(1, { action: "keshiState" });
  assert.equal(st.coins, 5000); assert.deepEqual(st.eq, KESHI_DEFAULT_EQ); assert.equal(st.color, 0);
  assert.deepEqual(st.stats, { m: 50, s: 50, b: 50, z: 50, rating: 50 });
  assert.deepEqual(st.have, { body: ["plain"], edge: ["paper"], sole: ["bare"], weight: ["none"] });
  assert.equal(st.table.parts.body.length, 5); assert.equal(st.table.colors.length, 8);
  assert.equal(ctx.fs.plain("yuslotKeshi/id1"), null);
});

test("パーツを買う：コインが引かれ、持ち物に入り、そのまま付く。強さも変わる。同じパーツは2回買えない", async () => {
  const ctx = setup({ coins: 1000 });
  const r = await ctx.act(1, { action: "keshiBuy", slot: "body", part: "pro" });
  assert.equal(r.ok, true); assert.equal(r.coins, 400); assert.equal(ctx.coinsOf(1), 400);
  assert.equal(r.eq.body, "pro"); assert.ok(r.have.body.includes("pro")); assert.deepEqual(r.bought, { slot: "body", part: "pro", price: 600 });
  assert.deepEqual([r.stats.m, r.stats.s, r.stats.b], [56, 56, 56]);
  assert.deepEqual(ctx.fs.plain("yuslotKeshi/id1").owned, ["body:pro"]);
  assert.equal((await ctx.act(1, { action: "keshiBuy", slot: "body", part: "pro" })).error, "already_owned");
  assert.equal(ctx.coinsOf(1), 400, "二重には引かれない");
  const st = await ctx.act(1, { action: "keshiState" });
  assert.equal(st.eq.body, "pro"); assert.equal(st.coins, 400);
  const r2 = await ctx.act(1, { action: "keshiBuy", slot: "weight", part: "coin" });
  assert.equal(r2.coins, 320); assert.deepEqual(ctx.fs.plain("yuslotKeshi/id1").owned, ["body:pro", "weight:coin"]);
  assert.equal(r2.eq.body, "pro"); assert.equal(r2.eq.weight, "coin", "ほかの枠はそのまま");
});

test("買えないとき：コイン不足・無料パーツ・存在しないパーツ・ゆうスロの席に着いているとき", async () => {
  const ctx = setup({ coins: 100 });
  assert.equal((await ctx.act(1, { action: "keshiBuy", slot: "body", part: "titan" })).error, "insufficient_coins");
  assert.equal(ctx.coinsOf(1), 100); assert.equal(ctx.fs.plain("yuslotKeshi/id1"), null);
  assert.equal((await ctx.act(1, { action: "keshiBuy", slot: "body", part: "plain" })).error, "already_owned", "無料のパーツは買う必要がない");
  assert.equal((await ctx.act(1, { action: "keshiBuy", slot: "body", part: "nope" })).error, "bad_request");
  assert.equal((await ctx.act(1, { action: "keshiBuy", slot: "hat", part: "plain" })).error, "bad_request");
  ctx.fs.put("yuslotSeats/yujackpot", encF({ uid: "id1", graceUntilMs: ctx.state.now + 60000 }));
  assert.equal((await ctx.act(1, { action: "keshiBuy", slot: "edge", part: "plastic" })).error, "seated");
  assert.equal(ctx.coinsOf(1), 100);
});

test("同時に買っても、コインが二重に引かれない（片方は「もう一度」）", async () => {
  const ctx = setup({ coins: 1000 });
  const rs = await Promise.all([ctx.act(1, { action: "keshiBuy", slot: "body", part: "sand" }), ctx.act(1, { action: "keshiBuy", slot: "sole", part: "wax" })]);
  const ok = rs.filter((r) => r.ok), busy = rs.filter((r) => r.error === "busy");
  assert.ok(ok.length >= 1 && ok.length + busy.length === 2);
  const spent = ok.reduce((a, r) => a + r.bought.price, 0);
  assert.equal(ctx.coinsOf(1), 1000 - spent);
  assert.equal(ctx.fs.plain("yuslotKeshi/id1").owned.length, ok.length);
});

test("まとめて買う：本体・ふち・そこなどを1回で買って付ける。コインは合計だけ1回引かれ、持ち物と装備が同時に変わる", async () => {
  const ctx = setup({ coins: 1000 });
  const r = await ctx.act(1, { action: "keshiBuyMany", items: [{ slot: "body", part: "sand" }, { slot: "edge", part: "band" }, { slot: "sole", part: "wax" }] });
  assert.equal(r.ok, true); assert.equal(r.spent, 150 + 200 + 250); assert.equal(r.coins, 400); assert.equal(ctx.coinsOf(1), 400);
  assert.deepEqual([r.eq.body, r.eq.edge, r.eq.sole, r.eq.weight], ["sand", "band", "wax", "none"]);
  assert.deepEqual(r.bought.map((b) => b.part).sort(), ["band", "sand", "wax"]);
  assert.deepEqual(ctx.fs.plain("yuslotKeshi/id1").owned.sort(), ["body:sand", "edge:band", "sole:wax"]);
  assert.deepEqual(r.stats, keshiStats(r.eq));
  assert.equal(ctx.fs.counts.commit, 1, "書き込みは1回");
});

test("まとめて買う：持っている・無料のパーツは買わずに付けるだけ。全部持っているときはコインが動かない", async () => {
  const ctx = setup({ coins: 1000 });
  await ctx.act(1, { action: "keshiBuy", slot: "body", part: "sand" });
  const before = ctx.coinsOf(1);
  const r = await ctx.act(1, { action: "keshiBuyMany", items: [{ slot: "body", part: "plain" }, { slot: "edge", part: "plastic" }] });
  assert.equal(r.spent, 100); assert.equal(ctx.coinsOf(1), before - 100); assert.deepEqual(r.bought.map((b) => b.part), ["plastic"]);
  assert.equal(r.eq.body, "plain", "無料の初期パーツには、買わずに戻せる");
  const r2 = await ctx.act(1, { action: "keshiBuyMany", items: [{ slot: "body", part: "sand" }, { slot: "edge", part: "plastic" }] });
  assert.equal(r2.ok, true); assert.equal(r2.spent, 0); assert.deepEqual(r2.bought, []); assert.equal(ctx.coinsOf(1), before - 100);
  assert.deepEqual([r2.eq.body, r2.eq.edge], ["sand", "plastic"]);
});

test("まとめて買う：合計がコインより多ければ、1個も買わない。形が悪い・同じ枠が重なる・存在しないパーツ・席に着いているときも断る", async () => {
  const ctx = setup({ coins: 500 });
  const r = await ctx.act(1, { action: "keshiBuyMany", items: [{ slot: "body", part: "sand" }, { slot: "edge", part: "band" }, { slot: "sole", part: "wax" }] });
  assert.equal(r.error, "insufficient_coins"); assert.equal(ctx.coinsOf(1), 500); assert.equal(ctx.fs.plain("yuslotKeshi/id1"), null, "1個も買っていない");
  for (const items of [undefined, [], "x", [{ slot: "body", part: "sand" }, { slot: "body", part: "pro" }], [{ slot: "body", part: "nope" }], [{ slot: "hat", part: "sand" }], [null], Array(5).fill({ slot: "body", part: "sand" })]) {
    assert.equal((await ctx.act(1, { action: "keshiBuyMany", items })).error, "bad_request", JSON.stringify(items));
  }
  ctx.fs.put("yuslotSeats/yujackpot", encF({ uid: "id1", graceUntilMs: ctx.state.now + 60000 }));
  assert.equal((await ctx.act(1, { action: "keshiBuyMany", items: [{ slot: "body", part: "sand" }] })).error, "seated");
  assert.equal(ctx.coinsOf(1), 500);
});

test("まとめて買う：非公開のあいだは最上位管理者だけ。同時に押しても、コインが二重に引かれない", async () => {
  const closed = setup({ keshi: false });
  assert.equal((await closed.act(1, { action: "keshiBuyMany", items: [{ slot: "body", part: "sand" }] })).error, "not_published");
  const ctx = setup({ coins: 1000 });
  const rs = await Promise.all([ctx.act(1, { action: "keshiBuyMany", items: [{ slot: "body", part: "sand" }, { slot: "sole", part: "wax" }] }), ctx.act(1, { action: "keshiBuyMany", items: [{ slot: "edge", part: "band" }] })]);
  const ok = rs.filter((r) => r.ok), busy = rs.filter((r) => r.error === "busy");
  assert.ok(ok.length >= 1 && ok.length + busy.length === 2);
  assert.equal(ctx.coinsOf(1), 1000 - ok.reduce((a, r) => a + r.spent, 0));
});

test("付け替え：持っているパーツと、無料の初期パーツだけ。色は8色から。ほかの人の消しゴムには触れない", async () => {
  const ctx = setup({ coins: 2000 });
  await ctx.act(1, { action: "keshiBuy", slot: "body", part: "sand" });
  await ctx.act(1, { action: "keshiBuy", slot: "sole", part: "tape" });
  const back = await ctx.act(1, { action: "keshiEquip", eq: { body: "plain" } });
  assert.equal(back.eq.body, "plain"); assert.equal(back.eq.sole, "tape", "指定しなかった枠はそのまま");
  const again = await ctx.act(1, { action: "keshiEquip", eq: { body: "sand", sole: "bare" }, color: 5 });
  assert.deepEqual([again.eq.body, again.eq.sole, again.color], ["sand", "bare", 5]);
  assert.equal((await ctx.act(1, { action: "keshiEquip", eq: { body: "titan" } })).error, "not_owned", "持っていないパーツは付けられない");
  assert.equal((await ctx.act(1, { action: "keshiEquip", eq: { edge: "metal" } })).error, "not_owned");
  assert.equal((await ctx.act(1, { action: "keshiEquip", eq: { body: "nope" } })).error, "not_owned");
  assert.equal((await ctx.act(1, { action: "keshiEquip", color: 8 })).error, "bad_request");
  assert.equal((await ctx.act(1, { action: "keshiEquip", color: -1 })).error, "bad_request");
  assert.equal(ctx.fs.plain("yuslotKeshi/id1").color, 5, "失敗した変更は保存されない");
  const other = await ctx.act(2, { action: "keshiState" });
  assert.deepEqual(other.eq, KESHI_DEFAULT_EQ); assert.equal(other.color, 0);
});

test("書類の中身が壊れていても、持っていないパーツは付いたことにならない", async () => {
  const ctx = setup();
  ctx.fs.put("yuslotKeshi/id1", encF({ owned: [], eq: { body: "titan", edge: "nope", sole: "wax", weight: "gold" }, color: 99 }));
  const st = await ctx.act(1, { action: "keshiState" });
  assert.deepEqual(st.eq, KESHI_DEFAULT_EQ); assert.equal(st.color, 0);
});

test("画面用の強さの計算（yukeshi-core.js）は、サーバーの計算と、全部の組み合わせで同じ", async () => {
  const { keshiStatsView } = await import("../../yukeshi-core.js");
  const table = { slots: KESHI_SLOTS, parts: KESHI_PARTS, base: 50 };
  const ids = (slot) => KESHI_PARTS[slot].map((p) => p.id);
  let n = 0;
  for (const body of ids("body")) for (const edge of ids("edge")) for (const sole of ids("sole")) for (const weight of ids("weight")) {
    const eq = { body, edge, sole, weight };
    assert.deepEqual(keshiStatsView(table, eq), keshiStats(eq), JSON.stringify(eq)); n++;
  }
  assert.equal(n, 625);
});

/* ===== リーグ戦（エントリーだけ） ===== */
import { keshiLeagueWeek } from "../worker.js";
const FRI_1510 = (d) => JST(2026, 10, d, 15, 10);

test("リーグの週：月曜 0:00〜金曜 15:10。第1回は 10/26（月）。金曜 15:10 を過ぎたら次の週。第1回より前は第1回の週", () => {
  const first = keshiLeagueWeek(JST(2026, 10, 22, 17));
  assert.equal(first.startMs, JST(2026, 10, 26, 0)); assert.equal(first.endMs, FRI_1510(30));
  assert.deepEqual(first.days, [26, 27, 28, 29, 30].map((d) => JST(2026, 10, d, 0)));
  assert.deepEqual(first.setsMs, [JST(2026, 10, 26, 10, 30), JST(2026, 10, 26, 12, 40), JST(2026, 10, 26, 15, 0)]);
  assert.equal(keshiLeagueWeek(JST(2026, 10, 25, 23, 59)).startMs, JST(2026, 10, 26, 0), "前の日曜でも、次は第1回");
  assert.equal(keshiLeagueWeek(JST(2026, 10, 28, 9)).startMs, JST(2026, 10, 26, 0), "週の途中は、その週");
  assert.equal(keshiLeagueWeek(FRI_1510(30) - 1).startMs, JST(2026, 10, 26, 0), "金曜 15:09 まで");
  assert.equal(keshiLeagueWeek(FRI_1510(30)).startMs, JST(2026, 11, 2, 0), "金曜 15:10 から次の週");
  assert.equal(keshiLeagueWeek(JST(2026, 11, 1, 12)).startMs, JST(2026, 11, 2, 0), "土日は次の週");
  assert.equal(keshiLeagueWeek(JST(2026, 11, 3, 12)).startMs, JST(2026, 11, 2, 0));
});

test("リーグ戦：エントリーしていない状態・まだ始まっていない・人数は0", async () => {
  const ctx = setup({ now: JST(2026, 10, 22, 17) });
  const st = await ctx.act(1, { action: "keshiLeagueState" });
  assert.deepEqual([st.ok, st.entered, st.count, st.started], [true, false, 0, false]);
  assert.deepEqual(st.prizes, [1000, 700, 400]); assert.deepEqual(st.sets, [[10, 30], [12, 40], [15, 0]]);
  assert.equal(st.week.startMs, JST(2026, 10, 26, 0));
  assert.equal(ctx.fs.plain("yuslotKeshi/_league"), null, "開くだけでは何も書かない");
  const closed = setup({ keshi: false });
  assert.equal((await closed.act(1, { action: "keshiLeagueState" })).error, "not_published");
  assert.equal((await closed.act(1, { action: "keshiLeagueEntry", enter: true })).error, "not_published");
});

test("リーグ戦：エントリー・やめる。同じ操作を繰り返しても人数は増えない。ほかの人の分は別", async () => {
  const ctx = setup({ now: JST(2026, 10, 22, 17) });
  const a = await ctx.act(1, { action: "keshiLeagueEntry", enter: true });
  assert.deepEqual([a.entered, a.count], [true, 1]);
  assert.equal(ctx.fs.plain("yuslotKeshi/id1").league, true);
  const again = await ctx.act(1, { action: "keshiLeagueEntry", enter: true });
  assert.deepEqual([again.entered, again.count], [true, 1], "二重にエントリーしても1人");
  const b = await ctx.act(2, { action: "keshiLeagueEntry", enter: true });
  assert.equal(b.count, 2);
  assert.equal((await ctx.act(1, { action: "keshiLeagueState" })).entered, true);
  assert.equal((await ctx.act(0, { action: "keshiLeagueState" })).entered, false);
  const out = await ctx.act(1, { action: "keshiLeagueEntry", enter: false });
  assert.deepEqual([out.entered, out.count], [false, 1]);
  assert.deepEqual([(await ctx.act(1, { action: "keshiLeagueEntry", enter: false })).count], [1], "やめるのを繰り返しても減りすぎない");
  assert.equal((await ctx.act(1, { action: "keshiLeagueEntry", enter: "yes" })).error, "bad_request");
});

test("リーグ戦：エントリーしても、買ったパーツ・付けているパーツ・色は変わらない（逆も同じ）", async () => {
  const ctx = setup({ coins: 3000, now: JST(2026, 10, 22, 17) });
  await ctx.act(1, { action: "keshiBuy", slot: "body", part: "pro" });
  await ctx.act(1, { action: "keshiEquip", color: 4 });
  await ctx.act(1, { action: "keshiLeagueEntry", enter: true });
  let d = ctx.fs.plain("yuslotKeshi/id1");
  assert.deepEqual([d.owned, d.eq.body, d.color, d.league], [["body:pro"], "pro", 4, true]);
  await ctx.act(1, { action: "keshiBuy", slot: "weight", part: "coin" });
  await ctx.act(1, { action: "keshiEquip", eq: { body: "plain" } });
  d = ctx.fs.plain("yuslotKeshi/id1");
  assert.equal(d.league, true, "買い物をしても、エントリーは残る");
  assert.deepEqual([d.owned, d.eq.body], [["body:pro", "weight:coin"], "plain"]);
});

test("リーグ戦：週の途中・金曜 15:10 以降でも、エントリーの状態と人数は返す", async () => {
  const ctx = setup({ now: JST(2026, 10, 28, 12) });
  await ctx.act(1, { action: "keshiLeagueEntry", enter: true });
  const mid = await ctx.act(1, { action: "keshiLeagueState" });
  assert.deepEqual([mid.started, mid.week.startMs, mid.entered], [true, JST(2026, 10, 26, 0), true]);
  ctx.state.now = FRI_1510(30) + 60000;
  const next = await ctx.act(1, { action: "keshiLeagueState" });
  assert.deepEqual([next.started, next.week.startMs, next.entered, next.count], [false, JST(2026, 11, 2, 0), true, 1], "次の週は、まだ始まっていない・エントリーは続く");
});
