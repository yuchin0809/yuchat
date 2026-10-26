/* 🎲 ヨット（worker.js の yacht*）のテスト
   実行：node --test "notify-worker/test/*.test.mjs" */
import test from "node:test";
import assert from "node:assert/strict";
import { yachtCategoryScore, yachtTotals, yachtWeekEnsure, runYachtWeekTick, resetYachtWeekTickForTest, rankWeekStart, resetYuslotCacheForTest, handleYuslotAction } from "../worker.js";

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
const ADMIN = "adminUid";

function setup({ now = JST(2026, 10, 21, 12), yacht = true, users = 4 } = {}) {
  resetYuslotCacheForTest(); resetYachtWeekTickForTest();
  const base = { "worldConfig/yuslot": { yuslotPublished: true, yachtPublished: yacht } };
  for (let i = 0; i < users; i++) base[`users/u${i}`] = { uid: `id${i}`, name: `u${i}`, coins: 1000 };
  const fs = fakeFs(base);
  const state = { now };
  const deps = { firestore: fs, adminUid: ADMIN, now: () => state.now, random: rngOf(7), slotSecret: "s", sendFcm: async () => ({ ok: true }) };
  const act = (i, body) => handleYuslotAction(deps, `id${i}`, { username: `u${i}`, ...body });
  return { fs, deps, state, act };
}
/* 12ターン、1回も振り直さずに、そのときいちばん高い役へ記録して最後まで遊ぶ */
async function playGame(ctx, i, { rerolls = 0 } = {}) {
  let g = await ctx.act(i, { action: "yachtStart" });
  const log = [g];
  for (let n = 0; n < 12; n++) {
    for (let r = 0; r < rerolls; r++) g = await ctx.act(i, { action: "yachtRoll", gid: g.gid, hold: [true, false, false, false, false] });
    const cat = g.opts.map((v, k) => [v, k]).filter(([v]) => v >= 0).sort((a, b) => b[0] - a[0])[0][1];
    g = await ctx.act(i, { action: "yachtScore", gid: g.gid, cat });
    log.push(g);
  }
  return { g, log };
}

test("役の点数：エース〜シックス／チョイス／フォーダイス／フルハウス／ストレート／ヨット", () => {
  const sc = (cat, ...d) => yachtCategoryScore(cat, d);
  assert.equal(sc(0, 1, 1, 3, 4, 1), 3); assert.equal(sc(3, 4, 4, 2, 4, 4), 16); assert.equal(sc(5, 6, 6, 1, 2, 3), 12); assert.equal(sc(2, 1, 2, 4, 5, 6), 0);
  assert.equal(sc(6, 1, 2, 3, 4, 6), 16);
  assert.equal(sc(7, 3, 3, 3, 3, 5), 17, "フォーダイス＝5個の合計"); assert.equal(sc(7, 3, 3, 3, 5, 5), 0); assert.equal(sc(7, 2, 2, 2, 2, 2), 10, "5個同じでもフォーダイス");
  assert.equal(sc(8, 2, 2, 5, 5, 5), 19, "フルハウス＝5個の合計"); assert.equal(sc(8, 2, 2, 2, 2, 5), 0); assert.equal(sc(8, 3, 3, 3, 3, 3), 0, "ヨットはフルハウスにしない");
  assert.equal(sc(9, 1, 2, 3, 4, 6), 15); assert.equal(sc(9, 2, 3, 4, 5, 5), 15); assert.equal(sc(9, 1, 2, 4, 5, 6), 0); assert.equal(sc(9, 1, 2, 3, 4, 5), 15, "5連続も4連続を含む");
  assert.equal(sc(10, 1, 2, 3, 4, 5), 30); assert.equal(sc(10, 2, 3, 4, 5, 6), 30); assert.equal(sc(10, 1, 2, 3, 4, 6), 0);
  assert.equal(sc(11, 4, 4, 4, 4, 4), 50); assert.equal(sc(11, 4, 4, 4, 4, 3), 0);
});

