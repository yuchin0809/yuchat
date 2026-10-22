/* 🥊 消しバトの2人対戦（worker.js の keshiRoom*・keshiSim）のテスト
   実行：node --test "notify-worker/test/*.test.mjs" */
import test from "node:test";
import assert from "node:assert/strict";
import { KESHI_DESK, KESHI_DEFAULT_EQ, keshiStats, keshiPhys, keshiSim, keshiLaunchSpeed, resetYuslotCacheForTest, handleYuslotAction } from "../worker.js";

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
const ROOM = "room1234567890abcd";

function setup({ keshi = true } = {}) {
  resetYuslotCacheForTest();
  const base = { "worldConfig/yuslot": { yuslotPublished: true, keshiPublished: keshi } };
  for (let i = 0; i < 4; i++) base[`users/u${i}`] = { uid: `id${i}`, name: `u${i}`, coins: 1000 };
  const fs = fakeFs(base);
  const state = { now: Date.UTC(2026, 9, 23, 3) };
  const deps = { firestore: fs, adminUid: ADMIN, now: () => state.now, random: () => 0.5, slotSecret: "s", sendFcm: async () => ({ ok: true }) };
  const act = (i, body) => handleYuslotAction(deps, `id${i}`, { username: `u${i}`, ...body });
  fs.put(`gameRooms/${ROOM}`, encF({ gameType: "keshi", ownerUid: "id1", owner: "u1", members: ["u1", "u2"], memberUids: ["id1", "id2"], status: "playing", createdAt: "x" }));
  return { fs, deps, state, act, room: () => fs.plain(`gameRooms/${ROOM}`), r: (i, action, body = {}) => act(i, { action, roomId: ROOM, ...body }) };
}
const BASE = keshiStats(KESHI_DEFAULT_EQ);
const BP = [keshiPhys(BASE), keshiPhys(BASE)];
const START = [[-KESHI_DESK.startX, KESHI_DESK.startZ], [KESHI_DESK.startX, -KESHI_DESK.startZ]];
/* 弾いている人から相手へ、まっすぐ弾く */
const aimAt = (y) => ({ gid: y.gid, dx: y.pos[1 - y.cur][0] - y.pos[y.cur][0], dz: y.pos[1 - y.cur][1] - y.pos[y.cur][1] });
const who = (y) => (y.order[y.cur] === "id1" ? 1 : 2);

test("動きの計算：強さの数字は、足し算・かけ算で作った決まった値。初期の消しゴムどうしは同じ", () => {
  assert.deepEqual(keshiPhys(BASE), { m: 1, a: 8, e: 0.5, r: 0.78 });
  const heavy = keshiPhys(keshiStats({ ...KESHI_DEFAULT_EQ, body: "titan", weight: "lead" }));
  assert.ok(heavy.m > 1.5, "重い消しゴムは重い");
  const slick = keshiPhys(keshiStats({ ...KESHI_DEFAULT_EQ, sole: "air" }));
  assert.ok(slick.a < 6.5, "すべる底は、止まりにくい");
  const top = keshiPhys(keshiStats({ body: "titan", edge: "crystal", sole: "air", weight: "gold" }));
  assert.ok(top.e <= 0.95 && top.a > 1 && top.m < 3);
});

test("動きの計算：まっすぐ弾いても当たらない。狙って弱く弾くと当たって動かすだけ、思いきり当てると机から落とせる", () => {
  const aim = () => { const dx = START[1][0] - START[0][0], dz = START[1][1] - START[0][1], n = Math.hypot(dx, dz); return [dx / n, dz / n]; };
  const go = (p, dir) => { const v = keshiLaunchSpeed(BP[0], p); return keshiSim(BP, START, 0, dir[0] * v, dir[1] * v); };
  const straight = go(0.8, [0, -1]);
  assert.deepEqual(straight.to[1], START[1], "まっすぐ弾いても、相手には当たらない（はじめの位置がずれている）"); assert.equal(straight.first, -1);
  const weak = go(0.4, aim());
  assert.equal(weak.first, -1); assert.deepEqual(weak.to[1], START[1], "弱いと、相手に届かない");
  const mid = go(0.8, aim());
  assert.equal(mid.first, -1, "狙って当てても、1回では落ちない"); assert.ok(mid.to[1][1] < START[1][1] - 0.4, "相手は動く");
  assert.equal(go(1, aim()).first, -1, "初期の消しゴムどうしは、全力で当てても1回では落ちない");
  const strong = keshiPhys(keshiStats({ ...KESHI_DEFAULT_EQ, body: "pro", edge: "band" })), v = keshiLaunchSpeed(strong, 1), [ax, az] = aim();
  const full = keshiSim([strong, strong], START, 0, ax * v, az * v);
  assert.equal(full.first, 1, "反発の強いパーツで思いきり当てると、相手が落ちる"); assert.deepEqual(full.out, [false, true]);
  const self = keshiSim(BP, START, 0, 0, keshiLaunchSpeed(BP[0], 1));
  assert.equal(self.first, 0, "相手のいない向きに強く弾くと、自分が落ちる");
});

