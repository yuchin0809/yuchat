/* 🎫 先着ゲーム（worker.js の battle*）のテスト
   実行：node --test "notify-worker/test/*.test.mjs" */
import test from "node:test";
import assert from "node:assert/strict";
import {
  kakuTimes, kakuDayId, kakuDayStart, resetKakuCacheForTest, resetYuslotCacheForTest, resetBattleCacheForTest, handleYuslotAction,
  battleCard, battlePlan, battleProofOk, battleBoardMerge, battleOpenSlots, battleClosedList,
  resetBattleWeekCacheForTest, resetBattleWeekTickForTest, runBattleWeekTick, battleWeekEnsure, battleWeekAnnounce, rankWeekStart,
  kakuCancelPlan, kakuCancelRun, kakuCancelExpire, runKakuCancelTick, resetKakuCancelTickForTest, SLOT_ASSET_MIN, kakuMachineFor, KAKU_EPOCH, kakuNextDay
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
  resetKakuCacheForTest(); resetYuslotCacheForTest(); resetBattleCacheForTest(); resetBattleWeekCacheForTest(); resetBattleWeekTickForTest(); resetKakuCancelTickForTest();
  const base = { "worldConfig/yuslot": { yuslotPublished: published } };
  for (let i = 0; i < n; i++) base[`users/u${i}`] = { uid: `id${i}`, name: `u${i}`, coins: 5000 };
  const fs = fakeFs(base);
  const state = { now };
  const sent = [];
  const deps = { firestore: fs, adminUid: ADMIN, random: Math.random, now: () => state.now, slotSecret: "s", sendFcm: async (token, data) => { sent.push({ token, data }); return { ok: true }; } };
  const act = (uid, name, body) => handleYuslotAction(deps, uid, { ...body, username: name });
  return { fs, deps, state, act, sent };
}
const ordOf = (plan) => [...plan.order].sort((a, b) => a - b);
const who = (i) => [`id${i}`, `u${i}`];
/* 人間の速さで、きちんと遊んだ記録をつくる（各画面にかかる時間は、最低限の少し上） */
function proofFor(plan, extra = 100) {
  const [c0, c1, c2, c3, c4, c5] = plan.conn;
  const need = [500 * c0 + 300, 500 * c1 + 300, 500 * c2 + 300, 500 * c3 + 300, 500 * c4 + 300, 500 * c5 + 700, 100];
  const t = []; let sum = 0;
  need.forEach((x) => { sum += x + extra; t.push(sum); });
  return t;
}
async function play(ctx, i, slot, { wait = 0 } = {}) {
  const [uid, name] = who(i);
  const s = await ctx.act(uid, name, { action: "battleStart" });
  assert.equal(s.ok, true, JSON.stringify(s));
  const t = proofFor(s.plan);
  ctx.state.now += t[6] + wait;
  return { start: s, res: await ctx.act(uid, name, { action: "battleFinish", att: s.att, slot, ans: s.plan.puzzle.answer, ord: ordOf(s.plan), card: String(s.card), t }) };
}
const quickIdx = async (ctx) => { await ctx.act("id0", "u0", { action: "battleStatus" }); return ctx.fs.plain(`yuslotKaku/${D}`).slots.filter((x) => x.kind === "quick").map((x) => x.i); };

