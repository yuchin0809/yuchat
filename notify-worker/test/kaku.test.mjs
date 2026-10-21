/* 🌈 ゆうスロ確変台（worker.js の kaku*）のテスト
   実行：node --test "notify-worker/test/*.test.mjs" */
import test from "node:test";
import { simulate } from "../yuslot-kaku-sim.mjs";
import assert from "node:assert/strict";
import {
  KAKU_EPOCH, KAKU_MACHINE_NAMES, kakuDayId, kakuDayStart, kakuNextDay, kakuTimes, kakuMachineFor, kakuSameKinds, kakuInitialSlots, kakuNpcName,
  kakuCurrentHolder, kakuIsWeekend, kakuPoolFor, kakuPickWinners, kakuStanding, kakuRunDraw, kakuRunEvent, kakuSeatRight, kakuSpinGate, kakuResultDataFor, runKakuTick, resetKakuCacheForTest,
  handleAdminAction, handleYuslotAction, kakuQuick, resetYuslotCacheForTest, slotApplySpin, slotRates, SLOT_MACHINES, SLOT_KAKU_RATE, SLOT_KAKU_SPECIAL_BOOST
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
const rngOf = (seed) => { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; };
const D = "2026-10-21";                                  // 確変の2日目（前日の抽選がある日）
const TT = kakuTimes(D), T1 = kakuTimes("2026-10-20");
const H = 3600000, M = 60000;
function setup({ now = TT.preOpen + H, random = rngOf(11), users, published = true } = {}) {
  resetKakuCacheForTest(); resetYuslotCacheForTest();
  const base = { "worldConfig/yuslot": { yuslotPublished: published } };
  const u = users || Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`u${i}`, { uid: `id${i}`, name: `u${i}`, coins: 5000 }]));
  Object.entries(u).forEach(([n, d]) => { base[`users/${n}`] = d; });
  const fs = fakeFs(base);
  const sent = [];
  const state = { now };
  const deps = { firestore: fs, adminUid: ADMIN, random, now: () => state.now, slotSecret: "s", sendFcm: async (token, data) => { sent.push({ token, data }); return { ok: true }; } };
  // 先着は、ゲーム（battle*）を通らないと買えない。ここでは枠の割り当て（kakuQuick）そのものを直接呼ぶ
  const act = (uid, name, body) => body.action === "kakuQuick" ? kakuQuick(deps, uid, { ...body, username: name }) : handleYuslotAction(deps, uid, { ...body, username: name });
  return { fs, deps, state, act, sent };
}

test("確変台：日付だけで決まり、前日と同じ台にならず、6台すべてが出る", () => {
  assert.equal(kakuMachineFor("2026-10-19"), null, "最初の日より前は確変なし");
  const ids = Object.keys(SLOT_MACHINES);
  let d = KAKU_EPOCH, prev = null; const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const m = kakuMachineFor(d);
    assert.ok(ids.includes(m)); assert.notEqual(m, prev, `${d} が前日と同じ`);
    assert.equal(kakuMachineFor(d), m, "同じ日は何度聞いても同じ");
    seen.add(m); prev = m; d = kakuNextDay(d);
  }
  assert.equal(seen.size, 6);
  assert.ok(Object.keys(SLOT_KAKU_RATE).every((k) => ids.includes(k) && SLOT_KAKU_RATE[k] > 1));
  assert.ok(SLOT_KAKU_RATE.yubasic > SLOT_KAKU_RATE.yujackpot, "高い台ほど倍率は小さい");
  assert.ok(ids.every((id) => KAKU_MACHINE_NAMES[id]));
});

test("時間割：8:00〜15:20 を18枠（30分×9＋10分×5＋30分×4）で隙間なく埋める。先着2・抽選3はランダム", () => {
  const slots = kakuInitialSlots(D);
  assert.equal(slots.length, 18);
  assert.equal(slots[0].s, TT.playStart); assert.equal(slots[17].e, TT.playEnd);
  slots.forEach((x, i) => { assert.equal(x.i, i); if (i) assert.equal(x.s, slots[i - 1].e, "隙間も重なりもない"); });
  assert.equal(slots.filter((x) => x.kind === "pre").length, 13);
  assert.equal(slots.filter((x) => x.kind === "lot").length, 3); assert.equal(slots.filter((x) => x.kind === "quick").length, 2);
  assert.ok(slots.filter((x) => x.kind !== "pre").every((x) => x.e - x.s === 10 * M && x.s >= kakuDayStart(D) + 12.5 * H && x.e <= kakuDayStart(D) + 13 * H + 20 * M), "当日分は12:30〜13:20の10分枠");
  assert.ok(slots.filter((x) => x.kind === "pre").every((x) => x.e - x.s === 30 * M));
  const patterns = new Set(); let d = KAKU_EPOCH; for (let i = 0; i < 30; i++) { patterns.add(kakuSameKinds(d).join()); d = kakuNextDay(d); }
  assert.ok(patterns.size >= 4, "先着になる時間は日ごとに変わる");
  assert.equal(TT.preOpen, kakuDayStart(D) - 12 * H); assert.equal(TT.preClose, kakuDayStart(D) - 3 * H);
  assert.equal(TT.sameOpen, kakuDayStart(D) + 7 * H); assert.equal(TT.sameClose, kakuDayStart(D) + 10.75 * H); assert.equal(TT.quickOpen, kakuDayStart(D) + 11.75 * H);
});

