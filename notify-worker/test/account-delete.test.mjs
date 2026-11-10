/* 🗑 アカウントの削除（本人）：管理者の完全削除と同じ処理を、本人の uid・名前の入力で呼ぶ（worker.js の selfDeleteAccount） */
import test from "node:test";
import assert from "node:assert/strict";
import { selfDeleteAccount, handleRequest } from "../worker.js";

const ROOT = "projects/p/databases/(default)/documents";
function fakeFs(users = {}, bets = []) {
  return {
    docName: (p) => `${ROOT}/${p}`,
    async query(collection, filters) {
      if (collection === "users") return Object.entries(users).filter(([, u]) => filters.every(([f, , v]) => u[f] === v)).map(([id, u]) => ({ id, path: `users/${id}`, data: u }));
      if (collection === "raceBets") return bets.filter((b) => filters.every(([f, , v]) => b[f] === v)).map((b, i) => ({ id: `b${i}`, path: `raceBets/b${i}`, data: b }));
      return [];
    },
    async get() { return null; },
    async getRaw() { return null; },
    async listCollectionIds() { return []; }, async listDocuments() { return []; },
    async set() {}, async add() {}, async commit() {}, async delete() {}
  };
}

test("アカウント削除（本人）：名前の入力が無い・違うときは削除しない。管理者・存在しない人は断る", async () => {
  const deps = { firestore: fakeFs({ たろう: { uid: "uT" } }), adminUid: "uA", now: () => 1 };
  assert.equal((await selfDeleteAccount(deps, "uT", {})).error, "confirm_mismatch");
  assert.equal((await selfDeleteAccount(deps, "uT", { confirmName: "はなこ" })).error, "confirm_mismatch");
  assert.equal((await selfDeleteAccount(deps, "uA", { confirmName: "x" })).error, "cannot_target_admin");
  assert.equal((await selfDeleteAccount(deps, "uNobody", { confirmName: "x" })).error, "user_not_found");
});

test("アカウント削除（本人）：未精算の馬券があれば断る（blocked）", async () => {
  const deps = { firestore: fakeFs({ たろう: { uid: "uT" } }, [{ uid: "uT", raceId: "2026-11-06", settled: false }]), adminUid: "uA", now: () => 1 };
  const r = await selfDeleteAccount(deps, "uT", { confirmName: "たろう" });
  assert.equal(r.error, "blocked");
});

test("/account は、ログインなしでは使えない。知らない操作は断る", async () => {
  const env = { ALLOWED_ORIGINS: "https://yuchin0809.github.io" };
  const req = (headers = {}, body = {}) => new Request("https://w.example/account", { method: "POST", headers: { Origin: "https://yuchin0809.github.io", "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  assert.equal((await handleRequest(req(), env, { verifyIdToken: async () => "uT" })).status, 401);
  const r = await handleRequest(req({ Authorization: "Bearer t" }, { action: "x" }), env, { verifyIdToken: async () => "uT", firestore: fakeFs() });
  assert.equal(r.status, 400);
});
