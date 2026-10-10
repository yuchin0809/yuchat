/* =========================================================
   ゆうChat 通知サーバー（Cloudflare Workers）

   アプリでメッセージを送ったあと、送信者の端末がここに
     POST /notify   Authorization: Bearer <Firebase の ID トークン>
                    { "messageId": "<messages のドキュメントID>" }
   を送る。Worker は
     1. ID トークンを検証して送信者の uid を確かめる（なりすまし防止）
     2. messages/{messageId} を読み、送信者本人のメッセージか確かめる
     3. 受信者を決める（友達チャット：friends の相手／グループ：送信者以外のメンバー）
     4. notificationLogs/{messageId} を「まだ無いときだけ」作る（同じメッセージの二重送信防止。書き込みはこの1回だけ）
     5. 受信者の全端末（fcmTokens）へ FCM で送る。無効になったトークンは削除する
   を行う。送信者本人の端末には送らない。

   外部ライブラリを使わない1ファイルなので、Cloudflare の管理画面にそのまま貼り付けて使える。

   管理者専用（👤 ユーザー管理）：
     POST /admin    Authorization: Bearer <管理者の ID トークン>
                    { "action": "listUsers" | "inspectUser" | "setPassword" | "suspend" | "unsuspend" | "deleteUser" | "deleteAuthOnly" | "adjustCoins" | "previewAssets" | "adjustAssets" | "notifyAnnouncement", ... }
   ID トークンの uid が ADMIN_UID のときだけ実行する（それ以外は 403）。パスワードはどこにも保存・記録しない。

   全員への通知（通知を ON にした全端末 = fcmTokens）：
     ・🏇 ゆうダービー開始1分前：Cron Triggers（毎分）で runScheduled が確かめる（アプリを閉じていても届く）
     ・📢 新しいお知らせ：管理者がアプリで作ったときは /admin の notifyAnnouncement、
       自動のお知らせ（GitHub Actions）は同じ sendBroadcastNotification を Actions から呼ぶ
     ・どちらも notificationLogs/{derby-… / announcement-…} を「まだ無いときだけ」作ってから送るので、同じ通知は1回だけ

   設定（Cloudflare の Worker → Settings → Variables and Secrets）：
     FIREBASE_SERVICE_ACCOUNT  （Secret）Firebase のサービスアカウントの鍵 JSON
     FIREBASE_PROJECT_ID       （Text）  yuuchat-be666
     ALLOWED_ORIGINS           （Text）  https://yuchin0809.github.io
     ADMIN_UID                 （Text）  g51wzTvJFsZiYEfre5aDuDckJXY2（省略時もこの値）
========================================================= */

const DEFAULT_PROJECT_ID = "yuuchat-be666";
const DEFAULT_ALLOWED_ORIGINS = "https://yuchin0809.github.io";
const GOOGLE_JWKS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
/* identitytoolkit：👤 ユーザー管理（パスワード設定・停止・削除）で Firebase Authentication を操作するため */
const OAUTH_SCOPES = "https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/firebase.messaging https://www.googleapis.com/auth/identitytoolkit";
/* 管理者（firestore.rules・script.js の ADMIN_UID と同じ）。環境変数 ADMIN_UID で上書きできる */
const DEFAULT_ADMIN_UID = "g51wzTvJFsZiYEfre5aDuDckJXY2";

/* 送信から時間がたったメッセージの通知は送らない */
const MAX_MESSAGE_AGE_MS = 10 * 60 * 1000;
const FIRESTORE_IN_LIMIT = 30;
const NOTIFICATION_TTL_SECONDS = 24 * 60 * 60;

/* =========================================================
   入口
========================================================= */

export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  },
  /* Cron Triggers（wrangler.toml の [triggers]）：毎分、ゆうダービー開始1分前の通知を確かめる */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduled(env, event.scheduledTime).catch((error) => console.error("scheduled error", String(error?.message || error).slice(0, 300))));
  }
};

export async function runScheduled(env = {}, scheduledTime = Date.now(), deps = createDefaultDeps(env)) {
  return notifyDerbyStartingSoon(deps, scheduledTime);
}

export async function handleRequest(request, env = {}, deps = createDefaultDeps(env)) {
  const cors = getCorsHeaders(request, env);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: cors ? 204 : 403, headers: cors || {} });
  }
  if (request.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed" }, 405, cors);
  }

  try {
    /* 1. 送信者の確認 */
    const idToken = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (!idToken) return jsonResponse({ error: "unauthenticated" }, 401, cors);

    let uid;
    try {
      uid = await deps.verifyIdToken(idToken);
    } catch (error) {
      console.warn("invalid id token", String(error.message || error));
      return jsonResponse({ error: "invalid_token" }, 401, cors);
    }

    let body;
    try {
      body = await request.json();
    } catch (error) {
      return jsonResponse({ error: "invalid_json" }, 400, cors);
    }
    /* 管理者専用（👤 ユーザー管理）：管理者の uid 以外はすべて拒否する */
    if (new URL(request.url).pathname.replace(/\/+$/, "") === "/admin") {
      const result = await handleAdminAction(deps, uid, body);
      return jsonResponse(result, result.status || 200, cors);
    }
    /* 💰 ゆう経済・🏇 ゆうダービー：本人の操作（残高・締切・結果・払い戻しはサーバーで確かめる） */
    if (new URL(request.url).pathname.replace(/\/+$/, "") === "/economy") {
      const result = await handleEconomyAction(deps, uid, body);
      return jsonResponse(result, result.status || 200, cors);
    }

    const messageId = typeof body?.messageId === "string" ? body.messageId : "";
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(messageId)) return jsonResponse({ error: "invalid_message_id" }, 400, cors);

    const result = await notifyForMessage(deps, uid, messageId);
    return jsonResponse(result, result.status || 200, cors);
  } catch (error) {
    /* 詳しい内容は Cloudflare のログにだけ残し、呼び出し元には返さない */
    console.error("notify error", error);
    return jsonResponse({ error: "internal_error" }, 500, cors);
  }
}

/* =========================================================
   通知の本体
========================================================= */

export async function notifyForMessage(deps, uid, messageId) {
  const fs = deps.firestore;

  /* 2. メッセージを読み、送信者本人のものか確かめる */
  const message = await fs.get(`messages/${messageId}`);
  if (!message) return { status: 404, error: "message_not_found" };
  if (message.senderUid !== uid) return { status: 403, error: "not_sender" };
  if (message.deleted) return { skipped: "deleted" };

  const createdAt = message.createdAt ? Date.parse(message.createdAt) : NaN;
  if (!Number.isFinite(createdAt) || deps.now() - createdAt > MAX_MESSAGE_AGE_MS) return { skipped: "too_old" };

  /* 3. 受信者を決める（送信者本人は必ず除く） */
  const target = await resolveRecipients(fs, message, uid);
  if (!target) return { status: 403, error: "not_allowed" };
  const recipientUids = [...new Set(target.recipientUids)].filter((id) => id && id !== uid);
  if (recipientUids.length === 0) return { skipped: "no_recipients" };

  /* 4. 同じメッセージの通知は1回だけ（すでに記録があれば送らない） */
  const claimed = await fs.createIfAbsent(`notificationLogs/${messageId}`, {
    messageId,
    senderUid: uid,
    chatType: target.chatType,
    recipientCount: recipientUids.length,
    createdAt: new Date(deps.now())
  });
  if (!claimed) return { skipped: "duplicate" };

  /* 5. 受信者の全端末へ送る */
  const tokens = await getTokensForUids(fs, recipientUids);
  const data = buildNotificationData(messageId, message, target);

  let sent = 0, failed = 0;
  const removed = [];
  await Promise.all(tokens.map(async (token) => {
    const outcome = await deps.sendFcm(token, data);
    if (outcome.ok) { sent++; return; }
    failed++;
    if (outcome.invalidToken) {
      removed.push(token);
      await fs.delete(`fcmTokens/${token}`).catch(() => {});
    }
  }));

  /* 送信結果（端末数・成功・失敗）は Firestore に書き足さず、Cloudflare のログにだけ残す。
     以前は送信後に notificationLogs を更新していたが、メッセージ1件につき書き込みが1回増えるだけで、どこからも読んでいなかった。
     二重送信の防止は 4 の「まだ無いときだけ作る」だけで行っているので、この更新が無くても変わらない */
  console.log("notify sent", JSON.stringify({ messageId, chatType: target.chatType, recipients: recipientUids.length, tokens: tokens.length, sent, failed, removed: removed.length }));

  return { sent, failed, removed: removed.length, recipients: recipientUids.length };
}

/* 友達チャット：friends ドキュメントに送信者の uid が含まれる場合だけ、もう一方へ
   グループ：送信者がメンバーで、その名前が本当に送信者のものである場合だけ、送信者以外のメンバーへ */
export async function resolveRecipients(fs, message, uid) {
  if (message.type === "friend") {
    const ids = [
      message.friendshipId,
      message.sender && message.receiver ? `${message.sender}_${message.receiver}` : null,
      message.sender && message.receiver ? `${message.receiver}_${message.sender}` : null
    ].filter(Boolean);

    for (const id of [...new Set(ids)]) {
      if (!/^[^/]{1,1500}$/.test(id)) continue;
      const friendship = await fs.get(`friends/${id}`);
      if (!friendship) continue;

      let recipientUid = null;
      if (friendship.user1Uid === uid) recipientUid = friendship.user2Uid;
      else if (friendship.user2Uid === uid) recipientUid = friendship.user1Uid;
      else return null;

      return { chatType: "friend", friendshipId: id, recipientUids: recipientUid ? [recipientUid] : [] };
    }
    return null;
  }

  if (message.type === "group" && message.groupId && /^[^/]{1,1500}$/.test(message.groupId)) {
    const group = await fs.get(`groups/${message.groupId}`);
    if (!group) return null;

    const members = Array.isArray(group.members) ? group.members : [];
    if (!message.sender || !members.includes(message.sender)) return null;

    const senderUser = await fs.get(`users/${message.sender}`);
    if (!senderUser || senderUser.uid !== uid) return null;

    const others = members.filter((name) => name && name !== message.sender && !name.includes("/"));
    const users = await fs.batchGet(others.map((name) => `users/${name}`));
    return {
      chatType: "group",
      groupId: message.groupId,
      groupName: group.name || "グループ",
      recipientUids: users.filter(Boolean).map((u) => u.uid).filter(Boolean)
    };
  }

  return null;
}

export function buildNotificationData(messageId, message, target) {
  const sender = truncate(message.sender || "友達", 30);

  if (target.chatType === "group") {
    return {
      kind: "message",
      messageId,
      chatType: "group",
      groupId: target.groupId,
      title: "ゆうChat",
      body: `${truncate(target.groupName, 30)}グループに新しいメッセージがあります`,
      link: `./?open=chat&group=${encodeURIComponent(target.groupId)}`,
      tag: `message-${messageId}`
    };
  }

  return {
    kind: "message",
    messageId,
    chatType: "friend",
    friendshipId: target.friendshipId,
    title: "ゆうChat",
    body: `${sender}さんからメッセージが届きました`,
    link: `./?open=chat&friendship=${encodeURIComponent(target.friendshipId)}`,
    tag: `message-${messageId}`
  };
}

async function getTokensForUids(fs, uids) {
  const tokens = [];
  for (let i = 0; i < uids.length; i += FIRESTORE_IN_LIMIT) {
    const docs = await fs.queryIn("fcmTokens", "uid", uids.slice(i, i + FIRESTORE_IN_LIMIT));
    docs.forEach((d) => tokens.push(d.id));
  }
  return [...new Set(tokens)];
}

/* =========================================================
   全員への通知（🏇 ゆうダービー開始1分前・📢 新しいお知らせ）
   ・送り先は fcmTokens（通知を ON にした端末だけが登録している）。トークンが無ければ何も送らない
   ・notificationLogs/{logId} を「まだ無いときだけ」作ってから送る（何回呼ばれても、同じ通知は1回だけ）
     ログには by: "notify-worker" を付ける。この印の無いログ（ルールで書き込みを止める前にブラウザから作られたものなど）は
     「送った記録」として扱わず、更新時刻を条件にして1回だけ引き継いで送る（引き継げるのは1つの実行だけ）
   ・使えなくなったトークンは消す。1台への送信に失敗しても、ほかの端末への送信は続ける
========================================================= */

const BROADCAST_LOG_BY = "notify-worker";

async function claimBroadcastLog(deps, logId, kind) {
  const fs = deps.firestore;
  const path = `notificationLogs/${logId}`;
  if (await fs.createIfAbsent(path, { kind, by: BROADCAST_LOG_BY, createdAt: new Date(deps.now()) })) return true;
  const existing = await fs.getRaw(path);
  if (!existing) return false;
  if (existing.fields.by?.stringValue === BROADCAST_LOG_BY) return false;
  try {
    await fs.commit([{
      update: { name: fs.docName(path), fields: encodeFields({ kind, by: BROADCAST_LOG_BY, createdAt: new Date(deps.now()) }) },
      currentDocument: { updateTime: existing.updateTime }
    }]);
    return true;
  } catch (error) {
    if (error?.status === 400 || error?.status === 409) return false; // ほかの実行が先に引き継いだ
    throw error;
  }
}

export async function sendBroadcastNotification(deps, logId, data) {
  const fs = deps.firestore;
  const claimed = await claimBroadcastLog(deps, logId, data.kind || "");
  if (!claimed) return { skipped: "duplicate" };

  const tokens = (await fs.query("fcmTokens", [], { select: ["uid"] })).map((d) => d.id);
  let sent = 0, failed = 0, removed = 0;
  await Promise.all(tokens.map(async (token) => {
    try {
      const outcome = await deps.sendFcm(token, data);
      if (outcome.ok) { sent++; return; }
      failed++;
      if (outcome.invalidToken) { removed++; await fs.delete(`fcmTokens/${token}`).catch(() => {}); }
    } catch {
      failed++;
    }
  }));
  await fs.update(`notificationLogs/${logId}`, { tokenCount: tokens.length, sent, failed, removedTokens: removed })
    .catch((error) => console.warn("log update failed", String(error?.message || error).slice(0, 200)));
  return { sent, failed, removed, tokens: tokens.length };
}

/* ----- 🏇 ゆうダービー開始1分前 -----
   開催スケジュール（script.js・derby-runner/run.mjs と同じ）：
     ・毎日 15:02（raceId「YYYY-MM-DD」）
     ・毎日 11:30（raceId「YYYY-MM-DD-1130」。DERBY_TWICE_DAILY_FROM の日から）
     ・管理者が作る手動レース（derbyManualRaces/{raceId} の raceAt。キャンセルされたものは除く）
   毎分の Cron で「開始の1分前（開始 − 60 秒）がこの分に入る」レースを探す（15:02 の回は 15:01、11:30 の回は 11:29 の Cron で通知）。
   Cron の時刻は分の頭（scheduledTime）。少し遅れて動いても、分単位に切り捨ててから判定するので結果は同じ。
   自動開催の回は計算だけで決まるので Firestore は読まない。手動レースだけ、その時間帯を1回問い合わせる */

const MINUTE_MS = 60 * 1000;
const DERBY_DAILY_RACES = [
  { hour: 11, minute: 30, suffix: "-1130", from: "2026-10-07" },
  { hour: 15, minute: 2, suffix: "", from: "" }
];
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

