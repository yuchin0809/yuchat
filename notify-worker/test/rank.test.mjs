/* 🏅 ゆうスロの会員ランク（worker.js の rank*）のテスト
   実行：node --test "notify-worker/test/*.test.mjs" */
import test from "node:test";
import assert from "node:assert/strict";
import { RANK_LEVELS, rankLevelFor, rankWeekStart, rankEnsureCurrent, runRankTick, resetRankCacheForTest, resetYuslotCacheForTest, resetKakuCacheForTest, handleYuslotAction, kakuPickWinners } from "../worker.js";

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
const rngOf = (seed) => { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; };

function setup({ now = JST(2026, 10, 21, 12), wagered = {}, published = true } = {}) {
  resetRankCacheForTest(); resetYuslotCacheForTest(); resetKakuCacheForTest();
  const base = { "worldConfig/yuslot": { yuslotPublished: published } };
  for (const [n, w] of Object.entries({ alice: 0, bob: 0, carol: 0, ...wagered })) base[`users/${n}`] = { uid: `id_${n}`, name: n, coins: 1000, ...(w ? { slotWagered: w, slotSpins: w } : {}) };
  const fs = fakeFs(base);
  const state = { now };
  const deps = { firestore: fs, adminUid: "adminUid", now: () => state.now, random: rngOf(5), slotSecret: "s", sendFcm: async () => ({ ok: true }) };
  const setWagered = (n, w) => fs.put(`users/${n}`, encF({ uid: `id_${n}`, name: n, coins: 1000, slotWagered: w, slotSpins: w }));
  return { fs, deps, state, setWagered };
}

test("週の始まり：月曜 7:00（日本時間）。月曜 6:59 までは前の週", () => {
  const mon = JST(2026, 10, 26, 7);
  assert.equal(rankWeekStart(mon), mon);
  assert.equal(rankWeekStart(mon + 3 * 86400000 + 5 * 3600000), mon, "木曜");
  assert.equal(rankWeekStart(mon - 1), JST(2026, 10, 19, 7), "月曜 6:59:59 は前の週");
  assert.equal(rankWeekStart(JST(2026, 10, 25, 23, 59)), JST(2026, 10, 19, 7), "日曜の夜");
  assert.equal(rankWeekStart(JST(2026, 10, 19, 7)), JST(2026, 10, 19, 7));
});

test("ランクの条件：500／2,000／6,000／15,000／35,000 コイン以上（ちょうどでも上がる）", () => {
  assert.deepEqual(RANK_LEVELS.map((r) => r.name), ["ゆうビギナー", "ゆうブロンズ", "ゆうシルバー", "ゆうゴールド", "ゆうプラチナ", "ゆうダイヤモンド"]);
  const cases = [[0, 0], [499, 0], [500, 1], [1999, 1], [2000, 2], [5999, 2], [6000, 3], [14999, 3], [15000, 4], [34999, 4], [35000, 5], [9999999, 5]];
  for (const [w, lv] of cases) assert.equal(rankLevelFor(w), lv, `${w} → ${lv}`);
  assert.equal(RANK_LEVELS[5].mult, 3, "最高ランクは約3倍");
});

test("最初の週：ドキュメントを作るだけ（全員ランクなし）。同じ週の間は、何度呼んでも読み取りだけで書き込まない", async () => {
  const { fs, deps } = setup();
  const a = await rankEnsureCurrent(deps);
  assert.equal(a.data.weekStart, JST(2026, 10, 19, 7)); assert.deepEqual(a.data.ranks, {});
  const commits = fs.counts.commit, queries = fs.counts.query;
  await rankEnsureCurrent(deps); await rankEnsureCurrent(deps);
  assert.equal(fs.counts.commit, commits); assert.equal(fs.counts.query, queries, "users を読み直さない");
});

