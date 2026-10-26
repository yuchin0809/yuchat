/* 💬 ゆうマートの商品へのコメント（worker.js の martComments*・NPC のコメント／返信）のテスト
   実行：node --test "notify-worker/test/*.test.mjs" */
import test from "node:test";
import assert from "node:assert/strict";
import { KESHI_PARTS, KESHI_SLOTS, KESHI_DEFAULT_EQ, MART, MART_COMMENT, martNpcCommentsFor, martNpcReplyFor, martCommentCheck, resetYuslotCacheForTest, resetLotteryCacheForTest, handleYuslotAction } from "../worker.js";

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
    docs, counts, put, plain, putP: (p, d) => put(p, encF(d)),
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

/* 出品の id を毎回同じ並びにする（NPC が買う／値下げ依頼を出すかは id から決まるので、テストの結果を固定する） */
let uuidSeq = 0;
Object.defineProperty(globalThis, "crypto", { value: { ...globalThis.crypto, randomUUID: () => `${String(++uuidSeq).padStart(8, "0")}-0000-4000-8000-${String(uuidSeq * 7919).padStart(12, "0")}`, getRandomValues: (a) => globalThis.crypto.getRandomValues(a), subtle: globalThis.crypto.subtle }, configurable: true });
const JST = (y, mo, d, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h - 9, mi, 0);
const ADMIN = "adminUid";
const ALL_OWNED = KESHI_SLOTS.flatMap((s) => KESHI_PARTS[s].filter((p) => p.price > 0 && !p.limited).map((p) => `${s}:${p.id}`));

function setup({ coins = 20000, now = JST(2026, 10, 25, 12), owned = [] } = {}) {
  resetYuslotCacheForTest(); resetLotteryCacheForTest();
  const base = { "worldConfig/yuslot": { yuslotPublished: true, keshiPublished: true } };
  for (let i = 0; i < 3; i++) base[`users/u${i}`] = { uid: `id${i}`, name: `u${i}`, coins };
  base["yuslotKeshi/id0"] = { owned, eq: { ...KESHI_DEFAULT_EQ }, color: 0, n: "u0" };
  const fs = fakeFs(base);
  const state = { now };
  const sent = [];
  const deps = { firestore: fs, adminUid: ADMIN, now: () => state.now, random: () => 0.5, slotSecret: "s", slotNpc: false, sendFcm: async (token, msg) => { sent.push({ token, msg }); return { ok: true }; } };
  const act = (i, body) => handleYuslotAction(deps, i === "admin" ? ADMIN : `id${i}`, { username: i === "admin" ? undefined : `u${i}`, ...body });
  return { fs, deps, state, act, sent, coinsOf: (i) => fs.plain(`users/u${i}`).coins, ownedOf: (i) => fs.plain(`yuslotKeshi/id${i}`)?.owned || [], total: () => [0, 1, 2].reduce((a, i) => a + fs.plain(`users/u${i}`).coins, 0) };
}
const MIN = 60000;
const owned = ["body:titan"];
const listed = async (t, price) => (await t.act(0, { action: "martList", slot: "body", part: "titan", price })).id;
const titanRef = Math.round(KESHI_PARTS.body.find((p) => p.id === "titan").price * MART.usedMarket);

test("NPC のコメント：相場の2倍以上なら別々の NPC が10人「高すぎ」系。出品の1〜5分以内に1人目、残りは30分ほどのあいだに。同じ商品なら、いつ見ても同じ", async () => {
  const t = setup({ owned }); const id = await listed(t, titanRef * 3);
  t.state.now += 30 * 1000;
  assert.equal((await t.act(1, { action: "martComments", id })).comments.length, 0, "出品の直後（1分未満）はまだ");
  t.state.now += 5 * MIN;
  const early = (await t.act(1, { action: "martComments", id })).comments;
  assert.equal(early.length >= 1, true, "1〜5分以内に1人目は必ず来る");
  t.state.now += 40 * MIN;
  const all = (await t.act(1, { action: "martComments", id })).comments;
  assert.equal(all.length, 10); assert.equal(new Set(all.map((c) => c.n)).size, 10, "別々の NPC");
  assert.ok(all.every((c) => c.npc && !c.mine && !c.del));
  assert.equal(new Set(all.map((c) => c.x)).size, 10, "言い回しもばらばら");
  assert.ok(all.some((c) => /高すぎ/.test(c.x)));
  assert.deepEqual((await t.act(2, { action: "martComments", id })).comments, all, "だれが見ても同じ");
  assert.ok(all.map((c) => c.t).every((x, i, a) => i === 0 || x >= a[i - 1]), "時間の順");
});