function jstDateText(ms) {
  return new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/* その日（日本時間）の自動開催の回：[{ raceId, raceAt }] */
export function dailyDerbyRaces(dateText) {
  const [y, m, d] = dateText.split("-").map(Number);
  return DERBY_DAILY_RACES
    .filter((r) => !r.from || dateText >= r.from)
    .map((r) => ({ raceId: `${dateText}${r.suffix}`, raceAt: Date.UTC(y, m - 1, d, r.hour, r.minute) - JST_OFFSET_MS }));
}

export function derbyNotificationData(raceId) {
  return {
    kind: "derby",
    raceId,
    title: "🏇 ゆうダービー",
    body: "あと1分でゆうダービーが始まります！",
    link: "./?open=derby",
    tag: `derby-${raceId}`
  };
}

export async function notifyDerbyStartingSoon(deps, now = deps.now()) {
  /* この分（M）に通知するのは、開始時刻が [M + 1分, M + 2分) のレース（開始 − 60 秒が M〜M + 59 秒） */
  const minute = Math.floor(now / MINUTE_MS) * MINUTE_MS;
  const from = minute + MINUTE_MS, to = minute + 2 * MINUTE_MS;
  /* 日付をまたぐ時間帯（23:59 など）も考えて、今日と明日の回を見る */
  const days = [...new Set([jstDateText(from), jstDateText(to)])];
  const due = days.flatMap(dailyDerbyRaces).filter((r) => r.raceAt >= from && r.raceAt < to);

  const manual = await deps.firestore.query("derbyManualRaces", [
    ["raceAt", "GREATER_THAN_OR_EQUAL", new Date(from)],
    ["raceAt", "LESS_THAN", new Date(to)]
  ], { select: ["raceAt", "status"] });
  manual.filter((r) => r.data.status !== "cancelled").forEach((r) => due.push({ raceId: r.id, raceAt: Date.parse(r.data.raceAt) }));

  const results = [];
  for (const race of due) {
    const result = await sendBroadcastNotification(deps, `derby-${race.raceId}`, derbyNotificationData(race.raceId));
    results.push({ raceId: race.raceId, ...result });
  }
  return { checkedAt: now, races: results };
}

/* ----- 📢 新しいお知らせ ----- */

export function announcementNotificationData(id, announcement) {
  return {
    kind: "announcement",
    announcementId: id,
    title: "📢 ゆうChatアップデート",
    body: truncate(announcement?.title || "新しいお知らせがあります", 60),
    link: "./?open=announcements",
    tag: `announcement-${id}`
  };
}

export async function notifyNewAnnouncement(deps, id) {
  const announcement = await deps.firestore.get(`announcements/${id}`);
  if (!announcement) return { status: 404, error: "announcement_not_found" };
  return sendBroadcastNotification(deps, `announcement-${id}`, announcementNotificationData(id, announcement));
}

function truncate(text, max) {
  const chars = [...String(text || "")];
  return chars.length > max ? chars.slice(0, max - 1).join("") + "…" : chars.join("");
}

/* =========================================================
   👤 ユーザー管理（管理者専用）
   ・呼び出し元の ID トークンの uid が ADMIN_UID のときだけ実行する
   ・パスワード：Authentication の「その uid のユーザー」に内部用メールアドレスとパスワードを設定する
     （ユーザーを作り直さない・uid は変わらない・パスワードはどこにも保存・記録しない）
   ・停止：Authentication で無効にし、ログイン状態を取り消す（アプリを開き直すとログアウトされる。開いたままの端末は最大1時間ほど）
     停止の理由などは suspendedUsers/{uid} に記録する（管理者だけが読める）
   ・完全削除：関連データを確かめ、未精算の馬券があれば断る。userDeletions/{uid} に進み具合を記録し、
     Authentication を停止 → Firestore の関連データ → users/{名前} → 最後に Authentication の順に消す
     （途中で失敗しても「Authentication だけ消えて Firestore が残る」ことはない。同じ操作でやり直せる）
   ・操作の記録は adminAuditLogs（パスワードは記録しない）
========================================================= */

const UID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const ADMIN_PASSWORD_MIN_LENGTH = 8;
const ADMIN_PASSWORD_MAX_LENGTH = 128;
const COMMIT_LIMIT = 400;
const USER_LIST_FIELDS = ["uid", "name", "coins", "createdAt", "updatedAt", "lastSeen", "lastLoginBonusDate", "totalBetAmount", "nameChangedFrom"];

export function internalAuthEmail(uid) {
  return `u-${uid}@yuuchat.local`;
}

/* Authentication はメールアドレスを小文字にして保存するので、大文字小文字を区別せずに比べる */
function sameEmail(a, b) {
  return Boolean(a) && Boolean(b) && String(a).toLowerCase() === String(b).toLowerCase();
}

function toMillis(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function summarizeAuthUser(user) {
  if (!user) return null;
  const infos = user.providerUserInfo || [];
  const providers = infos.map((p) => p.providerId);
  const google = infos.find((p) => p.providerId === "google.com");
  return {
    providers,
    anonymous: providers.length === 0,
    hasPassword: providers.includes("password"),
    internalEmail: sameEmail(user.email, internalAuthEmail(user.localId)),
    googleEmail: google?.email || "",
    googleName: google?.displayName || "",
    disabled: Boolean(user.disabled),
    createdAt: toMillis(user.createdAt),
    lastLoginAt: toMillis(user.lastLoginAt),
    lastRefreshAt: user.lastRefreshAt ? (Date.parse(user.lastRefreshAt) || null) : null
  };
}

export async function handleAdminAction(deps, callerUid, body) {
  if (!callerUid || callerUid !== deps.adminUid) return { status: 403, error: "not_admin" };

  const action = typeof body?.action === "string" ? body.action : "";
  const uid = typeof body?.uid === "string" ? body.uid : "";
  if (action !== "listUsers" && action !== "notifyAnnouncement" && !UID_PATTERN.test(uid)) return { status: 400, error: "invalid_uid" };

  try {
    switch (action) {
      case "listUsers": return await adminListUsers(deps);
      case "inspectUser": return await adminInspectUser(deps, uid);
      case "setPassword": return await adminSetPassword(deps, callerUid, uid, body.password);
      case "suspend": return await adminSuspend(deps, callerUid, uid, body.reason);
      case "unsuspend": return await adminUnsuspend(deps, callerUid, uid);
      case "deleteUser": return await adminDeleteUser(deps, callerUid, uid, body.confirmName);
      case "deleteAuthOnly": return await adminDeleteAuthOnly(deps, callerUid, uid);
      case "adjustCoins": return await adminAdjustCoins(deps, callerUid, uid, body);
      case "previewAssets": return await adminPreviewAssets(deps, uid, body);
      case "adjustAssets": return await adminAdjustAssets(deps, callerUid, uid, body);
      case "notifyAnnouncement": return await adminNotifyAnnouncement(deps, body);
      default: return { status: 400, error: "unknown_action" };
    }
  } catch (error) {
    /* エラーの文にはパスワードを含めない（Authentication の呼び出しはエラーコードだけを返す） */
    console.error("admin error", action, String(error?.message || error).slice(0, 300));
    return { status: 500, error: error?.authCode ? `auth_${error.authCode}` : "internal_error" };
  }
}

async function findUserDocsByUid(fs, uid) {
  return fs.query("users", [["uid", "EQUAL", uid]], { select: ["uid"] });
}

async function writeAuditLog(deps, entry) {
  try {
    await deps.firestore.add("adminAuditLogs", { ...entry, at: new Date(deps.now()) });
  } catch (error) {
    console.warn("audit log failed", String(error?.message || error).slice(0, 200));
  }
}

/* ----- 一覧 ----- */

async function adminListUsers(deps) {
  const fs = deps.firestore;
  const [userDocs, authUsers, suspended, deletions] = await Promise.all([
    fs.query("users", [], { select: USER_LIST_FIELDS }),
    deps.authAdmin.listAll(),
    fs.query("suspendedUsers", []),
    fs.query("userDeletions", [])
  ]);

  const authByUid = new Map(authUsers.map((u) => [u.localId, u]));
  const suspendedUids = new Set(suspended.map((d) => d.id));
  const deletionByUid = new Map(deletions.map((d) => [d.id, d.data]));
  const docCountByUid = new Map();
  userDocs.forEach((d) => { if (d.data.uid) docCountByUid.set(d.data.uid, (docCountByUid.get(d.data.uid) || 0) + 1); });

  const users = userDocs.map((d) => {
    const uid = typeof d.data.uid === "string" ? d.data.uid : "";
    return {
      name: d.id,
      uid,
      coins: typeof d.data.coins === "number" ? d.data.coins : null,
      createdAt: d.data.createdAt || null,
      updatedAt: d.data.updatedAt || null,
      lastSeen: d.data.lastSeen || null,
      totalBetAmount: typeof d.data.totalBetAmount === "number" ? d.data.totalBetAmount : null,
      nameChangedFrom: d.data.nameChangedFrom || "",
      sameUidCount: uid ? docCountByUid.get(uid) : 0,
      auth: summarizeAuthUser(authByUid.get(uid)),
      suspended: suspendedUids.has(uid),
      deletion: deletionByUid.get(uid)?.status || null,
      isAdmin: uid === deps.adminUid
    };
  });

  const authOnly = authUsers.filter((u) => !docCountByUid.has(u.localId)).map((u) => ({
    uid: u.localId,
    auth: summarizeAuthUser(u),
    suspended: suspendedUids.has(u.localId),
    deletion: deletionByUid.get(u.localId)?.status || null,
    deletionName: deletionByUid.get(u.localId)?.name || "",
    isAdmin: u.localId === deps.adminUid
  }));

  const pendingDeletions = deletions
    .filter((d) => d.data.status !== "completed")
    .map((d) => ({ uid: d.id, name: d.data.name || "", status: d.data.status || "", failedStep: d.data.failedStep || "", authExists: authByUid.has(d.id) }));

  return { users, authOnly, pendingDeletions };
}

/* ----- 詳細（削除したときに消えるもの・変わるものの確認を含む。何も変更しない） ----- */

async function adminInspectUser(deps, uid) {
  const fs = deps.firestore;
  const [docs, authUser, suspended, record] = await Promise.all([
    findUserDocsByUid(fs, uid),
    deps.authAdmin.lookup(uid),
    fs.get(`suspendedUsers/${uid}`),
    fs.get(`userDeletions/${uid}`)
  ]);
  const name = docs.length === 1 ? docs[0].id : "";
  const plan = await buildDeletionPlan(deps, uid, name);
  const userData = name ? await fs.get(`users/${name}`) : null;

  return {
    uid,
    name: name || record?.name || "",
    userDocNames: docs.map((d) => d.id),
    user: userData ? {
      coins: typeof userData.coins === "number" ? userData.coins : null,
      createdAt: userData.createdAt || null,
      lastSeen: userData.lastSeen || null,
      totalBetAmount: typeof userData.totalBetAmount === "number" ? userData.totalBetAmount : null,
      nameChangedFrom: userData.nameChangedFrom || ""
    } : null,
    auth: summarizeAuthUser(authUser),
    suspended: suspended ? { reason: suspended.reason || "", suspendedAt: suspended.suspendedAt || null } : null,
    deletion: record ? { status: record.status || "", failedStep: record.failedStep || "" } : null,
    isAdmin: uid === deps.adminUid,
    plan: { counts: plan.counts, blockers: plan.blockers, groups: plan.groups.map((g) => ({ name: g.groupName, action: g.action, nextOwner: g.nextOwner || "" })) }
  };
}

/* ----- パスワード設定・再設定（uid はそのまま。ユーザーを作り直さない） ----- */

async function adminSetPassword(deps, callerUid, uid, password) {
  if (typeof password !== "string" || password.length < ADMIN_PASSWORD_MIN_LENGTH || password.length > ADMIN_PASSWORD_MAX_LENGTH) {
    return { status: 400, error: "invalid_password" };
  }
  const fs = deps.firestore;
  const docs = await findUserDocsByUid(fs, uid);
  if (docs.length !== 1) return { status: 409, error: docs.length === 0 ? "user_not_found" : "multiple_user_docs" };
  const record = await fs.get(`userDeletions/${uid}`);
  if (record && record.status !== "completed") return { status: 409, error: "deletion_in_progress" };

  const authUser = await deps.authAdmin.lookup(uid);
  if (!authUser) return { status: 404, error: "auth_user_not_found" };

  /* Google のアカウントのメールアドレス以外の、知らないメールアドレスが設定されていたら上書きしない */
  const email = internalAuthEmail(uid);
  const googleEmails = (authUser.providerUserInfo || []).filter((p) => p.providerId === "google.com").map((p) => p.email);
  if (authUser.email && !sameEmail(authUser.email, email) && !googleEmails.some((e) => sameEmail(e, authUser.email))) {
    return { status: 409, error: "other_email" };
  }

  await deps.authAdmin.update(uid, { email, password });

  const after = summarizeAuthUser(await deps.authAdmin.lookup(uid));
  if (!after?.hasPassword || !after.internalEmail) return { status: 500, error: "verify_failed" };

  await writeAuditLog(deps, { action: "setPassword", targetUid: uid, targetName: docs[0].id, byUid: callerUid, result: "ok" });
  return { ok: true, name: docs[0].id, auth: after };
}

/* ----- 停止・停止の解除 ----- */

async function adminSuspend(deps, callerUid, uid, reason) {
  if (uid === deps.adminUid) return { status: 400, error: "cannot_target_admin" };
  const fs = deps.firestore;
  const authUser = await deps.authAdmin.lookup(uid);
  if (!authUser) return { status: 404, error: "auth_user_not_found" };
  const docs = await findUserDocsByUid(fs, uid);
  const name = docs.length === 1 ? docs[0].id : "";
  const text = typeof reason === "string" ? reason.trim().slice(0, 200) : "";

  await deps.authAdmin.update(uid, { disableUser: true, validSince: String(Math.floor(deps.now() / 1000)) });
  await fs.set(`suspendedUsers/${uid}`, { uid, name, reason: text, suspendedAt: new Date(deps.now()), byUid: callerUid });

  await writeAuditLog(deps, { action: "suspend", targetUid: uid, targetName: name, byUid: callerUid, result: "ok" });
  return { ok: true, name };
}

async function adminUnsuspend(deps, callerUid, uid) {
  if (uid === deps.adminUid) return { status: 400, error: "cannot_target_admin" };
  const fs = deps.firestore;
  const record = await fs.get(`userDeletions/${uid}`);
  if (record && record.status !== "completed") return { status: 409, error: "deletion_in_progress" };
  const authUser = await deps.authAdmin.lookup(uid);
  if (!authUser) return { status: 404, error: "auth_user_not_found" };
  const docs = await findUserDocsByUid(fs, uid);
  const name = docs.length === 1 ? docs[0].id : "";

  await deps.authAdmin.update(uid, { disableUser: false });
  await fs.delete(`suspendedUsers/${uid}`);

  await writeAuditLog(deps, { action: "unsuspend", targetUid: uid, targetName: name, byUid: callerUid, result: "ok" });
  return { ok: true, name };
}

/* ----- 完全削除 ----- */

/* 削除したときに消すもの・変えるものを調べる（何も変更しない）
   name が空のとき（users が無い・すでに消えた）は uid で探せるものだけを調べる
   ・1対1のメッセージ・フレンド関係：削除
   ・グループ：メンバーから外す（管理者なら次のメンバーに引き継ぐ。誰もいなくなるならグループとそのメッセージを削除）
     グループで送ったメッセージは残す
   ・ゆうダービーの馬券：未精算が1件でもあれば削除しない（blockers）。精算済みは削除
   ・ゲームルーム：自分が作ったルームは削除、参加中のルームからは退出。招待・ルーム作成の記録は削除
   ・通知の端末登録・名前変更の記録・総資産ランキングの行・users/{名前}（とその下）：削除 */
export async function buildDeletionPlan(deps, uid, name) {
  const fs = deps.firestore;
  const q = (collection, field, op, value) => fs.query(collection, [[field, op, value]]);
  const byName = Boolean(name);
  const none = Promise.resolve([]);

  const [friends1, friends2, sent, received, groupsByMember, groupsByOwner, bets, tokens,
    roomsByUid, roomsByOwner, roomsByName, invitesFrom, invitesTo, roomOwners, nameChanges, ranking] = await Promise.all([
    byName ? q("friends", "user1", "EQUAL", name) : none,
    byName ? q("friends", "user2", "EQUAL", name) : none,
    byName ? q("messages", "sender", "EQUAL", name) : none,
    byName ? q("messages", "receiver", "EQUAL", name) : none,
    byName ? q("groups", "members", "ARRAY_CONTAINS", name) : none,
    q("groups", "ownerUid", "EQUAL", uid),
    q("raceBets", "uid", "EQUAL", uid),
    q("fcmTokens", "uid", "EQUAL", uid),
    q("gameRooms", "memberUids", "ARRAY_CONTAINS", uid),
    q("gameRooms", "ownerUid", "EQUAL", uid),
    byName ? q("gameRooms", "members", "ARRAY_CONTAINS", name) : none,
    q("gameInvites", "fromUid", "EQUAL", uid),
    q("gameInvites", "toUid", "EQUAL", uid),
    q("gameRoomOwners", "uid", "EQUAL", uid),
    q("adminNameChanges", "uid", "EQUAL", uid),
    byName ? fs.getRaw("rankings/assets") : Promise.resolve(null)
  ]);

  const unique = (lists) => [...new Map(lists.flat().map((d) => [d.path, d])).values()];
  const isFriendMessage = (m) => m.data.type !== "group" && !m.data.groupId;

  /* 1対1：フレンド関係と、そのメッセージ */
  const friendships = unique([friends1, friends2]);
  const byFriendship = await Promise.all(friendships.map((f) => q("messages", "friendshipId", "EQUAL", f.id)));
  const friendMessages = unique([byFriendship.flat(), sent.filter(isFriendMessage), received.filter(isFriendMessage)]).filter(isFriendMessage);
  const groupMessagesKept = sent.filter((m) => !isFriendMessage(m)).length;

  /* グループ */
  const groups = [];
  for (const g of unique([groupsByMember, groupsByOwner])) {
    const members = Array.isArray(g.data.members) ? g.data.members : [];
    const remaining = members.filter((m) => m !== name || !byName);
    const isOwner = g.data.ownerUid ? g.data.ownerUid === uid : (byName && g.data.owner === name);
    const isMember = byName && members.includes(name);
    if (!isOwner && !isMember) continue;
    const base = { path: g.path, id: g.id, groupName: g.data.name || "グループ", updateTime: g.updateTime, remaining };
    if (remaining.length === 0) groups.push({ ...base, action: "delete" });
    else if (isOwner) groups.push({ ...base, action: "transfer", nextOwner: remaining[0] });
    else groups.push({ ...base, action: "leave" });
  }
  const deletedGroupMessages = await Promise.all(groups.filter((g) => g.action === "delete").map((g) => q("messages", "groupId", "EQUAL", g.id)));

  /* ゲームルーム */
  const rooms = [];
  for (const r of unique([roomsByUid, roomsByOwner, roomsByName])) {
    const isOwner = r.data.ownerUid ? r.data.ownerUid === uid : (byName && r.data.owner === name);
    const members = (Array.isArray(r.data.members) ? r.data.members : []).filter((m) => !(byName && m === name));
    const memberUids = (Array.isArray(r.data.memberUids) ? r.data.memberUids : []).filter((id) => id !== uid);
    const base = { path: r.path, id: r.id, updateTime: r.updateTime, members, memberUids };
    rooms.push({ ...base, action: isOwner || members.length === 0 ? "delete" : "leave" });
  }

  /* 馬券：未精算があれば削除しない */
  const unsettledBets = bets.filter((b) => b.data.settled !== true);
  const settledBets = bets.filter((b) => b.data.settled === true);

  const rankingUsers = ranking?.fields?.users?.arrayValue?.values || [];
  const rankingHasUser = byName && rankingUsers.some((v) => v?.mapValue?.fields?.name?.stringValue === name);

  const subtree = byName ? await collectSubtree(fs, `users/${name}`) : [];

  const deletes = {
    friendMessages: friendMessages.map((m) => m.path),
    friends: friendships.map((f) => f.path),
    raceBets: settledBets.map((b) => b.path),
    fcmTokens: tokens.map((t) => t.path),
    gameInvites: unique([invitesFrom, invitesTo]).map((d) => d.path),
    gameRoomOwners: roomOwners.map((d) => d.path),
    adminNameChanges: nameChanges.map((d) => d.path)
  };

  const blockers = [];
  if (uid === deps.adminUid) blockers.push("admin");
  if (unsettledBets.length > 0) blockers.push("unsettled_bets");

  const counts = {
    friends: friendships.length,
    friendMessages: friendMessages.length,
    groupMessagesKept,
    groupsLeave: groups.filter((g) => g.action === "leave").length,
    groupsTransfer: groups.filter((g) => g.action === "transfer").length,
    groupsDelete: groups.filter((g) => g.action === "delete").length,
    deletedGroupMessages: deletedGroupMessages.flat().length,
    raceBetsSettled: settledBets.length,
    raceBetsUnsettled: unsettledBets.length,
    fcmTokens: tokens.length,
    gameRoomsDelete: rooms.filter((r) => r.action === "delete").length,
    gameRoomsLeave: rooms.filter((r) => r.action === "leave").length,
    gameInvites: deletes.gameInvites.length,
    gameRoomOwners: roomOwners.length,
    adminNameChanges: nameChanges.length,
    rankingEntry: rankingHasUser ? 1 : 0,
    userDoc: byName ? 1 : 0,
    userSubDocs: subtree.length
  };

  return { uid, name, deletes, groups, rooms, rankingHasUser, subtree, blockers, counts };
}

/* users/{名前} の下のサブコレクションのドキュメント（深い方から） */
async function collectSubtree(fs, docPath) {
  const out = [];
  for (const collectionId of await fs.listCollectionIds(docPath)) {
    for (const child of await fs.listDocuments(`${docPath}/${collectionId}`)) {
      out.push(...await collectSubtree(fs, child), child);
    }
  }
  return out;
}

function fieldPathSegment(key) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? key : `\`${key.replace(/\\/g, "\\\\").replace(/`/g, "\\`")}\``;
}

