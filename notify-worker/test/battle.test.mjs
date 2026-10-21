/* 🎫 先着ゲーム（worker.js の battle*）のテスト
   実行：node --test "notify-worker/test/*.test.mjs" */
import test from "node:test";
import assert from "node:assert/strict";
import {
  kakuTimes, kakuDayId, kakuDayStart, resetKakuCacheForTest, resetYuslotCacheForTest, resetBattleCacheForTest, handleYuslotAction,
  battleCard, battlePlan, battleProofOk, battleBoardMerge, battleOpenSlots, battleClosedList
} from "../worker.js";

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
const D = "2026-10-21";
const TT = kakuTimes(D);
const H = 3600000, M = 60000;
function setup({ now = TT.quickOpen, published = true, n = 6 } = {}) {
  resetKakuCacheForTest(); resetYuslotCacheForTest(); resetBattleCacheForTest();
  const base = { "worldConfig/yuslot": { yuslotPublished: published } };
  for (let i = 0; i < n; i++) base[`users/u${i}`] = { uid: `id${i}`, name: `u${i}`, coins: 5000 };
  const fs = fakeFs(base);
  const state = { now };
  const deps = { firestore: fs, adminUid: ADMIN, random: Math.random, now: () => state.now, slotSecret: "s", sendFcm: async () => ({ ok: true }) };
  const act = (uid, name, body) => handleYuslotAction(deps, uid, { ...body, username: name });
  return { fs, deps, state, act };
}
const who = (i) => [`id${i}`, `u${i}`];
/* 人間の速さで、きちんと遊んだ記録をつくる（各画面にかかる時間は、最低限の少し上） */
function proofFor(plan, extra = 100) {
  const [c0, c1, c2, c3] = plan.conn;
  const need = [500 * c0 + 300, 500 * c1 + 300, 500 * c2 + 300, 500 * c3 + 700, 100];
  const t = []; let sum = 0;
  need.forEach((x) => { sum += x + extra; t.push(sum); });
  return t;
}
async function play(ctx, i, slot, { wait = 0 } = {}) {
  const [uid, name] = who(i);
  const s = await ctx.act(uid, name, { action: "battleStart" });
  assert.equal(s.ok, true, JSON.stringify(s));
  const t = proofFor(s.plan);
  ctx.state.now += t[4] + wait;
  return { start: s, res: await ctx.act(uid, name, { action: "battleFinish", att: s.att, slot, ans: s.plan.puzzle.answer, card: String(s.card), t }) };
}
const quickIdx = async (ctx) => { await ctx.act("id0", "u0", { action: "battleStatus" }); return ctx.fs.plain(`yuslotKaku/${D}`).slots.filter((x) => x.kind === "quick").map((x) => x.i); };