test("月曜 7:00 を過ぎると、先週の使ったコインでランクが決まる。次の週は「その週に使った分」だけで決まる（下がることもある）", async () => {
  const { fs, deps, state, setWagered } = setup({ wagered: { alice: 36000, bob: 2500, carol: 300 } });
  await rankEnsureCurrent(deps);                                  // 最初の週
  state.now = JST(2026, 10, 26, 7, 1);
  const w1 = await rankEnsureCurrent(deps);
  assert.equal(w1.data.weekStart, JST(2026, 10, 26, 7));
  assert.deepEqual(w1.data.ranks, { id_alice: 5, id_bob: 2 }, "alice=ダイヤ・bob=シルバー・carol=なし");
  assert.deepEqual(w1.data.lastWeek, { id_alice: 36000, id_bob: 2500, id_carol: 300 });
  assert.deepEqual(w1.data.base, { id_alice: 36000, id_bob: 2500, id_carol: 300 }, "いまの累計が次の週の始まり");
  // 1週間（alice は遊ばない・bob は +7000・carol は +600）
  setWagered("bob", 9500); setWagered("carol", 900);
  state.now = JST(2026, 11, 2, 7, 0);
  const w2 = await rankEnsureCurrent(deps);
  assert.deepEqual(w2.data.ranks, { id_bob: 3, id_carol: 1 }, "alice は遊ばなかったのでランクなし（下がる）・bob=ゴールド・carol=ブロンズ");
  assert.deepEqual(w2.data.lastWeek, { id_bob: 7000, id_carol: 600 });
  const commits = fs.counts.commit;
  await rankEnsureCurrent(deps);
  assert.equal(fs.counts.commit, commits, "同じ週にもう一度呼んでも更新しない");
});

test("週の集計は1回の commit：同時に呼んでも二重に集計されない", async () => {
  const { deps, state, fs } = setup({ wagered: { alice: 700 } });
  await rankEnsureCurrent(deps);
  state.now = JST(2026, 10, 26, 7, 2);
  const rs = await Promise.all([1, 2, 3, 4].map(() => rankEnsureCurrent(deps)));
  assert.ok(rs.every((r) => r.data.weekStart === JST(2026, 10, 26, 7)));
  assert.deepEqual(fs.plain("yuslotRank/current").ranks, { id_alice: 1 });
  assert.deepEqual(fs.plain("yuslotRank/current").base, { id_alice: 700 });
});

test("cron：月曜 7:00〜7:09 だけ動き、同じ週は1回だけ。それ以外の時刻は何も読まない", async () => {
  const { deps, fs } = setup({ wagered: { alice: 3000 } });
  await rankEnsureCurrent(deps);
  const reads = () => fs.counts.get + fs.counts.getRaw + fs.counts.query;
  const r0 = reads();
  assert.equal((await runRankTick({}, JST(2026, 10, 26, 6, 59), deps)).skipped, "outside");
  assert.equal((await runRankTick({}, JST(2026, 10, 26, 7, 10), deps)).skipped, "outside");
  assert.equal((await runRankTick({}, JST(2026, 10, 27, 7, 0), deps)).skipped, "outside", "火曜");
  assert.equal(reads(), r0, "時刻が違えば何も読まない");
  const t = JST(2026, 10, 26, 7, 0);
  deps.now = () => t;
  const r = await runRankTick({}, t, deps);
  assert.equal(r.ranked, 1);
  assert.equal(fs.plain("yuslotRank/current").ranks.id_alice, 2);
  assert.equal((await runRankTick({}, t + 60000, deps)).skipped, "done");
});