async function executeDeletionPlan(deps, plan, setStep) {
  const fs = deps.firestore;
  const del = (path) => ({ delete: fs.docName(path) });
  const commitAll = async (writes) => {
    for (let i = 0; i < writes.length; i += COMMIT_LIMIT) await fs.commit(writes.slice(i, i + COMMIT_LIMIT));
  };
  const updatedNow = [{ fieldPath: "updatedAt", setToServerValue: "REQUEST_TIME" }];

  setStep("friends");
  await commitAll([...plan.deletes.friendMessages, ...plan.deletes.friends].map(del));

  setStep("groups");
  for (const g of plan.groups) {
    if (g.action === "delete") {
      const messages = await fs.query("messages", [["groupId", "EQUAL", g.id]], { select: ["groupId"] });
      await commitAll(messages.map((m) => del(m.path)));
      await fs.commit([{ delete: fs.docName(g.path), currentDocument: { updateTime: g.updateTime } }]);
      continue;
    }
    const fields = { members: g.remaining };
    const fieldPaths = ["members", `lastReadAt.${fieldPathSegment(plan.uid)}`];
    if (g.action === "transfer") {
      const next = await fs.get(`users/${g.nextOwner}`);
      fields.owner = g.nextOwner;
      fields.ownerUid = next?.uid || "";
      fieldPaths.push("owner", "ownerUid");
    }
    await fs.commit([{
      update: { name: fs.docName(g.path), fields: encodeFields(fields) },
      updateMask: { fieldPaths },
      updateTransforms: updatedNow,
      currentDocument: { updateTime: g.updateTime }
    }]);
  }

  setStep("gameRooms");
  for (const r of plan.rooms) {
    if (r.action === "delete") {
      const invites = await fs.query("gameInvites", [["roomId", "EQUAL", r.id]], { select: ["roomId"] });
      await commitAll(invites.map((d) => del(d.path)));
      await fs.commit([{ delete: fs.docName(r.path), currentDocument: { updateTime: r.updateTime } }]);
      continue;
    }
    await fs.commit([{
      update: { name: fs.docName(r.path), fields: encodeFields({ members: r.members, memberUids: r.memberUids, status: "waiting" }) },
      updateMask: { fieldPaths: ["members", "memberUids", "status"] },
      updateTransforms: updatedNow,
      currentDocument: { updateTime: r.updateTime }
    }]);
  }

  setStep("records");
  const { raceBets, fcmTokens, gameInvites, gameRoomOwners, adminNameChanges } = plan.deletes;
  await commitAll([...raceBets, ...fcmTokens, ...gameInvites, ...gameRoomOwners, ...adminNameChanges].map(del));

  if (plan.rankingHasUser) {
    setStep("ranking");
    const ranking = await fs.getRaw("rankings/assets");
    const values = ranking?.fields?.users?.arrayValue?.values || [];
    const kept = values.filter((v) => v?.mapValue?.fields?.name?.stringValue !== plan.name);
    if (ranking && kept.length !== values.length) {
      await fs.commit([{
        update: { name: fs.docName("rankings/assets"), fields: { users: { arrayValue: { values: kept } } } },
        updateMask: { fieldPaths: ["users"] },
        currentDocument: { updateTime: ranking.updateTime }
      }]);
    }
  }

  if (plan.name) {
    setStep("userDoc");
    await commitAll(plan.subtree.map(del));
    /* 名前はすぐ再利用できるので、消す直前にもう一度「この uid のドキュメント」か確かめる */
    const userDoc = await fs.getRaw(`users/${plan.name}`);
    if (userDoc && userDoc.fields?.uid?.stringValue === plan.uid) {
      await fs.commit([{ delete: fs.docName(`users/${plan.name}`), currentDocument: { updateTime: userDoc.updateTime } }]);
    }
  }
}

async function adminDeleteUser(deps, callerUid, uid, confirmName) {
  if (uid === deps.adminUid) return { status: 400, error: "cannot_target_admin" };
  const fs = deps.firestore;
  const [docs, record] = await Promise.all([findUserDocsByUid(fs, uid), fs.get(`userDeletions/${uid}`)]);
  if (docs.length > 1) return { status: 409, error: "multiple_user_docs" };

  /* users が残っていれば、その名前で関連データを探す。
     users がすでに消えている（前回の削除の途中で止まった）ときは、名前で探すものは終わっているので uid で探せるものだけ */
  const name = docs.length === 1 ? docs[0].id : "";
  const resuming = Boolean(record && record.status !== "completed");
  const displayName = name || (resuming ? record.name || "" : "");
  if (!name && !resuming) return { status: 404, error: "user_not_found" };
  if (typeof confirmName !== "string" || !displayName || confirmName !== displayName) return { status: 400, error: "confirm_mismatch" };

  const plan = await buildDeletionPlan(deps, uid, name);
  if (plan.blockers.length > 0) return { status: 409, error: "blocked", blockers: plan.blockers, counts: plan.counts };

  const recordPath = `userDeletions/${uid}`;
  const startedAt = resuming && record.startedAt ? new Date(record.startedAt) : new Date(deps.now());
  const baseRecord = { uid, name: displayName, byUid: callerUid, startedAt, counts: plan.counts };
  await fs.set(recordPath, { ...baseRecord, status: "in_progress", updatedAt: new Date(deps.now()) });

  let step = "auth_disable";
  try {
    const authUser = await deps.authAdmin.lookup(uid);
    if (authUser && !authUser.disabled) {
      await deps.authAdmin.update(uid, { disableUser: true, validSince: String(Math.floor(deps.now() / 1000)) });
    }

    await executeDeletionPlan(deps, plan, (s) => { step = s; });

    step = "auth_delete";
    await deps.authAdmin.delete(uid);
    step = "suspended_record";
    await fs.delete(`suspendedUsers/${uid}`);

    await fs.set(recordPath, { ...baseRecord, status: "completed", updatedAt: new Date(deps.now()), completedAt: new Date(deps.now()) });
    await writeAuditLog(deps, { action: "deleteUser", targetUid: uid, targetName: displayName, byUid: callerUid, result: "ok", counts: plan.counts });
    return { ok: true, name: displayName, counts: plan.counts };
  } catch (error) {
    console.error("delete user failed", step, String(error?.message || error).slice(0, 300));
    await fs.set(recordPath, { ...baseRecord, status: "failed", failedStep: step, updatedAt: new Date(deps.now()) }).catch(() => {});
    await writeAuditLog(deps, { action: "deleteUser", targetUid: uid, targetName: displayName, byUid: callerUid, result: "failed", failedStep: step });
    return { status: 500, error: "delete_failed", step };
  }
}

/* ----- 新しいお知らせの通知（管理者がアプリでお知らせを作った直後に呼ぶ）。同じお知らせは1回だけ ----- */
async function adminNotifyAnnouncement(deps, body) {
  const id = typeof body?.announcementId === "string" ? body.announcementId : "";
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return { status: 400, error: "invalid_announcement_id" };
  const result = await notifyNewAnnouncement(deps, id);
  return result.status ? result : { ok: true, ...result };
}

/* ----- ゆうコインの増減（管理者） -----
   ・users/{名前} の coins だけを書き換える（銀行・株・馬券などには触れない）
   ・読んだときの更新時刻を条件にして書く（その間にアプリや自動処理がコインを変えていたら、読み直してやり直す）
     → 同時に操作されても、増減が失われたり二重になったりしない
   ・操作の記録（adminAuditLogs）は、コインの書き換えと同じ1回の書き込みで作る（どちらか片方だけにはならない）
   ・残高がマイナスになる減らし方はしない */

const ADMIN_COIN_ADJUST_MAX = 1000000;
const ADMIN_COIN_BALANCE_MAX = 1000000000000;
const ADMIN_COIN_RETRY = 8;

function readIntegerField(field) {
  if (!field) return 0;
  if ("integerValue" in field) return Number(field.integerValue);
  if ("doubleValue" in field) return Number(field.doubleValue);
  return NaN;
}