test("合計：エース〜シックスが63点以上でボーナス35点（ちょうどでも付く）", () => {
  const blank = Array(12).fill(-1);
  assert.deepEqual(yachtTotals(blank), { upper: 0, bonus: 0, total: 0 });
  const upper63 = [3, 6, 9, 12, 15, 18, ...Array(6).fill(-1)];   // 3の倍数×3個ずつ＝63
  assert.deepEqual(yachtTotals(upper63), { upper: 63, bonus: 35, total: 98 });
  assert.deepEqual(yachtTotals([3, 6, 9, 12, 15, 12, 10, 0, 0, 15, 30, 50]), { upper: 57, bonus: 0, total: 57 + 10 + 15 + 30 + 50 });
});

test("公開：非公開のあいだは最上位管理者だけ。公開の切り替えは、ゆうスロの公開に触れない", async () => {
  const ctx = setup({ yacht: false });
  assert.equal((await ctx.act(1, { action: "yachtStart" })).error, "not_published");
  assert.equal((await ctx.act(1, { action: "yachtRanking" })).error, "not_published");
  assert.equal((await ctx.act(1, { action: "yachtState" })).error, "not_published");
  const cfg = await ctx.act(1, { action: "config" });
  assert.equal(cfg.published, true); assert.equal(cfg.yachtPublished, false);
  const as = (body) => handleYuslotAction(ctx.deps, ADMIN, { username: "u0", ...body });
  ctx.fs.put("users/u0", encF({ uid: ADMIN, name: "u0", coins: 1000 }));
  assert.equal((await as({ action: "yachtStart" })).ok, true, "最上位管理者は遊べる");
  assert.equal((await ctx.act(1, { action: "setConfig", yachtPublished: true })).error, "not_top_admin");
  const set = await as({ action: "setConfig", yachtPublished: true });
  assert.deepEqual([set.published, set.yachtPublished], [true, true]);
  assert.equal(ctx.fs.plain("worldConfig/yuslot").yuslotPublished, true, "ゆうスロの公開はそのまま");
  assert.equal((await ctx.act(1, { action: "yachtStart" })).ok, true, "公開後は誰でも遊べる");
  const off = await as({ action: "setConfig", yachtPublished: false });
  assert.deepEqual([off.published, off.yachtPublished], [true, false], "ヨットだけ非公開にしても、ゆうスロは公開のまま");
  const slot = await as({ action: "setConfig", published: false });
  assert.deepEqual([slot.published, slot.yachtPublished], [false, false]);
  assert.equal(ctx.fs.plain("worldConfig/yuslot").yachtPublished, false);
});

test("1ゲーム：最初に1回振ってから始まり、12ターンで終わる。振り直しは1ターンに2回まで・キープした目は変わらない", async () => {
  const ctx = setup();
  let g = await ctx.act(1, { action: "yachtStart" });
  assert.equal(g.turn, 1); assert.equal(g.roll, 1); assert.equal(g.dice.length, 5); assert.ok(g.dice.every((d) => d >= 1 && d <= 6));
  assert.equal(g.opts.length, 12); assert.ok(g.opts.every((v) => v >= 0), "最初は全部の役の点が出る");
  const d1 = g.dice;
  const r2 = await ctx.act(1, { action: "yachtRoll", gid: g.gid, hold: [true, true, false, true, false] });
  assert.equal(r2.roll, 2); assert.deepEqual([r2.dice[0], r2.dice[1], r2.dice[3]], [d1[0], d1[1], d1[3]], "キープした目は変わらない");
  const r3 = await ctx.act(1, { action: "yachtRoll", gid: g.gid, hold: [false, false, false, false, false] });
  assert.equal(r3.roll, 3);
  const r4 = await ctx.act(1, { action: "yachtRoll", gid: g.gid, hold: [true, true, true, true, true] });
  assert.equal(r4.error, "no_rolls", "4回目は振れない");
  assert.equal((await ctx.act(1, { action: "yachtRoll", gid: "other", hold: [true, true, true, true, true] })).error, "stale");
  const s1 = await ctx.act(1, { action: "yachtScore", gid: g.gid, cat: 6 });
  assert.equal(s1.gained, s1.card[6]); assert.equal(s1.turn, 2); assert.equal(s1.roll, 1); assert.equal(s1.opts[6], -1, "記録した役はもう選べない");
  assert.equal((await ctx.act(1, { action: "yachtScore", gid: g.gid, cat: 6 })).error, "bad_request", "同じ役には2回記録できない");
  assert.equal((await ctx.act(1, { action: "yachtScore", gid: g.gid, cat: 12 })).error, "bad_request");
  assert.equal((await ctx.act(1, { action: "yachtRoll", gid: g.gid, hold: [true] })).error, "bad_request");
});

