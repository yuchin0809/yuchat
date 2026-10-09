/* 🎮 ゲームの招待のプッシュ通知（worker.js の notifyForGameInvite）のテスト
   Firestore・FCM は偽物。実行：node --test "notify-worker/test/*.test.mjs" */

import test from "node:test";
import assert from "node:assert/strict";
import { handleRequest, notifyForGameInvite, isGameRoomJoinable, gameInviteNotificationData } from "../worker.js";

const ORIGIN = "https://yuchin0809.github.io";
const env = { FIREBASE_PROJECT_ID: "demo-yuuchat", ALLOWED_ORIGINS: ORIGIN };
const NOW = Date.parse("2026-10-09T03:00:00Z");
const AT = "2026-10-09T02:59:40Z";

function fakeFirestore(docs) {
  const store = new Map(Object.entries(docs));
  const stats = { reads: 0 };
  return {
    store, stats,
    get: async (path) => { stats.reads++; return store.has(path) ? structuredClone(store.get(path)) : null; },
    batchGet: async (paths) => { stats.reads += paths.length; return paths.map((p) => (store.has(p) ? structuredClone(store.get(p)) : null)); },
    createIfAbsent: async (path, data) => { if (store.has(path)) return false; store.set(path, data); return true; },
    update: async (path, data) => { store.set(path, { ...(store.get(path) || {}), ...data }); },
    delete: async (path) => { store.delete(path); },
    queryIn: async (collection, field, values) => [...store.entries()]
      .filter(([p, d]) => p.startsWith(`${collection}/`) && values.includes(d[field]))
      .map(([p, d]) => ({ id: p.split("/")[1], ...d }))
  };
}

function makeDeps(docs, { invalidTokens = [] } = {}) {
  const sent = [];
  const firestore = fakeFirestore(docs);
  return {
    sent, firestore,
    deps: {
      now: () => NOW,
      verifyIdToken: async (token) => { if (token.startsWith("bad")) throw new Error("invalid"); return token; },
      firestore,
      sendFcm: async (token, data) => { sent.push({ token, data }); return invalidTokens.includes(token) ? { ok: false, invalidToken: true } : { ok: true }; }
    }
  };
}

