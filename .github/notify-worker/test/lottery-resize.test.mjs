/* 🎟 宝くじの番号の付け替え（.github/notify-worker/lottery-resize.mjs）のテスト（モック Firestore）
   実行：node --test ".github/notify-worker/test/*.test.mjs" */
import test from "node:test";
import assert from "node:assert/strict";
import { run } from "../lottery-resize.mjs";

const T = Date.UTC(2026, 9, 23, 5, 30, 0); // 2026-10-23（金）14:30 JST

function mockFs(initial = {}) {
  const docs = new Map(Object.entries(initial).map(([k, v]) => [k, { data: structuredClone(v), updateTime: "t0" }]));
  let ver = 1;
  const enc = (v) => Array.isArray(v) ? { arrayValue: { values: v.map(enc) } } : typeof v === "number" ? { integerValue: String(v) } : { stringValue: String(v) };
  return {
    docs,
    docName: (p) => `projects/p/databases/(default)/documents/${p}`,
    async getRaw(p) { const d = docs.get(p); if (!d) return null; return { fields: Object.fromEntries(Object.entries(d.data).map(([k, v]) => [k, enc(v)])), updateTime: d.updateTime }; },
    async query(coll, filters = []) { return [...docs.entries()].filter(([p]) => p.startsWith(coll + "/")).map(([p, d]) => ({ id: p.split("/")[1], updateTime: d.updateTime, data: d.data })).filter((r) => filters.every(([f, , v]) => r.data[f] === v)); },
    async commit(writes) {
      for (const w of writes) {
        const path = w.update.name.split("/documents/")[1]; const cur = docs.get(path);
        if (w.currentDocument?.updateTime && cur?.updateTime !== w.currentDocument.updateTime) throw Object.assign(new Error("FAILED_PRECONDITION"), { status: 400 });
      }
      for (const w of writes) {
        const path = w.update.name.split("/documents/")[1]; const cur = docs.get(path);
        for (const [k, v] of Object.entries(w.update.fields)) cur.data[k] = v.stringValue !== undefined ? v.stringValue : v.arrayValue ? v.arrayValue.values.map((x) => Number(x.integerValue)) : Number(v.integerValue);
        cur.updateTime = `t${ver++}`;
      }
    }
  };
}
const deps = (fs) => ({ firestore: fs, now: () => T - 3 * 3600000, random: () => 0.5 });

test("付け替え：1,500 以上の番号だけが動く。件数だけをログに出す（名前・番号は出さない）", async () => {
  const legacy = "0".repeat(3000).split(""); [10, 1600, 1601].forEach((n) => { legacy[n] = "1"; });
  const fs = mockFs({
    "lotteryRounds/2026-10-23": { round: "2026-10-23", tickets: 3, sales: 30, soldBits: legacy.join("") },
    "lotteryEntries/2026-10-23_uA": { uid: "uA", name: "ひみつの名前", round: "2026-10-23", numbers: [10, 1600, 1601] }
  });
  const logs = [];
  const r = await run({ deps: deps(fs), log: (m) => logs.push(m) });
  assert.equal(r.ok, true); assert.equal(r.moved, 1); assert.equal(r.tickets, 3);
  assert.equal(fs.docs.get("lotteryRounds/2026-10-23").data.soldBits.length, 1500);
  const nums = fs.docs.get("lotteryEntries/2026-10-23_uA").data.numbers;
  assert.equal(nums.length, 3); assert.ok(nums.every((n) => n < 1500)); assert.ok(nums.includes(10));
  assert.ok(!logs.join("\n").includes("ひみつの名前") && !logs.join("\n").includes("uA"), "ログに名前・IDを出さない");
  const again = await run({ deps: deps(fs), log: () => {} });
  assert.equal(again.skipped, "ok", "2回目は何もしない");
});

test("1,500 枚を超えて売れていたら、何も変えずに aborted を返す。売れた券がなければ何もしない", async () => {
  const fs = mockFs({
    "lotteryRounds/2026-10-23": { round: "2026-10-23", tickets: 1600, sales: 16000, soldBits: "1".repeat(1600) + "0".repeat(1400) },
    "lotteryEntries/2026-10-23_uA": { uid: "uA", name: "a", round: "2026-10-23", numbers: Array.from({ length: 1600 }, (_, i) => i) }
  });
  const r = await run({ deps: deps(fs), log: () => {} });
  assert.equal(r.aborted, "too_many"); assert.equal(fs.docs.get("lotteryRounds/2026-10-23").data.soldBits.length, 3000, "何も変えない");
  assert.equal((await run({ deps: deps(mockFs()), log: () => {} })).skipped, "no_round");
});
