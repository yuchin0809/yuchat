/* 📸 YuReal（worker.js の handleYurealAction・runYurealTick）のテスト */
import test from "node:test";
import assert from "node:assert/strict";
import { runYurealLaunchTick, resetYurealLaunchForTest, YUREAL_LAUNCH_MS, YUREAL_ANNOUNCE_ID, handleYurealAction, resetYurealCacheForTest, resetYurealTickForTest, runYurealTick, yurealTimeFor, yurealDateKey } from "../worker.js";

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
    async queryIn(collection, field, values) { return [...docs.entries()].filter(([p]) => p.startsWith(collection + "/")).map(([p, d]) => ({ id: p.split("/").slice(1).join("/"), ...decF(d.fields) })).filter((r) => values.includes(r[field])); },
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
const DAY = Date.UTC(2026, 10, 11, 0) - 9 * 3600000;   // 2026-11-11 日本時間 0:00
const JPG = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";

function setup({ published = false } = {}) {
  resetYurealCacheForTest(); resetYurealTickForTest();
  const base = { "worldConfig/yureal": { published } };
  for (let i = 0; i < 4; i++) base[`users/u${i}`] = { uid: `id${i}`, name: `u${i}`, coins: 0 };
  base["friends/f01"] = { user1Uid: "id0", user2Uid: "id1" };   // id0 と id1 は友達。id2 は、だれとも友達ではない
  const fs = fakeFs(base);
  const key = yurealDateKey(DAY + 12 * 3600000), at = yurealTimeFor(key);
  const state = { now: at + 30000 };
  const sent = [];
  const deps = { firestore: fs, adminUid: ADMIN, now: () => state.now, random: () => 0.1, slotSecret: "s", sendFcm: async (t, d) => { sent.push([t, d.title]); return { ok: true }; } };
  const act = (uid, body) => handleYurealAction(deps, uid, { username: uid.replace("id", "u"), ...body });
  return { fs, deps, state, act, key, at, sent };
}

test("通知の時刻：毎日 9:00〜15:00（日本時間）のどこか。同じ日はいつも同じで、日によって変わる", () => {
  const seen = new Set();
  for (let d = 0; d < 60; d++) {
    const key = yurealDateKey(DAY + d * 86400000 + 3600000), t = yurealTimeFor(key);
    const hh = new Date(t + 9 * 3600000).getUTCHours();
    assert.ok(hh >= 9 && hh < 15, `${key}: ${hh}時`); assert.equal(t, yurealTimeFor(key)); seen.add(t % 86400000);
  }
  assert.ok(seen.size > 30, "日によって、ちがう時刻");
});

test("公開前は、最上位管理者だけ。公開の切り替えは、最上位管理者だけ。公開後はだれでも", async () => {
  const c = setup();
  assert.equal((await c.act("id0", { action: "feed" })).error, "not_published");
  assert.equal((await c.act("id0", { action: "config" })).allowed, false);
  assert.equal((await c.act("id0", { action: "setPublished", published: true })).error, "not_top_admin");
  assert.equal((await handleYurealAction(c.deps, ADMIN, { action: "config" })).allowed, true);
  assert.equal((await handleYurealAction(c.deps, ADMIN, { action: "setPublished", published: true })).published, true);
  assert.equal((await c.act("id0", { action: "config" })).allowed, true);
});

test("投稿：通知の時刻より前はできない。3分以内はちょうどいい、遅れると「○分遅れ」。1日1回。写真の形と大きさを確かめる", async () => {
  const c = setup({ published: true });
  c.state.now = c.at - 1000;
  assert.equal((await c.act("id0", { action: "post", img: JPG })).error, "not_yet");
  c.state.now = c.at + 30000;
  assert.equal((await c.act("id0", { action: "post", img: "data:image/png;base64,AAAA" })).error, "bad_image");
  assert.equal((await c.act("id0", { action: "post", img: "data:image/jpeg;base64," + "A".repeat(230000) })).error, "bad_image");
  assert.equal((await c.act("id0", { action: "post", img: JPG, caption: "http://x" })).error, "bad_caption");
  const ok = await c.act("id0", { action: "post", img: JPG, caption: "ひるごはん" });
  assert.equal(ok.ok, true); assert.equal(ok.lateMin, 0);
  assert.equal((await c.act("id0", { action: "post", img: JPG })).error, "already_posted");
  c.state.now = c.at + 3 * 60000 + 5 * 60000 + 1;   // 8分すこし後（締切の3分から、5分すこし遅れ）
  assert.equal((await c.act("id1", { action: "post", img: JPG })).lateMin, 6);
});

