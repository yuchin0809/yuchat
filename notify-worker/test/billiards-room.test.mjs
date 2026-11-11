/* 🎱 ビリヤードの2人対戦・公開・お知らせ（worker.js の billiardsRoom*）のテスト */
import test from "node:test";
import assert from "node:assert/strict";
import { resetYuslotCacheForTest, resetSupporterCacheForTest, handleYuslotAction, runBilliardsAnnounceTick, resetBilliardsAnnounceForTest, BILLIARDS_LAUNCH_MS, BILLIARDS_ANNOUNCE_ID, runScheduledPublishTick, resetScheduledPublishForTest } from "../worker.js";
import { readFileSync } from "node:fs";
import { buildBlock, BEGIN, END } from "../sync-billiards.mjs";
import { newGame, snapshot, restore, shoot, runToRest, endShot, cueBall } from "../../yubilliards-core.js";

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

function setup({ published = true, supporters = ["id1", "id2"] } = {}) {
  resetYuslotCacheForTest(); resetSupporterCacheForTest();
  const base = { "worldConfig/yuslot": { yuslotPublished: true, billiardsPublished: published }, "supporterIndex/all": { byUid: Object.fromEntries(supporters.map((u) => [u, { n: u, m: 1, nc: "default", bc: "default", e: 0 }])) } };
  for (let i = 0; i < 4; i++) base[`users/u${i}`] = { uid: `id${i}`, name: `u${i}`, coins: 1000 };
  const fs = fakeFs(base);
  const state = { now: Date.UTC(2026, 10, 11, 3) };
  const deps = { firestore: fs, adminUid: ADMIN, now: () => state.now, random: () => 0.25, slotSecret: "s", sendFcm: async () => ({ ok: true }) };
  const act = (i, body) => handleYuslotAction(deps, `id${i}`, { username: `u${i}`, ...body });
  fs.put(`gameRooms/${ROOM}`, encF({ gameType: "billiards", ownerUid: "id1", owner: "u1", members: ["u1", "u2"], memberUids: ["id1", "id2"], status: "playing", createdAt: "x" }));
  return { fs, deps, state, act, room: () => fs.plain(`gameRooms/${ROOM}`), r: (i, action, body = {}) => act(i, { action, roomId: ROOM, ...body }) };
}
const who = (y) => (y.order[y.cur] === "id1" ? 1 : 2);

test("写し：Worker の billiards-core は、画面の yubilliards-core.js と同じ（ずれたら node notify-worker/sync-billiards.mjs）", () => {
  const w = readFileSync(new URL("../worker.js", import.meta.url), "utf8");
  const a = w.indexOf(BEGIN), b = w.indexOf(END);
  assert.ok(a > 0 && b > a);
  assert.equal(w.slice(a, b + END.length), buildBlock());
});

test("保存の形：snapshot と restore で、球の位置・グループ・番が元に戻る", () => {
  const g = newGame("eight"); g.groups = ["solid", "stripe"]; g.turn = 1; g.inHand = true; g.balls[3].on = false;
  const r = restore("eight", JSON.parse(JSON.stringify(snapshot(g))));
  assert.deepEqual(snapshot(r), snapshot(g)); assert.equal(r.balls[3].on, false);
  assert.ok(snapshot(g).b.length === 32 && snapshot(g).b.every((n) => typeof n === "number"));
});

test("ルーム：作った人だけが始められ、8ボールか9ボールを選べる。2回呼んでも、ゲームは1つ", async () => {
  const c = setup();
  assert.equal((await c.r(2, "billiardsRoomStart", { mode: "nine" })).error, "not_owner");
  const a = await c.r(1, "billiardsRoomStart", { mode: "nine" });
  assert.equal(a.ok, true); assert.equal(a.billiards.mode, "nine"); assert.equal(a.billiards.st.b.length, 20);
  const b = await c.r(2, "billiardsRoomStart", {});
  assert.equal(b.billiards.gid, a.billiards.gid);
  assert.equal(c.room().billiards.gid, a.billiards.gid);
});

