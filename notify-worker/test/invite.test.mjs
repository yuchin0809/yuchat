/* 🎟 招待コード（worker.js の handleInviteAction）：作る・使う・上限・1人1回・登録前のゲストは作れない */
import test from "node:test";
import assert from "node:assert/strict";
import { handleInviteAction, INVITE_MAX_USES } from "../worker.js";

const ROOT = "projects/p/databases/(default)/documents";
function fakeFs(users = {}) {
  const docs = new Map();
  return {
    docs,
    docName: (p) => `${ROOT}/${p}`,
    async get(p) { return docs.has(p) ? structuredClone(docs.get(p)) : null; },
    async getRaw(p) { return users[p.replace("users/", "")] ? { fields: { uid: { stringValue: users[p.replace("users/", "")].uid } }, updateTime: "t" } : null; },
    async query(c, f) { return c === "users" ? Object.entries(users).filter(([, u]) => f.every(([k, , v]) => u[k] === v)).map(([id]) => ({ id, path: `users/${id}` })) : []; },
    async createIfAbsent(p, d) { if (docs.has(p)) return false; docs.set(p, structuredClone(d)); return true; },
    async commit(writes) { for (const w of writes) { const p = w.update.name.slice(ROOT.length + 1); const cur = docs.get(p); if (!cur) throw new Error("missing"); for (const t of w.updateTransforms || []) cur[t.fieldPath] = Number(cur[t.fieldPath] || 0) + Number(t.increment.integerValue); } }
  };
}
const mk = (users) => ({ firestore: fakeFs(users), slotSecret: "s", now: () => 1 });

test("招待コード：登録済みの人は、自分の8文字のコードを作れる（同じ人は毎回同じ）。登録前のゲストは作れない", async () => {
  const deps = mk({ たろう: { uid: "uT" } });
  const a = await handleInviteAction(deps, "uT", { action: "create", username: "たろう" });
  assert.match(a.code, /^[A-Z2-9]{8}$/);
  assert.equal((await handleInviteAction(deps, "uT", { action: "create", username: "たろう" })).code, a.code);
  assert.equal((await handleInviteAction(deps, "uGuest", { action: "create", username: "x" })).error, "not_a_member");
});

test("招待コード：新しい人が使える。小文字でもよい。1人は1回だけ数える。知らないコード・形の違うコードは断る", async () => {
  const deps = mk({ たろう: { uid: "uT" } });
  const { code } = await handleInviteAction(deps, "uT", { action: "create", username: "たろう" });
  const r = await handleInviteAction(deps, "uNew", { action: "redeem", code: code.toLowerCase() });
  assert.equal(r.ok, true); assert.equal(r.ownerName, "たろう");
  await handleInviteAction(deps, "uNew", { action: "redeem", code });
  assert.equal(deps.firestore.docs.get(`inviteCodes/${code}`).uses, 1, "同じ人が何回使っても1回");
  assert.equal((await handleInviteAction(deps, "uX", { action: "redeem", code: "ZZZZZZZZ" })).error, "invalid_code");
  assert.equal((await handleInviteAction(deps, "uX", { action: "redeem", code: "abc" })).error, "invalid_code");
});

test("招待コード：1つのコードで使える人数に上限がある", async () => {
  const deps = mk({ たろう: { uid: "uT" } });
  const { code } = await handleInviteAction(deps, "uT", { action: "create", username: "たろう" });
  deps.firestore.docs.get(`inviteCodes/${code}`).uses = INVITE_MAX_USES;
  assert.equal((await handleInviteAction(deps, "uNew", { action: "redeem", code })).error, "code_full");
});
