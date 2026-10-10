/* 👤 ユーザー管理：総資産の増減（worker.js の previewAssets / adjustAssets）のテスト
   Firestore はメモリ上の偽物（更新時刻の条件・まとめて書き込み・「a.b」の項目指定を本物と同じように扱う）
   実行：node --test "notify-worker/test/*.test.mjs" */

import test from "node:test";
import assert from "node:assert/strict";
import { handleAdminAction, planAssetAdjustment, assetBreakdown, rerankAssetRanking } from "../worker.js";

const ADMIN = "adminUid";
const ROOT = "projects/p/databases/(default)/documents";

/* ----- Firestore REST の値 ⇔ JS の値 ----- */
const enc = (v) => v === null || v === undefined ? { nullValue: null } : typeof v === "boolean" ? { booleanValue: v } : typeof v === "number" ? (Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v }) : Array.isArray(v) ? { arrayValue: { values: v.map(enc) } } : typeof v === "object" ? { mapValue: { fields: encF(v) } } : { stringValue: String(v) };
const encF = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const dec = (v) => !v ? undefined : "nullValue" in v ? null : "integerValue" in v ? Number(v.integerValue) : "doubleValue" in v ? v.doubleValue : "booleanValue" in v ? v.booleanValue : "stringValue" in v ? v.stringValue : "timestampValue" in v ? v.timestampValue : v.arrayValue ? (v.arrayValue.values || []).map(dec) : v.mapValue ? decF(v.mapValue.fields || {}) : undefined;
const decF = (f) => Object.fromEntries(Object.entries(f || {}).map(([k, v]) => [k, dec(v)]));

/* 「a.b」の項目を、上書き（値があるとき）または削除（値が無いとき） */
function applyMask(fields, update, paths) {
  const next = structuredClone(fields);
  for (const path of paths) {
    const parts = path.split(".");
    let src = update, dst = next;
    for (let i = 0; i < parts.length - 1; i++) {
      src = src?.[parts[i]]?.mapValue?.fields;
      if (!dst[parts[i]]?.mapValue) dst[parts[i]] = { mapValue: { fields: {} } };
      dst[parts[i]].mapValue.fields ||= {};
      dst = dst[parts[i]].mapValue.fields;
    }
    const last = parts[parts.length - 1];
    if (src && last in src) dst[last] = structuredClone(src[last]); else delete dst[last];
  }
  return next;
}

function fakeFirestore(initial) {
  const docs = new Map();
  let clock = 1;
  const put = (path, fields) => docs.set(path, { fields: structuredClone(fields), updateTime: `t${clock++}` });
  Object.entries(initial).forEach(([path, data]) => put(path, encF(data)));
  const tick = () => new Promise((r) => setTimeout(r, Math.random() * 3));
  const fs = {
    docs, commits: 0, put,
    async query(collection, filters) {
      await tick();
      return [...docs.entries()].filter(([p]) => p.startsWith(`${collection}/`) && p.split("/").length === 2)
        .filter(([, d]) => filters.every(([f, , v]) => decF(d.fields)[f] === v))
        .map(([p, d]) => ({ id: p.split("/")[1], path: p, updateTime: d.updateTime, data: decF(d.fields) }));
    },
    async get(path) { await tick(); const d = docs.get(path); return d ? decF(d.fields) : null; },
    async getRaw(path) { await tick(); const d = docs.get(path); return d ? structuredClone(d) : null; },
    docName: (path) => `${ROOT}/${path}`,
    async add() { throw new Error("使わない"); },
    async commit(writes) {
      await tick();
      for (const w of writes) {
        const path = w.update.name.slice(ROOT.length + 1);
        const cur = docs.get(path);
        if (w.currentDocument?.updateTime && cur?.updateTime !== w.currentDocument.updateTime) {
          throw Object.assign(new Error("firestore commit 400 FAILED_PRECONDITION: the stored version does not match the required base version"), { status: 400 });
        }
        if (w.currentDocument?.exists === false && cur) throw Object.assign(new Error("firestore commit 409 ALREADY_EXISTS"), { status: 409 });
      }
      for (const w of writes) {
        const path = w.update.name.slice(ROOT.length + 1);
        const cur = docs.get(path)?.fields || {};
        const next = w.updateMask ? applyMask(cur, w.update.fields, w.updateMask.fieldPaths) : { ...w.update.fields };
        (w.updateTransforms || []).forEach((t) => { next[t.fieldPath] = { timestampValue: "REQUEST_TIME" }; });
        put(path, next);
      }
      fs.commits++;
    }
  };
  return fs;
}

