/* 通知サーバー（worker.js）のテスト：Emulator を使わず、Firestore・FCM は偽物で動かす
   実行：node --test "notify-worker/test/*.test.mjs" */

import test from "node:test";
import assert from "node:assert/strict";
import { handleRequest, createDefaultDeps, verifyFirebaseIdToken, resetJwksCacheForTest } from "../worker.js";

const PROJECT = "demo-yuuchat";
const ORIGIN = "https://yuchin0809.github.io";
const env = { FIREBASE_PROJECT_ID: PROJECT, ALLOWED_ORIGINS: ORIGIN };

/* ----- 偽の Firestore（メモリ上） ----- */
function fakeFirestore(docs) {
  const store = new Map(Object.entries(docs));
  return {
    store,
    get: async (path) => (store.has(path) ? structuredClone(store.get(path)) : null),
    batchGet: async (paths) => paths.map((p) => (store.has(p) ? structuredClone(store.get(p)) : null)),
    createIfAbsent: async (path, data) => { if (store.has(path)) return false; store.set(path, data); return true; },
    update: async (path, data) => { store.set(path, { ...(store.get(path) || {}), ...data }); },
    delete: async (path) => { store.delete(path); },
    queryIn: async (collection, field, values) => [...store.entries()]
      .filter(([p, d]) => p.startsWith(`${collection}/`) && values.includes(d[field]))
      .map(([p, d]) => ({ id: p.split("/")[1], ...d }))
  };
}

function makeDeps(docs, { now = Date.parse("2026-10-08T03:00:00Z"), invalidTokens = [] } = {}) {
  const sent = [];
  return {
    sent,
    deps: {
      now: () => now,
      verifyIdToken: async (token) => { if (token.startsWith("bad")) throw new Error("invalid"); return token; },
      firestore: fakeFirestore(docs),
      sendFcm: async (token, data) => { sent.push({ token, data }); return invalidTokens.includes(token) ? { ok: false, invalidToken: true } : { ok: true }; }
    }
  };
}

const request = (path, { method = "POST", token, body, origin = ORIGIN } = {}) => new Request(`https://w.example${path}`, {
  method,
  headers: { ...(origin ? { Origin: origin } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
  body: method === "POST" ? JSON.stringify(body ?? {}) : undefined
});
const json = async (res) => ({ status: res.status, body: await res.json().catch(() => null), cors: res.headers.get("Access-Control-Allow-Origin") });

const baseDocs = () => ({
  "users/えー": { uid: "uA", name: "えー" },
  "users/びー": { uid: "uB", name: "びー" },
  "users/しー": { uid: "uC", name: "しー" },
  "friends/えー_びー": { user1: "えー", user2: "びー", user1Uid: "uA", user2Uid: "uB" },
  "groups/g1": { name: "仲良し", members: ["えー", "びー", "しー"] },
  "fcmTokens/tokA": { uid: "uA" },
  "fcmTokens/tokB1": { uid: "uB" },
  "fcmTokens/tokB2": { uid: "uB" },
  "fcmTokens/tokC": { uid: "uC" },
  "messages/m1": { type: "friend", sender: "えー", senderUid: "uA", receiver: "びー", friendshipId: "えー_びー", createdAt: "2026-10-08T02:59:30Z" },
  "messages/g1m": { type: "group", sender: "えー", senderUid: "uA", groupId: "g1", createdAt: "2026-10-08T02:59:30Z" },
  "messages/old": { type: "friend", sender: "えー", senderUid: "uA", receiver: "びー", friendshipId: "えー_びー", createdAt: "2026-10-08T02:00:00Z" }
});

/* ===== HTTP の入口（公開後の確認と同じ項目） ===== */

test("CORS：アプリのサイトからの事前確認（OPTIONS）は 204 と Access-Control-Allow-Origin", async () => {
  const { deps } = makeDeps(baseDocs());
  for (const path of ["/notify", "/admin"]) {
    const res = await handleRequest(request(path, { method: "OPTIONS" }), env, deps);
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  }
});

test("CORS：ほかのサイトからの事前確認は 403", async () => {
  const { deps } = makeDeps(baseDocs());
  const res = await handleRequest(request("/notify", { method: "OPTIONS", origin: "https://evil.example" }), env, deps);
  assert.equal(res.status, 403);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), null);
});

test("/notify・/admin：ログインなし（ID トークンなし）は 401 unauthenticated", async () => {
  const { deps, sent } = makeDeps(baseDocs());
  for (const path of ["/notify", "/admin"]) {
    const r = await json(await handleRequest(request(path, { body: { messageId: "m1" } }), env, deps));
    assert.equal(r.status, 401);
    assert.equal(r.body.error, "unauthenticated");
  }
  assert.equal(sent.length, 0);
});