test("最後まで遊ぶと終了。合計は役の点数＋ボーナス。1ゲームの書き込みは約30回以内", async () => {
  const ctx = setup();
  const before = ctx.fs.counts.commit;
  const { g, log } = await playGame(ctx, 1, { rerolls: 2 });
  assert.equal(g.done, true); assert.equal(g.finished, true);
  assert.ok(g.card.every((v) => v >= 0));
  assert.equal(g.total, yachtTotals(g.card).total);
  assert.equal(ctx.fs.plain("yuslotYacht/id1").done, true); assert.equal(ctx.fs.plain("yuslotYacht/id1").total, g.total);
  assert.equal(log.length, 13);
  const writes = ctx.fs.counts.commit - before;
  assert.ok(writes <= 12 * 3 + 4, `書き込み ${writes} 回`);
  assert.equal((await ctx.act(1, { action: "yachtRoll", gid: g.gid, hold: [true, true, true, true, true] })).error, "no_game");
  const wk = ctx.fs.plain("yuslotYacht/_week");
  assert.deepEqual(wk.rows.map((r) => [r.uid, r.name, r.score]), [["id1", "u1", g.total]]);
  assert.equal(g.week.best, g.total); assert.equal(g.week.rank, 1);
});

test("開き直したら続きから。「あきらめて新しく始める」は新しいゲーム。終わったあとは新しいゲームが始まる", async () => {
  const ctx = setup();
  const a = await ctx.act(1, { action: "yachtStart" });
  await ctx.act(1, { action: "yachtScore", gid: a.gid, cat: 0 });
  const st = await ctx.act(1, { action: "yachtState" });
  assert.equal(st.game.gid, a.gid); assert.equal(st.game.turn, 2);
  const again = await ctx.act(1, { action: "yachtStart" });
  assert.equal(again.resumed, true); assert.equal(again.gid, a.gid); assert.equal(again.turn, 2);
  const fresh = await ctx.act(1, { action: "yachtStart", restart: true });
  assert.notEqual(fresh.gid, a.gid); assert.equal(fresh.turn, 1);
  assert.equal((await ctx.act(1, { action: "yachtScore", gid: a.gid, cat: 1 })).error, "stale", "古いゲームには記録できない");
  assert.equal((await ctx.act(2, { action: "yachtState" })).game, null, "ほかの人のゲームは見えない");
});

