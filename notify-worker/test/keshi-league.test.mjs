/* 🏆 消しバトのリーグ戦（worker.js の keshiLeague*）のテスト
   実行：node --test "notify-worker/test/*.test.mjs" */
import test from "node:test";
import assert from "node:assert/strict";
import { keshiStats, keshiBoutWinProb, keshiMatchSim, keshiLeagueSimulateSet, keshiLeagueAdvance, keshiLeagueWeek, runKeshiLeagueTick, resetKeshiLeagueTickForTest, resetYuslotCacheForTest, handleYuslotAction } from "../worker.js";

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
const MON = JST(2026, 10, 26, 0);
const rngOf = (seed) => { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; };

function setup({ users = 6, entered = users, now = JST(2026, 10, 26, 10, 30) } = {}) {
  resetYuslotCacheForTest(); resetKeshiLeagueTickForTest();
  const base = { "worldConfig/yuslot": { yuslotPublished: true, keshiPublished: true } };
  for (let i = 0; i < users; i++) {
    base[`users/u${i}`] = { uid: `id${i}`, name: `u${i}`, coins: 1000 };
    if (i < entered) base[`yuslotKeshi/id${i}`] = { league: true, n: `u${i}`, owned: [], eq: {}, color: 0 };
  }
  const fs = fakeFs(base);
  const state = { now };
  const deps = { firestore: fs, adminUid: ADMIN, now: () => state.now, random: () => 0.5, slotSecret: "s", sendFcm: async () => ({ ok: true }) };
  const act = (i, body) => handleYuslotAction(deps, `id${i}`, { username: `u${i}`, ...body });
  const wk = () => fs.plain("yuslotKeshiLeague/2026-10-26");
  const tick = (t) => { state.now = t; return runKeshiLeagueTick({}, t, deps); };
  return { fs, deps, state, act, wk, tick, coinsOf: (i) => fs.plain(`users/u${i}`).coins };
}
const players = (n, r = () => 50) => Array.from({ length: n }, (_, i) => ({ uid: `id${i}`, n: `u${i}`, r: r(i) }));
const matchesOf = (p) => Object.values(p).map((v) => v.m.filter((x) => x !== "-").length);

test("1本の勝つ確率と3本勝負：総合力が同じなら五分五分、差が大きいほど強い側が勝つ。でも毎回は勝てない", () => {
  assert.equal(keshiBoutWinProb(50, 50), 0.5);
  assert.ok(Math.abs(keshiBoutWinProb(62, 50) - 0.73) < 0.01 && Math.abs(keshiBoutWinProb(80, 50) - 0.924) < 0.01);
  assert.ok(keshiBoutWinProb(50, 62) < 0.3);
  const rnd = rngOf(11); let even = 0, strong = 0, mid = 0;
  const N = 6000;
  for (let i = 0; i < N; i++) { const a = keshiMatchSim(rnd, 50, 50); assert.ok((a.a === 2) !== (a.b === 2) && a.a <= 2 && a.b <= 2); if (a.a > a.b) even++; if (keshiMatchSim(rnd, 80, 50).a === 2) strong++; if (keshiMatchSim(rnd, 60, 50).a === 2) mid++; }
  assert.ok(Math.abs(even / N - 0.5) < 0.03, "同じ強さ");
  assert.ok(strong / N > 0.95 && strong / N < 0.995, `差30：${strong / N}`);
  assert.ok(mid / N > 0.6 && mid / N < 0.8, `差10：${mid / N}`);
});

test("1セット：全員が5試合。勝ち数の合計＝負け数の合計。同じ週・同じセットなら、何回やっても同じ結果", () => {
  const p1 = {}, p2 = {};
  keshiLeagueSimulateSet(p1, players(6), "2026-10-26", 0); keshiLeagueSimulateSet(p2, players(6), "2026-10-26", 0);
  assert.deepEqual(p1, p2, "同じ結果");
  assert.deepEqual(matchesOf(p1), [5, 5, 5, 5, 5, 5]);
  const vs = Object.values(p1);
  assert.equal(vs.reduce((a, v) => a + v.w, 0), vs.reduce((a, v) => a + v.l, 0)); assert.equal(vs.reduce((a, v) => a + v.w, 0), 15);
  vs.forEach((v) => { assert.equal(v.w + v.l, 5); assert.equal(v.d[0] + v.d[1], 5, "月の勝敗"); assert.equal(v.m.length, 5); v.m.forEach((m) => assert.match(m, /^[01]\|[0-2]-[0-2]\|u\d$/)); });
  const p3 = {}; keshiLeagueSimulateSet(p3, players(6), "2026-10-26", 1);
  assert.notDeepEqual(p3, p1, "別のセットは別の結果");
  assert.deepEqual(vs.map((v) => v.k), vs.map(() => [0, 0, 0, 0, 0]), "その日の最後のセットまでは順位を付けない");
});