test("抽選の重み：実在の申込者が当たるのは約1/3。同じ人が2枠当たるのはまれ・3枠はほぼ無し・最大3枠", () => {
  const rng = rngOf(2026);
  const apps = (n) => Array.from({ length: n }, (_, i) => ({ uid: `r${i}`, name: `r${i}` }));
  for (const [A, pool, cnt] of [[3, 39, 13], [8, 39, 13], [20, 39, 13], [3, 9, 3], [6, 9, 3]]) {
    let winnersReal = 0, applicantsWon = 0, two = 0, three = 0, N = 3000;
    for (let t = 0; t < N; t++) {
      const w = kakuPickWinners({ applicants: apps(A), poolTarget: pool, count: cnt, random: rng, dayId: D });
      assert.equal(w.length, cnt);
      const c = new Map(); w.filter((x) => !x.npc).forEach((x) => c.set(x.uid, (c.get(x.uid) || 0) + 1));
      applicantsWon += c.size; winnersReal += w.filter((x) => !x.npc).length;
      for (const n of c.values()) { assert.ok(n <= 3); if (n === 2) two++; if (n === 3) three++; }
    }
    const rate = applicantsWon / (A * N);
    assert.ok(rate > 0.25 && rate < 0.42, `申込${A}人・枠${cnt}：当たる割合 ${rate.toFixed(2)}（約1/3）`);
    assert.ok(two / Math.max(1, applicantsWon) < 0.15, `2枠の割合 ${(two / applicantsWon).toFixed(3)}`);
    assert.ok(three / Math.max(1, applicantsWon) < 0.02, `3枠の割合 ${(three / applicantsWon).toFixed(4)}`);
  }
  const many = kakuPickWinners({ applicants: apps(100), poolTarget: 39, count: 13, random: rng, dayId: D });
  assert.ok(many.every((x) => !x.npc), "申込が多い日は実在の人だけで埋まる（NPCは混ぜない）");
  assert.ok(kakuNpcName(D, 0)); assert.equal(new Set(Array.from({ length: 39 }, (_, i) => kakuNpcName(D, i))).size, 39, "NPCの名前は重ならない");
  const prior = new Map([["r0", 3]]);
  const capped = kakuPickWinners({ applicants: apps(3), poolTarget: 3, count: 6, wins: prior, random: rng, dayId: D });
  assert.ok(!capped.some((x) => x.uid === "r0"), "すでに3枠の人は当たらない");
});

test("抽選の重み：小さな差がつく（全体の当選割合は変わらない）。データが無ければ全員同じ", async () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ name: `r${i}`, total: (10 - i) * 1000 }));
  const st = kakuStanding(rows, ["r0", "r9", "新人"]);
  assert.equal(st.get("r0"), 0); assert.equal(st.get("r9"), 1); assert.equal(st.get("新人"), 0.5);
  assert.equal(kakuStanding(rows.map((r) => ({ ...r, total: 5 })), ["r3"]).get("r3"), 0.5);
  const rng = rngOf(55);
  const apps = rows.map((r) => ({ uid: r.name, name: r.name }));
  const won = new Map(); let real = 0, flat = 0; const N = 8000;
  for (let t = 0; t < N; t++) {
    kakuPickWinners({ applicants: apps, poolTarget: 65, count: 13, random: rng, dayId: D, standing: st }).filter((x) => !x.npc).forEach((x) => { won.set(x.uid, (won.get(x.uid) || 0) + 1); real++; });
    flat += kakuPickWinners({ applicants: apps, poolTarget: 65, count: 13, random: rng, dayId: D }).filter((x) => !x.npc).length;
  }
  const hi = won.get("r0") || 0, lo = won.get("r9") || 0;
  assert.ok(lo > hi && lo / hi < 1.8, `差は小さい（${(lo / hi).toFixed(2)}倍）`);
  assert.ok(Math.abs(real - flat) / flat < 0.06, `全体の当選数は変わらない（${real} / ${flat}）`);
});

test("申込の受付時間：前日12:00〜21:00（前日抽選）／当日7:00〜10:45（当日抽選）。二重申込は1回、時間外は断る", async () => {
  const { act, state, fs } = setup({ now: TT.preOpen - 1 });
  assert.equal((await act("id0", "u0", { action: "kakuApply", which: "pre" })).error, "not_open", "12:00前");
  state.now = TT.preOpen + M;
  assert.equal((await act("id0", "u0", { action: "kakuApply", which: "pre" })).ok, true);
  assert.equal((await act("id0", "u0", { action: "kakuApply", which: "pre" })).already, true, "二重申込は何も増えない");
  assert.equal((await act("id1", "u1", { action: "kakuApply", which: "pre" })).ok, true);
  assert.equal(fs.plain(`yuslotKaku/${D}`).app1.length, 2);
  assert.equal(fs.plain(`yuslotKaku/${D}`).machine, kakuMachineFor(D));
  state.now = TT.preClose;
  assert.equal((await act("id2", "u2", { action: "kakuApply", which: "pre" })).error, "not_open", "21:00で締切");
  assert.equal((await act("id2", "u2", { action: "kakuApply", which: "same" })).error, "not_open", "当日分はまだ");
  state.now = TT.sameOpen - 1; assert.equal((await act("id2", "u2", { action: "kakuApply", which: "same" })).error, "not_open");
  state.now = TT.sameOpen;
  assert.equal((await act("id2", "u2", { action: "kakuApply", which: "same" })).ok, true);
  state.now = TT.sameClose; assert.equal((await act("id3", "u3", { action: "kakuApply", which: "same" })).error, "not_open", "10:45で締切");
  // 非公開中は一般ユーザーは申し込めない
  const p = setup({ now: TT.preOpen + M, published: false });
  assert.equal((await p.act("id0", "u0", { action: "kakuApply", which: "pre" })).status, 403);
});