test("週間ランキング：1人1件の自己ベスト。下がらない・同点は先に出した人が上", async () => {
  const ctx = setup();
  const { yachtWeekAdd } = await import("../worker.js");
  const t = ctx.state.now;
  await yachtWeekAdd(ctx.deps, "id1", "u1", 150, t);
  await yachtWeekAdd(ctx.deps, "id2", "u2", 150, t + 1000);
  const low = await yachtWeekAdd(ctx.deps, "id1", "u1", 100, t + 2000);
  assert.deepEqual([low.best, low.rank, low.improved], [150, 1, false], "低い点では更新しない");
  const up = await yachtWeekAdd(ctx.deps, "id2", "u2", 180, t + 3000);
  assert.deepEqual([up.best, up.rank, up.improved], [180, 1, true]);
  const view = await ctx.act(1, { action: "yachtRanking" });
  assert.deepEqual(view.week.rows.map((r) => [r.rank, r.name, r.score, r.mine]), [[1, "u2", 180, false], [2, "u1", 150, true]]);
  assert.deepEqual(view.me, { best: 150, rank: 2, improved: false });
  assert.deepEqual(view.prizes, [500, 300, 100]);
  assert.ok(!JSON.stringify(view).includes("id1"), "uid は返さない");
});

test("結果発表：金曜15:10に、先週の上位3人へ500・300・100コイン（二重には払わない）。お知らせは出さない", async () => {
  const ctx = setup({ users: 6 });
  const { yachtWeekAdd } = await import("../worker.js");
  const ws = rankWeekStart(ctx.state.now);
  const next = ws + 7 * 86400000;
  [[1, 200], [2, 180], [3, 160], [4, 150], [5, 120]].forEach(([i, s], k) => { void k; });
  for (const [i, s] of [[1, 200], [2, 180], [3, 160], [4, 150], [5, 120]]) await yachtWeekAdd(ctx.deps, `id${i}`, `u${i}`, s, ctx.state.now + i);
  ctx.state.now = next - 60000;
  await ctx.act(1, { action: "yachtRanking" });
  assert.equal(ctx.fs.plain("users/u1").coins, 1000, "週の途中は払わない");
  const out = await runYachtWeekTick({}, next + 30000, ctx.deps);
  assert.equal(out.weekStart, next);
  assert.equal(ctx.fs.plain("users/u1").coins, 1500); assert.equal(ctx.fs.plain("users/u2").coins, 1300); assert.equal(ctx.fs.plain("users/u3").coins, 1100);
  assert.equal(ctx.fs.plain("users/u4").coins, 1000, "4位以下は渡さない");
  const wk = ctx.fs.plain("yuslotYacht/_week");
  assert.deepEqual(wk.rows, []); assert.equal(wk.last.total, 5); assert.deepEqual(wk.last.top.map((t) => [t.rank, t.name, t.score, t.prize, t.paid]), [[1, "u1", 200, 500, true], [2, "u2", 180, 300, true], [3, "u3", 160, 100, true]]);
  assert.ok([...ctx.fs.docs.keys()].every((p) => !p.startsWith("announcements/") && !p.startsWith("notificationLogs/")), "お知らせ・通知は出さない");
  resetYachtWeekTickForTest();
  await yachtWeekEnsure(ctx.deps); ctx.state.now = next + 60000; await yachtWeekEnsure(ctx.deps);
  assert.equal(ctx.fs.plain("users/u1").coins, 1500, "二重払いなし");
  ctx.state.now = next + 3600000;
  const view = await ctx.act(2, { action: "yachtRanking" });
  assert.equal(view.week.rows.length, 0); assert.equal(view.last.top.length, 3); assert.equal(view.last.top[1].mine, true);
});

test("結果発表の cron：金曜 15:10〜15:19 だけ動く（それ以外は何も読まない）", async () => {
  const ctx = setup();
  const next = rankWeekStart(ctx.state.now) + 7 * 86400000;
  const reads = () => ctx.fs.counts.get + ctx.fs.counts.getRaw + ctx.fs.counts.query;
  const r0 = reads();
  assert.equal((await runYachtWeekTick({}, next - 60000, ctx.deps)).skipped, "outside");
  assert.equal((await runYachtWeekTick({}, next + 10 * 60000, ctx.deps)).skipped, "outside");
  assert.equal((await runYachtWeekTick({}, next + 86400000, ctx.deps)).skipped, "outside");
  assert.equal(reads(), r0);
  assert.equal((await runYachtWeekTick({}, next + 60000, ctx.deps)).weekStart, next);
  assert.equal((await runYachtWeekTick({}, next + 120000, ctx.deps)).skipped, "done");
});