test("正しくない ID トークンは 401 invalid_token", async () => {
  const { deps } = makeDeps(baseDocs());
  const r = await json(await handleRequest(request("/notify", { token: "bad-token", body: { messageId: "m1" } }), env, deps));
  assert.equal(r.status, 401);
  assert.equal(r.body.error, "invalid_token");
});

test("POST 以外は 405", async () => {
  const { deps } = makeDeps(baseDocs());
  const res = await handleRequest(request("/notify", { method: "GET" }), env, deps);
  assert.equal(res.status, 405);
});

test("messageId が正しくなければ 400", async () => {
  const { deps } = makeDeps(baseDocs());
  const r = await json(await handleRequest(request("/notify", { token: "uA", body: { messageId: "../x" } }), env, deps));
  assert.equal(r.status, 400);
});

/* ===== 通知の本体 ===== */

test("友達チャット：相手の全端末へ送り、送信者には送らない。無効になったトークンは消す", async () => {
  const { deps, sent } = makeDeps(baseDocs(), { invalidTokens: ["tokB2"] });
  const r = await json(await handleRequest(request("/notify", { token: "uA", body: { messageId: "m1" } }), env, deps));
  assert.equal(r.status, 200);
  assert.equal(r.cors, ORIGIN);
  assert.deepEqual(sent.map((s) => s.token).sort(), ["tokB1", "tokB2"]);
  assert.deepEqual([r.body.sent, r.body.failed, r.body.removed], [1, 1, 1]);
  assert.equal(sent[0].data.body, "えーさんからメッセージが届きました");
  assert.equal(deps.firestore.store.has("fcmTokens/tokB2"), false);
  assert.equal(deps.firestore.store.has("notificationLogs/m1"), true);
});

test("同じメッセージの通知は1回だけ", async () => {
  const { deps, sent } = makeDeps(baseDocs());
  await handleRequest(request("/notify", { token: "uA", body: { messageId: "m1" } }), env, deps);
  const first = sent.length;
  const r = await json(await handleRequest(request("/notify", { token: "uA", body: { messageId: "m1" } }), env, deps));
  assert.equal(r.body.skipped, "duplicate");
  assert.equal(first, 2, "1回目は相手の2台へ");
  assert.equal(sent.length, first, "2回目は送らない");
});

/* 無料枠（1日2万回の書き込み）を守るため：通知1件あたりの Firestore への書き込みは notificationLogs の作成1回だけ */
function countLogWrites(deps) {
  const fs = deps.firestore, counts = { create: 0, update: 0 };
  const create = fs.createIfAbsent, update = fs.update;
  fs.createIfAbsent = async (path, data) => { if (path.startsWith("notificationLogs/")) counts.create++; return create(path, data); };
  fs.update = async (path, data) => { if (path.startsWith("notificationLogs/")) counts.update++; return update(path, data); };
  return counts;
}

test("通知の記録の書き込みは1回だけ（作成のみ。送信後に更新しない）：友達・グループ・無効なトークンがあるとき", async () => {
  for (const [messageId, invalidTokens] of [["m1", []], ["g1m", []], ["m1", ["tokB2"]]]) {
    const { deps, sent } = makeDeps(baseDocs(), { invalidTokens });
    const counts = countLogWrites(deps);
    const r = await json(await handleRequest(request("/notify", { token: "uA", body: { messageId } }), env, deps));
    assert.equal(r.status, 200);
    assert.ok(sent.length > 0, "通知は送られる");
    assert.deepEqual(counts, { create: 1, update: 0 }, messageId);
    assert.equal(deps.firestore.store.has(`notificationLogs/${messageId}`), true, "二重送信防止の記録は残る");
  }
});

test("同じメッセージの通知依頼が同時に2回届いても、送るのは1回だけ（1回は duplicate）", async () => {
  const { deps, sent } = makeDeps(baseDocs());
  const counts = countLogWrites(deps);
  const results = await Promise.all([1, 2].map(async () => json(await handleRequest(request("/notify", { token: "uA", body: { messageId: "m1" } }), env, deps))));
  assert.deepEqual(sent.map((s) => s.token).sort(), ["tokB1", "tokB2"]);
  assert.equal(results.filter((r) => r.body.skipped === "duplicate").length, 1);
  assert.equal(counts.update, 0);
});

test("送信を取り消したメッセージ（deleted・画像のデータは消してある）は通知しない。記録も作らない", async () => {
  const docs = baseDocs();
  docs["messages/m1"] = { ...docs["messages/m1"], deleted: true, deletedAt: "2026-10-08T02:59:50Z" };
  const { deps, sent } = makeDeps(docs);
  const r = await json(await handleRequest(request("/notify", { token: "uA", body: { messageId: "m1" } }), env, deps));
  assert.equal(r.body.skipped, "deleted");
  assert.equal(sent.length, 0);
  assert.equal(deps.firestore.store.has("notificationLogs/m1"), false);
});

