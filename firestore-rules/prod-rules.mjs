/* =========================================================
   Firestore ルール（firestore.rules）の本番確認・公開（GitHub Actions から実行）

   node prod-rules.mjs check     本番のルールを読み、差分を出し、本番のルールエンジンで新しいルールをテストする（本番は変えない）
   node prod-rules.mjs deploy    check がすべて通ったときだけ、新しいルールを本番に公開する
   node prod-rules.mjs rollback  ROLLBACK_RULESET（projects/…/rulesets/…）に本番のルールを戻す

   安全のための決まり：
   ・本番のルールが「これまでリポジトリにあったどれか」か「最初のルール（ログイン済みなら全部読み書き可）」と
     同じでなければ公開しない（Firebase Console で直接変えた内容を上書きして消さないため）
   ・本番のルールエンジン（Rules の test API）で、管理用データへの一般ユーザーの書き込みが拒否されること、
     既存のデータは今まで通り使えることを確かめてから公開する。test API は本番のデータに一切触れない
   ・公開の前の本番ルールの名前を必ず表示する（rollback で戻せる）

   環境変数：
     FIREBASE_SERVICE_ACCOUNT  サービスアカウントの鍵（JSON）。GitHub Secrets（ゆうダービー自動開催と同じもの）
     KNOWN_RULES_DIR           リポジトリの過去の firestore.rules を入れたフォルダ（ワークフローが用意する）
     ROLLBACK_RULESET          rollback のときに戻す先
     GITHUB_STEP_SUMMARY       GitHub Actions が設定する。結果をここに書き出す
========================================================= */

import fs from "fs";
import path from "path";
import { GoogleAuth } from "google-auth-library";

const EXPECTED_PROJECT_ID = "yuuchat-be666";
const ADMIN_UID = "g51wzTvJFsZiYEfre5aDuDckJXY2";
const RULES_FILE = new URL("../firestore.rules", import.meta.url);
const API = "https://firebaserules.googleapis.com/v1";