/* ===== 2人用（ゲームルームの yacht フィールド） ===== */
const ROOM = "room1234567890abcd";
function roomSetup(opts = {}) {
  const ctx = setup(opts);
  ctx.fs.put(`gameRooms/${ROOM}`, encF({ gameType: "yacht", ownerUid: "id1", owner: "u1", members: ["u1", "u2"], memberUids: ["id1", "id2"], status: "playing", createdAt: "x" }));
  ctx.room = () => ctx.fs.plain(`gameRooms/${ROOM}`);
  ctx.r = (i, action, body = {}) => ctx.act(i, { action, roomId: ROOM, ...body });
  return ctx;
}
async function turnBest(ctx, y) {   // いまの番の人が、いちばん高い役に記録する
  const who = y.order[y.cur] === "id1" ? 1 : 2;
  const cat = y.opts.map((v, k) => [v, k]).filter(([v]) => v >= 0).sort((a, b) => b[0] - a[0])[0][1];
  return (await ctx.r(who, "yachtRoomScore", { gid: y.gid, cat })).yacht;
}

test("2人用：ゲームを始める（どちらの画面から呼んでも同じゲーム）。最初は1番目の人の番・最初に1回振ってある", async () => {
  const ctx = roomSetup();
  const a = await ctx.r(1, "yachtRoomStart");
  assert.equal(a.ok, true);
  const y = a.yacht;
  assert.deepEqual([y.order, y.names, y.round, y.cur, y.roll, y.done], [["id1", "id2"], ["u1", "u2"], 1, 0, 1, false]);
  assert.equal(y.dice.length, 5); assert.equal(y.c0.length, 12); assert.ok(y.c0.every((v) => v === -1));
  assert.equal(y.opts.length, 12);
  const b = await ctx.r(2, "yachtRoomStart");
  assert.equal(b.yacht.gid, y.gid, "二重に始めない");
  assert.equal(ctx.room().yacht.gid, y.gid); assert.equal(ctx.room().status, "playing", "ルームのほかの項目はそのまま");
});

test("2人用：自分の番だけ操作できる。振り直しは2回まで・キープは変わらない・同じ役には2回記録できない", async () => {
  const ctx = roomSetup();
  let y = (await ctx.r(1, "yachtRoomStart")).yacht;
  assert.equal((await ctx.r(2, "yachtRoomRoll", { gid: y.gid, hold: [false, false, false, false, false] })).error, "not_your_turn");
  assert.equal((await ctx.r(2, "yachtRoomScore", { gid: y.gid, cat: 0 })).error, "not_your_turn");
  const d1 = y.dice;
  y = (await ctx.r(1, "yachtRoomRoll", { gid: y.gid, hold: [true, true, true, false, false] })).yacht;
  assert.equal(y.roll, 2); assert.deepEqual(y.dice.slice(0, 3), d1.slice(0, 3));
  y = (await ctx.r(1, "yachtRoomRoll", { gid: y.gid, hold: [false, false, false, false, false] })).yacht;
  assert.equal(y.roll, 3);
  assert.equal((await ctx.r(1, "yachtRoomRoll", { gid: y.gid, hold: [true, true, true, true, true] })).error, "no_rolls");
  assert.equal((await ctx.r(1, "yachtRoomRoll", { gid: "x", hold: [true, true, true, true, true] })).error, "stale");
  const s1 = (await ctx.r(1, "yachtRoomScore", { gid: y.gid, cat: 6 })).yacht;
  assert.equal(s1.cur, 1); assert.equal(s1.round, 1); assert.equal(s1.roll, 1); assert.equal(s1.c0[6], yachtCategoryScore(6, y.dice));
  assert.equal(s1.opts.length, 12); assert.ok(s1.opts.every((v) => v >= 0), "2人目の番：2人目の表の点");
  const s2 = (await ctx.r(2, "yachtRoomScore", { gid: y.gid, cat: 6 })).yacht;
  assert.equal(s2.cur, 0); assert.equal(s2.round, 2, "2人とも終わったら次のターン");
  assert.equal((await ctx.r(1, "yachtRoomScore", { gid: y.gid, cat: 6 })).error, "bad_request", "同じ役には2回記録できない");
  assert.equal((await ctx.r(1, "yachtRoomScore", { gid: y.gid, cat: 12 })).error, "bad_request");
});