test("ルーム：番でない人は打てない／ゲームが違うと断る／部外者は触れない", async () => {
  const c = setup();
  const y = (await c.r(1, "billiardsRoomStart", { mode: "eight" })).billiards;
  const other = 3 - who(y);
  assert.equal((await c.r(other, "billiardsRoomShoot", { gid: y.gid, angle: 0, power: 0.5 })).error, "not_your_turn");
  assert.equal((await c.r(who(y), "billiardsRoomShoot", { gid: "zzzz", angle: 0, power: 0.5 })).error, "stale");
  assert.equal((await c.r(who(y), "billiardsRoomShoot", { gid: y.gid, angle: 0, power: 0 })).error, "bad_request");
  assert.equal((await c.r(3, "billiardsRoomShoot", { gid: y.gid, angle: 0, power: 0.5 })).error, "not_member");
});

test("ルーム：打つと、Worker が最後まで動かして、結果を決める。同じ打ち方を画面で計算しても、同じ位置になる", async () => {
  const c = setup();
  const y0 = (await c.r(1, "billiardsRoomStart", { mode: "eight" })).billiards;
  const r = await c.r(who(y0), "billiardsRoomShoot", { gid: y0.gid, angle: 0, power: 1 });
  assert.equal(r.ok, true, JSON.stringify(r));
  const y = r.billiards;
  assert.equal(y.last.n, 1); assert.ok(y.last.ticks > 60);
  const g = restore("eight", y0.st); shoot(g, 0, 1, 0, 0); runToRest(g, 6000); endShot(g);
  assert.deepEqual(snapshot(g).b, y.st.b);
  assert.equal(y.cur, g.turn);
  assert.equal(c.room().billiards.last.n, 1);
});

test("ルーム：反則（どの球にも当たらない）なら、相手の番になって、手球を好きな場所に置ける。置き場所のずるは断る", async () => {
  const c = setup();
  const y0 = (await c.r(1, "billiardsRoomStart", { mode: "nine" })).billiards;
  const me = who(y0);
  const g = restore("nine", y0.st); const cue = cueBall(g);
  const angle = Math.atan2(100 - cue.y, 10 - cue.x);   // 球のない左へ、弱く
  const y1 = (await c.r(me, "billiardsRoomShoot", { gid: y0.gid, angle: Math.PI, power: 0.1 })).billiards;
  assert.equal(y1.last.foul, true); assert.equal(y1.cur, 1 - y0.cur); assert.equal(y1.st.h, 1);
  const bad = await c.r(3 - me, "billiardsRoomShoot", { gid: y0.gid, angle: 0, power: 0.5, place: { x: 740, y: 250 } });
  assert.equal(bad.error, "bad_place", "ほかの球に重なる場所には置けない");
  const ok = await c.r(3 - me, "billiardsRoomShoot", { gid: y0.gid, angle: 0, power: 0.5, place: { x: 400, y: 250 } });
  assert.equal(ok.ok, true, JSON.stringify(ok)); assert.equal(ok.billiards.last.place.x, 400);
  void angle;
});

test("ルーム：持ち時間が過ぎると、番が相手に移る。早すぎる呼びかけは断る。2回続けて放置すると負け。もう一度は、勝ち数をためる", async () => {
  const c = setup();
  const y0 = (await c.r(1, "billiardsRoomStart", { mode: "eight" })).billiards;
  const call = (i, y) => c.r(i, "billiardsRoomTimeout", { gid: y.gid, n: y.last ? y.last.n : 0, turn: y.cur });
  assert.equal((await call(1, y0)).error, "too_early");
  c.state.now += 70000;
  const y1 = (await call(1, y0)).billiards;
  assert.equal(y1.cur, 1 - y0.cur); assert.equal(y1.st.h, 1); assert.equal(y1.last.timeout, true);
  c.state.now += 70000;
  const y2 = (await call(2, y1)).billiards;
  assert.equal(y2.cur, y0.cur); assert.equal(y2.done, false);   // 別の人が1回ずつ放置した
  c.state.now += 70000;
  const y3 = (await call(1, y2)).billiards;
  const loser = y3.miss.findIndex((m) => m >= 2);
  assert.equal(y3.done, true); assert.equal(y3.winner, 1 - loser); assert.equal(y3.score[1 - loser], 1);
  const again = (await c.r(2, "billiardsRoomStart", { rematch: true })).billiards;
  assert.notEqual(again.gid, y3.gid); assert.equal(again.score[1 - loser], 1);
});

