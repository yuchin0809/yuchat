/* 🏇 ゆうダービー開始1分前・📢 新しいお知らせ のプッシュ通知（worker.js）のテスト
   Firestore・FCM は偽物。実行：node --test "notify-worker/test/*.test.mjs" */

import test from "node:test";
import assert from "node:assert/strict";
import worker, { dailyDerbyRaces, notifyDerbyStartingSoon, runScheduled, sendBroadcastNotification, handleAdminAction, handleRequest } from "../worker.js";

const ADMIN = "adminUid";
const jst = (text) => Date.parse(`${text}+09:00`);

function fakeFirestore(docs = {}) {
  const store = new Map(Object.entries(docs));
  const versions = new Map();
  let clock = 0;
  const stats = { queries: [], gets: 0, writes: 0 };
  const cmp = (a, op, b) => ({ EQUAL: a === b, GREATER_THAN: a > b, GREATER_THAN_OR_EQUAL: a >= b, LESS_THAN: a < b, LESS_THAN_OR_EQUAL: a <= b }[op]);
  const norm = (v) => (v instanceof Date ? v.getTime() : typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v) ? Date.parse(v) : v);
  return {
    store, stats,
    async query(collection, filters = []) {
      stats.queries.push(collection);
      return [...store.entries()]
        .filter(([p]) => p.startsWith(`${collection}/`) && p.split("/").length === 2)
        .filter(([, d]) => filters.every(([f, op, v]) => cmp(norm(d[f]), op, norm(v))))
        .map(([p, d]) => ({ id: p.split("/")[1], path: p, data: { ...d, raceAt: d.raceAt instanceof Date ? d.raceAt.toISOString() : d.raceAt } }));
    },
    async get(path) { stats.gets++; return store.has(path) ? { ...store.get(path) } : null; },
    async createIfAbsent(path, data) { if (store.has(path)) return false; stats.writes++; store.set(path, data); versions.set(path, ++clock); return true; },
    async update(path, data) { stats.writes++; store.set(path, { ...(store.get(path) || {}), ...data }); versions.set(path, ++clock); },
    async delete(path) { stats.writes++; store.delete(path); },
    /* worker.js の getRaw / commit と同じ形（文字列の項目だけ・更新時刻の条件つき） */
    async getRaw(path) {
      stats.gets++;
      if (!store.has(path)) return null;
      const fields = Object.fromEntries(Object.entries(store.get(path)).filter(([, v]) => typeof v === "string").map(([k, v]) => [k, { stringValue: v }]));
      return { fields, updateTime: `t${versions.get(path) || 0}` };
    },
    docName: (path) => `docs/${path}`,
    async commit(writes) {
      for (const w of writes) {
        const path = w.update.name.slice("docs/".length);
        if (w.currentDocument?.updateTime && w.currentDocument.updateTime !== `t${versions.get(path) || 0}`) {
          throw Object.assign(new Error("FAILED_PRECONDITION"), { status: 400 });
        }
      }
      for (const w of writes) {
        const path = w.update.name.slice("docs/".length);
        const data = Object.fromEntries(Object.entries(w.update.fields).map(([k, v]) => [k, v.stringValue ?? v.timestampValue ?? v]));
        stats.writes++; store.set(path, data); versions.set(path, ++clock);
      }
    }
  };
}

function makeDeps(docs, { now = Date.now(), fcm } = {}) {
  const sent = [];
  const firestore = fakeFirestore(docs);
  return {
    sent, firestore,
    deps: {
      now: () => now,
      adminUid: ADMIN,
      firestore,
      verifyIdToken: async (t) => t,
      sendFcm: async (token, data) => {
        sent.push({ token, data });
        if (fcm) return fcm(token);
        return { ok: true };
      }
    }
  };
}

const TOKENS = { "fcmTokens/tA": { uid: "uA" }, "fcmTokens/tB": { uid: "uB" }, "fcmTokens/bad": { uid: "uC" } };

/* ===== スケジュール ===== */

test("開催スケジュール：11:30（2026-10-07 から）と 15:02。raceId は script.js・derby-runner と同じ形", () => {
  assert.deepEqual(dailyDerbyRaces("2026-10-08"), [
    { raceId: "2026-10-08-1130", raceAt: jst("2026-10-08T11:30:00") },
    { raceId: "2026-10-08", raceAt: jst("2026-10-08T15:02:00") }
  ]);
  assert.deepEqual(dailyDerbyRaces("2026-10-06").map((r) => r.raceId), ["2026-10-06"], "11:30 の回は 2026-10-07 から");
});