const PRICES = { YGM: 180, YMT: 240, YFD: 150, YEN: 300, YPY: 210 };
const market = (prices = PRICES) => ({ date: "2026-10-10", companies: Object.fromEntries(Object.entries(prices).map(([c, price]) => [c, { price, prevPrice: price, history: [price] }])) });
const total = (u, prices = PRICES) => u.coins + (u.bank?.deposit || 0) + Object.entries(u.stocks || {}).reduce((s, [c, h]) => s + h.qty * prices[c], 0) - (u.bank?.loan || 0);

/* たろう：コイン 1000・預金 3000・YEN 20株（6000）・YGM 10株（1800）・借入 0 → 総資産 11800 */
function setup({ taro = {}, rankingUsers, prices = PRICES, noRanking = false } = {}) {
  const taroData = {
    uid: "uT", name: "たろう", coins: 1000, lastSeen: "keep", totalBetAmount: 12345,
    bank: { deposit: 3000, interestBase: 2500, loan: 0, interestDate: "2026-10-09", loanDueAt: null },
    stocks: { YEN: { qty: 20, cost: 5000 }, YGM: { qty: 10, cost: 2000 } },
    ...taro
  };
  const others = { "はなこ": { uid: "uH", name: "はなこ", coins: 9000, bank: { deposit: 0, loan: 0 }, stocks: {} }, "かんりしゃ": { uid: ADMIN, name: "かんりしゃ", coins: 5, bank: {}, stocks: {} } };
  const initial = { "users/たろう": taroData, ...Object.fromEntries(Object.entries(others).map(([n, d]) => [`users/${n}`, d])), "market/current": market(prices) };
  if (!noRanking) {
    const rows = rankingUsers || [
      { name: "たろう", coins: 1000, deposit: 3000, stockValue: 7800, loan: 0, total: 11800, rank: 1 },
      { name: "はなこ", coins: 9000, deposit: 0, stockValue: 0, loan: 0, total: 9000, rank: 2 },
      { name: "かんりしゃ", coins: 5, deposit: 0, stockValue: 0, loan: 0, total: 5, rank: 3 }
    ];
    initial["rankings/assets"] = { date: "2026-10-10", complete: true, prices, users: rows, userCount: rows.length };
  }
  const firestore = fakeFirestore(initial);
  return { firestore, deps: { adminUid: ADMIN, firestore, now: () => Date.now() } };
}

const userOf = (fs, name = "たろう") => decF(fs.docs.get(`users/${name}`).fields);
const rankingOf = (fs) => decF(fs.docs.get("rankings/assets").fields);
const logs = (fs) => [...fs.docs.entries()].filter(([p]) => p.startsWith("adminAuditLogs/")).map(([, d]) => decF(d.fields));
const expectedOf = (b) => ({ deposit: b.deposit, stocks: Object.fromEntries(b.stocks.map((s) => [s.code, s.qty])), prices: b.prices });
async function previewThenAdjust(deps, direction, amount) {
  const p = await handleAdminAction(deps, ADMIN, { action: "previewAssets", uid: "uT", direction, amount });
  if (!p.ok) return { preview: p };
  const r = await handleAdminAction(deps, ADMIN, { action: "adjustAssets", uid: "uT", direction, amount, expected: expectedOf(p.breakdown) });
  return { preview: p, result: r };
}

