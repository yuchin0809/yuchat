/* 総資産ランキングの1時間おきの更新（economy.mjs の refreshAssetRanking）のテスト（モック Firestore）
   実行：node --test derby-runner/ranking-hourly.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import { refreshAssetRanking } from "./economy.mjs";

function mockDb({ market = { companies: { YGM: { price: 100 } } }, users = {}, ranking = { date: "2026-10-20", complete: true, users: [] } } = {}) {
  const log = { reads: 0, writes: [] };
  return {
    log,
    collection(name) {
      return {
        doc(id) {
          return {
            async get() { log.reads++; const d = name === "market" ? market : null; return { exists: !!d, data: () => d }; },
            async update(obj) { if (!ranking) { const e = new Error("5 NOT_FOUND"); e.code = 5; throw e; } log.writes.push({ path: `${name}/${id}`, obj }); }
          };
        },
        select() { return { async get() { log.reads += Object.keys(users).length; return { size: Object.keys(users).length, docs: Object.entries(users).map(([id, data]) => ({ id, data: () => data })) }; } }; }
      };
    }
  };
}
const JST = (h, m = 7) => new Date(Date.UTC(2026, 9, 21, h - 9, m, 0));

test("9:00〜16:59（日本時間）だけ更新する。それ以外の時刻は何も読まない", async () => {
  for (const h of [0, 8, 17, 23]) { const db = mockDb(); assert.equal((await refreshAssetRanking({ db, now: JST(h), log: () => {} })).reason, "outside", `${h}時`); assert.equal(db.log.reads, 0); }
  for (const h of [9, 12, 13, 16]) { const db = mockDb({ users: { a: { coins: 10 } } }); assert.equal((await refreshAssetRanking({ db, now: JST(h), log: () => {} })).status, "ok", `${h}時`); }
});

test("ランキングを作り直す：総資産＝手持ち＋預金＋株の評価額−借入。同額は同じ順位。ランキングのデータは update で必要な項目だけ書く（date・complete は触らない）", async () => {
  const users = {
    a: { uid: "ua", coins: 100, bank: { deposit: 50, loan: 0 }, stocks: { YGM: { qty: 2, cost: 150 } } },   // 100+50+200 = 350
    b: { uid: "ub", coins: 400, bank: { deposit: 0, loan: 100 } },                                          // 300
    c: { uid: "uc", coins: 300 },                                                                           // 300
    d: { uid: "ud" }                                                                                        // coins が無い人は対象外
  };
  const db = mockDb({ users });
  const r = await refreshAssetRanking({ db, now: JST(10), log: () => {} });
  assert.equal(r.status, "ok"); assert.equal(r.users, 3);
  const w = db.log.writes[0];
  assert.equal(w.path, "rankings/assets");
  assert.deepEqual(w.obj.users.map((u) => [u.name, u.total, u.rank]), [["a", 350, 1], ["b", 300, 2], ["c", 300, 2]]);
  assert.equal(w.obj.userCount, 3);
  assert.ok(w.obj.liveUpdatedAt, "最終更新の時刻を入れる");
  for (const k of ["date", "complete", "updatedBy", "prices"]) assert.equal(k in w.obj, false, `${k} は変えない`);
  assert.equal(db.log.writes.length, 1, "書き込みは1回だけ");
});

test("まだ株価のデータが無い・まだランキングのデータが無いときは何もしない（最初の13:00の処理が作る）", async () => {
  const noMarket = { collection: (n) => ({ doc: () => ({ async get() { return { exists: false }; } }) }) };
  assert.equal((await refreshAssetRanking({ db: noMarket, now: JST(10), log: () => {} })).reason, "no_market");
  const db = mockDb({ users: { a: { coins: 1 } }, ranking: null });
  assert.equal((await refreshAssetRanking({ db, now: JST(10), log: () => {} })).reason, "no_ranking");
});