test("動きの計算：重い消しゴムは当たり負けしにくく、軽いほうが遠くへ飛ぶ。同じ入力は、いつも同じ答え。必ず止まる", () => {
  const heavy = keshiPhys(keshiStats({ ...KESHI_DEFAULT_EQ, weight: "gold" })), light = keshiPhys(BASE);
  const hit = (a, b) => { const P = [a, b], dx = START[1][0] - START[0][0], dz = START[1][1] - START[0][1], n = Math.hypot(dx, dz), v = keshiLaunchSpeed(a, 1); return keshiSim(P, START, 0, dx / n * v, dz / n * v); };
  const h2l = hit(heavy, light), l2h = hit(light, heavy);
  assert.ok(Math.hypot(h2l.to[1][0] - START[1][0], h2l.to[1][1] - START[1][1]) > Math.hypot(l2h.to[1][0] - START[1][0], l2h.to[1][1] - START[1][1]), "重いほうが当てたほうが、相手は遠くへ飛ぶ");
  assert.deepEqual(hit(heavy, light), h2l);
  let seed = 3; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let i = 0; i < 300; i++) {
    const P = [keshiPhys(keshiStats({ body: ["plain", "sponge", "sand", "pro", "titan"][i % 5], edge: ["paper", "band", "crystal"][(i >> 1) % 3], sole: ["bare", "wax", "air"][(i >> 2) % 3], weight: ["none", "lead", "gold"][(i >> 3) % 3] })), light];
    const pos = [[(rnd() - .5) * 6, (rnd() - .5) * 8], [(rnd() - .5) * 6, (rnd() - .5) * 8]];
    if (Math.hypot(pos[0][0] - pos[1][0], pos[0][1] - pos[1][1]) < 2.4) continue;
    const a = rnd() * Math.PI * 2, v = keshiLaunchSpeed(P[0], rnd());
    const r = keshiSim(P, pos, i % 2, Math.cos(a) * v, Math.sin(a) * v);
    assert.ok(r.steps < 1200, "止まる");
    r.to.flat().forEach((n) => assert.ok(Number.isFinite(n)));
  }
});

test("画面用の動きの計算（yukeshi-core.js）は、サーバーの計算と同じ答えになる", async () => {
  const { keshiSimStepper } = await import("../../yukeshi-core.js");
  let seed = 11; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const bodies = ["plain", "sponge", "sand", "pro", "titan"], sols = ["bare", "tape", "wax", "teflon", "air"], wts = ["none", "coin", "bolt", "lead", "gold"], edges = ["paper", "plastic", "band", "metal", "crystal"];
  let hits = 0, falls = 0;
  for (let i = 0; i < 400; i++) {
    const mk = () => keshiPhys(keshiStats({ body: bodies[Math.floor(rnd() * 5)], edge: edges[Math.floor(rnd() * 5)], sole: sols[Math.floor(rnd() * 5)], weight: wts[Math.floor(rnd() * 5)] }));
    const P = [mk(), mk()], who0 = i % 2, pos = who0 === 0 ? START : [START[0], START[1]];
    const a = (rnd() - .5) * 0.6 + (who0 === 0 ? Math.PI : 0), v = keshiLaunchSpeed(P[who0], 0.3 + rnd() * 0.7);
    const vx = Math.round(Math.sin(a) * v * 1000) / 1000, vz = Math.round(Math.cos(a) * v * 1000) / 1000;
    const server = keshiSim(P, pos, who0, vx, vz);
    const s = keshiSimStepper(P, pos, who0, vx, vz);
    while (s.step()) { /* 終わるまで */ }
    const r3 = (x) => Math.round(x * 1000) / 1000;
    assert.deepEqual([[r3(s.x[0]), r3(s.z[0])], [r3(s.x[1]), r3(s.z[1])]], server.to, `#${i} 位置`);
    assert.equal(s.first, server.first); assert.deepEqual(s.out, server.out); assert.equal(s.steps, server.steps);
    if (server.first >= 0) falls++; if (Math.hypot(server.to[0][0] - server.to[1][0], server.to[0][1] - server.to[1][1]) < 3) hits++;
  }
  assert.ok(falls > 40 && hits > 40, "いろいろな場面を試せている");
});