test("画面用の状態：自分のランク・今週の進み・次のランク・条件の一覧。抽選の倍率は返さない。非公開中は断る", async () => {
  const { deps, state, setWagered, fs } = setup({ wagered: { alice: 2500 } });
  const act = (who, body = {}) => handleYuslotAction(deps, `id_${who}`, { action: "rankStatus", username: who, ...body });
  let r = await act("alice");
  assert.equal(r.ok, true); assert.equal(r.level, 0); assert.equal(r.thisWeek, 2500, "最初の週は記録の開始からの累計");
  assert.equal(r.projectedName, "ゆうシルバー"); assert.deepEqual(r.next, { name: "ゆうブロンズ", min: 500 });
  assert.deepEqual(r.levels.map((l) => l.min), [0, 500, 2000, 6000, 15000, 35000]);
  assert.ok(!JSON.stringify(r).includes("mult"), "倍率は返さない");
  state.now = JST(2026, 10, 26, 7, 5);
  r = await act("alice");
  assert.equal(r.level, 2); assert.equal(r.name, "ゆうシルバー"); assert.equal(r.thisWeek, 0); assert.equal(r.lastWeek, 2500);
  setWagered("alice", 2500 + 800);
  state.now += 6 * 60000;                                                  // 5分のメモリは過ぎたが、同じ週
  r = await act("alice");
  assert.equal(r.thisWeek, 800); assert.equal(r.projectedName, "ゆうブロンズ"); assert.deepEqual(r.next, { name: "ゆうゴールド", min: 6000 });
  assert.equal(r.nextRollMs, JST(2026, 11, 2, 7));
  const un = setup({ published: false });
  assert.equal((await handleYuslotAction(un.deps, "id_alice", { action: "rankStatus", username: "alice" })).error, "not_published");
});

test("表示のための読み取りは5分ためる（毎回 Firestore を読まない）", async () => {
  const { deps, fs } = setup();
  const act = () => handleYuslotAction(deps, "id_alice", { action: "rankStatus", username: "alice" });
  await act();
  const gets = fs.counts.getRaw;
  for (let i = 0; i < 5; i++) await act();
  // 1回の表示で読むのは「自分の users」1件だけ（ランクのドキュメントはメモリから）
  assert.ok(fs.counts.getRaw - gets <= 5 * 2, `getRaw ${fs.counts.getRaw - gets}`);
});

test("抽選：ランクが高い人ほど当たりやすい（最高ランクで約3倍）。ランクがなければ全員平等。全体の当選割合は変わらない", () => {
  const rng = rngOf(99);
  const names = ["lv0", "lv1", "lv2", "lv3", "lv4", "lv5"];
  const apps = names.map((n) => ({ uid: n, name: n }));
  const rankOf = new Map(names.map((n, i) => [n, i]));
  const won = Object.fromEntries(names.map((n) => [n, 0])); let real = 0; const N = 12000;
  for (let t = 0; t < N; t++) {
    const w = kakuPickWinners({ applicants: apps, poolTarget: 65, count: 13, random: rng, dayId: "2026-10-21", rankOf });
    w.filter((x) => !x.npc).forEach((x) => { won[x.uid]++; real++; });
  }
  for (let i = 1; i < names.length; i++) assert.ok(won[names[i]] > won[names[i - 1]], `ランクが高いほど当たりやすい ${names.map((n) => won[n]).join(",")}`);
  assert.ok(won.lv5 / won.lv0 > 2.4 && won.lv5 / won.lv0 < 3.6, `最高ランクは約3倍 ${(won.lv5 / won.lv0).toFixed(2)}`);
  let flat = 0; for (let t = 0; t < N; t++) flat += kakuPickWinners({ applicants: apps, poolTarget: 65, count: 13, random: rng, dayId: "2026-10-21" }).filter((x) => !x.npc).length;
  assert.ok(Math.abs(real - flat) / flat < 0.08, `実在の人が当たる総数は変わらない（${real} / ${flat}）`);
  // ランクがなければ全員同じ重み
  const same = [{ uid: "a", name: "a" }, { uid: "b", name: "b" }];
  const c = { a: 0, b: 0 };
  for (let t = 0; t < 30000; t++) kakuPickWinners({ applicants: same, poolTarget: 2, count: 1, random: rng, dayId: "2026-10-21" }).forEach((x) => { c[x.uid]++; });
  assert.ok(Math.abs(c.a / c.b - 1) < 0.08, `ランクがなければ平等 ${c.a} / ${c.b}`);
});