test("前日の抽選：21:00に13枠が決まり、NPCが混ざり、1人最大3枠。もう一度実行しても変わらない", async () => {
  const { act, state, fs, deps } = setup({ now: TT.preOpen + M, random: rngOf(5) });
  for (let i = 0; i < 6; i++) await act(`id${i}`, `u${i}`, { action: "kakuApply", which: "pre" });
  state.now = TT.preClose;
  const r = await kakuRunDraw(deps, D, 1);
  assert.equal(r.drawn, true); assert.equal(r.applicants, 6);
  const doc = fs.plain(`yuslotKaku/${D}`);
  const pre = doc.slots.filter((x) => x.kind === "pre");
  assert.equal(pre.length, 13); assert.ok(pre.every((x) => x.name), "13枠すべて埋まる（実在かNPC）");
  assert.ok(pre.some((x) => x.npc), "申込が少ないのでNPCが混ざる"); assert.ok(pre.filter((x) => x.npc).every((x) => x.uid === ""));
  const per = new Map(); pre.filter((x) => x.uid).forEach((x) => per.set(x.uid, (per.get(x.uid) || 0) + 1));
  assert.ok([...per.values()].every((n) => n <= 3));
  assert.equal(doc.draw1Done, true);
  const snapshot = JSON.stringify(doc.slots);
  assert.equal((await kakuRunDraw(deps, D, 1)).skipped, "done");
  assert.equal(JSON.stringify(fs.plain(`yuslotKaku/${D}`).slots), snapshot, "再実行しても結果は変わらない");
});

test("当日の抽選と先着：10:45に3枠、11:45から先着2枠（1人1枠・早い者勝ち・始まった枠は不可）", async () => {
  const { act, state, fs, deps } = setup({ now: TT.sameOpen + M, random: rngOf(9) });
  for (let i = 0; i < 4; i++) await act(`id${i}`, `u${i}`, { action: "kakuApply", which: "same" });
  state.now = TT.sameClose;
  assert.equal((await kakuRunDraw(deps, D, 2)).drawn, true);
  let doc = fs.plain(`yuslotKaku/${D}`);
  const lots = doc.slots.filter((x) => x.kind === "lot"), quicks = doc.slots.filter((x) => x.kind === "quick");
  assert.equal(lots.length, 3); assert.ok(lots.every((x) => x.name)); assert.ok(quicks.every((x) => !x.name), "先着はまだ空き");
  assert.equal(doc.slots.filter((x) => x.kind === "pre").every((x) => !x.name), true, "前日の抽選の枠には触れない");
  // 先着
  state.now = TT.quickOpen - 1;
  assert.equal((await act("id5", "u5", { action: "kakuQuick", slot: quicks[0].i })).error, "not_open");
  state.now = TT.quickOpen;
  const a = await act("id5", "u5", { action: "kakuQuick", slot: quicks[0].i });
  assert.equal(a.ok, true);
  assert.equal((await act("id4", "u4", { action: "kakuQuick", slot: quicks[0].i })).error, "taken", "早い者勝ち");
  assert.equal((await act("id5", "u5", { action: "kakuQuick", slot: quicks[1].i })).error, "quick_limit", "先着は1人1枠");
  assert.equal((await act("id4", "u4", { action: "kakuQuick", slot: lots[0].i })).status, 400, "先着でない枠は取れない");
  const b = await act("id4", "u4", { action: "kakuQuick", slot: quicks[1].i });
  assert.equal(b.ok, true);
  doc = fs.plain(`yuslotKaku/${D}`);
  assert.equal(doc.slots[quicks[0].i].uid, "id5"); assert.equal(doc.slots[quicks[1].i].uid, "id4");
  // 始まった枠は取れない
  const fresh = setup({ now: TT.quickOpen }); await kakuRunDraw(fresh.deps, D, 2);
  const q = fresh.fs.plain(`yuslotKaku/${D}`).slots.filter((x) => x.kind === "quick")[0];
  fresh.state.now = q.s;
  assert.equal((await fresh.act("id1", "u1", { action: "kakuQuick", slot: q.i })).error, "slot_started");
});