for (const [label, at, expected] of [
  ["15:01:00（Cron の時刻ちょうど）", "2026-10-08T15:01:00", ["2026-10-08"]],
  ["15:01:20（Cron が少し遅れた）", "2026-10-08T15:01:20", ["2026-10-08"]],
  ["15:01:59（Cron が大きく遅れた）", "2026-10-08T15:01:59", ["2026-10-08"]],
  ["11:29:00", "2026-10-08T11:29:00", ["2026-10-08-1130"]],
  ["11:28:00（2分前はまだ）", "2026-10-08T11:28:00", []],
  ["11:30:00（開始したあとは送らない）", "2026-10-08T11:30:00", []],
  ["15:00:00（2分前はまだ）", "2026-10-08T15:00:00", []],
  ["15:00:59（2分前の分）", "2026-10-08T15:00:59", []],
  ["15:02:00（開始したあとは送らない）", "2026-10-08T15:02:00", []],
  ["2026-10-06 11:29（11:30 の回が始まる前の日）", "2026-10-06T11:29:00", []],
  ["12:00:00（レースが無い時刻）", "2026-10-08T12:00:00", []]
]) {
  test(`開始1分前の判定：${label} → ${expected.join("・") || "なし"}`, async () => {
    const { deps, sent } = makeDeps({ ...TOKENS });
    const r = await notifyDerbyStartingSoon(deps, jst(at));
    assert.deepEqual(r.races.map((x) => x.raceId), expected);
    assert.equal(sent.length, expected.length * 3);
    if (expected.length) {
      assert.deepEqual(sent[0].data, { kind: "derby", raceId: expected[0], title: "🏇 ゆうダービー", body: "あと1分でゆうダービーが始まります！", link: "./?open=derby", tag: `derby-${expected[0]}` });
    }
  });
}

test("手動レース：raceAt の1分前に通知。キャンセルされたレースには送らない", async () => {
  const { deps, sent } = makeDeps({
    ...TOKENS,
    "derbyManualRaces/2026-10-08-m1800": { raceAt: new Date(jst("2026-10-08T18:00:00")), status: "scheduled" },
    "derbyManualRaces/2026-10-08-m1805": { raceAt: new Date(jst("2026-10-08T18:05:00")), status: "cancelled" },
    "derbyManualRaces/2026-10-08-m1900": { raceAt: new Date(jst("2026-10-08T19:00:00")), status: "scheduled" }
  });
  assert.deepEqual((await notifyDerbyStartingSoon(deps, jst("2026-10-08T17:59:00"))).races.map((x) => x.raceId), ["2026-10-08-m1800"]);
  assert.deepEqual((await notifyDerbyStartingSoon(deps, jst("2026-10-08T18:04:00"))).races.map((x) => x.raceId), []);
  assert.equal(new Set(sent.map((s) => s.data.raceId)).size, 1);
});

test("1日を毎分 Cron で回すと、各レースはちょうど「開始1分前の分」に1回だけ通知（自動 11:30・15:02、手動 18:00・秒ずれ 20:00:30）", async () => {
  const { deps, sent } = makeDeps({
    ...TOKENS,
    "derbyManualRaces/2026-10-08-m1800": { raceAt: new Date(jst("2026-10-08T18:00:00")), status: "scheduled" },
    "derbyManualRaces/2026-10-08-m2000": { raceAt: new Date(jst("2026-10-08T20:00:30")), status: "scheduled" }
  });
  const firedAt = {};
  for (let t = jst("2026-10-08T00:00:00"); t < jst("2026-10-09T00:00:00"); t += 60000) {
    const r = await notifyDerbyStartingSoon(deps, t);
    r.races.filter((x) => !x.skipped).forEach((x) => { (firedAt[x.raceId] ||= []).push(new Date(t + 9 * 3600000).toISOString().slice(11, 16)); });
  }
  assert.deepEqual(firedAt, {
    "2026-10-08-1130": ["11:29"],
    "2026-10-08": ["15:01"],
    "2026-10-08-m1800": ["17:59"],
    "2026-10-08-m2000": ["19:59"]
  });
  assert.equal(sent.length, 4 * 3, "4レース × 3台、二重送信なし");
});