test("2人対戦：始める。机の上の位置・強さ・持ち時間。どちらの画面から呼んでも同じゲーム。読み書きは最小", async () => {
  const ctx = setup();
  ctx.fs.put("yuslotKeshi/id2", encF({ owned: ["body:titan", "weight:gold"], eq: { body: "titan", weight: "gold" }, color: 3 }));
  const before = { ...ctx.fs.counts };
  const a = await ctx.r(1, "keshiRoomStart");
  assert.equal(a.ok, true);
  const y = a.keshi;
  assert.deepEqual([y.order, y.names, y.bout, y.cur, y.starter, y.flicks, y.wins, y.done, y.last], [["id1", "id2"], ["u1", "u2"], 1, 0, 0, 0, [0, 0], false, null]);
  assert.deepEqual(y.pos, START); assert.deepEqual(y.eq[0], KESHI_DEFAULT_EQ); assert.equal(y.eq[1].body, "titan"); assert.deepEqual(y.color, [0, 3]);
  assert.equal(y.rt[0], 50); assert.ok(y.rt[1] > 60); assert.deepEqual(y.par[0], keshiPhys(BASE)); assert.ok(y.par[1].m > y.par[0].m);
  assert.equal(y.deadline - y.at, 34000);
  assert.equal(ctx.fs.counts.getRaw - before.getRaw, 3, "ルーム1件＋2人の消しゴムの書類");
  assert.equal(ctx.fs.counts.commit - before.commit, 1);
  const b = await ctx.r(2, "keshiRoomStart");
  assert.equal(b.keshi.gid, y.gid, "二重に始めない");
  assert.equal(ctx.room().keshi.gid, y.gid); assert.equal(ctx.room().status, "playing", "ルームのほかの項目はそのまま");
  assert.equal(ctx.fs.counts.commit - before.commit, 1, "2回目は書かない");
});

test("2人対戦：弾く。番の人だけ・正しい形だけ。弾くと、動きの結果が書かれて、相手の番になる（読み1・書き1）", async () => {
  const ctx = setup();
  let y = (await ctx.r(1, "keshiRoomStart")).keshi;
  assert.equal((await ctx.r(2, "keshiRoomFlick", { ...aimAt(y), p: 0.5 })).error, "not_your_turn");
  assert.equal((await ctx.r(1, "keshiRoomFlick", { ...aimAt(y), gid: "x", p: 0.5 })).error, "stale");
  for (const bad of [{ p: 0 }, { p: 0.01 }, { p: NaN }, { p: "a" }, { dx: 0, dz: 0 }, { dx: "x" }]) assert.equal((await ctx.r(1, "keshiRoomFlick", { ...aimAt(y), p: 0.5, ...bad })).error, "bad_request", JSON.stringify(bad));
  const before = { ...ctx.fs.counts };
  ctx.state.now += 5000;
  const r = await ctx.r(1, "keshiRoomFlick", { ...aimAt(y), p: 0.4 });
  assert.equal(r.ok, true);
  y = r.keshi;
  assert.equal(y.cur, 1); assert.equal(y.flicks, 1); assert.equal(y.last.n, 1); assert.equal(y.last.by, 0); assert.deepEqual(y.last.from, START); assert.deepEqual(y.last.to, y.pos);
  assert.ok(y.last.vz < 0 && y.last.vx > 0, "相手の向きへ弾いた（相手は少し右前にいる）"); assert.ok(y.pos[0][1] < 2.6 && y.pos[0][1] > 0, "少し前に進んだ");
  assert.deepEqual(y.pos[1], START[1]); assert.ok(y.deadline - y.at >= 30000);
  assert.equal(ctx.fs.counts.getRaw - before.getRaw, 1); assert.equal(ctx.fs.counts.commit - before.commit, 1);
  assert.deepEqual(ctx.room().keshi, y);
  assert.equal((await ctx.r(1, "keshiRoomFlick", { ...aimAt(y), p: 0.4 })).error, "not_your_turn", "続けて弾けない");
  const big = await ctx.r(2, "keshiRoomFlick", { gid: y.gid, dx: 0, dz: 1, p: 7 });
  assert.equal(big.keshi.last.vz, Math.round(keshiLaunchSpeed(y.par[1], 1) * 1000) / 1000, "強さは 1 までに丸める");
});

