/* =========================================================
   ゆうChat 通知サーバー（Cloudflare Workers）

   アプリでメッセージを送ったあと、送信者の端末がここに
     POST /notify   Authorization: Bearer <Firebase の ID トークン>
                    { "messageId": "<messages のドキュメントID>" }
   を送る。Worker は
     1. ID トークンを検証して送信者の uid を確かめる（なりすまし防止）
     2. messages/{messageId} を読み、送信者本人のメッセージか確かめる
     3. 受信者を決める（友達チャット：friends の相手／グループ：送信者以外のメンバー）
     4. notificationLogs/{messageId} を「まだ無いときだけ」作る（同じメッセージの二重送信防止）
     5. 受信者の全端末（fcmTokens）へ FCM で送る。無効になったトークンは削除する
   を行う。送信者本人の端末には送らない。

   外部ライブラリを使わない1ファイルなので、Cloudflare の管理画面にそのまま貼り付けて使える。

   管理者専用（👤 ユーザー管理）：
     POST /admin    Authorization: Bearer <管理者の ID トークン>
                    { "action": "listUsers" | "inspectUser" | "setPassword" | "suspend" | "unsuspend" | "deleteUser" | "deleteAuthOnly" | "adjustCoins" | "notifyAnnouncement", ... }
   ID トークンの uid が ADMIN_UID のときだけ実行する（それ以外は 403）。パスワードはどこにも保存・記録しない。

   🎮 ゲームの招待（大富豪・オセロ・将棋）：
     POST /notify   Authorization: Bearer <招待した人の ID トークン>
                    { "inviteId": "<gameInvites のドキュメントID>" }
   招待した本人・部屋を作った本人・友達どうし・保留中で新しい招待・まだ参加できる部屋のときだけ、
   招待された人の全端末へ送る。notificationLogs/invite-{inviteId}-{招待した時刻} で同じ招待の通知は1回だけ

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

    /* 🎮 ゲームの招待 */
    if (body && typeof body === "object" && "inviteId" in body) {
      const inviteId = typeof body.inviteId === "string" ? body.inviteId : "";
      if (!/^[A-Za-z0-9_-]{1,200}$/.test(inviteId)) return jsonResponse({ error: "invalid_invite_id" }, 400, cors);
      const result = await notifyForGameInvite(deps, uid, inviteId);
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

  await fs.update(`notificationLogs/${messageId}`, { tokenCount: tokens.length, sent, failed, removedTokens: removed.length })
    .catch((error) => console.warn("log update failed", error));

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

/* ----- 🎮 ゲームの招待 ----- */

const GAME_NAMES = { daifugo: "大富豪", othello: "オセロ", shogi: "将棋" };
const GAME_MAX_PLAYERS = { daifugo: 4, othello: 2, shogi: 2 };

/* まだ参加できる部屋か（script.js の isGameRoomJoinable と同じ判定）
   ・満員でない
   ・対局中でない（大富豪は、1回のゲームが終わって次のゲームを待っている間も参加できる） */
export function isGameRoomJoinable(room) {
  if (!room || !GAME_MAX_PLAYERS[room.gameType]) return false;
  const members = Array.isArray(room.members) ? room.members : [];
  if (members.length >= GAME_MAX_PLAYERS[room.gameType]) return false;
  if (room.status !== "playing") return true;
  return room.gameType === "daifugo" && room.gameState?.phase === "finished";
}

export function gameInviteNotificationData(inviteId, invite) {
  const gameName = GAME_NAMES[invite.gameType] || "ゲーム";
  return {
    kind: "gameInvite",
    inviteId,
    roomId: invite.roomId,
    gameType: invite.gameType,
    inviteAt: String(Date.parse(invite.createdAt) || ""),
    title: "🎮 ゲームの招待",
    body: `${truncate(invite.from || "友達", 30)}さんから${gameName}に招待されました`,
    link: `./?open=games&invite=${encodeURIComponent(inviteId)}`,
    tag: `invite-${inviteId}`
  };
}

export async function notifyForGameInvite(deps, uid, inviteId) {
  const fs = deps.firestore;

  /* 招待した本人か・保留中の新しい招待か */
  const invite = await fs.get(`gameInvites/${inviteId}`);
  if (!invite) return { status: 404, error: "invite_not_found" };
  if (invite.fromUid !== uid) return { status: 403, error: "not_inviter" };
  if (!GAME_NAMES[invite.gameType] || typeof invite.roomId !== "string" || typeof invite.toUid !== "string") return { status: 400, error: "invalid_invite" };
  if (inviteId !== `${invite.roomId}_${invite.toUid}` || invite.toUid === uid) return { status: 400, error: "invalid_invite" };
  if (invite.status !== "pending") return { skipped: "not_pending" };
  const createdAt = invite.createdAt ? Date.parse(invite.createdAt) : NaN;
  if (!Number.isFinite(createdAt) || deps.now() - createdAt > MAX_MESSAGE_AGE_MS) return { skipped: "too_old" };

  /* 部屋を作った本人が、まだ参加できる部屋に招待しているか */
  if (!/^[^/]{1,1500}$/.test(invite.roomId)) return { status: 400, error: "invalid_invite" };
  const room = await fs.get(`gameRooms/${invite.roomId}`);
  if (!room) return { skipped: "room_not_found" };
  if (room.ownerUid !== uid || room.gameType !== invite.gameType) return { status: 403, error: "not_room_owner" };
  if (!isGameRoomJoinable(room)) return { skipped: "room_not_joinable" };

  /* 名前が本人のものか・友達どうしか */
  const from = String(invite.from || ""), to = String(invite.to || "");
  if (!from || !to || from.includes("/") || to.includes("/")) return { status: 400, error: "invalid_invite" };
  const [fromUser, toUser, friendA, friendB] = await fs.batchGet([`users/${from}`, `users/${to}`, `friends/${from}_${to}`, `friends/${to}_${from}`]);
  if (fromUser?.uid !== uid || toUser?.uid !== invite.toUid) return { status: 403, error: "name_mismatch" };
  if (!friendA && !friendB) return { status: 403, error: "not_friends" };

  /* 同じ招待の通知は1回だけ（返事のあとにもう一度招待したときは、招待した時刻が変わるので送る） */
  const logId = `invite-${inviteId}-${createdAt}`;
  const claimed = await fs.createIfAbsent(`notificationLogs/${logId}`, { kind: "gameInvite", inviteId, fromUid: uid, toUid: invite.toUid, createdAt: new Date(deps.now()) });
  if (!claimed) return { skipped: "duplicate" };

  const tokens = await getTokensForUids(fs, [invite.toUid]);
  const data = gameInviteNotificationData(inviteId, invite);
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