async function adminAdjustCoins(deps, callerUid, uid, body) {
  const direction = body?.direction;
  const amount = body?.amount;
  if (direction !== "increase" && direction !== "decrease") return { status: 400, error: "invalid_direction" };
  if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount <= 0 || amount > ADMIN_COIN_ADJUST_MAX) {
    return { status: 400, error: "invalid_amount" };
  }
  const expected = body?.expectedCoins;
  if (expected !== undefined && (typeof expected !== "number" || !Number.isSafeInteger(expected))) return { status: 400, error: "invalid_expected" };

  const fs = deps.firestore;
  const docs = await findUserDocsByUid(fs, uid);
  if (docs.length !== 1) return { status: 409, error: docs.length === 0 ? "user_not_found" : "multiple_user_docs" };
  const record = await fs.get(`userDeletions/${uid}`);
  if (record && record.status !== "completed") return { status: 409, error: "deletion_in_progress" };
  const name = docs[0].id;
  const callerDocs = await findUserDocsByUid(fs, callerUid);
  const byName = callerDocs.length === 1 ? callerDocs[0].id : "";
  const delta = direction === "increase" ? amount : -amount;

  for (let attempt = 1; attempt <= ADMIN_COIN_RETRY; attempt++) {
    const user = await fs.getRaw(`users/${name}`);
    if (!user || user.fields?.uid?.stringValue !== uid) return { status: 409, error: "user_not_found" };
    const before = readIntegerField(user.fields.coins);
    if (!Number.isSafeInteger(before)) return { status: 409, error: "invalid_balance" };
    if (expected !== undefined && before !== expected) return { status: 409, error: "balance_changed", coins: before };
    const after = before + delta;
    if (after < 0) return { status: 409, error: "insufficient_coins", coins: before };
    if (after > ADMIN_COIN_BALANCE_MAX) return { status: 400, error: "balance_too_large", coins: before };

    const logId = crypto.randomUUID().replace(/-/g, "");
    try {
      await fs.commit([
        {
          update: { name: fs.docName(`users/${name}`), fields: { coins: { integerValue: String(after) } } },
          updateMask: { fieldPaths: ["coins"] },
          currentDocument: { updateTime: user.updateTime }
        },
        {
          update: {
            name: fs.docName(`adminAuditLogs/${logId}`),
            fields: encodeFields({ action: "adjustCoins", targetUid: uid, targetName: name, direction, amount, delta, beforeCoins: before, afterCoins: after, byUid: callerUid, byName, result: "ok" })
          },
          updateTransforms: [{ fieldPath: "at", setToServerValue: "REQUEST_TIME" }],
          currentDocument: { exists: false }
        }
      ]);
      return { ok: true, name, direction, amount, beforeCoins: before, afterCoins: after };
    } catch (error) {
      /* 読んだあとに users が変わっていた（条件が合わない）・ほかの書き込みと重なったときは、少し待ってから読み直す */
      const retryable = [400, 409].includes(error?.status) && /FAILED_PRECONDITION|ABORTED|does not match|contention|ALREADY_EXISTS/i.test(String(error.message));
      if (!retryable) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20 + Math.random() * 60 * attempt));
    }
  }
  return { status: 409, error: "busy" };
}

/* ----- 総資産の増減（管理者。不正に増やされたコインが預金・株に移されていても回収できるようにする） -----
   総資産 = 手持ちコイン + 銀行預金 + 保有株の評価額（株数 × 今の株価）− 借入残高（アプリ・derby-runner と同じ計算）
   ・増やす：銀行預金（bank.deposit）に足す。手持ちコイン・株・借入には触れない
   ・減らす：銀行預金から先に減らし、足りない分は保有株を「評価額の高い銘柄から」回収する。
     回収した株の代金はコインにも預金にも戻さない（売却ではない）。株は1株単位なので、足りない分を超える株数を回収し、
     超えた分（1株の株価より少ない）だけを預金に戻す → 総資産の減少は指定した金額とちょうど同じになる
   ・手持ちコインと借入には触れない（手持ちコインは adjustCoins で別に減らす）。減らしたあとの総資産が 0 より少なくなる減らし方はしない
   ・預金を減らしたら、利息の対象（interestBase）も預金を超えないようにする（引き出しと同じ）。株の取得額（cost）は株数に比例して減らす（売却と同じ）
   ・previewAssets：今の内訳と、その金額で何がどれだけ減るか（書き込まない）。adjustAssets：その内容で実行する
     表示したあとに預金・株・株価が変わっていたら（expected が違う）、何もせずに最新の内訳を返す
   ・users の書き換え・総資産ランキング（rankings/assets）のその人の行と順位の更新・操作の記録（adminAuditLogs）は、
     1回のまとめて書き込み（読んだときの更新時刻が条件）。途中でアプリ・自動処理が書き換えていたら読み直してやり直す
   株の会社と最初の株価は script.js・derby-runner/economy.mjs と同じにすること */

const ASSET_STOCK_INITIAL_PRICES = { YGM: 180, YMT: 240, YFD: 150, YEN: 280, YPY: 210 };
const ADMIN_ASSET_ADJUST_MAX = 10000000;
const ADMIN_ASSET_RETRY = 8;

function assetInt(value) {
  return Math.max(0, Math.floor(Number(value) || 0));
}

function marketPricesOf(market) {
  const prices = {};
  Object.entries(ASSET_STOCK_INITIAL_PRICES).forEach(([code, initial]) => {
    const price = Number(market?.companies?.[code]?.price);
    prices[code] = Number.isFinite(price) && price > 0 ? price : initial;
  });
  return prices;
}

/* users の内容（decode 済み）と株価から、総資産の内訳 */
export function assetBreakdown(data, prices) {
  const bank = data?.bank && typeof data.bank === "object" ? data.bank : {};
  const deposit = assetInt(bank.deposit);
  const loan = assetInt(bank.loan);
  const coins = Number(data?.coins) || 0;
  const stocks = Object.entries(data?.stocks && typeof data.stocks === "object" ? data.stocks : {})
    .map(([code, h]) => {
      const qty = assetInt(h?.qty);
      const price = Number(prices[code]) || 0;
      return { code, qty, cost: Math.max(0, Math.round(Number(h?.cost) || 0)), price, value: qty * price };
    })
    .filter((s) => s.qty > 0)
    .sort((a, b) => (b.value - a.value) || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  const stockValue = stocks.reduce((sum, s) => sum + s.value, 0);
  return { coins, deposit, interestBase: assetInt(bank.interestBase), loan, stocks, stockValue, total: coins + deposit + stockValue - loan };
}

/* 減らす・増やすときに、何がどれだけ変わるか。足りなければ error */
export function planAssetAdjustment(breakdown, direction, amount) {
  if (direction === "increase") {
    const deposit = breakdown.deposit + amount;
    return { direction, amount, fromDeposit: -amount, removed: [], change: 0, after: { deposit, interestBase: breakdown.interestBase, stocks: {} }, totalAfter: breakdown.total + amount };
  }
  const recoverable = breakdown.deposit + breakdown.stocks.filter((s) => s.price > 0).reduce((sum, s) => sum + s.value, 0);
  const max = Math.max(0, Math.min(recoverable, breakdown.total));
  if (amount > max) return { error: "insufficient_assets", max };

  const fromDeposit = Math.min(breakdown.deposit, amount);
  let rest = amount - fromDeposit;
  let change = 0;
  const removed = [];
  const stocksAfter = {};
  for (const s of breakdown.stocks) {
    if (rest <= 0 || s.price <= 0) continue;
    const qty = s.value <= rest ? s.qty : Math.ceil(rest / s.price);
    const value = qty * s.price;
    const costRemoved = Math.round(s.cost * (qty / s.qty));
    removed.push({ code: s.code, qty, price: s.price, value, costRemoved, qtyBefore: s.qty, qtyAfter: s.qty - qty });
    stocksAfter[s.code] = s.qty - qty > 0 ? { qty: s.qty - qty, cost: s.cost - costRemoved } : null;
    if (value > rest) change = value - rest;
    rest = Math.max(0, rest - value);
  }
  if (rest > 0) return { error: "insufficient_assets", max };
  const deposit = breakdown.deposit - fromDeposit + change;
  const interestBase = Math.min(breakdown.interestBase, deposit);
  const totalAfter = breakdown.total - amount;
  return { direction, amount, fromDeposit, removed, change, after: { deposit, interestBase, stocks: stocksAfter }, totalAfter };
}

/* 総資産ランキング（rankings/assets）のその人の行を、ランキングの株価で計算し直して並べ直す（derby-runner の buildAssetRanking と同じ並び） */
export function rerankAssetRanking(rows, name, data, prices) {
  const index = rows.findIndex((r) => r?.name === name);
  if (index < 0) return null;
  const b = assetBreakdown(data, prices);
  const next = rows.map((r, i) => (i === index ? { ...r, coins: b.coins, deposit: b.deposit, stockValue: b.stockValue, loan: b.loan, total: b.total } : { ...r }));
  next.sort((a, c) => ((Number(c.total) || 0) - (Number(a.total) || 0)) || (a.name < c.name ? -1 : a.name > c.name ? 1 : 0));
  let rank = 0, prev = null;
  next.forEach((r, i) => { const t = Number(r.total) || 0; if (t !== prev) { rank = i + 1; prev = t; } r.rank = rank; });
  return { rows: next, before: rows[index], after: next.find((r) => r.name === name) };
}

function sameAssetSnapshot(breakdown, prices, expected) {
  if (!expected || typeof expected !== "object") return true;
  if (expected.deposit !== breakdown.deposit) return false;
  const held = Object.fromEntries(breakdown.stocks.map((s) => [s.code, s.qty]));
  const exp = expected.stocks && typeof expected.stocks === "object" ? expected.stocks : {};
  const codes = new Set([...Object.keys(held), ...Object.keys(exp)]);
  for (const code of codes) if ((held[code] || 0) !== (exp[code] || 0)) return false;
  const expPrices = expected.prices && typeof expected.prices === "object" ? expected.prices : {};
  return breakdown.stocks.every((s) => expPrices[s.code] === s.price);
}

function publicBreakdown(b, prices) {
  return { coins: b.coins, deposit: b.deposit, loan: b.loan, stockValue: b.stockValue, total: b.total, stocks: b.stocks.map(({ code, qty, price, value }) => ({ code, qty, price, value })), prices };
}

function validateAssetRequest(body) {
  const direction = body?.direction;
  const amount = body?.amount;
  if (direction !== "increase" && direction !== "decrease") return { status: 400, error: "invalid_direction" };
  if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount <= 0 || amount > ADMIN_ASSET_ADJUST_MAX) return { status: 400, error: "invalid_amount" };
  return null;
}

async function loadAssetTarget(fs, uid) {
  const docs = await findUserDocsByUid(fs, uid);
  if (docs.length !== 1) return { error: { status: 409, error: docs.length === 0 ? "user_not_found" : "multiple_user_docs" } };
  const record = await fs.get(`userDeletions/${uid}`);
  if (record && record.status !== "completed") return { error: { status: 409, error: "deletion_in_progress" } };
  return { name: docs[0].id };
}

async function readAssetState(fs, uid, name) {
  const [user, market] = await Promise.all([fs.getRaw(`users/${name}`), fs.get("market/current")]);
  if (!user || user.fields?.uid?.stringValue !== uid) return { error: { status: 409, error: "user_not_found" } };
  const data = decodeFields(user.fields);
  if (!Number.isFinite(Number(data.coins))) return { error: { status: 409, error: "invalid_balance" } };
  const prices = marketPricesOf(market);
  return { user, data, prices, breakdown: assetBreakdown(data, prices) };
}

async function adminPreviewAssets(deps, uid, body) {
  const fs = deps.firestore;
  const target = await loadAssetTarget(fs, uid);
  if (target.error) return target.error;
  const state = await readAssetState(fs, uid, target.name);
  if (state.error) return state.error;
  const result = { ok: true, name: target.name, breakdown: publicBreakdown(state.breakdown, state.prices) };
  if (body?.direction !== undefined || body?.amount !== undefined) {
    const invalid = validateAssetRequest(body);
    if (invalid) return invalid;
    const plan = planAssetAdjustment(state.breakdown, body.direction, body.amount);
    if (plan.error) return { status: 409, error: plan.error, max: plan.max, breakdown: result.breakdown };
    result.plan = { direction: plan.direction, amount: plan.amount, fromDeposit: plan.fromDeposit, removed: plan.removed.map(({ code, qty, price, value, qtyBefore, qtyAfter }) => ({ code, qty, price, value, qtyBefore, qtyAfter })), change: plan.change, depositAfter: plan.after.deposit, totalAfter: plan.totalAfter };
  }
  return result;
}

async function adminAdjustAssets(deps, callerUid, uid, body) {
  const invalid = validateAssetRequest(body);
  if (invalid) return invalid;
  const { direction, amount } = body;
  const fs = deps.firestore;
  const target = await loadAssetTarget(fs, uid);
  if (target.error) return target.error;
  const name = target.name;
  const callerDocs = await findUserDocsByUid(fs, callerUid);
  const byName = callerDocs.length === 1 ? callerDocs[0].id : "";

  for (let attempt = 1; attempt <= ADMIN_ASSET_RETRY; attempt++) {
    const [state, ranking] = await Promise.all([readAssetState(fs, uid, name), fs.getRaw("rankings/assets")]);
    if (state.error) return state.error;
    const { user, data, prices, breakdown } = state;
    if (!sameAssetSnapshot(breakdown, prices, body?.expected)) return { status: 409, error: "assets_changed", breakdown: publicBreakdown(breakdown, prices) };
    const plan = planAssetAdjustment(breakdown, direction, amount);
    if (plan.error) return { status: 409, error: plan.error, max: plan.max, breakdown: publicBreakdown(breakdown, prices) };

    /* users：bank.deposit / bank.interestBase と、変わる銘柄の stocks.{code} だけを書く（ほかの項目はそのまま） */
    const userFields = { bank: { mapValue: { fields: { deposit: { integerValue: String(plan.after.deposit) }, interestBase: { integerValue: String(plan.after.interestBase) } } } } };
    const fieldPaths = ["bank.deposit", "bank.interestBase"];
    const stockFields = {};
    Object.entries(plan.after.stocks).forEach(([code, holding]) => {
      fieldPaths.push(`stocks.${code}`);
      if (holding) stockFields[code] = { mapValue: { fields: { qty: { integerValue: String(holding.qty) }, cost: { integerValue: String(holding.cost) } } } };
    });
    if (Object.keys(stockFields).length) userFields.stocks = { mapValue: { fields: stockFields } };

    /* 変更後の users の内容（ランキングの計算用） */
    const afterData = structuredClone(data);
    afterData.bank = { ...(afterData.bank || {}), deposit: plan.after.deposit, interestBase: plan.after.interestBase };
    afterData.stocks = { ...(afterData.stocks || {}) };
    Object.entries(plan.after.stocks).forEach(([code, holding]) => { if (holding) afterData.stocks[code] = holding; else delete afterData.stocks[code]; });
    const afterBreakdown = assetBreakdown(afterData, prices);

    const writes = [{
      update: { name: fs.docName(`users/${name}`), fields: userFields },
      updateMask: { fieldPaths },
      currentDocument: { updateTime: user.updateTime }
    }];

    let rankingResult = null;
    if (ranking) {
      const rows = decodeValue(ranking.fields?.users) || [];
      const rankingPrices = ranking.fields?.prices ? decodeValue(ranking.fields.prices) : null;
      const reranked = Array.isArray(rows) ? rerankAssetRanking(rows, name, afterData, rankingPrices && Object.keys(rankingPrices).length ? rankingPrices : prices) : null;
      if (reranked) {
        rankingResult = { rankBefore: reranked.before.rank ?? null, rankAfter: reranked.after.rank, totalBefore: reranked.before.total ?? null, totalAfter: reranked.after.total };
        writes.push({
          update: { name: fs.docName("rankings/assets"), fields: { users: encodeValue(reranked.rows) } },
          updateMask: { fieldPaths: ["users"] },
          currentDocument: { updateTime: ranking.updateTime }
        });
      }
    }

    const summary = (b) => ({ coins: b.coins, deposit: b.deposit, stockValue: b.stockValue, loan: b.loan, total: b.total });
    const logId = crypto.randomUUID().replace(/-/g, "");
    writes.push({
      update: {
        name: fs.docName(`adminAuditLogs/${logId}`),
        fields: encodeFields({
          action: "adjustAssets", targetUid: uid, targetName: name, direction, amount,
          delta: direction === "increase" ? amount : -amount,
          before: summary(breakdown), after: summary(afterBreakdown),
          beforeTotal: breakdown.total, afterTotal: afterBreakdown.total,
          fromDeposit: plan.fromDeposit, changeToDeposit: plan.change,
          removedStocks: plan.removed.map(({ code, qty, price, value, costRemoved, qtyBefore, qtyAfter }) => ({ code, qty, price, value, costRemoved, qtyBefore, qtyAfter })),
          prices, ranking: rankingResult || { updated: false },
          byUid: callerUid, byName, result: "ok"
        })
      },
      updateTransforms: [{ fieldPath: "at", setToServerValue: "REQUEST_TIME" }],
      currentDocument: { exists: false }
    });

    try {
      await fs.commit(writes);
      return {
        ok: true, name, direction, amount,
        beforeTotal: breakdown.total, afterTotal: afterBreakdown.total,
        fromDeposit: plan.fromDeposit, change: plan.change,
        removed: plan.removed.map(({ code, qty, price, value }) => ({ code, qty, price, value })),
        breakdown: publicBreakdown(afterBreakdown, prices),
        ranking: rankingResult
      };
    } catch (error) {
      const retryable = [400, 409].includes(error?.status) && /FAILED_PRECONDITION|ABORTED|does not match|contention|ALREADY_EXISTS/i.test(String(error.message));
      if (!retryable) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20 + Math.random() * 60 * attempt));
    }
  }
  return { status: 409, error: "busy" };
}

