/* indexes.mjs のテスト（本番には接続しない。API は偽物を使う） */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { loadSpec, plan, sameIndex, equivalentIndex, loadServiceAccount, run, chatQueries, EXPECTED_PROJECT_ID } from "../indexes.mjs";

const P = EXPECTED_PROJECT_ID;
const wanted = loadSpec();
const prodName = (cg, id) => `projects/${P}/databases/(default)/collectionGroups/${cg}/indexes/${id}`;
const asProd = (w, id, state = "READY") => ({
  name: prodName(w.collectionGroup, id), queryScope: w.queryScope, state,
  fields: [...w.fields, { fieldPath: "__name__", order: w.fields[w.fields.length - 1].order }]
});
const quiet = () => {};

/* 偽物の API：呼ばれたものを記録する。作ったインデックスは CREATING → readyAfter 回目の一覧で READY */
function fakeApi({ existing = [], readyAfter = 1, createError = null, queryError = null } = {}) {
  const calls = [];
  const store = existing.map((e) => ({ ...e }));
  let lists = 0;
  const api = async (method, url, data) => {
    calls.push({ method, url, data });
    if (!["GET", "POST"].includes(method)) throw new Error("GET・POST 以外は使わない");
    if (method === "GET" && /collectionGroups\/-\/indexes/.test(url)) {
      lists++;
      store.forEach((s) => { if (s.state === "CREATING" && lists > s.readyAt) s.state = "READY"; });
      return { indexes: store.map((s) => ({ name: s.name, queryScope: s.queryScope, fields: s.fields, state: s.state })) };
    }
    if (method === "POST" && /\/indexes$/.test(url)) {
      if (createError) throw createError;
      const cg = url.match(/collectionGroups\/([^/]+)\/indexes$/)[1];
      store.push({ name: prodName(cg, `new${store.length}`), queryScope: data.queryScope, fields: data.fields, state: "CREATING", readyAt: lists + readyAfter });
      return { name: "operations/x" };
    }
    if (method === "POST" && /documents:runQuery$/.test(url)) {
      if (queryError) throw queryError;
      return [{ readTime: "2026-10-09T00:00:00Z" }];
    }
    throw new Error(`想定外の呼び出し ${method} ${url}`);
  };
  return { api, calls, store };
}

test("firestore.indexes.json：チャット用の2件だけ（重複なし）", () => {
  assert.equal(wanted.length, 2);
  const keys = wanted.map((w) => `${w.collectionGroup}|${w.fields.map((f) => f.fieldPath + ":" + f.order).join(",")}`);
  assert.deepEqual(keys.sort(), [
    "messages|groupId:ASCENDING,createdAt:DESCENDING",
    "messages|sender:ASCENDING,receiver:ASCENDING,createdAt:DESCENDING"
  ]);
  wanted.forEach((w) => assert.equal(w.queryScope, "COLLECTION"));
  assert.equal(wanted.filter((a, i) => wanted.some((b, j) => j < i && (sameIndex(a, b) || equivalentIndex(a, b)))).length, 0);
});

test("firestore.indexes.json：fieldOverrides や不正な項目は受け付けない", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "idx-"));
  const f = path.join(dir, "i.json");
  fs.writeFileSync(f, JSON.stringify({ indexes: [], fieldOverrides: [{ collectionGroup: "messages", fieldPath: "x", indexes: [] }] }));
  assert.throws(() => loadSpec(f), /fieldOverrides/);
  fs.writeFileSync(f, JSON.stringify({ indexes: [{ collectionGroup: "messages", queryScope: "COLLECTION", fields: [{ fieldPath: "a", order: "ASCENDING" }] }] }));
  assert.throws(() => loadSpec(f), /2つ以上/);
  fs.writeFileSync(f, JSON.stringify({ indexes: [{ collectionGroup: "messages", queryScope: "COLLECTION", fields: [{ fieldPath: "a", order: "ASCENDING" }, { fieldPath: "b", arrayConfig: "CONTAINS" }] }] }));
  assert.throws(() => loadSpec(f), /order/);
});

test("比較：本番の __name__ 付き・等号の順番違いは同じものとみなし、並び順や項目が違うものは別", () => {
  const [one] = wanted.filter((w) => w.fields.length === 3);
  assert.ok(sameIndex(one, asProd(one, "a")));
  const swapped = { ...asProd(one, "b"), fields: [one.fields[1], one.fields[0], one.fields[2]] };
  assert.ok(!sameIndex(one, swapped));
  assert.ok(equivalentIndex(one, swapped));
  const asc = { ...asProd(one, "c"), fields: [one.fields[0], one.fields[1], { fieldPath: "createdAt", order: "ASCENDING" }] };
  assert.ok(!sameIndex(one, asc) && !equivalentIndex(one, asc));
  const group = { ...asProd(one, "d"), name: prodName("other", "d") };
  assert.ok(!sameIndex(one, group) && !equivalentIndex(one, group));
  const cgScope = { ...asProd(one, "e"), queryScope: "COLLECTION_GROUP" };
  assert.ok(!sameIndex(one, cgScope));
});