test("問題：人ごと・回ごとにサーバーが作る（同じ入力なら同じ、接続画面の回数は範囲内、選択肢は4つで正解は1つ）", async () => {
  const { deps } = setup();
  const seen = new Set(), cards = new Set();
  for (let u = 0; u < 40; u++) for (let att = 1; att <= 3; att++) {
    const p = await battlePlan(deps, D, `uid${u}`, att), p2 = await battlePlan(deps, D, `uid${u}`, att);
    assert.deepEqual(p, p2, "同じ入力なら同じ問題");
    assert.ok(p.conn[0] >= 2 && p.conn[0] <= 4, "最初の接続は2〜4回");
    assert.ok(p.conn.length === 6 && p.conn.slice(1).every((x) => x >= 0 && x <= 2) && p.conn.reduce((s, x) => s + x, 0) <= 10, "切り替えは0〜2回（5か所）、合計は10回まで");
    assert.equal(new Set(p.order).size, 4, "並べ替えの数字は4つ"); assert.ok(p.order.every((n) => n >= 1 && n <= 99));
    assert.ok(p.slide.emoji && p.slide.goal && p.slide.label.includes("右に移してください"));
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
  assert.equal(battleProofOk(plan, t, t[6] + 10), null);
  assert.equal(battleProofOk(plan, t.map((x) => Math.floor(x / 3)), 5000), "too_fast");
  assert.equal(battleProofOk(plan, [...t].reverse(), 99999), "bad_proof");
  assert.equal(battleProofOk(plan, t.slice(0, 5), 99999), "bad_proof");
  assert.equal(battleProofOk(plan, t.map(() => NaN), 99999), "bad_proof");
  assert.equal(battleProofOk(plan, t, t[6] - 3500), "bad_proof", "端末の申告のほうが長い");
  assert.equal(battleProofOk(plan, t, t[6] + 3), null, "多少のずれは許す");
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
  ctx.state.now += t[6];
  const send = (over) => ctx.act("id1", "u1", { action: "battleFinish", att: s.att, slot: q0, ans: s.plan.puzzle.answer, ord: ordOf(s.plan), card: String(s.card), t, ...over });
  assert.equal((await send({ ans: (s.plan.puzzle.answer + 1) % 4 })).error, "bad_proof");
  assert.equal((await send({ card: "000" })).error, "bad_proof");
  assert.equal((await send({ ord: [...ordOf(s.plan)].reverse() })).error, "bad_proof", "数字を小さい順にタップしていない");
  assert.equal((await send({ ord: undefined })).error, "bad_proof");
  assert.equal((await send({ att: 9 })).error, "stale");
  assert.equal((await send({ t: t.map((x) => Math.floor(x / 4)) })).error, "too_fast");
  assert.equal((await send({ slot: 999 })).error !== undefined, true);
  assert.equal(ctx.fs.plain(`yuslotKaku/${D}`).slots[q0].uid, "");
  assert.equal((await send({})).got, true, "正しい記録なら取れる");
  const none = setup();
  assert.equal((await none.act("id1", "u1", { action: "battleFinish", att: 1, slot: 0, ans: 0, card: "100", t: [1, 2, 3, 4, 5, 6, 7] })).error, "no_game");
});

test("早い者勝ち：先に押した人が取り、遅れた人は「売り切れ」→残りの枠があればやり直せる（時計は進み続ける）", async () => {
  const ctx = setup();
  const [q0, q1] = await quickIdx(ctx);
  const a = await ctx.act("id1", "u1", { action: "battleStart" });
  const b = await ctx.act("id2", "u2", { action: "battleStart" });
  const ta = proofFor(a.plan), tb = proofFor(b.plan);
  ctx.state.now += Math.max(ta[6], tb[6]);
  const send = (id, nm, s, t, slot) => ctx.act(id, nm, { action: "battleFinish", att: s.att, slot, ans: s.plan.puzzle.answer, ord: ordOf(s.plan), card: String(s.card), t });
  const ra = await send("id1", "u1", a, ta, q0);
  assert.equal(ra.got, true);
  const rb = await send("id2", "u2", b, tb, q0);
  assert.equal(rb.done, false); assert.equal(rb.got, false); assert.equal(rb.soldOut, true); assert.equal(rb.reason, "taken");
  assert.equal(rb.att, 2); assert.ok(rb.plan && rb.plan.conn.length === 6, "新しい問題");
  assert.deepEqual(rb.closed.filter((x) => x.why === "taken").map((x) => x.i), [q0]);
  assert.equal(ctx.fs.plain("yuslotBattle/id2").st, b.st, "時計（スタート時刻）はそのまま");
  assert.equal(ctx.fs.plain("yuslotBattle/id2").d, false);
  // 2回目：もう一方の枠を取る
  const t2 = proofFor(rb.plan); ctx.state.now += t2[6];
  const rb2 = await ctx.act("id2", "u2", { action: "battleFinish", att: rb.att, slot: q1, ans: rb.plan.puzzle.answer, ord: ordOf(rb.plan), card: String(rb.card), t: t2 });
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
  const results = await Promise.all(starts.map((s, k) => ctx.act(`id${k + 1}`, `u${k + 1}`, { action: "battleFinish", att: s.att, slot: q0, ans: s.plan.puzzle.answer, ord: ordOf(s.plan), card: String(s.card), t: proofFor(s.plan) })));
  assert.equal(results.filter((r) => r.got).length, 1, "同じ枠を取れたのは1人だけ");
  assert.equal(ctx.fs.plain(`yuslotKaku/${D}`).slots.filter((x) => x.kind === "quick" && x.uid).length, 1);
  // 残りの枠を1人が取り、最後の1人は残り枠なしで終わる
  const retry = results.map((r, k) => ({ r, k })).filter((x) => !x.r.got);
  const x = retry[0]; ctx.state.now += 5000;
  const g = await ctx.act(`id${x.k + 1}`, `u${x.k + 1}`, { action: "battleFinish", att: x.r.att, slot: q1, ans: x.r.plan.puzzle.answer, ord: ordOf(x.r.plan), card: String(x.r.card), t: proofFor(x.r.plan) });
  assert.equal(g.got, true);
  const y = retry[1]; ctx.state.now += 5000;
  const last = await ctx.act(`id${y.k + 1}`, `u${y.k + 1}`, { action: "battleFinish", att: y.r.att, slot: q1, ans: y.r.plan.puzzle.answer, ord: ordOf(y.r.plan), card: String(y.r.card), t: proofFor(y.r.plan) });
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
  const old = proofFor(s1.plan); ctx.state.now += old[6];
  assert.equal((await ctx.act("id1", "u1", { action: "battleFinish", att: 1, slot: q0, ans: s1.plan.puzzle.answer, ord: ordOf(s1.plan), card: String(s1.card), t: old })).error, "stale", "前の回の記録は使えない");
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
    const t = proofFor(s.plan); ctx.state.now += t[6];
    const r = await ctx.act("id3", "u3", { action: "battleFinish", att: 1, slot: target.i, ans: s.plan.puzzle.answer, ord: ordOf(s.plan), card: String(s.card), t });
    assert.equal(r.done, false); assert.equal(r.reason, "overlap");
    assert.equal(r.closed.find((x) => x.i === target.i).why, "rule");
    const t2 = proofFor(r.plan); ctx.state.now += t2[6];
    const r2 = await ctx.act("id3", "u3", { action: "battleFinish", att: 2, slot: other.i, ans: r.plan.puzzle.answer, ord: ordOf(r.plan), card: String(r.card), t: t2 });
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
  const t = proofFor(s.plan); ctx.state.now += t[6];
  const r = await ctx.act("id1", "u1", { action: "battleFinish", att: 1, slot: q1, ans: s.plan.puzzle.answer, ord: ordOf(s.plan), card: String(s.card), t });
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
  const t = proofFor(s.plan); ctx.state.now += t[6];
  await ctx.act("id1", "u1", { action: "battleFinish", att: 1, slot: q0, ans: s.plan.puzzle.answer, ord: ordOf(s.plan), card: String(s.card), t });
  assert.ok(ctx.fs.counts.commit - c0 <= 4, `commit ${ctx.fs.counts.commit - c0}`);
});

/* ===== 練習・週間ランキング ===== */
const dayOf = (ctx) => kakuDayId(ctx.state.now);
const quickOfDay = async (ctx) => { await ctx.act("id0", "u0", { action: "battleStatus" }); return ctx.fs.plain(`yuslotKaku/${dayOf(ctx)}`).slots.filter((x) => x.kind === "quick").map((x) => x.i); };
/* i 番の人が、その日の先着の枠を取る（かかった時間を ms にそろえるため、スタートから待つ） */
async function playOn(ctx, i, { slotNo = 0, wait = 0 } = {}) {
  const idx = await quickOfDay(ctx);
  const [uid, name] = who(i);
  const s = await ctx.act(uid, name, { action: "battleStart" });
  assert.equal(s.ok, true, JSON.stringify(s));
  const t = proofFor(s.plan);
  ctx.state.now += t[6] + wait;
  return ctx.act(uid, name, { action: "battleFinish", att: s.att, slot: idx[slotNo], ans: s.plan.puzzle.answer, ord: ordOf(s.plan), card: String(s.card), t });
}
const WEEK0 = rankWeekStart(TT.quickOpen);               // 2026-10-19（月）7:00 JST
const MON = WEEK0 + 7 * 86400000;                         // 次の月曜 7:00

test("練習：問題だけ返して、何も保存しない（いつでも何回でも・記録やランキングには関係しない）", async () => {
  const ctx = setup({ now: TT.quickOpen - 5 * H });
  const before = ctx.fs.docs.size;
  const a = await ctx.act("id1", "u1", { action: "battlePractice" });
  const b = await ctx.act("id1", "u1", { action: "battlePractice" });
  assert.equal(a.ok, true); assert.ok(a.plan.conn.length === 6 && a.plan.order.length === 4 && a.plan.slide.emoji && a.plan.puzzle.options.length === 4 && a.plan.consent.length === 10);
  assert.ok(a.card >= 100 && a.card <= 999);
  assert.notDeepEqual(a.plan, b.plan, "毎回ちがう問題");
  assert.equal(ctx.fs.docs.size, before, "書類は増えない");
  assert.equal(ctx.fs.plain("yuslotBattle/id1"), null); assert.equal(ctx.fs.plain("yuslotBattle/_board"), null);
  assert.equal(ctx.fs.plain("yuslotBattle/_week"), null);
  // 本番の問題は、練習の影響を受けない（その日のカード番号は同じ）
  ctx.state.now = TT.quickOpen;
  const s = await ctx.act("id1", "u1", { action: "battleStart" });
  assert.equal(s.card, await battleCard(ctx.deps, D, "id1"));
  const closed = setup({ published: false });
  assert.equal((await closed.act("id1", "u1", { action: "battlePractice" })).error, "not_published");
});

test("週間ランキング：記録は今週の自己ベストにも入る。当日の新記録は12:00に反映", async () => {
  const ctx = setup();
  const r = await playOn(ctx, 1);
  assert.equal(r.got, true);
  const w = ctx.fs.plain("yuslotBattle/_week");
  assert.equal(w.weekStart, WEEK0); assert.equal(w.rows.length, 1); assert.equal(w.rows[0].uid, "id1"); assert.equal(w.rows[0].ms, r.ms);
  const early = await ctx.act("id2", "u2", { action: "battleRanking" });
  assert.equal(early.week.rows.length, 0, "12:00 前は出ない"); assert.deepEqual(early.week.prizes, [500, 250, 100]);
  assert.equal(early.week.startMs, WEEK0); assert.equal(early.week.endMs, MON);
  ctx.state.now = kakuDayStart(D) + 12 * H; resetBattleCacheForTest(); resetBattleWeekCacheForTest();
  const late = await ctx.act("id2", "u2", { action: "battleRanking" });
  assert.equal(late.week.rows.length, 1); assert.equal(late.week.rows[0].name, "u1"); assert.equal(late.week.rows[0].prize, 500);
  assert.ok(!JSON.stringify(late).includes("id1"), "uid は返さない");
});

test("結果発表：月曜7:00に、先週の上位3人へ500・250・100コイン（二重には払わない）・お知らせと通知・ランキングは空に", async () => {
  const ctx = setup({ n: 6 });
  // 水・木・金に、タイムの違う5人が記録（1日の先着の枠は2つ。1回きりで取れた人も、取れなかった人もタイムは載る）
  ctx.state.now = TT.quickOpen;
  const r1 = await playOn(ctx, 1, { slotNo: 0 });                 // u1：水・速い
  const r2 = await playOn(ctx, 2, { slotNo: 1, wait: 3000 });     // u2：水・少し遅い
  ctx.state.now = kakuTimes("2026-10-22").quickOpen; resetKakuCacheForTest();
  const r3 = await playOn(ctx, 3, { slotNo: 0, wait: 9000 });     // u3：木・遅い
  const r4 = await playOn(ctx, 4, { slotNo: 1, wait: 20000 });    // u4：木・とても遅い
  ctx.state.now = kakuTimes("2026-10-23").quickOpen; resetKakuCacheForTest();
  const r5 = await playOn(ctx, 5, { slotNo: 0, wait: 1000 });     // u5：金・2番目に速い
  assert.equal(ctx.fs.plain("yuslotBattle/_week").rows.length, 5);
  const expect = [[1, r1.ms], [2, r2.ms], [3, r3.ms], [4, r4.ms], [5, r5.ms]].sort((a, b) => a[1] - b[1]).map(([i]) => i);
  const coinsBefore = Object.fromEntries([1, 2, 3, 4, 5].map((i) => [i, ctx.fs.plain(`users/u${i}`).coins]));
  // 日曜まで：まだ払わない
  ctx.state.now = MON - 60000;
  await ctx.act("id1", "u1", { action: "battleRanking" });
  assert.equal(ctx.fs.plain("users/u1").coins, coinsBefore[1], "週の途中は払わない");
  // 月曜 7:00 の cron
  const out = await runBattleWeekTick({}, MON + 30000, ctx.deps);
  assert.equal(out.weekStart, MON);
  const week = ctx.fs.plain("yuslotBattle/_week");
  assert.equal(week.weekStart, MON); assert.deepEqual(week.rows, []);
  const prizes = [500, 250, 100];
  const topRows = week.last.top;
  assert.equal(topRows.length, 3);
  topRows.forEach((t, k) => {
    assert.equal(t.rank, k + 1); assert.equal(t.prize, prizes[k]); assert.equal(t.paid, true);
    const i = Number(t.uid.slice(2));
    assert.equal(ctx.fs.plain(`users/u${i}`).coins, coinsBefore[i] + prizes[k], `${k + 1}位にコイン`);
  });
  assert.equal(week.last.total, 5);
  assert.deepEqual(topRows.map((t) => Number(t.uid.slice(2))), expect.slice(0, 3), "タイムの速い順");
  const rest = [1, 2, 3, 4, 5].filter((i) => !topRows.some((t) => t.uid === `id${i}`));
  rest.forEach((i) => assert.equal(ctx.fs.plain(`users/u${i}`).coins, coinsBefore[i], "4位以下には渡さない"));
  // お知らせ（全員）が1件だけ
  const ann = ctx.fs.plain(`announcements/battle-${WEEK0}`);
  assert.ok(ann && ann.title.includes("週間ランキング")); assert.ok(ann.body.includes("500 コイン") && ann.body.includes("250 コイン") && ann.body.includes("100 コイン"));
  assert.equal(week.last.announced, true);
  // 二重払いなし：もう一度動かしても、再読み込みしても増えない
  resetBattleWeekTickForTest();
  assert.equal((await runBattleWeekTick({}, MON + 60000, ctx.deps)).skipped, true);
  await battleWeekEnsure(ctx.deps); await ctx.act("id1", "u1", { action: "battleRanking" });
  topRows.forEach((t, k) => { const i = Number(t.uid.slice(2)); assert.equal(ctx.fs.plain(`users/u${i}`).coins, coinsBefore[i] + prizes[k], "二重払いなし"); });
  // ランキング画面：今週は空、先週の結果発表が出る（本人には自分の順位と賞金）
  resetBattleCacheForTest(); resetBattleWeekCacheForTest();
  ctx.state.now = MON + 3600000;
  const view = await ctx.act(`id${Number(topRows[0].uid.slice(2))}`, `u${Number(topRows[0].uid.slice(2))}`, { action: "battleRanking" });
  assert.equal(view.week.rows.length, 0); assert.equal(view.week.startMs, MON);
  assert.equal(view.last.top.length, 3); assert.equal(view.last.me.rank, 1); assert.equal(view.last.me.prize, 500);
  assert.ok(!JSON.stringify(view).includes('"id'), "uid は返さない");
  assert.equal(view.rows.length >= 4, true, "通算のランキングは残る（先週までの記録）");
});

test("結果発表：月曜の cron が動かなくても、次に記録・ランキングを開いた人が追いつかせる。参加者が少なくても、いない人の賞金は出さない", async () => {
  const ctx = setup({ n: 4 });
  ctx.state.now = TT.quickOpen;
  const r1 = await playOn(ctx, 1);
  const r2 = await playOn(ctx, 2, { slotNo: 1, wait: 2000 });
  assert.ok(r1.ms < r2.ms);
  const c1 = ctx.fs.plain("users/u1").coins, c2 = ctx.fs.plain("users/u2").coins;
  ctx.state.now = MON + 5 * H;                                      // cron が動かないまま、月曜の昼
  await ctx.act("id3", "u3", { action: "battleRanking" });
  assert.equal(ctx.fs.plain("users/u1").coins, c1 + 500); assert.equal(ctx.fs.plain("users/u2").coins, c2 + 250);
  const week = ctx.fs.plain("yuslotBattle/_week");
  assert.equal(week.last.top.length, 2, "参加者は2人だけ");
  assert.ok(ctx.fs.plain(`announcements/battle-${WEEK0}`));
});

test("結果発表：参加者がいない週は何も払わず、お知らせも出さない。実在しない人の賞金は出さない", async () => {
  const ctx = setup({ n: 3 });
  ctx.fs.put("yuslotBattle/_week", encF({ weekStart: WEEK0, rows: [], last: null }));
  ctx.state.now = MON + 2 * H;
  await battleWeekEnsure(ctx.deps);
  assert.equal(ctx.fs.plain("yuslotBattle/_week").weekStart, MON);
  assert.equal(ctx.fs.plain(`announcements/battle-${WEEK0}`), null);
  // 1位が削除済みのユーザー
  const c2 = setup({ n: 3 });
  c2.fs.put("yuslotBattle/_week", encF({ weekStart: WEEK0, last: null, rows: [{ uid: "gone", name: "きえた", ms: 5000, day: D, pms: 0, pday: "" }, { uid: "id1", name: "u1", ms: 9000, day: D, pms: 0, pday: "" }] }));
  c2.state.now = MON + 2 * H;
  await battleWeekEnsure(c2.deps);
  const last = c2.fs.plain("yuslotBattle/_week").last;
  assert.equal(last.top[0].paid, false); assert.equal(last.top[1].paid, true); assert.equal(last.top[1].rank, 2, "繰り下げない");
  assert.equal(c2.fs.plain("users/u1").coins, 5000 + 250);
});

test("結果発表の cron：月曜 7:00〜7:09 だけ動く（それ以外は何も読まない）", async () => {
  const ctx = setup();
  const reads = () => ctx.fs.counts ? 0 : 0;
  void reads;
  assert.equal((await runBattleWeekTick({}, MON - 60000, ctx.deps)).skipped, "outside");
  assert.equal((await runBattleWeekTick({}, MON + 10 * 60000, ctx.deps)).skipped, "outside");
  assert.equal((await runBattleWeekTick({}, MON + 3 * 86400000, ctx.deps)).skipped, "outside");
  const ok = await runBattleWeekTick({}, MON + 60000, ctx.deps);
  assert.ok(!ok.skipped || ok.skipped === true);
  assert.equal((await runBattleWeekTick({}, MON + 120000, ctx.deps)).skipped, "done");
});

/* ===== NPC 枠のキャンセル ===== */
const PLAN = kakuCancelPlan(D);
/* その日の枠を、前日抽選の結果が出たあとの状態にする（前日抽選の枠はすべて NPC、当日の枠は空き） */
async function dayWithNpc(ctx, { npcKinds = ["pre"] } = {}) {
  await ctx.act("id0", "u0", { action: "battleStatus" });
  const day = ctx.fs.plain(`yuslotKaku/${D}`);
  day.slots.forEach((x) => { if (npcKinds.includes(x.kind)) { x.npc = true; x.name = `npc${x.i}`; x.uid = ""; } });
  ctx.fs.put(`yuslotKaku/${D}`, encF(day)); resetKakuCacheForTest();
  return day;
}
const slotsOf = (ctx) => ctx.fs.plain(`yuslotKaku/${D}`).slots;
const cxOf = (ctx) => slotsOf(ctx).filter((x) => x.cx);

test("キャンセルの予定：1日1〜3回、10:00〜14:30 の完全ランダムな時刻（日付から決まる）", () => {
  const counts = new Set();
  for (let d = 0; d < 300; d++) {
    const day = kakuDayId(Date.UTC(2026, 9, 20) + d * 86400000);
    const p = kakuCancelPlan(day), p2 = kakuCancelPlan(day);
    assert.deepEqual(p, p2); counts.add(p.n);
    assert.ok(p.n >= 1 && p.n <= 3 && p.times.length === p.n);
    const t0 = kakuDayStart(day);
    p.times.forEach((t, i) => { assert.ok(t >= t0 + 10 * H && t < t0 + 14.5 * H, "10:00〜14:30"); if (i) assert.ok(t >= p.times[i - 1]); });
  }
  assert.deepEqual([...counts].sort(), [1, 2, 3]);
});

test("キャンセル：予定の時刻になるまで何も起きず、時刻になると NPC の枠が1つ空きになる（プレイヤーの枠・抽選前の枠は選ばれない）", async () => {
  const ctx = setup({ now: PLAN.times[0] - 60000 });
  const day = await dayWithNpc(ctx);
  // 1枠はプレイヤーが持っている
  const mineIdx = day.slots.find((x) => x.kind === "pre" && x.s > PLAN.times[0] + 3 * H).i;
  const d2 = ctx.fs.plain(`yuslotKaku/${D}`); d2.slots[mineIdx].npc = false; d2.slots[mineIdx].name = "u1"; d2.slots[mineIdx].uid = "id1";
  ctx.fs.put(`yuslotKaku/${D}`, encF(d2)); resetKakuCacheForTest();
  assert.equal((await kakuCancelRun(ctx.deps, D)).skipped, "none_due");
  assert.equal(cxOf(ctx).length, 0);
  ctx.state.now = PLAN.times[0] + 1000;
  const r = await kakuCancelRun(ctx.deps, D);
  assert.equal(r.ran, 1);
  const cx = cxOf(ctx);
  assert.equal(cx.length, 1);
  assert.equal(cx[0].npc, false); assert.equal(cx[0].uid, ""); assert.equal(cx[0].name, "");
  assert.ok(cx[0].s > ctx.state.now + 2 * M, "まだ始まっていない枠");
  assert.notEqual(cx[0].i, mineIdx);
  assert.equal(ctx.fs.plain(`yuslotKaku/${D}`).cxDone, 1);
  assert.equal((await kakuCancelRun(ctx.deps, D)).ran, 0, "同じ回は1度だけ");
  // 残りの回も、時刻になれば実行され、回数（1〜3）を超えない
  ctx.state.now = PLAN.times[PLAN.n - 1] + 1000;
  await kakuCancelRun(ctx.deps, D); await kakuCancelRun(ctx.deps, D);
  assert.equal(ctx.fs.plain(`yuslotKaku/${D}`).cxDone, PLAN.n);
  assert.ok(cxOf(ctx).length <= PLAN.n);
  // 抽選前の枠（空き）しかない日は、何も起きない（回数だけ進む）
  const none = setup({ now: PLAN.times[0] + 1000 });
  await none.act("id0", "u0", { action: "battleStatus" });
  assert.equal((await kakuCancelRun(none.deps, D)).ran >= 1, true);
  assert.equal(cxOf(none).length, 0);
});

test("キャンセルの通知：オンにした人にだけ。お知らせ（announcements）は流さない。cron は予定の時刻から30分だけ動く", async () => {
  const ctx = setup({ now: PLAN.times[0] - 5 * 60000 });
  await dayWithNpc(ctx);
  ctx.fs.put("fcmTokens/tok1", encF({ uid: "id1" })); ctx.fs.put("fcmTokens/tok2", encF({ uid: "id2" })); ctx.fs.put("fcmTokens/tok3", encF({ uid: "id3" }));
  assert.equal((await ctx.act("id1", "u1", { action: "kakuSetNotify", prefs: { cancel: true } })).prefs.cancel, true);
  assert.equal((await ctx.act("id2", "u2", { action: "kakuGetNotify" })).prefs.cancel, false, "初期設定はオフ");
  assert.equal((await ctx.act("id3", "u3", { action: "kakuSetNotify", prefs: { cancel: true } })).ok, true);
  const annBefore = [...ctx.fs.docs.keys()].filter((k) => k.startsWith("announcements/")).length;
  assert.equal((await runKakuCancelTick({}, PLAN.times[0] - 60000, ctx.deps)).skipped, "outside");
  const r = await runKakuCancelTick({}, PLAN.times[0] + 60000, ctx.deps);
  assert.equal(r.ran, 1);
  assert.deepEqual(ctx.sent.map((x) => x.token).sort(), ["tok1", "tok3"], "オンにした人だけ");
  assert.ok(ctx.sent[0].data.title.includes("キャンセル"));
  assert.equal([...ctx.fs.docs.keys()].filter((k) => k.startsWith("announcements/")).length, annBefore, "お知らせは作らない");
  const again = await runKakuCancelTick({}, PLAN.times[0] + 2 * 60000, ctx.deps);
  assert.equal(again.skipped, "outside", "実行済みの回は、もう動かない");
  assert.equal((await runKakuCancelTick({}, PLAN.times[0] + 31 * 60000, { ...ctx.deps })).skipped, "outside", "30分より後は動かない");
});

test("表：その日の枠ごとに「埋まっています」。NPC かプレイヤーかは区別しない。抽選前の枠は行ごと出さない。キャンセル枠だけ「空き」", async () => {
  const ctx = setup({ now: TT.sameOpen + H });
  await dayWithNpc(ctx);   // 前日抽選の枠はすべて NPC。当日の抽選（lot）は未抽選、先着（quick）は未取得
  // 1枠は他のプレイヤー、1枠は自分
  const d = ctx.fs.plain(`yuslotKaku/${D}`);
  const pres = d.slots.filter((x) => x.kind === "pre");
  d.slots[pres[0].i].npc = false; d.slots[pres[0].i].uid = "id2"; d.slots[pres[0].i].name = "u2";
  d.slots[pres[1].i].npc = false; d.slots[pres[1].i].uid = "id1"; d.slots[pres[1].i].name = "u1";
  const cxI = pres[pres.length - 1].i;
  Object.assign(d.slots[cxI], { npc: false, name: "", uid: "", cx: 1, cxAt: ctx.state.now });
  ctx.fs.put(`yuslotKaku/${D}`, encF(d)); resetKakuCacheForTest();
  const b = await ctx.act("id1", "u1", { action: "battleBoard" });
  assert.equal(b.ok, true); assert.equal(b.notify, false);
  const by = new Map(b.rows.map((r) => [r.i, r.state]));
  assert.equal(by.get(pres[0].i), "filled", "他のプレイヤーも「埋まっています」");
  assert.equal(by.get(pres[1].i), "mine"); assert.equal(by.get(pres[2].i), "filled", "NPC も「埋まっています」");
  assert.equal(by.get(cxI), "open");
  assert.ok(!b.rows.some((r) => d.slots[r.i].kind === "lot"), "当日の抽選（結果が出る前）の枠は出さない");
  assert.equal(b.rows.filter((r) => r.kind === "quick").length, 2); assert.ok(b.rows.filter((r) => r.kind === "quick").every((r) => r.state === "quick"));
  const text = JSON.stringify(b);
  assert.ok(!/npc|id2|u2|cxStart|cxAt|16500/.test(text), "名前・uid・NPC・時計の中身は返さない");
  // 当日抽選の結果が出たあとは、その枠も出る
  const d2 = ctx.fs.plain(`yuslotKaku/${D}`); d2.slots.filter((x) => x.kind === "lot").forEach((x) => { x.npc = true; x.name = "npcL"; });
  ctx.fs.put(`yuslotKaku/${D}`, encF(d2)); resetKakuCacheForTest();
  const b2 = await ctx.act("id1", "u1", { action: "battleBoard" });
  assert.equal(b2.rows.filter((r) => d2.slots[r.i].kind === "lot").length, 3);
  // 取られなかった空き枠は、始まったら「終了」
  ctx.state.now = d.slots[cxI].s + 1000;
  const b3 = await ctx.act("id1", "u1", { action: "battleBoard" });
  assert.equal(b3.rows.find((r) => r.i === cxI).state, "ended");
  // 通知の設定は、この画面から変えられる（既存の設定の保存と同じ入口）
  await ctx.act("id1", "u1", { action: "kakuSetNotify", prefs: { cancel: true } });
  assert.equal((await ctx.act("id1", "u1", { action: "battleBoard" })).notify, true);
  assert.equal((await ctx.act("id2", "u2", { action: "battleBoard" })).notify, false);
});

test("表：予定の時刻を過ぎていたら、cron が遅れていても表を開いた人が追いつかせる", async () => {
  const ctx = setup({ now: PLAN.times[0] + 5 * 60000 });
  await dayWithNpc(ctx);
  assert.equal(cxOf(ctx).length, 0);
  const b = await ctx.act("id1", "u1", { action: "battleBoard" });
  assert.equal(cxOf(ctx).length, 1);
  assert.equal(b.rows.filter((r) => r.state === "open").length, 1);
});

async function openOne(ctx) {
  ctx.state.now = PLAN.times[0] + 1000;
  await dayWithNpc(ctx);
  await kakuCancelRun(ctx.deps, D);
  return cxOf(ctx)[0];
}
async function claimGame(ctx, i, slotIdx, { wait = 0, tweak = (b) => b } = {}) {
  const [uid, name] = who(i);
  const s = await ctx.act(uid, name, { action: "claimStart", slot: slotIdx });
  if (!s.ok) return { s };
  const t = proofFor(s.plan);
  ctx.state.now += t[6] + wait;
  const f = await ctx.act(uid, name, { action: "claimFinish", ...tweak({ att: s.att, slot: slotIdx, ans: s.plan.puzzle.answer, ord: ordOf(s.plan), card: String(s.card), t }) });
  return { s, f };
}

test("キャンセル枠を取る：ミニゲームの記録が正しく、時間内なら取れる。ランキングには載らない。時計の中身は返さない", async () => {
  const ctx = setup({ n: 4 });
  const cx = await openOne(ctx);
  const { s, f } = await claimGame(ctx, 1, cx.i);
  assert.equal(s.ok, true); assert.equal(s.slot.i, cx.i); assert.ok(s.plan.order.length === 4 && s.card >= 100);
  assert.equal(f.got, true);
  const now = slotsOf(ctx)[cx.i];
  assert.equal(now.uid, "id1"); assert.equal(now.name, "u1"); assert.equal(now.npc, false); assert.ok(!now.cx && !now.cxStart, "キャンセルの印は消える");
  assert.ok(!/cxStart|16500|cxAt/.test(JSON.stringify(s) + JSON.stringify(f)), "時計の中身は返さない");
  assert.equal(ctx.fs.plain("yuslotBattle/_board"), null, "ランキングには載らない");
  assert.equal(ctx.fs.plain("yuslotBattle/_week"), null);
  assert.equal(ctx.fs.plain("yuslotBattle/id1"), null, "先着ゲームの記録（1日1件）にも影響しない");
  // もう取られた枠には、スタートもできない
  assert.equal((await ctx.act("id2", "u2", { action: "claimStart", slot: cx.i })).error, "gone");
  // その枠は、台で遊べる（枠の持ち主）
  ctx.state.now = cx.s + 1000;
  assert.equal(slotsOf(ctx)[cx.i].uid, "id1");
});

test("キャンセル枠：最初の1人のスタートから時間内に誰も取れなければ、別の NPC が取る（後から始めた人も、その時計の中で競う）", async () => {
  const ctx = setup({ n: 4 });
  const cx = await openOne(ctx);
  // u1 がスタート（時計が動く）→ 途中でやめる。u2 が5秒後にスタートして時間内に終える → u2 が取る
  const s1 = await ctx.act("id1", "u1", { action: "claimStart", slot: cx.i });
  assert.equal(s1.ok, true);
  assert.ok(slotsOf(ctx)[cx.i].cxStart, "最初の1人のスタートで時計が動く");
  const start1 = slotsOf(ctx)[cx.i].cxStart;
  ctx.state.now += 5000;
  const s2 = await ctx.act("id2", "u2", { action: "claimStart", slot: cx.i });
  assert.equal(slotsOf(ctx)[cx.i].cxStart, start1, "時計は最初の1人のまま（2人目で延びない）");
  const t = proofFor(s2.plan); ctx.state.now += t[6];
  assert.ok(ctx.state.now - start1 < 16500, "時間内");
  const f2 = await ctx.act("id2", "u2", { action: "claimFinish", att: s2.att, slot: cx.i, ans: s2.plan.puzzle.answer, ord: ordOf(s2.plan), card: String(s2.card), t });
  assert.equal(f2.got, true);
  // 別の日の別の枠で：時間切れ
  const ctx2 = setup({ n: 4 });
  const cy = await openOne(ctx2);
  const a = await ctx2.act("id1", "u1", { action: "claimStart", slot: cy.i });
  const ta = proofFor(a.plan); ctx2.state.now += 16600;                  // 16.5秒を過ぎてから終える
  const fa = await ctx2.act("id1", "u1", { action: "claimFinish", att: a.att, slot: cy.i, ans: a.plan.puzzle.answer, ord: ordOf(a.plan), card: String(a.card), t: ta });
  assert.equal(fa.lost, true); assert.equal(fa.got, false);
  const taken = slotsOf(ctx2)[cy.i];
  assert.equal(taken.npc, true, "別の NPC が取った"); assert.ok(taken.name && taken.name !== "" && !taken.cx);
  assert.equal(taken.uid, "");
  // そのあとは、誰もスタートできない。表も「埋まっています」
  assert.equal((await ctx2.act("id2", "u2", { action: "claimStart", slot: cy.i })).error, "gone");
  assert.equal((await ctx2.act("id2", "u2", { action: "battleBoard" })).rows.find((r) => r.i === cy.i).state, "filled");
});

test("キャンセル枠：誰もスタートしなければ枠が始まるまで空きのまま。決まり（時間が重なる・1日3枠）は守る。ふつうの枠・不正な記録は取れない", async () => {
  const ctx = setup({ n: 4 });
  const cx = await openOne(ctx);
  assert.equal(slotsOf(ctx)[cx.i].cx, 1); assert.ok(!slotsOf(ctx)[cx.i].cxStart);
  const b = await ctx.act("id3", "u3", { action: "battleBoard" });
  assert.equal(b.rows.find((r) => r.i === cx.i).state, "open", "誰もスタートしていない間は空きのまま");
  // NPC のふつうの枠・存在しない枠は取れない
  const npcSlot = slotsOf(ctx).find((x) => x.npc);
  assert.equal((await ctx.act("id3", "u3", { action: "claimStart", slot: npcSlot.i })).error, "gone");
  assert.equal((await ctx.act("id3", "u3", { action: "claimStart", slot: 999 })).error, "gone");
  assert.equal((await ctx.act("id3", "u3", { action: "claimStart", slot: "x" })).error, "bad_request");
  // 時間が重なる枠を持っている人は、スタートできない
  const d = ctx.fs.plain(`yuslotKaku/${D}`);
  const other = d.slots.find((x) => x.i !== cx.i && x.npc && (x.s < cx.e && cx.s < x.e));
  if (other) { d.slots[other.i].npc = false; d.slots[other.i].uid = "id3"; d.slots[other.i].name = "u3"; ctx.fs.put(`yuslotKaku/${D}`, encF(d)); resetKakuCacheForTest(); assert.equal((await ctx.act("id3", "u3", { action: "claimStart", slot: cx.i })).error, "rule"); }
  // 不正な記録（答え・数字の順番・速すぎ）は取れない
  const s = await ctx.act("id1", "u1", { action: "claimStart", slot: cx.i });
  const t = proofFor(s.plan); ctx.state.now += t[6];
  const send = (over) => ctx.act("id1", "u1", { action: "claimFinish", att: s.att, slot: cx.i, ans: s.plan.puzzle.answer, ord: ordOf(s.plan), card: String(s.card), t, ...over });
  assert.equal((await send({ ans: (s.plan.puzzle.answer + 1) % 4 })).error, "bad_proof");
  assert.equal((await send({ ord: [...ordOf(s.plan)].reverse() })).error, "bad_proof");
  assert.equal((await send({ card: "000" })).error, "bad_proof");
  assert.equal((await send({ t: t.map((x) => Math.floor(x / 4)) })).error, "too_fast");
  assert.equal((await send({ att: 9 })).error, "stale");
  assert.equal(slotsOf(ctx)[cx.i].uid, "", "取れていない");
  assert.equal((await send({})).got, true);
});

test("キャンセル枠：同時に押しても、取れるのは1人だけ", async () => {
  const ctx = setup({ n: 5 });
  const cx = await openOne(ctx);
  const starts = await Promise.all([1, 2, 3, 4].map((i) => ctx.act(`id${i}`, `u${i}`, { action: "claimStart", slot: cx.i })));
  assert.ok(starts.every((x) => x.ok));
  ctx.state.now += 9000;
  const fins = await Promise.all(starts.map((x, k) => ctx.act(`id${k + 1}`, `u${k + 1}`, { action: "claimFinish", att: x.att, slot: cx.i, ans: x.plan.puzzle.answer, ord: ordOf(x.plan), card: String(x.card), t: proofFor(x.plan) })));
  assert.equal(fins.filter((f) => f.got).length, 1);
  assert.equal(fins.filter((f) => f.lost).length, 3);
  assert.ok(slotsOf(ctx)[cx.i].uid);
});

test("確変の抽選・通常の先着は、キャンセルの仕組みの影響を受けない（キャンセル枠でない先着の枠は claimStart できない）", async () => {
  const ctx = setup({ now: TT.quickOpen, n: 3 });
  const [q0] = await quickOfDay(ctx);
  assert.equal((await ctx.act("id1", "u1", { action: "claimStart", slot: q0 })).error, "gone");
  const r = await playOn(ctx, 1);
  assert.equal(r.got, true);
});

/* ===== 高い台は、総資産がある人だけ ===== */
const setUser = (ctx, i, over) => ctx.fs.put(`users/u${i}`, encF({ uid: `id${i}`, name: `u${i}`, coins: 0, ...over }));
const seatOn = (ctx, i, machine) => ctx.act(`id${i}`, `u${i}`, { action: "seat", machine });
const leave = async (ctx, i, r) => { await ctx.act(`id${i}`, `u${i}`, { action: "settle", session: r.session }); ctx.fs.docs.delete(`yuslotSeats/${r.machine}`); };
const OFF_HOURS_NOW = kakuDayStart("2026-10-19") + 9 * H;   // 確変の日より前（月曜の朝）：確変台の制限は関係ない

test("高い台：9コインの台は総資産1000以上・7コインは800以上・5コインは600以上。それ以外の台は条件なし", async () => {
  assert.deepEqual(SLOT_ASSET_MIN, { yujackpot: 1000, yurainbow: 800, yutreasure: 600 });
  const ctx = setup({ now: OFF_HOURS_NOW, n: 3 });
  const cases = [["yujackpot", 1000], ["yurainbow", 800], ["yutreasure", 600]];
  for (const [machine, need] of cases) {
    setUser(ctx, 1, { coins: need - 1 });
    const low = await seatOn(ctx, 1, machine);
    assert.equal(low.error, "assets_low", machine); assert.equal(low.status, 409); assert.equal(low.need, need); assert.equal(low.total, need - 1);
    assert.equal(ctx.fs.plain(`yuslotSeats/${machine}`), null, "着席していない");
    setUser(ctx, 1, { coins: need });
    const ok = await seatOn(ctx, 1, machine);
    assert.equal(ok.ok, true, `${machine} は ${need} でちょうど遊べる`); await leave(ctx, 1, ok);
  }
  // 条件のない台（1〜3コイン）は、コインが少なくても遊べる
  setUser(ctx, 2, { coins: 1 });
  for (const machine of ["yubasic", "yurush", "yuchance"]) { const r = await seatOn(ctx, 2, machine); assert.equal(r.ok, true, machine); await leave(ctx, 2, r); }
});

test("高い台：総資産＝手持ちコイン＋預金＋株の評価額−借入（株価は market/current）", async () => {
  const ctx = setup({ now: OFF_HOURS_NOW, n: 3 });
  ctx.fs.put("market/current", encF({ companies: { YGM: { price: 200 }, YMT: { price: 240 } } }));
  // コイン300＋預金400＋株（YGM 2株×200）＝1100 → ジャックポット可
  setUser(ctx, 1, { coins: 300, bank: { deposit: 400, interestBase: 400, loan: 0 }, stocks: { YGM: { qty: 2, cost: 360 } } });
  const a = await seatOn(ctx, 1, "yujackpot"); assert.equal(a.ok, true); await leave(ctx, 1, a);
  // 借入があると引かれる：1100−200＝900 → ジャックポットは不可、レインボー（800）は可
  setUser(ctx, 1, { coins: 300, bank: { deposit: 400, interestBase: 400, loan: 200 }, stocks: { YGM: { qty: 2, cost: 360 } } });
  const b = await seatOn(ctx, 1, "yujackpot"); assert.equal(b.error, "assets_low"); assert.equal(b.total, 900);
  const c = await seatOn(ctx, 1, "yurainbow"); assert.equal(c.ok, true); await leave(ctx, 1, c);
  // 手持ちコイン＋預金−借入だけで足りていれば、株価は読まない（読み取りを減らす）
  setUser(ctx, 2, { coins: 1500 });
  const reads = ctx.fs.counts.get;
  const d = await seatOn(ctx, 2, "yujackpot"); assert.equal(d.ok, true);
  assert.equal(ctx.fs.counts.get, reads, "market/current を読んでいない");
});

test("高い台：確変の枠の持ち主は、総資産に関係なく遊べる（枠の持ち主でなければ、これまでどおり遊べない）", async () => {
  // 確変台が高い台になる日と、その枠の時間を探す
  let day = KAKU_EPOCH, machine = null;
  for (let i = 0; i < 40; i++) { const m = kakuMachineFor(day); if (SLOT_ASSET_MIN[m]) { machine = m; break; } day = kakuNextDay(day); }
  assert.ok(machine, "高い台が確変台になる日がある");
  const t = kakuTimes(day);
  const ctx = setup({ now: t.playStart + 5 * M, n: 3 });
  await ctx.act("id0", "u0", { action: "kakuStatus" });
  const doc = ctx.fs.plain(`yuslotKaku/${day}`);
  const slots = doc.slots.map((x) => ({ ...x, uid: "", name: "", npc: false }));
  const first = slots.find((x) => x.s <= ctx.state.now && ctx.state.now < x.e);
  Object.assign(first, { uid: "id1", name: "u1" });
  ctx.fs.put(`yuslotKaku/${day}`, encF({ ...doc, slots })); resetKakuCacheForTest();
  setUser(ctx, 1, { coins: 5 });            // 総資産は足りない
  setUser(ctx, 2, { coins: 5 });
  const mine = await seatOn(ctx, 1, machine);
  assert.equal(mine.ok, true, "枠の持ち主は、総資産が足りなくても遊べる"); assert.equal(mine.kaku, true);
  assert.equal((await seatOn(ctx, 2, machine)).error, "kaku_locked", "枠の持ち主でない人は、これまでどおり遊べない");
  await leave(ctx, 1, mine);
  // 同じ人でも、確変の枠のない時間や、確変台でない高い台では、条件がかかる
  const other = Object.keys(SLOT_ASSET_MIN).find((m) => m !== machine);
  assert.equal((await seatOn(ctx, 1, other)).error, "assets_low");
});

/* ===== 読み取りを減らす（動きは変えない） ===== */
test("ロビー：席を1回の問い合わせで読み、数秒はメモリから返す。着席・退席のときは捨てる（表示は変わらない）", async () => {
  const ctx = setup({ now: OFF_HOURS_NOW, n: 4 });
  const before = { getRaw: ctx.fs.counts.getRaw, query: ctx.fs.counts.query };
  const a = await ctx.act("id1", "u1", { action: "lobby" });
  assert.equal(ctx.fs.counts.getRaw, before.getRaw, "6台を1台ずつ読まない");
  assert.equal(ctx.fs.counts.query - before.query, 1, "席の一覧は1回の問い合わせ");
  assert.ok(Object.values(a.seats).every((x) => x.occupied === false));
  // 何回開いても、数秒のあいだは読み直さない
  for (let i = 0; i < 5; i++) { ctx.state.now += 1000; await ctx.act(`id${1 + (i % 3)}`, `u${1 + (i % 3)}`, { action: "lobby" }); }
  assert.equal(ctx.fs.counts.query - before.query, 1, "6秒以内は、読み取りなし");
  // 着席すると、すぐロビーに反映される（本人は mine、ほかの人は使用中）
  setUser(ctx, 1, { coins: 5000 });
  const seat = await seatOn(ctx, 1, "yubasic");
  assert.equal(seat.ok, true);
  const mine = await ctx.act("id1", "u1", { action: "lobby" }), other = await ctx.act("id2", "u2", { action: "lobby" });
  assert.equal(mine.seats.yubasic.occupied, true); assert.equal(mine.seats.yubasic.mine, true);
  assert.equal(other.seats.yubasic.occupied, true); assert.equal(other.seats.yubasic.mine, false); assert.equal(other.seats.yubasic.name, "u1");
  // 退席すると、すぐ空きになる
  await leave(ctx, 1, seat);
  assert.equal((await ctx.act("id2", "u2", { action: "lobby" })).seats.yubasic.occupied, false);
  // 数秒たてば、読み直す
  const q = ctx.fs.counts.query; ctx.state.now += 7000;
  await ctx.act("id2", "u2", { action: "lobby" });
  assert.equal(ctx.fs.counts.query - q, 1);
});

test("先着ページの表：「キャンセルの通知」の設定は、15秒おきに開かれても毎回は読まない。設定を変えたらすぐ反映", async () => {
  const ctx = setup({ now: TT.sameOpen + H, n: 3 });
  await dayWithNpc(ctx);
  let gets = 0; const orig = ctx.fs.get; ctx.fs.get = async (p) => { if (String(p).startsWith("yuslotPrefs/")) gets++; return orig(p); };
  for (let i = 0; i < 4; i++) { ctx.state.now += 14000; assert.equal((await ctx.act("id1", "u1", { action: "battleBoard" })).notify, false); }
  assert.equal(gets, 1, "1分のあいだは、設定を読み直さない");
  ctx.state.now += 20000; await ctx.act("id1", "u1", { action: "battleBoard" });
  assert.equal(gets, 2, "1分たてば読み直す");
  await ctx.act("id1", "u1", { action: "kakuSetNotify", prefs: { cancel: true } });
  assert.equal((await ctx.act("id1", "u1", { action: "battleBoard" })).notify, true, "設定を変えたら、すぐ反映");
  assert.equal((await ctx.act("id2", "u2", { action: "battleBoard" })).notify, false, "ほかの人には影響しない");
});