test("2人用：12ターン×2人で終了。点が高い人の勝ち（同点は引き分け）。終了後は操作できず、「もう一度」で新しいゲーム", async () => {
  const ctx = roomSetup();
  let y = (await ctx.r(1, "yachtRoomStart")).yacht;
  const gid = y.gid;
  for (let n = 0; n < 24; n++) y = await turnBest(ctx, y);
  assert.equal(y.done, true); assert.equal(y.reason, "finished");
  const t0 = yachtTotals(y.c0).total, t1 = yachtTotals(y.c1).total;
  assert.equal(y.winner, t0 > t1 ? 0 : t1 > t0 ? 1 : 2);
  assert.ok(y.c0.every((v) => v >= 0) && y.c1.every((v) => v >= 0));
  assert.equal((await ctx.r(1, "yachtRoomRoll", { gid, hold: [true, true, true, true, true] })).error, "no_game");
  assert.equal((await ctx.r(2, "yachtRoomStart")).yacht.done, true, "終わったあとは、そのまま結果を返す");
  const again = (await ctx.r(2, "yachtRoomStart", { rematch: true })).yacht;
  assert.notEqual(again.gid, gid); assert.equal(again.done, false); assert.equal(again.round, 1);
  assert.equal(Object.keys(ctx.room()).includes("gameState"), false);
});

test("2人用：1ゲームの書き込みは、振る・記録する操作の回数だけ（読み取りはルーム1件ずつ）", async () => {
  const ctx = roomSetup();
  let y = (await ctx.r(1, "yachtRoomStart")).yacht;
  const c0 = ctx.fs.counts.commit, g0 = ctx.fs.counts.getRaw;
  for (let n = 0; n < 24; n++) y = await turnBest(ctx, y);
  assert.equal(ctx.fs.counts.commit - c0, 24, "1操作＝1回の書き込み");
  assert.ok(ctx.fs.counts.getRaw - g0 <= 24 + 2, "1操作＝ルーム1件の読み取り（準備中の確認は短時間メモリ）");
});

test("2人用：時間制限はない。何時間たっても、自分の番なら振れる・記録できる。自動で記録されず、放置しても負けにならない", async () => {
  const ctx = roomSetup();
  let y = (await ctx.r(1, "yachtRoomStart")).yacht;
  const key = (yy) => ({ gid: yy.gid, round: yy.round, turn: yy.cur });
  assert.equal(y.deadline, undefined, "持ち時間の印はない"); assert.equal(y.miss, undefined);
  ctx.state.now += 6 * 3600000;   // 6時間たつ
  const t = (await ctx.r(2, "yachtRoomTimeout", key(y))).yacht;     // 古い画面のタイマーからの呼び出し：何もしない
  assert.deepEqual([t.cur, t.round, t.c0.every((v) => v === -1), t.done], [0, 1, true, false], "自動で記録しない・番も進まない");
  assert.equal((await ctx.r(1, "yachtRoomTimeout", key(y))).yacht.gid, y.gid);
  const rolled = await ctx.r(1, "yachtRoomRoll", { gid: y.gid, hold: [false, false, false, false, false] });
  assert.equal(rolled.error, undefined); assert.equal(rolled.yacht.roll, 2, "6時間あとでも振れる");
  const scored = await ctx.r(1, "yachtRoomScore", { gid: y.gid, cat: 0 });
  assert.equal(scored.error, undefined); assert.equal(scored.yacht.cur, 1, "記録できて、次の人へ");
  // 次の人が丸1日放置しても、負けにならない
  ctx.state.now += 24 * 3600000;
  const idle = (await ctx.r(1, "yachtRoomTimeout", key(scored.yacht))).yacht;
  assert.deepEqual([idle.done, idle.cur, idle.c1.every((v) => v === -1)], [false, 1, true]);
  assert.equal((await ctx.r(2, "yachtRoomScore", { gid: y.gid, cat: 1 })).error, undefined, "1日あとでも記録できる");
});