test("着席の制限：確変台は、その時間の枠をとった人だけ。NPC・空き枠は誰も遊べない。ほかの台・8:00前・15:20以降は通常", async () => {
  const { act, state, fs, deps } = setup({ now: TT.preOpen + M, random: rngOf(3) });
  const machine = kakuMachineFor(D), other = Object.keys(SLOT_MACHINES).find((m) => m !== machine);
  await act("id0", "u0", { action: "kakuApply", which: "pre" });
  state.now = TT.preClose; await kakuRunDraw(deps, D, 1);
  // 自分の枠を手で決めて確かめる（u0 に 9:00〜9:30 と 9:30〜10:00 の連続2枠、10:00〜10:30 は NPC、10:30〜は空き）
  const doc = fs.plain(`yuslotKaku/${D}`);
  const slots = doc.slots.map((x) => ({ ...x, uid: "", name: "", npc: false }));
  const byStart = (h, m) => slots.find((x) => x.s === TT.dayStart + (h * 60 + m) * M);
  Object.assign(byStart(9, 0), { uid: "id0", name: "u0" }); Object.assign(byStart(9, 30), { uid: "id0", name: "u0" });
  Object.assign(byStart(10, 0), { uid: "", name: "ほしぞら", npc: true });
  fs.put(`yuslotKaku/${D}`, encF({ ...doc, slots })); resetKakuCacheForTest();
  const at = (h, m = 0) => TT.dayStart + (h * 60 + m) * M;

  state.now = at(7, 30);   assert.equal((await act("id1", "u1", { action: "seat", machine })).ok, true, "8:00前は通常の台");
  await act("id1", "u1", { action: "settle", session: (await act("id1", "u1", { action: "seat", machine })).session });
  fs.docs.delete(`yuslotSeats/${machine}`);
  state.now = at(8, 30);   const locked = await act("id1", "u1", { action: "seat", machine });
  assert.equal(locked.error, "kaku_locked"); assert.equal(locked.status, 409);
  assert.equal((await act("id1", "u1", { action: "seat", machine: other })).ok, true, "ほかの台は通常どおり");
  state.now = at(9, 10);
  assert.equal((await act("id1", "u1", { action: "seat", machine })).error, "kaku_locked", "枠の持ち主以外は不可");
  const seat = await act("id0", "u0", { action: "seat", machine });
  assert.equal(seat.ok, true); assert.equal(seat.kaku, true); assert.equal(seat.kakuEnd, at(10, 0), "連続する自分の枠の終わりまで");
  // スピン：枠の中はOK、枠の終わりを過ぎたら断る（精算はできる）
  state.now = at(9, 59);   assert.equal((await act("id0", "u0", { action: "spin", session: seat.session })).ok, true);
  state.now = at(10, 0);   const over = await act("id0", "u0", { action: "spin", session: seat.session });
  assert.equal(over.error, "kaku_over"); assert.equal(over.mustSettle, true);
  const stl = await act("id0", "u0", { action: "settle", session: seat.session });
  assert.equal(stl.ok, true, "終わったあとも精算はできる");
  state.now = at(10, 10);  assert.equal((await act("id1", "u1", { action: "seat", machine })).error, "kaku_locked", "NPCの枠は誰も遊べない");
  state.now = at(10, 40);  assert.equal((await act("id1", "u1", { action: "seat", machine })).error, "kaku_locked", "空き枠も誰も遊べない");
  state.now = at(15, 20);  assert.equal((await act("id1", "u1", { action: "seat", machine })).ok, true, "15:20以降は通常の台");
  // 通常の席のまま8:00を過ぎたら、スピンは断る
  const dayless = { machine, kaku: false };
  assert.equal(kakuSpinGate(dayless, at(8, 1)), "over"); assert.equal(kakuSpinGate(dayless, at(7, 59)), null); assert.equal(kakuSpinGate({ machine: other }, at(8, 1)), null);
});

test("確変の還元率：30分（約900スピン）の平均収支は、どの台も +700〜+1,500 コイン（大当たりを1.5倍にしたあと）。高い台ほど倍率は小さい。通常のセッションは変わらない", () => {
  const rng = rngOf(77);
  for (const m of Object.keys(SLOT_MACHINES)) {
    const r = simulate(m, SLOT_KAKU_RATE[m], rng, 1500);
    assert.ok(r.mean >= 700 && r.mean <= 1500, `${m}: 平均 ${r.mean.toFixed(0)}（700〜1500）`);
    const normal = simulate(m, 0, rng, 1500);
    assert.ok(normal.mean < 0, `${m}: 通常の台は平均でマイナス（${normal.mean.toFixed(0)}）`);
    const rtp = (normal.mean + SLOT_MACHINES[m].price * 900) / (SLOT_MACHINES[m].price * 900);
    assert.ok(rtp < 0.995, `${m}: 通常の台の還元率は100%未満（${(rtp * 100).toFixed(1)}%）`);
  }
  const ra = slotRates("yubasic", SLOT_KAKU_RATE.yubasic), rb = slotRates("yubasic", 1);
  assert.ok(Math.abs(ra.special / SLOT_MACHINES.yubasic.kakuSpecial - SLOT_KAKU_RATE.yubasic * SLOT_KAKU_SPECIAL_BOOST) < 1e-9, "確変中の大当たりは、（通常の台を増やす前の確率）×倍率×1.5");
  assert.ok(rb.special > SLOT_MACHINES.yubasic.kakuSpecial, "通常の台の大当たりは、以前より出やすい");
  assert.equal(slotRates("yubasic", 1).special, slotRates("yubasic").special, "通常のときは変わらない");
  const k = SLOT_KAKU_RATE;
  assert.ok(k.yubasic > k.yurush && k.yurush > k.yuchance && k.yuchance > k.yutreasure, "料金の高い台ほど倍率は小さい");
  assert.ok(Math.max(k.yurainbow, k.yujackpot) <= k.yutreasure + 0.02, "高級台は料金の低い台より小さい（シミュレーションの誤差は0.02まで）");
});