test("見られる範囲：友達だけ。自分が投稿するまで、友達のきょうの写真は見えない。友達でない人の写真は、一覧にも写真にも出ない", async () => {
  const c = setup({ published: true });
  await c.act("id1", { action: "post", img: JPG, caption: "u1" });
  await c.act("id2", { action: "post", img: JPG, caption: "u2" });
  let f0 = await c.act("id0", { action: "feed" });
  assert.equal(f0.items.length, 0); assert.equal(f0.hidden, true); assert.equal(f0.posted, false);
  assert.equal((await c.act("id0", { action: "photo", id: `${c.key}_id1` })).error, "post_first");
  await c.act("id0", { action: "post", img: JPG });
  f0 = await c.act("id0", { action: "feed" });
  assert.deepEqual(f0.items.map((i) => i.name).sort(), ["u0", "u1"], "友達（u1）と自分だけ。u2 は出ない");
  assert.ok(!JSON.stringify(f0).includes("data:image"), "一覧には、写真を入れない");
  assert.equal((await c.act("id0", { action: "photo", id: `${c.key}_id1` })).img, JPG);
  assert.equal((await c.act("id0", { action: "photo", id: `${c.key}_id2` })).error, "not_friend");
});

test("リアクション：友達の写真に、絵文字をタップして送れる。1つの投稿に、1人1個だけ（変えたり外したりはできない）。コメントはない", async () => {
  const c = setup({ published: true });
  await c.act("id1", { action: "post", img: JPG }); await c.act("id0", { action: "post", img: JPG });
  const id = `${c.key}_id1`;
  const r1 = await c.act("id0", { action: "react", id, emoji: "❤️" });
  assert.deepEqual(r1.item.reactions, { "❤️": 1 }); assert.equal(r1.item.myReaction, "❤️");
  assert.equal((await c.act("id0", { action: "react", id, emoji: "❤️" })).error, "already_reacted", "同じものを、もう一度は押せない");
  assert.equal((await c.act("id0", { action: "react", id, emoji: "😢" })).error, "already_reacted", "べつの絵文字も、追加できない");
  assert.equal((await c.act("id0", { action: "react", id, emoji: "" })).error, "bad_emoji", "外すこともできない");
  assert.equal((await c.act("id1", { action: "react", id, emoji: "😢" })).item.reactions["😢"], 1, "ほかの人は、べつに付けられる");
  assert.equal((await c.act("id0", { action: "react", id, emoji: "💩" })).error, "bad_emoji");
  assert.equal((await c.act("id2", { action: "react", id, emoji: "👍" })).error, "not_friend");
  assert.equal((await c.act("id0", { action: "comment", id, text: "いいね" })).error, "unknown_action", "コメントはなくなった");
  assert.equal("comments" in (await c.act("id0", { action: "feed" })).items[0], false);
});

test("きえる時刻：きのうの写真は、きょうの通知の時刻まで見える。その日に自分も投稿したときだけ、友達の写真が見える。通知のあとは、きえる（見えず、データも消える）", async () => {
  const c = setup({ published: true });
  const yk = yurealDateKey(c.at - 86400000);
  const post = (u, mark) => { c.fs.put(`yurealPosts/${yk}_${u}`, encF({ uid: u, name: u.replace("id", "u"), date: yk, at: c.at - 86400000 + 60000, lateMin: 0, caption: mark, reactions: {} })); c.fs.put(`yurealImages/${yk}_${u}`, encF({ img: JPG, uid: u, date: yk })); };
  post("id1", "y1");
  c.state.now = c.at - 3600000;   // きょうの通知の1時間前
  let f = await c.act("id0", { action: "feed" });
  assert.equal(f.items.length, 0, "自分がきのう投稿していないので、友達のきのうの写真は見えない"); assert.equal(f.hidden, true);
  assert.equal((await c.act("id0", { action: "photo", id: `${yk}_id1` })).error, "post_first");
  post("id0", "y0");
  f = await c.act("id0", { action: "feed" });
  assert.deepEqual(f.items.map((i) => i.name).sort(), ["u0", "u1"], "自分もきのう投稿していれば、見える");
  assert.equal((await c.act("id0", { action: "photo", id: `${yk}_id1` })).img, JPG);
  c.state.now = c.at + 30000;     // きょうの通知の時刻をすぎた
  f = await c.act("id0", { action: "feed" });
  assert.equal(f.items.length, 0, "きのうの写真は、きえる");
  assert.equal((await c.act("id0", { action: "photo", id: `${yk}_id1` })).error, "gone");
  assert.equal((await c.act("id0", { action: "react", id: `${yk}_id1`, emoji: "❤️" })).error, "gone");
  c.fs.put("fcmTokens/t0", encF({ uid: "id0" }));
  const out = await runYurealTick({}, c.at + 60000, c.deps);   // 通知のとき、きのうまでの分を消す
  assert.equal(out.expired, 2); assert.equal(c.fs.plain(`yurealPosts/${yk}_id1`), null); assert.equal(c.fs.plain(`yurealImages/${yk}_id0`), null);
});