const room = (gameType, extra = {}) => ({ gameType, owner: "えー", ownerUid: "uA", members: ["えー"], memberUids: ["uA"], status: "waiting", gameState: {}, ...extra });
const invite = (gameType, extra = {}) => ({ roomId: `r-${gameType}`, gameType, from: "えー", fromUid: "uA", to: "びー", toUid: "uB", status: "pending", createdAt: AT, respondedAt: null, ...extra });
const docs = (extra = {}) => ({
  "users/えー": { uid: "uA" }, "users/びー": { uid: "uB" }, "users/しー": { uid: "uC" },
  "friends/えー_びー": { user1: "えー", user2: "びー", user1Uid: "uA", user2Uid: "uB" },
  "fcmTokens/tokA": { uid: "uA" }, "fcmTokens/tokB1": { uid: "uB" }, "fcmTokens/tokB2": { uid: "uB" }, "fcmTokens/tokC": { uid: "uC" },
  "gameRooms/r-daifugo": room("daifugo"), "gameRooms/r-othello": room("othello"), "gameRooms/r-shogi": room("shogi"),
  "gameInvites/r-daifugo_uB": invite("daifugo"), "gameInvites/r-othello_uB": invite("othello"), "gameInvites/r-shogi_uB": invite("shogi"),
  ...extra
});
const post = (body, token = "uA") => new Request("https://w.example/notify", { method: "POST", headers: { Origin: ORIGIN, Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
const call = async (deps, body, token) => { const res = await handleRequest(post(body, token), env, deps); return { status: res.status, body: await res.json() }; };

for (const [gameType, name] of [["daifugo", "大富豪"], ["othello", "オセロ"], ["shogi", "将棋"]]) {
  test(`${name}の招待：招待された人の全端末にだけ届く。名前・ゲーム名・タップ先（招待の画面）`, async () => {
    const { deps, sent } = makeDeps(docs());
    const r = await call(deps, { inviteId: `r-${gameType}_uB` });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { sent: 2, failed: 0, removed: 0, tokens: 2 });
    assert.deepEqual(sent.map((s) => s.token).sort(), ["tokB1", "tokB2"]);
    assert.deepEqual(sent[0].data, {
      kind: "gameInvite", inviteId: `r-${gameType}_uB`, roomId: `r-${gameType}`, gameType, inviteAt: String(Date.parse(AT)),
      title: "🎮 ゲームの招待", body: `えーさんから${name}に招待されました`,
      link: `./?open=games&invite=${encodeURIComponent(`r-${gameType}_uB`)}`, tag: `invite-r-${gameType}_uB`
    });
  });
}

test("同じ招待は何回頼まれても1回だけ。返事のあとにもう一度招待した（時刻が変わった）ときはまた届く", async () => {
  const { deps, sent, firestore } = makeDeps(docs());
  await call(deps, { inviteId: "r-othello_uB" });
  assert.deepEqual((await call(deps, { inviteId: "r-othello_uB" })).body, { skipped: "duplicate" });
  assert.equal(sent.length, 2);
  firestore.store.set("gameInvites/r-othello_uB", invite("othello", { createdAt: "2026-10-09T02:59:55Z" }));
  assert.equal((await call(deps, { inviteId: "r-othello_uB" })).body.sent, 2);
  assert.equal(sent.length, 4);
});

test("招待した本人以外（招待された人・他人）が頼んでも送らない（403）", async () => {
  const { deps, sent } = makeDeps(docs());
  assert.equal((await call(deps, { inviteId: "r-daifugo_uB" }, "uB")).status, 403);
  assert.equal((await call(deps, { inviteId: "r-daifugo_uB" }, "uC")).status, 403);
  assert.equal(sent.length, 0);
});

test("なりすまし・不正な招待は送らない：部屋を作った人でない／他人の名前／友達でない／ID と中身が違う", async () => {
  const cases = [
    ["部屋を作った人でない", { "gameRooms/r-daifugo": room("daifugo", { ownerUid: "uC" }) }, 403],
    ["ゲームの種類が部屋と違う", { "gameRooms/r-daifugo": room("othello") }, 403],
    ["from の名前が本人のものでない", { "gameInvites/r-daifugo_uB": invite("daifugo", { from: "しー" }) }, 403],
    ["to の名前と toUid が合わない", { "gameInvites/r-daifugo_uB": invite("daifugo", { to: "しー" }) }, 403],
    ["友達でない", { "friends/えー_びー": undefined }, 403],
    ["ID と部屋・相手が合わない", { "gameInvites/r-daifugo_uB": invite("daifugo", { roomId: "r-othello" }) }, 400],
    ["知らないゲーム", { "gameInvites/r-daifugo_uB": invite("poker") }, 400]
  ];
  for (const [label, extra, status] of cases) {
    const d = docs(extra);
    Object.keys(extra).forEach((k) => { if (extra[k] === undefined) delete d[k]; });
    const { deps, sent } = makeDeps(d);
    const r = await call(deps, { inviteId: "r-daifugo_uB" });
    assert.equal(r.status, status, label);
    assert.equal(sent.length, 0, label);
  }
});

test("無効な招待には送らない：返事済み／古い招待／部屋が無い／満員／対局中", async () => {
  const cases = [
    ["辞退済み", { "gameInvites/r-othello_uB": invite("othello", { status: "declined" }) }, "not_pending"],
    ["10分より前の招待", { "gameInvites/r-othello_uB": invite("othello", { createdAt: "2026-10-09T02:40:00Z" }) }, "too_old"],
    ["部屋が閉じられた", { "gameRooms/r-othello": undefined }, "room_not_found"],
    ["満員", { "gameRooms/r-othello": room("othello", { members: ["えー", "しー"] }) }, "room_not_joinable"],
    ["対局中", { "gameRooms/r-othello": room("othello", { status: "playing" }) }, "room_not_joinable"]
  ];
  for (const [label, extra, skipped] of cases) {
    const d = docs(extra);
    Object.keys(extra).forEach((k) => { if (extra[k] === undefined) delete d[k]; });
    const { deps, sent } = makeDeps(d);
    assert.deepEqual((await call(deps, { inviteId: "r-othello_uB" })).body, { skipped }, label);
    assert.equal(sent.length, 0, label);
  }
  const { deps } = makeDeps(docs());
  assert.equal((await call(deps, { inviteId: "nothing_uB" })).status, 404);
  assert.equal((await call(deps, { inviteId: "../x" })).status, 400);
});

test("大富豪は、1回のゲームが終わって次を待っている間は招待できる（対局中は不可）", () => {
  assert.equal(isGameRoomJoinable(room("daifugo", { status: "playing", gameState: { phase: "finished" } })), true);
  assert.equal(isGameRoomJoinable(room("daifugo", { status: "playing", gameState: { phase: "playing" } })), false);
  assert.equal(isGameRoomJoinable(room("daifugo", { members: ["a", "b", "c", "d"] })), false);
  assert.equal(isGameRoomJoinable(room("othello", { status: "playing", gameState: { phase: "finished" } })), false);
  assert.equal(isGameRoomJoinable(room("shogi")), true);
});

test("使えなくなったトークンは消し、ログに件数を残す。既存のメッセージ通知（messageId）はそのまま動く", async () => {
  const { deps, firestore } = makeDeps({
    ...docs(),
    "messages/m1": { type: "friend", sender: "えー", senderUid: "uA", receiver: "びー", friendshipId: "えー_びー", createdAt: "2026-10-09T02:59:30Z" }
  }, { invalidTokens: ["tokB2"] });
  assert.deepEqual((await call(deps, { inviteId: "r-shogi_uB" })).body, { sent: 1, failed: 1, removed: 1, tokens: 2 });
  assert.equal(firestore.store.has("fcmTokens/tokB2"), false);
  const log = firestore.store.get(`notificationLogs/invite-r-shogi_uB-${Date.parse(AT)}`);
  assert.equal(log.kind, "gameInvite"); assert.equal(log.sent, 1);
  const m = await call(deps, { messageId: "m1" });
  assert.equal(m.status, 200); assert.equal(m.body.sent, 1);
});

test("通知の本文：名前が長くても切る・知らないゲームは「ゲーム」", () => {
  const d = gameInviteNotificationData("r_uB", invite("othello", { from: "あ".repeat(50) }));
  assert.equal(d.body, `${"あ".repeat(29)}…さんからオセロに招待されました`);
});