test("1日の最後のセット（3番目）のあとに、その日の終わりの順位を残す", () => {
  const p = {};
  for (let k = 0; k < 3; k++) keshiLeagueSimulateSet(p, players(6), "2026-10-26", k);
  const ranks = Object.values(p).map((v) => v.k[0]).sort((a, b) => a - b);
  assert.deepEqual(ranks, [1, 2, 3, 4, 5, 6]);
  const best = Object.entries(p).find(([, v]) => v.k[0] === 1)[1];
  assert.ok(Object.values(p).every((v) => best.w >= v.w), "1位は勝ち数が最多");
  assert.equal(Object.values(p).reduce((a, v) => a + v.d[0] + v.d[1], 0), 6 * 15, "1日15試合");
});

test("人数が奇数：1回戦ごとに1人が休み（5人なら全員が1回ずつ休んで4試合）。1人だけ・2人だけでも動く", () => {
  const p = {}; keshiLeagueSimulateSet(p, players(5), "w", 0);
  assert.deepEqual(matchesOf(p), [4, 4, 4, 4, 4]); Object.values(p).forEach((v) => assert.equal(v.m.filter((x) => x === "-").length, 1));
  const one = {}; keshiLeagueSimulateSet(one, players(1), "w", 0);
  assert.deepEqual(one.id0.m, ["-", "-", "-", "-", "-"]); assert.equal(one.id0.w + one.id0.l, 0);
  const two = {}; keshiLeagueSimulateSet(two, players(2), "w", 0);
  assert.equal(two.id0.w + two.id0.l, 5); assert.equal(two.id0.w, two.id1.l);
  assert.ok(two.id0.m.every((m) => m.endsWith("|u1")), "2人だけなら、同じ相手");
  const none = {}; keshiLeagueSimulateSet(none, [], "w", 0); assert.deepEqual(none, {});
});

test("相手の決め方：その週の最初はランダム。そのあとは勝ち数が近い人（勝ち数が1つずつ違う8人なら、1回戦は隣どうし）", () => {
  const p = {}; players(8).forEach((x, i) => { p[x.uid] = { n: x.n, w: 7 - i, l: 0, r: 50, d: Array(10).fill(0), k: Array(5).fill(0), m: [] }; });   // id0=7勝 … id7=0勝
  keshiLeagueSimulateSet(p, players(8), "2026-10-26", 4);
  const first = (i) => p[`id${i}`].m[0].split("|")[2];
  [[0, 1], [2, 3], [4, 5], [6, 7]].forEach(([a, b]) => { assert.equal(first(a), `u${b}`); assert.equal(first(b), `u${a}`); });
  const fresh = {}; keshiLeagueSimulateSet(fresh, players(8), "2026-10-26", 0);
  const opps = new Set(Object.keys(fresh).map((u) => fresh[u].m[0].split("|")[2]));
  assert.equal(opps.size, 8, "全員が誰かと当たる");
});

test("同じセットの中では、できるだけ同じ相手を避ける（6人なら、5試合のうち、同じ相手は多くても1回だけ。8人なら、5試合すべて別の相手）", () => {
  for (const seed of ["a", "b", "c", "d", "e"]) {
    const p = {}; keshiLeagueSimulateSet(p, players(6), seed, 0);
    Object.values(p).forEach((v) => assert.ok(new Set(v.m.map((m) => m.split("|")[2])).size >= 4, seed));
    const q = {}; keshiLeagueSimulateSet(q, players(8), seed, 0);
    Object.values(q).forEach((v) => assert.equal(new Set(v.m.map((m) => m.split("|")[2])).size, 5, seed));
  }
});