test("2人用：ルームの参加者だけ。ルームの種類が違う・存在しない・形式が不正なものは断る", async () => {
  const ctx = roomSetup();
  assert.equal((await ctx.r(3, "yachtRoomStart")).error, "not_member");
  assert.equal((await ctx.act(1, { action: "yachtRoomStart", roomId: "nope12345678" })).error, "no_room");
  assert.equal((await ctx.act(1, { action: "yachtRoomStart", roomId: "../x" })).error, "bad_request");
  ctx.fs.put("gameRooms/othello12345678", encF({ gameType: "othello", members: ["u1"], memberUids: ["id1"], status: "playing" }));
  assert.equal((await ctx.act(1, { action: "yachtRoomStart", roomId: "othello12345678" })).error, "bad_request");
  ctx.fs.put("gameRooms/wait1234567890", encF({ gameType: "yacht", members: ["u1"], memberUids: ["id1"], status: "waiting" }));
  assert.equal((await ctx.act(1, { action: "yachtRoomStart", roomId: "wait1234567890" })).error, "not_ready", "2人そろうまで始まらない");
});

test("2人用：準備中は最上位管理者だけ。ただし最上位管理者が入っているルームなら、招待された友達も遊べる。公開後は誰でも", async () => {
  const closed = roomSetup({ yacht: false });
  assert.equal((await closed.r(1, "yachtRoomStart")).error, "not_published", "管理者のいない部屋は遊べない");
  const withAdmin = setup({ yacht: false });
  withAdmin.fs.put(`gameRooms/${ROOM}`, encF({ gameType: "yacht", ownerUid: ADMIN, owner: "admin", members: ["admin", "u2"], memberUids: [ADMIN, "id2"], status: "playing" }));
  const adminStart = await handleYuslotAction(withAdmin.deps, ADMIN, { action: "yachtRoomStart", roomId: ROOM, username: "admin" });
  assert.equal(adminStart.ok, true, "最上位管理者は遊べる");
  const guest = await withAdmin.act(2, { action: "yachtRoomRoll", roomId: ROOM, gid: adminStart.yacht.gid, hold: [true, true, true, true, true] });
  assert.equal(guest.error, "not_your_turn", "招待された友達は、部屋に入って操作できる（ここでは相手の番）");
  const open = roomSetup({ yacht: true });
  assert.equal((await open.r(1, "yachtRoomStart")).ok, true);
});

test("2人用：メンバーが入れ替わったら、新しいゲームを始める（前の人のゲームを引き継がない）", async () => {
  const ctx = roomSetup();
  const first = (await ctx.r(1, "yachtRoomStart")).yacht;
  ctx.fs.put(`gameRooms/${ROOM}`, encF({ ...ctx.room(), members: ["u1", "u3"], memberUids: ["id1", "id3"], yacht: first }));
  const next = (await ctx.act(1, { action: "yachtRoomStart", roomId: ROOM })).yacht;
  assert.notEqual(next.gid, first.gid); assert.deepEqual(next.order, ["id1", "id3"]);
});