test("NPC のコメント：値段の段階（安い・ふつう・ちょっと高め・かなり高い）。どの出品にも、1〜5分以内に必ず1人は NPC がコメントする", () => {
  const mk = (price) => ({ i: "L1", u: "idX", n: "x", k: "part", slot: "body", part: "titan~u", price, t: 1000000, e: 1000000 + 3 * 86400000 });
  const at = (L, ms) => martNpcCommentsFor(L, L.i, L.t + ms);
  for (const r of [0.3, 0.9, 1.3, 1.7, 2.5, 6]) {
    const L = mk(Math.round(titanRef * r));
    assert.ok(at(L, 5 * MIN + 1000).length >= 1, `相場の${r}倍でも、5分以内に1人`);
    if (r >= MART_COMMENT.highRatio) assert.equal(at(L, 60 * MIN).length, 10, `相場の${r}倍：10人`);
  }
  assert.equal(at(mk(titanRef * 2), 90 * MIN).length, 10, "ちょうど2倍から10人");
  assert.ok(at(mk(Math.round(titanRef * 1.99)), 90 * MIN).length <= 3, "2倍未満は1〜3人");
  assert.equal(at(mk(Math.round(titanRef * 1.0)), 90 * MIN).length, 1);
  assert.ok(at(mk(Math.round(titanRef * 0.5)), 90 * MIN).every((c) => /安|お得|ええ値段|掘り出し|ありがたい/.test(c.x)));
  assert.ok(martNpcCommentsFor({ ...mk(titanRef * 5), npc: true }, "n1-1", 1000000 + 90 * MIN).length <= 2, "NPC の出品へは、多くても2人");
});

test("プレイヤーのコメント：書ける・80文字まで・URL/メール/電話番号/NG は送れない・10秒に1回・1商品10件・最大30件。書いた人の名前が付く", async () => {
  const t = setup({ owned }); const id = await listed(t, titanRef);
  const r = await t.act(1, { action: "martCommentPost", id, text: "これ気になる！" });
  assert.equal(r.ok, true);
  assert.equal(r.comments.find((c) => c.mine).n, "u1");
  assert.equal((await t.act(1, { action: "martCommentPost", id, text: "もう一回" })).error, "too_fast");
  assert.equal((await t.act(1, { action: "martCommentPost", id, text: "" })).error, "empty");
  assert.equal((await t.act(1, { action: "martCommentPost", id, text: "あ".repeat(81) })).error, "too_long");
  for (const bad of ["https://example.com 見て", "www.example.jp", "foo@example.com", "090-1234-5678", "死ね"]) { t.state.now += 11000; assert.ok(["not_allowed", "ng_word"].includes((await t.act(1, { action: "martCommentPost", id, text: bad })).error), bad); }
  assert.equal(martCommentCheck("あ".repeat(80)).text.length, 80);
  for (let i = 0; i < 12; i++) { t.state.now += 11000; await t.act(1, { action: "martCommentPost", id, text: `コメント${i}` }); }
  const mine = (await t.act(1, { action: "martComments", id })).comments.filter((c) => c.mine);
  assert.equal(mine.length, MART_COMMENT.perUser, "1商品に10件まで");
  const doc = t.fs.plain(`martComments/${id}`);
  assert.equal(doc.c.length, 10); assert.ok(doc.exp, "TTL 用の exp");
  assert.equal((await t.act(1, { action: "martCommentPost", id: "n999-1", text: "x" })).error, "gone");
});

test("最大30件：古いものから消える", async () => {
  const t = setup({ owned }); const id = await listed(t, titanRef);
  const users = [1, 2]; let n = 0;
  for (let round = 0; round < 8; round++) for (const u of users) { t.state.now += 11000; if ((await t.act(u, { action: "martCommentPost", id, text: `c${n++}` })).ok !== true) break; }
  t.fs.put(`martComments/${id}`, { ...t.fs.docs.get(`martComments/${id}`).fields, c: { arrayValue: { values: Array.from({ length: 35 }, (_, i) => ({ mapValue: { fields: encF({ i: `x${i}`, u: "idZ", n: "z", t: i, x: `z${i}` }) } })) } } });
  t.state.now += 11000; await t.act(2, { action: "martCommentPost", id, text: "最後" });
  const c = t.fs.plain(`martComments/${id}`).c;
  assert.equal(c.length, MART_COMMENT.max); assert.equal(c[c.length - 1].x, "最後"); assert.equal(c[0].i, "x6");
});

test("プレイヤー同士：返信できる（返信先が記録される）。消せるのは、本人・出品者・最上位管理者だけ", async () => {
  const t = setup({ owned }); const id = await listed(t, titanRef);
  const a = await t.act(1, { action: "martCommentPost", id, text: "いくらまで下がる？" });
  const cid = a.cid;
  t.state.now += 11000;
  const b = await t.act(2, { action: "martCommentPost", id, text: "@u1 私も気になる", replyTo: cid });
  const reply = b.comments.find((c) => c.mine);
  assert.equal(reply.r, cid); assert.equal(reply.rn, "u1");
  assert.equal((await t.act(2, { action: "martCommentDelete", id, cid })).error, "not_allowed", "ほかの人のコメントは消せない");
  const own = await t.act(0, { action: "martComments", id });
  assert.ok(own.comments.filter((c) => !c.npc).every((c) => c.del), "出品者は全部消せる");
  assert.equal((await t.act(1, { action: "martCommentDelete", id, cid })).ok, true, "本人は消せる");
  assert.equal((await t.act("admin", { action: "martCommentDelete", id, cid: reply.cid })).ok, true, "管理者も消せる");
  assert.equal(t.fs.plain(`martComments/${id}`).c.length, 0);
});

