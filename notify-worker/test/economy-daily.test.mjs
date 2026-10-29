/* 🛠 ゆう経済の1日1回の処理（株価・利息・ゆう税・ボーナス・総資産ランキング）と、総資産ランキングの1時間おきの更新を、Worker 自身で行う（worker.js の runEconomyTick）のテスト
   実行：node --test "notify-worker/test/*.test.mjs"
   計算は derby-runner/economy.mjs と同じ結果になること（下の「正解の値」は、economy.mjs で計算した値） */
import test from "node:test";
import assert from "node:assert/strict";
import { STOCK_NEWS } from "../../derby-runner/stock-news.mjs";
import {
  STOCK_NEWS_COPY, djComputeDailyMarket, djStockSecret, djApplyDailyUserUpdate, djBuildRanking,
  runEconomyDaily, runEconomyRankingLive, runEconomyTick, resetEconomyTickForTest
} from "../worker.js";

console.log = () => {};
console.error = () => {};
const jst = (d, h, m) => Date.UTC(2026, 9, d, h, m) - 9 * 3600000;   // 2026-10-d の h:m（日本時間）
const ROOT = "projects/t/databases/(default)/documents/";

/* ---- 小さな Firestore のにせもの（REST の形：fields・updateMask・updateTransforms・更新時刻の条件） ---- */
const enc = (v) => v === null ? { nullValue: null } : typeof v === "boolean" ? { booleanValue: v } : typeof v === "number" ? (Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v }) : typeof v === "string" ? { stringValue: v } : Array.isArray(v) ? { arrayValue: { values: v.map(enc) } } : { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])) } };
const dec = (v) => "stringValue" in v ? v.stringValue : "integerValue" in v ? Number(v.integerValue) : "doubleValue" in v ? v.doubleValue : "booleanValue" in v ? v.booleanValue : "timestampValue" in v ? v.timestampValue : "nullValue" in v ? null : "arrayValue" in v ? (v.arrayValue.values || []).map(dec) : Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, dec(x)]));
const decFields = (f) => Object.fromEntries(Object.entries(f || {}).map(([k, v]) => [k, dec(v)]));

function makeFs(seed = {}, { failCommits = [] } = {}) {
  const docs = new Map();
  let clock = 1;
  const stamp = () => `2026-10-29T00:00:${String(clock++).padStart(2, "0")}.000000Z`;
  Object.entries(seed).forEach(([path, data]) => docs.set(path, { fields: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, enc(v)])), updateTime: stamp() }));
  const log = { commits: [], reads: [], sets: [] };
  let commitNo = 0;
  const fs = {
    docName: (p) => ROOT + p,
    async getRaw(path) { log.reads.push(path); const d = docs.get(path); return d ? { fields: structuredClone(d.fields), updateTime: d.updateTime } : null; },
    async get(path) { const d = docs.get(path); return d ? decFields(d.fields) : null; },
    async set(path, data) { log.sets.push({ path, data }); },
    async query(collection) { log.reads.push(`query:${collection}`); return [...docs.entries()].filter(([p]) => p.startsWith(collection + "/") && p.split("/").length === 2).map(([p, d]) => ({ id: p.split("/")[1], path: p, updateTime: d.updateTime, data: decFields(d.fields) })); },
    async commit(writes) {
      commitNo++;
      if (failCommits.includes(commitNo)) { /* 途中で別の書き込みが入ったことにする */ const t = writes[0].update.name.slice(ROOT.length); const d = docs.get(t); if (d) d.updateTime = stamp(); throw Object.assign(new Error("firestore commit 409 FAILED_PRECONDITION"), { status: 409 }); }
      for (const w of writes) {
        const path = w.update.name.slice(ROOT.length), cur = docs.get(path);
        if (w.currentDocument?.updateTime && (!cur || cur.updateTime !== w.currentDocument.updateTime)) throw Object.assign(new Error("firestore commit 409 FAILED_PRECONDITION"), { status: 409 });
        if (w.currentDocument?.exists === false && cur) throw Object.assign(new Error("firestore commit 409 ALREADY_EXISTS"), { status: 409 });
      }
      log.commits.push(writes);
      for (const w of writes) {
        const path = w.update.name.slice(ROOT.length), cur = docs.get(path);
        let fields = cur ? cur.fields : {};
        if (w.updateMask) {
          for (const fp of w.updateMask.fieldPaths) {
            const parts = fp.split(".");
            if (parts.length === 1) fields[fp] = w.update.fields[fp];
            else { fields[parts[0]] ||= { mapValue: { fields: {} } }; fields[parts[0]].mapValue.fields ||= {}; fields[parts[0]].mapValue.fields[parts[1]] = w.update.fields[parts[0]].mapValue.fields[parts[1]]; }
          }
        } else fields = { ...w.update.fields };
        for (const t of w.updateTransforms || []) fields[t.fieldPath] = { timestampValue: "2026-10-29T04:00:00.000000Z" };
        docs.set(path, { fields, updateTime: stamp() });
      }
    }
  };
  return { fs, docs, log, get: (p) => (docs.has(p) ? decFields(docs.get(p).fields) : null) };
}
const ENV = { STOCK_SEED_SECRET: "golden-secret" };
const world = () => makeFs({
  "market/current": { date: "2026-10-28", startDate: "2026-10-27", companies: { YGM: { price: 194, prevPrice: 192, changePct: 1, history: [192, 194] }, YMT: { price: 212, prevPrice: 229, changePct: -7, history: [229, 212] }, YFD: { price: 153, prevPrice: 150, changePct: 2, history: [150, 153] }, YEN: { price: 228, prevPrice: 249, changePct: -8, history: [249, 228] }, YPY: { price: 221, prevPrice: 227, changePct: -2, history: [227, 221] } }, todayNews: [], events: [], recentNewsIds: ["YEN-b07", "YMT-b20"] },
  "rankings/assets": { date: "2026-10-28", complete: true, users: [], userCount: 0, liveUpdatedAt: "2026-10-28T07:00:00.000000Z" },
  "users/あ": { uid: "u1", coins: 100, bank: { deposit: 5000, interestBase: 5000, loan: 0 }, stocks: { YGM: { qty: 10 } }, bonus500Granted: true },
  "users/い": { uid: "u2", coins: 30000, bank: { deposit: 100, interestBase: 100, loan: 0 }, bonus500Granted: true },
  "users/う": { uid: "u3", coins: 50, bank: { deposit: 200, interestBase: 200, loan: 1000, loanDueAt: "2026-10-28T00:00:00.000000Z" }, bonus500Granted: true },
  "users/え": { uid: "u4", coins: 10 }
});