test("ルーム：公開前は、最上位管理者がいるルーム以外は使えない", async () => {
  const c = setup({ published: false });
  assert.equal((await c.r(1, "billiardsRoomStart", { mode: "eight" })).error, "not_published");
});

test("公開とお知らせ：予約の時刻に、公開のスイッチが入り、お知らせが1回だけ作られて、通知が1回だけ送られる", async () => {
  const c = setup({ published: false });
  resetScheduledPublishForTest(); resetBilliardsAnnounceForTest();
  c.fs.put("fcmTokens/t1", encF({ uid: "id1" })); c.fs.put("fcmTokens/t2", encF({ uid: "id2" }));
  const sent = []; c.deps.sendFcm = async (token, data) => { sent.push([token, data.title, data.link]); return { ok: true }; };
  assert.deepEqual(await runBilliardsAnnounceTick({}, BILLIARDS_LAUNCH_MS - 60000, c.deps), { skipped: "outside" });
  await runScheduledPublishTick({}, BILLIARDS_LAUNCH_MS + 60000, c.deps);
  assert.equal(c.fs.plain("worldConfig/yuslot").billiardsPublished, true);
  const out = await runBilliardsAnnounceTick({}, BILLIARDS_LAUNCH_MS + 60000, c.deps);
  assert.equal(out.sent, 2);
  assert.equal(c.fs.plain(`announcements/${BILLIARDS_ANNOUNCE_ID}`).title.includes("サポーター限定"), true);
  resetBilliardsAnnounceForTest();
  assert.equal((await runBilliardsAnnounceTick({}, BILLIARDS_LAUNCH_MS + 120000, c.deps)).skipped, "duplicate");
  assert.equal(sent.length, 2);
});

test("サポーター限定：公開されても、サポーターと最上位管理者だけ。サポーターでない人は、ルームも、始めることもできない", async () => {
  const c = setup({ supporters: ["id1"] });   // id1 だけサポーター
  const cfg1 = await c.act(1, { action: "config" }), cfg2 = await c.act(2, { action: "config" }), cfg0 = await c.act(0, { action: "config" });
  assert.equal(cfg1.billiardsAllowed, true); assert.equal(cfg2.billiardsAllowed, false); assert.equal(cfg0.billiardsAllowed, false); assert.equal(cfg2.billiardsPublished, true);
  assert.equal((await c.r(2, "billiardsRoomStart", { mode: "eight" })).error, "supporter_only");
  assert.equal((await c.r(1, "billiardsRoomStart", { mode: "eight" })).error, "opponent_not_supporter", "相手がサポーターでないと、始められない");
  const ok = setup({ supporters: ["id1", "id2"] });
  assert.equal((await ok.r(1, "billiardsRoomStart", { mode: "eight" })).ok, true);
});

test("サポーター限定：サポーターをやめた人は、打てなくなる。管理者（ADMIN）は、サポーターでなくても使える", async () => {
  const c = setup();
  const y = (await c.r(1, "billiardsRoomStart", { mode: "eight" })).billiards;
  const me = who(y);
  resetSupporterCacheForTest(); c.fs.put("supporterIndex/all", encF({ byUid: { [me === 1 ? "id2" : "id1"]: { n: "x", m: 1, nc: "default", bc: "default", e: 0 } } }));
  assert.equal((await c.r(me, "billiardsRoomShoot", { gid: y.gid, angle: 0, power: 0.5 })).error, "supporter_only");
  const adm = setup({ supporters: [] });
  const cfgA = await handleYuslotAction(adm.deps, ADMIN, { username: "admin", action: "config" });
  assert.equal(cfgA.billiardsAllowed, true);
});