test("2人対戦：3本勝負。相手を落とすと1本。先に2本取った人の勝ち。2本目は後ろの人から弾く", async () => {
  const ctx = setup();
  const strong = { owned: ["body:pro", "edge:band"], eq: { body: "pro", edge: "band", sole: "bare", weight: "none" }, color: 0 };
  ctx.fs.put("yuslotKeshi/id1", encF(strong)); ctx.fs.put("yuslotKeshi/id2", encF(strong));
  let y = (await ctx.r(1, "keshiRoomStart")).keshi;
  const flick = async (p) => { const r = await ctx.r(who(y), "keshiRoomFlick", { ...aimAt(y), p }); assert.equal(r.ok, true, JSON.stringify(r)); y = r.keshi; return y; };
  y = await flick(1);
  assert.deepEqual([y.wins, y.bout, y.starter, y.cur, y.flicks], [[1, 0], 2, 1, 1, 0], "1本目は先手の勝ち。2本目は後手から");
  assert.deepEqual(y.hist, [{ w: 0, how: "ko" }]); assert.deepEqual(y.pos, START, "机の上の位置が元に戻る");
  assert.equal(y.last.first, 1); assert.ok(Math.abs(y.last.to[1][1]) >= KESHI_DESK.hd || Math.abs(y.last.to[1][0]) >= KESHI_DESK.hw, "落ちた消しゴムの最後の位置は、机の外");
  y = await flick(1);
  assert.deepEqual([y.wins, y.bout, y.starter, y.done], [[1, 1], 3, 0, false], "2本目は後手の勝ち");
  y = await flick(1);
  assert.deepEqual([y.wins, y.done, y.winner, y.reason], [[2, 1], true, 0, "finished"]);
  assert.deepEqual(y.hist.map((h) => h.w), [0, 1, 0]);
  assert.equal((await ctx.r(1, "keshiRoomFlick", { gid: y.gid, dx: 0, dz: -1, p: 0.5 })).error, "no_game");
  assert.equal((await ctx.r(2, "keshiRoomStart")).keshi.done, true, "終わったあとは、そのまま結果を返す");
  const again = (await ctx.r(2, "keshiRoomStart", { rematch: true })).keshi;
  assert.notEqual(again.gid, y.gid); assert.deepEqual([again.wins, again.bout, again.done], [[0, 0], 1, false]);
});

test("2人対戦：自分で机から落ちたら、相手の1本（自滅）", async () => {
  const ctx = setup();
  const y = (await ctx.r(1, "keshiRoomStart")).keshi;
  const r = (await ctx.r(1, "keshiRoomFlick", { gid: y.gid, dx: 0, dz: 1, p: 1 })).keshi;
  assert.deepEqual([r.wins, r.hist[0].how, r.last.first], [[0, 1], "self", 0]);
});

test("2人対戦：8回弾いても落ちなければ、机のふちから遠い（真ん中に近い）ほうが勝ち", async () => {
  const ctx = setup();
  let y = (await ctx.r(1, "keshiRoomStart")).keshi;
  for (let k = 0; k < 8; k++) {
    const mine = y.cur === 0;
    const r = await ctx.r(who(y), "keshiRoomFlick", { gid: y.gid, dx: 0, dz: mine ? 1 : 1, p: mine ? 0.2 : 0.03 });   // 先手は、後ろへ下がっていく（ふちに近づく）
    assert.equal(r.ok, true, JSON.stringify(r)); y = r.keshi;
  }
  assert.deepEqual([y.wins, y.hist[0].how, y.bout], [[0, 1], "edge", 2], "ふちに近づいた先手の負け");
});

test("2人対戦：持ち時間。早すぎる催促は断る・二重に処理しない・続けて2回放置すると負け・弾けば数え直し", async () => {
  const ctx = setup();
  let y = (await ctx.r(1, "keshiRoomStart")).keshi;
  const key = (v) => ({ gid: v.gid, bout: v.bout, flicks: v.flicks, turn: v.cur });
  assert.equal((await ctx.r(2, "keshiRoomTimeout", key(y))).error, "too_early");
  ctx.state.now += 37000;
  assert.equal((await ctx.r(1, "keshiRoomFlick", { ...aimAt(y), p: 0.5 })).error, "timeout", "時間切れのあとは弾けない");
  const t1 = (await ctx.r(2, "keshiRoomTimeout", key(y))).keshi;   // 相手の画面から呼んでもよい
  assert.deepEqual([t1.cur, t1.miss, t1.flicks, t1.done], [1, [1, 0], 1, false]);
  assert.equal((await ctx.r(1, "keshiRoomTimeout", key(y))).keshi.cur, 1, "同じ時間切れを二重に処理しない");
  const f = (await ctx.r(2, "keshiRoomFlick", { ...aimAt(t1), p: 0.3 })).keshi;   // 2人目は普通に弾く → 1人目の番へ
  ctx.state.now += 40000;
  const t2 = (await ctx.r(2, "keshiRoomTimeout", key(f))).keshi;   // 1人目：また放置（弾いた人の miss は 0 に戻っているので、1人目は 2回目）
  assert.deepEqual([t2.done, t2.winner, t2.reason], [true, 1, "timeout"], "続けて2回放置した人は負け");
});