test("管理者だけが、その日の確変台の当選者（名前・NPCかどうか）を見られる。プレイヤーには返さない。uid は返さない", async () => {
  const { act, deps, state, fs } = setup({ now: TT.preOpen + M, random: rngOf(21) });
  for (const i of [0, 1, 2]) await act(`id${i}`, `u${i}`, { action: "kakuApply", which: "pre" });
  state.now = TT.preClose + 6000;
  await kakuRunDraw(deps, D, 1);
  const r = await handleAdminAction(deps, ADMIN, { action: "kakuWinners", day: D });
  assert.equal(r.ok, true); assert.equal(r.exists, true); assert.equal(r.day, D); assert.equal(r.draw1Done, true); assert.equal(r.applied1, 3);
  assert.equal(r.machineName, KAKU_MACHINE_NAMES[kakuMachineFor(D)]);
  const pre = r.slots.filter((x) => x.kind === "pre");
  assert.equal(pre.length, 13);
  assert.ok(pre.every((x) => x.name && typeof x.npc === "boolean"), "13枠すべてに名前（NPCかプレイヤー）");
  assert.ok(pre.some((x) => !x.npc), "土曜でなければ、申込3人のうち当たる人もいる（このシードでは）"); 
  assert.ok(r.slots.filter((x) => x.kind !== "pre").every((x) => x.empty), "当日分はまだ決まっていない");
  assert.ok(!JSON.stringify(r).includes("uid") && !JSON.stringify(r).includes("id0"), "uid は返さない");
  assert.deepEqual(r.slots.map((x) => x.s), [...r.slots.map((x) => x.s)].sort((a, b) => a - b), "時刻順");
  // 管理者以外（プレイヤー・本人でも）は見られない
  for (const who of ["id0", "id1", "someone"]) assert.equal((await handleAdminAction(deps, who, { action: "kakuWinners", day: D })).error, "not_admin");
  // その日のデータがまだ無い日は exists:false
  const none = await handleAdminAction(deps, ADMIN, { action: "kakuWinners", day: "2027-01-01" });
  assert.equal(none.ok, true); assert.equal(none.exists, false);
  // 日付を省くと今日（サーバーの日付）
  state.now = TT.dayStart + 9 * H;
  assert.equal((await handleAdminAction(deps, ADMIN, { action: "kakuWinners" })).day, D);
  assert.equal(fs.counts.getRaw >= 0, true);
});

test("通知の設定：初期は結果の2つだけON。個人ごとに変えられる。抽選結果は申し込んだ本人にだけ、その人の結果だけが届く", async () => {
  const { act, deps, fs, sent, state } = setup({ now: TT.preOpen + M, random: rngOf(4) });
  assert.deepEqual((await act("id0", "u0", { action: "kakuGetNotify" })).prefs, { pub: false, same: false, result1: true, result2: true, cancel: false });
  assert.equal((await act("id1", "u1", { action: "kakuSetNotify", prefs: { result1: false, pub: true, bogus: true } })).prefs.result1, false);
  assert.deepEqual((await act("id1", "u1", { action: "kakuGetNotify" })).prefs, { pub: true, same: false, result1: false, result2: true, cancel: false });
  for (const i of [0, 1, 2, 3, 4]) fs.put(`fcmTokens/tok${i}`, encF({ uid: `id${i}` }));
  for (const i of [0, 1, 2]) await act(`id${i}`, `u${i}`, { action: "kakuApply", which: "pre" });   // id3・id4 は申し込まない。id1 は結果の通知をOFF
  state.now = TT.preClose;
  await kakuRunDraw(deps, D, 1);
  state.now = TT.resultAt;
  await kakuRunEvent(deps, "result1", D);
  const doc = fs.plain(`yuslotKaku/${D}`);
  assert.deepEqual(sent.map((x) => x.token).sort(), ["tok0", "tok2"], "申し込んだ人（id0・id2）だけ。OFFの id1・申し込んでいない id3・id4 には送らない");
  for (const x of sent) {
    const uid = x.token === "tok0" ? "id0" : "id2";
    const mine = doc.slots.filter((s) => s.uid === uid && s.kind === "pre");
    if (mine.length) { assert.match(x.data.body, /当選/); const hm = (ms) => { const d = new Date(ms + 9 * H); return `${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, "0")}`; }; assert.ok(mine.every((s) => x.data.body.includes(`${hm(s.s)}〜${hm(s.e)}`)), "自分の枠の時間が入っている"); }
    else assert.match(x.data.body, /外れ/);
    assert.ok(!/NPC|さん/.test(x.data.body), "ほかの人の名前・NPCは載らない");
  }
  // お知らせ（📢）は全員共通なので、誰が当たったかは載せない
  const ann = fs.plain(`announcements/kaku-${D}`);
  assert.ok(ann && ann.title.includes(KAKU_MACHINE_NAMES[kakuMachineFor(D)]) && ann.title.length <= 50 && ann.body.length <= 480);
  assert.ok(!/NPC|さん|u0|u1|u2/.test(ann.body), "お知らせに個人の結果は載らない"); assert.match(ann.body, /プッシュ通知でお知らせ/);
  const n = sent.length; await kakuRunEvent(deps, "result1", D);
  assert.equal(sent.length, n, "2回目は重ねて送らない"); assert.equal([...fs.docs.keys()].filter((k) => k.startsWith("announcements/")).length, 1);
  // 当日分の結果も同じ：申し込んだ本人にだけ
  state.now = TT.sameOpen + M; resetKakuCacheForTest();
  await act("id3", "u3", { action: "kakuApply", which: "same" });
  state.now = TT.sameClose + 6000; sent.length = 0;   // 締切の5秒後に抽選する
  await kakuRunEvent(deps, "draw2", D);
  assert.deepEqual(sent.map((x) => x.token), ["tok3"], "申し込んだ id3 にだけ（結果の通知はONが初期）");
  assert.ok(/当日分/.test(sent[0].data.body));
  // 公開の通知（初期OFF）は全員向けの内容で、ONにした id1 にだけ
  sent.length = 0; await kakuRunEvent(deps, "pub", D);
  assert.deepEqual(sent.map((x) => x.token), ["tok1"]);
  // 結果の中身（関数）：申し込んでいない人は null
  assert.equal(kakuResultDataFor(doc, "id4", 1, "x", D), null);
});