test("内訳：総資産 = 手持ちコイン + 預金 + 株の評価額 − 借入。株は評価額の高い順", async () => {
  const { deps, firestore } = setup();
  const p = await handleAdminAction(deps, ADMIN, { action: "previewAssets", uid: "uT" });
  assert.equal(p.ok, true);
  assert.deepEqual([p.breakdown.coins, p.breakdown.deposit, p.breakdown.stockValue, p.breakdown.loan, p.breakdown.total], [1000, 3000, 7800, 0, 11800]);
  assert.deepEqual(p.breakdown.stocks.map((s) => [s.code, s.qty, s.price, s.value]), [["YEN", 20, 300, 6000], ["YGM", 10, 180, 1800]]);
  assert.equal(firestore.commits, 0, "内訳の表示は書き込まない");
});

test("預金だけで足りる：預金だけ減り、株・手持ちコイン・借入・ほかの項目はそのまま。総資産はちょうど指定額減る", async () => {
  const { deps, firestore } = setup();
  const before = userOf(firestore);
  const { preview, result } = await previewThenAdjust(deps, "decrease", 1200);
  assert.deepEqual([preview.plan.fromDeposit, preview.plan.removed.length, preview.plan.change, preview.plan.totalAfter], [1200, 0, 0, 10600]);
  assert.equal(result.ok, true);
  assert.deepEqual([result.beforeTotal, result.afterTotal], [11800, 10600]);
  const after = userOf(firestore);
  assert.equal(after.bank.deposit, 1800);
  assert.equal(after.bank.interestBase, 1800, "利息の対象は預金を超えない");
  assert.deepEqual(after.stocks, before.stocks);
  assert.equal(after.coins, 1000);
  assert.deepEqual({ ...after, bank: null }, { ...before, bank: null }, "bank 以外は1項目も変わらない");
  assert.deepEqual({ ...after.bank, deposit: 0, interestBase: 0 }, { ...before.bank, deposit: 0, interestBase: 0 }, "借入・利息日などはそのまま");
  assert.equal(total(after), 10600);
  assert.equal(firestore.commits, 1, "users・ランキング・記録は1回の書き込み");
});

test("株も回収：預金を0にし、評価額の高い銘柄（YEN）から回収。代金はコイン・預金に戻さず、端数だけ預金へ。総資産の減少は指定額と一致", async () => {
  const { deps, firestore } = setup();
  /* 3000（預金）+ 1000 → YEN 300円 を 4株（1200）回収し、200 を預金へ戻す */
  const { preview, result } = await previewThenAdjust(deps, "decrease", 4000);
  assert.deepEqual(preview.plan.removed.map((r) => [r.code, r.qty, r.value, r.qtyAfter]), [["YEN", 4, 1200, 16]]);
  assert.deepEqual([preview.plan.fromDeposit, preview.plan.change, preview.plan.depositAfter, preview.plan.totalAfter], [3000, 200, 200, 7800]);
  assert.equal(result.ok, true);
  const after = userOf(firestore);
  assert.equal(after.coins, 1000, "手持ちコインは変わらない（代金を戻さない）");
  assert.equal(after.bank.deposit, 200);
  assert.deepEqual(after.stocks.YEN, { qty: 16, cost: 4000 }, "取得額は株数に比例して減る（5000 × 16/20）");
  assert.deepEqual(after.stocks.YGM, { qty: 10, cost: 2000 }, "ほかの銘柄はそのまま");
  assert.equal(total(after), 11800 - 4000);
  assert.equal(result.afterTotal, 7800);
});

test("株を複数銘柄・全株まで回収：YEN を全部、続けて YGM。銘柄の項目は消え、端数は預金へ。減少額は一致", async () => {
  const { deps, firestore } = setup();
  /* 3000 + 6000（YEN 全部）+ 1000 → YGM 180円 を 6株（1080）、端数 80 */
  const { preview, result } = await previewThenAdjust(deps, "decrease", 10000);
  assert.deepEqual(preview.plan.removed.map((r) => [r.code, r.qty, r.value]), [["YEN", 20, 6000], ["YGM", 6, 1080]]);
  assert.equal(preview.plan.change, 80);
  assert.equal(result.ok, true);
  const after = userOf(firestore);
  assert.equal("YEN" in after.stocks, false, "全部回収した銘柄は消える");
  assert.deepEqual(after.stocks.YGM, { qty: 4, cost: 800 });
  assert.equal(after.bank.deposit, 80);
  assert.equal(total(after), 1800);
});