test("日付をまたぐ時刻（23:59）でも動く（翌日の回も見る）", async () => {
  const { deps } = makeDeps({ ...TOKENS, "derbyManualRaces/2026-10-09-m0000": { raceAt: new Date(jst("2026-10-09T00:00:00")), status: "scheduled" } });
  assert.deepEqual((await notifyDerbyStartingSoon(deps, jst("2026-10-08T23:59:00"))).races.map((x) => x.raceId), ["2026-10-09-m0000"]);
});

test("同じレースは二重に通知しない（Cron が2回動いても・手で呼び直しても）", async () => {
  const { deps, sent } = makeDeps({ ...TOKENS });
  await notifyDerbyStartingSoon(deps, jst("2026-10-08T15:01:00"));
  const second = await notifyDerbyStartingSoon(deps, jst("2026-10-08T15:01:30"));
  assert.equal(second.races[0].skipped, "duplicate");
  assert.equal(sent.length, 3);
  assert.ok(deps.firestore.store.has("notificationLogs/derby-2026-10-08"));
});

test("読み取りは毎分「手動レースの問い合わせ1回」だけ。通知を送るときだけ fcmTokens を読む", async () => {
  const { deps } = makeDeps({ ...TOKENS });
  await notifyDerbyStartingSoon(deps, jst("2026-10-08T12:00:00"));
  assert.deepEqual(deps.firestore.stats.queries, ["derbyManualRaces"]);
  assert.equal(deps.firestore.stats.writes, 0);
  await notifyDerbyStartingSoon(deps, jst("2026-10-08T15:01:00"));
  assert.deepEqual(deps.firestore.stats.queries, ["derbyManualRaces", "derbyManualRaces", "fcmTokens"]);
});

test("通知トークンが1つも無くてもエラーにならない", async () => {
  const { deps, sent } = makeDeps({});
  const r = await notifyDerbyStartingSoon(deps, jst("2026-10-08T15:01:00"));
  assert.deepEqual([r.races[0].tokens, r.races[0].sent], [0, 0]);
  assert.equal(sent.length, 0);
});

test("使えなくなったトークンは消し、1台の送信が失敗（例外）しても、ほかの端末には送る", async () => {
  const { deps } = makeDeps({ ...TOKENS }, { fcm: (t) => { if (t === "bad") return { ok: false, invalidToken: true }; if (t === "tB") throw new Error("network"); return { ok: true }; } });
  const r = await sendBroadcastNotification(deps, "derby-x", { kind: "derby", title: "t", body: "b" });
  assert.deepEqual([r.sent, r.failed, r.removed], [1, 2, 1]);
  assert.equal(deps.firestore.store.has("fcmTokens/bad"), false);
  assert.equal(deps.firestore.store.has("fcmTokens/tA"), true);
});

test("iPhone アプリの端末（platform: ios-app）には、賭けゲーム（ダービー・確変）の通知は送らない。お知らせなど、ほかの通知は送る", async () => {
  const { deps, sent } = makeDeps({ ...TOKENS, "fcmTokens/appT": { uid: "uA", platform: "ios-app" } });
  const d = await sendBroadcastNotification(deps, "derby-app-1", { kind: "derby", title: "t", body: "b" });
  assert.equal(sent.some((x) => x.token === "appT"), false, "ダービーは、アプリの端末に送らない");
  assert.ok(d.sent >= 1, "ウェブの端末には、送る");
  const k = await sendBroadcastNotification(deps, "kaku-app-1", { kind: "kaku", title: "t", body: "b" });
  assert.equal(sent.some((x) => x.token === "appT"), false);
  await sendBroadcastNotification(deps, "announcement-app-1", { kind: "announcement", title: "t", body: "b" });
  assert.equal(sent.some((x) => x.token === "appT"), true, "お知らせは、アプリの端末にも送る");
});

test("Cron の入口：worker の scheduled が runScheduled を呼ぶ（アプリを閉じていても Cloudflare が毎分動かす）", async () => {
  assert.equal(typeof worker.scheduled, "function");
  const { deps, sent } = makeDeps({ ...TOKENS });
  const r = await runScheduled({}, jst("2026-10-08T11:29:00"), deps);
  assert.deepEqual(r.races.map((x) => x.raceId), ["2026-10-08-1130"]);
  assert.equal(sent.length, 3);
  let waited = null;
  await worker.scheduled({ scheduledTime: jst("2026-10-08T12:00:00") }, { ACCESS_TOKEN_OVERRIDE: "x", FIRESTORE_BASE_URL: "http://127.0.0.1:9" }, { waitUntil: (p) => { waited = p; } });
  await waited; /* 接続できなくても例外で止まらない（ログに出すだけ） */
});