/* 2026-09-26 時点の本番ルール（このリポジトリにルールを入れる前のもの） */
const INITIAL_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if request.auth != null;
    }
  }
}`;

/* 確認・公開に必要な権限（Google Cloud IAM）
   rulesets.test は、公開前に本番のルールエンジンで新しいルールをテストするために使う */
const REQUIRED_PERMISSIONS = [
  "firebaserules.releases.get",
  "firebaserules.rulesets.get",
  "firebaserules.rulesets.test",
  "firebaserules.rulesets.create",
  "firebaserules.releases.update"
];
const EXTRA_PERMISSIONS = [];

const summary = [];
const out = (line = "") => { console.log(line); summary.push(line); };
const writeSummary = () => { if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary.join("\n") + "\n"); };

/* コメントと空白の違いは無視して比べる */
function normalizeRules(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "").replace(/\s+/g, " ").trim();
}

function loadServiceAccount() {
  const json = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!json) throw new Error("FIREBASE_SERVICE_ACCOUNT が設定されていません");
  const credentials = JSON.parse(json);
  if (credentials.project_id !== EXPECTED_PROJECT_ID) {
    throw new Error(`サービスアカウントのプロジェクトが ${EXPECTED_PROJECT_ID} ではありません（${credentials.project_id}）`);
  }
  return credentials;
}

/* ログは公開されるので、サービスアカウントのアドレスは一部だけ表示する（IAM の画面で見分けられる程度） */
function describeServiceAccount(credentials) {
  const [local, domain] = String(credentials.client_email || "").split("@");
  return `${local.slice(0, Math.min(local.length, 20))}…@${domain || "?"}（キーID ${String(credentials.private_key_id || "").slice(0, 8)}…）`;
}

async function createApi(credentials) {
  const auth = new GoogleAuth({ credentials, scopes: ["https://www.googleapis.com/auth/cloud-platform", "https://www.googleapis.com/auth/firebase"] });
  const client = await auth.getClient();
  return async (method, urlPath, data) => {
    try {
      const url = /^https:/.test(urlPath) ? urlPath : `${API}/${urlPath}`;
      const response = await client.request({ url, method, data });
      return response.data;
    } catch (error) {
      const status = error.response?.status;
      const message = error.response?.data?.error?.message || error.message;
      const hint = status === 403
        ? "（サービスアカウントにこの操作の権限がありません。Google Cloud Console の IAM で、このサービスアカウントに「Firebase Rules 管理者」（roles/firebaserules.admin）を追加してください）"
        : "";
      throw new Error(`${method} ${urlPath} → ${status || ""} ${message}${hint}`);
    }
  };
}

async function getProductionRules(api, projectId) {
  const release = await api("GET", `projects/${projectId}/releases/cloud.firestore`);
  const ruleset = await api("GET", release.rulesetName);
  const source = (ruleset.source?.files || []).map((f) => f.content).join("\n");
  return { release, ruleset, source };
}

/* ----- 本番のルールエンジンで確かめる内容（本番のデータには触れない） ----- */
const DOCS = "/databases/(default)/documents";
const admin = { uid: ADMIN_UID, token: {} };
const userA = { uid: "rulesTestUserA", token: {} };
const fakeAdmin = { uid: "rulesTestFakeAdmin", token: { email: "admin@example.com", name: "admin" } };

const manualRace = { raceId: "2030-01-01-m1200", dayId: "2030-01-01", status: "scheduled", betCount: 0, createdByUid: ADMIN_UID };
const announcementDoc = { title: "お知らせ", body: "本文", createdByUid: ADMIN_UID, createdByName: "admin" };
const eventDoc = { title: "テスト", description: "", location: "", capacity: 0, status: "scheduled", participantCount: 0, createdByUid: ADMIN_UID };

function testCase(expectation, label, auth, method, docPath, { data, existing } = {}) {
  const request = { path: `${DOCS}/${docPath}`, method };
  if (auth) request.auth = auth;
  if (data) request.resource = { data };
  const tc = { expectation, request };
  if (existing) tc.resource = { data: existing };
  return { label, tc };
}

const TEST_CASES = [
  // 管理者は管理操作ができる
  testCase("ALLOW", "管理者：手動レースの作成", admin, "create", "derbyManualRaces/2030-01-01-m1200", { data: manualRace }),
  testCase("ALLOW", "管理者：手動レースのキャンセル", admin, "update", "derbyManualRaces/2030-01-01-m1200", { data: { ...manualRace, status: "cancelled" }, existing: manualRace }),
  testCase("ALLOW", "管理者：手動レースの削除", admin, "delete", "derbyManualRaces/2030-01-01-m1200", { existing: manualRace }),
  // 一般ユーザーは管理用データを直接書き換えられない
  testCase("DENY", "一般：手動レースの作成", userA, "create", "derbyManualRaces/2030-01-01-m1200", { data: manualRace }),
  testCase("DENY", "一般：手動レースのキャンセル", userA, "update", "derbyManualRaces/2030-01-01-m1200", { data: { ...manualRace, status: "cancelled" }, existing: manualRace }),
  testCase("DENY", "一般：手動レースの投票数を0に戻す", userA, "update", "derbyManualRaces/2030-01-01-m1200", { data: { ...manualRace, betCount: 0 }, existing: { ...manualRace, betCount: 3 } }),
  testCase("DENY", "一般：手動レースの削除", userA, "delete", "derbyManualRaces/2030-01-01-m1200", { existing: manualRace }),
  testCase("DENY", "メール・名前が管理者風でも UID が違う人：手動レースの作成", fakeAdmin, "create", "derbyManualRaces/2030-01-01-m1200", { data: manualRace }),
  // 廃止したイベント機能（events / eventParticipants）：管理者も一般ユーザーも読み書きできない
  testCase("DENY", "管理者：イベントの読み取り（廃止）", admin, "get", "events/ev-test", { existing: eventDoc }),
  testCase("DENY", "管理者：イベントの作成（廃止）", admin, "create", "events/ev-test", { data: eventDoc }),
  testCase("DENY", "管理者：イベントの削除（廃止）", admin, "delete", "events/ev-test", { existing: eventDoc }),
  testCase("DENY", "一般：イベントの読み取り（廃止）", userA, "get", "events/ev-test", { existing: eventDoc }),
  testCase("DENY", "一般：イベントの作成（廃止）", userA, "create", "events/ev-test", { data: eventDoc }),
  testCase("DENY", "一般：イベントの編集（廃止）", userA, "update", "events/ev-test", { data: { ...eventDoc, participantCount: 1 }, existing: eventDoc }),
  testCase("DENY", "一般：参加記録の読み取り（廃止）", userA, "get", "eventParticipants/ev-test_rulesTestUserA", { existing: { eventId: "ev-test", uid: userA.uid } }),
  testCase("DENY", "一般：参加記録の作成（廃止）", userA, "create", "eventParticipants/ev-test_rulesTestUserA", { data: { eventId: "ev-test", uid: userA.uid, username: "x" } }),
  testCase("DENY", "一般：参加記録の削除（廃止）", userA, "delete", "eventParticipants/ev-test_rulesTestUserA", { existing: { eventId: "ev-test", uid: userA.uid } }),
  // ゆうダービーの馬券：固定オッズ方式のレース（2026-10-09 以降）は固定オッズの精算だけ。自分の馬券だけ精算できる
  testCase("ALLOW", "raceBets：旧方式のレースの自分の馬券を旧方式で精算", userA, "update", "raceBets/b-old", { data: { raceId: "2026-10-08", uid: userA.uid, settled: true, win: true, payout: 80 }, existing: { raceId: "2026-10-08", uid: userA.uid, settled: false } }),
  testCase("DENY", "raceBets：新方式のレースの馬券を古い形式で精算", userA, "update", "raceBets/b-new", { data: { raceId: "2026-10-09", uid: userA.uid, settled: true, win: true, payout: 80 }, existing: { raceId: "2026-10-09", uid: userA.uid, settled: false } }),
  testCase("ALLOW", "raceBets：新方式のレースの自分の馬券を固定オッズで精算", userA, "update", "raceBets/b-new", { data: { raceId: "2026-10-09", uid: userA.uid, settled: true, win: true, payout: 600, payoutRule: "fixed-v1" }, existing: { raceId: "2026-10-09", uid: userA.uid, settled: false } }),
  testCase("DENY", "raceBets：他人の馬券を精算", userA, "update", "raceBets/b-other", { data: { raceId: "2026-10-09", uid: "someoneElse", settled: true, win: true, payout: 600, payoutRule: "fixed-v1" }, existing: { raceId: "2026-10-09", uid: "someoneElse", settled: false } }),
  testCase("ALLOW", "raceBets：新方式のレースの馬券購入", userA, "create", "raceBets/b-buy", { data: { raceId: "2026-10-12", uid: userA.uid, type: "win", horses: [1], amount: 100, settled: false, oddsVersion: 1, oddsTenths: 25 } }),
  // お知らせ（announcements）：読み取りはログイン済みなら誰でも・作成/編集/削除は管理者だけ
  testCase("ALLOW", "一般：お知らせの読み取り", userA, "get", "announcements/a1", { existing: announcementDoc }),
  testCase("ALLOW", "管理者：お知らせの削除", admin, "delete", "announcements/a1", { existing: announcementDoc }),
  testCase("DENY", "一般：お知らせの作成", userA, "create", "announcements/a1", { data: announcementDoc }),
  testCase("DENY", "一般：お知らせの編集", userA, "update", "announcements/a1", { data: { ...announcementDoc, title: "乗っ取り" }, existing: announcementDoc }),
  testCase("DENY", "一般：お知らせの削除", userA, "delete", "announcements/a1", { existing: announcementDoc }),
  testCase("DENY", "メール・名前が管理者風でも UID が違う人：お知らせの削除", fakeAdmin, "delete", "announcements/a1", { existing: announcementDoc }),
  testCase("DENY", "未ログイン：お知らせの読み取り", null, "get", "announcements/a1", { existing: announcementDoc }),
  testCase("ALLOW", "users：自分の lastAnnouncementReadAt の更新（既存の users のルールのまま）", userA, "update", "users/alice", { data: { uid: userA.uid, coins: 1000, lastAnnouncementReadAt: "2030-01-01" }, existing: { uid: userA.uid, coins: 1000 } }),
  // 一般ユーザーの読み取りと既存データは今まで通り
  testCase("ALLOW", "一般：手動レースの読み取り", userA, "get", "derbyManualRaces/2030-01-01-m1200", { existing: manualRace }),
  testCase("ALLOW", "users：自分のデータ更新", userA, "update", "users/alice", { data: { uid: userA.uid, coins: 900 }, existing: { uid: userA.uid, coins: 1000 } }),
  testCase("ALLOW", "users：ランキング（他人のデータの読み取り）", userA, "get", "users/bob", { existing: { uid: "bob", coins: 1000 } }),
  testCase("DENY", "users：他人の名前の書き換え", userA, "update", "users/bob", { data: { uid: "bob", name: "へんななまえ", coins: 1000 }, existing: { uid: "bob", name: "bob", coins: 1000 } }),
  testCase("DENY", "users：他人のコインの書き換え", userA, "update", "users/bob", { data: { uid: "bob", coins: 999999 }, existing: { uid: "bob", coins: 1000 } }),
  testCase("DENY", "users：他人のデータの削除", userA, "delete", "users/bob", { existing: { uid: "bob", coins: 1000 } }),
  testCase("DENY", "users：管理者でも他人の users を直接は書き換えられない（名前の強制変更以外）", admin, "update", "users/bob", { data: { uid: "bob", coins: 1 }, existing: { uid: "bob", coins: 1000 } }),
  testCase("ALLOW", "users：自分の名前で新規登録", userA, "create", "users/alice2", { data: { uid: userA.uid, name: "alice2" } }),
  testCase("ALLOW", "friends：友達追加", userA, "create", "friends/alice_bob", { data: { user1: "alice", user2: "bob" } }),
  testCase("ALLOW", "groups：グループ作成", userA, "create", "groups/g1", { data: { name: "g", members: ["alice"] } }),
  testCase("ALLOW", "messages：メッセージ送信", userA, "create", "messages/m1", { data: { sender: "alice", text: "hi" } }),
  testCase("ALLOW", "messages：既読", userA, "update", "messages/m1", { data: { sender: "bob", readBy: ["alice"] }, existing: { sender: "bob", readBy: [] } }),
  testCase("ALLOW", "gameRooms：部屋作成", userA, "create", "gameRooms/r1", { data: { host: "alice" } }),
  // 🎮 ゲームの招待：読めるのは本人どうしだけ・返事は招待された人だけ・なりすましの招待は作れない
  testCase("ALLOW", "gameInvites：招待された人が自分の招待を読む", userA, "get", "gameInvites/r1_" + userA.uid, { existing: { roomId: "r1", toUid: userA.uid, fromUid: "someoneElse", status: "pending" } }),
  testCase("DENY", "gameInvites：他人の招待を読む", userA, "get", "gameInvites/r1_someoneElse", { existing: { roomId: "r1", toUid: "someoneElse", fromUid: "anotherOne", status: "pending" } }),
  testCase("ALLOW", "gameInvites：招待された人が辞退する", userA, "update", "gameInvites/r1_" + userA.uid, { data: { roomId: "r1", toUid: userA.uid, fromUid: "someoneElse", status: "declined", respondedAt: 1 }, existing: { roomId: "r1", toUid: userA.uid, fromUid: "someoneElse", status: "pending", respondedAt: null } }),
  testCase("DENY", "gameInvites：他人の招待を辞退にする", userA, "update", "gameInvites/r1_someoneElse", { data: { roomId: "r1", toUid: "someoneElse", fromUid: "anotherOne", status: "declined", respondedAt: 1 }, existing: { roomId: "r1", toUid: "someoneElse", fromUid: "anotherOne", status: "pending", respondedAt: null } }),
  testCase("DENY", "gameInvites：他人になりすまして招待を作る", userA, "create", "gameInvites/r1_someoneElse", { data: { roomId: "r1", gameType: "othello", from: "bob", fromUid: "anotherOne", to: "carol", toUid: "someoneElse", status: "pending" } }),
  testCase("DENY", "gameInvites：形の合わない招待を作る", userA, "create", "gameInvites/i1", { data: { from: "alice", to: "bob" } }),
  testCase("ALLOW", "fcmTokens：通知トークン保存", userA, "create", "fcmTokens/t1", { data: { uid: userA.uid } }),
  testCase("ALLOW", "races：レース結果作成（自動開催）", userA, "create", "races/2030-01-02", { data: { raceId: "2030-01-02", status: "finished" } }),
  testCase("ALLOW", "raceBets：投票", userA, "create", "raceBets/b1", { data: { raceId: "2030-01-02", uid: userA.uid, amount: 100 } }),
  testCase("ALLOW", "raceLogs：開催ログ", userA, "create", "raceLogs/2030-01-02", { data: { raceId: "2030-01-02" } }),
  testCase("DENY", "未ログイン：users の読み取り（今まで通り拒否）", null, "get", "users/alice", { existing: { uid: userA.uid } }),
  testCase("DENY", "未ログイン：メッセージ送信（今まで通り拒否）", null, "create", "messages/m2", { data: { text: "x" } }),
  testCase("DENY", "未ログイン：イベントの読み取り", null, "get", "events/ev-test", { existing: eventDoc }),
  // 👤 ユーザー管理：停止の記録・操作の記録・削除の進み具合は、通知サーバー（サービスアカウント）だけが書く
  testCase("DENY", "一般：自分の停止の記録の読み取り", userA, "get", `suspendedUsers/${userA.uid}`, { existing: { uid: userA.uid } }),
  testCase("ALLOW", "管理者：停止の記録の読み取り", admin, "get", `suspendedUsers/${userA.uid}`, { existing: { uid: userA.uid } }),
  testCase("DENY", "一般：他人の停止の記録の読み取り", userA, "get", "suspendedUsers/someoneElse", { existing: { uid: "someoneElse" } }),
  testCase("DENY", "一般：自分の停止の記録を消す", userA, "delete", `suspendedUsers/${userA.uid}`, { existing: { uid: userA.uid } }),
  testCase("DENY", "管理者：ブラウザから停止の記録を作る", admin, "create", "suspendedUsers/someoneElse", { data: { uid: "someoneElse" } }),
  testCase("ALLOW", "管理者：操作の記録の読み取り", admin, "get", "adminAuditLogs/l1", { existing: { action: "setPassword" } }),
  testCase("DENY", "一般：操作の記録の読み取り", userA, "get", "adminAuditLogs/l1", { existing: { action: "setPassword" } }),
  testCase("DENY", "管理者：ブラウザから操作の記録を書き換える", admin, "update", "adminAuditLogs/l1", { data: { action: "x" }, existing: { action: "setPassword" } }),
  testCase("DENY", "一般：削除の進み具合の読み取り", userA, "get", `userDeletions/${userA.uid}`, { existing: { status: "failed" } }),
  testCase("DENY", "管理者：ブラウザから削除の進み具合を書く", admin, "create", "userDeletions/someoneElse", { data: { status: "completed" } }),
  // 通知の送信記録（notificationLogs）は、通知サーバー（サービスアカウント）だけが書く
  testCase("DENY", "一般：ダービーの通知記録を先に作る", userA, "create", "notificationLogs/derby-2030-01-02", { data: { kind: "derby" } }),
  testCase("DENY", "管理者：ブラウザから通知記録を作る", admin, "create", "notificationLogs/announcement-pr-99", { data: { kind: "announcement" } }),
  testCase("DENY", "一般：通知記録の読み取り", userA, "get", "notificationLogs/derby-2030-01-01", { existing: { kind: "derby" } }),
  // 友達関係の解除（friends の削除）は当事者だけ。作成・更新は今まで通り
  testCase("ALLOW", "friends：当事者が友達関係を解除", userA, "delete", "friends/alice_bob", { existing: { user1: "alice", user2: "bob", user1Uid: userA.uid, user2Uid: "someoneElse" } }),
  testCase("DENY", "friends：当事者でない人が友達関係を解除", userA, "delete", "friends/bob_carol", { existing: { user1: "bob", user2: "carol", user1Uid: "someoneElse", user2Uid: "anotherOne" } }),
  testCase("ALLOW", "friends：最新メッセージ・既読の更新（今まで通り）", userA, "update", "friends/bob_carol", { data: { user1: "bob", user2: "carol", lastMessagePreview: "x" }, existing: { user1: "bob", user2: "carol" } })
];

async function runProductionEngineTests(api, projectId, source) {
  const result = await api("POST", `projects/${projectId}:test`, {
    source: { files: [{ name: "firestore.rules", content: source }] },
    testSuite: { testCases: TEST_CASES.map((c) => c.tc) }
  });
  const errors = (result.issues || []).filter((i) => i.severity === "ERROR");
  const rows = TEST_CASES.map((c, i) => {
    const r = (result.testResults || [])[i] || {};
    return { label: c.label, expectation: c.tc.expectation, ok: r.state === "SUCCESS", debug: (r.debugMessages || []).join(" ") };
  });
  return { errors, rows, issues: result.issues || [] };
}

function knownRuleVersions() {
  const versions = [{ name: "最初のルール（ログイン済みなら全部読み書き可）", source: INITIAL_RULES }];
  const dir = process.env.KNOWN_RULES_DIR;
  if (dir && fs.existsSync(dir)) {
    for (const file of fs.readdirSync(dir).sort()) versions.push({ name: `リポジトリの過去の版 ${file}`, source: fs.readFileSync(path.join(dir, file), "utf8") });
  }
  return versions;
}

/* 本番を変える前に、必要な権限がそろっているかを確かめる（確かめるだけで何も変えない）。
   存在しない権限名が混ざると全体がエラーになるので、1つずつ調べる */
async function checkPermissions(api, projectId) {
  const status = {};
  for (const permission of [...REQUIRED_PERMISSIONS, ...EXTRA_PERMISSIONS]) {
    try {
      const result = await api("POST", `https://cloudresourcemanager.googleapis.com/v1/projects/${projectId}:testIamPermissions`, { permissions: [permission] });
      status[permission] = (result.permissions || []).includes(permission) ? "あり" : "なし";
    } catch (error) {
      status[permission] = /not valid/i.test(error.message) ? "（権限名として無効）" : `確認できず：${error.message}`;
    }
  }
  const known = REQUIRED_PERMISSIONS.every((p) => status[p] === "あり" || status[p] === "なし");
  return { known, status, missing: REQUIRED_PERMISSIONS.filter((p) => status[p] === "なし") };
}