test("端数調整：いろいろな金額で、総資産の減少が指定額とちょうど同じ・預金に戻す端数は1株の株価より少ない", () => {
  const b = assetBreakdown({ coins: 50, bank: { deposit: 123, interestBase: 999, loan: 0 }, stocks: { YEN: { qty: 7, cost: 2100 }, YGM: { qty: 9, cost: 1620 }, YFD: { qty: 3, cost: 450 } } }, PRICES);
  const recoverable = 123 + 7 * 300 + 9 * 180 + 3 * 150;
  for (let amount = 1; amount <= recoverable; amount += 7) {
    const plan = planAssetAdjustment(b, "decrease", amount);
    assert.ok(!plan.error, `amount ${amount}`);
    const removedValue = plan.removed.reduce((s, r) => s + r.value, 0);
    assert.equal(plan.fromDeposit + removedValue - plan.change, amount, `amount ${amount}`);
    const last = plan.removed[plan.removed.length - 1];
    assert.ok(plan.change === 0 || plan.change < last.price, `端数 ${plan.change}`);
    assert.equal(plan.totalAfter, b.total - amount);
    assert.ok(plan.after.interestBase <= plan.after.deposit);
  }
});

test("資産不足：預金＋株の評価額を超える減額は拒否し、回収できる上限を返す（何も書かない）", async () => {
  const { deps, firestore } = setup();
  const p = await handleAdminAction(deps, ADMIN, { action: "previewAssets", uid: "uT", direction: "decrease", amount: 10801 });
  assert.deepEqual([p.status, p.error, p.max], [409, "insufficient_assets", 10800]);
  const r = await handleAdminAction(deps, ADMIN, { action: "adjustAssets", uid: "uT", direction: "decrease", amount: 10801 });
  assert.deepEqual([r.status, r.error, r.max], [409, "insufficient_assets", 10800]);
  assert.equal(firestore.commits, 0);
  /* 上限ちょうどは回収でき、手持ちコインだけが残る */
  const ok = await handleAdminAction(deps, ADMIN, { action: "adjustAssets", uid: "uT", direction: "decrease", amount: 10800 });
  assert.equal(ok.ok, true);
  const after = userOf(firestore);
  assert.deepEqual([after.coins, after.bank.deposit, Object.keys(after.stocks).length, total(after)], [1000, 0, 0, 1000]);
});

test("総資産が0未満になる減額は拒否（借入が手持ちコインより多いとき）", async () => {
  const { deps, firestore } = setup({ taro: { coins: 100, bank: { deposit: 3000, interestBase: 0, loan: 500 }, stocks: {} } });
  /* 総資産 = 100 + 3000 − 500 = 2600。預金は 3000 あるが、2600 までしか減らせない */
  const r = await handleAdminAction(deps, ADMIN, { action: "adjustAssets", uid: "uT", direction: "decrease", amount: 2601 });
  assert.deepEqual([r.error, r.max], ["insufficient_assets", 2600]);
  const ok = await handleAdminAction(deps, ADMIN, { action: "adjustAssets", uid: "uT", direction: "decrease", amount: 2600 });
  assert.equal(ok.ok, true); assert.equal(ok.afterTotal, 0);
  assert.equal(userOf(firestore).bank.loan, 500, "借入には触れない");
});

test("増やす：預金に足す。手持ちコイン・株・利息の対象はそのまま", async () => {
  const { deps, firestore } = setup();
  const { preview, result } = await previewThenAdjust(deps, "increase", 2500);
  assert.equal(preview.plan.totalAfter, 14300);
  assert.equal(result.ok, true);
  const after = userOf(firestore);
  assert.deepEqual([after.coins, after.bank.deposit, after.bank.interestBase, after.stocks.YEN.qty], [1000, 5500, 2500, 20]);
  assert.equal(total(after), 14300);
});