test("最初の日（10/20）は前日の抽選なし：当日分だけ。お知らせにもそう書く。cron は予定の時刻の直後だけ動く", async () => {
  const day = KAKU_EPOCH;
  const { act, deps, fs, state } = setup({ now: T1.dayStart - 1 * H, random: rngOf(8) }); // 前日の23:00（作成時点で21:00を過ぎている）
  const st = await act("id0", "u0", { action: "kakuStatus" });
  assert.equal(st.tomorrow.machine, kakuMachineFor(day));
  assert.equal((await act("id0", "u0", { action: "kakuApply", which: "pre" })).error, "not_open", "前日の抽選の申込は終わっている");
  state.now = T1.sameOpen + M;
  const st2 = await act("id0", "u0", { action: "kakuStatus" });
  assert.equal(st2.today.mode, "sameDay"); assert.equal(fs.plain(`yuslotKaku/${day}`).draw1Done, true);
  await kakuAnnounceResultForTest(deps, day);
  const ann = fs.plain(`announcements/kaku-${day}`);
  assert.match(ann.body, /当日分/); assert.doesNotMatch(ann.body, /プッシュ通知でお知らせしました/);
  // cron の間引き
  resetKakuCacheForTest();
  assert.equal((await runKakuTick({}, T1.dayStart + 5 * H, deps)).skipped, "outside");
  assert.equal((await runKakuTick({}, T1.dayStart + 12 * H + 11 * M, deps)).skipped, "outside", "12:00の10分後以降は動かない");
  const before = { ...fs.counts };
  const r = await runKakuTick({}, T1.sameClose + 30 * 1000, deps);                 // 10:45 の少しあと
  assert.equal(r.draw2.drawn, true);
  assert.equal((await runKakuTick({}, T1.sameClose + 90 * 1000, deps)).skipped, "done", "もう終わっている");
  assert.ok(fs.counts.commit > before.commit);
});
async function kakuAnnounceResultForTest(deps, day) { const { kakuAnnounceResult } = await import("../worker.js"); return kakuAnnounceResult(deps, day); }

 test("状態の取得：自分の枠と先着の空き状況（名前なし）だけ。ほかの人の予定・NPC・uid は返さない", async () => {
  const { act, deps, state, fs } = setup({ now: TT.preOpen + M, random: rngOf(6) });
  for (let i = 0; i < 3; i++) await act(`id${i}`, `u${i}`, { action: "kakuApply", which: "pre" });
  state.now = TT.preClose; await kakuRunDraw(deps, D, 1);
  state.now = TT.dayStart + 8 * H - 20 * M;
  resetKakuCacheForTest();
  const doc = fs.plain(`yuslotKaku/${D}`);
  const st = await act("id0", "u0", { action: "kakuStatus" });
  assert.equal(st.today.day, D); assert.equal(st.today.machine, kakuMachineFor(D));
  const myCount = doc.slots.filter((x) => x.uid === "id0").length;
  assert.equal(st.today.slots.filter((x) => x.mine).length, myCount);
  assert.ok(st.today.slots.every((x) => x.mine || x.kind === "quick"), "自分の枠か、先着の枠（空き状況）だけ");
  assert.ok(st.today.slots.filter((x) => !x.mine).every((x) => x.kind === "quick" && typeof x.taken === "boolean"));
  assert.equal(st.today.applied1, true); assert.equal(st.today.draw1Done, true);
  const json = JSON.stringify(st);
  assert.ok(!/id0|id1|id2|NPC/.test(json), "uid・NPCは返さない");
  const others = doc.slots.filter((x) => x.name && x.uid !== "id0").map((x) => x.name);
  assert.ok(others.length > 0 && others.every((n) => !json.includes(`"${n}"`)), "ほかの人の名前は返さない");
  assert.equal(st.tomorrow.day, kakuNextDay(D)); assert.equal(st.tomorrow.machine, kakuMachineFor(kakuNextDay(D)));
  // 申し込んでいない人には、自分の枠はなく、前日の抽選の結果も出さない
  const st3 = await act("id5", "u5", { action: "kakuStatus" });
  assert.equal(st3.today.slots.filter((x) => x.mine).length, 0); assert.equal(st3.today.applied1, false);
  // 着席の拒否にも、いま誰が使っているかは入れない
  state.now = TT.dayStart + 8 * H + 5 * M;
  const locked = await act("id5", "u5", { action: "seat", machine: kakuMachineFor(D) });
  assert.equal(locked.error, "kaku_locked"); assert.equal(locked.slot, undefined);
});

test("先着：11:45ちょうどから買える（その1ミリ秒前は買えない）", async () => {
  const { act, state, deps } = setup({ now: TT.sameOpen + M, random: rngOf(12) });
  await act("id0", "u0", { action: "kakuApply", which: "same" });
  state.now = TT.sameClose + 6000; await kakuRunDraw(deps, D, 2);
  const q = (await act("id1", "u1", { action: "kakuStatus" })).today.slots.filter((x) => x.kind === "quick");
  state.now = TT.quickOpen - 1;
  assert.equal((await act("id1", "u1", { action: "kakuQuick", slot: q[0].i })).error, "not_open");
  state.now = TT.quickOpen;
  assert.equal((await act("id1", "u1", { action: "kakuQuick", slot: q[0].i })).ok, true, "11:45:00.000 から買える");
});