test("plan：本番にあるものは作らず、無いものだけ作る", () => {
  const unrelated = { name: prodName("bets", "z"), queryScope: "COLLECTION", state: "READY", fields: [{ fieldPath: "uid", order: "ASCENDING" }, { fieldPath: "createdAt", order: "DESCENDING" }] };
  assert.equal(plan(wanted, []).create.length, 2);
  assert.equal(plan(wanted, [unrelated]).create.length, 2);
  const p = plan(wanted, [asProd(wanted[0], "a"), unrelated]);
  assert.equal(p.create.length, 1);
  assert.ok(sameIndex(p.create[0], wanted[1]));
  assert.equal(plan(wanted, wanted.map((w, i) => asProd(w, `x${i}`))).create.length, 0);
});

test("サービスアカウント：yuuchat-be666 以外・未設定なら止める", () => {
  assert.throws(() => loadServiceAccount({}), /設定されていません/);
  assert.throws(() => loadServiceAccount({ FIREBASE_SERVICE_ACCOUNT: JSON.stringify({ project_id: "other-project" }) }), /yuuchat-be666 ではありません/);
  assert.equal(loadServiceAccount({ FIREBASE_SERVICE_ACCOUNT: JSON.stringify({ project_id: P }) }).project_id, P);
});

test("check：読むだけ（POST をしない）", async () => {
  const { api, calls } = fakeApi({ existing: [asProd(wanted[0], "a")] });
  const r = await run("check", { api, projectId: P, wanted, log: quiet });
  assert.equal(r.plan.create.length, 1);
  assert.equal(calls.filter((c) => c.method !== "GET").length, 0);
});

test("deploy：無いものだけを作り、READY まで待ってから問い合わせを確かめる。削除・変更はしない", async () => {
  const unrelated = { name: prodName("bets", "z"), queryScope: "COLLECTION", state: "READY", fields: [{ fieldPath: "uid", order: "ASCENDING" }, { fieldPath: "createdAt", order: "DESCENDING" }] };
  const { api, calls, store } = fakeApi({ existing: [asProd(wanted[0], "a"), unrelated], readyAfter: 3 });
  let slept = 0;
  const r = await run("deploy", { api, projectId: P, wanted, wait: 25, sleep: async () => { slept++; }, log: quiet });
  const creates = calls.filter((c) => c.method === "POST" && /\/indexes$/.test(c.url));
  assert.equal(creates.length, 1);
  assert.match(creates[0].url, new RegExp(`^projects/${P}/databases/\\(default\\)/collectionGroups/messages/indexes$`));
  assert.deepEqual(creates[0].data, { queryScope: wanted[1].queryScope, fields: wanted[1].fields });
  assert.ok(calls.every((c) => ["GET", "POST"].includes(c.method)));
  assert.ok(store.some((s) => s.name === unrelated.name), "関係ないインデックスは残る");
  assert.ok(slept >= 2, "READY になるまで待った");
  assert.equal(r.ready, true);
  assert.equal(r.verify.length, 2);
  assert.ok(r.verify.every((v) => v.ok));
});

test("deploy：時間内に READY にならなければ、ready=false で確認の問い合わせもしない", async () => {
  const { api, calls } = fakeApi({ readyAfter: 1e9 });
  let t = Date.now();
  const realNow = Date.now;
  Date.now = () => t;
  try {
    const r = await run("deploy", { api, projectId: P, wanted, wait: 1, sleep: async () => { t += 30 * 1000; }, log: quiet });
    assert.equal(r.ready, false);
    assert.equal(r.verify, undefined);
    assert.equal(calls.filter((c) => /runQuery/.test(c.url)).length, 0);
  } finally { Date.now = realNow; }
});

test("deploy：すでに作成中（409）は失敗にしない／権限不足（403）は止める", async () => {
  const conflict = Object.assign(new Error("exists"), { status: 409, apiStatus: "ALREADY_EXISTS" });
  const a = fakeApi({ createError: conflict, existing: [] });
  const r = await run("deploy", { api: a.api, projectId: P, wanted, wait: 0, sleep: async () => {}, log: quiet });
  assert.equal(r.ready, false);
  const denied = Object.assign(new Error("denied"), { status: 403, apiStatus: "PERMISSION_DENIED" });
  const b = fakeApi({ createError: denied });
  const lines = [];
  await assert.rejects(run("deploy", { api: b.api, projectId: P, wanted, log: (l) => lines.push(...l) }), /作成に失敗/);
  assert.ok(lines.some((l) => /roles\/datastore\.indexAdmin/.test(l)));
});

test("verify：チャットの問い合わせ（1対1・グループ）を、どの文書にも当たらない値で1件だけ試す", async () => {
  const qs = chatQueries();
  assert.equal(qs.length, 2);
  qs.forEach((q) => { assert.equal(q.structuredQuery.limit, 1); assert.deepEqual(q.structuredQuery.orderBy, [{ field: { fieldPath: "createdAt" }, direction: "DESCENDING" }]); });
  assert.equal(qs[0].structuredQuery.where.compositeFilter.op, "OR");
  assert.ok(JSON.stringify(qs).includes("__index_check__"));
  const ok = fakeApi();
  assert.equal((await run("verify", { api: ok.api, projectId: P, wanted, log: quiet })).ok, true);
  const missing = Object.assign(new Error("The query requires an index"), { status: 400, apiStatus: "FAILED_PRECONDITION" });
  const ng = fakeApi({ queryError: missing });
  const r = await run("verify", { api: ng.api, projectId: P, wanted, log: quiet });
  assert.equal(r.ok, false);
  assert.ok(r.verify.every((v) => v.needsIndex));
});
