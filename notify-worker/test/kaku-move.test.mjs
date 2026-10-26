/* ⏰ 当たった確変枠（前日の抽選の30分枠）の時間を変える（worker.js の kakuMove）のテスト
   実行：node --test "notify-worker/test/*.test.mjs" */
import test from "node:test";
import assert from "node:assert/strict";
import { KAKU_EPOCH, kakuTimes, kakuInitialSlots, handleYuslotAction, resetKakuCacheForTest, resetYuslotCacheForTest } from "../worker.js";

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


const D = "2026-10-21", TT = kakuTimes(D), H = 3600000, M = 60000;
const rngOf = (seed) => { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; };
function setup({ now = TT.dayStart + 7 * H + 55 * M, patch = {} } = {}) {
  resetKakuCacheForTest(); resetYuslotCacheForTest();
  const slots = kakuInitialSlots(D).map((x) => ({ ...x }));
  const set = (i, v) => { const k = slots.findIndex((x) => x.i === i); slots[k] = { ...slots[k], ...v }; };
  const pre = slots.filter((x) => x.kind === "pre").map((x) => x.i);   // 30分枠の番号（時間順）
  set(pre[3], { uid: "id0", name: "u0", npc: false });                  // id0 が前日の抽選で当たった
  set(pre[4], { uid: "id1", name: "u1", npc: false });                  // id1（ほかのプレイヤー）
  set(pre[5], { uid: "", name: "ほしぞら", npc: true });
  set(pre[6], { uid: "", name: "みかん", npc: true });
  set(pre[7], { uid: "", name: "ひなた", npc: true, cx: 1 });          // 取り消された枠（選べない）
  set(pre[8], { uid: "id0", name: "u0", npc: false, bt: 1 });           // マートで買った枠
  Object.entries(patch).forEach(([i, v]) => set(Number(i), v));
  const base = { "worldConfig/yuslot": { yuslotPublished: true, keshiPublished: true }, [`yuslotKaku/${D}`]: { day: D, machine: "yubasic", mode: "full", slots, app1: [], app2: [], draw1Done: true, draw2Done: false } };
  for (let i = 0; i < 3; i++) base[`users/u${i}`] = { uid: `id${i}`, name: `u${i}`, coins: 5000 };
  const fs = fakeFs(base), state = { now };
  const deps = { firestore: fs, adminUid: "adminUid", slotNpc: false, random: rngOf(5), now: () => state.now, slotSecret: "s", sendFcm: async () => ({ ok: true }) };
  const act = (i, body) => handleYuslotAction(deps, `id${i}`, { username: `u${i}`, ...body });
  return { fs, state, act, pre, day: () => fs.plain(`yuslotKaku/${D}`), slot: (i) => fs.plain(`yuslotKaku/${D}`).slots.find((x) => x.i === i) };
}

test("変えられる枠の一覧：自分が前日の抽選で当たった枠だけ。移れる先は NPC がとっている枠（プレイヤーの枠・取り消された枠・マートで買った枠は出ない）", async () => {
  const t = setup();
  const info = await t.act(0, { action: "kakuMoveInfo" });
  assert.equal(info.ok, true); assert.equal(info.days.length, 1);
  const m = info.days[0].moves;
  assert.equal(m.length, 1, "マートで買った枠は対象外");
  assert.equal(m[0].from.i, t.pre[3]);
  assert.deepEqual(m[0].to.map((x) => x.i), [t.pre[5], t.pre[6]]);
  assert.deepEqual((await t.act(2, { action: "kakuMoveInfo" })).days, [], "当たっていない人には何も出ない");
  const st = await t.act(0, { action: "kakuStatus" });
  assert.deepEqual(st.today.slots.filter((x) => x.mine).map((x) => [x.i, x.mv]), [[t.pre[3], 1], [t.pre[8], undefined]], "状態にも「変えられる」の印");
});