test("ニュースの文は、derby-runner のものと同じ（コピーがずれていない）", () => { assert.deepEqual(STOCK_NEWS_COPY, STOCK_NEWS); });

test("株価の計算は、derby-runner/economy.mjs と同じ結果（正解の値）", async () => {
  const golden = [
    ["2026-10-27", { YGM: 192, YMT: 229, YFD: 150, YEN: 249, YPY: 227 }, ["YPY-g08", "YGM-g25", "YEN-b02"], []],
    ["2026-10-28", { YGM: 194, YMT: 212, YFD: 153, YEN: 228, YPY: 221 }, ["YEN-b07", "YMT-b20"], []],
    ["2026-10-29", { YGM: 183, YMT: 205, YFD: 168, YEN: 249, YPY: 237 }, ["YPY-g25", "YFD-b10", "YMT-b27"], ["YFD:surge"]]
  ];
  let m = null;
  for (const [date, prices, news, events] of golden) {
    m = await djComputeDailyMarket(m, date, "golden-secret");
    assert.deepEqual(Object.fromEntries(Object.entries(m.companies).map(([k, v]) => [k, v.price])), prices, date);
    assert.deepEqual(m.todayNews.map((n) => n.id), news, date);
    assert.deepEqual(m.events.map((e) => `${e.code}:${e.kind}`), events, date);
  }
});

