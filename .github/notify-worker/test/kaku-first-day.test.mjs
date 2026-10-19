/* 🌈 確変台 初日の準備（.github/notify-worker/kaku-first-day.mjs）のテスト（モック Firestore） */
import test from "node:test";
import assert from "node:assert/strict";
import { run, ANNOUNCE_ID, ANNOUNCE_TITLE, announceBody } from "../kaku-first-day.mjs";
import { kakuMachineFor, KAKU_MACHINE_NAMES, KAKU_EPOCH } from "../../../notify-worker/worker.js";

function mockFs() {
  const docs = new Map();
  return {
    _docs: docs,
    docName: (p) => `projects/p/databases/(default)/documents/${p}`,
    async getRaw(p) { return docs.has(p) ? { fields: {}, updateTime: "t1", _plain: docs.get(p) } : null; },
    async createIfAbsent(p, data) { if (docs.has(p)) return false; docs.set(p, structuredClone(data)); return true; }
  };
}
test("初日の準備：ドキュメントとお知らせを作る（2回目は何も増えない）。お知らせの長さは制限内", async () => {
  const fs = mockFs();
  // 前日の抽選の締切（20:00 UTC ＝ 05:00 JST…ではなく、前日21:00 JST ＝ 12:00 UTC）のあとに実行したことにする
  const deps = { firestore: fs, now: () => Date.UTC(2026, 9, 19, 15, 40, 0), random: Math.random };
  const machine = KAKU_MACHINE_NAMES[kakuMachineFor(KAKU_EPOCH)];
  // kakuEnsureDay は getRaw で読み直すので、モックの getRaw が decodeFields できる形を返すようにする
  fs.getRaw = async (p) => (fs._docs.has(p) ? { fields: { day: { stringValue: KAKU_EPOCH }, mode: { stringValue: "sameDay" } }, updateTime: "t1" } : null);
  const r1 = await run({ deps, log: () => {} });
  assert.equal(r1.machine, machine); assert.equal(r1.announced, true);
  assert.ok(fs._docs.has(`yuslotKaku/${KAKU_EPOCH}`), "初日のドキュメント");
  assert.equal(fs._docs.get(`yuslotKaku/${KAKU_EPOCH}`).mode, "sameDay", "前日の抽選の締切後なので当日分だけ");
  assert.equal(fs._docs.get(`yuslotKaku/${KAKU_EPOCH}`).draw1Done, true);
  const ann = fs._docs.get(`announcements/${ANNOUNCE_ID}`);
  assert.ok(ann.title === ANNOUNCE_TITLE(machine) && [...ann.title].length <= 50, `タイトル ${[...ann.title].length}文字`);
  assert.ok([...announceBody(machine)].length <= 500, `本文 ${[...announceBody(machine)].length}文字`);
  assert.match(ann.body, /抽選3枠・先着2枠/); assert.match(ann.body, /7:00〜10:45/); assert.match(ann.body, /11:45/);
  const r2 = await run({ deps, log: () => {} });
  assert.equal(r2.announced, false);
  assert.equal([...fs._docs.keys()].filter((k) => k.startsWith("announcements/")).length, 1);
});