test("グループ：送信者以外のメンバー全員へ", async () => {
  const { deps, sent } = makeDeps(baseDocs());
  const r = await json(await handleRequest(request("/notify", { token: "uA", body: { messageId: "g1m" } }), env, deps));
  assert.equal(r.status, 200);
  assert.deepEqual(sent.map((s) => s.token).sort(), ["tokB1", "tokB2", "tokC"]);
  assert.match(sent[0].data.body, /仲良しグループに新しいメッセージがあります/);
});

test("送信者本人のメッセージでなければ送らない（403）", async () => {
  const { deps, sent } = makeDeps(baseDocs());
  const r = await json(await handleRequest(request("/notify", { token: "uB", body: { messageId: "m1" } }), env, deps));
  assert.equal(r.status, 403);
  assert.equal(sent.length, 0);
});

test("時間がたったメッセージの通知は送らない", async () => {
  const { deps, sent } = makeDeps(baseDocs());
  const r = await json(await handleRequest(request("/notify", { token: "uA", body: { messageId: "old" } }), env, deps));
  assert.equal(r.body.skipped, "too_old");
  assert.equal(sent.length, 0);
});

/* ===== ID トークンの検証・サービスアカウント ===== */

const b64url = (bytes) => Buffer.from(bytes).toString("base64url");
const enc = (obj) => b64url(Buffer.from(JSON.stringify(obj)));
const keyPair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const otherPair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const jwk = { ...(await crypto.subtle.exportKey("jwk", keyPair.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
const jwksFetch = async () => new Response(JSON.stringify({ keys: [jwk] }), { headers: { "Cache-Control": "max-age=3600" } });
const nowSec = Math.floor(Date.now() / 1000);
const makeToken = async (claims, { kid = "k1", key = keyPair.privateKey } = {}) => {
  const unsigned = `${enc({ alg: "RS256", kid, typ: "JWT" })}.${enc(claims)}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${b64url(new Uint8Array(sig))}`;
};
const good = { aud: PROJECT, iss: `https://securetoken.google.com/${PROJECT}`, sub: "uA", iat: nowSec - 10, exp: nowSec + 3000, auth_time: nowSec - 100 };

test("ID トークン：正しいトークンは uid を返す", async () => {
  resetJwksCacheForTest();
  assert.equal(await verifyFirebaseIdToken(await makeToken(good), PROJECT, jwksFetch), "uA");
});

for (const [name, claims, opts] of [
  ["署名の改ざん", good, { key: otherPair.privateKey }],
  ["期限切れ", { ...good, exp: nowSec - 1 }],
  ["別プロジェクト（aud）", { ...good, aud: "other" }],
  ["発行者が違う（iss）", { ...good, iss: "https://evil" }],
  ["知らない鍵（kid）", good, { kid: "zzz" }],
  ["uid が空", { ...good, sub: "" }]
]) {
  test(`ID トークン：${name}は拒否`, async () => {
    resetJwksCacheForTest();
    await assert.rejects(verifyFirebaseIdToken(await makeToken(claims, opts || {}), PROJECT, jwksFetch));
  });
}

test("サービスアカウント：署名した JWT でアクセストークンを取得して FCM に送る", async () => {
  const saPair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const pkcs8 = Buffer.from(await crypto.subtle.exportKey("pkcs8", saPair.privateKey)).toString("base64").match(/.{1,64}/g).join("\n");
  const sa = { client_email: "sa@demo.iam.gserviceaccount.com", private_key: `-----BEGIN PRIVATE KEY-----\n${pkcs8}\n-----END PRIVATE KEY-----\n`, token_uri: "https://oauth2.mock/token" };
  let seen = null;
  const fetchImpl = async (url, init) => {
    if (url === "https://oauth2.mock/token") {
      const [h, p, s] = new URLSearchParams(init.body).get("assertion").split(".");
      const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", saPair.publicKey, Buffer.from(s, "base64url"), new TextEncoder().encode(`${h}.${p}`));
      seen = { ok, claims: JSON.parse(Buffer.from(p, "base64url")) };
      return new Response(JSON.stringify({ access_token: "AT-1", expires_in: 3600 }));
    }
    if (url.includes("messages:send")) { seen.auth = init.headers.Authorization; return new Response("{}"); }
    throw new Error(`unexpected ${url}`);
  };
  const deps = createDefaultDeps({ FIREBASE_SERVICE_ACCOUNT: JSON.stringify(sa), FIREBASE_PROJECT_ID: PROJECT, FCM_BASE_URL: "https://fcm.mock/v1" }, fetchImpl);
  const r = await deps.sendFcm("tok", { a: "b" });
  assert.ok(r.ok);
  assert.ok(seen.ok, "署名が正しい");
  assert.equal(seen.claims.iss, sa.client_email);
  assert.match(seen.claims.scope, /firebase\.messaging/);
  assert.equal(seen.auth, "Bearer AT-1");
});
