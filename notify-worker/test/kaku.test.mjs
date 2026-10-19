/* 🌈 ゆうスロ確変台（worker.js の kaku*）のテスト
   実行：node --test "notify-worker/test/*.test.mjs" */
import test from "node:test";
import assert from "node:assert/strict";
import {
  KAKU_EPOCH, KAKU_MACHINE_NAMES, kakuDayId, kakuDayStart, kakuNextDay, kakuTimes, kakuMachineFor, kakuSameKinds, kakuInitialSlots, kakuNpcName,
  kakuPickWinners, kakuRunDraw, kakuRunEvent, kakuSeatRight, kakuSpinGate, runKakuTick, resetKakuCacheForTest,
  handleYuslotAction, resetYuslotCacheForTest, slotApplySpin, SLOT_MACHINES, SLOT_KAKU_RATE
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
  const act = (uid, name, body) => handleYuslotAction(deps, uid, { ...body, username: name });
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

test("確変の還元率：確変中は当たりが増え、料金が高い台ほど倍率が小さい。通常のセッションは変わらない", () => {
  const rng = rngOf(77);
  const play = (machine, kaku) => {
    let session = { machine, price: SLOT_MACHINES[machine].price, startCoins: 1e9, delta: 0, freeSpins: 0, feverUntil: 0, feverPending: false, spins: 0, wins: 0, streak: 0, kaku };
    let now = 0;
    for (let i = 0; i < 30000; i++) { const r = slotApplySpin(session, now, rng); session = r.session; if (session.feverPending) session = { ...session, feverUntil: now + 20000, feverPending: false }; now += 2000; }
    return session.delta / (30000 * SLOT_MACHINES[machine].price);
  };
  for (const m of ["yubasic", "yujackpot"]) {
    const normal = play(m, false), kaku = play(m, true);
    assert.ok(kaku > normal + 0.3, `${m}: 通常 ${normal.toFixed(2)} → 確変 ${kaku.toFixed(2)}（収支/賭け金）`);
    assert.ok(kaku > 0, `${m}: 確変は平均でプラス`);
  }
});

test("通知の設定：初期は結果の2つだけON。個人ごとに変えられ、プッシュはその設定どおりに送る（先着の通知はない）", async () => {
  const { act, deps, fs, sent, state } = setup({ now: TT.preOpen + M, random: rngOf(4) });
  await act("id2", "u2", { action: "kakuApply", which: "pre" });   // 前日の抽選がある回（前日に作られたドキュメント）
  state.now = TT.preClose;
  assert.deepEqual((await act("id0", "u0", { action: "kakuGetNotify" })).prefs, { pub: false, same: false, result1: true, result2: true });
  assert.equal((await act("id1", "u1", { action: "kakuSetNotify", prefs: { result1: false, pub: true, bogus: true } })).prefs.result1, false);
  assert.deepEqual((await act("id1", "u1", { action: "kakuGetNotify" })).prefs, { pub: true, same: false, result1: false, result2: true });
  fs.put("fcmTokens/tokA", encF({ uid: "id0" })); fs.put("fcmTokens/tokB", encF({ uid: "id1" })); fs.put("fcmTokens/tokC", encF({ uid: "id2" }));
  await kakuRunDraw(deps, D, 1);
  state.now = TT.resultAt;
  const r = await kakuRunEvent(deps, "result1", D);
  assert.deepEqual(sent.map((x) => x.token).sort(), ["tokA", "tokC"], "7:50の結果は、OFFにした人（id1）には送らない");
  assert.equal(sent[0].data.kind, "kaku");
  const ann = fs.plain(`announcements/kaku-${D}`);
  assert.ok(ann && ann.title.includes(KAKU_MACHINE_NAMES[kakuMachineFor(D)]) && ann.title.length <= 50 && ann.body.length <= 480, "7:50のお知らせ（📢）が1件");
  assert.match(ann.body, /前日の抽選結果/); assert.match(ann.body, /NPC/);
  sent.length = 0;
  await kakuRunEvent(deps, "result1", D);
  assert.equal(sent.length, 0, "2回目は通知を重ねて送らない"); assert.equal([...fs.docs.keys()].filter((k) => k.startsWith("announcements/")).length, 1);
  // 公開の通知（初期OFF）は、ONにした id1 にだけ
  await kakuRunEvent(deps, "pub", D);
  assert.deepEqual(sent.map((x) => x.token), ["tokB"]);
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
  assert.match(ann.body, /当日分/); assert.doesNotMatch(ann.body, /前日の抽選結果/);
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

test("状態の取得：今日の確変台・枠（NPC表示つき・自分の枠）・明日の申込。uid は返さない", async () => {
  const { act, deps, state } = setup({ now: TT.preOpen + M, random: rngOf(6) });
  await act("id0", "u0", { action: "kakuApply", which: "pre" });
  state.now = TT.preClose; await kakuRunDraw(deps, D, 1);
  state.now = TT.dayStart + 8 * H - 20 * M;
  resetKakuCacheForTest();
  const st = await act("id0", "u0", { action: "kakuStatus" });
  assert.equal(st.today.day, D); assert.equal(st.today.machine, kakuMachineFor(D)); assert.equal(st.today.slots.length, 18);
  assert.ok(st.today.slots.filter((x) => x.kind === "pre").every((x) => x.name));
  assert.ok(st.today.slots.some((x) => x.npc)); assert.ok(typeof st.today.slots[0].mine === "boolean");
  assert.equal(st.tomorrow.day, kakuNextDay(D)); assert.equal(st.tomorrow.machine, kakuMachineFor(kakuNextDay(D)));
  assert.ok(!JSON.stringify(st).includes("id0"), "uid を含まない");
});