test("問題：人ごと・回ごとにサーバーが作る（同じ入力なら同じ、接続画面の回数は範囲内、選択肢は4つで正解は1つ）", async () => {
  const { deps } = setup();
  const seen = new Set(), cards = new Set();
  for (let u = 0; u < 40; u++) for (let att = 1; att <= 3; att++) {
    const p = await battlePlan(deps, D, `uid${u}`, att), p2 = await battlePlan(deps, D, `uid${u}`, att);
    assert.deepEqual(p, p2, "同じ入力なら同じ問題");
    assert.ok(p.conn[0] >= 2 && p.conn[0] <= 4, "最初の接続は2〜4回");
    assert.ok(p.conn.slice(1).every((x) => x >= 0 && x <= 2) && p.conn.reduce((s, x) => s + x, 0) <= 8, "切り替えは0〜2回、合計は8回まで");
    assert.equal(new Set(p.puzzle.options).size, 4);
    assert.ok(p.puzzle.answer >= 0 && p.puzzle.answer < 4);
    assert.deepEqual([...p.consent].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    seen.add(JSON.stringify(p));
  }
  assert.ok(seen.size > 100, `ほとんどが違う問題（${seen.size}/120）`);
  for (let u = 0; u < 60; u++) { const c = await battleCard(deps, D, `uid${u}`); assert.ok(c >= 100 && c <= 999, "3桁"); cards.add(c); assert.equal(c, await battleCard(deps, D, `uid${u}`), "その日は同じ番号"); }
  assert.ok(cards.size > 30, "人ごとにばらける");
  assert.notEqual(await battleCard(deps, D, "uid1"), await battleCard({ ...deps, slotSecret: "other" }, D, "uid1"), "鍵が違えば番号も違う");
});

test("チェック：速すぎる・順番がおかしい・サーバーの測った時間より長い申告は通さない", async () => {
  const { deps } = setup();
  const plan = await battlePlan(deps, D, "x", 1), t = proofFor(plan);
  assert.equal(battleProofOk(plan, t, t[4] + 10), null);
  assert.equal(battleProofOk(plan, t.map((x) => Math.floor(x / 3)), 5000), "too_fast");
  assert.equal(battleProofOk(plan, [...t].reverse(), 99999), "bad_proof");
  assert.equal(battleProofOk(plan, t.slice(0, 4), 99999), "bad_proof");
  assert.equal(battleProofOk(plan, t.map(() => NaN), 99999), "bad_proof");
  assert.equal(battleProofOk(plan, t, t[4] - 3500), "bad_proof", "端末の申告のほうが長い");
  assert.equal(battleProofOk(plan, t, t[4] + 3), null, "多少のずれは許す");
});

test("状態：待機画面（11:30〜）からカード番号が見え、11:45 前は始められない。公開前は使えない", async () => {
  const early = setup({ now: TT.quickOpen - 20 * M });
  const a = await early.act("id1", "u1", { action: "battleStatus" });
  assert.equal(a.ok, true); assert.equal(a.card, undefined, "11:30 前はカード番号なし");
  assert.equal(a.times.goAt, TT.quickOpen); assert.equal(a.times.waitOpen, TT.quickOpen - 15 * M);
  assert.equal(a.slots.length, 2, "先着の枠は2つ（取られた状況は返さない）");
  assert.ok(a.slots.every((x) => !("taken" in x)));
  early.state.now = TT.quickOpen - 10 * M;
  const b = await early.act("id1", "u1", { action: "battleStatus" });
  assert.equal(b.card, await battleCard(early.deps, D, "id1"));
  assert.equal((await early.act("id1", "u1", { action: "battleStart" })).error, "not_open", "11:45 前は始められない");
  early.state.now = TT.quickOpen - 1;
  assert.equal((await early.act("id1", "u1", { action: "battleStart" })).error, "not_open", "11:44:59.999 もだめ");
  early.state.now = TT.quickOpen;
  assert.equal((await early.act("id1", "u1", { action: "battleStart" })).ok, true, "11:45:00.000 からOK");
  const closed = setup({ published: false });
  assert.equal((await closed.act("id1", "u1", { action: "battleStart" })).error, "not_published");
  assert.equal((await closed.act("id1", "u1", { action: "battleStatus" })).error, "not_published");
  assert.equal((await closed.act("id1", "u1", { action: "battleRanking" })).error, "not_published");
});

test("先着を直接買う入口（kakuQuick）は公開されていない", async () => {
  const ctx = setup();
  const [q] = await quickIdx(ctx);
  const r = await handleYuslotAction(ctx.deps, "id1", { action: "kakuQuick", slot: q, username: "u1" });
  assert.equal(r.error, "unknown_action");
  assert.equal(ctx.fs.plain(`yuslotKaku/${D}`).slots[q].uid, "", "取れていない");
});

test("遊んで取る：1位のタイム＝スタートから最後に押すまで。ランキングへの当日分の反映は12:00", async () => {
  const ctx = setup();
  const [q0] = await quickIdx(ctx);
  const { start, res } = await play(ctx, 1, q0);
  assert.equal(res.ok, true); assert.equal(res.got, true); assert.equal(res.slot, q0);
  assert.equal(res.ms, ctx.state.now - start.st, "サーバーが測った、スタートから押すまで");
  assert.equal(ctx.fs.plain(`yuslotKaku/${D}`).slots[q0].uid, "id1", "枠は本人のもの");
  const rec = ctx.fs.plain("yuslotBattle/id1");
  assert.equal(rec.d, true); assert.equal(rec.g, q0); assert.equal(rec.ms, res.ms);
  // 11:45〜12:00：当日の記録は載らない（本人には保留中のタイムを返す）
  const r1 = await ctx.act("id1", "u1", { action: "battleRanking" });
  assert.equal(r1.rows.length, 0); assert.equal(r1.pendingMs, res.ms);
  resetBattleCacheForTest();
  ctx.state.now = kakuDayStart(D) + 12 * H;
  const r2 = await ctx.act("id2", "u2", { action: "battleRanking" });
  assert.equal(r2.rows.length, 1); assert.equal(r2.rows[0].name, "u1"); assert.equal(r2.rows[0].ms, res.ms);
  assert.ok(!JSON.stringify(r2).includes("id1"), "uid は返さない");
  // やり直しはできない（もう終わり）
  const again = await ctx.act("id1", "u1", { action: "battleStart" });
  assert.equal(again.done, true); assert.equal(again.rec.got, true);
});

test("検証：違う答え・カード番号・古い回・速すぎる記録はだめで、枠は取れない", async () => {
  const ctx = setup();
  const [q0] = await quickIdx(ctx);
  const s = await ctx.act("id1", "u1", { action: "battleStart" });
  const t = proofFor(s.plan);
  ctx.state.now += t[4];
  const send = (over) => ctx.act("id1", "u1", { action: "battleFinish", att: s.att, slot: q0, ans: s.plan.puzzle.answer, card: String(s.card), t, ...over });
  assert.equal((await send({ ans: (s.plan.puzzle.answer + 1) % 4 })).error, "bad_proof");
  assert.equal((await send({ card: "000" })).error, "bad_proof");
  assert.equal((await send({ att: 9 })).error, "stale");
  assert.equal((await send({ t: t.map((x) => Math.floor(x / 4)) })).error, "too_fast");
  assert.equal((await send({ slot: 999 })).error !== undefined, true);
  assert.equal(ctx.fs.plain(`yuslotKaku/${D}`).slots[q0].uid, "");
  assert.equal((await send({})).got, true, "正しい記録なら取れる");
  const none = setup();
  assert.equal((await none.act("id1", "u1", { action: "battleFinish", att: 1, slot: 0, ans: 0, card: "100", t: [1, 2, 3, 4, 5] })).error, "no_game");
});

test("早い者勝ち：先に押した人が取り、遅れた人は「売り切れ」→残りの枠があればやり直せる（時計は進み続ける）", async () => {
  const ctx = setup();
  const [q0, q1] = await quickIdx(ctx);
  const a = await ctx.act("id1", "u1", { action: "battleStart" });
  const b = await ctx.act("id2", "u2", { action: "battleStart" });
  const ta = proofFor(a.plan), tb = proofFor(b.plan);
  ctx.state.now += Math.max(ta[4], tb[4]);
  const send = (id, nm, s, t, slot) => ctx.act(id, nm, { action: "battleFinish", att: s.att, slot, ans: s.plan.puzzle.answer, card: String(s.card), t });
  const ra = await send("id1", "u1", a, ta, q0);
  assert.equal(ra.got, true);
  const rb = await send("id2", "u2", b, tb, q0);
  assert.equal(rb.done, false); assert.equal(rb.got, false); assert.equal(rb.soldOut, true); assert.equal(rb.reason, "taken");
  assert.equal(rb.att, 2); assert.ok(rb.plan && rb.plan.conn.length === 4, "新しい問題");
  assert.deepEqual(rb.closed.filter((x) => x.why === "taken").map((x) => x.i), [q0]);
  assert.equal(ctx.fs.plain("yuslotBattle/id2").st, b.st, "時計（スタート時刻）はそのまま");
  assert.equal(ctx.fs.plain("yuslotBattle/id2").d, false);
  // 2回目：もう一方の枠を取る
  const t2 = proofFor(rb.plan); ctx.state.now += t2[4];
  const rb2 = await ctx.act("id2", "u2", { action: "battleFinish", att: rb.att, slot: q1, ans: rb.plan.puzzle.answer, card: String(rb.card), t: t2 });
  assert.equal(rb2.got, true); assert.equal(rb2.slot, q1);
  assert.ok(rb2.ms > ra.ms, "やり直した分、タイムは長い");
  // 3人目：もう売り切れ。スタートも押せない（記録なし）
  const c = await ctx.act("id3", "u3", { action: "battleStart" });
  assert.equal(c.soldOut, true); assert.equal(ctx.fs.plain("yuslotBattle/id3"), null);
});

test("売り切れで終わった人（残りの枠なし）もタイムは記録される。同時に押しても二重には売れない", async () => {
  const ctx = setup();
  const [q0, q1] = await quickIdx(ctx);
  const starts = await Promise.all([1, 2, 3, 4].map((i) => ctx.act(`id${i}`, `u${i}`, { action: "battleStart" })));
  ctx.state.now += 20000;
  const results = await Promise.all(starts.map((s, k) => ctx.act(`id${k + 1}`, `u${k + 1}`, { action: "battleFinish", att: s.att, slot: q0, ans: s.plan.puzzle.answer, card: String(s.card), t: proofFor(s.plan) })));
  assert.equal(results.filter((r) => r.got).length, 1, "同じ枠を取れたのは1人だけ");
  assert.equal(ctx.fs.plain(`yuslotKaku/${D}`).slots.filter((x) => x.kind === "quick" && x.uid).length, 1);
  // 残りの枠を1人が取り、最後の1人は残り枠なしで終わる
  const retry = results.map((r, k) => ({ r, k })).filter((x) => !x.r.got);
  const x = retry[0]; ctx.state.now += 5000;
  const g = await ctx.act(`id${x.k + 1}`, `u${x.k + 1}`, { action: "battleFinish", att: x.r.att, slot: q1, ans: x.r.plan.puzzle.answer, card: String(x.r.card), t: proofFor(x.r.plan) });
  assert.equal(g.got, true);
  const y = retry[1]; ctx.state.now += 5000;
  const last = await ctx.act(`id${y.k + 1}`, `u${y.k + 1}`, { action: "battleFinish", att: y.r.att, slot: q1, ans: y.r.plan.puzzle.answer, card: String(y.r.card), t: proofFor(y.r.plan) });
  assert.equal(last.done, true); assert.equal(last.got, false); assert.equal(last.soldOut, true);
  assert.equal(ctx.fs.plain(`yuslotBattle/id${y.k + 1}`).g, -1);
  const board = ctx.fs.plain("yuslotBattle/_board").rows;
  assert.ok(board.some((r) => r.uid === `id${y.k + 1}`), "取れなかった人もランキングに載る");
});

test("開き直し：ページを閉じて入り直しても時計はそのまま、新しい問題になる", async () => {
  const ctx = setup();
  const s1 = await ctx.act("id1", "u1", { action: "battleStart" });
  ctx.state.now += 30000;
  const s2 = await ctx.act("id1", "u1", { action: "battleStart" });
  assert.equal(s2.att, 2); assert.equal(s2.st, s1.st);
  assert.equal(s2.card, s1.card, "カード番号はその日ずっと同じ");
  const [q0] = await quickIdx(ctx);
  const old = proofFor(s1.plan); ctx.state.now += old[4];
  assert.equal((await ctx.act("id1", "u1", { action: "battleFinish", att: 1, slot: q0, ans: s1.plan.puzzle.answer, card: String(s1.card), t: old })).error, "stale", "前の回の記録は使えない");
});

test("抽選の枠を持っている人も先着ゲームに参加できる（時間が重なる枠は取れず、重ならない枠は取れる）", async () => {
  const ctx = setup();
  await quickIdx(ctx);
  const day = ctx.fs.plain(`yuslotKaku/${D}`);
  const quick = day.slots.filter((x) => x.kind === "quick");
  // 先着の枠のひとつと時間が重なる枠（前日抽選の枠など）を、id3 が持っている状態にする
  const clash = day.slots.find((x) => x.kind !== "quick" && quick.some((q) => x.s < q.e && q.s < x.e));
  const target = clash ? quick.find((q) => clash.s < q.e && q.s < clash.e) : null;
  if (clash) { clash.uid = "id3"; clash.name = "u3"; ctx.fs.put(`yuslotKaku/${D}`, encF(day)); resetKakuCacheForTest(); }
  const other = quick.find((q) => !target || q.i !== target.i);
  const open = battleOpenSlots(ctx.fs.plain(`yuslotKaku/${D}`).slots, "id3", ctx.state.now);
  assert.equal(open.includes(other.i), true, "重ならない枠は取れる");
  if (target) assert.equal(open.includes(target.i), false, "時間が重なる枠は取れない");
  const s = await ctx.act("id3", "u3", { action: "battleStart" });
  assert.equal(s.ok, true);
  if (target) {
    // 重なる枠を選んで押すと、取れずに「やり直し」になる（もう一方の枠は取れる）
    const t = proofFor(s.plan); ctx.state.now += t[4];
    const r = await ctx.act("id3", "u3", { action: "battleFinish", att: 1, slot: target.i, ans: s.plan.puzzle.answer, card: String(s.card), t });
    assert.equal(r.done, false); assert.equal(r.reason, "overlap");
    assert.equal(r.closed.find((x) => x.i === target.i).why, "rule");
    const t2 = proofFor(r.plan); ctx.state.now += t2[4];
    const r2 = await ctx.act("id3", "u3", { action: "battleFinish", att: 2, slot: other.i, ans: r.plan.puzzle.answer, card: String(r.card), t: t2 });
    assert.equal(r2.got, true);
  }
});

test("先着の枠がすでに取れている人（通信エラーなどの後）は、押し直すと取れた結果になる", async () => {
  const ctx = setup();
  const [q0, q1] = await quickIdx(ctx);
  const s = await ctx.act("id1", "u1", { action: "battleStart" });
  const day = ctx.fs.plain(`yuslotKaku/${D}`);
  day.slots[q0].uid = "id1"; day.slots[q0].name = "u1";
  ctx.fs.put(`yuslotKaku/${D}`, encF(day)); resetKakuCacheForTest();
  assert.equal(s.haveQuick, false);
  const t = proofFor(s.plan); ctx.state.now += t[4];
  const r = await ctx.act("id1", "u1", { action: "battleFinish", att: 1, slot: q1, ans: s.plan.puzzle.answer, card: String(s.card), t });
  assert.equal(r.done, true); assert.equal(r.got, true); assert.equal(r.slot, q0);
  assert.equal(ctx.fs.plain(`yuslotKaku/${D}`).slots[q1].uid, "", "2枠目は取れない（1人1枠）");
});

test("ランキング：通算の自己ベスト（今日より前の記録は残り、当日の新記録は12:00に反映）", () => {
  let rows = battleBoardMerge([], "a", "あ", "2026-10-21", 9000);
  assert.deepEqual(rows, [{ uid: "a", name: "あ", ms: 9000, day: "2026-10-21", pms: 0, pday: "" }]);
  rows = battleBoardMerge(rows, "a", "あ", "2026-10-21", 12000);
  assert.equal(rows[0].ms, 9000, "同じ日は速いほう");
  rows = battleBoardMerge(rows, "a", "あ", "2026-10-22", 15000);
  assert.equal(rows[0].ms, 9000, "遅ければ自己ベストのまま");
  rows = battleBoardMerge(rows, "a", "あ2", "2026-10-23", 7000);
  assert.deepEqual([rows[0].ms, rows[0].day, rows[0].pms, rows[0].pday, rows[0].name], [7000, "2026-10-23", 9000, "2026-10-21", "あ2"], "前の自己ベストを pms に残す");
  rows = battleBoardMerge(rows, "a", "あ2", "2026-10-23", 6500);
  assert.deepEqual([rows[0].ms, rows[0].pms], [6500, 9000], "同じ日の更新では前日までの記録はそのまま");
});

test("ランキングの表示：当日の新記録は12:00まで前の自己ベストを表示、順位は速い順、上位20人＋自分", async () => {
  const ctx = setup({ n: 1 });
  const rows = [];
  for (let i = 0; i < 25; i++) rows.push({ uid: `p${i}`, name: `p${i}`, ms: 10000 + i * 100, day: "2026-10-20", pms: 0, pday: "" });
  rows.push({ uid: "id0", name: "u0", ms: 5000, day: D, pms: 20000, pday: "2026-10-19" });  // 今日、自己ベスト更新
  ctx.fs.put("yuslotBattle/_board", encF({ rows }));
  ctx.state.now = kakuDayStart(D) + 11 * H + 50 * M;
  const before = await ctx.act("id0", "u0", { action: "battleRanking" });
  assert.equal(before.rows.length, 20); assert.equal(before.total, 26);
  assert.equal(before.rows[0].name, "p0", "12:00 前は、昨日までの記録");
  assert.equal(before.me.rank, 26); assert.equal(before.me.ms, 20000); assert.equal(before.pendingMs, 5000);
  resetBattleCacheForTest();
  ctx.state.now = kakuDayStart(D) + 12 * H;
  const after = await ctx.act("id0", "u0", { action: "battleRanking" });
  assert.equal(after.rows[0].name, "u0"); assert.equal(after.rows[0].me, true); assert.equal(after.rows[0].ms, 5000);
  assert.equal(after.me.rank, 1); assert.equal(after.pendingMs, null);
  assert.ok(after.rows.every((r, i) => i === 0 || r.ms >= after.rows[i - 1].ms), "速い順");
  // 読み取りは書類1つ（30秒はメモリ）
  const reads = ctx.fs.counts.getRaw;
  await ctx.act("id0", "u0", { action: "battleRanking" }); await ctx.act("id0", "u0", { action: "battleRanking" });
  assert.equal(ctx.fs.counts.getRaw, reads, "メモリから返す");
});

test("読み取り・書き込みの回数：スタート＝書き込み1、おしまい＝記録とランキングの2", async () => {
  const ctx = setup();
  await quickIdx(ctx);
  const c0 = ctx.fs.counts.commit;
  const s = await ctx.act("id1", "u1", { action: "battleStart" });
  const [q0] = await quickIdx(ctx);
  assert.equal(ctx.fs.plain("yuslotBattle/id1").a, 1);
  const t = proofFor(s.plan); ctx.state.now += t[4];
  await ctx.act("id1", "u1", { action: "battleFinish", att: 1, slot: q0, ans: s.plan.puzzle.answer, card: String(s.card), t });
  assert.ok(ctx.fs.counts.commit - c0 <= 4, `commit ${ctx.fs.counts.commit - c0}`);
});