/* =========================================================
   💰 ゆう経済・🏇 ゆうダービー（本人の操作をサーバーで検証して行う）

   POST /economy   Authorization: Bearer <Firebase の ID トークン>
                   { "action": "...", "username": "<自分の名前（省略可）>", ... }
   ID トークンの uid の users/{名前} だけを書き換える（他人のデータは書き換えない）。
   残高・株価・締切・オッズ・レース結果・払い戻し額は、ここ（サーバー）で計算・確認する（ブラウザから送られた値は使わない）。

     bankDeposit / bankWithdraw { amount }   預け入れ・引き出し
     bankBorrow / bankRepay                  緊急融資・返済
     stockTrade { code, side, qty }          株の売買（株価は market/current）
     loginBonus                              ログインボーナス（日本時間で1日1回）
     bonus500                                追加ボーナス（1人1回）
     placeBet { raceId, type, horses, amount }  馬券の購入（受付中のレース・締切前だけ）
     ensureRaceResult { raceId }             発走時刻を過ぎたレースの結果を作る（まだ無ければ）
     settleMyBets { raceId }                 結果の出たレースの、自分の未精算の馬券を精算する

   users の書き換えは、読んだときの更新時刻を条件にしたまとめて書き込み（途中で書き換えられていたら読み直してやり直す）。
   設定（コインの額・銀行・株・レースの時刻・オッズ）は script.js・derby-odds.js・derby-runner と同じにすること
========================================================= */

const ECON_START_COINS = 1000;
const ECON_BONUS_COINS = 500;
const ECON_LOGIN_BONUS_COINS = 50;
const ECON_LOAN_AMOUNT = 500;
const ECON_LOAN_MAX_COINS = 100;
const ECON_LOAN_DAYS = 7;
const ECON_MAX_TRADE_QTY = 100000;
const ECON_MAX_AMOUNT = 100000000;
const ECON_BET_MIN = 10;
const ECON_RETRY = 8;
const DAY_MS = 24 * 3600 * 1000;

/* レースの時刻（script.js・derby-runner と同じ） */
/* 本番の開催時刻（script.js・derby-runner と同じ）。テストのときだけ env で上書きできる（本番は env を設定しないので常にこの値） */
let DERBY_RACE_HOUR = 15;
let DERBY_RACE_MINUTE = 2;
let DERBY_MORNING_HOUR = 11;
let DERBY_MORNING_MINUTE = 30;
const DERBY_MORNING_SUFFIX = "-1130";
const DERBY_TWICE_DAILY_FROM = "2026-10-07";
let DERBY_CLOSE_MINUTES_BEFORE = 10;

/* テスト用の開催時刻の上書き（本番の env には無い）。DERBY_RACE_HM="15:2" / DERBY_MORNING_HM="11:30" / DERBY_CLOSE_MIN="0" */
export function applyDerbyTimeOverrides(env = {}) {
  const hm = (v) => { const m = /^(\d{1,2}):(\d{1,2})$/.exec(String(v || "")); return m ? [Number(m[1]), Number(m[2])] : null; };
  const race = hm(env.DERBY_RACE_HM); if (race) { DERBY_RACE_HOUR = race[0]; DERBY_RACE_MINUTE = race[1]; }
  const morning = hm(env.DERBY_MORNING_HM); if (morning) { DERBY_MORNING_HOUR = morning[0]; DERBY_MORNING_MINUTE = morning[1]; }
  if (env.DERBY_CLOSE_MIN !== undefined && env.DERBY_CLOSE_MIN !== "") DERBY_CLOSE_MINUTES_BEFORE = Number(env.DERBY_CLOSE_MIN);
}
const DERBY_AUTO_RACE_ID = /^(\d{4}-\d{2}-\d{2})(-1130)?$/;
const DERBY_MANUAL_RACE_ID = /^\d{4}-\d{2}-\d{2}-m\d{4}$/;
/* レース結果を作ってよいのはサーバー（GitHub Actions の derby-runner と、この Worker）だけ */
const DERBY_SERVER_GENERATORS = ["github-actions", "worker"];
/* この日（レースIDの日付）以降のレースは、サーバーが作った結果だけを使う（それ以前のブラウザが作った結果はそのまま）。
   null のあいだは確かめない（Firestore Rules でブラウザからの書き込みを止めるときに日付を入れる） */
const DERBY_SERVER_RESULTS_FROM = null;

const ECONOMY_ACTIONS = ["bankDeposit", "bankWithdraw", "bankBorrow", "bankRepay", "stockTrade", "loginBonus", "bonus500", "placeBet", "ensureRaceResult", "settleMyBets", "startingCoins", "renameCarry"];
const ECON_CARRY_FIELDS = ["coins", "bonus500Granted", "bonus500GrantedAt", "totalBetAmount", "bank", "stocks", "lastLoginBonusDate", "lastAnnouncementReadAt"];

export function jstDateString(ms) {
  return new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 10);
}

function jstTimeMs(dayId, hour, minute) {
  const [y, m, d] = dayId.split("-").map(Number);
  return Date.UTC(y, m - 1, d, hour, minute, 0, 0) - JST_OFFSET_MS;
}

/* 自動開催の回の発走時刻（ミリ秒）。自動開催の raceId でなければ null */
export function autoRaceTimeMs(raceId) {
  const m = DERBY_AUTO_RACE_ID.exec(String(raceId || ""));
  if (!m) return null;
  if (m[2]) return m[1] >= DERBY_TWICE_DAILY_FROM ? jstTimeMs(m[1], DERBY_MORNING_HOUR, DERBY_MORNING_MINUTE) : null;
  return jstTimeMs(m[1], DERBY_RACE_HOUR, DERBY_RACE_MINUTE);
}

/* いま投票を受け付けている自動開催の回（締切前のいちばん早い回。script.js の getOpenBettingRaceContexts と同じ） */
export function nextAutoRaceId(nowMs) {
  const candidates = [];
  for (const offset of [-1, 0, 1, 2]) {
    const dayId = jstDateString(nowMs + offset * DAY_MS);
    if (dayId >= DERBY_TWICE_DAILY_FROM) candidates.push(`${dayId}${DERBY_MORNING_SUFFIX}`);
    candidates.push(dayId);
  }
  return candidates
    .map((id) => ({ id, closeMs: autoRaceTimeMs(id) - DERBY_CLOSE_MINUTES_BEFORE * 60000 }))
    .filter((c) => nowMs < c.closeMs)
    .sort((a, b) => a.closeMs - b.closeMs)[0]?.id || null;
}

function tsMillis(v) {
  if (v === null || v === undefined) return NaN;
  if (typeof v === "number") return v;
  return Date.parse(v);
}

/* レースの予定（発走・締切・受付開始）。手動レースは derbyManualRaces/{raceId} を読む。見つからなければ null */
async function loadRaceSchedule(fs, raceId) {
  const auto = autoRaceTimeMs(raceId);
  if (auto !== null) return { raceId, manual: false, raceMs: auto, closeMs: auto - DERBY_CLOSE_MINUTES_BEFORE * 60000 };
  if (!DERBY_MANUAL_RACE_ID.test(String(raceId || ""))) return null;
  const raw = await fs.getRaw(`derbyManualRaces/${raceId}`);
  if (!raw) return null;
  const data = decodeFields(raw.fields);
  return {
    raceId, manual: true, raw, cancelled: data.status === "cancelled",
    raceMs: tsMillis(data.raceAt), closeMs: tsMillis(data.closeAt), openMs: tsMillis(data.openAt), betCount: Number(data.betCount) || 0
  };
}

/* ---------- 固定オッズ（derby-odds.js の oddsVersion 1 と同じ計算。変更禁止） ---------- */

const DERBY_FIXED_ODDS_FROM = "2026-10-09";
const DERBY_BET_TYPES = ["win", "place", "quinella", "trio", "trifecta"];
const DERBY_BET_COUNT = { win: 1, place: 1, quinella: 2, trio: 3, trifecta: 3 };
const DERBY_FIXED_PAYOUT_RULE = "fixed-v1";
const DERBY_V1 = Object.freeze({
  horses: Object.freeze([
    { number: 1, power: 6, fan: 0.5 }, { number: 2, power: 7, fan: 0.4 }, { number: 3, power: 8, fan: 0.5 },
    { number: 4, power: 5, fan: 0.3 }, { number: 5, power: 9, fan: 0.8 }, { number: 6, power: 4, fan: 0.5 },
    { number: 7, power: 6, fan: 0.4 }, { number: 8, power: 3, fan: 0.6 }, { number: 9, power: 7, fan: 1.0 },
    { number: 10, power: 8, fan: 0.6 }
  ].map(Object.freeze)),
  returnRate: 0.8, condMin: 0.75, condRange: 0.55, popShade: 0.05, minTenths: 11,
  capTenths: Object.freeze({ win: 999, place: 999, quinella: 4999, trio: 4999, trifecta: 9999 })
});

function derbyHash32(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function derbySeededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function isFixedOddsRaceId(raceId) {
  return String(raceId || "").slice(0, 10) >= DERBY_FIXED_ODDS_FROM;
}

export function derbyRaceParams(raceId) {
  if (!isFixedOddsRaceId(raceId)) return null;
  const random = derbySeededRandom(derbyHash32(`v1:${raceId}`));
  const cond = DERBY_V1.horses.map(() => Math.round((DERBY_V1.condMin + DERBY_V1.condRange * random()) * 100) / 100);
  const strength = DERBY_V1.horses.map((h, i) => h.power * cond[i]);
  const maxStrength = Math.max(...strength);
  const popScore = DERBY_V1.horses.map((h, i) => 0.6 * strength[i] / maxStrength + 0.3 * h.fan + 0.1 * random());
  const order = DERBY_V1.horses.map((_, i) => i).sort((a, b) => popScore[b] - popScore[a] || a - b);
  const popRank = new Array(DERBY_V1.horses.length);
  order.forEach((i, k) => { popRank[i] = k + 1; });
  return { oddsVersion: 1, cond, popRank };
}

function derbyToTenths(probability, shade, type) {
  let tenths = Math.floor(DERBY_V1.returnRate * shade / probability * 10);
  if (tenths > DERBY_V1.capTenths[type]) tenths = DERBY_V1.capTenths[type];
  if (tenths < DERBY_V1.minTenths) tenths = DERBY_V1.minTenths;
  return tenths;
}

const derbyTableCache = new Map();

export function derbyOddsTable(raceId) {
  const params = derbyRaceParams(raceId);
  if (!params) return null;
  if (derbyTableCache.has(raceId)) return derbyTableCache.get(raceId);
  const horses = DERBY_V1.horses;
  const n = horses.length;
  const strength = horses.map((h, i) => h.power * params.cond[i]);
  let total = 0;
  for (let i = 0; i < n; i++) total += strength[i];
  const shade = params.popRank.map((rank) => 1 - DERBY_V1.popShade * (n - rank) / (n - 1));
  const table = { oddsVersion: 1, win: {}, place: {}, quinella: {}, trio: {}, trifecta: {} };
  const placeP = new Array(n).fill(0);
  const quinellaP = {};
  const trioP = {};
  for (let a = 0; a < n; a++) {
    for (let b = 0; b < n; b++) {
      if (b === a) continue;
      for (let c = 0; c < n; c++) {
        if (c === a || c === b) continue;
        const p = (strength[a] / total) * (strength[b] / (total - strength[a])) * (strength[c] / (total - strength[a] - strength[b]));
        table.trifecta[`${horses[a].number}-${horses[b].number}-${horses[c].number}`] = derbyToTenths(p, (shade[a] + shade[b] + shade[c]) / 3, "trifecta");
        placeP[a] += p; placeP[b] += p; placeP[c] += p;
        const [q1, q2] = a < b ? [a, b] : [b, a];
        const qKey = `${horses[q1].number}-${horses[q2].number}`;
        quinellaP[qKey] = (quinellaP[qKey] || 0) + p;
        const [t1, t2, t3] = [a, b, c].sort((x, y) => x - y);
        const tKey = `${horses[t1].number}-${horses[t2].number}-${horses[t3].number}`;
        trioP[tKey] = (trioP[tKey] || 0) + p;
      }
    }
  }
  for (let i = 0; i < n; i++) {
    table.win[horses[i].number] = derbyToTenths(strength[i] / total, shade[i], "win");
    table.place[horses[i].number] = derbyToTenths(placeP[i], shade[i], "place");
  }
  const indexOf = (num) => horses.findIndex((h) => h.number === num);
  for (const [key, p] of Object.entries(quinellaP)) {
    const [x, y] = key.split("-").map(Number).map(indexOf);
    table.quinella[key] = derbyToTenths(p, (shade[x] + shade[y]) / 2, "quinella");
  }
  for (const [key, p] of Object.entries(trioP)) {
    const [x, y, z] = key.split("-").map(Number).map(indexOf);
    table.trio[key] = derbyToTenths(p, (shade[x] + shade[y] + shade[z]) / 3, "trio");
  }
  if (derbyTableCache.size > 50) derbyTableCache.clear();
  derbyTableCache.set(raceId, table);
  return table;
}

export function derbyTicketOddsTenths(table, type, horses) {
  if (!table || !Array.isArray(horses)) return null;
  const h = horses.map(Number);
  if (type === "win" || type === "place") return h.length === 1 ? table[type][h[0]] ?? null : null;
  if (type === "quinella") return h.length === 2 ? table.quinella[[...h].sort((x, y) => x - y).join("-")] ?? null : null;
  if (type === "trio") return h.length === 3 ? table.trio[[...h].sort((x, y) => x - y).join("-")] ?? null : null;
  if (type === "trifecta") return h.length === 3 ? table.trifecta[h.join("-")] ?? null : null;
  return null;
}

export function derbyFixedPayout(amount, oddsTenths) {
  const a = Math.floor(Number(amount) || 0);
  const t = Math.floor(Number(oddsTenths) || 0);
  if (a <= 0 || t <= 0) return 0;
  return Math.floor((a * t) / 10);
}

export function derbyRaceOddsRecord(raceId) {
  const params = derbyRaceParams(raceId);
  if (!params) return {};
  const table = derbyOddsTable(raceId);
  const numbers = DERBY_V1.horses.map((h) => h.number);
  return { oddsVersion: 1, oddsCond: params.cond, oddsPopRank: params.popRank, oddsWinTenths: numbers.map((n) => table.win[n]), oddsPlaceTenths: numbers.map((n) => table.place[n]) };
}

export function derbyRaceOrder(raceId, random = Math.random) {
  const params = derbyRaceParams(raceId);
  if (!params) return null;
  const keyed = DERBY_V1.horses.map((h, i) => ({ number: h.number, key: Math.pow(random(), 1 / (h.power * params.cond[i])) }));
  keyed.sort((a, b) => b.key - a.key);
  return keyed.map((h) => h.number);
}

/* 的中判定（script.js・derby-runner と同じ） */
export function derbyBetWins(bet, order) {
  const [top1, top2, top3] = order;
  const top3set = [top1, top2, top3];
  const horses = bet.horses || [];
  if (bet.type === "win") return horses[0] === top1;
  if (bet.type === "place") return top3set.includes(horses[0]);
  if (bet.type === "quinella") {
    if (horses.length !== 2) return false;
    const a = [...horses].sort((x, y) => x - y), b = [top1, top2].sort((x, y) => x - y);
    return a[0] === b[0] && a[1] === b[1];
  }
  if (bet.type === "trio") {
    if (horses.length !== 3) return false;
    const a = [...horses].sort((x, y) => x - y), b = [...top3set].sort((x, y) => x - y);
    return a.every((n, i) => n === b[i]);
  }
  if (bet.type === "trifecta") return horses.length === 3 && horses[0] === top1 && horses[1] === top2 && horses[2] === top3;
  return false;
}

/* 馬券の中身が正しいか（券種・馬の数・馬番号・重複・金額） */
export function validBetShape(type, horses, amount) {
  if (!DERBY_BET_TYPES.includes(type)) return "invalid_bet_type";
  if (!Array.isArray(horses) || horses.length !== DERBY_BET_COUNT[type]) return "invalid_horses";
  if (!horses.every((h) => Number.isInteger(h) && h >= 1 && h <= 10) || new Set(horses).size !== horses.length) return "invalid_horses";
  if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < ECON_BET_MIN || amount > ECON_MAX_AMOUNT) return "invalid_amount";
  return null;
}