test("2人対戦：参加者だけ。ルームの種類が違う・存在しない・形式が不正なものは断る", async () => {
  const ctx = setup();
  assert.equal((await ctx.r(3, "keshiRoomStart")).error, "not_member");
  assert.equal((await ctx.act(1, { action: "keshiRoomStart", roomId: "nope12345678" })).error, "no_room");
  assert.equal((await ctx.act(1, { action: "keshiRoomStart", roomId: "../x" })).error, "bad_request");
  ctx.fs.put("gameRooms/yacht12345678", encF({ gameType: "yacht", members: ["u1"], memberUids: ["id1"], status: "playing" }));
  assert.equal((await ctx.act(1, { action: "keshiRoomStart", roomId: "yacht12345678" })).error, "bad_request");
  ctx.fs.put("gameRooms/wait1234567890", encF({ gameType: "keshi", members: ["u1"], memberUids: ["id1"], status: "waiting" }));
  assert.equal((await ctx.act(1, { action: "keshiRoomStart", roomId: "wait1234567890" })).error, "not_ready", "2人そろうまで始まらない");
});

test("2人対戦：準備中は最上位管理者だけ。ただし最上位管理者が入っているルームなら、招待された友達も遊べる。公開後は誰でも", async () => {
  const closed = setup({ keshi: false });
  assert.equal((await closed.r(1, "keshiRoomStart")).error, "not_published", "管理者のいない部屋は遊べない");
  const withAdmin = setup({ keshi: false });
  withAdmin.fs.put(`gameRooms/${ROOM}`, encF({ gameType: "keshi", ownerUid: ADMIN, owner: "admin", members: ["admin", "u2"], memberUids: [ADMIN, "id2"], status: "playing" }));
  const adminStart = await handleYuslotAction(withAdmin.deps, ADMIN, { action: "keshiRoomStart", roomId: ROOM, username: "admin" });
  assert.equal(adminStart.ok, true, "最上位管理者は遊べる");
  const guest = await withAdmin.act(2, { action: "keshiRoomFlick", roomId: ROOM, gid: adminStart.keshi.gid, dx: 0, dz: 1, p: 0.5 });
  assert.equal(guest.error, "not_your_turn", "招待された友達は、部屋に入って操作できる（ここでは相手の番）");
  assert.equal((await setup({ keshi: true }).r(1, "keshiRoomStart")).ok, true);
});

test("2人対戦：メンバーが入れ替わったら、新しいゲームを始める（前の人のゲームを引き継がない）", async () => {
  const ctx = setup();
  const first = (await ctx.r(1, "keshiRoomStart")).keshi;
  ctx.fs.put(`gameRooms/${ROOM}`, encF({ ...ctx.room(), members: ["u1", "u3"], memberUids: ["id1", "id3"], keshi: first }));
  const next = (await ctx.act(1, { action: "keshiRoomStart", roomId: ROOM })).keshi;
  assert.notEqual(next.gid, first.gid); assert.deepEqual(next.order, ["id1", "id3"]);
});

test("画面用の動きの数字（yukeshi-core.js）は、サーバーの数字と、全部の組み合わせで同じ", async () => {
  const { keshiPhysView, keshiLaunchSpeedView, keshiStatsView } = await import("../../yukeshi-core.js");
  const { KESHI_PARTS, KESHI_SLOTS } = await import("../worker.js");
  const table = { slots: KESHI_SLOTS, parts: KESHI_PARTS, base: 50 };
  let n = 0;
  for (const body of ["plain", "sponge", "sand", "pro", "titan"]) for (const edge of ["paper", "plastic", "band", "metal", "crystal"]) for (const sole of ["bare", "tape", "wax", "teflon", "air"]) for (const weight of ["none", "coin", "bolt", "lead", "gold"]) {
    const eq = { body, edge, sole, weight }, P = keshiPhys(keshiStats(eq));
    assert.deepEqual(keshiPhysView(keshiStatsView(table, eq)), P);
    for (const p of [0.1, 0.55, 1]) assert.equal(keshiLaunchSpeedView(P, p), keshiLaunchSpeed(P, p));
    n++;
  }
  assert.equal(n, 625);
});