test("先着の同時購入：同じ枠を同時に押しても1人だけ。同じ人が別々の枠を同時に押しても1枠だけ（二重取りなし）", async () => {
  const { act, state, deps, fs } = setup({ now: TT.sameOpen + M, random: rngOf(12) });
  await act("id0", "u0", { action: "kakuApply", which: "same" });
  state.now = TT.sameClose + 6000; await kakuRunDraw(deps, D, 2);
  state.now = TT.quickOpen;
  const q = fs.plain(`yuslotKaku/${D}`).slots.filter((x) => x.kind === "quick");
  // ① 6人が同じ枠を同時に押す
  const res = await Promise.all(Array.from({ length: 6 }, (_, i) => act(`id${i}`, `u${i}`, { action: "kakuQuick", slot: q[0].i })));
  assert.equal(res.filter((r) => r.ok).length, 1, "同じ枠を取れるのは1人だけ");
  assert.ok(res.filter((r) => !r.ok).every((r) => ["busy", "taken"].includes(r.error)), JSON.stringify(res.map((r) => r.error)));
  assert.ok(res.some((r) => r.error === "busy"), "同時に押した人は「もう一度」になる（更新時刻の条件で弾かれる）");
  const owners = fs.plain(`yuslotKaku/${D}`).slots.filter((x) => x.i === q[0].i);
  assert.equal(owners.length, 1); assert.ok(owners[0].uid, "持ち主は1人");
  // ② 同じ人が、2つの先着枠を同時に押す
  const free = setup({ now: TT.sameOpen + M, random: rngOf(13) });
  free.state.now = TT.sameClose + 6000; await kakuRunDraw(free.deps, D, 2); free.state.now = TT.quickOpen;
  const q2 = free.fs.plain(`yuslotKaku/${D}`).slots.filter((x) => x.kind === "quick");
  const both = await Promise.all([free.act("id5", "u5", { action: "kakuQuick", slot: q2[0].i }), free.act("id5", "u5", { action: "kakuQuick", slot: q2[1].i })]);
  assert.equal(both.filter((r) => r.ok).length, 1, "1人が先着で取れるのは1枠だけ");
  assert.equal(free.fs.plain(`yuslotKaku/${D}`).slots.filter((x) => x.uid === "id5").length, 1);
  // もう一度押すと、理由が分かる
  const again = await free.act("id5", "u5", { action: "kakuQuick", slot: both[0].ok ? q2[1].i : q2[0].i });
  assert.equal(again.error, "quick_limit");
});

test("申込の二重送信：同じ人が同時に何度押しても申込は1件", async () => {
  const { act, fs } = setup({ now: TT.preOpen + M });
  const r = await Promise.all(Array.from({ length: 5 }, () => act("id0", "u0", { action: "kakuApply", which: "pre" })));
  assert.ok(r.every((x) => x.ok));
  assert.equal(fs.plain(`yuslotKaku/${D}`).app1.length, 1);
});

test("抽選と申込がぶつかっても、抽選は必ず行われる（読み直してやり直す）。競合で失敗したら次の分にやり直す", async () => {
  // ① 読み取りと書き込みの間に申込が入る → 読み直して、その人も抽選に入る
  const a = setup({ now: TT.sameOpen + M, random: rngOf(21) });
  await a.act("id0", "u0", { action: "kakuApply", which: "same" });
  const orig = a.fs.commit.bind(a.fs); let injected = false;
  a.fs.commit = async (writes) => {
    if (!injected && writes.some((w) => w.update?.name?.includes("yuslotKaku") && w.currentDocument?.updateTime)) {
      injected = true;
      const keep = a.state.now; a.state.now = TT.sameClose - 1000;               // 締切の直前に送られた申込が、抽選の読み取りのあとに書き込まれた
      await a.act("id1", "u1", { action: "kakuApply", which: "same" });
      a.state.now = keep;
    }
    return orig(writes);
  };
  a.state.now = TT.sameClose + 6000;
  const r = await kakuRunDraw(a.deps, D, 2);
  assert.equal(r.drawn, true); assert.equal(r.applicants, 2, "遅れて入った申込も抽選に入る");
  assert.equal(a.fs.plain(`yuslotKaku/${D}`).draw2Done, true);
  // ② 4回続けて競合した場合は「raced」で、次の分の cron でやり直される（完了扱いにしない）
  const b = setup({ now: TT.sameOpen + M, random: rngOf(22) });
  await b.act("id0", "u0", { action: "kakuApply", which: "same" });
  const orig2 = b.fs.commit.bind(b.fs); let fails = 0;
  b.fs.commit = async (writes) => {
    if (fails < 4 && writes.some((w) => w.update?.name?.includes("yuslotKaku") && w.currentDocument?.updateTime)) { fails++; throw Object.assign(new Error("firestore commit 400 FAILED_PRECONDITION"), { status: 400 }); }
    return orig2(writes);
  };
  const at = TT.sameClose + 30000;
  const t1 = await runKakuTick({}, at, b.deps); b.state.now = at;
  assert.equal(t1.draw2.skipped, "raced");
  const t2 = await runKakuTick({}, at + 60000, b.deps);
  assert.equal(t2.draw2.drawn, true, "次の分にやり直して、抽選が行われる");
  assert.equal((await runKakuTick({}, at + 120000, b.deps)).skipped, "done");
});