test("強い消しゴム（総合力が高い人）は、週を通してよく勝つ", () => {
  const p = {};
  const rs = [80, 50, 50, 50, 50, 20];
  for (let k = 0; k < 15; k++) keshiLeagueSimulateSet(p, players(6, (i) => rs[i]), "2026-10-26", k);
  assert.ok(p.id0.w > p.id5.w + 20, `強い：${p.id0.w}勝 / 弱い：${p.id5.w}勝`);
  assert.ok(p.id0.l > 0 || p.id5.w > 0, "毎回は勝てない");
});

test("時刻どおりに進む：月曜 10:30 に最初のセット。同じ時刻に何回呼んでも1回だけ。12:40・15:00 で次のセット", async () => {
  const ctx = setup({ users: 6 });
  assert.equal(ctx.wk(), null);
  await ctx.tick(JST(2026, 10, 26, 10, 30));
  assert.equal(ctx.wk().setsDone, 1);
  const snap = JSON.stringify(ctx.wk().p);
  await ctx.tick(JST(2026, 10, 26, 10, 31)); await runKeshiLeagueTick({}, JST(2026, 10, 26, 10, 30), ctx.deps);
  assert.equal(ctx.wk().setsDone, 1); assert.equal(JSON.stringify(ctx.wk().p), snap, "二重に試合をしない");
  resetKeshiLeagueTickForTest();
  await keshiLeagueAdvance({ ...ctx.deps, now: () => JST(2026, 10, 26, 10, 45) }, JST(2026, 10, 26, 10, 45));
  assert.equal(ctx.wk().setsDone, 1, "決まったセット数より先には進まない");
  await ctx.tick(JST(2026, 10, 26, 12, 40)); assert.equal(ctx.wk().setsDone, 2);
  await ctx.tick(JST(2026, 10, 26, 15, 0)); assert.equal(ctx.wk().setsDone, 3);
  const k0 = Object.values(ctx.wk().p).map((v) => v.k[0]).sort((a, b) => a - b);
  assert.deepEqual(k0, [1, 2, 3, 4, 5, 6], "月曜の終わりの順位");
});

test("cron の時間帯：セットの時刻から30分と、金曜 15:10〜15:19 だけ。それ以外は何も読まない。第1回より前も動かない", async () => {
  const ctx = setup();
  const reads = () => ctx.fs.counts.get + ctx.fs.counts.getRaw + ctx.fs.counts.query;
  const r0 = reads();
  for (const t of [JST(2026, 10, 26, 10, 29), JST(2026, 10, 26, 11, 0), JST(2026, 10, 26, 12, 39), JST(2026, 10, 24, 10, 30), JST(2026, 10, 25, 12, 40), JST(2026, 10, 23, 10, 30), JST(2026, 10, 30, 15, 30), JST(2026, 10, 30, 15, 31)])
    assert.equal((await runKeshiLeagueTick({}, t, ctx.deps)).skipped, "outside", new Date(t).toISOString());
  assert.equal(reads(), r0, "時刻が違えば何も読まない");
  assert.equal(ctx.fs.counts.commit, 0);
});

test("cron が止まっていても、画面を開いた人が追いつかせる（月曜の夜に開けば、月曜の3セットが済んでいる）", async () => {
  const ctx = setup();
  ctx.state.now = JST(2026, 10, 26, 20, 0);
  const st = await ctx.act(0, { action: "keshiLeagueState" });
  assert.equal(ctx.wk().setsDone, 3);
  assert.equal(st.setsDone, 3); assert.equal(st.me.days[0].w + st.me.days[0].l, 15); assert.equal(st.me.recent.length, 5);
  ctx.state.now = JST(2026, 10, 28, 16, 0);
  await ctx.act(0, { action: "keshiLeagueState" });
  assert.equal(ctx.wk().setsDone, 9, "水曜の夜までに9セット");
  const again = JSON.stringify(ctx.wk().p);
  await ctx.act(1, { action: "keshiLeagueState" });
  assert.equal(JSON.stringify(ctx.wk().p), again, "何人が開いても、二重には進まない");
});