/* ===== 📢 新しいお知らせ ===== */

const ANN = { "announcements/a1": { title: "ゆうコインの管理を追加しました", body: "本文" } };

test("お知らせの通知：管理者だけ。タイトル「📢 ゆうChatアップデート」・本文はお知らせのタイトル・タップでお知らせ画面", async () => {
  const { deps, sent } = makeDeps({ ...TOKENS, ...ANN });
  const r = await handleAdminAction(deps, ADMIN, { action: "notifyAnnouncement", announcementId: "a1" });
  assert.equal(r.ok, true); assert.equal(r.sent, 3);
  assert.deepEqual(sent[0].data, { kind: "announcement", announcementId: "a1", title: "📢 ゆうChatアップデート", body: "ゆうコインの管理を追加しました", link: "./?open=announcements", tag: "announcement-a1" });
});

test("お知らせの通知：同じお知らせは二重に送らない", async () => {
  const { deps, sent } = makeDeps({ ...TOKENS, ...ANN });
  await handleAdminAction(deps, ADMIN, { action: "notifyAnnouncement", announcementId: "a1" });
  const again = await handleAdminAction(deps, ADMIN, { action: "notifyAnnouncement", announcementId: "a1" });
  assert.equal(again.skipped, "duplicate");
  assert.equal(sent.length, 3);
});

test("お知らせの通知：管理者以外は 403・存在しないお知らせは 404・ID が不正なら 400（何も送らない）", async () => {
  const { deps, sent } = makeDeps({ ...TOKENS, ...ANN });
  assert.equal((await handleAdminAction(deps, "uA", { action: "notifyAnnouncement", announcementId: "a1" })).status, 403);
  assert.equal((await handleAdminAction(deps, ADMIN, { action: "notifyAnnouncement", announcementId: "nope" })).status, 404);
  assert.equal((await handleAdminAction(deps, ADMIN, { action: "notifyAnnouncement", announcementId: "../x" })).status, 400);
  assert.equal(sent.length, 0);
});

test("お知らせの通知：ログインなしの /admin は 401（既存と同じ）", async () => {
  const { deps } = makeDeps({ ...TOKENS, ...ANN });
  const res = await handleRequest(new Request("https://w/admin", { method: "POST", headers: { Origin: "https://yuchin0809.github.io" }, body: JSON.stringify({ action: "notifyAnnouncement", announcementId: "a1" }) }), { ALLOWED_ORIGINS: "https://yuchin0809.github.io" }, deps);
  assert.equal(res.status, 401);
});

/* ===== 通知記録（notificationLogs）を先に作られても、通知は止まらない ===== */

test("ブラウザなどから先に作られた（Worker の印が無い）通知記録は引き継いで送る。2回目は送らない", async () => {
  const { deps, sent, firestore } = makeDeps({ ...TOKENS, "notificationLogs/derby-2026-10-08": { kind: "derby" } });
  const first = await sendBroadcastNotification(deps, "derby-2026-10-08", { kind: "derby", title: "t", body: "b" });
  assert.equal(first.tokens, 3);
  assert.equal(sent.length, 3);
  assert.equal(firestore.store.get("notificationLogs/derby-2026-10-08").by, "notify-worker");
  const second = await sendBroadcastNotification(deps, "derby-2026-10-08", { kind: "derby", title: "t", body: "b" });
  assert.deepEqual(second, { skipped: "duplicate" });
  assert.equal(sent.length, 3, "二重に送らない");
});

test("Worker が作った通知記録があれば送らない（チャット以外の全員への通知）", async () => {
  const { deps, sent } = makeDeps({ ...TOKENS, "notificationLogs/announcement-pr-9": { kind: "announcement", by: "notify-worker" } });
  assert.deepEqual(await sendBroadcastNotification(deps, "announcement-pr-9", { kind: "announcement" }), { skipped: "duplicate" });
  assert.equal(sent.length, 0);
});

test("印の無い記録を2つの実行が同時に引き継ごうとしても、送るのは1回だけ", async () => {
  const { deps, sent } = makeDeps({ ...TOKENS, "notificationLogs/derby-2026-10-08": { kind: "derby" } });
  const results = await Promise.all([
    sendBroadcastNotification(deps, "derby-2026-10-08", { kind: "derby" }),
    sendBroadcastNotification(deps, "derby-2026-10-08", { kind: "derby" })
  ]);
  assert.equal(results.filter((r) => r.skipped === "duplicate").length, 1);
  assert.equal(sent.length, 3);
});