/* ---------- レースの演出用データ（derby-runner の buildRaceCheckpoints・buildFinishStats と同じ） ---------- */

const DERBY_SEGMENTS = 48;
const DERBY_STYLES = { 1: "start", 2: "front", 3: "mid", 4: "closer", 5: "stamina", 6: "front", 7: "stamina", 8: "longshot", 9: "front", 10: "closer" };

function derbyStyleMultiplier(style, frac, random) {
  switch (style) {
    case "start": return frac < 0.3 ? 1.5 : (frac < 0.7 ? 1.0 : 0.7);
    case "front": return frac < 0.5 ? 1.25 : 0.9;
    case "mid": return frac < 0.3 ? 0.8 : (frac < 0.75 ? 1.2 : 1.1);
    case "closer": return frac < 0.6 ? 0.65 : 1.6;
    case "stamina": return 1.0;
    case "longshot": return 0.5 + random() * 1.3;
    default: return 1.0;
  }
}

export function derbyCheckpoints(order, random = Math.random) {
  const numbers = Object.keys(DERBY_STYLES).map(Number);
  const gapStep = 0.015 + random() * 0.025;
  const finalProgress = {};
  order.forEach((n, rank) => { finalProgress[n] = Math.max(0.7, 1 - rank * gapStep); });
  finalProgress[order[0]] = 1;
  const weights = {};
  numbers.forEach((n) => { weights[n] = Array.from({ length: DERBY_SEGMENTS }, (_, s) => derbyStyleMultiplier(DERBY_STYLES[n], s / DERBY_SEGMENTS, random) * (0.3 + random())); });
  numbers.forEach((n) => { const total = weights[n].reduce((a, b) => a + b, 0); const scale = finalProgress[n] / total; weights[n] = weights[n].map((w) => w * scale); });
  const cumulative = Object.fromEntries(numbers.map((n) => [n, 0]));
  const frames = [];
  for (let s = 0; s < DERBY_SEGMENTS; s++) {
    const frame = {};
    numbers.forEach((n) => { cumulative[n] += weights[n][s]; frame[n] = Math.min(1, Number(cumulative[n].toFixed(4))); });
    frames.push(frame);
  }
  return frames;
}

function derbyTimeText(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  return `${m}:${(totalSeconds - m * 60).toFixed(1).padStart(4, "0")}`;
}

function derbyMargin(gap) {
  if (gap < 0.05) return "ハナ";
  if (gap < 0.12) return "アタマ";
  if (gap < 0.2) return "クビ";
  if (gap < 0.35) return "1/2馬身";
  if (gap < 0.55) return "3/4馬身";
  if (gap < 0.8) return "1馬身";
  if (gap < 1.2) return "1馬身1/2";
  if (gap < 1.8) return "2馬身";
  return `${Math.round(gap / 0.8)}馬身`;
}

export function derbyFinishStats(order, random = Math.random) {
  let seconds = 116 + random() * 10;
  const stats = [{ number: order[0], seconds, gap: 0 }];
  for (let i = 1; i < order.length; i++) { const gap = 0.05 + random() * 0.55; seconds += gap; stats.push({ number: order[i], seconds, gap }); }
  return stats.map((s, i) => ({ number: s.number, timeText: derbyTimeText(s.seconds), marginText: i === 0 ? "" : derbyMargin(s.gap) }));
}

/* サーバーが作った結果か（DERBY_SERVER_RESULTS_FROM 以降のレースだけ確かめる） */
export function isTrustedRaceResult(raceId, race, serverResultsFrom = DERBY_SERVER_RESULTS_FROM) {
  if (!race || !Array.isArray(race.resultOrder) || race.resultOrder.length !== 10) return false;
  if (!serverResultsFrom || String(raceId).slice(0, 10) < serverResultsFrom) return true;
  return DERBY_SERVER_GENERATORS.includes(race.generatedBy);
}

/* ---------- users の読み書き ---------- */

function econError(status, error, extra = {}) {
  return { status, error, ...extra };
}

async function loadMyUser(fs, uid, preferredName) {
  if (typeof preferredName === "string" && preferredName && preferredName.length <= 100 && !preferredName.includes("/")) {
    const raw = await fs.getRaw(`users/${preferredName}`);
    if (raw && raw.fields?.uid?.stringValue === uid) return { name: preferredName, raw };
  }
  const docs = await findUserDocsByUid(fs, uid);
  if (docs.length !== 1) return { error: econError(409, docs.length === 0 ? "NO_USER" : "multiple_user_docs") };
  const raw = await fs.getRaw(`users/${docs[0].id}`);
  if (!raw || raw.fields?.uid?.stringValue !== uid) return { error: econError(409, "NO_USER") };
  return { name: docs[0].id, raw };
}

const restInt = (n) => ({ integerValue: String(n) });
const restTime = (ms) => ({ timestampValue: new Date(ms).toISOString() });
const restNull = () => ({ nullValue: null });

/* bank の map を、今の値（型を保ったまま）に変更を重ねて作る */
function bankWith(rawFields, changes) {
  const fields = structuredClone(rawFields?.bank?.mapValue?.fields || {});
  Object.entries(changes).forEach(([k, v]) => { fields[k] = v; });
  return { mapValue: { fields } };
}

function econBank(data) {
  const b = data?.bank && typeof data.bank === "object" ? data.bank : {};
  const int = (v) => Math.max(0, Math.floor(Number(v) || 0));
  return { deposit: int(b.deposit), interestBase: int(b.interestBase), loan: int(b.loan) };
}

function isRetryableCommitError(error) {
  return [400, 409].includes(error?.status) && /FAILED_PRECONDITION|ABORTED|does not match|contention|ALREADY_EXISTS/i.test(String(error.message));
}

/* 自分の users を読み、plan（変更内容の計算）を作ってまとめて書く。途中で書き換えられていたらやり直す */
async function runMyUserChange(deps, uid, preferredName, plan) {
  const fs = deps.firestore;
  for (let attempt = 1; attempt <= ECON_RETRY; attempt++) {
    const me = await loadMyUser(fs, uid, preferredName);
    if (me.error) return me.error;
    const data = decodeFields(me.raw.fields);
    if (typeof data.coins !== "number" || !Number.isSafeInteger(data.coins)) return econError(409, "invalid_balance");
    const step = await plan({ name: me.name, raw: me.raw, data, now: deps.now() });
    if (step.error) return step;
    if (!step.userFields && !(step.writes || []).length) return { ok: true, ...step.result };
    const writes = [];
    if (step.userFields) {
      writes.push({
        update: { name: fs.docName(`users/${me.name}`), fields: step.userFields },
        updateMask: { fieldPaths: step.fieldPaths || Object.keys(step.userFields) },
        ...(step.userTransforms ? { updateTransforms: step.userTransforms } : {}),
        currentDocument: { updateTime: me.raw.updateTime }
      });
    }
    writes.push(...(step.writes || []));
    try {
      await fs.commit(writes);
      return { ok: true, ...step.result };
    } catch (error) {
      if (!isRetryableCommitError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20 + Math.random() * 60 * attempt));
    }
  }
  return econError(409, "busy");
}

function parsePositiveAmount(value, max = ECON_MAX_AMOUNT) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= max ? value : null;
}

/* ---------- 各操作 ---------- */

export async function handleEconomyAction(deps, uid, body) {
  const action = typeof body?.action === "string" ? body.action : "";
  if (!ECONOMY_ACTIONS.includes(action)) return econError(400, "unknown_action");
  const name = body?.username;
  try {
    switch (action) {
      case "bankDeposit": return await econBankDeposit(deps, uid, name, body.amount);
      case "bankWithdraw": return await econBankWithdraw(deps, uid, name, body.amount);
      case "bankBorrow": return await econBankBorrow(deps, uid, name);
      case "bankRepay": return await econBankRepay(deps, uid, name);
      case "stockTrade": return await econStockTrade(deps, uid, name, body);
      case "loginBonus": return await econLoginBonus(deps, uid, name);
      case "bonus500": return await econBonus500(deps, uid, name);
      case "placeBet": return await econPlaceBet(deps, uid, name, body);
      case "ensureRaceResult": return await econEnsureRaceResult(deps, body?.raceId);
      case "settleMyBets": return await econSettleMyBets(deps, uid, name, body?.raceId);
      case "startingCoins": return await econStartingCoins(deps, uid, name);
      case "renameCarry": return await econRenameCarry(deps, uid, body);
      default: return econError(400, "unknown_action");
    }
  } catch (error) {
    console.error("economy error", action, String(error?.message || error).slice(0, 300));
    return econError(500, "internal_error");
  }
}

/* 初期コイン（1000）：コインがまだ無いときだけ付ける（アプリが users を作った直後に呼ぶ） */
async function econStartingCoins(deps, uid, name) {
  const fs = deps.firestore;
  const me = await loadMyUser(fs, uid, name);
  if (me.error) return me.error;
  const data = decodeFields(me.raw.fields);
  if (typeof data.coins === "number") return { ok: true, granted: false, coins: data.coins };
  try {
    await fs.commit([{
      update: { name: fs.docName(`users/${me.name}`), fields: { coins: restInt(ECON_START_COINS) } },
      updateMask: { fieldPaths: ["coins"] },
      currentDocument: { updateTime: me.raw.updateTime }
    }]);
    return { ok: true, granted: true, coins: ECON_START_COINS };
  } catch (error) {
    if (isRetryableCommitError(error)) return { ok: true, granted: false };
    throw error;
  }
}

/* 名前変更のときの経済項目の引き継ぎ：from・to がどちらも自分（uid が一致）のとき、
   from の経済項目（コイン・銀行・株・累計賭け金・ボーナス・お知らせ既読）を to にコピーして、from を消す。
   ブラウザは経済項目を書けないので、この引き継ぎだけサーバーが行う（新しい名前で初期コインが二重に付かないように） */
async function econRenameCarry(deps, uid, body) {
  const from = body?.from;
  const to = body?.to;
  const bad = (v) => typeof v !== "string" || !v || v.length > 100 || v.includes("/");
  if (bad(from) || bad(to) || from === to) return econError(400, "invalid_rename");
  const fs = deps.firestore;
  for (let attempt = 1; attempt <= ECON_RETRY; attempt++) {
    const [fromRaw, toRaw] = await Promise.all([fs.getRaw(`users/${from}`), fs.getRaw(`users/${to}`)]);
    if (!toRaw || toRaw.fields?.uid?.stringValue !== uid) return econError(409, "rename_to_not_mine");
    if (!fromRaw) return { ok: true, carried: false };
    if (fromRaw.fields?.uid?.stringValue !== uid) return econError(409, "rename_from_not_mine");
    const carry = {};
    ECON_CARRY_FIELDS.forEach((f) => { if (f in fromRaw.fields) carry[f] = structuredClone(fromRaw.fields[f]); });
    try {
      await fs.commit([
        { update: { name: fs.docName(`users/${to}`), fields: carry }, updateMask: { fieldPaths: ECON_CARRY_FIELDS }, currentDocument: { updateTime: toRaw.updateTime } },
        { delete: fs.docName(`users/${from}`), currentDocument: { updateTime: fromRaw.updateTime } }
      ]);
      return { ok: true, carried: true };
    } catch (error) {
      if (!isRetryableCommitError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20 + Math.random() * 60 * attempt));
    }
  }
  return econError(409, "busy");
}

async function econBankDeposit(deps, uid, name, amountIn) {
  const amount = parsePositiveAmount(amountIn);
  if (!amount) return econError(400, "invalid_amount");
  return runMyUserChange(deps, uid, name, ({ raw, data }) => {
    const bank = econBank(data);
    if (bank.loan > 0) return econError(409, "LOAN_ACTIVE");
    if (data.coins < amount) return econError(409, "NOT_ENOUGH_COINS");
    return { userFields: { coins: restInt(data.coins - amount), bank: bankWith(raw.fields, { deposit: restInt(bank.deposit + amount) }) }, result: { coins: data.coins - amount, deposit: bank.deposit + amount } };
  });
}

async function econBankWithdraw(deps, uid, name, amountIn) {
  const amount = parsePositiveAmount(amountIn);
  if (!amount) return econError(400, "invalid_amount");
  return runMyUserChange(deps, uid, name, ({ raw, data }) => {
    const bank = econBank(data);
    if (bank.deposit < amount) return econError(409, "NOT_ENOUGH_DEPOSIT");
    const deposit = bank.deposit - amount;
    return { userFields: { coins: restInt(data.coins + amount), bank: bankWith(raw.fields, { deposit: restInt(deposit), interestBase: restInt(Math.min(bank.interestBase, deposit)) }) }, result: { coins: data.coins + amount, deposit } };
  });
}

async function econBankBorrow(deps, uid, name) {
  return runMyUserChange(deps, uid, name, ({ raw, data, now }) => {
    const bank = econBank(data);
    if (bank.loan > 0) return econError(409, "LOAN_ACTIVE");
    if (data.coins > ECON_LOAN_MAX_COINS) return econError(409, "TOO_MANY_COINS");
    return {
      userFields: {
        coins: restInt(data.coins + ECON_LOAN_AMOUNT),
        bank: bankWith(raw.fields, { loan: restInt(ECON_LOAN_AMOUNT), loanTakenAt: restTime(now), loanDueAt: restTime(now + ECON_LOAN_DAYS * DAY_MS), overdue: { booleanValue: false }, overdueDate: restNull(), lastAutoRepay: restNull() })
      },
      result: { coins: data.coins + ECON_LOAN_AMOUNT, loan: ECON_LOAN_AMOUNT }
    };
  });
}