async function check(api, projectId, credentials) {
  const newSource = fs.readFileSync(RULES_FILE, "utf8");

  out("## Firestore ルール：本番の確認");
  out(`- プロジェクト：${projectId}`);
  out(`- サービスアカウント：${describeServiceAccount(credentials)}`);
  const permissions = await checkPermissions(api, projectId);
  out(`- 権限：${Object.entries(permissions.status).map(([p, v]) => `${p}=${v}`).join(" / ")}`);
  if (!permissions.known) out("- 権限の事前確認：一部を確かめられませんでした。実際の操作で確かめます");
  else if (permissions.missing.length) out(`- 権限の事前確認：**足りない権限があります** → ${permissions.missing.join(", ")}（「Firebase Rules 管理者」roles/firebaserules.admin に含まれます）`);
  else out("- 権限の事前確認：必要な権限はすべてあります");

  const prod = await getProductionRules(api, projectId);
  fs.writeFileSync("production.rules", prod.source.endsWith("\n") ? prod.source : prod.source + "\n");
  out(`- 本番で公開中のルール：\`${prod.release.rulesetName}\`（公開日時 ${prod.release.updateTime || "不明"}）`);

  const same = normalizeRules(prod.source) === normalizeRules(newSource);
  const match = knownRuleVersions().find((v) => normalizeRules(v.source) === normalizeRules(prod.source));
  out(`- 本番のルールは：${same ? "**今回の firestore.rules と同じ（公開済み）**" : match ? `${match.name} と同じ` : "**リポジトリのどの版とも違う（Firebase Console で直接変更された可能性）**"}`);

  const engine = await runProductionEngineTests(api, projectId, newSource);
  const before = await runProductionEngineTests(api, projectId, prod.source);
  out("");
  out("### 本番のルールエンジンでのテスト（本番のデータには触れない）");
  if (engine.errors.length) out(`- **新しいルールにエラー**：${engine.errors.map((e) => e.description).join(" / ")}`);
  out("| 内容 | 期待 | 今回のルール | いまの本番ルール |");
  out("|---|---|---|---|");
  engine.rows.forEach((row, i) => {
    const b = before.rows[i];
    out(`| ${row.label} | ${row.expectation === "ALLOW" ? "許可" : "拒否"} | ${row.ok ? "✅ 期待どおり" : "❌ 違う"} | ${b.ok ? "期待どおり" : "⚠️ 期待と違う"} |`);
  });
  const passed = engine.rows.filter((r) => r.ok).length;
  out("");
  out(`- 今回のルール：${passed} / ${engine.rows.length} 期待どおり`);
  out(`- いまの本番ルール：${before.rows.filter((r) => r.ok).length} / ${before.rows.length} 期待どおり（⚠️ は、いまの本番では防げていない操作）`);
  for (const row of engine.rows.filter((r) => !r.ok)) console.error(`期待と違う: ${row.label} ${row.debug}`);

  const safeToDeploy = !engine.errors.length && passed === engine.rows.length && (same || Boolean(match)) && !permissions.missing.length;
  out(`- 公開してよいか：${safeToDeploy ? (same ? "公開済み（変更なし）" : "**はい**（安全確認がすべて通った）") : "**いいえ**"}`);
  return { safeToDeploy, same, prod, newSource };
}