test("画面用のデータ：自分の順位・日ごとの勝敗と順位・最新セットの5試合・上位の表。uid は返さない", async () => {
  const ctx = setup();
  ctx.state.now = JST(2026, 10, 27, 11, 0);
  const st = await ctx.act(2, { action: "keshiLeagueState" });
  assert.equal(st.started, true); assert.equal(st.setsDone, 4); assert.equal(st.lastSetMs, JST(2026, 10, 27, 10, 30));
  assert.ok(st.me.rank >= 1 && st.me.rank <= 6); assert.equal(st.me.w + st.me.l, 4 * 5);
  assert.equal(st.me.days[1].w + st.me.days[1].l, 5, "火曜は1セット済み"); assert.ok(st.me.days[0].rank >= 1 && st.me.days[1].rank === 0);
  st.me.recent.forEach((m) => { assert.equal(typeof m.win, "boolean"); assert.match(m.score, /^[0-2]-[0-2]$/); assert.match(m.opp, /^u\d$/); });
  assert.equal(st.total, 6); assert.equal(st.top.length, 6); assert.equal(st.top.filter((t) => t.mine).length, 1);
  assert.deepEqual(st.top.map((t) => t.rank), [1, 2, 3, 4, 5, 6]);
  for (let i = 1; i < st.top.length; i++) assert.ok(st.top[i - 1].w >= st.top[i].w);
  assert.ok(!JSON.stringify(st).includes("id2") && !JSON.stringify(st).includes('"uid"'), "uid は返さない");
  const out = await setup({ users: 6, entered: 0 }).act(0, { action: "keshiLeagueState" });
  assert.equal(out.me, null); assert.equal(out.total, 0);
});

test("金曜 15:10 の結果発表：上位3名に 1000・700・400 コイン。二重には払わない。お知らせ・通知は出さない。次の週の画面に先週の結果が出る", async () => {
  const ctx = setup({ users: 6 });
  for (const t of [[26], [27], [28], [29], [30]].flatMap(([d]) => [[d, 10, 30], [d, 12, 40], [d, 15, 0]])) await ctx.tick(JST(2026, 10, ...t));
  assert.equal(ctx.wk().setsDone, 15);
  assert.notEqual(ctx.wk().settled, true, "15:00 のあとは、まだ発表しない");
  const before = [0, 1, 2, 3, 4, 5].map((i) => ctx.coinsOf(i));
  await ctx.tick(JST(2026, 10, 30, 15, 10));
  const wk = ctx.wk();
  assert.equal(wk.settled, true); assert.equal(wk.top.length, 3);
  assert.deepEqual(wk.top.map((t) => [t.rank, t.prize, t.paid]), [[1, 1500, true], [2, 1000, true], [3, 300, true]]);
  const gained = [0, 1, 2, 3, 4, 5].map((i) => ctx.coinsOf(i) - before[i]);
  wk.top.forEach((t) => assert.equal(gained[Number(t.uid.slice(2))], t.prize));
  assert.equal(gained.reduce((a, b) => a + b, 0), 2800, "4位以下には渡さない");
  const rows = Object.entries(wk.p).map(([uid, v]) => ({ uid, ...v })).sort((a, b) => b.w - a.w || a.l - b.l || b.r - a.r || (a.n < b.n ? -1 : 1));
  assert.deepEqual(wk.top.map((t) => t.uid), rows.slice(0, 3).map((r) => r.uid), "勝ち数の多い順");
  assert.ok(wk.top[0].w >= wk.top[1].w && wk.top[1].w >= wk.top[2].w);
  // 二重払いなし
  resetKeshiLeagueTickForTest();
  await ctx.tick(JST(2026, 10, 30, 15, 12)); await ctx.act(0, { action: "keshiLeagueState" });
  assert.equal([0, 1, 2, 3, 4, 5].map((i) => ctx.coinsOf(i) - before[i]).reduce((a, b) => a + b, 0), 2800);
  assert.ok([...ctx.fs.docs.keys()].every((p) => !p.startsWith("announcements/") && !p.startsWith("notificationLogs/")), "お知らせ・通知は出さない");
  // 次の週の画面に、先週の結果（自分が入賞したかも）
  const winnerIdx = Number(wk.top[0].uid.slice(2));
  ctx.state.now = JST(2026, 10, 31, 12);
  const st = await ctx.act(winnerIdx, { action: "keshiLeagueState" });
  assert.equal(st.week.startMs, JST(2026, 11, 2, 0)); assert.equal(st.week.no, 2); assert.equal(st.started, false); assert.equal(st.me, null, "新しい週は、まだ戦績なし");
  assert.equal(st.last.top.length, 3); assert.equal(st.last.top[0].mine, true); assert.equal(st.last.me.rank, 1);
});