async function econBankRepay(deps, uid, name) {
  return runMyUserChange(deps, uid, name, ({ raw, data }) => {
    const bank = econBank(data);
    if (bank.loan <= 0) return econError(409, "NO_LOAN");
    if (data.coins < bank.loan) return econError(409, "NOT_ENOUGH_COINS");
    return {
      userFields: {
        coins: restInt(data.coins - bank.loan),
        bank: bankWith(raw.fields, { loan: restInt(0), loanTakenAt: restNull(), loanDueAt: restNull(), overdue: { booleanValue: false }, overdueDate: restNull(), lastAutoRepay: restNull() })
      },
      result: { coins: data.coins - bank.loan, repaid: bank.loan }
    };
  });
}

async function econStockTrade(deps, uid, name, body) {
  const code = body?.code;
  const side = body?.side;
  const qty = parsePositiveAmount(body?.qty, ECON_MAX_TRADE_QTY);
  if (!Object.prototype.hasOwnProperty.call(ASSET_STOCK_INITIAL_PRICES, code)) return econError(400, "NO_COMPANY");
  if (side !== "buy" && side !== "sell") return econError(400, "invalid_side");
  if (!qty) return econError(400, "invalid_qty");
  const market = await deps.firestore.get("market/current");
  const price = marketPricesOf(market)[code];
  return runMyUserChange(deps, uid, name, ({ data }) => {
    const h = data.stocks?.[code] || {};
    const holding = { qty: Math.max(0, Math.floor(Number(h.qty) || 0)), cost: Math.max(0, Math.round(Number(h.cost) || 0)) };
    const amount = price * qty;
    let next, coins;
    if (side === "buy") {
      if (data.coins < amount) return econError(409, "NOT_ENOUGH_COINS");
      next = { qty: holding.qty + qty, cost: holding.cost + amount };
      coins = data.coins - amount;
    } else {
      if (holding.qty < qty) return econError(409, "NOT_ENOUGH_STOCK");
      const costPart = Math.round(holding.cost * (qty / holding.qty));
      next = { qty: holding.qty - qty, cost: holding.cost - costPart };
      coins = data.coins + amount;
    }
    const userFields = { coins: restInt(coins) };
    if (next.qty > 0) userFields.stocks = { mapValue: { fields: { [code]: { mapValue: { fields: { qty: restInt(next.qty), cost: restInt(next.cost) } } } } } };
    return { userFields, fieldPaths: ["coins", `stocks.${code}`], result: { coins, price, amount, qty: next.qty, marketDate: market?.date || "" } };
  });
}

async function econLoginBonus(deps, uid, name) {
  return runMyUserChange(deps, uid, name, ({ data, now }) => {
    const today = jstDateString(now);
    if (data.lastLoginBonusDate === today) return { result: { granted: false, today } };
    return { userFields: { coins: restInt(data.coins + ECON_LOGIN_BONUS_COINS), lastLoginBonusDate: { stringValue: today } }, result: { granted: true, amount: ECON_LOGIN_BONUS_COINS, today } };
  });
}

async function econBonus500(deps, uid, name) {
  return runMyUserChange(deps, uid, name, ({ data, now }) => {
    if (data.bonus500Granted === true) return { result: { granted: false } };
    return { userFields: { coins: restInt(data.coins + ECON_BONUS_COINS), bonus500Granted: { booleanValue: true }, bonus500GrantedAt: restTime(now) }, result: { granted: true, amount: ECON_BONUS_COINS } };
  });
}

/* 馬券の購入：受付中のレース（自動開催は締切前のいちばん早い回、手動レースは受付時間内）だけ。
   コインの引き落とし・累計賭け金・馬券の作成（・手動レースの投票数）を1回のまとめて書き込みで行う */
async function econPlaceBet(deps, uid, name, body) {
  const { raceId, type, horses, amount } = body || {};
  if (typeof raceId !== "string" || raceId.length > 40) return econError(400, "invalid_race");
  const shapeError = validBetShape(type, horses, amount);
  if (shapeError) return econError(400, shapeError);
  if (!isFixedOddsRaceId(raceId)) return econError(409, "RACE_CLOSED");
  const fs = deps.firestore;
  for (let attempt = 1; attempt <= ECON_RETRY; attempt++) {
    const now = deps.now();
    const schedule = await loadRaceSchedule(fs, raceId);
    if (!schedule) return econError(409, "RACE_CLOSED");
    if (schedule.manual) {
      if (schedule.cancelled) return econError(409, "MANUAL_RACE_CANCELLED");
      if (!(now >= schedule.openMs && now < schedule.closeMs)) return econError(409, "MANUAL_RACE_CLOSED");
    } else if (nextAutoRaceId(now) !== raceId) {
      return econError(409, "RACE_CLOSED");
    }
    const me = await loadMyUser(fs, uid, name);
    if (me.error) return me.error;
    const data = decodeFields(me.raw.fields);
    if (typeof data.coins !== "number" || !Number.isSafeInteger(data.coins)) return econError(409, "invalid_balance");
    if (data.coins < amount) return econError(409, "NOT_ENOUGH_COINS");

    const oddsTenths = derbyTicketOddsTenths(derbyOddsTable(raceId), type, horses);
    const betId = crypto.randomUUID().replace(/-/g, "").slice(0, 20);
    const total = Number(data.totalBetAmount) || 0;
    const writes = [
      {
        update: { name: fs.docName(`users/${me.name}`), fields: { coins: restInt(data.coins - amount), totalBetAmount: restInt(total + amount) } },
        updateMask: { fieldPaths: ["coins", "totalBetAmount"] },
        currentDocument: { updateTime: me.raw.updateTime }
      },
      {
        update: {
          name: fs.docName(`raceBets/${betId}`),
          fields: encodeFields({ raceId, uid, username: me.name, type, horses, amount, settled: false, win: null, payout: null, oddsVersion: 1, oddsTenths, placedBy: "worker" })
        },
        updateTransforms: [{ fieldPath: "createdAt", setToServerValue: "REQUEST_TIME" }],
        currentDocument: { exists: false }
      }
    ];
    if (schedule.manual) {
      writes.push({
        update: { name: fs.docName(`derbyManualRaces/${raceId}`), fields: { betCount: restInt(schedule.betCount + 1) } },
        updateMask: { fieldPaths: ["betCount"] },
        currentDocument: { updateTime: schedule.raw.updateTime }
      });
    }
    try {
      await fs.commit(writes);
      return { ok: true, betId, raceId, coins: data.coins - amount, oddsTenths };
    } catch (error) {
      if (!isRetryableCommitError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20 + Math.random() * 60 * attempt));
    }
  }
  return econError(409, "busy");
}

/* 発走時刻を過ぎたレースの結果を作る（まだ無いとき。サーバーが作ったものでない結果は、確かめる日付以降なら作り直す） */
async function econEnsureRaceResult(deps, raceId) {
  if (typeof raceId !== "string" || !isFixedOddsRaceId(raceId)) return econError(400, "invalid_race");
  const fs = deps.firestore;
  const schedule = await loadRaceSchedule(fs, raceId);
  if (!schedule || schedule.cancelled) return econError(409, "invalid_race");
  if (!(deps.now() >= schedule.raceMs)) return econError(409, "race_not_started");
  const existing = await fs.getRaw(`races/${raceId}`);
  if (existing && isTrustedRaceResult(raceId, decodeFields(existing.fields))) return { ok: true, created: false };

  const random = deps.random || Math.random;
  const order = derbyRaceOrder(raceId, random);
  const race = { raceId, resultOrder: order, checkpoints: derbyCheckpoints(order, random), finishStats: derbyFinishStats(order, random), status: "finished", generatedBy: "worker", ...derbyRaceOddsRecord(raceId) };
  const logFields = { raceId, scheduledAt: new Date(schedule.raceMs), resultGeneratedBy: "worker", resultStatus: existing ? "regenerated" : "created" };
  try {
    await fs.commit([
      {
        update: { name: fs.docName(`races/${raceId}`), fields: encodeFields(race) },
        updateTransforms: [{ fieldPath: "generatedAt", setToServerValue: "REQUEST_TIME" }],
        currentDocument: existing ? { updateTime: existing.updateTime } : { exists: false }
      },
      {
        update: { name: fs.docName(`raceLogs/${raceId}`), fields: encodeFields(logFields) },
        updateMask: { fieldPaths: Object.keys(logFields) },
        updateTransforms: [{ fieldPath: "resultGeneratedAt", setToServerValue: "REQUEST_TIME" }]
      }
    ]);
    return { ok: true, created: true };
  } catch (error) {
    if (isRetryableCommitError(error)) return { ok: true, created: false };
    throw error;
  }
}

/* 精算してよい馬券か（締切までに買われた・中身が正しい） */
export function betRejectReason(bet, closeMs, serverResultsFrom = DERBY_SERVER_RESULTS_FROM) {
  if (validBetShape(bet.type, bet.horses, bet.amount)) return "invalid_bet";
  const created = tsMillis(bet.createdAt);
  if (!Number.isFinite(created) || !Number.isFinite(closeMs) || created > closeMs) return "after_close";
  if (serverResultsFrom && String(bet.raceId).slice(0, 10) >= serverResultsFrom && bet.placedBy !== "worker") return "not_server_placed";
  return null;
}

/* 結果の出たレースの、自分の未精算の馬券を精算する（払い戻しはサーバーでレースIDのオッズから計算） */
/* 山分け方式（固定オッズより前のレース）の払い戻し：同じ券種の賭け金の合計 × 0.8 を、当たった人で賭け金に応じて分ける */
function derbyPoolPayouts(allBets, order) {
  const pools = {};
  allBets.forEach((b) => {
    const amount = Math.max(0, Math.floor(Number(b.amount) || 0));
    if (!pools[b.type]) pools[b.type] = { total: 0, winning: 0 };
    pools[b.type].total += amount;
    if (derbyBetWins(b, order)) pools[b.type].winning += amount;
  });
  const out = {};
  allBets.forEach((b) => {
    const pool = pools[b.type];
    const win = derbyBetWins(b, order);
    out[b.id] = { win, payout: win && pool.winning > 0 ? Math.floor((Number(b.amount) || 0) / pool.winning * pool.total * 0.8) : 0 };
  });
  return out;
}

async function econSettleMyBets(deps, uid, name, raceId) {
  if (typeof raceId !== "string" || raceId.length > 40 || !/^\d{4}-\d{2}-\d{2}/.test(raceId)) return econError(400, "invalid_race");
  const fs = deps.firestore;
  const fixed = isFixedOddsRaceId(raceId);
  const [schedule, race] = await Promise.all([loadRaceSchedule(fs, raceId), fs.get(`races/${raceId}`)]);
  if (fixed && !schedule) return econError(409, "invalid_race");
  if (!race || !isTrustedRaceResult(raceId, race)) return econError(409, "no_result");
  const me = await loadMyUser(fs, uid, name);
  if (me.error) return me.error;
  const bets = await fs.query("raceBets", [["raceId", "EQUAL", raceId], ["uid", "EQUAL", uid], ["settled", "EQUAL", false]]);
  const table = fixed ? derbyOddsTable(raceId) : null;
  /* 山分け方式は、そのレースの全馬券（賭け金の合計）が払い戻しの計算に要る */
  const poolPayouts = fixed ? null : derbyPoolPayouts((await fs.query("raceBets", [["raceId", "EQUAL", raceId]])).map((b) => ({ id: b.id, ...b.data })), race.resultOrder);
  const settled = [];
  for (const bet of bets) {
    const data = bet.data;
    let fields;
    if (fixed) {
      const reject = betRejectReason(data, schedule.closeMs);
      const oddsTenths = derbyTicketOddsTenths(table, data.type, data.horses);
      const win = !reject && oddsTenths !== null && derbyBetWins(data, race.resultOrder);
      const payout = win ? derbyFixedPayout(data.amount, oddsTenths) : 0;
      fields = { settled: true, win, payout, payoutRule: DERBY_FIXED_PAYOUT_RULE, settledOddsTenths: oddsTenths, settledBy: "worker", ...(reject ? { rejectedReason: reject } : {}) };
    } else {
      const { win, payout } = poolPayouts[bet.id] || { win: false, payout: 0 };
      fields = { settled: true, win, payout, settledBy: "worker" };
    }
    const payout = fields.payout;
    const writes = [{
      update: { name: fs.docName(`raceBets/${bet.id}`), fields: encodeFields(fields) },
      updateMask: { fieldPaths: Object.keys(fields) },
      currentDocument: { updateTime: bet.updateTime }
    }];
    if (payout > 0) {
      writes.push({
        update: { name: fs.docName(`users/${me.name}`), fields: {} },
        updateMask: { fieldPaths: [] },
        updateTransforms: [{ fieldPath: "coins", increment: restInt(payout) }],
        currentDocument: { exists: true }
      });
    }
    try {
      await fs.commit(writes);
      settled.push({ betId: bet.id, type: data.type, horses: data.horses, amount: data.amount, win: fields.win, payout, rejected: fields.rejectedReason || null });
    } catch (error) {
      if (!isRetryableCommitError(error)) throw error; /* ほかの処理（derby-runner など）が先に精算した */
    }
  }
  return { ok: true, raceId, settled, payoutTotal: settled.reduce((s, b) => s + b.payout, 0) };
}

/* Firestore にデータが1件もない Authentication のユーザー（名前を決める前にやめたゲストなど）だけを消す */
async function adminDeleteAuthOnly(deps, callerUid, uid) {
  if (uid === deps.adminUid) return { status: 400, error: "cannot_target_admin" };
  const fs = deps.firestore;
  const [docs, record, authUser] = await Promise.all([findUserDocsByUid(fs, uid), fs.get(`userDeletions/${uid}`), deps.authAdmin.lookup(uid)]);
  if (docs.length > 0) return { status: 409, error: "has_user_doc" };
  if (record && record.status !== "completed") return { status: 409, error: "deletion_in_progress" };
  if (!authUser) return { status: 404, error: "auth_user_not_found" };

  const plan = await buildDeletionPlan(deps, uid, "");
  const total = Object.values(plan.counts).reduce((sum, n) => sum + n, 0);
  if (total > 0) return { status: 409, error: "has_data", counts: plan.counts };

  await deps.authAdmin.delete(uid);
  await fs.delete(`suspendedUsers/${uid}`);
  await writeAuditLog(deps, { action: "deleteAuthOnly", targetUid: uid, targetName: "", byUid: callerUid, result: "ok" });
  return { ok: true };
}

/* =========================================================
   HTTP まわり
========================================================= */

function getCorsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const allowed = String(env.ALLOWED_ORIGINS || DEFAULT_ALLOWED_ORIGINS).split(",").map((s) => s.trim()).filter(Boolean);
  if (!origin || !allowed.includes(origin)) return null;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin"
  };
}

function jsonResponse(data, status, cors) {
  const { status: _ignored, ...body } = data || {};
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...(cors || {}) }
  });
}

/* =========================================================
   本番用の依存（Google の認証・Firestore REST・FCM HTTP v1）
========================================================= */