function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

async function deploy(api, projectId, credentials) {
  const result = await check(api, projectId, credentials);
  if (!result.safeToDeploy) throw new Error("安全確認が通らなかったため、本番のルールは変更していません");
  if (result.same) { out("- 本番はすでに今回のルールなので、何もしませんでした"); return; }

  const previous = result.prod.release.rulesetName;
  setOutput("previous_ruleset", previous);
  const created = await api("POST", `projects/${projectId}/rulesets`, { source: { files: [{ name: "firestore.rules", content: result.newSource }] } });
  await api("PATCH", `projects/${projectId}/releases/cloud.firestore`, { release: { name: `projects/${projectId}/releases/cloud.firestore`, rulesetName: created.name } });

  const after = await getProductionRules(api, projectId);
  if (after.release.rulesetName !== created.name || normalizeRules(after.source) !== normalizeRules(result.newSource)) {
    throw new Error(`公開後の確認に失敗しました（本番：${after.release.rulesetName}）`);
  }
  out("");
  setOutput("deployed_ruleset", created.name);
  out("### 公開しました");
  out(`- 新しいルール：\`${created.name}\``);
  out(`- 公開前のルール（戻すときはこれを ROLLBACK_RULESET に指定）：\`${previous}\``);
}

async function rollback(api, projectId) {
  const target = (process.env.ROLLBACK_RULESET || "").trim();
  if (!/^projects\/[^/]+\/rulesets\/[\w-]+$/.test(target) || !target.startsWith(`projects/${projectId}/`)) {
    throw new Error("ROLLBACK_RULESET に projects/<プロジェクト>/rulesets/<ID> の形で戻す先を指定してください");
  }
  await api("GET", target);
  const before = await getProductionRules(api, projectId);
  await api("PATCH", `projects/${projectId}/releases/cloud.firestore`, { release: { name: `projects/${projectId}/releases/cloud.firestore`, rulesetName: target } });
  const after = await getProductionRules(api, projectId);
  if (after.release.rulesetName !== target) throw new Error("戻した後の確認に失敗しました");
  out("## Firestore ルール：元に戻しました");
  out(`- 戻す前：\`${before.release.rulesetName}\``);
  out(`- いま：\`${target}\``);
}

const mode = process.argv[2] || "check";
try {
  const credentials = loadServiceAccount();
  const api = await createApi(credentials);
  if (mode === "check") {
    const { safeToDeploy } = await check(api, credentials.project_id, credentials);
    writeSummary();
    if (!safeToDeploy) process.exit(1);
  } else if (mode === "deploy") {
    await deploy(api, credentials.project_id, credentials);
    writeSummary();
  } else if (mode === "rollback") {
    await rollback(api, credentials.project_id);
    writeSummary();
  } else {
    throw new Error(`不明なモード：${mode}`);
  }
} catch (error) {
  out(`- **エラー**：${error.message}`);
  writeSummary();
  console.error(error);
  process.exit(1);
}