test("抽選に当たる割合は、土日が約5%・平日が約20%。申込者が多い日は、さらに低くなる", async () => {
  assert.equal(kakuIsWeekend("2026-10-23"), false, "金曜"); assert.equal(kakuIsWeekend("2026-10-24"), true, "土曜"); assert.equal(kakuIsWeekend("2026-10-25"), true, "日曜"); assert.equal(kakuIsWeekend("2026-10-26"), false, "月曜");
  assert.equal(kakuPoolFor("2026-10-21", 1), 65); assert.equal(kakuPoolFor("2026-10-21", 2), 15);
  assert.equal(kakuPoolFor("2026-10-24", 1), 260); assert.equal(kakuPoolFor("2026-10-24", 2), 60);
  const rng = rngOf(404);
  const apps = (n) => Array.from({ length: n }, (_, i) => ({ uid: `r${i}`, name: `r${i}` }));
  for (const [day, type, A, lo, hi] of [["2026-10-24", 1, 3, 0.035, 0.075], ["2026-10-24", 1, 20, 0.035, 0.075], ["2026-10-25", 2, 5, 0.035, 0.075], ["2026-10-21", 1, 8, 0.15, 0.25]]) {
    const cnt = type === 1 ? 13 : 3; let won = 0, two = 0; const N = 6000;
    for (let t = 0; t < N; t++) {
      const w = kakuPickWinners({ applicants: apps(A), poolTarget: kakuPoolFor(day, type), count: cnt, random: rng, dayId: day });
      const c = new Map(); w.filter((x) => !x.npc).forEach((x) => c.set(x.uid, (c.get(x.uid) || 0) + 1));
      won += c.size; for (const n of c.values()) if (n >= 2) two++;
    }
    const rate = won / (A * N);
    assert.ok(rate >= lo && rate <= hi, `${day} 種類${type} 申込${A}人：当たる割合 ${(rate * 100).toFixed(1)}%`);
    assert.ok(two / Math.max(1, won) < 0.1, "複数枠はまれ");
  }
  // 申込が非常に多い土日：実在の人だけで枠が埋まり、割合は5%より低い
  const many = kakuPickWinners({ applicants: apps(400), poolTarget: kakuPoolFor("2026-10-24", 1), count: 13, random: rng, dayId: "2026-10-24" });
  assert.ok(many.every((x) => !x.npc));
  // 抽選の実行にも反映される：土曜は申込3人でも、ほとんどの枠がNPC
  const W = "2026-10-24", TW = kakuTimes(W);
  const w = setup({ now: TW.preOpen + M, random: rngOf(9) });
  for (let i = 0; i < 3; i++) await w.act(`id${i}`, `u${i}`, { action: "kakuApply", which: "pre" });
  w.state.now = TW.preClose + 6000; await kakuRunDraw(w.deps, W, 1);
  const pre = w.fs.plain(`yuslotKaku/${W}`).slots.filter((x) => x.kind === "pre");
  assert.ok(pre.filter((x) => x.npc).length >= 10, "土曜は実在の当選者が少なく、NPCが多い");
  const st = await w.act("id0", "u0", { action: "kakuStatus" });
  assert.equal(st.tomorrow.weekend, true, "金曜の夜から見た「明日」（土曜）は土日扱い"); assert.equal(st.today.weekend, false, "金曜は平日");
});

test("台のカード用：いまの枠を使っているのは「NPC／ほかのプレイヤー／自分／いない」のどれかだけ返す（名前・uid は返さない）", async () => {
  const at = (h, m = 0) => TT.dayStart + (h * 60 + m) * M;
  const slots = kakuInitialSlots(D).map((x) => ({ ...x }));
  const byStart = (h, m) => slots.find((x) => x.s === at(h, m));
  Object.assign(byStart(8, 0), { uid: "idA", name: "はなこ" });                  // ほかのプレイヤー
  Object.assign(byStart(8, 30), { uid: "", name: "ほしぞら", npc: true });          // NPC
  Object.assign(byStart(9, 0), { uid: "idMe", name: "me" });                    // 自分
  const h = (hh, mm) => kakuCurrentHolder(slots, "idMe", TT, at(hh, mm));
  assert.equal(h(8, 10).holder, "player"); assert.equal(h(8, 40).holder, "npc"); assert.equal(h(9, 10).holder, "me"); assert.equal(h(9, 40).holder, "none");
  assert.deepEqual(h(8, 40), { s: at(8, 30), e: at(9, 0), holder: "npc" });
  assert.equal(h(7, 59), null, "8:00より前は通常の台"); assert.equal(kakuCurrentHolder(slots, "idMe", TT, at(15, 20)), null, "15:20以降は通常の台");
  assert.ok(!JSON.stringify(h(8, 10)).match(/idA|はなこ/) && !JSON.stringify(h(8, 40)).match(/ほしぞら/), "名前は含まない");
  // 状態の取得にも入る
  const env = setup({ now: TT.preOpen + M, random: rngOf(31) });
  for (let i = 0; i < 2; i++) await env.act(`id${i}`, `u${i}`, { action: "kakuApply", which: "pre" });
  env.state.now = TT.preClose + 6000; await kakuRunDraw(env.deps, D, 1);
  env.state.now = at(8, 5); resetKakuCacheForTest();
  const st = await env.act("id0", "u0", { action: "kakuStatus" });
  assert.ok(st.today.cur && ["me", "player", "npc", "none"].includes(st.today.cur.holder));
  const first = env.fs.plain(`yuslotKaku/${D}`).slots[0];
  assert.equal(st.today.cur.holder, first.uid ? (first.uid === "id0" ? "me" : "player") : first.npc ? "npc" : "none");
  assert.ok(!JSON.stringify(st.today.cur).match(/id0|id1|u0|u1/));
  env.state.now = at(7, 0); resetKakuCacheForTest();
  assert.equal((await env.act("id0", "u0", { action: "kakuStatus" })).today.cur, null, "8:00前は null");
});