export function createDefaultDeps(env, fetchImpl = (...args) => fetch(...args)) {
  applyDerbyTimeOverrides(env);
  const projectId = env.FIREBASE_PROJECT_ID || DEFAULT_PROJECT_ID;
  const firestoreBase = env.FIRESTORE_BASE_URL || "https://firestore.googleapis.com/v1";
  const fcmBase = env.FCM_BASE_URL || "https://fcm.googleapis.com/v1";
  const getAccessToken = env.ACCESS_TOKEN_OVERRIDE
    ? async () => env.ACCESS_TOKEN_OVERRIDE
    : () => getServiceAccountAccessToken(env.FIREBASE_SERVICE_ACCOUNT, fetchImpl);

  const authAdminBase = env.AUTH_ADMIN_BASE_URL || "https://identitytoolkit.googleapis.com/v1";

  return {
    now: () => Date.now(),
    adminUid: env.ADMIN_UID || DEFAULT_ADMIN_UID,
    verifyIdToken: (token) => verifyFirebaseIdToken(token, projectId, fetchImpl),
    firestore: createFirestoreClient({ base: firestoreBase, projectId, getAccessToken, fetchImpl }),
    authAdmin: createAuthAdminClient({ base: authAdminBase, projectId, getAccessToken, fetchImpl }),
    sendFcm: (token, data) => sendFcmMessage({ base: fcmBase, projectId, getAccessToken, fetchImpl }, token, data)
  };
}

/* ----- Firebase の ID トークンの検証 ----- */

let cachedJwks = null;

async function getGoogleJwks(fetchImpl) {
  if (cachedJwks && cachedJwks.expiresAt > Date.now()) return cachedJwks.keys;
  const response = await fetchImpl(GOOGLE_JWKS_URL);
  if (!response.ok) throw new Error(`jwks ${response.status}`);
  const json = await response.json();
  const maxAge = Number((response.headers.get("Cache-Control") || "").match(/max-age=(\d+)/)?.[1] || 3600);
  cachedJwks = { keys: json.keys || [], expiresAt: Date.now() + maxAge * 1000 };
  return cachedJwks.keys;
}

export function resetJwksCacheForTest() {
  cachedJwks = null;
}

export async function verifyFirebaseIdToken(token, projectId, fetchImpl, nowSeconds = Math.floor(Date.now() / 1000)) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed token");

  const header = JSON.parse(base64UrlDecodeToString(parts[0]));
  const payload = JSON.parse(base64UrlDecodeToString(parts[1]));
  if (header.alg !== "RS256" || !header.kid) throw new Error("bad header");

  const jwk = (await getGoogleJwks(fetchImpl)).find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("unknown key");

  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5", key, base64UrlDecode(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  );
  if (!valid) throw new Error("bad signature");

  const skew = 300;
  if (payload.aud !== projectId) throw new Error("bad audience");
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) throw new Error("bad issuer");
  if (typeof payload.exp !== "number" || payload.exp <= nowSeconds) throw new Error("expired");
  if (typeof payload.iat !== "number" || payload.iat > nowSeconds + skew) throw new Error("issued in the future");
  if (typeof payload.auth_time === "number" && payload.auth_time > nowSeconds + skew) throw new Error("bad auth_time");
  if (typeof payload.sub !== "string" || !payload.sub || payload.sub.length > 128) throw new Error("bad subject");
  return payload.sub;
}

/* ----- サービスアカウントで Google のアクセストークンを取得 ----- */

let cachedAccessToken = null;

async function getServiceAccountAccessToken(serviceAccountJson, fetchImpl) {
  if (cachedAccessToken && cachedAccessToken.expiresAt > Date.now() + 60000) return cachedAccessToken.token;
  if (!serviceAccountJson) throw new Error("FIREBASE_SERVICE_ACCOUNT is not set");

  const sa = typeof serviceAccountJson === "string" ? JSON.parse(serviceAccountJson) : serviceAccountJson;
  const now = Math.floor(Date.now() / 1000);
  const tokenUri = sa.token_uri || "https://oauth2.googleapis.com/token";
  const unsigned = `${base64UrlEncodeString(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64UrlEncodeString(JSON.stringify({
    iss: sa.client_email, scope: OAUTH_SCOPES, aud: tokenUri, iat: now, exp: now + 3600
  }))}`;

  const key = await crypto.subtle.importKey("pkcs8", pemToArrayBuffer(sa.private_key), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const assertion = `${unsigned}.${base64UrlEncodeBytes(new Uint8Array(signature))}`;

  const response = await fetchImpl(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${assertion}`
  });
  if (!response.ok) throw new Error(`oauth ${response.status} ${await response.text()}`);
  const json = await response.json();
  cachedAccessToken = { token: json.access_token, expiresAt: Date.now() + (json.expires_in || 3600) * 1000 };
  return cachedAccessToken.token;
}

/* ----- Firestore REST ----- */

function createFirestoreClient({ base, projectId, getAccessToken, fetchImpl }) {
  const root = `projects/${projectId}/databases/(default)/documents`;
  const docUrl = (path) => `${base}/${root}/${path.split("/").map(encodeURIComponent).join("/")}`;

  const call = async (url, init = {}) => {
    const token = await getAccessToken();
    return fetchImpl(url, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers || {}) } });
  };

  return {
    async get(path) {
      const response = await call(docUrl(path));
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`firestore get ${path} ${response.status} ${await response.text()}`);
      return decodeDocument(await response.json());
    },

    async batchGet(paths) {
      if (paths.length === 0) return [];
      const response = await call(`${base}/${root}:batchGet`, {
        method: "POST",
        body: JSON.stringify({ documents: paths.map((p) => `${root}/${p}`) })
      });
      if (!response.ok) throw new Error(`firestore batchGet ${response.status} ${await response.text()}`);
      const results = await response.json();
      const byName = new Map(results.filter((r) => r.found).map((r) => [r.found.name, decodeDocument(r.found)]));
      return paths.map((p) => byName.get(`projects/${projectId}/databases/(default)/documents/${p}`) || null);
    },

    async createIfAbsent(path, data) {
      const [collection, id] = path.split("/");
      const response = await call(`${base}/${root}/${encodeURIComponent(collection)}?documentId=${encodeURIComponent(id)}`, {
        method: "POST",
        body: JSON.stringify({ fields: encodeFields(data) })
      });
      if (response.status === 409) return false;
      if (!response.ok) throw new Error(`firestore create ${path} ${response.status} ${await response.text()}`);
      return true;
    },

    async update(path, data) {
      const mask = Object.keys(data).map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join("&");
      const response = await call(`${docUrl(path)}?${mask}`, { method: "PATCH", body: JSON.stringify({ fields: encodeFields(data) }) });
      if (!response.ok) throw new Error(`firestore update ${path} ${response.status} ${await response.text()}`);
    },

    async delete(path) {
      const response = await call(docUrl(path), { method: "DELETE" });
      if (!response.ok && response.status !== 404) throw new Error(`firestore delete ${path} ${response.status}`);
    },

    async queryIn(collectionId, field, values) {
      const response = await call(`${base}/${root}:runQuery`, {
        method: "POST",
        body: JSON.stringify({
          structuredQuery: {
            from: [{ collectionId }],
            where: { fieldFilter: { field: { fieldPath: field }, op: "IN", value: { arrayValue: { values: values.map((v) => ({ stringValue: v })) } } } }
          }
        })
      });
      if (!response.ok) throw new Error(`firestore query ${response.status} ${await response.text()}`);
      return (await response.json()).filter((r) => r.document).map((r) => ({ id: r.document.name.split("/").pop(), ...decodeDocument(r.document) }));
    },

    /* ----- 👤 ユーザー管理用 ----- */

    /* filters: [[項目, "EQUAL" | "ARRAY_CONTAINS", 値], ...]（複数は AND）。select を渡すとその項目だけ読む
       戻り値：{ id, path, updateTime, data } の配列 */
    async query(collectionId, filters = [], { select } = {}) {
      const fieldFilters = filters.map(([field, op, value]) => ({ fieldFilter: { field: { fieldPath: field }, op, value: encodeValue(value) } }));
      const structuredQuery = { from: [{ collectionId }] };
      if (fieldFilters.length === 1) structuredQuery.where = fieldFilters[0];
      if (fieldFilters.length > 1) structuredQuery.where = { compositeFilter: { op: "AND", filters: fieldFilters } };
      if (select) structuredQuery.select = { fields: select.map((fieldPath) => ({ fieldPath })) };
      const response = await call(`${base}/${root}:runQuery`, { method: "POST", body: JSON.stringify({ structuredQuery }) });
      if (!response.ok) throw new Error(`firestore query ${collectionId} ${response.status} ${await response.text()}`);
      return (await response.json()).filter((r) => r.document).map((r) => toListedDocument(r.document));
    },

    /* 型をそのまま保つための読み取り（fields は Firestore REST の形のまま） */
    async getRaw(path) {
      const response = await call(docUrl(path));
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`firestore get ${path} ${response.status} ${await response.text()}`);
      const document = await response.json();
      return { fields: document.fields || {}, updateTime: document.updateTime };
    },

    /* 自動 ID で作る */
    async add(collectionId, data) {
      const response = await call(`${base}/${root}/${encodeURIComponent(collectionId)}`, { method: "POST", body: JSON.stringify({ fields: encodeFields(data) }) });
      if (!response.ok) throw new Error(`firestore add ${collectionId} ${response.status} ${await response.text()}`);
    },

    async set(path, data) {
      const response = await call(docUrl(path), { method: "PATCH", body: JSON.stringify({ fields: encodeFields(data) }) });
      if (!response.ok) throw new Error(`firestore set ${path} ${response.status} ${await response.text()}`);
    },

    /* まとめて書く（1回 500 件まで。すべて成功するか、すべて失敗する） */
    async commit(writes) {
      if (writes.length === 0) return;
      const response = await call(`${base}/${root}:commit`, { method: "POST", body: JSON.stringify({ writes }) });
      if (!response.ok) throw Object.assign(new Error(`firestore commit ${response.status} ${await response.text()}`), { status: response.status });
    },

    docName: (path) => `${root}/${path}`,

    async listCollectionIds(path) {
      const ids = [];
      let pageToken;
      do {
        const response = await call(`${docUrl(path)}:listCollectionIds`, { method: "POST", body: JSON.stringify({ pageSize: 100, ...(pageToken ? { pageToken } : {}) }) });
        if (!response.ok) throw new Error(`firestore listCollectionIds ${response.status} ${await response.text()}`);
        const json = await response.json();
        ids.push(...(json.collectionIds || []));
        pageToken = json.nextPageToken;
      } while (pageToken);
      return ids;
    },

    /* サブコレクションの中身（存在しない親の下にあるものも含めて） */
    async listDocuments(collectionPath) {
      const docs = [];
      let pageToken;
      do {
        const params = new URLSearchParams({ pageSize: "300", showMissing: "true", "mask.fieldPaths": "__name__" });
        if (pageToken) params.set("pageToken", pageToken);
        const response = await call(`${docUrl(collectionPath)}?${params}`);
        if (!response.ok) throw new Error(`firestore list ${response.status} ${await response.text()}`);
        const json = await response.json();
        (json.documents || []).forEach((d) => docs.push(d.name.slice(d.name.indexOf("/documents/") + "/documents/".length).split("/").map(decodeURIComponent).join("/")));
        pageToken = json.nextPageToken;
      } while (pageToken);
      return docs;
    }
  };
}

function toListedDocument(document) {
  const path = document.name.slice(document.name.indexOf("/documents/") + "/documents/".length);
  return { id: decodeURIComponent(path.split("/").pop()), path: path.split("/").map(decodeURIComponent).join("/"), updateTime: document.updateTime, data: decodeDocument(document) };
}

function decodeValue(v) {
  if (!v) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("timestampValue" in v) return v.timestampValue;
  if ("nullValue" in v) return null;
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(decodeValue);
  if ("mapValue" in v) return decodeFields(v.mapValue.fields || {});
  return null;
}

function decodeFields(fields) {
  const out = {};
  Object.entries(fields || {}).forEach(([k, v]) => { out[k] = decodeValue(v); });
  return out;
}

function decodeDocument(document) {
  return decodeFields(document.fields || {});
}

function encodeValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encodeValue) } };
  if (typeof v === "object") return { mapValue: { fields: encodeFields(v) } };
  return { stringValue: String(v) };
}

function encodeFields(data) {
  const out = {};
  Object.entries(data).forEach(([k, v]) => { out[k] = encodeValue(v); });
  return out;
}

/* ----- Firebase Authentication（管理用 REST：Identity Toolkit） -----
   エラーには要求の中身（パスワードなど）を入れない */

function createAuthAdminClient({ base, projectId, getAccessToken, fetchImpl }) {
  const url = (method) => `${base}/projects/${projectId}/${method}`;
  const call = async (method, init) => {
    const token = await getAccessToken();
    const response = await fetchImpl(url(method), { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      const code = String(json?.error?.message || `HTTP_${response.status}`).split(/[\s:]/)[0];
      throw Object.assign(new Error(`auth ${method.split(":").pop()} ${code}`), { authCode: code });
    }
    return json;
  };

  return {
    async lookup(uid) {
      const json = await call("accounts:lookup", { method: "POST", body: JSON.stringify({ localId: [uid] }) });
      return (json.users || [])[0] || null;
    },

    async listAll() {
      const users = [];
      let nextPageToken;
      do {
        const params = new URLSearchParams({ maxResults: "1000" });
        if (nextPageToken) params.set("nextPageToken", nextPageToken);
        const json = await call(`accounts:batchGet?${params}`, { method: "GET" });
        users.push(...(json.users || []));
        nextPageToken = json.nextPageToken;
      } while (nextPageToken);
      return users;
    },

    /* uid はそのまま（作り直さない）。fields：email / password / disableUser / validSince */
    async update(uid, fields) {
      await call("accounts:update", { method: "POST", body: JSON.stringify({ localId: uid, ...fields }) });
    },

    async delete(uid) {
      try {
        await call("accounts:delete", { method: "POST", body: JSON.stringify({ localId: uid }) });
      } catch (error) {
        if (error.authCode !== "USER_NOT_FOUND") throw error;
      }
    }
  };
}

/* ----- FCM HTTP v1 ----- */

async function sendFcmMessage({ base, projectId, getAccessToken, fetchImpl }, token, data) {
  const accessToken = await getAccessToken();
  const response = await fetchImpl(`${base}/projects/${projectId}/messages:send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: {
        token,
        data,
        webpush: { headers: { Urgency: "high", TTL: String(NOTIFICATION_TTL_SECONDS) } }
      }
    })
  });
  if (response.ok) return { ok: true };

  const text = await response.text();
  /* もう使えないトークン（登録解除・不正）は削除する */
  const invalidToken = response.status === 404 || /UNREGISTERED|registration token|Requested entity was not found/i.test(text);
  return { ok: false, status: response.status, invalidToken, detail: text.slice(0, 300) };
}

/* ----- base64url / PEM ----- */

function base64UrlDecode(input) {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(input.length / 4) * 4, "=");
  const binary = atob(base64);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function base64UrlDecodeToString(input) {
  return new TextDecoder().decode(base64UrlDecode(input));
}

function base64UrlEncodeBytes(bytes) {
  let binary = "";
  bytes.forEach((b) => { binary += String.fromCharCode(b); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlEncodeString(text) {
  return base64UrlEncodeBytes(new TextEncoder().encode(text));
}

function pemToArrayBuffer(pem) {
  const base64 = String(pem).replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)).buffer;
}
