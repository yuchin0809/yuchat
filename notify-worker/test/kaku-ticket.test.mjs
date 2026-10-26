/* 🎟 確変チケット（ゆう番くじ C賞・D賞・ラストワン賞の「確変台の予約」）のテスト
   実行：node --test "notify-worker/test/*.test.mjs" */
import test from "node:test";
import assert from "node:assert/strict";
import {
  KAKU_EPOCH, kakuNextDay, kakuTimes, kakuRunDraw, kakuTicketsOf, kakuTicketLeft, kakuTicketUntil, handleYuslotAction, resetKakuCacheForTest, resetYuslotCacheForTest, BANKUJI
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


const rngOf = (seed) => { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; };
const D = "2026-10-21", TT = kakuTimes(D), H = 3600000, M = 60000;
const DAY0 = "2026-10-20";                                     // 前日（D の前日）。D の確変の予約は、この日の 12:00〜21:00
function setup({ now = TT.preOpen + H, prizes = {}, users = 2 } = {}) {
  resetKakuCacheForTest(); resetYuslotCacheForTest();
  const base = { "worldConfig/yuslot": { yuslotPublished: true, keshiPublished: true } };
  for (let i = 0; i < users; i++) {
    base[`users/u${i}`] = { uid: `id${i}`, name: `u${i}`, coins: 5000 };
    base[`bankujiEntries/${BANKUJI.round}_id${i}`] = { uid: `id${i}`, name: `u${i}`, round: BANKUJI.round, tickets: [], prizes: prizes[i] || [], dayKey: "", dayCount: 0 };
  }
  const fs = fakeFs(base), state = { now };
  const deps = { firestore: fs, adminUid: "adminUid", slotNpc: false, random: rngOf(5), now: () => state.now, slotSecret: "s", sendFcm: async () => ({ ok: true }) };
  const act = (i, body) => handleYuslotAction(deps, `id${i}`, { username: `u${i}`, ...body });
  const entry = (i) => fs.plain(`bankujiEntries/${BANKUJI.round}_id${i}`);
  return { fs, deps, state, act, entry, day: () => fs.plain(`yuslotKaku/${D}`) };
}
const C = (n, extra = {}) => ({ n, id: "C", kind: "kaku3", at: TT.preOpen - H, until: TT.preOpen - H + 60 * 86400000, ...extra });
const Dd = (n, extra = {}) => ({ n, id: "D", kind: "kaku1", at: TT.preOpen - H, until: TT.preOpen - H + 60 * 86400000, ...extra });
const LAST = (n, extra = {}) => ({ n, id: "L", kind: "last", at: TT.preOpen - H, ...extra });

test("チケットの数え方：C賞3回・D賞1回・ラストワン賞3回（引いてから60日）。使い切り・期限切れは数えない。期限が近いものから使う", () => {
  const now = TT.preOpen;
  assert.deepEqual([C(1), Dd(2), LAST(3)].map(kakuTicketLeft), [3, 1, 3]);
  assert.deepEqual([C(1, { used: 2 }), Dd(2, { used: 1 }), LAST(3, { used: 3 })].map(kakuTicketLeft), [1, 0, 0]);
  assert.equal(kakuTicketUntil(LAST(3)), LAST(3).at + 60 * 86400000);
  const list = kakuTicketsOf([C(1, { until: now + 5 * H }), Dd(2, { until: now + 2 * H }), LAST(3, { at: now - 59 * 86400000 }), C(4, { until: now - 1 }), { n: 5, id: "H", kind: "coin", amount: 100 }, Dd(6, { used: 1, until: now + H })], now);
  assert.deepEqual(list.map((r) => r.n), [2, 1, 3], "期限が近いものから。期限切れ・使い切り・ほかの景品は除く");
});

test("チケットを持っていない人：残り0回。枠の一覧は読まない。使おうとすると断る", async () => {
  const t = setup();
  const info = await t.act(0, { action: "kakuTicketInfo" });
  assert.deepEqual([info.ok, info.left, info.tickets.length, info.reserve, info.take.length], [true, 0, 0, null, 0]);
  assert.equal(t.fs.counts.getRaw, 0, "枠の書類は読んでいない");
  assert.equal((await t.act(0, { action: "kakuTicketUse", mode: "reserve", day: D, slot: 0 })).error, "no_ticket");
});

test("予約：前日 12:00〜21:00 だけ。明日の30分枠を確定で取る。1枠につき1人だけ・チケットは1回ぶん減る", async () => {
  const t = setup({ prizes: { 0: [C(1)], 1: [Dd(2)] }, now: TT.preOpen - 1 });
  assert.equal((await t.act(0, { action: "kakuTicketUse", mode: "reserve", day: D, slot: 3 })).error, "not_open", "12:00 前");
  const info0 = await t.act(0, { action: "kakuTicketInfo" });
  assert.deepEqual([info0.left, info0.reserve.open, info0.reserve.openMs], [3, false, TT.preOpen]);
  t.state.now = TT.preOpen + H;
  const info = await t.act(0, { action: "kakuTicketInfo" });
  assert.equal(info.reserve.open, true); assert.equal(info.reserve.slots.length, 13); assert.ok(info.reserve.slots.every((x) => x.state === "free"));
  assert.equal(info.tickets[0].n, 1);
  const r = await t.act(0, { action: "kakuTicketUse", mode: "reserve", day: D, slot: 3 });
  assert.deepEqual([r.ok, r.mode, r.day, r.slot, r.left], [true, "reserve", D, 3, 2]);
  const slot = t.day().slots.find((x) => x.i === 3);
  assert.deepEqual([slot.uid, slot.name, slot.npc, slot.bt, slot.tk], ["id0", "u0", false, 1, 1], "買った枠と同じ扱い（ゆうマートで売れない）");
  const used = t.entry(0).prizes[0];
  assert.deepEqual([used.used, used.id, used.kind, used.n, used.useLog.length], [1, "C", "kaku3", 1, 1], "景品の中身は変えない");
  assert.equal((await t.act(1, { action: "kakuTicketUse", mode: "reserve", day: D, slot: 3 })).error, "taken", "同じ枠は、もう予約できない");
  const other = await t.act(1, { action: "kakuTicketInfo" });
  assert.equal(other.reserve.slots.find((x) => x.i === 3).state, "taken"); assert.equal((await t.act(0, { action: "kakuTicketInfo" })).reserve.slots.find((x) => x.i === 3).state, "mine");
  assert.equal((await t.act(1, { action: "kakuTicketUse", mode: "reserve", day: D, slot: 4 })).ok, true);
  assert.equal(t.entry(1).prizes[0].used, 1); assert.equal((await t.act(1, { action: "kakuTicketUse", mode: "reserve", day: D, slot: 5 })).error, "no_ticket", "D賞は1回だけ");
  assert.equal((await t.act(0, { action: "kakuTicketUse", mode: "reserve", day: "2026-10-23", slot: 6 })).error, "bad_request", "明日の分だけ");
  assert.equal((await t.act(0, { action: "kakuTicketUse", mode: "reserve", day: D, slot: 13 })).error, "bad_request", "30分枠ではない");
  t.state.now = TT.preClose;
  assert.equal((await t.act(0, { action: "kakuTicketUse", mode: "reserve", day: D, slot: 6 })).error, "not_open", "21:00 からは予約できない");
});

test("予約：1日に取れる枠は最大3つ。4つ目は断り、チケットは減らない", async () => {
  const t = setup({ prizes: { 0: [C(1), Dd(2)] } });
  for (const si of [0, 1, 2]) assert.equal((await t.act(0, { action: "kakuTicketUse", mode: "reserve", day: D, slot: si })).ok, true);
  assert.equal((await t.act(0, { action: "kakuTicketUse", mode: "reserve", day: D, slot: 5 })).error, "day_limit");
  assert.equal(t.entry(0).prizes.find((x) => x.id === "D").used, 1, "期限が同じなら、残りの少ない D賞から使う");
  assert.equal(t.entry(0).prizes.find((x) => x.id === "C").used, 2);
  assert.equal((await t.act(0, { action: "kakuTicketInfo" })).left, 1, "C賞に1回残っている（4つ目は上限で断ったので減っていない）");
});

test("21:00 の抽選：予約された枠は抽選に出さず、ほかの枠だけを抽選する。申込者の当たる割合は変わらない", async () => {
  const t = setup({ prizes: { 0: [C(1)] }, users: 6 });
  for (const si of [0, 1, 2]) await t.act(0, { action: "kakuTicketUse", mode: "reserve", day: D, slot: si });
  for (let i = 1; i < 6; i++) await t.act(i, { action: "kakuApply", which: "pre" });
  t.state.now = TT.preClose + M;
  const r = await kakuRunDraw(t.deps, D, 1);
  assert.equal(r.drawn, true);
  const slots = t.day().slots.filter((x) => x.kind === "pre");
  for (const si of [0, 1, 2]) { const x = slots.find((y) => y.i === si); assert.deepEqual([x.uid, x.tk, x.bt], ["id0", 1, 1], "予約された枠は、そのまま"); }
  const rest = slots.filter((x) => !x.tk);
  assert.equal(rest.length, 10); assert.ok(rest.every((x) => x.uid || x.npc), "残りの10枠は抽選で決まった");
  assert.ok(rest.every((x) => x.uid !== "id0"), "チケットで3枠とった人は、1日の上限（3枠）なので抽選では当たらない");
});

test("取る：抽選のあと、NPC がとった30分枠を、枠が始まる11分前まで。キャンセル中・人の枠・もう取られた枠は取れない", async () => {
  const t = setup({ prizes: { 0: [C(1)], 1: [Dd(2)] }, now: TT.preOpen + H });
  assert.equal((await t.act(0, { action: "kakuTicketUse", mode: "take", day: D, slot: 0 })).error, "not_open", "抽選の前は、NPC の枠がない");
  await t.act(1, { action: "kakuApply", which: "pre" });
  t.state.now = TT.preClose + M;
  await kakuRunDraw(t.deps, D, 1);
  const d = t.day(), npcSlots = d.slots.filter((x) => x.kind === "pre" && x.npc);
  const humanSlot = d.slots.find((x) => x.kind === "pre" && x.uid);
  assert.ok(npcSlots.length >= 8);
  const info = await t.act(0, { action: "kakuTicketInfo" });
  assert.equal(info.take.length, npcSlots.length); assert.ok(info.take.every((x) => x.day === D && npcSlots.some((y) => y.i === x.i)));
  assert.equal((await t.act(0, { action: "kakuTicketUse", mode: "take", day: D, slot: humanSlot?.i ?? 0 })).error, humanSlot ? "taken" : "taken", "人の枠は取れない");
  const target = npcSlots[0];
  const r = await t.act(0, { action: "kakuTicketUse", mode: "take", day: D, slot: target.i });
  assert.deepEqual([r.ok, r.mode, r.left], [true, "take", 2]);
  const after = t.day().slots.find((x) => x.i === target.i);
  assert.deepEqual([after.uid, after.npc, after.bt, after.tk, after.kn], ["id0", false, 1, 1, 1]);
  assert.equal((await t.act(1, { action: "kakuTicketUse", mode: "take", day: D, slot: target.i })).error, "taken");
  // キャンセル中（cx）の枠は取れない
  const cx = npcSlots[1];
  const raw = t.day(); raw.slots = raw.slots.map((x) => (x.i === cx.i ? { ...x, npc: false, name: "", uid: "", cx: 1, cxAt: t.state.now } : x));
  await t.fs.update(`yuslotKaku/${D}`, { slots: raw.slots });
  assert.equal((await t.act(1, { action: "kakuTicketUse", mode: "take", day: D, slot: cx.i })).error, "taken", "cx の枠は取れない");
  // 始まる11分前を過ぎたら取れない
  const near = npcSlots[2];
  t.state.now = near.s - 11 * M;
  assert.equal((await t.act(1, { action: "kakuTicketUse", mode: "take", day: D, slot: near.i })).error, "too_late");
  t.state.now = near.s - 11 * M - 1;
  assert.equal((await t.act(1, { action: "kakuTicketUse", mode: "take", day: D, slot: near.i })).ok, true, "11分1ミリ秒前までは取れる");
});

test("取る・予約：時間が重なる枠は取れない／期限切れのチケットは使えない／ラストワン賞は3回／使ったあとの記録", async () => {
  const t = setup({ prizes: { 0: [LAST(1)], 1: [C(2, { until: TT.preOpen })] } });
  const r1 = await t.act(0, { action: "kakuTicketUse", mode: "reserve", day: D, slot: 0 });
  assert.equal(r1.left, 2);
  assert.equal((await t.act(0, { action: "kakuTicketUse", mode: "reserve", day: D, slot: 0 })).error, "taken", "自分が予約した枠も、もう一度は予約できない");
  assert.equal((await t.act(1, { action: "kakuTicketUse", mode: "reserve", day: D, slot: 0 })).error, "taken");
  assert.equal((await t.act(1, { action: "kakuTicketUse", mode: "reserve", day: D, slot: 1 })).error, "no_ticket", "期限切れ");
  assert.equal((await t.act(0, { action: "kakuTicketUse", mode: "reserve", day: D, slot: 1 })).left, 1);
  assert.equal((await t.act(0, { action: "kakuTicketUse", mode: "reserve", day: D, slot: 2 })).left, 0);
  assert.equal((await t.act(0, { action: "kakuTicketUse", mode: "reserve", day: D, slot: 3 })).error, "day_limit", "1日3枠まで（3回使い切りでもある）");
  const left = await t.act(0, { action: "kakuTicketInfo" });
  assert.deepEqual([left.left, left.tickets.length], [0, 0], "ラストワン賞の3回は使い切り");
  const rec = t.entry(0).prizes[0];
  assert.deepEqual([rec.used, rec.useLog.map((x) => x.i), rec.useLog[0].m], [3, [0, 1, 2], "reserve"]);
});

test("ゆうマートで売る：一度でも使ったチケットは売れない（使っていないものは今まで通り）", async () => {
  const t = setup({ prizes: { 0: [C(1), C(2), Dd(3)] } });
  await t.act(0, { action: "kakuTicketUse", mode: "reserve", day: D, slot: 0 });   // 期限が同じなら、残りが少ない…ここでは最初の C(1) を使う
  const used = t.entry(0).prizes.find((x) => x.used > 0);
  const sellable = await t.act(0, { action: "martSellable" });
  assert.equal(sellable.ok, true);
  assert.ok(!sellable.prizes.some((x) => x.n === used.n), "使ったチケットは出品できる景品に出ない");
  assert.ok(sellable.prizes.some((x) => x.n !== used.n && (x.pid === "C" || x.pid === "D")), "使っていないものは出る");
  const sell = await t.act(0, { action: "martList", kind: "prize", n: used.n, price: 100 });
  assert.equal(sell.error, "used");
});