test("株価の秘密値：Secret が優先／無ければサービスアカウントの鍵から作る（derby-runner と同じ）／どちらも無ければ null", async () => {
  assert.equal(await djStockSecret({ STOCK_SEED_SECRET: "x" }), "x");
  const sa = JSON.stringify({ private_key: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n" });
  assert.match(await djStockSecret({ FIREBASE_SERVICE_ACCOUNT: sa }), /^[0-9a-f]{64}$/);
  assert.equal(await djStockSecret({}), null);
});

test("1人分の処理：利息・返済期限切れの自動返済・ゆう税・追加ボーナス（economy.mjs と同じ）", () => {
  const prices = { YGM: 200, YMT: 250, YFD: 150, YEN: 300, YPY: 210 }, now = Date.parse("2026-10-29T04:00:00Z");
  const a = djApplyDailyUserUpdate({ coins: 100, bank: { deposit: 5000, interestBase: 5000, loan: 0 }, stocks: { YGM: { qty: 10 } }, bonus500Granted: true }, "2026-10-29", now, prices);
  assert.equal(a.interest, 50); assert.equal(a.tax, 43, "総資産 7,150 のうち 5,000 を超えた 2,150 の 2%"); assert.equal(a.bankSet.deposit, 5050); assert.equal(a.bankSet.lastInterest, 50); assert.equal(a.coins, 57, "税は手持ちから先に引く");
  const b = djApplyDailyUserUpdate({ coins: 30000, bank: { deposit: 100, interestBase: 100, loan: 0 }, bonus500Granted: true }, "2026-10-29", now, prices);
  assert.equal(b.interest, 1); assert.ok(b.tax > 0); assert.equal(b.coins, 30000 - b.tax);
  const c = djApplyDailyUserUpdate({ coins: 50, bank: { deposit: 200, interestBase: 200, loan: 1000, loanDueAt: "2026-10-28T00:00:00Z" }, bonus500Granted: true }, "2026-10-29", now, prices);
  assert.deepEqual(c.repaid, { date: "2026-10-29", amount: 252, fromDeposit: 202, fromCoins: 50, remaining: 748 });
  assert.equal(c.coins, 0);
  const d = djApplyDailyUserUpdate({ coins: 10 }, "2026-10-29", now, prices);
  assert.equal(d.bonus, true); assert.equal(d.coins, 510);
  assert.equal(djApplyDailyUserUpdate({ coins: 10, bonus500Granted: true }, "2026-10-29", now, prices), null, "変わらない人は null");
  assert.equal(djApplyDailyUserUpdate({ coins: 10, bonus500Granted: true, bank: { deposit: 5000, interestBase: 5000, interestDate: "2026-10-29", taxDate: "2026-10-29" } }, "2026-10-29", now, prices), null, "同じ日に2回はしない");
});

test("13:00 の処理：株価・利息・返済・ボーナス・ランキング・毎日の記録を行う。2回目は何もしない", async () => {
  resetEconomyTickForTest();
  const w = world();
  const out = await runEconomyTick(ENV, jst(29, 13, 0), { firestore: w.fs });
  assert.equal(out.daily.status, "ok");
  const market = w.get("market/current");
  assert.equal(market.date, "2026-10-29"); assert.equal(market.updatedBy, "worker");
  assert.deepEqual(Object.fromEntries(Object.entries(market.companies).map(([k, v]) => [k, v.price])), { YGM: 183, YMT: 205, YFD: 168, YEN: 249, YPY: 237 }, "前日（10/28）の記録から、10/29 の株価（economy.mjs と同じ）");
  assert.equal(w.get("users/あ").bank.deposit, 5050); assert.equal(w.get("users/あ").bank.interestDate, "2026-10-29");
  assert.equal(w.get("users/あ").coins, 61, "ゆう税（総資産 6,980 のうち 5,000 を超えた分の 2%＝39）を手持ちから引く"); assert.equal(w.get("users/あ").bank.lastTax, 39); assert.equal(w.get("users/あ").stocks.YGM.qty, 10, "触れない項目はそのまま");
  assert.equal(w.get("users/う").bank.loan, 748); assert.equal(w.get("users/う").coins, 0); assert.equal(w.get("users/う").bank.loanDueAt, "2026-10-28T00:00:00.000000Z", "返し終わっていない借入の期限はそのまま");
  assert.equal(w.get("users/え").coins, 510); assert.equal(w.get("users/え").bonus500Granted, true);
  const ranking = w.get("rankings/assets");
  assert.equal(ranking.date, "2026-10-29"); assert.equal(ranking.complete, true); assert.equal(ranking.userCount, 4);
  assert.deepEqual(ranking.users.map((u) => u.name), ["い", "あ", "え", "う"]); assert.deepEqual(ranking.users.map((u) => u.rank), [1, 2, 3, 4]);
  assert.equal(ranking.prices.YGM, 183);
  assert.equal(ranking.users.find((u) => u.name === "あ").stockValue, 1830);
  const hist = w.get("economyStats/history");
  assert.equal(hist.points.length, 1); assert.equal(hist.points[0].date, "2026-10-29"); assert.equal(hist.points[0].users, 4);
  assert.deepEqual(w.log.sets.map((s) => [s.path, s.data.result]), [["economyStats/dailyWatch", "worker_ok"]]);

  const before = w.log.commits.length;
  resetEconomyTickForTest();
  const again = await runEconomyTick(ENV, jst(29, 13, 2), { firestore: w.fs });
  assert.equal(again.daily.reason, "done"); assert.equal(w.log.commits.length, before, "2回目は書かない");
});

test("13:00 より前は何もしない。13:00 の分は動く／決まった分以外は Firestore に触れない", async () => {
  resetEconomyTickForTest();
  const w = world();
  assert.equal((await runEconomyDaily({ firestore: w.fs }, ENV, jst(29, 12, 59))).reason, "before_13");
  assert.equal(w.log.reads.length, 0);
  for (const [h, m] of [[0, 0], [13, 6], [13, 7], [18, 0], [22, 59]]) assert.equal((await runEconomyTick(ENV, jst(29, h, m), { firestore: w.fs })).skipped, "outside", `${h}:${m}`);
  assert.equal(w.log.reads.length, 0);
});

test("株価の秘密値が無いときは株価もランキングも更新せず（エラー）、あとで秘密値があれば行える", async () => {
  resetEconomyTickForTest();
  const w = world();
  const bad = await runEconomyTick({}, jst(29, 13, 0), { firestore: w.fs });
  assert.equal(bad.daily.status, "error");
  assert.equal(w.get("market/current").date, "2026-10-28"); assert.equal(w.get("rankings/assets").date, "2026-10-28");
  assert.equal(w.log.sets[0].data.result, "worker_error");
  const ok = await runEconomyTick(ENV, jst(29, 13, 1), { firestore: w.fs });
  assert.equal(ok.daily.status, "ok"); assert.equal(w.get("rankings/assets").complete, true);
});

test("書く前に別の書き込みが入った人は、読み直してやり直す（二重にならない）", async () => {
  resetEconomyTickForTest();
  const base = world();
  const seed = Object.fromEntries([...base.docs.entries()].map(([p, d]) => [p, decFields(d.fields)]));
  const race = makeFs(seed, { failCommits: [2] });   // 1回目＝株価、2回目＝最初の人の書き込みが、別の書き込みとぶつかる
  const out = await runEconomyDaily({ firestore: race.fs }, ENV, jst(29, 13, 0));
  assert.equal(out.status, "ok"); assert.deepEqual(out.errors, []);
  assert.equal(race.get("users/あ").bank.deposit, 5050, "やり直したあとも、利息は1回だけ");
});

test("1時間おきのランキング更新：9:05〜16:25 に users・userCount・liveUpdatedAt だけ書く（date・complete・prices は変えない）", async () => {
  resetEconomyTickForTest();
  const w = world();
  const out = await runEconomyRankingLive({ firestore: w.fs }, jst(29, 9, 5));
  assert.equal(out.status, "ok");
  const r = w.get("rankings/assets");
  assert.equal(r.date, "2026-10-28"); assert.equal(r.complete, true); assert.equal(r.userCount, 4);
  assert.equal(r.liveUpdatedAt, "2026-10-29T04:00:00.000000Z");
  assert.deepEqual(r.users.map((u) => u.name), ["い", "あ", "え", "う"]);
  assert.equal(w.log.commits.at(-1)[0].updateMask.fieldPaths.join(), "users,userCount");
  const reads = w.log.reads.length;
  assert.equal((await runEconomyRankingLive({ firestore: w.fs }, jst(29, 9, 25))).reason, "fresh", "45分以内に更新していれば、読み直さない（:25 のやり直し）");
  assert.equal(w.log.reads.length, reads + 1, "確かめるのは rankings/assets の1件だけ");
});

test("1時間おきのランキング更新：9:00〜16:59 の外・ランキングの書類が無いときは何もしない／tick は :05 と :25 だけ動く", async () => {
  resetEconomyTickForTest();
  const w = world();
  assert.equal((await runEconomyRankingLive({ firestore: w.fs }, jst(29, 8, 59))).reason, "outside");
  assert.equal((await runEconomyRankingLive({ firestore: w.fs }, jst(29, 17, 5))).reason, "outside");
  const empty = makeFs({ "market/current": {} });
  assert.equal((await runEconomyRankingLive({ firestore: empty.fs }, jst(29, 10, 5))).reason, "no_ranking");
  const t = await runEconomyTick(ENV, jst(29, 10, 5), { firestore: world().fs });
  assert.equal(t.live.status, "ok");
  assert.equal((await runEconomyTick(ENV, jst(29, 10, 6), { firestore: world().fs })).skipped, "outside");
});

test("総資産ランキング：同額は同じ順位、同額は名前の順", () => {
  const r = djBuildRanking([{ name: "b", total: 10 }, { name: "a", total: 10 }, { name: "c", total: 20 }]);
  assert.deepEqual(r.map((x) => [x.name, x.rank]), [["c", 1], ["a", 2], ["b", 2]]);
});