test("消す：自分の投稿は消せる。友達は消せない", async () => {
  const c = setup({ published: true });
  await c.act("id1", { action: "post", img: JPG }); await c.act("id0", { action: "post", img: JPG });
  const id = `${c.key}_id1`;
  assert.equal((await c.act("id0", { action: "deletePost", id })).error, "not_owner");
  assert.equal((await c.act("id1", { action: "deletePost", id })).ok, true);
  assert.equal(c.fs.plain(`yurealPosts/${id}`), null); assert.equal(c.fs.plain(`yurealImages/${id}`), null);
});

test("通知：決まった時刻の5分だけ。公開前は最上位管理者にだけ。同じ日は1回だけ。それ以外の時刻は何もしない", async () => {
  const c = setup();
  c.fs.put("fcmTokens/ta", encF({ uid: ADMIN })); c.fs.put("fcmTokens/t0", encF({ uid: "id0" }));
  assert.equal((await runYurealTick({}, c.at - 60000, c.deps)).skipped, "outside");
  const out = await runYurealTick({}, c.at + 60000, c.deps);
  assert.equal(out.notify.sent, 1); assert.deepEqual(c.sent, [["ta", "📸 YuSnap の時間です！"]]);
  assert.equal((await runYurealTick({}, c.at + 120000, c.deps)).skipped, "outside");
  const d2 = setup({ published: true });
  d2.fs.put("fcmTokens/ta", encF({ uid: ADMIN })); d2.fs.put("fcmTokens/t0", encF({ uid: "id0" }));
  assert.equal((await runYurealTick({}, d2.at + 60000, d2.deps)).notify.sent, 2, "公開後は全員");
});

test("古い写真の掃除：毎日3:10〜3:20に、2日より古い分（2〜3日前）を消す。きょう・きのうは残す", async () => {
  const c = setup({ published: true });
  const dk = (back) => yurealDateKey(c.at - back * 86400000);
  for (const [b, u] of [[0, "a"], [1, "b"], [2, "c"], [3, "d"]]) { c.fs.put(`yurealPosts/${dk(b)}_${u}`, encF({ uid: u, date: dk(b) })); c.fs.put(`yurealImages/${dk(b)}_${u}`, encF({ img: JPG })); }
  const t = jst310(c.at);
  const out = await runYurealTick({}, t, c.deps);
  assert.equal(out.pruned, 2);
  assert.ok(c.fs.plain(`yurealPosts/${dk(0)}_a`) && c.fs.plain(`yurealPosts/${dk(1)}_b`));
  assert.equal(c.fs.plain(`yurealPosts/${dk(2)}_c`), null); assert.equal(c.fs.plain(`yurealImages/${dk(3)}_d`), null);
});
function jst310(atMs) { const key = yurealDateKey(atMs); return Date.UTC(Number(key.slice(0, 4)), Number(key.slice(4, 6)) - 1, Number(key.slice(6, 8))) - 9 * 3600000 + (3 * 60 + 12) * 60000; }

test("公開とお知らせ：決まった時刻に、公開のスイッチが入り、お知らせが1回だけ作られ、通知が1回だけ全員へ送られる。あとから非公開に戻しても、入れ直さない", async () => {
  const c = setup(); resetYurealLaunchForTest();
  c.fs.put("fcmTokens/t0", encF({ uid: "id0" })); c.fs.put("fcmTokens/t1", encF({ uid: "id1" }));
  assert.equal((await runYurealLaunchTick({}, YUREAL_LAUNCH_MS - 60000, c.deps)).skipped, "outside");
  const out = await runYurealLaunchTick({}, YUREAL_LAUNCH_MS + 60000, c.deps);
  assert.equal(out.sent, 2);
  assert.equal(c.fs.plain("worldConfig/yureal").published, true);
  const a = c.fs.plain(`announcements/${YUREAL_ANNOUNCE_ID}`);
  assert.ok(a.title.includes("ベータ版")); assert.ok(!/\d{1,2}[:：時]\d{2}/.test(a.body), "お知らせに、通知の時刻は書かない");
  assert.equal((await runYurealLaunchTick({}, YUREAL_LAUNCH_MS + 120000, c.deps)).skipped, "done");
  resetYurealLaunchForTest(); resetYurealCacheForTest();
  await handleYurealAction(c.deps, ADMIN, { action: "setPublished", published: false });
  assert.equal((await runYurealLaunchTick({}, YUREAL_LAUNCH_MS + 180000, c.deps)).skipped, "duplicate");
  assert.equal(c.fs.plain("worldConfig/yureal").published, false, "管理者が戻したあとは、入れ直さない");
});