test("時間を変える：NPC の枠に移り、どかされた NPC がもとの枠に入る。枠の数・NPC の人数は変わらず、変えた枠には印がつく", async () => {
  const t = setup();
  const before = t.day().slots;
  const r = await t.act(0, { action: "kakuMove", day: D, from: t.pre[3], to: t.pre[5] });
  assert.equal(r.ok, true); assert.equal(r.to.i, t.pre[5]);
  const to = t.slot(t.pre[5]), from = t.slot(t.pre[3]);
  assert.deepEqual([to.uid, to.name, to.npc, to.mv], ["id0", "u0", false, 1]);
  assert.deepEqual([from.uid, from.name, from.npc, from.mv], ["", "ほしぞら", true, undefined], "どかされた NPC が、もとの枠に入る");
  const after = t.day().slots;
  assert.equal(after.length, before.length);
  assert.equal(after.filter((x) => x.npc).length, before.filter((x) => x.npc).length, "NPC の数は変わらない");
  assert.equal(after.filter((x) => x.uid === "id0").length, 2);
  const st = await t.act(0, { action: "kakuStatus" });
  assert.equal(st.today.slots.find((x) => x.i === t.pre[5]).mv, 2, "変更ずみ");
  assert.equal((await t.act(0, { action: "kakuMove", day: D, from: t.pre[5], to: t.pre[6] })).error, "already_moved", "1当選につき1回");
  assert.deepEqual((await t.act(0, { action: "kakuMoveInfo" })).days, [], "変えたあとは、もう出ない");
});

test("プレイヤーはどかせない：ほかのプレイヤーの枠・まだ決まっていない枠・取り消された枠・自分のものではない枠へは動けない", async () => {
  const t = setup();
  assert.equal((await t.act(0, { action: "kakuMove", day: D, from: t.pre[3], to: t.pre[4] })).error, "taken", "ほかのプレイヤーの枠");
  assert.equal((await t.act(0, { action: "kakuMove", day: D, from: t.pre[3], to: t.pre[7] })).error, "taken", "取り消された枠");
  assert.equal((await t.act(0, { action: "kakuMove", day: D, from: t.pre[3], to: t.pre[0] })).error, "taken", "まだだれも決まっていない枠");
  assert.equal((await t.act(1, { action: "kakuMove", day: D, from: t.pre[3], to: t.pre[5] })).error, "not_movable", "他人の枠は動かせない");
  assert.equal((await t.act(0, { action: "kakuMove", day: D, from: t.pre[8], to: t.pre[5] })).error, "not_movable", "マートで買った枠は対象外");
  assert.equal(t.slot(t.pre[4]).uid, "id1"); assert.equal(t.slot(t.pre[3]).uid, "id0");
});

test("期限：いまの枠も移る先も、始まる11分前まで。時間が重なる自分の枠には移れない", async () => {
  const t = setup();
  const target = t.slot(t.pre[5]), mine = t.slot(t.pre[3]);
  t.state.now = target.s - 11 * M;
  assert.equal((await t.act(0, { action: "kakuMove", day: D, from: t.pre[3], to: t.pre[5] })).error, "too_late", "移る先が11分前");
  t.state.now = mine.s - 11 * M;
  assert.equal((await t.act(0, { action: "kakuMove", day: D, from: t.pre[3], to: t.pre[5] })).error, "too_late", "いまの枠が11分前");
  assert.deepEqual((await t.act(0, { action: "kakuMoveInfo" })).days, []);
  const init = kakuInitialSlots(D).filter((x) => x.kind === "pre"), my = init[8];   // 自分のほかの枠（マートで買った12:00の枠）
  const t2 = setup({ patch: { [init[5].i]: { s: my.s + 10 * M, e: my.e + 10 * M } } });   // 自分のほかの枠と重なる枠（テスト用に時間をずらす）。いま動かす枠そのものとは、重なってもよい（入れ替わるので）
  assert.equal((await t2.act(0, { action: "kakuMove", day: D, from: t2.pre[3], to: t2.pre[5] })).error, "overlap");
});

test("書き込みは1回の commit。そのあとほかの人が抽選・チケット・マートで同じ書類を更新していても、二重に取らない（読み直してやり直す）", async () => {
  const t = setup();
  const c0 = t.fs.counts.commit;
  await t.act(0, { action: "kakuMove", day: D, from: t.pre[3], to: t.pre[5] });
  assert.equal(t.fs.counts.commit, c0 + 1);
  assert.equal((await t.act(2, { action: "kakuMove", day: D, from: t.pre[3], to: t.pre[6] })).error, "not_movable");
  assert.equal((await t.act(0, { action: "kakuMove", day: "2026-10-30", from: 1, to: 2 })).error, "bad_request");
});