test("NPC の返信：NPC の出品では出品者の NPC が必ず返信（20秒〜3分後）。人の出品では、ときどき別の NPC が返信。人どうしのやりとりには返信しない", async () => {
  const t = setup({ owned });
  const st = await t.act(1, { action: "martStatus" });
  const npcItem = st.listings.find((x) => x.npc && x.k === "part" && !x.au);
  assert.ok(npcItem);
  await t.act(1, { action: "martCommentPost", id: npcItem.id, text: "ありがとう！" });
  const early = (await t.act(1, { action: "martComments", id: npcItem.id })).comments;
  t.state.now += 4 * MIN;
  const later = (await t.act(1, { action: "martComments", id: npcItem.id })).comments;
  const rep = later.find((c) => c.npc && c.r);
  assert.ok(rep, "NPC の返信"); assert.equal(rep.n, npcItem.n); assert.equal(rep.rn, "u1"); assert.match(rep.x, /どういたしまして|こちらこそ/);
  assert.equal(early.filter((c) => c.r).length, 0, "すぐには返信しない");
  // 人の出品：約35%の確率なので、たくさん書いて割合を見る。人への返信（r あり）には返信しない
  const L = { i: "Lx", u: "idA", n: "a", k: "part", slot: "body", part: "titan~u", price: titanRef, t: 0, e: 1e12 };
  let got = 0, N = 400; for (let i = 0; i < N; i++) if (martNpcReplyFor(L, "Lx", { i: `c${i}`, u: "idB", n: "b", t: 1000, x: "気になる" }, 1000 + 10 * MIN)) got++;
  assert.ok(got / N > 0.25 && got / N < 0.45, `返信の割合 ${got / N}`);
  assert.equal(martNpcReplyFor(L, "Lx", { i: "c1", u: "idB", n: "b", t: 1000, x: "気になる", r: "zz" }, 1000 + 10 * MIN), null);
});

test("通知：人の出品にコメントが付いたら、出品者に通知（1出品10分に1回まで）。自分のコメントでは通知しない。返信された人にも通知", async () => {
  const t = setup({ owned }); const id = await listed(t, titanRef);
  t.fs.put("fcmTokens/tok0", encF({ uid: "id0" })); t.fs.put("fcmTokens/tok1", encF({ uid: "id1" }));
  const a = await t.act(1, { action: "martCommentPost", id, text: "気になる" });
  assert.equal(t.sent.length, 1); assert.equal(t.sent[0].token, "tok0"); assert.match(t.sent[0].msg.body, /u1：気になる/);
  t.state.now += 11000; await t.act(2, { action: "martCommentPost", id, text: "私も" });
  assert.equal(t.sent.length, 1, "10分以内は、出品者にもう通知しない");
  t.state.now += 11000; await t.act(2, { action: "martCommentPost", id, text: "@u1 どうやろ", replyTo: a.cid });
  assert.equal(t.sent.length, 2); assert.equal(t.sent[1].token, "tok1", "返信された人（u1）に通知");
  t.state.now += 11 * MIN; await t.act(2, { action: "martCommentPost", id, text: "また来た" });
  assert.equal(t.sent.length, 3, "10分たてば、出品者にまた通知");
  t.state.now += 11000; await t.act(0, { action: "martCommentPost", id, text: "返信します" });
  assert.equal(t.sent.length, 3, "出品者自身のコメントでは通知しない");
});

test("読み書きの回数：見る＝書類1回の読み取り（5秒はメモリ）・書き込みなし。書く＝書き込み1回。NPC のコメントは保存しない", async () => {
  const t = setup({ owned }); const id = await listed(t, titanRef * 3);
  t.state.now += 40 * MIN;
  await t.act(1, { action: "martComments", id });
  const g0 = t.fs.counts.getRaw + t.fs.counts.get, c0 = t.fs.counts.commit;
  for (let i = 0; i < 10; i++) { t.state.now += 400; await t.act(2, { action: "martComments", id }); }
  assert.equal(t.fs.counts.getRaw + t.fs.counts.get, g0, "5秒のあいだは何も読まない");
  assert.equal(t.fs.counts.commit, c0, "見るだけでは書かない");
  await t.act(1, { action: "martCommentPost", id, text: "高いなあ" });
  assert.equal(t.fs.counts.commit, c0 + 1, "書くのは1回の commit");
  assert.equal(t.fs.plain(`martComments/${id}`).c.length, 1, "保存されるのはプレイヤーのコメントだけ（NPC の10人ぶんは保存しない）");
});
