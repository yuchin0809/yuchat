/* 🛠 ゆう経済の1日1回の処理の見守り（worker.js の runDailyWatchdogTick）のテスト
   実行：node --test "notify-worker/test/*.test.mjs" */
import test from "node:test";
import assert from "node:assert/strict";
import { runDailyWatchdogTick, resetDailyWatchForTest } from "../worker.js";

console.warn = () => {};
const jst = (d, h, m) => Date.UTC(2026, 9, d, h, m) - 9 * 3600000;   // 2026-10-d の h:m（日本時間）
function make({ doc, token = "tok", status = 204 } = {}) {
  resetDailyWatchForTest();
  const calls = { gets: 0, fetch: [] };
  const deps = { firestore: { async get(path) { calls.gets++; assert.equal(path, "rankings/assets"); return doc ?? null; } } };
  const fetchImpl = async (url, init) => { calls.fetch.push({ url, init }); return { status }; };
  const env = token ? { GITHUB_DISPATCH_TOKEN: token } : {};
  return { calls, deps, run: (t) => runDailyWatchdogTick(env, t, deps, fetchImpl) };
}

test("見守り：決まった時刻（13:10 など）以外は、Firestore にも GitHub にも触れない", async () => {
  const w = make({ doc: null });
  for (const [h, m] of [[0, 0], [12, 41], [13, 0], [13, 11], [13, 24], [16, 0], [22, 59]]) assert.equal((await w.run(jst(22, h, m))).skipped, "outside", `${h}:${m}`);
  assert.equal(w.calls.gets, 0); assert.equal(w.calls.fetch.length, 0);
});

test("見守り：今日の分が済んでいれば、何もしない（その日は、もう読み取りもしない）", async () => {
  const w = make({ doc: { date: "2026-10-22", complete: true } });
  assert.equal((await w.run(jst(22, 13, 10))).skipped, "done");
  assert.equal(w.calls.fetch.length, 0);
  assert.equal((await w.run(jst(22, 13, 25))).skipped, "done"); assert.equal(w.calls.gets, 1, "済んだ日は、2回目からは読まない");
});

test("見守り：今日の分が済んでいなければ（前の日の記録・未完了・書類なし）、derby-runner を手動実行する", async () => {
  for (const doc of [{ date: "2026-10-21", complete: true }, { date: "2026-10-22", complete: false }, null]) {
    const w = make({ doc });
    const r = await w.run(jst(22, 13, 10));
    assert.equal(r.dispatched, true, JSON.stringify(doc));
    assert.equal(w.calls.fetch.length, 1);
    const { url, init } = w.calls.fetch[0];
    assert.equal(url, "https://api.github.com/repos/yuchin0809/yuchat/actions/workflows/derby-runner.yml/dispatches");
    assert.equal(init.method, "POST"); assert.equal(init.headers.Authorization, "Bearer tok"); assert.deepEqual(JSON.parse(init.body), { ref: "main" });
  }
});

test("見守り：日付は日本時間で見る（日本時間 23:10 は、まだ今日）／朝に前日の分が済んでいても今日の分には数えない", async () => {
  const w = make({ doc: { date: "2026-10-22", complete: true } });
  assert.equal((await w.run(jst(22, 23, 10))).skipped, "done");
  const w2 = make({ doc: { date: "2026-10-22", complete: true } });
  assert.equal((await w2.run(jst(23, 13, 10))).dispatched, true, "翌日の13:10には、前日の分は数えない");
});

test("見守り：鍵（GITHUB_DISPATCH_TOKEN）が無ければ何もしない。GitHub が断ったら、失敗として返す（例外にしない）。次の時刻に、もう一度確かめる", async () => {
  const none = make({ doc: null, token: "" });
  assert.equal((await none.run(jst(22, 13, 10))).skipped, "no_token"); assert.equal(none.calls.fetch.length, 0);
  const bad = make({ doc: null, status: 403 });
  const r = await bad.run(jst(22, 13, 10)); assert.equal(r.dispatched, false); assert.equal(r.status, 403);
  assert.equal((await bad.run(jst(22, 13, 25))).dispatched, false, "次の時刻にも、もう一度頼む");
  assert.equal(bad.calls.fetch.length, 2);
});
