import test from "node:test";
import assert from "node:assert/strict";
import { sendFcmMessage } from "../worker.js";

test("通知の送信：Web（webpush）に加えて、iPhone アプリ（apns）用の「画面に出る通知」も付く", async () => {
  let sent = null;
  const fetchImpl = async (url, init) => { sent = JSON.parse(init.body); return { ok: true }; };
  const r = await sendFcmMessage({ base: "https://fcm.test/v1", projectId: "p", getAccessToken: async () => "tok", fetchImpl }, "device-token", { kind: "message", title: "ゆうさん", body: "こんにちは", tag: "chat-1", link: "./" });
  assert.equal(r.ok, true);
  const m = sent.message;
  assert.equal(m.token, "device-token");
  assert.equal(m.data.title, "ゆうさん");
  assert.ok(m.webpush.headers.TTL);
  assert.equal(m.apns.payload.aps.alert.title, "ゆうさん");
  assert.equal(m.apns.payload.aps.alert.body, "こんにちは");
  assert.equal(m.apns.payload.aps["thread-id"], "chat-1");
  assert.equal(m.apns.headers["apns-push-type"], "alert");
  assert.equal(m.notification, undefined, "Web に二重に出さないため、notification は付けない");
});