test("ランキングの更新：その人の行（コイン・預金・株・総資産）と順位が、同じ書き込みで正しく変わる。ほかの人の行はそのまま", async () => {
  const { deps, firestore } = setup();
  const r = await handleAdminAction(deps, ADMIN, { action: "adjustAssets", uid: "uT", direction: "decrease", amount: 4000 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.ranking, { rankBefore: 1, rankAfter: 2, totalBefore: 11800, totalAfter: 7800 });
  const ranking = rankingOf(firestore);
  assert.deepEqual(ranking.users.map((u) => [u.name, u.total, u.rank]), [["はなこ", 9000, 1], ["たろう", 7800, 2], ["かんりしゃ", 5, 3]]);
  const taro = ranking.users.find((u) => u.name === "たろう");
  assert.deepEqual([taro.coins, taro.deposit, taro.stockValue, taro.loan], [1000, 200, 16 * 300 + 1800, 0]);
  assert.equal(ranking.date, "2026-10-10"); assert.equal(ranking.complete, true); assert.equal(ranking.userCount, 3);
  assert.deepEqual(ranking.users.find((u) => u.name === "はなこ"), { name: "はなこ", coins: 9000, deposit: 0, stockValue: 0, loan: 0, total: 9000, rank: 1 });
});

test("ランキング：同額は同じ順位・名前の順（derby-runner と同じ並び）", () => {
  const rows = [{ name: "あ", total: 100, rank: 1 }, { name: "い", total: 50, rank: 2 }, { name: "う", total: 10, rank: 3 }];
  const r = rerankAssetRanking(rows, "あ", { coins: 50, bank: {}, stocks: {} }, PRICES);
  assert.deepEqual(r.rows.map((x) => [x.name, x.total, x.rank]), [["あ", 50, 1], ["い", 50, 1], ["う", 10, 3]]);
  assert.equal(rerankAssetRanking(rows, "いない", { coins: 1 }, PRICES), null);
});

test("ランキング：ランキングの株価（13:00 の値）で計算する。ランキングに居ない人・ランキングが無いときは users だけ変える", async () => {
  const s1 = setup({ rankingUsers: [{ name: "はなこ", coins: 9000, deposit: 0, stockValue: 0, loan: 0, total: 9000, rank: 1 }] });
  const r1 = await handleAdminAction(s1.deps, ADMIN, { action: "adjustAssets", uid: "uT", direction: "decrease", amount: 100 });
  assert.equal(r1.ok, true); assert.equal(r1.ranking, null);
  assert.equal(rankingOf(s1.firestore).users.length, 1);
  const s2 = setup({ noRanking: true });
  const r2 = await handleAdminAction(s2.deps, ADMIN, { action: "adjustAssets", uid: "uT", direction: "decrease", amount: 100 });
  assert.equal(r2.ok, true);
  assert.equal(s2.firestore.docs.has("rankings/assets"), false, "ランキングを新しく作らない");
});

test("操作の記録：対象・金額・変更前後の総資産と内訳・回収した株・端数・使った株価・ランキングの順位・実行者が残る", async () => {
  const { deps, firestore } = setup();
  await handleAdminAction(deps, ADMIN, { action: "adjustAssets", uid: "uT", direction: "decrease", amount: 4000 });
  const [log] = logs(firestore);
  assert.equal(log.action, "adjustAssets");
  assert.deepEqual([log.targetUid, log.targetName, log.direction, log.amount, log.delta], ["uT", "たろう", "decrease", 4000, -4000]);
  assert.deepEqual([log.beforeTotal, log.afterTotal], [11800, 7800]);
  assert.deepEqual(log.before, { coins: 1000, deposit: 3000, stockValue: 7800, loan: 0, total: 11800 });
  assert.deepEqual(log.after, { coins: 1000, deposit: 200, stockValue: 6600, loan: 0, total: 7800 });
  assert.deepEqual([log.fromDeposit, log.changeToDeposit], [3000, 200]);
  assert.deepEqual(log.removedStocks, [{ code: "YEN", qty: 4, price: 300, value: 1200, costRemoved: 1000, qtyBefore: 20, qtyAfter: 16 }]);
  assert.equal(log.prices.YEN, 300);
  assert.deepEqual(log.ranking, { rankBefore: 1, rankAfter: 2, totalBefore: 11800, totalAfter: 7800 });
  assert.deepEqual([log.byUid, log.byName, log.result], [ADMIN, "かんりしゃ", "ok"]);
  assert.ok(log.at);
});

test("表示したあとに預金・株・株価が変わっていたら（expected が違う）、何も変えずに最新の内訳を返す", async () => {
  const { deps, firestore } = setup();
  const p = await handleAdminAction(deps, ADMIN, { action: "previewAssets", uid: "uT", direction: "decrease", amount: 4000 });
  /* 表示のあと、本人が株を5株買い足した */
  const cur = decF(firestore.docs.get("users/たろう").fields);
  firestore.put("users/たろう", encF({ ...cur, coins: 0, stocks: { ...cur.stocks, YEN: { qty: 25, cost: 6500 } } }));
  const r = await handleAdminAction(deps, ADMIN, { action: "adjustAssets", uid: "uT", direction: "decrease", amount: 4000, expected: expectedOf(p.breakdown) });
  assert.deepEqual([r.status, r.error], [409, "assets_changed"]);
  assert.equal(r.breakdown.stocks.find((s) => s.code === "YEN").qty, 25);
  assert.equal(firestore.commits, 0);
  /* 株価が変わっていた（13:00 の更新）ときも同じ */
  const s2 = setup();
  const p2 = await handleAdminAction(s2.deps, ADMIN, { action: "previewAssets", uid: "uT" });
  s2.firestore.put("market/current", encF(market({ ...PRICES, YEN: 310 })));
  const r2 = await handleAdminAction(s2.deps, ADMIN, { action: "adjustAssets", uid: "uT", direction: "decrease", amount: 4000, expected: expectedOf(p2.breakdown) });
  assert.equal(r2.error, "assets_changed");
});

test("同時更新：回収の途中でアプリ・自動処理が users（コイン）やランキングを書き換えても、その変更を消さずにやり直す", async () => {
  const { deps, firestore } = setup();
  const realGetRaw = firestore.getRaw;
  let interfered = 0;
  firestore.getRaw = async (path) => {
    const doc = await realGetRaw(path);
    if (interfered < 2 && path === "users/たろう") {
      interfered++;
      /* 読んだ直後に、競馬の払い戻し +250（コインだけ）が書かれた */
      const cur = decF(firestore.docs.get(path).fields);
      firestore.put(path, encF({ ...cur, coins: cur.coins + 250 }));
    }
    return doc;
  };
  const p = await handleAdminAction(deps, ADMIN, { action: "previewAssets", uid: "uT" });
  const r = await handleAdminAction(deps, ADMIN, { action: "adjustAssets", uid: "uT", direction: "decrease", amount: 4000, expected: expectedOf(p.breakdown) });
  assert.equal(r.ok, true);
  const after = userOf(firestore);
  assert.equal(after.coins, 1000 + 250 * interfered, "払い戻しのコインは消えない");
  assert.equal(after.bank.deposit, 200);
  assert.equal(after.stocks.YEN.qty, 16);
  assert.equal(r.beforeTotal - r.afterTotal, 4000);
  assert.equal(logs(firestore).length, 1);
});

test("同時に10回回収しても、成功した回数分だけ正確に減り、記録の数も一致する（二重・取りこぼしなし）", async () => {
  const { deps, firestore } = setup();
  const results = await Promise.all(Array.from({ length: 10 }, () => handleAdminAction(deps, ADMIN, { action: "adjustAssets", uid: "uT", direction: "decrease", amount: 700 })));
  const ok = results.filter((r) => r.ok);
  results.filter((r) => !r.ok).forEach((r) => assert.ok(["busy", "insufficient_assets"].includes(r.error), r.error));
  assert.ok(ok.length >= 3, `成功 ${ok.length} 件`);
  assert.equal(total(userOf(firestore)), 11800 - 700 * ok.length);
  assert.equal(logs(firestore).length, ok.length);
  const ranking = rankingOf(firestore).users.find((u) => u.name === "たろう");
  assert.equal(ranking.total, 11800 - 700 * ok.length, "ランキングの行も同じ値");
  /* 記録の「前→後」をつなげると途切れない */
  const chain = logs(firestore).map((l) => [l.beforeTotal, l.afterTotal]).sort((a, b) => b[0] - a[0]);
  chain.forEach(([b, a], i) => { assert.equal(b - a, 700); if (i > 0) assert.equal(chain[i - 1][1], b); });
});

test("同時に：ランキングが（13:00 の集計などで）書き換えられた直後でも、新しいランキングに対して計算し直す", async () => {
  const { deps, firestore } = setup();
  const realGetRaw = firestore.getRaw;
  let done = false;
  firestore.getRaw = async (path) => {
    const doc = await realGetRaw(path);
    if (!done && path === "rankings/assets") {
      done = true;
      const cur = decF(firestore.docs.get(path).fields);
      firestore.put(path, encF({ ...cur, users: [...cur.users, { name: "あたらしい", coins: 20000, deposit: 0, stockValue: 0, loan: 0, total: 20000, rank: 1 }] }));
    }
    return doc;
  };
  const r = await handleAdminAction(deps, ADMIN, { action: "adjustAssets", uid: "uT", direction: "decrease", amount: 100 });
  assert.equal(r.ok, true);
  const names = rankingOf(firestore).users.map((u) => u.name);
  assert.ok(names.includes("あたらしい"), "あとから書かれたランキングの行は消えない");
  assert.deepEqual(rankingOf(firestore).users.map((u) => u.rank), [1, 2, 3, 4]);
});

for (const [label, amount] of [["0", 0], ["マイナス", -5], ["小数", 1.5], ["文字列", "100"], ["大きすぎる", 10000001], ["NaN", NaN], ["指定なし", undefined]]) {
  test(`不正な金額（${label}）は拒否`, async () => {
    const { deps, firestore } = setup();
    const r = await handleAdminAction(deps, ADMIN, { action: "adjustAssets", uid: "uT", direction: "decrease", amount });
    assert.deepEqual([r.status, r.error], [400, "invalid_amount"]);
    assert.equal(firestore.commits, 0);
  });
}

test("増やす・減らす以外の指定は拒否", async () => {
  const { deps, firestore } = setup();
  assert.equal((await handleAdminAction(deps, ADMIN, { action: "adjustAssets", uid: "uT", direction: "set", amount: 5 })).error, "invalid_direction");
  assert.equal(firestore.commits, 0);
});

test("管理者以外（一般ユーザー・本人）は 403。内訳も見られず、何も書かない", async () => {
  const { deps, firestore } = setup();
  for (const caller of ["uT", "uH", ""]) {
    for (const action of ["previewAssets", "adjustAssets"]) {
      const r = await handleAdminAction(deps, caller, { action, uid: "uT", direction: "decrease", amount: 100 });
      assert.deepEqual([r.status, r.error], [403, "not_admin"]);
    }
  }
  assert.equal(firestore.commits, 0);
});

test("ユーザーが見つからない・削除の途中なら変更しない", async () => {
  const { deps, firestore } = setup();
  assert.equal((await handleAdminAction(deps, ADMIN, { action: "adjustAssets", uid: "nobody", direction: "decrease", amount: 1 })).error, "user_not_found");
  firestore.put("userDeletions/uT", encF({ status: "failed" }));
  assert.equal((await handleAdminAction(deps, ADMIN, { action: "adjustAssets", uid: "uT", direction: "decrease", amount: 1 })).error, "deletion_in_progress");
  assert.equal(firestore.commits, 0);
});

test("株価がまだ一度も更新されていない（market/current が無い）ときは、最初の株価で計算する（アプリと同じ）", async () => {
  const { deps, firestore } = setup();
  firestore.docs.delete("market/current");
  const p = await handleAdminAction(deps, ADMIN, { action: "previewAssets", uid: "uT" });
  assert.deepEqual(p.breakdown.stocks.map((s) => [s.code, s.price]), [["YEN", 280], ["YGM", 180]]);
});