test("金曜の cron が動かなくても、あとで画面を開いた人が、残りのセットも発表も追いつかせる", async () => {
  const ctx = setup({ users: 4 });
  ctx.state.now = JST(2026, 10, 31, 9, 0);
  await ctx.act(0, { action: "keshiLeagueState" });
  assert.equal(ctx.wk().setsDone, 15); assert.equal(ctx.wk().settled, true); assert.equal(ctx.wk().top.length, 3);
  assert.equal([0, 1, 2, 3].map((i) => ctx.coinsOf(i) - 1000).reduce((a, b) => a + b, 0), 2800);
});

test("エントリー：途中から入った人は、いまのセットから参加。やめた人は次のセットから抜ける（戦績は残る）", async () => {
  const ctx = setup({ users: 6, entered: 4 });
  await ctx.tick(JST(2026, 10, 26, 10, 30));
  assert.deepEqual(Object.keys(ctx.wk().p).sort(), ["id0", "id1", "id2", "id3"]);
  await ctx.act(4, { action: "keshiLeagueEntry", enter: true });
  await ctx.act(0, { action: "keshiLeagueEntry", enter: false });
  await ctx.tick(JST(2026, 10, 26, 12, 40));
  const p = ctx.wk().p;
  assert.deepEqual(Object.keys(p).sort(), ["id0", "id1", "id2", "id3", "id4"]);
  assert.equal(p.id4.w + p.id4.l > 0, true); assert.equal(p.id4.d[0] + p.id4.d[1], 5, "入ってからの1セットだけ");
  assert.equal(p.id0.w + p.id0.l, 5, "やめたあとの試合はしない（最初のセットの分だけ）");
  const out = await ctx.act(0, { action: "keshiLeagueState" });
  assert.equal(out.entered, false); assert.equal(out.me.w + out.me.l, 5, "やめても、これまでの戦績は見られる");
});

test("週の途中で最初のエントリーがあった場合：入った時刻より前のセットには参加しない。次のセットから戦う", async () => {
  const ctx = setup({ users: 3, entered: 0 });
  ctx.state.now = JST(2026, 10, 28, 13, 0);
  assert.equal((await ctx.act(0, { action: "keshiLeagueState" })).me, null); assert.equal(ctx.wk(), null, "誰もいなければ何も作らない");
  await ctx.act(0, { action: "keshiLeagueEntry", enter: true }); await ctx.act(1, { action: "keshiLeagueEntry", enter: true });
  const st = await ctx.act(0, { action: "keshiLeagueState" });
  assert.equal(ctx.wk().setsDone, 8, "水曜 12:40 のセットまでは、もう過ぎている");
  assert.equal(st.me, null, "まだ試合をしていない");
  await ctx.tick(JST(2026, 10, 28, 15, 0));
  const after = await ctx.act(0, { action: "keshiLeagueState" });
  assert.equal(ctx.wk().setsDone, 9); assert.equal(after.me.w + after.me.l, 5, "15:00 のセットから参加");
});

test("消しゴムが強いほど、リーグでも有利（パーツを買った人の総合力が使われる）", async () => {
  const ctx = setup({ users: 2 });
  ctx.fs.put("yuslotKeshi/id0", encF({ league: true, n: "u0", owned: ["body:titan", "edge:crystal", "sole:air", "weight:gold"], eq: { body: "titan", edge: "crystal", sole: "air", weight: "gold" }, color: 0 }));
  await ctx.tick(JST(2026, 10, 26, 10, 30));
  assert.equal(ctx.wk().p.id0.r, keshiStats({ body: "titan", edge: "crystal", sole: "air", weight: "gold" }).rating);
  assert.equal(ctx.wk().p.id1.r, 50);
  const total = { w: 0 };
  for (let k = 0; k < 6; k++) { const p = {}; for (let s = 0; s < 40; s++) keshiLeagueSimulateSet(p, [{ uid: "a", n: "a", r: ctx.wk().p.id0.r }, { uid: "b", n: "b", r: 50 }], `x${k}`, s); total.w += p.a.w; }
  assert.ok(total.w / (6 * 40 * 5) > 0.75, `強い消しゴムの勝率：${total.w / (6 * 40 * 5)}`);
});
