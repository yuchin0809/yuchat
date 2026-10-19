/* 🎟 宝くじ売り場オープン自動処理（.github/notify-worker/lottery-open.mjs）のテスト（モック Firestore）
   実行：node --test ".github/notify-worker/test/*.test.mjs" */
import test from "node:test";
import assert from "node:assert/strict";
import { run, ANNOUNCE_ID, ANNOUNCE_TITLE, ANNOUNCE_BODY } from "../lottery-open.mjs";

function mockFs() {
  const docs = new Map();
  return {
    _docs: docs,
    async set(p, data) { docs.set(p, structuredClone(data)); },
    async createIfAbsent(p, data) { if (docs.has(p)) return false; docs.set(p, structuredClone(data)); return true; }
  };
}
const deps = (fs) => ({ firestore: fs, now: () => Date.UTC(2026, 9, 19, 12, 0, 0) });

test("オープン：公開・お知らせ投稿・プッシュ通知（コインは配らない）", async () => {
  const fs = mockFs();
  const calls = [];
  const r = await run({ deps: deps(fs), notify: async (_d, id) => { calls.push(id); return { tokens: 3, sent: 3 }; }, log: () => {} });
  assert.equal(fs._docs.get("worldConfig/lottery").lotteryPublished, true, "公開された");
  const ann = fs._docs.get(`announcements/${ANNOUNCE_ID}`);
  assert.ok(ann && ann.title === ANNOUNCE_TITLE && ann.body.includes("ゆう宝くじ売り場"), "お知らせが投稿された");
  assert.deepEqual(calls, [ANNOUNCE_ID], "プッシュ通知が1回呼ばれる");
  assert.equal(r.published, true); assert.equal(r.announced, true);
  assert.equal([...fs._docs.keys()].some((k) => k.startsWith("users/")), false, "ユーザーのコインには触れない");
});

test("お知らせの文章：タイトル50文字・本文500文字まで（アプリの「📢 お知らせ」に載せる長さ）", () => {
  assert.ok([...ANNOUNCE_TITLE].length <= 50, `タイトル ${[...ANNOUNCE_TITLE].length}文字`);
  assert.ok([...ANNOUNCE_BODY].length <= 500, `本文 ${[...ANNOUNCE_BODY].length}文字`);
  assert.match(ANNOUNCE_BODY, /月曜 8:00/); assert.match(ANNOUNCE_BODY, /金曜 14:30/); assert.match(ANNOUNCE_BODY, /前後賞/);
});

test("冪等：もう一度実行してもお知らせは増えない・通知は重複扱い", async () => {
  const fs = mockFs();
  await run({ deps: deps(fs), notify: async () => ({ tokens: 1, sent: 1 }), log: () => {} });
  const r2 = await run({ deps: deps(fs), notify: async () => ({ skipped: "duplicate" }), log: () => {} });
  assert.equal(r2.announced, false, "2回目はお知らせを作らない");
  assert.equal(fs._docs.get("worldConfig/lottery").lotteryPublished, true);
  assert.equal([...fs._docs.keys()].filter((k) => k.startsWith("announcements/")).length, 1);
});

test("プッシュ通知が失敗してもお知らせと公開は残る", async () => {
  const fs = mockFs();
  const r = await run({ deps: deps(fs), notify: async () => { throw new Error("fcm down"); }, log: () => {} });
  assert.equal(r.published, true); assert.equal(r.announced, true); assert.equal(r.notified, null);
});
