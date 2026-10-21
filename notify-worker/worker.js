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
    /* 🎟 毎週金曜 14:30（日本時間）の宝くじの抽選。抽選の直後以外は Firestore に触れずにすぐ戻る */
    ctx.waitUntil(runLotteryTick(env, event.scheduledTime).catch((error) => console.error("lottery tick error", String(error?.message || error).slice(0, 300))));
    /* 🌈 ゆうスロ確変台：前日12:00の公開・21:00の抽選・当日7:00/7:50/10:45。予定の時刻の直後以外は Firestore に触れずにすぐ戻る */
    ctx.waitUntil(runKakuTick(env, event.scheduledTime).catch((error) => console.error("kaku tick error", String(error?.message || error).slice(0, 300))));
    /* 🏅 ゆうスロの会員ランク：毎週月曜 7:00（日本時間）に、先週の使ったコインでランクを決める。それ以外の分は Firestore に触れずにすぐ戻る */
    ctx.waitUntil(runRankTick(env, event.scheduledTime).catch((error) => console.error("rank tick error", String(error?.message || error).slice(0, 300))));
    /* 🎫 先着ゲームの週間ランキング：毎週月曜 7:00（日本時間）に結果発表（1位500・2位250・3位100コイン）。それ以外の分は Firestore に触れずにすぐ戻る */
    ctx.waitUntil(runBattleWeekTick(env, event.scheduledTime).catch((error) => console.error("battle week error", String(error?.message || error).slice(0, 300))));
    /* 💸 コイン送金：3日たっても承認されない申請を、1日1回（日本時間 3:07）自動で却下して返金する。それ以外の分は Firestore に触れずにすぐ戻る */
    ctx.waitUntil(runTransferExpiryTick(env, event.scheduledTime).catch((error) => console.error("transfer expiry error", String(error?.message || error).slice(0, 300))));
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
    /* 🎰 ゆうワールド「ゆうスロ」：着席・スピン・精算・公開設定（残高・抽選・精算はサーバーが確定） */
    if (new URL(request.url).pathname.replace(/\/+$/, "") === "/yuslot") {
      const result = await handleYuslotAction(deps, uid, body);
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

export async function sendBroadcastNotification(deps, logId, data, filterUid = null, dataForUid = null) {
  const fs = deps.firestore;
  const claimed = await claimBroadcastLog(deps, logId, data.kind || "");
  if (!claimed) return { skipped: "duplicate" };

  // filterUid＝通知の好みで、送らない人を外す／dataForUid＝人ごとに中身を変える（null を返した人には送らない。本人の結果だけを届けるため）
  const targets = (await fs.query("fcmTokens", [], { select: ["uid"] })).filter((d) => !filterUid || filterUid(d.data?.uid)).map((d) => ({ token: d.id, data: dataForUid ? dataForUid(d.data?.uid) : data })).filter((t) => t.data);
  const tokens = targets.map((t) => t.token);
  let sent = 0, failed = 0, removed = 0;
  await Promise.all(targets.map(async ({ token, data }) => {
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
const USER_LIST_FIELDS = ["uid", "name", "coins", "createdAt", "updatedAt", "lastSeen", "lastLoginBonusDate", "totalBetAmount", "nameChangedFrom", "slotSpins", "slotWagered"];

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
  const noUidActions = ["listUsers", "notifyAnnouncement", "renameUserRefs", "transferList", "transferApprove", "transferReject", "kakuWinners"];
  if (!noUidActions.includes(action) && !UID_PATTERN.test(uid)) return { status: 400, error: "invalid_uid" };

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
      case "renameUserRefs": return await adminRenameUserRefs(deps, body);
      case "lotteryRefund": return await adminLotteryRefund(deps, callerUid, uid, body);
      case "kakuWinners": return await adminKakuWinners(deps, body);
      case "transferList": return await adminTransferList(deps);
      case "transferApprove": return await adminTransferApprove(deps, callerUid, body);
      case "transferReject": return await adminTransferReject(deps, callerUid, body);
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
      slotSpins: typeof d.data.slotSpins === "number" ? d.data.slotSpins : 0,
      slotWagered: typeof d.data.slotWagered === "number" ? d.data.slotWagered : 0,
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

/* 管理者による名前の強制変更のあと、名前が入っているチャット・グループ・友達関係を新しい名前に書き換える。
   ブラウザからは他人のメッセージ等を書き換えられないので、管理者の操作を受けてサーバーが行う。 */
async function adminRenameUserRefs(deps, body) {
  const from = body?.from, to = body?.to;
  const bad = (v) => typeof v !== "string" || !v || v.length > 100 || v.includes("/");
  if (bad(from) || bad(to) || from === to) return { status: 400, error: "invalid_rename" };
  const count = await rewriteNameRefs(deps.firestore, from, to);
  return { ok: true, count };
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

const ECONOMY_ACTIONS = ["bankDeposit", "bankWithdraw", "bankBorrow", "bankRepay", "stockTrade", "loginBonus", "bonus500", "placeBet", "ensureRaceResult", "settleMyBets", "startingCoins", "renameCarry", "syncNameClaim", "transferRequest", "transferCancel", "transferMine"];
const ECON_CARRY_FIELDS = ["coins", "bonus500Granted", "bonus500GrantedAt", "totalBetAmount", "bank", "stocks", "lastLoginBonusDate", "lastAnnouncementReadAt", "slotSpins", "slotWagered", "slotKakuSpins", "slotKakuWagered"];

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
      case "syncNameClaim": return await econSyncNameClaim(deps, uid, name);
      case "transferRequest": return await transferRequest(deps, uid, body);
      case "transferCancel": return await transferCancel(deps, uid, body);
      case "transferMine": return await transferMine(deps, uid);
      default: return econError(400, "unknown_action");
    }
  } catch (error) {
    console.error("economy error", action, String(error?.message || error).slice(0, 300));
    return econError(500, "internal_error");
  }
}

/* 名前クレームの同期：ログイン中のユーザーのユーザー名（本人が所有する users/{名前}）を
   Firebase Authentication のカスタムクレーム name に入れる。Firestore Rules はこの name で
   「チャット・グループの当事者」を判定する。ほかのカスタムクレームは消さずに残す。
   すでに同じ名前なら何もしない（トークンの作り直しを無駄に促さない）。 */
async function setNameClaim(deps, uid, name) {
  const existing = await deps.authAdmin.lookup(uid);
  let claims = {};
  try { claims = existing?.customAttributes ? JSON.parse(existing.customAttributes) : {}; } catch { claims = {}; }
  if (claims.name === name) return false;
  claims.name = name;
  await deps.authAdmin.update(uid, { customAttributes: JSON.stringify(claims) });
  return true;
}

async function econSyncNameClaim(deps, uid, name) {
  const me = await loadMyUser(deps.firestore, uid, name);
  if (me.error) return me.error;
  const changed = await setNameClaim(deps, uid, me.name);
  // changed が true のとき、アプリ側はトークンを再取得（getIdToken(true)）してから購読を始める
  return { ok: true, name: me.name, changed };
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
    // 名前が変わったので、トークンの名前クレームも新しい名前（to）に合わせる（チャットの本人確認用）
    if (!fromRaw) { await setNameClaim(deps, uid, to); return { ok: true, carried: false }; }
    if (fromRaw.fields?.uid?.stringValue !== uid) return econError(409, "rename_from_not_mine");
    const carry = {};
    ECON_CARRY_FIELDS.forEach((f) => { if (f in fromRaw.fields) carry[f] = structuredClone(fromRaw.fields[f]); });
    try {
      await fs.commit([
        { update: { name: fs.docName(`users/${to}`), fields: carry }, updateMask: { fieldPaths: ECON_CARRY_FIELDS }, currentDocument: { updateTime: toRaw.updateTime } },
        { delete: fs.docName(`users/${from}`), currentDocument: { updateTime: fromRaw.updateTime } }
      ]);
      await setNameClaim(deps, uid, to);
      // 名前が入っているチャット・グループ・友達関係を新しい名前に書き換える（from は本人であることを上で確認済み）。
      // ブラウザは他人のメッセージ等を書き換えられないので、この引き継ぎはサーバーが行う。失敗しても引き継ぎ自体は成功扱いにする
      let refs = 0;
      try { refs = await rewriteNameRefs(fs, from, to); } catch (error) { console.error("rename refs rewrite failed", String(error?.message || error).slice(0, 200)); }
      return { ok: true, carried: true, refs };
    } catch (error) {
      if (!isRetryableCommitError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20 + Math.random() * 60 * attempt));
    }
  }
  return econError(409, "busy");
}

/* 名前（ユーザー名）が入っているデータを古い名前から新しい名前に一括で書き換える（サービスアカウント）。
   対象：messages（sender・receiver）／groups（owner・members 配列）／friends（user1・user2・requestedBy・acceptedBy）。
   呼び出し元で「from が本人（または管理者）」であることを必ず確かめてから使うこと。1回の書き込みは 400 件ずつ。 */
async function rewriteNameRefs(fs, from, to) {
  const byPath = new Map(); // path -> { fields, mask:Set }
  const stage = (path, field, value) => {
    const e = byPath.get(path) || { fields: {}, mask: new Set() };
    e.fields[field] = value; e.mask.add(field); byPath.set(path, e);
  };
  for (const field of ["sender", "receiver"]) {
    for (const d of await fs.query("messages", [[field, "EQUAL", from]], { select: [field] })) stage(`messages/${d.id}`, field, to);
  }
  for (const d of await fs.query("groups", [["owner", "EQUAL", from]], { select: ["owner"] })) stage(`groups/${d.id}`, "owner", to);
  for (const d of await fs.query("groups", [["members", "ARRAY_CONTAINS", from]], { select: ["members"] })) {
    const members = (Array.isArray(d.data?.members) ? d.data.members : []).map((m) => (m === from ? to : m));
    stage(`groups/${d.id}`, "members", members);
  }
  for (const field of ["user1", "user2", "requestedBy", "acceptedBy"]) {
    for (const d of await fs.query("friends", [[field, "EQUAL", from]], { select: [field] })) stage(`friends/${d.id}`, field, to);
  }
  const writes = [...byPath.entries()].map(([path, e]) => ({
    update: { name: fs.docName(path), fields: encodeFields(e.fields) },
    updateMask: { fieldPaths: [...e.mask] }
  }));
  for (let i = 0; i < writes.length; i += 400) await fs.commit(writes.slice(i, i + 400));
  return writes.length;
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

/* =========================================================
   🎰 ゆうワールド「ゆうスロ」：サーバー権威のスロット
   ・抽選・配当・残高・着席・精算はすべてサーバーが確定する（クライアントは表示だけ）。
   ・プレイ中（スピン）は Firebase にアクセスしない。残高は「着席時に一度読んだ値＋署名セッションが持つ増減」で管理し、
     一定間隔の flush と退出時の settle のときだけ Firestore にまとめて反映する（増分 increment で冪等）。
   ・公開設定は worldConfig/yuslot（最上位管理者だけが変更）。非公開中は最上位管理者以外は遊べない。
   ========================================================= */

export const SLOT_MACHINES = {
  // rates：台ごとの小当たり（さくらんぼ/ベル/スイカ）の確率。料金が高い台ほど還元率が下がるように調整してある。
  //   当たりやすさ（還元率）の目標：Basic95 / Rush92 / Chance90 / Treasure88 / Rainbow85 / Jackpot82（%）。
  //   確率・配当はここだけで管理し、演出では一切変えない。実測はシミュレーション（yuslot-sim.mjs）で検証する。
  yubasic:    { price: 1, special: "orig",    specialRate: 1 / 290, kakuSpecial: 1 / 320, rates: { cherry: 0.0750, bell: 0.0625, watermelon: 0.0501 } },
  yurush:     { price: 2, special: "orig",    specialRate: 1 / 310, kakuSpecial: 1 / 360, rates: { cherry: 0.0816, bell: 0.0680, watermelon: 0.0544 } },
  yuchance:   { price: 3, special: "triple7", specialRate: 1 / 330, kakuSpecial: 1 / 400, rates: { cherry: 0.0848, bell: 0.0707, watermelon: 0.0565 } },
  yutreasure: { price: 5, special: "triple7", specialRate: 1 / 370, kakuSpecial: 1 / 480, rates: { cherry: 0.0893, bell: 0.0744, watermelon: 0.0596 } },
  yurainbow:  { price: 7, special: "triple7", specialRate: 1 / 365, kakuSpecial: 1 / 560, rates: { cherry: 0.0896, bell: 0.0747, watermelon: 0.0598 } },
  yujackpot:  { price: 9, special: "triple7", specialRate: 1 / 360, kakuSpecial: 1 / 640, rates: { cherry: 0.0892, bell: 0.0744, watermelon: 0.0594 } }
};
export const SLOT_RULES = {
  // 既定値（台ごとに rates で上書きしないときに使う）。freeReplay 以下は全台共通。
  cherry: 0.06, bell: 0.05, watermelon: 0.04, replay: 0.02, star: 0.003, treasure: 0.006,
  freeReplay: 0.01, starFreeSpins: 5, win3Mult: 3, specialMult: 80, feverMs: 20000,
  treasurePrizes: [[3, 0.40], [5, 0.30], [10, 0.20], [20, 0.08], [50, 0.02]]
};
/* 台ごとの実効確率（rates が無い項目は SLOT_RULES の既定値。special は specialRate） */
export function slotRates(machineId, kaku = 1) {
  const m = SLOT_MACHINES[machineId], R = SLOT_RULES, o = m && m.rates ? m.rates : {};
  const k = kaku > 0 ? kaku : 1; // 確変：すべての当たりの確率を同じ倍率で上げる（払い戻しの額は変えない）
  return {
    cherry: (o.cherry != null ? o.cherry : R.cherry) * k,
    bell: (o.bell != null ? o.bell : R.bell) * k,
    watermelon: (o.watermelon != null ? o.watermelon : R.watermelon) * k,
    replay: (o.replay != null ? o.replay : R.replay) * k,
    star: (o.star != null ? o.star : R.star) * k,
    treasure: (o.treasure != null ? o.treasure : R.treasure) * k,
    // 確変のときの大当たりは、通常の台を増やす前の確率（kakuSpecial）を元にする（確変の強さは変えない）
    special: k > 1 ? (m.kakuSpecial != null ? m.kakuSpecial : m.specialRate) * k * SLOT_KAKU_SPECIAL_BOOST : (o.special != null ? o.special : m.specialRate)
  };
}
/* 確変台の倍率（台ごと）。料金が高い台ほど小さい。シミュレーション（notify-worker/yuslot-kaku-sim.mjs）で、小当たりの倍率を30分（自動スピン約900回）の平均 約+600 コインになるように決めたあと、大当たりだけ SLOT_KAKU_SPECIAL_BOOST 倍にした（平均は +800〜+1,400 ほど） */
export const SLOT_KAKU_SPECIAL_BOOST = 1.5; // 確変中は大当たり（777／オリジナル＝FEVER）だけ、さらにこの倍率
export const SLOT_KAKU_RATE = { yubasic: 1.8, yurush: 1.43, yuchance: 1.32, yutreasure: 1.24, yurainbow: 1.23, yujackpot: 1.25 };
const SLOT_FRUITS = ["cherry", "bell", "watermelon"];
const SLOT_FLUSH_INTERVAL_MS = 15000;   // クライアントがこの間隔で flush する
const SLOT_SEAT_GRACE_MS = 90000;       // 復旧猶予（約1分）＋flush の間隔ぶんの余裕
const SLOT_SESSION_MAX_MS = 24 * 3600 * 1000;

/* 営業時間（日本時間 07:00〜23:00）。日次リセットは 07:00 */
function slotJstHour(nowMs) { return new Date(nowMs + 9 * 3600000).getUTCHours(); }
export function slotBusinessOpen(nowMs) { const h = slotJstHour(nowMs); return h >= 7 && h < 23; }
export function slotBusinessDay(nowMs) {
  // 07:00 JST で日付が変わるように、JST から 7 時間引いた日付を使う
  const d = new Date(nowMs + 9 * 3600000 - 7 * 3600000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function slotPickTreasure(random) {
  let r = random();
  for (const [coins, p] of SLOT_RULES.treasurePrizes) { if (r < p) return coins; r -= p; }
  return SLOT_RULES.treasurePrizes[0][0];
}
function slotDisplayPool(machineId) {
  const m = SLOT_MACHINES[machineId];
  return [...SLOT_FRUITS, "replay", "star", "treasure", m.special === "orig" ? "orig" : "triple7"];
}
function slotLoseCenter(machineId, random) {
  const pool = slotDisplayPool(machineId);
  const sp = SLOT_MACHINES[machineId].special === "orig" ? "orig" : "triple7";
  const pick = () => pool[Math.floor(random() * pool.length) % pool.length];
  // 期待感を高めるため、半分くらいのハズレは「リーチの形」（左2つが同じ・右だけ違う）で見せる。
  // たまに特別絵柄（777/オリジナル）の惜しいリーチにする。あくまで表示だけで、配当は0のまま（結果は変えない）。
  if (random() < 0.5) {
    const pairSym = random() < 0.25 ? sp : pick();
    let odd = pick(), guard = 0;
    while (odd === pairSym && guard++ < 8) odd = pick();
    if (odd === pairSym) odd = pool[(pool.indexOf(pairSym) + 1) % pool.length];
    return [pairSym, pairSym, odd];
  }
  let c = [pick(), pick(), pick()];
  if (c[0] === c[1] && c[1] === c[2]) c[2] = pool[(pool.indexOf(c[2]) + 1) % pool.length]; // 3つ揃いは避ける
  return c;
}

/* 1スピンの抽選結果（純粋関数。残高には触れない）。free=無料スピン中、fever=FEVER中 */
export function slotDrawOutcome(machineId, { free = false, fever = false, kaku = 1 } = {}, random = Math.random) {
  const m = SLOT_MACHINES[machineId];
  const R = SLOT_RULES;
  if (!m) throw new Error("unknown_machine");
  const rates = slotRates(machineId, kaku);
  if (fever) {
    // FEVER中はさくらんぼ・ベル・スイカのみ（必ずどれかが揃う）。重みは台ごとの小当たり確率に比例
    const w = [["cherry", rates.cherry], ["bell", rates.bell], ["watermelon", rates.watermelon]];
    const tot = rates.cherry + rates.bell + rates.watermelon;
    let r = random() * tot, pick = "cherry";
    for (const [s, p] of w) { if (r < p) { pick = s; break; } r -= p; }
    return { result: pick, payout: m.price * R.win3Mult, freeAdd: 0, feverStart: false, prize: 0, center: [pick, pick, pick], fever: true };
  }
  const entries = [
    ["cherry", rates.cherry], ["bell", rates.bell], ["watermelon", rates.watermelon],
    ["replay", free ? R.freeReplay : rates.replay],
    ["star", free ? 0 : rates.star],
    ["treasure", rates.treasure],
    ["special", rates.special]
  ];
  let r = random();
  for (const [res, p] of entries) {
    if (p <= 0) continue;
    if (r < p) {
      if (res === "cherry" || res === "bell" || res === "watermelon") return { result: res, payout: m.price * R.win3Mult, freeAdd: 0, feverStart: false, prize: 0, center: [res, res, res] };
      if (res === "replay") return { result: "replay", payout: 0, freeAdd: 1, feverStart: false, prize: 0, center: ["replay", "replay", "replay"] };
      if (res === "star") return { result: "star", payout: 0, freeAdd: R.starFreeSpins, feverStart: false, prize: 0, center: ["star", "star", "star"] };
      if (res === "treasure") { const prize = slotPickTreasure(random); return { result: "treasure", payout: prize, freeAdd: 0, feverStart: false, prize, center: ["treasure", "treasure", "treasure"] }; }
      if (res === "special") { const sym = m.special === "orig" ? "orig" : "triple7"; return { result: "special", symbol: sym, payout: m.price * R.specialMult, freeAdd: 0, feverStart: true, prize: 0, center: [sym, sym, sym] }; }
    }
    r -= p;
  }
  return { result: "lose", payout: 0, freeAdd: 0, feverStart: false, prize: 0, center: slotLoseCenter(machineId, random) };
}

/* セッションに1スピンを適用する（残高・無料スピン・FEVER・統計を更新）。Firestore には触れない */
export function slotApplySpin(session, nowMs, random = Math.random, kakuRate = 0) {
  const price = session.price;
  const fever = nowMs < (session.feverUntil || 0);
  const usingFree = (session.freeSpins || 0) > 0;
  const available = session.startCoins + session.delta;
  if (!usingFree && available < price) return { error: "no_funds" };

  const draw = slotDrawOutcome(session.machine, { free: usingFree, fever, kaku: session.kaku ? (kakuRate || SLOT_KAKU_RATE[session.machine] || 1) : 1 }, random);
  const cost = usingFree ? 0 : price;
  const next = { ...session };
  next.delta = session.delta + draw.payout - cost;
  next.freeSpins = (session.freeSpins || 0) - (usingFree ? 1 : 0) + draw.freeAdd;
  // 特別役の当たりでは FEVER を自動では始めない。「開始待ち（feverPending）」にして、
  // ユーザーが余韻を楽しんでから feverStart アクションで開始する。
  if (draw.feverStart && !fever) next.feverPending = true;
  next.spins = (session.spins || 0) + 1;
  // 会員ランク用の記録：有料の回転数（無料スピンは数えない）と、そのうち確変中の回転数。使ったコイン＝回転数×台の料金
  if (!usingFree) { next.paid = (session.paid || 0) + 1; if (session.kaku) next.kakuPaid = (session.kakuPaid || 0) + 1; }
  const coinWin = draw.payout > 0;
  if (coinWin) { next.wins = (session.wins || 0) + 1; next.streak = (session.streak || 0) + 1; }
  else if (draw.result === "lose") { next.streak = 0; }
  else { next.wins = session.wins || 0; next.streak = session.streak || 0; }
  next.lastMs = nowMs;

  const balance = next.startCoins + next.delta;
  const spin = {
    result: draw.result, center: draw.center, payout: draw.payout, cost, prize: draw.prize,
    freeAdd: draw.freeAdd, coinWin, feverStart: draw.feverStart && !fever, feverPending: next.feverPending === true,
    fever: nowMs < (next.feverUntil || 0), feverUntil: next.feverUntil || 0,
    balance, freeSpins: next.freeSpins, spins: next.spins, wins: next.wins, streak: next.streak
  };
  return { session: next, spin };
}

/* ----- 署名セッション（HMAC-SHA256。鍵はサービスアカウント秘密鍵などから導出） ----- */
async function slotHmacKey(secret) {
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(secret || "")));
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
async function slotSignSession(session, secret) {
  const key = await slotHmacKey(secret);
  const body = base64UrlEncodeString(JSON.stringify(session));
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `${body}.${base64UrlEncodeBytes(new Uint8Array(sig))}`;
}
async function slotVerifySession(token, secret) {
  const [body, sig] = String(token || "").split(".");
  if (!body || !sig) return null;
  const key = await slotHmacKey(secret);
  const ok = await crypto.subtle.verify("HMAC", key, base64UrlDecode(sig), new TextEncoder().encode(body));
  if (!ok) return null;
  try { return JSON.parse(base64UrlDecodeToString(body)); } catch { return null; }
}
function slotRandomHex(n = 16) {
  const b = new Uint8Array(n); crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/* ----- 公開設定（worldConfig/yuslot）。短時間キャッシュしてスピン中の読み取りを避ける ----- */
let slotConfigCache = { value: null, at: 0 };
export function resetYuslotCacheForTest() { slotConfigCache = { value: null, at: 0 }; }
async function slotGetPublished(deps, { maxAgeMs = 30000 } = {}) {
  const now = deps.now();
  if (slotConfigCache.value !== null && now - slotConfigCache.at < maxAgeMs) return slotConfigCache.value;
  try {
    const doc = await deps.firestore.get("worldConfig/yuslot");
    const published = doc?.yuslotPublished === true;
    slotConfigCache = { value: published, at: now };
    return published;
  } catch (error) {
    console.warn("yuslot config read failed", String(error?.message || error).slice(0, 120));
    return slotConfigCache.value === true ? false : false; // 取得失敗は非公開扱い
  }
}
function slotIsTopAdmin(deps, uid) { return uid && uid === deps.adminUid; }

export async function handleYuslotAction(deps, uid, body) {
  const action = typeof body?.action === "string" ? body.action : "";
  try {
    switch (action) {
      case "config": return await yuslotConfig(deps, uid);
      case "setConfig": return await yuslotSetConfig(deps, uid, body);
      case "lobby": return await yuslotLobby(deps, uid);
      case "seat": return await yuslotSeat(deps, uid, body);
      case "spin": return await yuslotSpin(deps, uid, body);
      case "feverStart": return await yuslotFeverStart(deps, uid, body);
      case "flush": return await yuslotFlush(deps, uid, body);
      case "settle": return await yuslotSettle(deps, uid, body);
      case "lotteryStatus": return await lotteryStatus(deps, uid, body);
      case "lotteryBuy": return await lotteryBuy(deps, uid, body);
      case "lotterySetPublished": return await lotterySetPublished(deps, uid, body);
      case "kakuStatus": return await kakuStatus(deps, uid, body);
      case "kakuApply": return await kakuApply(deps, uid, body);
      // 先着は、ゲーム（battle*）を通らないと買えない（kakuQuick を直接呼ぶ入口はない）
      case "battleStatus": return await battleStatus(deps, uid, body);
      case "battleStart": return await battleStart(deps, uid, body);
      case "battleFinish": return await battleFinish(deps, uid, body);
      case "battleRanking": return await battleRanking(deps, uid, body);
      case "battlePractice": return await battlePractice(deps, uid, body);
      case "rankStatus": return await rankStatus(deps, uid, body);
      case "kakuGetNotify": return { ok: true, prefs: await kakuGetNotify(deps, uid) };
      case "kakuSetNotify": return await kakuSetNotify(deps, uid, body);
      default: return { status: 400, error: "unknown_action" };
    }
  } catch (error) {
    console.error("yuslot error", action, String(error?.message || error).slice(0, 300));
    return { status: 500, error: "internal_error" };
  }
}

async function yuslotConfig(deps, uid) {
  const published = await slotGetPublished(deps);
  return { ok: true, published, isTopAdmin: slotIsTopAdmin(deps, uid), open: slotBusinessOpen(deps.now()), serverNowMs: deps.now(), day: slotBusinessDay(deps.now()) };
}

async function yuslotSetConfig(deps, uid, body) {
  if (!slotIsTopAdmin(deps, uid)) return { status: 403, error: "not_top_admin" };
  const published = body?.published === true;
  await deps.firestore.commit([{
    update: { name: deps.firestore.docName("worldConfig/yuslot"), fields: { yuslotPublished: { booleanValue: published }, updatedAtMs: { integerValue: String(deps.now()) }, updatedByUid: { stringValue: uid } } },
    updateMask: { fieldPaths: ["yuslotPublished", "updatedAtMs", "updatedByUid"] }
  }]);
  slotConfigCache = { value: published, at: deps.now() };
  return { ok: true, published };
}

async function yuslotLobby(deps, uid) {
  const published = await slotGetPublished(deps);
  if (!published && !slotIsTopAdmin(deps, uid)) return { status: 403, error: "not_published" };
  const now = deps.now();
  const ids = Object.keys(SLOT_MACHINES);
  const seats = {};
  await Promise.all(ids.map(async (id) => {
    const raw = await deps.firestore.getRaw(`yuslotSeats/${id}`);
    const d = raw ? decodeFields(raw.fields) : null;
    seats[id] = d && Number(d.graceUntilMs || 0) > now ? { name: d.name || "", occupied: true, mine: d.uid === uid } : { occupied: false };
  }));
  return { ok: true, seats, open: slotBusinessOpen(now), serverNowMs: now };
}

async function yuslotSeat(deps, uid, body) {
  const machine = typeof body?.machine === "string" ? body.machine : "";
  if (!SLOT_MACHINES[machine]) return { status: 400, error: "unknown_machine" };
  const published = await slotGetPublished(deps);
  if (!published && !slotIsTopAdmin(deps, uid)) return { status: 403, error: "not_published" };
  const now = deps.now();
  if (!slotBusinessOpen(now)) return { status: 409, error: "closed" };

  // 🌈 確変台は、その時間の枠をとった人だけ（NPC・空き枠は誰も遊べない）
  const kakuRight = await kakuSeatRight(deps, uid, machine, now);
  if (kakuRight && kakuRight.locked) return { status: 409, error: "kaku_locked" };

  const me = await loadMyUser(deps.firestore, uid, body?.username);
  if (me.error) return me.error;
  const startCoins = Number(decodeFields(me.raw.fields).coins || 0);

  const seatPath = `yuslotSeats/${machine}`;
  const raw = await deps.firestore.getRaw(seatPath);
  const cur = raw ? decodeFields(raw.fields) : null;
  if (cur && cur.uid !== uid && Number(cur.graceUntilMs || 0) > now) return { status: 409, error: "seat_taken", name: cur.name || "" };

  const nonce = slotRandomHex();
  const seatFields = {
    uid: { stringValue: uid }, name: { stringValue: me.name }, nonce: { stringValue: nonce },
    machine: { stringValue: machine }, seatedAtMs: { integerValue: String(now) },
    graceUntilMs: { integerValue: String(now + SLOT_SEAT_GRACE_MS) }, flushedTotal: { integerValue: "0" }
  };
  const write = { update: { name: deps.firestore.docName(seatPath), fields: seatFields } };
  if (raw) write.currentDocument = { updateTime: raw.updateTime }; else write.currentDocument = { exists: false };
  try {
    await deps.firestore.commit([write]);
  } catch (error) {
    if (isRetryableCommitError(error) || error.status === 409) return { status: 409, error: "seat_taken" };
    throw error;
  }

  const session = {
    v: 1, uid, name: me.name, machine, price: SLOT_MACHINES[machine].price,
    startCoins, delta: 0, flushed: 0, freeSpins: 0, feverUntil: 0,
    spins: 0, wins: 0, streak: 0, day: slotBusinessDay(now), nonce, seatMs: now, lastMs: now
  };
  if (kakuRight && kakuRight.end) { session.kaku = true; session.kakuEnd = kakuRight.end; } // 確変中（枠の終わりまで）
  const signed = await slotSignSession(session, deps.slotSecret);
  return { ok: true, session: signed, machine, price: session.price, startCoins, name: me.name, balance: startCoins, freeSpins: 0, open: true, serverNowMs: now, day: session.day, kaku: session.kaku === true, kakuEnd: session.kakuEnd || 0 };
}

async function yuslotLoadSession(deps, uid, body) {
  const session = await slotVerifySession(body?.session, deps.slotSecret);
  if (!session || session.uid !== uid) return { error: { status: 401, error: "bad_session" } };
  if (!SLOT_MACHINES[session.machine]) return { error: { status: 400, error: "unknown_machine" } };
  return { session };
}

async function yuslotSpin(deps, uid, body) {
  const now = deps.now();
  const loaded = await yuslotLoadSession(deps, uid, body);
  if (loaded.error) return loaded.error;
  const session = loaded.session;
  // 非公開に切り替わっていたら、一般ユーザーはスピンできない（残りは settle で安全に退出）
  const published = await slotGetPublished(deps);
  if (!published && !slotIsTopAdmin(deps, uid)) return { status: 403, error: "not_published", mustSettle: true };
  if (now - session.seatMs > SLOT_SESSION_MAX_MS) return { status: 409, error: "session_expired", mustSettle: true };
  if (session.day !== slotBusinessDay(now)) return { status: 409, error: "day_rollover", mustSettle: true };
  if (!slotBusinessOpen(now)) return { status: 409, error: "closed", mustSettle: true };
  if (kakuSpinGate(session, now)) return { status: 409, error: "kaku_over", mustSettle: true }; // 確変台の枠が終わった（精算して退席）

  const applied = slotApplySpin(session, now, deps.random);
  if (applied.error) return { status: 409, error: applied.error };
  const signed = await slotSignSession(applied.session, deps.slotSecret);
  return { ok: true, spin: applied.spin, session: signed };
}

/* FEVER を開始する（特別役の当たりで feverPending になっている分を、ユーザー操作のタイミングで始める）。
   Firestore には触れない。連打しても二重開始・報酬重複しない（feverPending を一度だけ消費する）。 */
async function yuslotFeverStart(deps, uid, body) {
  const now = deps.now();
  const loaded = await yuslotLoadSession(deps, uid, body);
  if (loaded.error) return loaded.error;
  const session = loaded.session;
  const alreadyFever = now < (session.feverUntil || 0);
  if (!session.feverPending || alreadyFever) {
    // 開始待ちが無い、またはすでに FEVER 中 → 何もしない（冪等）
    const signed = await slotSignSession(session, deps.slotSecret);
    return { ok: true, started: false, session: signed, fever: alreadyFever, feverUntil: session.feverUntil || 0, serverNowMs: now };
  }
  const next = { ...session, feverUntil: now + SLOT_RULES.feverMs, feverPending: false };
  const signed = await slotSignSession(next, deps.slotSecret);
  return { ok: true, started: true, session: signed, fever: true, feverUntil: next.feverUntil, serverNowMs: now };
}

/* 増減をまとめて Firestore に反映する（flush/settle 共通。seat の flushedTotal で冪等化） */
async function yuslotPersist(deps, uid, session, { release }) {
  const now = deps.now();
  const seatPath = `yuslotSeats/${session.machine}`;
  const raw = await deps.firestore.getRaw(seatPath);
  const cur = raw ? decodeFields(raw.fields) : null;
  // 自分の着席でなく、nonce も違う＝別の人に取られた/すでに解放済み。未反映分は（安全のため）反映しない
  if (!cur || cur.uid !== uid || cur.nonce !== session.nonce) return { ok: true, applied: 0, seatLost: !release };
  const toApply = Math.trunc(session.delta - Number(cur.flushedTotal || 0));
  // 会員ランク用：前回の反映からの、有料の回転数と使ったコイン（users の項目に足すだけ。同じ users の書き込みに入れるので、書き込み回数は増えない）
  const paid = Math.max(0, Math.trunc(session.paid || 0)), kakuPaid = Math.max(0, Math.trunc(session.kakuPaid || 0));
  const dPaid = Math.max(0, paid - Number(cur.flushedPaid || 0)), dKaku = Math.max(0, kakuPaid - Number(cur.flushedKakuPaid || 0));
  const price = Math.max(0, Math.trunc(session.price || 0));
  const incr = (field, n) => ({ fieldPath: field, increment: { integerValue: String(n) } });
  const transforms = [];
  if (toApply !== 0) transforms.push(incr("coins", toApply));
  if (dPaid > 0) { transforms.push(incr("slotSpins", dPaid), incr("slotWagered", dPaid * price)); }
  if (dKaku > 0) { transforms.push(incr("slotKakuSpins", dKaku), incr("slotKakuWagered", dKaku * price)); }
  const writes = [];
  if (transforms.length) {
    writes.push({
      update: { name: deps.firestore.docName(`users/${session.name}`), fields: {} },
      updateMask: { fieldPaths: [] },
      updateTransforms: transforms,
      currentDocument: { exists: true }
    });
  }
  if (release) {
    writes.push({ delete: deps.firestore.docName(seatPath), currentDocument: { updateTime: raw.updateTime } });
  } else {
    writes.push({
      update: { name: deps.firestore.docName(seatPath), fields: { flushedTotal: { integerValue: String(Math.trunc(session.delta)) }, flushedPaid: { integerValue: String(paid) }, flushedKakuPaid: { integerValue: String(kakuPaid) }, graceUntilMs: { integerValue: String(now + SLOT_SEAT_GRACE_MS) }, lastFlushMs: { integerValue: String(now) } } },
      updateMask: { fieldPaths: ["flushedTotal", "flushedPaid", "flushedKakuPaid", "graceUntilMs", "lastFlushMs"] },
      currentDocument: { updateTime: raw.updateTime }
    });
  }
  await deps.firestore.commit(writes);
  return { ok: true, applied: toApply };
}

async function yuslotFlush(deps, uid, body) {
  const loaded = await yuslotLoadSession(deps, uid, body);
  if (loaded.error) return loaded.error;
  const session = loaded.session;
  let res;
  try { res = await yuslotPersist(deps, uid, session, { release: false }); }
  catch (error) { if (isRetryableCommitError(error)) return { status: 409, error: "busy" }; throw error; }
  if (res.seatLost) return { status: 409, error: "seat_lost", mustStop: true };
  const next = { ...session, flushed: Math.trunc(session.delta) };
  const signed = await slotSignSession(next, deps.slotSecret);
  return { ok: true, session: signed, applied: res.applied, balance: session.startCoins + session.delta };
}

async function yuslotSettle(deps, uid, body) {
  const loaded = await yuslotLoadSession(deps, uid, body);
  if (loaded.error) return loaded.error;
  const session = loaded.session;
  let res;
  try { res = await yuslotPersist(deps, uid, session, { release: true }); }
  catch (error) { if (isRetryableCommitError(error)) { res = { ok: true, applied: 0 }; } else throw error; }
  // FEVER・無料スピンは退出で破棄（セッション限りで Firestore に保存していない）
  return { ok: true, applied: res.applied || 0, finalBalance: session.startCoins + session.delta };
}

/* =========================================================
   🎟 ゆう宝くじ売り場（毎週金曜 14:30（日本時間）に抽選。週ごとに名前・賞金が変わる）
   ・抽選・購入・賞金の支払いはすべてサーバーが確定する（クライアントは表示だけ）。
   ・券は1枚ずつ保存せず、ユーザーごとの「購入枚数」だけを lotteryEntries/{回}_{uid} に持つ。
   ・券には番号が付く。番号は 15組 × 100番 ＝ 全1,500通り（1回の抽選につき1,500枚が上限＝売り切れあり）。
     買い方は「連番」（同じ組の続き番号）と「バラ」（空いている番号からランダム）。番号は買った瞬間にサーバーが重ならないように決める。
   ・抽選では、等級ごとの当選番号を3,000通りの中から重ならないように決める（1等は全体で1本）。当選番号の券を持っている人に賞金。
     売れ残った番号が当たったら、その賞金は払わない。1枚あたりの1等の確率は 1/1,500、枚数に比例。
   ・前後賞：1等の番号の前と後ろ（組の端は次の組へつながる）の2本。連番で買うと1等と一緒に当てやすい。
   ・賞金の額は週ごとの倍率で変わる（ふつうの週は ×0.9 / ×0.95 / ×1、ビッグイベントは ×2 など）。7等だけは元返し固定。
   ・販売は「抽選の週の月曜 8:00（日本時間）」に始まり、抽選の5分前に締め切る。抽選のあと次の販売開始までは「準備中」（前回の結果のリプレイだけ見られる）。
   ・1人あたりの購入上限はない（1回の抽選につき全1,500枚が売り切れるまで）。連番は1組（100枚）まで、バラは何枚でも。
   ・抽選は毎分の cron（scheduled）から。決まった時刻に1回だけ実行し、支払い・結果の記録は1回の commit で行う（二重払いなし）。
   ・Firestore の使用量を最小に：購入は「読み取り3回（残高・着席確認1回のクエリ・売れた番号の記録）＋書き込み3件の commit 1回」。
     状態の表示は準備中なら読み取りほぼ0（結果の記録はWorkerのメモリに数分間ためる）、販売中は2回（自分の番号・残高）。抽選は参加者ぶんの読み取りだけ。
   ・ゆうスロに着席中は購入できない（同じコインを二重に使えないように）。
   ・公開設定は worldConfig/lottery（最上位管理者だけが変更）。非公開中は最上位管理者以外は使えない。
   ========================================================= */

export const LOTTERY = {
  price: 10,                 // 1枚の値段（ゆうコイン）
  poolSize: 1500,            // 1回の番号の数（15組 × 100番。売り切れたらその回は買えない）
  perGroup: 100,             // 1組あたりの番号の数
  seqMax: 100,               // 連番で買える最大枚数（1組ぶん）。バラには上限なし
  closeBeforeMs: 5 * 60000,  // 抽選の何ミリ秒前に販売を締め切るか
  tiers: [                   // count＝当たりの本数、prize＝倍率1のときの賞金（fixed は倍率をかけない元返し、adjacent は1等の前後の番号）
    { name: "1等", count: 1, prize: 10000 },
    { name: "前後賞", count: 2, prize: 2500, adjacent: true },
    { name: "2等", count: 1, prize: 3000 },
    { name: "3等", count: 3, prize: 1000 },
    { name: "4等", count: 10, prize: 300 },
    { name: "5等", count: 20, prize: 150 },
    { name: "6等", count: 60, prize: 30 },
    { name: "7等", count: 115, prize: 10, fixed: true }
  ]
};
const LOTTERY_WEEK_MS = 7 * 86400000;
const LOTTERY_EPOCH_MS = Date.UTC(2026, 9, 23, 5, 30, 0); // 最初の抽選：2026-10-23（金）14:30 JST ＝ 05:30 UTC
/* 毎週変わる宝くじの名前（順番に回る） */
const LOTTERY_NAMES = [
  "虹のきらめき宝くじ", "黄金のクローバー宝くじ", "星降る夜の宝くじ", "ゆうドリーム宝くじ", "ハッピーラッキー宝くじ", "七福神の宝くじ",
  "月見だんご宝くじ", "わくわく大漁宝くじ", "ミラクルスターズ宝くじ", "スマイル福引宝くじ", "桜吹雪の宝くじ", "ゆう花火宝くじ"
];
const LOTTERY_BIG_NAMES = ["超ビッグ！ゆうドリームジャンボ", "黄金ミリオン宝くじ", "ゆうスーパージャンボ宝くじ", "レインボー・メガジャンボ"];
/* ふつうの週の賞金の倍率（3週で一回り）／ビッグイベントの週（6週に1回）の倍率 */
const LOTTERY_SCALES = [0.9, 0.95, 1];
const LOTTERY_BIG_SCALE = 2;
/* 日付を決めて特別回にする（YYYY-MM-DD ＝ 抽選の日本時間の日付） */
const LOTTERY_OVERRIDES = {
  "2026-10-23": { name: "🎊 グランドオープン記念！ゆうミリオンジャンボ", scale: 1, big: true }, // 最初の回：1等 10,000
  "2026-12-25": { name: "🎄年末ジャンボ宝くじ", scale: 2, big: true },
  "2027-01-01": { name: "🎍新春お年玉ジャンボ", scale: 1.5, big: true }
};

const lotteryMod = (n, m) => ((n % m) + m) % m;

/* 今より後の、いちばん近い金曜 14:30（JST）の抽選時刻（ミリ秒）。ちょうどの時刻は次の回になる */
export function lotteryNextDrawMs(nowMs) {
  const d = new Date(nowMs);
  let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 5, 30, 0) + lotteryMod(5 - d.getUTCDay(), 7) * 86400000;
  if (t <= nowMs) t += LOTTERY_WEEK_MS;
  return t;
}
export function lotteryRoundId(drawMs) {
  const d = new Date(drawMs + 9 * 3600000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
/* 販売の開始：抽選の週の月曜 8:00（日本時間）。抽選は金曜 14:30 なので、4日と6時間30分前 */
export function lotterySaleStartMs(drawMs) { return drawMs - (4 * 86400000 + 6.5 * 3600000); }

/* その回の名前・賞金の倍率・ビッグイベントかどうか（計算だけで決まる。Firestore には保存しない） */
export function lotteryEventFor(drawMs) {
  const id = lotteryRoundId(drawMs);
  const idx = Math.round((drawMs - LOTTERY_EPOCH_MS) / LOTTERY_WEEK_MS);
  // 6週に1回のビッグイベント。ただし、前後の週が特別回（年末・新春など）のときは、ビッグが続かないように見送る
  const nearSpecial = [-1, 1].some((k) => LOTTERY_OVERRIDES[lotteryRoundId(drawMs + k * LOTTERY_WEEK_MS)]);
  let big = lotteryMod(idx, 6) === 5 && !nearSpecial, name, scale;
  if (big) { name = LOTTERY_BIG_NAMES[lotteryMod(Math.floor(idx / 6), LOTTERY_BIG_NAMES.length)]; scale = LOTTERY_BIG_SCALE; }
  else { name = LOTTERY_NAMES[lotteryMod(idx, LOTTERY_NAMES.length)]; scale = LOTTERY_SCALES[lotteryMod(idx, LOTTERY_SCALES.length)]; }
  const o = LOTTERY_OVERRIDES[id];
  if (o) { name = o.name; scale = o.scale; big = o.big === true; }
  return { id, drawMs, saleStartMs: lotterySaleStartMs(drawMs), closeMs: drawMs - LOTTERY.closeBeforeMs, index: idx, name, scale, big, price: LOTTERY.price };
}
/* 等級ごとの賞金（その回の倍率を反映。元返し等級は倍率をかけない） */
export function lotteryPrizeOf(tier, scale) {
  if (tier.fixed) return tier.prize;
  const v = tier.prize * scale;
  return v >= 100 ? Math.round(v / 10) * 10 : Math.round(v); // 100以上は10コイン単位に丸める
}
/* その回の等級の一覧（表示用） */
export function lotteryTiersFor(scale) { return LOTTERY.tiers.map((t) => ({ name: t.name, count: t.count, prize: lotteryPrizeOf(t, scale), ...(t.adjacent ? { adjacent: true } : {}) })); }
/* 番号（0〜1499）の表示：01組000番〜15組099番 */
export function lotteryNumberLabel(n) {
  return `${String(Math.floor(n / LOTTERY.perGroup) + 1).padStart(2, "0")}組${String(n % LOTTERY.perGroup).padStart(3, "0")}番`;
}

/* 当選番号を決める（純粋関数）：1等 → 前後賞（1等の前後。端は輪になってつながる）→ ほかの等級を、重ならないように引く */
export function lotteryPrizeNumbers(random) {
  const N = LOTTERY.poolSize, taken = new Set(), out = [];
  const add = (tier, number) => { taken.add(number); out.push({ tier: tier.name, number }); };
  const pick = () => {
    for (let k = 0; k < 64; k++) { const n = Math.floor(random() * N); if (!taken.has(n)) return n; }
    for (let n = 0; n < N; n++) if (!taken.has(n)) return n; // 乱数が偏っていても必ず終わる
    return 0;
  };
  const first = LOTTERY.tiers[0];
  const top = pick(); add(first, top);
  for (const t of LOTTERY.tiers) if (t.adjacent) { add(t, (top + N - 1) % N); add(t, (top + 1) % N); }
  for (const t of LOTTERY.tiers) {
    if (t === first || t.adjacent) continue;
    for (let k = 0; k < t.count; k++) add(t, pick());
  }
  return out;
}

/* 当選番号の券を持っている人を探して、賞金を決める（純粋関数）。1人が複数の番号に当たることもある */
export function lotteryDrawWinners(entries, scale, prizes) {
  const owner = new Map();
  for (const e of entries) for (const n of e.numbers || []) owner.set(n, e);
  const winners = [];
  for (const pr of prizes) {
    const e = owner.get(pr.number);
    if (!e) continue; // 売れ残りの番号は払わない
    winners.push({ uid: e.uid, name: e.name, tier: pr.tier, number: pr.number, amount: lotteryPrizeOf(LOTTERY.tiers.find((t) => t.name === pr.tier), scale) });
  }
  return winners;
}

/* 番号の割り当て（純粋関数）。soldBits は 1,500 文字の "0"/"1"（1＝売れた）。
   mode "seq"＝同じ組の続き番号（連番）、"random"＝空いている番号からランダム */
export function lotteryAllocate(soldBits, count, mode, random) {
  const N = LOTTERY.poolSize, G = LOTTERY.perGroup;
  const free = [];
  for (let i = 0; i < N; i++) if (soldBits[i] !== "1") free.push(i);
  if (free.length < count) return { error: "sold_out", remaining: free.length };
  if (mode === "seq" && count > 1) {
    const starts = [];
    for (let g = 0; g < N / G; g++) {
      let run = 0;
      for (let k = 0; k < G; k++) {
        const i = g * G + k;
        run = soldBits[i] === "1" ? 0 : run + 1;
        if (run >= count) starts.push(i - count + 1);
      }
    }
    if (!starts.length) return { error: "no_consecutive" };
    const s = starts[Math.floor(random() * starts.length)];
    return { numbers: Array.from({ length: count }, (_, k) => s + k) };
  }
  for (let k = 0; k < count; k++) { // 部分シャッフル
    const j = k + Math.floor(random() * (free.length - k));
    const t = free[k]; free[k] = free[j]; free[j] = t;
  }
  return { numbers: free.slice(0, count).sort((a, b) => a - b) };
}

/* 番号の数を 3,000 → 1,500 に減らしたときの引っ越し：古い売れた番号の表（3,000文字）の回を、1,500通りに直す。
   1,500 未満の番号はそのまま。1,500 以上の番号を持っている人だけ、空いている番号（1,500未満）に付け替える（連番は同じ組の続き番号のまま）。
   ・合計の枚数・買った人・コインは変わらない。売れた番号の表と、付け替える人の番号を、1回の commit（更新時刻の条件つき）で書く。
   ・すでに 1,500 文字なら何もしない（何度呼んでも安全）。1,500 枚を超えて売れていたら、何も変えずに知らせる（aborted）。 */
export async function lotteryResizeRound(deps, roundId) {
  const fs = deps.firestore, N = LOTTERY.poolSize;
  for (let attempt = 0; attempt < 5; attempt++) {
    const roundRaw = await fs.getRaw(`lotteryRounds/${roundId}`);
    if (!roundRaw) return { skipped: "no_round" };
    const round = decodeFields(roundRaw.fields);
    if (typeof round.soldBits !== "string" || round.soldBits.length === N) return { skipped: "ok" };
    if (round.status === "done") return { skipped: "done" };
    const docs = await fs.query("lotteryEntries", [["round", "EQUAL", roundId]]);
    const entries = docs.map((d) => ({ id: d.id, updateTime: d.updateTime, numbers: Array.isArray(d.data.numbers) ? d.data.numbers.filter((n) => Number.isInteger(n) && n >= 0) : [] })).filter((e) => e.numbers.length > 0);
    const total = entries.reduce((sum, e) => sum + e.numbers.length, 0);
    if (total > N) return { aborted: "too_many", tickets: total };
    const bits = Array(N).fill("0");
    entries.forEach((e) => e.numbers.forEach((n) => { if (n < N) bits[n] = "1"; }));
    const plan = [];
    for (const e of entries.filter((x) => x.numbers.some((n) => n >= N))) {
      const keep = e.numbers.filter((n) => n < N);
      const move = e.numbers.filter((n) => n >= N).sort((a, b) => a - b);
      const consecutive = move.length > 1 && move.every((n, i) => i === 0 || n === move[i - 1] + 1);
      let alloc = consecutive ? lotteryAllocate(bits.join(""), move.length, "seq", deps.random) : null;
      if (!alloc || alloc.error) alloc = lotteryAllocate(bits.join(""), move.length, "random", deps.random);
      if (alloc.error) return { aborted: "no_room", tickets: total };
      alloc.numbers.forEach((n) => { bits[n] = "1"; });
      plan.push({ id: e.id, updateTime: e.updateTime, numbers: [...keep, ...alloc.numbers].sort((a, b) => a - b) });
    }
    if (plan.length > 400) return { aborted: "too_many_entries", tickets: total };
    const writes = [{ update: { name: fs.docName(`lotteryRounds/${roundId}`), fields: encodeFields({ soldBits: bits.join("") }) }, updateMask: { fieldPaths: ["soldBits"] }, currentDocument: { updateTime: roundRaw.updateTime } }];
    plan.forEach((x) => writes.push({ update: { name: fs.docName(`lotteryEntries/${x.id}`), fields: encodeFields({ numbers: x.numbers }) }, updateMask: { fieldPaths: ["numbers"] }, currentDocument: { updateTime: x.updateTime } }));
    try { await fs.commit(writes); }
    catch (error) { if (isRetryableCommitError(error)) continue; throw error; } // 途中で誰かが買った等：読み直してやり直す
    lotteryDocCache.delete(`lotteryRounds/${roundId}`);
    return { ok: true, moved: plan.length, tickets: total };
  }
  return { skipped: "busy" };
}
const lotteryIsLegacyBits = (round) => typeof round?.soldBits === "string" && round.soldBits.length !== LOTTERY.poolSize;

let lotteryConfigCache = { value: null, at: 0 };
let lotteryDocCache = new Map();
const lotteryDrawDone = new Set();
export function resetLotteryCacheForTest() { lotteryConfigCache = { value: null, at: 0 }; lotteryDocCache = new Map(); lotteryDrawDone.clear(); }

async function lotteryGetPublished(deps, maxAgeMs = 60000) {
  const now = deps.now();
  if (lotteryConfigCache.value !== null && now - lotteryConfigCache.at < maxAgeMs) return lotteryConfigCache.value;
  try {
    const doc = await deps.firestore.get("worldConfig/lottery");
    lotteryConfigCache = { value: doc?.lotteryPublished === true, at: now };
    return lotteryConfigCache.value;
  } catch (error) {
    console.warn("lottery config read failed", String(error?.message || error).slice(0, 120));
    return false; // 取得失敗は非公開扱い
  }
}
/* ttlMs は数値、または「読んだ中身から決める関数」。確定した（done）回の結果は変わらないので長くためる */
const lotteryDoneTtl = (data) => (data && data.status === "done" ? 600000 : 15000);
async function lotteryCachedGet(deps, path, ttlMs = 30000) {
  const now = deps.now();
  const hit = lotteryDocCache.get(path);
  if (hit && now - hit.at < (typeof ttlMs === "function" ? ttlMs(hit.data) : ttlMs)) return hit.data;
  const data = await deps.firestore.get(path);
  lotteryDocCache.set(path, { data, at: now });
  return data;
}

const lotteryYen = (n) => Number(n || 0).toLocaleString("ja-JP");

/* 結果発表のお知らせ（📢）＋プッシュ通知。お知らせは固定IDで1件だけ、通知は notificationLogs で二重送信しない */
async function lotteryAnnounce(deps, id, round) {
  const fs = deps.firestore;
  const ws = Array.isArray(round.winners) ? round.winners : [];
  const nums = Array.isArray(round.prizeNumbers) ? round.prizeNumbers : [];
  const lines = [`「${round.name}」の抽選結果です！（販売 ${lotteryYen(round.tickets)} 枚）`];
  for (const t of lotteryTiersFor(Number(round.scale) || 1)) {
    const w = ws.filter((x) => x.tier === t.name);
    if (t.count <= 3) { // 1等・前後賞・2等・3等は当選番号と当選者を出す
      const items = nums.filter((n) => n.tier === t.name).map((n) => { const h = w.find((x) => x.number === n.number); return `${lotteryNumberLabel(n.number)} ${h ? h.name + "さん" : "（売れ残り）"}`; });
      lines.push(`${t.name}（${lotteryYen(t.prize)} コイン）：${items.join("、")}`);
    } else if (w.length) lines.push(`${t.name}（${lotteryYen(t.prize)} コイン）：${w.length}名`);
  }
  lines.push(ws.length ? "当選したみなさんには、ゆうコインをお渡ししました🎁" : "今回は当選者がいませんでした。");
  const now = new Date(deps.now());
  await fs.createIfAbsent(`announcements/lottery-${id}`, {
    title: truncate(`🎟 ${round.name} 結果発表！`, 50), body: truncate(lines.join("\n"), 480),
    createdAt: now, updatedAt: now, createdByUid: "yuuchat-lottery", createdByName: "ゆう宝くじ売り場"
  });
  try { await notifyNewAnnouncement(deps, `lottery-${id}`); }
  catch (error) { console.warn("lottery notify failed", String(error?.message || error).slice(0, 120)); }
  await fs.update(`lotteryRounds/${id}`, { announced: true });
}

/* 抽選の実行。売上が1枚も無い回（ドキュメントが無い）は何もしない。支払いと結果の記録は1回の commit（二重払いなし） */
export async function lotteryRunDraw(deps, drawMs) {
  const fs = deps.firestore, ev = lotteryEventFor(drawMs);
  const roundPath = `lotteryRounds/${ev.id}`;
  let raw = await fs.getRaw(roundPath);
  if (!raw) return { status: "no_sales", id: ev.id };
  let round = decodeFields(raw.fields);
  if (round.status === "done") {
    if (round.announced !== true) await lotteryAnnounce(deps, ev.id, round);
    return { status: "done", id: ev.id };
  }
  if (lotteryIsLegacyBits(round)) { // 番号の数を減らす前の回なら、抽選の前に番号を付け替える（付け替えで更新時刻が変わるので読み直す）
    await lotteryResizeRound(deps, ev.id);
    raw = await fs.getRaw(roundPath); round = decodeFields(raw.fields);
  }
  const docs = await fs.query("lotteryEntries", [["round", "EQUAL", ev.id]]);
  const entries = docs.map((d) => ({ uid: d.data.uid, name: d.data.name, numbers: Array.isArray(d.data.numbers) ? d.data.numbers.filter((n) => Number.isInteger(n) && n >= 0 && n < LOTTERY.poolSize) : [] })).filter((e) => e.numbers.length > 0 && e.uid && e.name);
  const tickets = entries.reduce((s, e) => s + e.numbers.length, 0);
  const salesCoins = tickets * ev.price;
  const prizeNumbers = lotteryPrizeNumbers(deps.random);
  let winners = lotteryDrawWinners(entries, ev.scale, prizeNumbers);

  // 実在するユーザー（uid が一致）だけに払う。払えない分は払わない（持ち越しなし）
  const uidOf = new Map(entries.map((e) => [e.name, e.uid]));
  const names = [...new Set(winners.map((w) => w.name))];
  const userDocs = names.length ? await fs.batchGet(names.map((n) => `users/${n}`)) : [];
  const valid = new Set(names.filter((n, i) => userDocs[i] && userDocs[i].uid === uidOf.get(n)));
  winners = winners.filter((w) => valid.has(w.name));

  const paid = winners.reduce((s, w) => s + w.amount, 0);
  const byName = new Map();
  winners.forEach((w) => byName.set(w.name, (byName.get(w.name) || 0) + w.amount));
  const writes = [...byName].map(([name, amount]) => ({
    update: { name: fs.docName(`users/${name}`), fields: {} },
    updateMask: { fieldPaths: [] },
    updateTransforms: [{ fieldPath: "coins", increment: restInt(amount) }],
    currentDocument: { exists: true }
  }));
  const done = {
    status: "done", name: ev.name, big: ev.big, scale: ev.scale, drawMs, tickets, sales: salesCoins, paid,
    prizeNumbers, winners: winners.map((w) => ({ uid: w.uid, name: w.name, tier: w.tier, number: w.number, amount: w.amount })), drawnAtMs: deps.now(), announced: false
  };
  writes.push({
    update: { name: fs.docName(roundPath), fields: encodeFields(done) },
    updateMask: { fieldPaths: Object.keys(done) },
    currentDocument: { updateTime: raw.updateTime } // 同時に別の抽選が走っても、先に終わった1回だけが有効
  });
  await fs.commit(writes);
  lotteryDocCache.delete(roundPath);
  await lotteryAnnounce(deps, ev.id, done);
  return { status: "drawn", id: ev.id, paid, tickets, winners: winners.length };
}

/* 毎分の cron から呼ぶ。直近の抽選時刻の直後（最初の10分は毎分、そのあと24時間は15分ごと）だけ動く。
   それ以外の分は Firestore に触れずにすぐ戻る */
export async function runLotteryTick(env = {}, scheduledTime = Date.now(), deps = null) {
  const drawMs = lotteryNextDrawMs(scheduledTime) - LOTTERY_WEEK_MS;
  const since = scheduledTime - drawMs;
  if (since < 0 || since > 24 * 3600000) return { skipped: "outside" };
  const mins = Math.floor(since / 60000);
  if (!(mins < 10 || mins % 15 === 0)) return { skipped: "throttle" };
  const id = lotteryRoundId(drawMs);
  if (lotteryDrawDone.has(id)) return { skipped: "done" };
  const d = deps || createDefaultDeps(env);
  const r = await lotteryRunDraw(d, drawMs);
  if (r.status === "done" || r.status === "drawn" || r.status === "no_sales") lotteryDrawDone.add(id);
  return r;
}

async function lotterySeatedElsewhere(deps, uid, now) {
  // 6台ぶんを1台ずつ読まず、「自分の uid の席」を1回のクエリで探す（読み取り6回 → 1回）
  const docs = await deps.firestore.query("yuslotSeats", [["uid", "EQUAL", uid]]);
  return docs.some((d) => Number(d.data.graceUntilMs || 0) > now);
}

async function lotterySetPublished(deps, uid, body) {
  if (!slotIsTopAdmin(deps, uid)) return { status: 403, error: "not_top_admin" };
  const published = body?.published === true;
  await deps.firestore.commit([{
    update: { name: deps.firestore.docName("worldConfig/lottery"), fields: { lotteryPublished: { booleanValue: published }, updatedAtMs: { integerValue: String(deps.now()) }, updatedByUid: { stringValue: uid } } },
    updateMask: { fieldPaths: ["lotteryPublished", "updatedAtMs", "updatedByUid"] }
  }]);
  lotteryConfigCache = { value: published, at: deps.now() };
  return { ok: true, published };
}

async function lotteryStatus(deps, uid, body) {
  const now = deps.now();
  const admin = slotIsTopAdmin(deps, uid);
  const published = await lotteryGetPublished(deps);
  if (!published && !admin) return { ok: true, published: false, isTopAdmin: false, serverNowMs: now };
  const drawMs = lotteryNextDrawMs(now);
  const ev = lotteryEventFor(drawMs);
  const prevId = lotteryRoundId(drawMs - LOTTERY_WEEK_MS);
  const phase = now < ev.saleStartMs ? "preparing" : now < ev.closeMs ? "selling" : "closed";
  // 前回の結果（確定した回は変わらないので、Worker のメモリに数分ためて読み取りを減らす）
  const prev = await lotteryCachedGet(deps, `lotteryRounds/${prevId}`, lotteryDoneTtl);
  const done = prev && prev.status === "done";
  const ws = done && Array.isArray(prev.winners) ? prev.winners : [];
  const topTiers = new Set(LOTTERY.tiers.filter((t) => t.count <= 3).map((t) => t.name)); // 1等・前後賞・2等・3等は当選番号と当選者を表示
  const pn = done && Array.isArray(prev.prizeNumbers) ? prev.prizeNumbers : [];
  const last = done ? {
    id: prevId, name: prev.name, big: prev.big === true, drawMs: prev.drawMs, tickets: prev.tickets, paid: prev.paid,
    numbers: pn.filter((n) => topTiers.has(n.tier)).map((n) => { const h = ws.find((w) => w.number === n.number); return { tier: n.tier, number: n.number, name: h ? h.name : null }; }),
    winnerCount: ws.length,
    tiers: lotteryTiersFor(Number(prev.scale) || 1).map((t) => ({ ...t, hit: ws.filter((w) => w.tier === t.name).length })), // 抽選会ショー用（その回の賞金と、等級ごとの当選口数）
    myWins: ws.filter((w) => w.uid === uid).map((w) => ({ tier: w.tier, number: w.number, amount: w.amount })),
    myWin: ws.filter((w) => w.uid === uid).reduce((s, w) => s + (Number(w.amount) || 0), 0)
  } : null;
  const base = { ok: true, published, isTopAdmin: admin, serverNowMs: now, phase, last, prev: { id: prevId, drawMs: drawMs - LOTTERY_WEEK_MS } }; // prev＝前回の回（結果の集計待ちかどうかの判定用）
  if (phase === "preparing") {
    // 次の回の販売が始まるまでは「準備中」。名前・賞金は出さず、自分の番号や残高も読まない（読み取りなし）
    return { ...base, open: false, event: { id: ev.id, drawMs: ev.drawMs, saleStartMs: ev.saleStartMs, closeMs: ev.closeMs, price: ev.price } };
  }
  let [round, entry, me] = await Promise.all([
    lotteryCachedGet(deps, `lotteryRounds/${ev.id}`, 30000),
    deps.firestore.get(`lotteryEntries/${ev.id}_${uid}`),
    loadMyUser(deps.firestore, uid, body?.username)
  ]);
  if (lotteryIsLegacyBits(round)) { // 番号の数を減らす前の回：番号を付け替えてから、読み直す
    await lotteryResizeRound(deps, ev.id).catch(() => {});
    [round, entry] = await Promise.all([lotteryCachedGet(deps, `lotteryRounds/${ev.id}`, 0), deps.firestore.get(`lotteryEntries/${ev.id}_${uid}`)]);
  }
  const tickets = Number(round?.tickets) || 0;
  const myNumbers = Array.isArray(entry?.numbers) ? entry.numbers : [];
  return {
    ...base,
    event: { id: ev.id, name: ev.name, big: ev.big, price: ev.price, drawMs: ev.drawMs, saleStartMs: ev.saleStartMs, closeMs: ev.closeMs, scale: ev.scale },
    open: phase === "selling",
    tickets, pool: LOTTERY.poolSize, remaining: Math.max(0, LOTTERY.poolSize - tickets),
    tiers: lotteryTiersFor(ev.scale),
    myTickets: myNumbers.length, myNumbers,
    balance: me.error ? null : Number(decodeFields(me.raw.fields).coins || 0),
    limits: { seqMax: LOTTERY.seqMax }
  };
}

async function lotteryBuy(deps, uid, body) {
  const count = Number(body?.count);
  if (!Number.isInteger(count) || count < 1 || count > LOTTERY.poolSize) return { status: 400, error: "bad_count" };
  const mode = body?.mode === "seq" ? "seq" : "random";
  const now = deps.now();
  const published = await lotteryGetPublished(deps);
  if (!published && !slotIsTopAdmin(deps, uid)) return { status: 403, error: "not_published" };
  const ev = lotteryEventFor(lotteryNextDrawMs(now));
  if (now < ev.saleStartMs) return { status: 409, error: "not_started", saleStartMs: ev.saleStartMs };
  if (now >= ev.closeMs) return { status: 409, error: "sales_closed" };
  if (mode === "seq" && count > LOTTERY.seqMax) return { status: 409, error: "no_consecutive" }; // 連番は1組（100枚）まで

  const me = await loadMyUser(deps.firestore, uid, body?.username);
  if (me.error) return me.error;
  const coins = Number(decodeFields(me.raw.fields).coins || 0);
  const cost = ev.price * count;
  if (coins < cost) return { status: 409, error: "insufficient_coins" };
  if (await lotterySeatedElsewhere(deps, uid, now)) return { status: 409, error: "seated" };

  // 売れた番号の記録（その回のドキュメント）を読んで、重ならない番号を決める。書き込みはその記録の更新時刻を条件にする
  // → 同時に別の人が買っていたら、どちらか一方だけが成功し、もう一方は「もう一度」になる（番号が重ならない）
  const entryPath = `lotteryEntries/${ev.id}_${uid}`;
  const roundPath = `lotteryRounds/${ev.id}`;
  const roundRaw = await deps.firestore.getRaw(roundPath);
  const round = roundRaw ? decodeFields(roundRaw.fields) : {};
  const N = LOTTERY.poolSize;
  if (lotteryIsLegacyBits(round)) { // 番号の数を減らす前の回：先に番号を付け替える（付け替えが済むまでは買えない）
    const m = await lotteryResizeRound(deps, ev.id).catch(() => ({}));
    return { status: 409, error: m.ok ? "busy" : "preparing" };
  }
  const bits = typeof round.soldBits === "string" && round.soldBits.length === N ? round.soldBits : "0".repeat(N);
  const alloc = lotteryAllocate(bits, count, mode, deps.random);
  if (alloc.error) return { status: 409, error: alloc.error, remaining: alloc.remaining };
  const next = bits.split("");
  alloc.numbers.forEach((n) => { next[n] = "1"; });
  const nextBits = next.join("");
  const totalTickets = nextBits.split("1").length - 1;
  const roundFields = { round: ev.id, name: ev.name, tickets: totalTickets, sales: totalTickets * ev.price, soldBits: nextBits };
  try {
    await deps.firestore.commit([
      { update: { name: deps.firestore.docName(`users/${me.name}`), fields: { coins: restInt(coins - cost) } }, updateMask: { fieldPaths: ["coins"] }, currentDocument: { updateTime: me.raw.updateTime } },
      // 自分の番号は「追加」で書く（読まずに済む。同じ番号は重ならないので順番どおりに増えるだけ）
      { update: { name: deps.firestore.docName(entryPath), fields: encodeFields({ uid, name: me.name, round: ev.id }) }, updateMask: { fieldPaths: ["uid", "name", "round"] },
        updateTransforms: [{ fieldPath: "numbers", appendMissingElements: { values: alloc.numbers.map((n) => restInt(n)) } }] },
      { update: { name: deps.firestore.docName(roundPath), fields: encodeFields(roundFields) }, updateMask: { fieldPaths: Object.keys(roundFields) }, currentDocument: roundRaw ? { updateTime: roundRaw.updateTime } : { exists: false } }
    ]);
  } catch (error) {
    if (isRetryableCommitError(error)) return { status: 409, error: "busy" }; // 残高や売れた番号が同時に変わった等。もう一度
    throw error;
  }
  lotteryDocCache.delete(roundPath);
  return { ok: true, bought: count, numbers: alloc.numbers, balance: coins - cost, cost, mode, tickets: totalTickets, remaining: Math.max(0, N - totalTickets) };
}

/* =========================================================
   🌈 ゆうスロ「確変台」（毎日どこか1台が、抽選・先着で権利をとった人だけの高還元の台になる）
   ・確変台は日付からの決まったランダムで決まる（前日と同じ台は避ける）。Firestore には保存しなくても分かる。
   ・時間割（日本時間）：8:00〜12:30 は30分×9枠／12:30〜13:20 は10分×5枠（当日分：抽選3・先着2。どれが抽選・先着かは日ごとにランダム）
     ／13:20〜15:20 は30分×4枠。合計18枠。
   ・前日の抽選（30分枠13個）：前日 12:00 に公開・申込開始 → 21:00 締切・抽選 → 当日 7:50 に結果のお知らせ。
   ・当日の抽選（10分枠3個）：7:00〜10:45 に申込 → 10:45 に抽選。先着（10分枠2個・1人1枠）：11:45 から。
   ・抽選は「ダミー（NPC）の仮想申込者」を混ぜて、実在の申込者が当たる確率が、平日は約20%・土日は約5%になるようにする（アカウントは作らない）。
     1人が同じ日に当たれるのは最大3枠。2枠目・3枠目は当たりにくい重み（×0.2）をかける。
   ・遊べるのは、その時間の枠をとった人だけ（NPC・空き枠は誰も遊べない）。8:00 前と 15:20 以降は通常の台。
   ・確変中は、すべての当たりの確率を台ごとの倍率で上げる（SLOT_KAKU_RATE）。
   ・Firestore：yuslotKaku/{日付}（サーバー専用）。申込は appendMissingElements で追記するだけ。毎分の cron は予定の時刻以外は何も読まない。
   ・通知の好み：yuslotPrefs/{uid}（サーバー専用）。先着の通知はなし。
========================================================= */

export const KAKU_EPOCH = "2026-10-20";                 // 最初の確変の日
const KAKU_JST = 9 * 3600000, KAKU_DAY_MS = 86400000, KAKU_MIN = 60000;
const KAKU_PRE_STARTS = [480, 510, 540, 570, 600, 630, 660, 690, 720, 800, 830, 860, 890]; // 30分枠（8:00〜12:00／13:20〜14:50）
const KAKU_SAME_STARTS = [750, 760, 770, 780, 790];     // 12:30〜13:10 の10分枠（当日分）
const KAKU_WIN_RATE = { weekday: 0.2, weekend: 0.05 };  // 実在の申込者が抽選に当たる割合（平日は約20%、土日は約5%）
export function kakuIsWeekend(dayId) { const w = new Date(kakuDayStart(dayId) + KAKU_JST).getUTCDay(); return w === 0 || w === 6; }
/* 申込者＋NPC の人数＝枠数 ÷ 当たる割合（申込者が少ないほど NPC が多く混ざる。申込者がこれより多い日は、割合はもっと低くなる） */
export function kakuPoolFor(dayId, type) {
  const count = type === 1 ? KAKU_PRE_STARTS.length : 3;
  return Math.round(count / (kakuIsWeekend(dayId) ? KAKU_WIN_RATE.weekend : KAKU_WIN_RATE.weekday));
}
const KAKU_MAX_PER_DAY = 3, KAKU_REPEAT_WEIGHT = 0.2;
const KAKU_BIAS = 1.5; // 申込者ごとの重みの調整の幅（小さな差）
export const KAKU_MACHINE_NAMES = { yubasic: "ゆうベーシック", yurush: "ゆうラッシュ", yuchance: "ゆうチャンス", yutreasure: "ゆうトレジャー", yurainbow: "ゆうレインボー", yujackpot: "ゆうジャックポット" };
const KAKU_NPC_NAMES = ["ほしぞら", "みかん", "ひなた", "そらまめ", "もちもち", "さくら", "こはる", "はるか", "ゆうき", "りんご", "ぽんた", "だいふく", "ねこまる", "ことり", "つばさ", "あおぞら", "ひまわり", "にじいろ", "まっちゃ", "きなこ", "わかば", "ふうた", "らいむ", "みずほ", "もも", "ぱんだ", "くるみ", "かずは", "しろくま", "ゆずぽん", "たいよう", "なないろ", "ちくわ", "おにぎり", "どんぐり", "ふわふわ", "きらきら", "しおり", "あんず", "れもん", "すいか", "ぷりん", "こむぎ", "ゆきうさぎ", "ひよこ", "ののか", "あかり", "みどり", "そうた", "かなた", "いちご", "めろん", "こうめ", "とまと", "ぽぷら", "りく", "はなび", "ほたる", "かぜのこ", "つきみ"];
export const KAKU_NOTIFY_DEFAULTS = { pub: false, same: false, result1: true, result2: true };

export function kakuDayId(ms) {
  const d = new Date(ms + KAKU_JST);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
export function kakuDayStart(dayId) { const [y, m, d] = dayId.split("-").map(Number); return Date.UTC(y, m - 1, d) - KAKU_JST; }
export function kakuNextDay(dayId) { return kakuDayId(kakuDayStart(dayId) + KAKU_DAY_MS); }
export function kakuTimes(dayId) {
  const t0 = kakuDayStart(dayId), H = 3600000;
  return { dayStart: t0, preOpen: t0 - 12 * H, preClose: t0 - 3 * H, sameOpen: t0 + 7 * H, resultAt: t0 + 7 * H + 50 * KAKU_MIN, playStart: t0 + 8 * H,
    sameClose: t0 + 10 * H + 45 * KAKU_MIN, quickOpen: t0 + 11 * H + 45 * KAKU_MIN, playEnd: t0 + 15 * H + 20 * KAKU_MIN };
}
function kakuHash(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function kakuMulberry(a) { return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function kakuSeeded(seed) { return kakuMulberry(kakuHash(seed)); }

/* その日の確変台（日付だけで決まる。前日と同じ台は避ける） */
const kakuMachineCache = new Map();
export function kakuMachineFor(dayId) {
  if (dayId < KAKU_EPOCH) return null;
  if (kakuMachineCache.has(dayId)) return kakuMachineCache.get(dayId);
  const ids = Object.keys(SLOT_MACHINES);
  let prev = null, d = KAKU_EPOCH, out = null;
  for (let guard = 0; guard < 2000; guard++) {
    const pool = ids.filter((x) => x !== prev);
    const m = pool[Math.floor(kakuSeeded("machine:" + d)() * pool.length) % pool.length];
    kakuMachineCache.set(d, m);
    if (d === dayId) { out = m; break; }
    prev = m; d = kakuNextDay(d);
  }
  return out;
}
/* 当日分の10分枠5個のうち、先着にする2個（残り3個が抽選）。日ごとにランダム */
export function kakuSameKinds(dayId) {
  const r = kakuSeeded("kinds:" + dayId);
  const idx = [0, 1, 2, 3, 4];
  for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
  const quick = new Set(idx.slice(0, 2));
  return KAKU_SAME_STARTS.map((_, i) => (quick.has(i) ? "quick" : "lot"));
}
export function kakuInitialSlots(dayId) {
  const t0 = kakuDayStart(dayId), kinds = kakuSameKinds(dayId), slots = [];
  KAKU_PRE_STARTS.forEach((m) => slots.push({ s: t0 + m * KAKU_MIN, e: t0 + (m + 30) * KAKU_MIN, kind: "pre", uid: "", name: "", npc: false }));
  KAKU_SAME_STARTS.forEach((m, i) => slots.push({ s: t0 + m * KAKU_MIN, e: t0 + (m + 10) * KAKU_MIN, kind: kinds[i], uid: "", name: "", npc: false }));
  slots.sort((a, b) => a.s - b.s);
  return slots.map((x, i) => ({ i, ...x }));
}
export function kakuNpcName(dayId, i) { return KAKU_NPC_NAMES[(kakuHash("npc:" + dayId) + i) % KAKU_NPC_NAMES.length]; }

/* 申込者ごとの重みの調整に使う値（0〜1）。総資産ランキングの順位から（rankings/assets の users）。ランキングに無い人は 0.5 */
export function kakuStanding(rows, names) {
  const list = Array.isArray(rows) ? rows : [];
  const totals = list.map((r) => Number(r?.total)).filter(Number.isFinite);
  const byName = new Map(list.map((r) => [r?.name, Number(r?.total)]));
  const out = new Map();
  for (const name of names) {
    const mine = byName.get(name);
    if (!Number.isFinite(mine) || totals.length < 2) { out.set(name, 0.5); continue; }
    let above = 0, same = 0;
    for (const t of totals) { if (t > mine) above++; else if (t === mine) same++; }
    out.set(name, (above + (same - 1) / 2) / (totals.length - 1));
  }
  return out;
}

/* 抽選：実在の申込者に、足りない人数ぶんの NPC を混ぜた集団から count 回引く。すでに当たった人は ×0.2 の重みを重ね、最大3回まで。
   rankOf（uid→会員ランク）があれば、ランクが高い人ほど重みを大きくする（最高ランクで約3倍）。ランクがなければ全員同じ重み。
   NPC は実在の申込者の平均の重み＝全体の当選割合は変わらない */
export function kakuPickWinners({ applicants, poolTarget, count, wins = new Map(), random, dayId, rankOf = null, standing = null }) {
  const weightOf = (a) => (standing ? 1 + (KAKU_BIAS - 1) * (standing.get(a.name) ?? 0.5) : 1) * (rankOf ? (RANK_LEVELS[rankOf.get(a.uid) || 0]?.mult || 1) : 1);
  const all = applicants.map((a) => ({ uid: a.uid, name: a.name, npc: false, base: weightOf(a) }));
  const npcN = Math.max(0, poolTarget - all.length);
  const npcBase = all.length ? all.reduce((s, p) => s + p.base, 0) / all.length : 1;
  for (let i = 0; i < npcN; i++) all.push({ uid: "npc:" + i, name: kakuNpcName(dayId, i), npc: true, base: npcBase });
  const got = new Map(all.map((p) => [p.uid, p.npc ? 0 : (wins.get(p.uid) || 0)]));
  const chosen = [];
  for (let k = 0; k < count; k++) {
    const w = all.map((p) => { const n = got.get(p.uid); return n >= KAKU_MAX_PER_DAY ? 0 : p.base * Math.pow(KAKU_REPEAT_WEIGHT, n); });
    const total = w.reduce((s, x) => s + x, 0);
    if (total <= 0) break;
    let r = random() * total, idx = 0;
    for (; idx < w.length - 1; idx++) { if (r < w[idx]) break; r -= w[idx]; }
    chosen.push(all[idx]); got.set(all[idx].uid, got.get(all[idx].uid) + 1);
  }
  return chosen;
}
const kakuParseApplicants = (list) => (Array.isArray(list) ? list : []).map((x) => { const i = String(x).indexOf("\t"); return i > 0 ? { uid: x.slice(0, i), name: x.slice(i + 1) } : null; }).filter(Boolean);
const kakuWinsOf = (slots) => { const m = new Map(); (slots || []).forEach((s) => { if (s.uid) m.set(s.uid, (m.get(s.uid) || 0) + 1); }); return m; };
function kakuShuffle(arr, random) { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

/* ----- その日のドキュメント yuslotKaku/{日付}（メモリに短くためる） ----- */
const kakuDocCache = new Map();
const kakuTickDone = new Set();
export function resetKakuCacheForTest() { kakuDocCache.clear(); kakuTickDone.clear(); }
async function kakuGetDay(deps, dayId, ttlMs = 15000) {
  const now = deps.now(), hit = kakuDocCache.get(dayId);
  if (hit && now - hit.at < ttlMs) return hit.value;
  const raw = await deps.firestore.getRaw(`yuslotKaku/${dayId}`);
  const value = raw ? { data: decodeFields(raw.fields), updateTime: raw.updateTime } : null;
  kakuDocCache.set(dayId, { at: now, value });
  return value;
}
export async function kakuEnsureDay(deps, dayId) {
  const cur = await kakuGetDay(deps, dayId, 5000);
  if (cur) return cur;
  const now = deps.now(), t = kakuTimes(dayId);
  const mode = now >= t.preClose ? "sameDay" : "full"; // 前日の抽選の締切後に作った日は、当日分だけ発売
  await deps.firestore.createIfAbsent(`yuslotKaku/${dayId}`, { day: dayId, machine: kakuMachineFor(dayId), mode, slots: kakuInitialSlots(dayId), app1: [], app2: [], draw1Done: mode === "sameDay", draw2Done: false, createdAtMs: now });
  kakuDocCache.delete(dayId);
  return kakuGetDay(deps, dayId, 0);
}
async function kakuWriteSlots(deps, dayId, cur, extra) {
  const fields = { slots: cur.data.slots, ...extra };
  await deps.firestore.commit([{ update: { name: deps.firestore.docName(`yuslotKaku/${dayId}`), fields: encodeFields(fields) }, updateMask: { fieldPaths: Object.keys(fields) }, currentDocument: { updateTime: cur.updateTime } }]);
  kakuDocCache.delete(dayId);
}

/* 抽選の実行（冪等：done フラグ＋更新時刻の条件）。type 1＝前日の抽選（30分枠）、2＝当日の抽選（10分枠・抽選用の3個） */
export async function kakuRunDraw(deps, dayId, type) {
  const doneKey = type === 1 ? "draw1Done" : "draw2Done";
  let rankDoc; // 会員ランク（yuslotRank/current。申込者がいるときだけ1回読む）
  let standingRows; // 申込者ごとの重みの調整に使うデータ（申込者がいるときだけ1回読む）
  // 抽選の読み取りと書き込みの間に、申込や先着が入って更新時刻が変わったら、読み直してやり直す（最大4回）。
  // 申込は受付の締切までに入ったものが必ず抽選に入るようにするため（やり直さないと、抽選が行われないままになってしまう）
  for (let attempt = 0; attempt < 4; attempt++) {
    kakuDocCache.delete(dayId);
    const cur = await kakuEnsureDay(deps, dayId);
    if (cur.data[doneKey]) return { skipped: "done" };
    const slots = cur.data.slots.map((x) => ({ ...x }));
    const targets = slots.map((x, i) => i).filter((i) => (type === 1 ? slots[i].kind === "pre" : slots[i].kind === "lot"));
    const apps = kakuParseApplicants(type === 1 ? cur.data.app1 : cur.data.app2);
    if (apps.length && rankDoc === undefined) {
      try { rankDoc = (await rankEnsureCurrent(deps)).data.ranks || {}; } catch { rankDoc = {}; } // 読めなくても抽選は止めない（ランクなし）
    }
    if (apps.length && standingRows === undefined) {
      try { const raw = await deps.firestore.getRaw("rankings/assets"); standingRows = raw ? decodeFields(raw.fields).users || [] : []; }
      catch { standingRows = []; } // 読めなくても抽選は止めない（調整なし）
    }
    const standing = standingRows && standingRows.length ? kakuStanding(standingRows, apps.map((a) => a.name)) : null;
    const rankOf = rankDoc ? new Map(Object.entries(rankDoc)) : null;
    const winners = kakuPickWinners({ applicants: apps, poolTarget: kakuPoolFor(dayId, type), count: targets.length, wins: kakuWinsOf(slots), random: deps.random, dayId, rankOf, standing });
    kakuShuffle(targets, deps.random).forEach((slotIdx, k) => {
      const w = winners[k]; if (!w) return;
      slots[slotIdx] = { ...slots[slotIdx], uid: w.npc ? "" : w.uid, name: w.name, npc: w.npc };
    });
    try { await kakuWriteSlots(deps, dayId, { data: { slots }, updateTime: cur.updateTime }, { [doneKey]: true, [type === 1 ? "applied1" : "applied2"]: apps.length }); }
    catch (error) { if (isRetryableCommitError(error)) continue; throw error; }
    return { drawn: true, applicants: apps.length, real: slots.filter((x) => x.uid).length };
  }
  return { skipped: "raced" };
}

/* ----- 申込・先着・状態 ----- */
async function kakuGate(deps, uid) {
  const published = await slotGetPublished(deps);
  return published || slotIsTopAdmin(deps, uid);
}
async function kakuApply(deps, uid, body) {
  const which = body?.which === "same" ? "same" : body?.which === "pre" ? "pre" : "";
  if (!which) return { status: 400, error: "bad_request" };
  if (!(await kakuGate(deps, uid))) return { status: 403, error: "not_published" };
  const now = deps.now();
  const dayId = which === "same" ? kakuDayId(now) : kakuNextDay(kakuDayId(now));
  if (dayId < KAKU_EPOCH) return { status: 409, error: "no_event" };
  const t = kakuTimes(dayId);
  const open = which === "same" ? now >= t.sameOpen && now < t.sameClose : now >= t.preOpen && now < t.preClose;
  if (!open) return { status: 409, error: "not_open" };
  const me = await loadMyUser(deps.firestore, uid, body?.username);
  if (me.error) return me.error;
  const cur = await kakuEnsureDay(deps, dayId);
  if (which === "pre" && cur.data.mode === "sameDay") return { status: 409, error: "not_open" };
  const field = which === "same" ? "app2" : "app1";
  if ((cur.data[field] || []).some((x) => String(x).startsWith(uid + "\t"))) return { ok: true, already: true };
  await deps.firestore.commit([{ update: { name: deps.firestore.docName(`yuslotKaku/${dayId}`), fields: {} }, updateMask: { fieldPaths: [] },
    updateTransforms: [{ fieldPath: field, appendMissingElements: { values: [{ stringValue: `${uid}\t${me.name}` }] } }], currentDocument: { exists: true } }]);
  kakuDocCache.delete(dayId);
  return { ok: true, already: false };
}
export async function kakuQuick(deps, uid, body) {
  const idx = Number(body?.slot);
  if (!Number.isInteger(idx)) return { status: 400, error: "bad_request" };
  if (!(await kakuGate(deps, uid))) return { status: 403, error: "not_published" };
  const now = deps.now(), dayId = kakuDayId(now);
  if (dayId < KAKU_EPOCH) return { status: 409, error: "no_event" };
  const t = kakuTimes(dayId);
  if (now < t.quickOpen) return { status: 409, error: "not_open" };
  const me = await loadMyUser(deps.firestore, uid, body?.username);
  if (me.error) return me.error;
  const cur = await kakuGetDay(deps, dayId, 0);
  if (!cur) return { status: 409, error: "not_open" };
  const slots = cur.data.slots.map((x) => ({ ...x }));
  const slot = slots[idx];
  if (!slot || slot.kind !== "quick") return { status: 400, error: "bad_request" };
  if (now >= slot.s) return { status: 409, error: "slot_started" };
  if (slot.uid || slot.name) return { status: 409, error: "taken" };
  const mine = slots.filter((x) => x.uid === uid);
  if (mine.some((x) => x.kind === "quick")) return { status: 409, error: "quick_limit" };       // 先着は1人1枠まで
  if (mine.length >= KAKU_MAX_PER_DAY) return { status: 409, error: "day_limit" };                // 1日最大3枠
  if (mine.some((x) => x.s < slot.e && slot.s < x.e)) return { status: 409, error: "overlap" };
  slots[idx] = { ...slot, uid, name: me.name, npc: false };
  try { await kakuWriteSlots(deps, dayId, { data: { slots }, updateTime: cur.updateTime }, {}); }
  catch (error) { if (isRetryableCommitError(error)) return { status: 409, error: "busy" }; throw error; }
  return { ok: true, slot: idx, name: me.name };
}
/* =========================================================
   🎫 先着ゲーム（確変台の当日分の先着）
   ・11:45 になったら「先着はこちら」を押してスタート。接続画面→チケット選択→〇〇を選択→カード番号→同意→「チケットを取る」。
   ・問題（カード番号・接続画面の出方・お題・同意ボタンの並び）は、サーバーが人ごと・回ごとに作る（鍵つきのハッシュから計算するので保存しない）。
   ・タイムは、スタートを押してから最後に「チケットを取る」を押すまで（サーバーが測る）。売り切れてやり直しても時計は止まらない。
   ・枠の割り当ては、サーバーに届いた順（kakuQuick の原子的な書き込み）。ランキングは通算の自己ベスト（当日分は12:00に反映）。
   ・練習：サーバーが問題を作って返すだけ（Firestore には何も書かない）。練習のタイムは、サーバーには送らない＝ランキングには載らない。
   ・週間ランキング：毎週月曜 7:00（会員ランクと同じ週）に結果発表。1位500・2位250・3位100コインを、結果発表と同時にお渡しする（コインの支払いと、書類の更新は1回の commit＝二重払いなし）。
   ・Firebase：1人あたり、スタートで1回・やり直しごとに1回・おしまいで3回の書き込み。ランキング（通算・今週）は書類2つを30秒だけメモリに置く。
========================================================= */
const BATTLE_WAIT_MS = 15 * KAKU_MIN;           // 待機画面に入れるのは 11:30 から
const BATTLE_TOP = 20;                           // ランキングに出す人数
const BATTLE_REVEAL_MS = 12 * 3600000;           // 当日の記録がランキングに載る時刻（0:00 からの経過）
const BATTLE_BOARD = "yuslotBattle/_board";
const BATTLE_WEEK = "yuslotBattle/_week";           // 今週のランキング：{ weekStart, rows, last }。last＝先週の結果発表
const BATTLE_PRIZES = [500, 250, 100];                // 週間ランキングの賞金（1位・2位・3位のコイン）
const BATTLE_CONN_MAX = 8;                       // 1回のゲームでの接続画面（リロード）の合計の上限
/* お題の絵文字：同じなかまから、お題1つ＋まぎらわしい3つを出す */
const BATTLE_PUZZLES = [
  [["🐱", "ねこ"], ["🐶", "いぬ"], ["🐭", "ねずみ"], ["🐰", "うさぎ"], ["🐻", "くま"], ["🐼", "パンダ"], ["🐸", "かえる"], ["🐵", "さる"], ["🐷", "ぶた"], ["🦊", "きつね"], ["🐯", "とら"], ["🐔", "にわとり"]],
  [["🍎", "りんご"], ["🍊", "みかん"], ["🍌", "バナナ"], ["🍇", "ぶどう"], ["🍓", "いちご"], ["🍉", "すいか"], ["🍑", "もも"], ["🍋", "レモン"], ["🍒", "さくらんぼ"], ["🍐", "なし"]],
  [["🚗", "くるま"], ["🚕", "タクシー"], ["🚌", "バス"], ["🚓", "パトカー"], ["🚑", "きゅうきゅうしゃ"], ["🚒", "しょうぼうしゃ"], ["🚲", "じてんしゃ"], ["🚃", "でんしゃ"], ["✈️", "ひこうき"], ["🚢", "ふね"]],
  [["😀", "にっこり"], ["😢", "ないている"], ["😡", "おこっている"], ["😴", "ねむっている"], ["😎", "サングラス"], ["😱", "びっくり"], ["🥺", "うるうる"], ["😍", "ハートの目"], ["🤔", "かんがえ中"], ["😷", "マスク"]],
  [["☀️", "たいよう"], ["🌙", "つき"], ["⭐", "ほし"], ["☁️", "くも"], ["🌈", "にじ"], ["⚡", "かみなり"], ["❄️", "ゆき"], ["🔥", "ひ"], ["💧", "みず"], ["🌸", "さくら"]]
];

async function battleRand(deps, ...parts) {
  const key = await slotHmacKey(deps.slotSecret);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("battle:" + parts.join(":"))));
  return kakuMulberry(((sig[0] << 24) | (sig[1] << 16) | (sig[2] << 8) | sig[3]) >>> 0);
}
/* その日のカード番号（人ごと・3桁。待機画面から出す） */
export async function battleCard(deps, day, uid) { const r = await battleRand(deps, "card", day, uid); return 100 + Math.floor(r() * 900); }
/* 1回ぶんの問題。conn＝接続画面で押すリロードの回数［最初の接続, チケット選択の後, 〇〇選択の後, カード番号の後］ */
export async function battlePlan(deps, day, uid, att) {
  const r = await battleRand(deps, "plan", day, uid, att);
  const [target, ...rest] = kakuShuffle(BATTLE_PUZZLES[Math.floor(r() * BATTLE_PUZZLES.length)], r);
  const options = kakuShuffle([target, ...rest.slice(0, 3)], r);
  const conn = [2 + Math.floor(r() * 3), 0, 0, 0];
  for (let k = 1; k < 4; k++) conn[k] = r() < 1 / 3 ? 1 + (r() < 0.5 ? 1 : 0) : 0;
  let over = conn.reduce((s, x) => s + x, 0) - BATTLE_CONN_MAX;
  for (let k = 3; k >= 1 && over > 0; k--) { const cut = Math.min(conn[k], over); conn[k] -= cut; over -= cut; }
  return { conn, puzzle: { label: `「${target[1]}」を選択してください`, options: options.map((x) => x[0]), answer: options.indexOf(target) }, consent: kakuShuffle([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], r) };
}
/* 端末から届いた操作の記録（t＝各画面を終えた時刻：チケット選択の「次へ」／〇〇の「次へ」／カード番号／同意10個／「チケットを取る」。スタート画面を押してからのミリ秒）が、人間の速さか */
export function battleProofOk(plan, t, attemptMs) {
  if (!Array.isArray(t) || t.length !== 5 || !t.every((x) => Number.isFinite(x) && x >= 0)) return "bad_proof";
  for (let i = 1; i < 5; i++) if (t[i] < t[i - 1]) return "bad_proof";
  const [c0, c1, c2, c3] = plan.conn;
  const need = [500 * c0 + 300, 500 * c1 + 300, 500 * c2 + 300, 500 * c3 + 700, 100]; // リロード1回は0.5秒かかる、ボタン1回は0.07秒より速くは押せない、など
  for (let i = 0; i < 5; i++) if (t[i] - (i ? t[i - 1] : 0) < need[i]) return "too_fast";
  if (attemptMs < t[4] - 3000) return "bad_proof";                       // 端末の申告が、サーバーの測った時間より長いはずがない
  if (attemptMs < need.reduce((s, x) => s + x, 0)) return "too_fast";
  return null;
}
const battleQuickOf = (slots) => (slots || []).filter((x) => x.kind === "quick");
/* いま取れる先着の枠（取られていない・始まっていない・自分のルールに反しない） */
export function battleOpenSlots(slots, uid, now) {
  const mine = (slots || []).filter((x) => x.uid === uid);
  if (mine.some((x) => x.kind === "quick") || mine.length >= KAKU_MAX_PER_DAY) return [];
  return battleQuickOf(slots).filter((x) => !x.uid && !x.name && now < x.s && !mine.some((m) => m.s < x.e && x.s < m.e)).map((x) => x.i);
}
const battleUntaken = (slots, now) => battleQuickOf(slots).filter((x) => !x.uid && !x.name && now < x.s).map((x) => x.i);
/* やり直しのとき、選べない枠（売り切れ・始まった・自分のルールで取れない） */
export function battleClosedList(slots, uid, now) {
  const open = new Set(battleOpenSlots(slots, uid, now));
  return battleQuickOf(slots).filter((x) => !open.has(x.i)).map((x) => ({ i: x.i, why: x.uid || x.name ? "taken" : now >= x.s ? "started" : "rule" }));
}
const battleSlotsView = (slots, uid) => battleQuickOf(slots).map((x) => ({ i: x.i, s: x.s, e: x.e, mine: x.uid === uid }));

async function battleGate(deps, uid) {
  if (!(await kakuGate(deps, uid))) return { status: 403, error: "not_published" };
  const now = deps.now(), day = kakuDayId(now);
  if (day < KAKU_EPOCH) return { status: 409, error: "no_event" };
  return { now, day, t: kakuTimes(day) };
}
async function battleGetRec(deps, uid, day) {
  const d = await deps.firestore.get(`yuslotBattle/${uid}`);
  return d && d.day === day ? d : null;
}
const battleRecView = (rec) => ({ done: rec.d === true, got: rec.d === true && rec.g >= 0, slot: rec.g, ms: rec.ms || 0 });

async function battleStatus(deps, uid) {
  const g = await battleGate(deps, uid);
  if (g.error) return g.error === "no_event" ? { ok: true, active: false, serverNowMs: deps.now() } : g;
  const { now, day, t } = g;
  const [cur, rec] = await Promise.all([now >= t.sameOpen - 2 * 3600000 ? kakuEnsureDay(deps, day) : kakuGetDay(deps, day), battleGetRec(deps, uid, day)]);
  const slots = cur ? cur.data.slots : kakuInitialSlots(day);
  const out = { ok: true, active: true, serverNowMs: now, times: { waitOpen: t.quickOpen - BATTLE_WAIT_MS, goAt: t.quickOpen }, slots: battleSlotsView(slots, uid), allTaken: battleUntaken(slots, now).length === 0 && now >= t.quickOpen };
  if (now >= out.times.waitOpen) out.card = await battleCard(deps, day, uid);
  if (rec) out.rec = battleRecView(rec);
  return out;
}

/* 「先着はこちら」：スタート（最初の1回は時計を動かす。やり直し・開き直しは、時計はそのままで新しい問題をもらう） */
async function battleStart(deps, uid, body) {
  const g = await battleGate(deps, uid);
  if (g.error) return g;
  const { now, day, t } = g;
  if (now < t.quickOpen) return { status: 409, error: "not_open" };
  const [cur, rec0] = await Promise.all([kakuEnsureDay(deps, day), battleGetRec(deps, uid, day)]);
  if (rec0 && rec0.d === true) return { ok: true, done: true, rec: battleRecView(rec0) };
  const slots = cur.data.slots;
  if (!battleUntaken(slots, now).length) {            // 完売後は参加できない。途中だった人は、ここで終わりにする（タイムは記録する）
    if (rec0) { const ms = Math.max(1, now - rec0.st); await battleFinalize(deps, uid, rec0, day, ms, -1); return { ok: true, done: true, rec: { done: true, got: false, slot: -1, ms } }; }
    return { ok: true, soldOut: true };
  }
  const me = await loadMyUser(deps.firestore, uid, body?.username);
  if (me.error) return me.error;
  const att = rec0 ? rec0.a + 1 : 1, st = rec0 ? rec0.st : now;
  await deps.firestore.set(`yuslotBattle/${uid}`, { day, st, as: now, a: att, d: false, n: me.name });
  const [plan, card] = await Promise.all([battlePlan(deps, day, uid, att), battleCard(deps, day, uid)]);
  return { ok: true, att, st, serverNowMs: now, card, plan, slots: battleSlotsView(slots, uid), closed: rec0 ? battleClosedList(slots, uid, now) : [],
    haveQuick: slots.some((x) => x.uid === uid && x.kind === "quick") };
}

/* 1日1件の記録を確定する（ランキングへの反映は失敗しても、チケットや結果は消さない） */
async function battleFinalize(deps, uid, rec, day, ms, slot) {
  await deps.firestore.set(`yuslotBattle/${uid}`, { day, st: rec.st, as: rec.as, a: rec.a, d: true, ms, g: slot, n: rec.n });
  try { await battleBoardAdd(deps, uid, rec.n, day, ms); }
  catch (error) { console.warn("battle board update failed", String(error?.message || error).slice(0, 120)); }
  try { await battleWeekAdd(deps, uid, rec.n, day, ms); }
  catch (error) { console.warn("battle week update failed", String(error?.message || error).slice(0, 120)); }
}

/* 「チケットを取る」：記録のチェック → 枠の確保（サーバーに届いた順） → 取れなければ、残りがあればやり直し */
async function battleFinish(deps, uid, body) {
  const g = await battleGate(deps, uid);
  if (g.error) return g;
  const { now, day, t } = g;
  if (now < t.quickOpen) return { status: 409, error: "not_open" };
  const slotIdx = Number(body?.slot), att = Number(body?.att);
  if (!Number.isInteger(slotIdx) || !Number.isInteger(att)) return { status: 400, error: "bad_request" };
  const rec = await battleGetRec(deps, uid, day);
  if (!rec) return { status: 409, error: "no_game" };
  if (rec.d === true) return { ok: true, done: true, ...battleRecView(rec) };
  if (rec.a !== att) return { status: 409, error: "stale" };
  const [plan, card] = await Promise.all([battlePlan(deps, day, uid, att), battleCard(deps, day, uid)]);
  if (Number(body?.ans) !== plan.puzzle.answer || String(body?.card) !== String(card)) return { status: 400, error: "bad_proof" };
  const proof = battleProofOk(plan, body?.t, now - rec.as);
  if (proof) return { status: 400, error: proof };
  const ms = Math.max(1, now - rec.st);
  let res;
  for (let k = 0; k < 3; k++) { res = await kakuQuick(deps, uid, { slot: slotIdx, username: body?.username }); if (res.error !== "busy") break; }
  if (res.ok) { await battleFinalize(deps, uid, rec, day, ms, slotIdx); return { ok: true, done: true, got: true, slot: slotIdx, ms }; }
  if (["bad_request", "not_published", "no_event", "not_open"].includes(res.error)) return res;
  if (res.status !== 409) return res;
  // 取れなかった：残りの枠があればやり直し、なければここで終わり
  const cur = await kakuGetDay(deps, day, 0);
  const slots = cur.data.slots;
  const held = slots.find((x) => x.uid === uid && x.kind === "quick"); // 直前の通信エラーなどで、すでに取れていた場合
  if (held) { await battleFinalize(deps, uid, rec, day, ms, held.i); return { ok: true, done: true, got: true, slot: held.i, ms }; }
  if (!battleOpenSlots(slots, uid, now).length) { await battleFinalize(deps, uid, rec, day, ms, -1); return { ok: true, done: true, got: false, soldOut: true, ms }; }
  const att2 = att + 1;
  await deps.firestore.set(`yuslotBattle/${uid}`, { day, st: rec.st, as: now, a: att2, d: false, n: rec.n });
  return { ok: true, done: false, got: false, soldOut: true, reason: res.error, att: att2, plan: await battlePlan(deps, day, uid, att2), card, serverNowMs: now, closed: battleClosedList(slots, uid, now), slots: battleSlotsView(slots, uid) };
}

/* ----- ランキング（yuslotBattle/_board：{ rows: [{ uid, name, ms, day, pms, pday }] }）。pms／pday は、今日より前の自己ベスト ----- */
export function battleBoardMerge(rows, uid, name, day, ms) {
  const out = rows.map((r) => ({ ...r }));
  const row = out.find((r) => r.uid === uid);
  if (!row) { out.push({ uid, name, ms, day, pms: 0, pday: "" }); return out; }
  row.name = name;
  if (row.day === day) { if (ms < row.ms) row.ms = ms; return out; }
  if (ms < row.ms) { row.pms = row.ms; row.pday = row.day; row.ms = ms; row.day = day; }
  return out;
}
async function battleBoardAdd(deps, uid, name, day, ms) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const raw = await deps.firestore.getRaw(BATTLE_BOARD);
    const rows = raw ? decodeFields(raw.fields).rows || [] : [];
    const next = battleBoardMerge(rows, uid, name, day, ms);
    try {
      if (raw) await deps.firestore.commit([{ update: { name: deps.firestore.docName(BATTLE_BOARD), fields: encodeFields({ rows: next }) }, updateMask: { fieldPaths: ["rows"] }, currentDocument: { updateTime: raw.updateTime } }]);
      else if (!(await deps.firestore.createIfAbsent(BATTLE_BOARD, { rows: next }))) continue;
      battleBoardCache = { at: 0, rows: null };
      return;
    } catch (error) { if (isRetryableCommitError(error)) continue; throw error; }
  }
  throw new Error("battle board raced");
}
let battleBoardCache = { at: 0, rows: null };
export function resetBattleCacheForTest() { battleBoardCache = { at: 0, rows: null }; }
async function battleBoardRows(deps, ttlMs = 30000) {
  const now = deps.now();
  if (battleBoardCache.rows && now - battleBoardCache.at < ttlMs) return battleBoardCache.rows;
  const raw = await deps.firestore.getRaw(BATTLE_BOARD);
  const rows = raw ? decodeFields(raw.fields).rows || [] : [];
  battleBoardCache = { at: now, rows };
  return rows;
}
/* 12:00 より前は、当日の新記録を出さない（それまでは、今日より前の自己ベストを出す）。タイムの速い順 */
const battleCmp = (a, b) => a.ms - b.ms || (a.day < b.day ? -1 : a.day > b.day ? 1 : 0) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
export function battleVisibleRows(rows, uid, day, reveal) {
  const vis = [];
  let pending = null;
  for (const r of rows) {
    if (r.day === day && !reveal) {
      if (r.uid === uid) pending = r.ms;
      if (r.pms > 0) vis.push({ uid: r.uid, name: r.name, ms: r.pms, day: r.pday });
    } else vis.push({ uid: r.uid, name: r.name, ms: r.ms, day: r.day });
  }
  vis.sort(battleCmp);
  return { vis, pending };
}
const battleBoardView = (vis, uid, pending, prizes = null) => {
  const mineIdx = vis.findIndex((r) => r.uid === uid);
  return { total: vis.length, pendingMs: pending,
    rows: vis.slice(0, BATTLE_TOP).map((r, i) => ({ rank: i + 1, name: r.name, ms: r.ms, day: r.day, me: r.uid === uid, ...(prizes ? { prize: prizes[i] || 0 } : {}) })),
    me: mineIdx >= 0 ? { rank: mineIdx + 1, ms: vis[mineIdx].ms, day: vis[mineIdx].day, ...(prizes ? { prize: prizes[mineIdx] || 0 } : {}) } : null };
};
async function battleRanking(deps, uid) {
  if (!(await kakuGate(deps, uid))) return { status: 403, error: "not_published" };
  const now = deps.now(), day = kakuDayId(now), reveal = now >= kakuDayStart(day) + BATTLE_REVEAL_MS;
  const rows = await battleBoardRows(deps);
  const all = battleVisibleRows(rows, uid, day, reveal);
  const out = { ok: true, serverNowMs: now, revealAtMs: kakuDayStart(day) + BATTLE_REVEAL_MS, ...battleBoardView(all.vis, uid, all.pending), week: null, last: null };
  try {   // 今週のランキングと先週の結果発表（取れなくても、通算のランキングは返す）
    const w = (await battleWeekEnsure(deps, { ttlMs: 30000 })).data;
    const wv = battleVisibleRows(w.rows || [], uid, day, reveal);
    out.week = { startMs: Number(w.weekStart), endMs: Number(w.weekStart) + RANK_WEEK_MS, prizes: BATTLE_PRIZES, ...battleBoardView(wv.vis, uid, wv.pending, BATTLE_PRIZES) };
    const l = w.last;
    if (l && Array.isArray(l.top) && l.top.length) {
      const mine = l.top.find((t) => t.uid === uid);
      out.last = { startMs: Number(l.weekStart), endMs: Number(l.endMs), total: Number(l.total) || l.top.length,
        top: l.top.map((t) => ({ rank: t.rank, name: t.name, ms: t.ms, day: t.day, prize: t.prize, me: t.uid === uid })), me: mine ? { rank: mine.rank, prize: mine.paid ? mine.prize : 0 } : null };
    }
  } catch (error) { console.warn("battle week read failed", String(error?.message || error).slice(0, 120)); }
  return out;
}

/* ----- 週間ランキング（yuslotBattle/_week）。毎週月曜 7:00 に先週の上位3人へコインを渡し、結果発表（お知らせ・通知）を出す ----- */
let battleWeekCache = { at: 0, value: null };
export function resetBattleWeekCacheForTest() { battleWeekCache = { at: 0, value: null }; }
export async function battleWeekAdd(deps, uid, name, day, ms) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const cur = await battleWeekEnsure(deps);
    const next = battleBoardMerge(cur.data.rows || [], uid, name, day, ms);
    try {
      await deps.firestore.commit([{ update: { name: deps.firestore.docName(BATTLE_WEEK), fields: encodeFields({ rows: next }) }, updateMask: { fieldPaths: ["rows"] }, currentDocument: { updateTime: cur.updateTime } }]);
      battleWeekCache = { at: 0, value: null };
      return;
    } catch (error) { if (isRetryableCommitError(error)) continue; throw error; }
  }
  throw new Error("battle week raced");
}
/* いまの週のドキュメントを返す。無ければ作り、週が替わっていれば先週の分を確定してコインを渡す（更新時刻の条件つきの1回の commit） */
export async function battleWeekEnsure(deps, { ttlMs = 0 } = {}) {
  const ws = rankWeekStart(deps.now());
  if (ttlMs > 0 && battleWeekCache.value && deps.now() - battleWeekCache.at < ttlMs && Number(battleWeekCache.value.data.weekStart) >= ws) return battleWeekCache.value;
  for (let attempt = 0; attempt < 4; attempt++) {
    const raw = await deps.firestore.getRaw(BATTLE_WEEK);
    if (!raw) { await deps.firestore.createIfAbsent(BATTLE_WEEK, { weekStart: ws, rows: [], last: null }); continue; }
    const cur = { data: decodeFields(raw.fields), updateTime: raw.updateTime };
    if (Number(cur.data.weekStart) >= ws) { battleWeekCache = { at: deps.now(), value: cur }; return cur; }
    try { await battleWeekSettle(deps, cur, ws); }
    catch (error) { if (isRetryableCommitError(error)) continue; throw error; }
    try { await battleWeekAnnounce(deps); } catch (error) { console.warn("battle week announce failed", String(error?.message || error).slice(0, 120)); }
  }
  throw new Error("battle week raced");
}
/* 先週の上位3人にコインを渡す。支払いと、書類の更新（先週の結果・今週の空の記録）は1回の commit。いない人・実在しない人の分は渡さない（繰り下げもしない） */
async function battleWeekSettle(deps, cur, ws) {
  const fs = deps.firestore;
  const rows = (cur.data.rows || []).map((r) => ({ uid: r.uid, name: r.name, ms: r.ms, day: r.day })).sort(battleCmp);
  const top = rows.slice(0, BATTLE_PRIZES.length).map((r, i) => ({ rank: i + 1, uid: r.uid, name: r.name, ms: r.ms, day: r.day, prize: BATTLE_PRIZES[i] }));
  const found = await Promise.all(top.map((t) => transferFindUser(fs, t.uid, t.name)));
  const writes = [];
  top.forEach((t, i) => {
    t.paid = !!found[i];
    if (found[i]) writes.push({ update: { name: fs.docName(`users/${found[i].name}`), fields: {} }, updateMask: { fieldPaths: [] }, updateTransforms: [{ fieldPath: "coins", increment: restInt(t.prize) }], currentDocument: { exists: true } });
  });
  const fields = { weekStart: ws, rows: [], last: { weekStart: Number(cur.data.weekStart), endMs: ws, top, total: rows.length, announced: top.length === 0 } };
  writes.push({ update: { name: fs.docName(BATTLE_WEEK), fields: encodeFields(fields) }, updateMask: { fieldPaths: Object.keys(fields) }, currentDocument: { updateTime: cur.updateTime } });
  await fs.commit(writes);
  battleWeekCache = { at: 0, value: null };
}
const battleMd = (ms) => { const d = new Date(ms + KAKU_JST); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`; };
/* 結果発表のお知らせ（📢・全員）と、入賞した人への通知。お知らせは固定IDで1件だけ、通知は notificationLogs で二重送信しない */
export async function battleWeekAnnounce(deps) {
  const fs = deps.firestore;
  const raw = await fs.getRaw(BATTLE_WEEK);
  const d = raw ? decodeFields(raw.fields) : null;
  const l = d && d.last;
  if (!l || l.announced === true || !Array.isArray(l.top) || !l.top.length) return { skipped: true };
  const medal = ["🥇", "🥈", "🥉"];
  const lines = [`${battleMd(l.weekStart)}〜${battleMd(l.endMs - 1)} の先着ゲーム、週間ランキングの結果発表です！（参加 ${l.total} 人）`];
  l.top.forEach((t) => lines.push(`${medal[t.rank - 1]} ${t.rank}位 ${t.name}さん ${(t.ms / 1000).toFixed(2)}秒 → ${t.prize} コイン${t.paid ? "" : "（お渡しできませんでした）"}`));
  lines.push("入賞したみなさんには、ゆうコインをお渡ししました🎁 今週も「🎫 当日の先着はこちら」で挑戦しよう！");
  const now = new Date(deps.now()), id = `battle-${l.weekStart}`;
  await fs.createIfAbsent(`announcements/${id}`, { title: truncate("🏆 先着ゲーム 週間ランキングの結果発表！", 50), body: truncate(lines.join("\n"), 480), createdAt: now, updatedAt: now, createdByUid: "yuuchat-battle", createdByName: "先着ゲーム" });
  try { await notifyNewAnnouncement(deps, id); } catch (error) { console.warn("battle announce notify failed", String(error?.message || error).slice(0, 120)); }
  await Promise.all(l.top.filter((t) => t.paid).map((t) => transferNotify(deps, t.uid, "🏆 先着ゲームの賞金！", `週間ランキング ${t.rank}位！ ${t.prize} コインをお渡ししました🎁`)));
  await fs.update(BATTLE_WEEK, { last: { ...l, announced: true } });
  battleWeekCache = { at: 0, value: null };
  return { announced: true };
}
const battleWeekTickDone = new Set();
export function resetBattleWeekTickForTest() { battleWeekTickDone.clear(); }
/* 毎分の cron から。月曜 7:00〜7:09（日本時間）の間だけ動く（取りこぼしても、次に記録・ランキングを開いたときに追いつく） */
export async function runBattleWeekTick(env = {}, scheduledTime = Date.now(), deps = null) {
  const j = new Date(scheduledTime + 9 * 3600000);
  if (j.getUTCDay() !== 1 || j.getUTCHours() !== 7 || j.getUTCMinutes() > 9) return { skipped: "outside" };
  const key = String(rankWeekStart(scheduledTime));
  if (battleWeekTickDone.has(key)) return { skipped: "done" };
  const d = { ...(deps || createDefaultDeps(env)), now: () => scheduledTime };
  const cur = await battleWeekEnsure(d);
  const r = await battleWeekAnnounce(d);
  battleWeekTickDone.add(key);
  return { weekStart: cur.data.weekStart, ...r };
}

/* ----- 練習：サーバーが問題を作って返すだけ。何も保存しない（タイム・枠・ランキングには関係しない） ----- */
async function battlePractice(deps, uid) {
  if (!(await kakuGate(deps, uid))) return { status: 403, error: "not_published" };
  const nonce = slotRandomHex(6);
  const [plan, card] = await Promise.all([battlePlan(deps, "practice", uid, nonce), battleCard(deps, "practice", uid + nonce)]);
  return { ok: true, plan, card, serverNowMs: deps.now() };
}
/* 画面に返すのは「自分の枠」と「先着の空き状況（名前なし）」だけ。ほかの人（NPC を含む）の予定・結果は返さない */
/* いまの枠を使っている（使う）のが「NPC」「ほかのプレイヤー」「自分」「いない」のどれかだけを返す（名前は返さない）。台のカードに表示する */
export function kakuCurrentHolder(slots, uid, t, now) {
  if (now < t.playStart || now >= t.playEnd) return null;
  const x = (slots || []).find((y) => y.s <= now && now < y.e);
  if (!x) return null;
  const holder = x.uid ? (uid && x.uid === uid ? "me" : "player") : x.npc ? "npc" : "none";
  return { s: x.s, e: x.e, holder };
}
const kakuPersonalSlots = (slots, uid) => (slots || [])
  .filter((x) => (!!uid && x.uid === uid) || x.kind === "quick")
  .map((x) => ({ i: x.i, s: x.s, e: x.e, kind: x.kind, mine: !!uid && x.uid === uid, taken: !!(x.uid || x.name) }));
async function kakuStatus(deps, uid, body) {
  const now = deps.now(), today = kakuDayId(now), tomorrow = kakuNextDay(today);
  const out = { ok: true, serverNowMs: now, active: today >= KAKU_EPOCH || tomorrow >= KAKU_EPOCH };
  if (today >= KAKU_EPOCH) {
    const t = kakuTimes(today);
    const cur = now >= t.sameOpen - 2 * 3600000 ? await kakuEnsureDay(deps, today) : await kakuGetDay(deps, today);
    const d = cur ? cur.data : null;
    out.today = {
      day: today, machine: kakuMachineFor(today), mode: d ? d.mode : "sameDay", times: t, weekend: kakuIsWeekend(today),
      slots: kakuPersonalSlots(d ? d.slots : kakuInitialSlots(today), uid),
      cur: kakuCurrentHolder(d ? d.slots : [], uid, t, now),
      applied1: !!d && (d.app1 || []).some((x) => String(x).startsWith(uid + "\t")),
      applied2: !!d && (d.app2 || []).some((x) => String(x).startsWith(uid + "\t")),
      draw1Done: !!d && d.draw1Done === true, draw2Done: !!d && d.draw2Done === true
    };
  }
  if (tomorrow >= KAKU_EPOCH) {
    const t = kakuTimes(tomorrow);
    const cur = now >= t.preOpen ? await kakuGetDay(deps, tomorrow) : null;
    out.tomorrow = { day: tomorrow, machine: kakuMachineFor(tomorrow), times: t, weekend: kakuIsWeekend(tomorrow), applied1: !!cur && (cur.data.app1 || []).some((x) => String(x).startsWith(uid + "\t")), mode: cur ? cur.data.mode : "full" };
  }
  return out;
}

/* ----- 着席・スピンの制限（確変台は、その時間の枠をとった人だけ） ----- */
export async function kakuSeatRight(deps, uid, machine, now) {
  const dayId = kakuDayId(now);
  if (kakuMachineFor(dayId) !== machine) return null;
  const t = kakuTimes(dayId);
  if (now < t.playStart || now >= t.playEnd) return null;
  const cur = await kakuGetDay(deps, dayId);
  const slots = cur ? cur.data.slots : [];
  const slot = slots.find((x) => x.s <= now && now < x.e);
  if (!slot || slot.uid !== uid) return { locked: true };
  let end = slot.e;
  for (;;) { const nx = slots.find((x) => x.s === end && x.uid === uid); if (!nx) break; end = nx.e; }
  return { end };
}
export function kakuSpinGate(session, now) {
  const dayId = kakuDayId(now);
  if (kakuMachineFor(dayId) !== session.machine) return null;
  const t = kakuTimes(dayId);
  if (now < t.playStart || now >= t.playEnd) return session.kaku ? "over" : null;
  return !session.kaku || now >= (session.kakuEnd || 0) ? "over" : null;
}

/* ----- 通知（個人ごとの設定。先着の通知はなし） ----- */
async function kakuGetNotify(deps, uid) {
  const d = await deps.firestore.get(`yuslotPrefs/${uid}`);
  const n = d && d.kakuNotify && typeof d.kakuNotify === "object" ? d.kakuNotify : {};
  const out = {};
  for (const k of Object.keys(KAKU_NOTIFY_DEFAULTS)) out[k] = typeof n[k] === "boolean" ? n[k] : KAKU_NOTIFY_DEFAULTS[k];
  return out;
}
async function kakuSetNotify(deps, uid, body) {
  const cur = await kakuGetNotify(deps, uid), next = { ...cur };
  for (const k of Object.keys(KAKU_NOTIFY_DEFAULTS)) if (typeof body?.prefs?.[k] === "boolean") next[k] = body.prefs[k];
  await deps.firestore.set(`yuslotPrefs/${uid}`, { uid, kakuNotify: next, updatedAtMs: deps.now() });
  return { ok: true, prefs: next };
}
async function kakuPushFilter(deps, kind) {
  const docs = await deps.firestore.query("yuslotPrefs", []);
  const m = new Map(docs.map((d) => [d.data.uid, d.data.kakuNotify || {}]));
  return (uid) => { const p = m.get(uid); return p && typeof p[kind] === "boolean" ? p[kind] : KAKU_NOTIFY_DEFAULTS[kind]; };
}
const kakuMd = (ms) => { const d = new Date(ms + KAKU_JST); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`; };
const kakuHm = (ms) => { const d = new Date(ms + KAKU_JST); return `${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, "0")}`; };

/* 毎分の cron から。予定の時刻（前日12:00公開・前日21:00抽選・7:00・7:50・10:45）の直後10分だけ動く */
const KAKU_EVENTS = [
  { name: "pub", m: 720, next: true }, { name: "draw1", m: 1260, next: true },
  { name: "same", m: 420, next: false }, { name: "result1", m: 470, next: false }, { name: "draw2", m: 645, next: false }
];
export async function runKakuTick(env = {}, scheduledTime = Date.now(), deps = null) {
  const minOfDay = Math.floor(((scheduledTime + KAKU_JST) % KAKU_DAY_MS) / KAKU_MIN);
  const due = KAKU_EVENTS.filter((e) => minOfDay >= e.m && minOfDay < e.m + 10);
  if (!due.length) return { skipped: "outside" };
  const today = kakuDayId(scheduledTime);
  const todo = due.map((e) => ({ e, day: e.next ? kakuNextDay(today) : today })).filter((x) => x.day >= KAKU_EPOCH && !kakuTickDone.has(`${x.e.name}:${x.day}`));
  if (!todo.length) return { skipped: "done" };
  const d = deps || createDefaultDeps(env);
  const results = {};
  for (const { e, day } of todo) {
    try {
      results[e.name] = await kakuRunEvent(d, e.name, day);
      if (!(results[e.name] && results[e.name].skipped === "raced")) kakuTickDone.add(`${e.name}:${day}`); // 競合でできなかったときは、次の分にやり直す
    } catch (error) { console.error("kaku event error", e.name, String(error?.message || error).slice(0, 200)); }
  }
  return results;
}
async function kakuPush(deps, kind, day, title, body, dataForUid = null) {
  const filter = await kakuPushFilter(deps, kind);
  return sendBroadcastNotification(deps, `kaku-${kind}-${day}`, { kind: "kaku", title, body: truncate(body, 80), link: "./?open=announcements", tag: `kaku-${kind}-${day}` }, filter, dataForUid);
}
/* 抽選の結果は「申し込んだ本人」にだけ届ける（ほかの人の結果は載せない。申し込んでいない人には送らない） */
export function kakuResultDataFor(d, uid, type, machine, day) {
  if (!uid) return null;
  const apps = (type === 1 ? d.app1 : d.app2) || [];
  if (!apps.some((x) => String(x).startsWith(uid + "\t"))) return null;
  const mine = (d.slots || []).filter((x) => x.uid === uid && x.kind === (type === 1 ? "pre" : "lot")).sort((a, b) => a.s - b.s);
  const times = mine.map((x) => `${kakuHm(x.s)}〜${kakuHm(x.e)}`).join("、");
  const title = type === 1 ? "🌈 確変台の抽選結果" : "🌈 当日分の抽選結果";
  const body = mine.length
    ? (type === 1 ? `🎉 当選！ ${times} の枠をゲット。8:00から「${machine}」で遊べます。` : `🎉 当日分に当選！ ${times} の枠をゲット。「${machine}」で遊べます。`)
    : (type === 1 ? `今回は抽選に外れました。今日の確変台は「${machine}」。当日分の抽選・先着もあります！` : `当日分は外れました…。先着は11:45から！`);
  return { kind: "kaku", title, body: truncate(body, 80), link: "./?open=announcements", tag: `kaku-result${type}-${day}` };
}
export async function kakuRunEvent(deps, name, day) {
  const machine = KAKU_MACHINE_NAMES[kakuMachineFor(day)];
  if (name === "pub") {
    await kakuEnsureDay(deps, day);
    return kakuPush(deps, "pub", day, "🌈 明日の確変台が決まりました", `明日（${kakuMd(kakuDayStart(day))}）の確変台は「${machine}」。申込は今日の21:00まで！ゆうスロの台の一覧の上から申し込めます。`);
  }
  if (name === "draw1" || name === "draw2") { // 締切の瞬間に送られた申込が書き込み終わるまで、数秒待ってから抽選する
    const closeMs = name === "draw1" ? kakuTimes(day).preClose : kakuTimes(day).sameClose;
    const wait = closeMs + 5000 - deps.now();
    if (wait > 0 && wait <= 10000) await (deps.sleep ? deps.sleep(wait) : new Promise((r) => setTimeout(r, wait)));
  }
  if (name === "draw1") return kakuRunDraw(deps, day, 1);
  if (name === "same") {
    await kakuEnsureDay(deps, day);
    return kakuPush(deps, "same", day, "🌈 今日の確変台：当日分の抽選申込スタート", `今日の確変台は「${machine}」。12:30〜13:20の10分枠の抽選は10:45まで申込OK！`);
  }
  if (name === "draw2") {
    const r = await kakuRunDraw(deps, day, 2);
    const cur = await kakuGetDay(deps, day, 0);
    if (cur) await kakuPush(deps, "result2", day, "🌈 当日分の抽選結果", "", (uid) => kakuResultDataFor(cur.data, uid, 2, machine, day));
    return r;
  }
  if (name === "result1") return kakuAnnounceResult(deps, day);
  return { skipped: "unknown" };
}
/* 当日 7:50：お知らせ（📢）は「今日の確変台と進め方」だけ（誰が当たったかは載せない）。固定IDで1件だけ。
   抽選結果のプッシュは、前日の抽選に申し込んだ本人にだけ、その人の結果だけを送る */
export async function kakuAnnounceResult(deps, day) {
  const cur = await kakuEnsureDay(deps, day);
  const d = cur.data, machine = KAKU_MACHINE_NAMES[d.machine];
  const lines = [`今日の確変台は「${machine}」！ 8:00〜15:20、枠をとった人だけが遊べます（還元率がグンと上がります）。`];
  if (d.mode === "sameDay") lines.push("今日は前日の抽選がなく、当日分（12:30〜13:20の10分枠）だけの発売です。");
  else lines.push("前日の抽選に申し込んだ方には、それぞれの結果をプッシュ通知でお知らせしました。ゆうスロの台の一覧の上の「確変台チケット売り場」でも、自分の予定を確認できます。");
  lines.push("【当日分（10分枠）】7:00〜10:45に抽選の申込、先着は11:45から。まだ間に合います！");
  const now = new Date(deps.now());
  await deps.firestore.createIfAbsent(`announcements/kaku-${day}`, { title: truncate(`🌈 今日の確変台は「${machine}」！`, 50), body: truncate(lines.join("\n"), 480), createdAt: now, updatedAt: now, createdByUid: "yuuchat-kaku", createdByName: "ゆうスロ確変台" });
  if (d.mode === "sameDay") return { announced: true };
  return kakuPush(deps, "result1", day, "🌈 確変台の抽選結果", "", (uid) => kakuResultDataFor(d, uid, 1, machine, day));
}

/* 管理者だけ：そのユーザーが「いま販売中の回」で買った宝くじを全部取り消して、全額返金する（本人から頼まれたとき用）。
   ・取り消す番号は売れた番号の表からも外す（ほかの人が買えるようになる）。枚数・売上も減らす。本人の番号の記録は消す。
   ・コインの返金・売れた番号の表・番号の記録の削除・操作の記録は、1回の commit（更新時刻の条件つき）。二重に返金しない。
   ・dryRun:true なら、何も変えずに「何枚・いくら返金か」だけ返す。すでに抽選が済んだ回は取り消せない。 */
async function adminLotteryRefund(deps, callerUid, uid, body) {
  const fs = deps.firestore;
  const ev = lotteryEventFor(lotteryNextDrawMs(deps.now()));
  const docs = await findUserDocsByUid(fs, uid);
  if (docs.length !== 1) return { status: 409, error: docs.length === 0 ? "user_not_found" : "multiple_user_docs" };
  const name = docs[0].id;
  const entryPath = `lotteryEntries/${ev.id}_${uid}`, roundPath = `lotteryRounds/${ev.id}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    let roundRaw = await fs.getRaw(roundPath);
    if (roundRaw && lotteryIsLegacyBits(decodeFields(roundRaw.fields))) { await lotteryResizeRound(deps, ev.id); roundRaw = await fs.getRaw(roundPath); }
    const entryRaw = await fs.getRaw(entryPath);
    const numbers = entryRaw ? (decodeFields(entryRaw.fields).numbers || []).filter((n) => Number.isInteger(n) && n >= 0) : [];
    if (!roundRaw || numbers.length === 0) return { ok: true, name, roundId: ev.id, roundName: ev.name, tickets: 0, refund: 0, dryRun: body?.dryRun === true };
    const round = decodeFields(roundRaw.fields);
    if (round.status === "done") return { status: 409, error: "already_drawn", roundId: ev.id };
    const refund = numbers.length * ev.price;
    if (body?.dryRun === true) return { ok: true, dryRun: true, name, roundId: ev.id, roundName: ev.name, tickets: numbers.length, refund };
    const userRaw = await fs.getRaw(`users/${name}`);
    if (!userRaw || userRaw.fields?.uid?.stringValue !== uid) return { status: 409, error: "user_not_found" };
    const before = readIntegerField(userRaw.fields.coins);
    if (!Number.isSafeInteger(before) || before + refund > ADMIN_COIN_BALANCE_MAX) return { status: 409, error: "invalid_balance" };
    const bits = typeof round.soldBits === "string" ? round.soldBits.split("") : Array(LOTTERY.poolSize).fill("0");
    numbers.forEach((n) => { if (n < bits.length) bits[n] = "0"; });
    const roundFields = { soldBits: bits.join(""), tickets: Math.max(0, (Number(round.tickets) || 0) - numbers.length), sales: Math.max(0, (Number(round.sales) || 0) - refund) };
    try {
      await fs.commit([
        { update: { name: fs.docName(`users/${name}`), fields: {} }, updateMask: { fieldPaths: [] }, updateTransforms: [{ fieldPath: "coins", increment: restInt(refund) }], currentDocument: { updateTime: userRaw.updateTime } },
        { update: { name: fs.docName(roundPath), fields: encodeFields(roundFields) }, updateMask: { fieldPaths: Object.keys(roundFields) }, currentDocument: { updateTime: roundRaw.updateTime } },
        { delete: fs.docName(entryPath), currentDocument: { updateTime: entryRaw.updateTime } },
        { update: { name: fs.docName(`adminAuditLogs/${crypto.randomUUID().replace(/-/g, "")}`), fields: encodeFields({ action: "lotteryRefund", targetUid: uid, targetName: name, roundId: ev.id, tickets: numbers.length, refund, byUid: callerUid, result: "ok" }) }, updateTransforms: [{ fieldPath: "at", setToServerValue: "REQUEST_TIME" }], currentDocument: { exists: false } }
      ]);
    } catch (error) { if (isRetryableCommitError(error)) continue; throw error; }
    lotteryDocCache.delete(roundPath);
    await transferNotify(deps, uid, "🎟 宝くじの購入を取り消しました", `${numbers.length}枚の購入を取り消して、${refund} コインを返金しました。`);
    return { ok: true, name, roundId: ev.id, roundName: ev.name, tickets: numbers.length, refund, afterCoins: before + refund };
  }
  return { status: 409, error: "busy" };
}

/* 管理者だけ：確変台の当選者（その日の枠ごとの名前・NPCかどうか）。プレイヤーには見せない（ほかの人の名前は出さない決まり）。読み取りは1日ぶんのドキュメント1件 */
async function adminKakuWinners(deps, body) {
  const day = typeof body?.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.day) ? body.day : kakuDayId(deps.now());
  const d = await deps.firestore.get(`yuslotKaku/${day}`);
  if (!d) return { ok: true, day, exists: false, machineName: KAKU_MACHINE_NAMES[kakuMachineFor(day)] || "" };
  const slots = (Array.isArray(d.slots) ? d.slots : []).slice().sort((a, b) => a.s - b.s)
    .map((x) => ({ s: x.s, e: x.e, kind: x.kind, name: x.name || "", npc: x.npc === true, empty: !x.name && !x.uid }));
  return {
    ok: true, day, exists: true, machine: d.machine, machineName: KAKU_MACHINE_NAMES[d.machine] || d.machine || "", mode: d.mode,
    draw1Done: d.draw1Done === true, draw2Done: d.draw2Done === true,
    applied1: Number(d.applied1) || (Array.isArray(d.app1) ? d.app1.length : 0), applied2: Number(d.applied2) || (Array.isArray(d.app2) ? d.app2.length : 0),
    slots
  };
}

/* =========================================================
   🏅 ゆうスロの会員ランク
   ・ランクは、ゆうスロで「1週間に使ったコイン」（有料の回転数 × 台の料金。確変中の分も数える。無料スピンは数えない）で決まる。
   ・毎週月曜 7:00（日本時間）に更新：先週の使ったコインで、今週のランクが決まる（下がることもある）。
   ・ランクが高いほど、確変台の抽選に当たりやすい（最高ランクで約3倍。倍率は画面には出さない）。
   ・ランクの条件（使ったコイン）は画面に見せる。回転数・使ったコインは users の slotSpins / slotWagered（精算のたびに Worker が足す）。
   ・Firestore：yuslotRank/current（サーバー専用）の1件だけ。週の始まりの累計（base）・今週のランク（ranks）・先週の分（lastWeek）を入れる。
     週1回の集計は users を1回読んで、このドキュメントを1件書くだけ。抽選のときは1件読む。表示は5分ためて読む。
========================================================= */
export const RANK_LEVELS = [
  { name: "ゆうビギナー", min: 0, mult: 1 },
  { name: "ゆうブロンズ", min: 500, mult: 1.2 },
  { name: "ゆうシルバー", min: 2000, mult: 1.5 },
  { name: "ゆうゴールド", min: 6000, mult: 1.9 },
  { name: "ゆうプラチナ", min: 15000, mult: 2.4 },
  { name: "ゆうダイヤモンド", min: 35000, mult: 3 }
];
export function rankLevelFor(wagered) {
  let level = 0;
  RANK_LEVELS.forEach((r, i) => { if (Number(wagered) >= r.min) level = i; });
  return level;
}
const RANK_WEEK_MS = 7 * 86400000;
const RANK_EPOCH_MS = Date.UTC(2026, 9, 18, 22, 0, 0); // 最初の週の始まり：2026-10-19（月）7:00 JST（記録は 10/20 から始まった）
/* いまを含む週の始まり（月曜 7:00 JST）のミリ秒 */
export function rankWeekStart(nowMs) {
  const DAY = 86400000, shift = 2 * 3600000; // JST の月曜 7:00 を、月曜 0:00 に見立てるためのずらし（+9時間 −7時間）
  const j = nowMs + shift, day = Math.floor(j / DAY);
  const sinceMonday = (new Date(day * DAY).getUTCDay() + 6) % 7;
  return (day - sinceMonday) * DAY - shift;
}
const rankCache = { at: 0, value: null };
export function resetRankCacheForTest() { rankCache.at = 0; rankCache.value = null; rankTickDone.clear(); }
async function rankGet(deps, ttlMs) {
  const now = deps.now();
  if (ttlMs > 0 && rankCache.value && now - rankCache.at < ttlMs) return rankCache.value;
  const raw = await deps.firestore.getRaw("yuslotRank/current");
  const value = raw ? { data: decodeFields(raw.fields), updateTime: raw.updateTime } : null;
  rankCache.at = now; rankCache.value = value;
  return value;
}
/* 今週のランクのドキュメントを返す。無ければ作り、週が替わっていれば先週の分を集計して更新する（更新時刻の条件つきの1回の commit） */
export async function rankEnsureCurrent(deps, { ttlMs = 0 } = {}) {
  const fs = deps.firestore;
  const ws = rankWeekStart(deps.now());
  let cur = await rankGet(deps, ttlMs);
  if (cur && Number(cur.data.weekStart) >= ws) return cur;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0 || (cur && ttlMs > 0)) cur = await rankGet(deps, 0);
    if (cur && Number(cur.data.weekStart) >= ws) return cur;
    if (!cur) {
      await fs.createIfAbsent("yuslotRank/current", { weekStart: RANK_EPOCH_MS, base: {}, ranks: {}, lastWeek: {}, updatedAtMs: deps.now() });
      cur = await rankGet(deps, 0);
      if (!cur || Number(cur.data.weekStart) >= ws) return cur;
    }
    // 週が替わった：先週に使ったコイン＝いまの累計 − 週の始まりの累計。それでランクを決め、いまの累計を次の週の始まりにする
    const users = await fs.query("users", [], { select: ["uid", "slotWagered"] });
    const prevBase = cur.data.base || {};
    const base = {}, ranks = {}, lastWeek = {};
    for (const u of users) {
      const uid = typeof u.data.uid === "string" ? u.data.uid : "";
      if (!uid) continue;
      const total = Math.max(0, Math.trunc(Number(u.data.slotWagered) || 0));
      const week = Math.max(0, total - Math.trunc(Number(prevBase[uid]) || 0));
      if (total > 0) base[uid] = total;
      if (week > 0) lastWeek[uid] = week;
      const level = rankLevelFor(week);
      if (level > 0) ranks[uid] = level;
    }
    const fields = { weekStart: ws, base, ranks, lastWeek, updatedAtMs: deps.now() };
    try {
      await fs.commit([{ update: { name: fs.docName("yuslotRank/current"), fields: encodeFields(fields) }, updateMask: { fieldPaths: Object.keys(fields) }, currentDocument: { updateTime: cur.updateTime } }]);
    } catch (error) { if (isRetryableCommitError(error)) continue; throw error; }
    rankCache.at = 0; rankCache.value = null;
    return rankGet(deps, 0);
  }
  return cur;
}
const rankTickDone = new Set();
/* 毎分の cron から。月曜 7:00〜7:09（日本時間）の間だけ動く（取りこぼしても、次の抽選・表示のときに追いつく） */
export async function runRankTick(env = {}, scheduledTime = Date.now(), deps = null) {
  const j = new Date(scheduledTime + 9 * 3600000);
  if (j.getUTCDay() !== 1 || j.getUTCHours() !== 7 || j.getUTCMinutes() > 9) return { skipped: "outside" };
  const key = String(rankWeekStart(scheduledTime));
  if (rankTickDone.has(key)) return { skipped: "done" };
  const d = deps || createDefaultDeps(env);
  const cur = await rankEnsureCurrent({ ...d, now: () => scheduledTime });
  rankTickDone.add(key);
  return { weekStart: cur?.data?.weekStart, ranked: Object.keys(cur?.data?.ranks || {}).length };
}
/* 画面用：自分のランク・今週の進み・条件（倍率などの抽選の中身は返さない） */
async function rankStatus(deps, uid, body) {
  if (!(await kakuGate(deps, uid))) return { status: 403, error: "not_published" };
  const me = await loadMyUser(deps.firestore, uid, body?.username);
  if (me.error) return me.error;
  const cur = await rankEnsureCurrent(deps, { ttlMs: 300000 });
  const d = cur?.data || {};
  const level = Math.min(RANK_LEVELS.length - 1, Math.max(0, Math.trunc(Number((d.ranks || {})[uid]) || 0)));
  const total = Math.max(0, Math.trunc(readIntegerField(me.raw.fields?.slotWagered) || 0));
  const thisWeek = Math.max(0, total - Math.trunc(Number((d.base || {})[uid]) || 0));
  const projected = rankLevelFor(thisWeek);
  const next = level + 1 < RANK_LEVELS.length ? RANK_LEVELS[level + 1] : null;
  return {
    ok: true, serverNowMs: deps.now(),
    level, name: RANK_LEVELS[level].name, thisWeek, lastWeek: Math.trunc(Number((d.lastWeek || {})[uid]) || 0),
    projected, projectedName: RANK_LEVELS[projected].name,
    next: next ? { name: next.name, min: next.min } : null,
    levels: RANK_LEVELS.map((r) => ({ name: r.name, min: r.min })),
    weekStartMs: Number(d.weekStart) || rankWeekStart(deps.now()), nextRollMs: (Number(d.weekStart) || rankWeekStart(deps.now())) + RANK_WEEK_MS
  };
}

/* =========================================================
   💸 コインの送金（管理者の承認制）
   ・本人が「誰に・いくら」を申請すると、送る人のコインを先に預かる（引く）。コインは増えない・二重に使えない。
   ・最上位管理者だけが、管理者画面で「OK」（相手にコインが届く）か「却下」（送った人に全額戻る）を押せる。
   ・3日たっても承認されない申請は、自動で却下して返金する（毎日 3:07）。送った人が自分で取り消すこともできる。
   ・金額の上限・手数料・メッセージはなし。ゆうスロに着席中は申請できない（スロのコインと二重にならないように）。
   ・Firestore：coinTransfers/{id}（サーバー専用）。コインの移動・状態の更新・操作の記録は1回の commit（更新時刻の条件つき）で行い、二重送金・二重返金は起きない。
========================================================= */
const TRANSFER_EXPIRE_MS = 3 * 24 * 3600 * 1000;
const TRANSFER_RETRY = 8;

/* uid から、いまの users/{名前} を探す（名前が変わっていても追えるように、まず記録した名前を試す） */
async function transferFindUser(fs, uid, hintName) {
  if (typeof hintName === "string" && hintName && hintName.length <= 100 && !hintName.includes("/")) {
    const raw = await fs.getRaw(`users/${hintName}`);
    if (raw && raw.fields?.uid?.stringValue === uid) return { name: hintName, raw };
  }
  const docs = await findUserDocsByUid(fs, uid);
  if (docs.length !== 1) return null;
  const raw = await fs.getRaw(`users/${docs[0].id}`);
  return raw && raw.fields?.uid?.stringValue === uid ? { name: docs[0].id, raw } : null;
}

/* 特定の1人にだけ、プッシュ通知（失敗しても処理は続ける） */
async function transferNotify(deps, uid, title, body) {
  try {
    const tokens = await deps.firestore.query("fcmTokens", [["uid", "EQUAL", uid]], { select: ["uid"] });
    await Promise.all(tokens.map(async (t) => {
      const outcome = await deps.sendFcm(t.id, { kind: "transfer", title, body: truncate(body, 80), link: "./", tag: "coin-transfer" }).catch(() => ({ ok: false }));
      if (outcome && outcome.invalidToken) await deps.firestore.delete(`fcmTokens/${t.id}`).catch(() => {});
    }));
  } catch (error) {
    console.warn("transfer notify failed", String(error?.message || error).slice(0, 200));
  }
}

const transferFields = (id, d) => ({ id, senderUid: d.senderUid, senderName: d.senderName, receiverUid: d.receiverUid, receiverName: d.receiverName, amount: d.amount, createdAtMs: d.createdAtMs });

/* 申請：送る人のコインを預かり、申請を作る（1回の commit） */
async function transferRequest(deps, uid, body) {
  const fs = deps.firestore;
  const to = typeof body?.to === "string" ? body.to.trim() : "";
  const amount = body?.amount;
  if (!to || to.length > 100 || to.includes("/")) return { status: 400, error: "invalid_receiver" };
  if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount <= 0 || amount > ADMIN_COIN_BALANCE_MAX) return { status: 400, error: "invalid_amount" };
  const me = await loadMyUser(fs, uid, body?.username);
  if (me.error) return me.error;
  if (to === me.name) return { status: 400, error: "self" };
  if (await lotterySeatedElsewhere(deps, uid, deps.now())) return { status: 409, error: "seated" };
  const target = await fs.getRaw(`users/${to}`);
  const receiverUid = target?.fields?.uid?.stringValue || "";
  if (!target || !receiverUid) return { status: 404, error: "user_not_found" };
  if (receiverUid === uid) return { status: 400, error: "self" };
  const gone = await fs.get(`userDeletions/${receiverUid}`);
  if (gone) return { status: 404, error: "user_not_found" };

  const id = crypto.randomUUID().replace(/-/g, "");
  let senderRaw = me.raw;
  for (let attempt = 1; attempt <= TRANSFER_RETRY; attempt++) {
    const coins = readIntegerField(senderRaw.fields?.coins);
    if (!Number.isSafeInteger(coins)) return { status: 409, error: "invalid_balance" };
    if (coins < amount) return { status: 409, error: "insufficient_coins", coins };
    try {
      await fs.commit([
        { update: { name: fs.docName(`users/${me.name}`), fields: { coins: { integerValue: String(coins - amount) } } }, updateMask: { fieldPaths: ["coins"] }, currentDocument: { updateTime: senderRaw.updateTime } },
        { update: { name: fs.docName(`coinTransfers/${id}`), fields: encodeFields({ senderUid: uid, senderName: me.name, receiverUid, receiverName: to, amount, status: "pending", createdAtMs: deps.now() }) }, currentDocument: { exists: false } }
      ]);
      return { ok: true, id, coins: coins - amount };
    } catch (error) {
      if (!isRetryableCommitError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20 + Math.random() * 60 * attempt));
      senderRaw = await fs.getRaw(`users/${me.name}`);
      if (!senderRaw || senderRaw.fields?.uid?.stringValue !== uid) return { status: 409, error: "NO_USER" };
    }
  }
  return { status: 409, error: "busy" };
}

/* 却下・取り消し・期限切れ：預かったコインを送った人に戻して、状態を変える（1回の commit） */
async function transferRefund(deps, id, status, by, extra = {}) {
  const fs = deps.firestore;
  for (let attempt = 1; attempt <= TRANSFER_RETRY; attempt++) {
    const raw = await fs.getRaw(`coinTransfers/${id}`);
    if (!raw) return { status: 404, error: "not_found" };
    const d = decodeFields(raw.fields);
    if (d.status !== "pending") return { status: 409, error: "not_pending", transferStatus: d.status };
    if (extra.onlySender && d.senderUid !== extra.onlySender) return { status: 404, error: "not_found" };
    const sender = await transferFindUser(fs, d.senderUid, d.senderName);
    const now = deps.now();
    const fields = { status, resolvedAtMs: now, resolvedBy: by, refunded: Boolean(sender) };
    const writes = [{ update: { name: fs.docName(`coinTransfers/${id}`), fields: encodeFields(fields) }, updateMask: { fieldPaths: Object.keys(fields) }, currentDocument: { updateTime: raw.updateTime } }];
    if (sender) writes.push({ update: { name: fs.docName(`users/${sender.name}`), fields: {} }, updateMask: { fieldPaths: [] }, updateTransforms: [{ fieldPath: "coins", increment: restInt(d.amount) }], currentDocument: { exists: true } });
    if (extra.audit) writes.push({ update: { name: fs.docName(`adminAuditLogs/${crypto.randomUUID().replace(/-/g, "")}`), fields: encodeFields({ action: extra.audit, transferId: id, targetUid: d.senderUid, targetName: d.senderName, receiverUid: d.receiverUid, receiverName: d.receiverName, amount: d.amount, byUid: extra.byUid || "", result: "ok" }) }, updateTransforms: [{ fieldPath: "at", setToServerValue: "REQUEST_TIME" }], currentDocument: { exists: false } });
    try {
      await fs.commit(writes);
      return { ok: true, id, status, refunded: Boolean(sender), transfer: transferFields(id, d) };
    } catch (error) {
      if (!isRetryableCommitError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20 + Math.random() * 60 * attempt));
    }
  }
  return { status: 409, error: "busy" };
}

async function transferCancel(deps, uid, body) {
  const id = typeof body?.id === "string" ? body.id : "";
  if (!/^[0-9a-f]{32}$/.test(id)) return { status: 400, error: "invalid_id" };
  const r = await transferRefund(deps, id, "cancelled", "sender", { onlySender: uid });
  return r.ok ? { ok: true, id } : r;
}

/* 自分が出した、承認待ちの申請（取り消せる） */
async function transferMine(deps, uid) {
  const docs = await deps.firestore.query("coinTransfers", [["senderUid", "EQUAL", uid], ["status", "EQUAL", "pending"]]);
  const list = docs.map((x) => ({ id: x.id, to: x.data.receiverName, amount: x.data.amount, createdAtMs: x.data.createdAtMs, expiresAtMs: x.data.createdAtMs + TRANSFER_EXPIRE_MS }))
    .sort((a, b) => b.createdAtMs - a.createdAtMs);
  return { ok: true, requests: list, serverNowMs: deps.now() };
}

/* 管理者：承認待ちの一覧（誰から誰へ・いくら。判断の材料に、二人の今のコイン・アカウントを作った日・最後のログインも付ける） */
async function adminTransferList(deps) {
  const fs = deps.firestore;
  const docs = await fs.query("coinTransfers", [["status", "EQUAL", "pending"]]);
  const rows = docs.map((x) => ({ id: x.id, ...x.data })).sort((a, b) => a.createdAtMs - b.createdAtMs);
  const info = new Map();
  const uids = [...new Set(rows.flatMap((r) => [r.senderUid, r.receiverUid]))];
  await Promise.all(uids.map(async (u) => {
    const rec = { coins: null, createdAt: null, lastLoginAt: null, exists: false };
    try {
      const found = await transferFindUser(fs, u, rows.find((r) => r.senderUid === u)?.senderName || rows.find((r) => r.receiverUid === u)?.receiverName);
      if (found) { rec.exists = true; rec.name = found.name; rec.coins = readIntegerField(found.raw.fields?.coins); }
      const auth = summarizeAuthUser(await deps.authAdmin.lookup(u));
      if (auth) { rec.createdAt = auth.createdAt; rec.lastLoginAt = auth.lastLoginAt; rec.disabled = auth.disabled; }
    } catch { /* 材料が取れなくても一覧は出す */ }
    info.set(u, rec);
  }));
  const toReceiver = new Map();
  rows.forEach((r) => { const t = toReceiver.get(r.receiverUid) || { count: 0, total: 0 }; t.count++; t.total += r.amount; toReceiver.set(r.receiverUid, t); });
  return {
    ok: true,
    serverNowMs: deps.now(),
    requests: rows.map((r) => ({
      id: r.id, senderName: r.senderName, receiverName: r.receiverName, amount: r.amount, createdAtMs: r.createdAtMs, expiresAtMs: r.createdAtMs + TRANSFER_EXPIRE_MS,
      sender: info.get(r.senderUid), receiver: info.get(r.receiverUid),
      toReceiver: toReceiver.get(r.receiverUid)
    }))
  };
}

async function adminTransferApprove(deps, callerUid, body) {
  const fs = deps.firestore;
  const id = typeof body?.id === "string" ? body.id : "";
  if (!/^[0-9a-f]{32}$/.test(id)) return { status: 400, error: "invalid_id" };
  for (let attempt = 1; attempt <= TRANSFER_RETRY; attempt++) {
    const raw = await fs.getRaw(`coinTransfers/${id}`);
    if (!raw) return { status: 404, error: "not_found" };
    const d = decodeFields(raw.fields);
    if (d.status !== "pending") return { status: 409, error: "not_pending", transferStatus: d.status };
    const receiver = await transferFindUser(fs, d.receiverUid, d.receiverName);
    if (!receiver || await fs.get(`userDeletions/${d.receiverUid}`)) return { status: 409, error: "receiver_missing" };
    const before = readIntegerField(receiver.raw.fields?.coins);
    if (!Number.isSafeInteger(before)) return { status: 409, error: "invalid_balance" };
    if (before + d.amount > ADMIN_COIN_BALANCE_MAX) return { status: 400, error: "balance_too_large" };
    const fields = { status: "approved", resolvedAtMs: deps.now(), resolvedBy: "admin", receiverName: receiver.name };
    try {
      await fs.commit([
        { update: { name: fs.docName(`coinTransfers/${id}`), fields: encodeFields(fields) }, updateMask: { fieldPaths: Object.keys(fields) }, currentDocument: { updateTime: raw.updateTime } },
        { update: { name: fs.docName(`users/${receiver.name}`), fields: {} }, updateMask: { fieldPaths: [] }, updateTransforms: [{ fieldPath: "coins", increment: restInt(d.amount) }], currentDocument: { exists: true } },
        { update: { name: fs.docName(`adminAuditLogs/${crypto.randomUUID().replace(/-/g, "")}`), fields: encodeFields({ action: "coinTransferApprove", transferId: id, targetUid: d.receiverUid, targetName: receiver.name, senderUid: d.senderUid, senderName: d.senderName, amount: d.amount, byUid: callerUid, result: "ok" }) }, updateTransforms: [{ fieldPath: "at", setToServerValue: "REQUEST_TIME" }], currentDocument: { exists: false } }
      ]);
    } catch (error) {
      if (!isRetryableCommitError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20 + Math.random() * 60 * attempt));
      continue;
    }
    await transferNotify(deps, d.receiverUid, "💸 コインが届きました", `${d.senderName}さんから ${d.amount} コインが届きました。`);
    await transferNotify(deps, d.senderUid, "💸 コインを送りました", `${receiver.name}さんへの ${d.amount} コインの送金が承認されました。`);
    return { ok: true, id, amount: d.amount, senderName: d.senderName, receiverName: receiver.name };
  }
  return { status: 409, error: "busy" };
}

async function adminTransferReject(deps, callerUid, body) {
  const id = typeof body?.id === "string" ? body.id : "";
  if (!/^[0-9a-f]{32}$/.test(id)) return { status: 400, error: "invalid_id" };
  const r = await transferRefund(deps, id, "rejected", "admin", { audit: "coinTransferReject", byUid: callerUid });
  if (!r.ok) return r;
  await transferNotify(deps, r.transfer.senderUid, "💸 コインの送金は承認されませんでした", `${r.transfer.receiverName}さんへの ${r.transfer.amount} コインは、送られずに戻りました。`);
  return { ok: true, id, refunded: r.refunded };
}

/* 期限切れ：毎日 日本時間 3:07 に、3日たっても承認されていない申請を、却下して返金する（それ以外の分は何も読まない） */
const transferExpiryDone = new Set();
export function resetTransferCacheForTest() { transferExpiryDone.clear(); }
export async function runTransferExpiryTick(env = {}, scheduledTime = Date.now(), deps = null) {
  const jst = new Date(scheduledTime + 9 * 3600000);
  if (jst.getUTCHours() !== 3 || jst.getUTCMinutes() !== 7) return { skipped: "outside" };
  const day = jst.toISOString().slice(0, 10);
  if (transferExpiryDone.has(day)) return { skipped: "done" };
  const d = deps || createDefaultDeps(env);
  const docs = await d.firestore.query("coinTransfers", [["status", "EQUAL", "pending"]], { select: ["createdAtMs"] });
  const old = docs.filter((x) => Number(x.data.createdAtMs) <= scheduledTime - TRANSFER_EXPIRE_MS);
  let expired = 0;
  for (const x of old) {
    const r = await transferRefund(d, x.id, "expired", "auto");
    if (r.ok) {
      expired++;
      await transferNotify(d, r.transfer.senderUid, "💸 コインの送金の申請が期限切れになりました", `${r.transfer.receiverName}さんへの ${r.transfer.amount} コインは、承認されなかったため戻りました。`);
    }
  }
  transferExpiryDone.add(day);
  return { expired, checked: docs.length };
}

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
    // ゆうスロの署名セッションの鍵（新しい Secret は不要。サービスアカウント秘密鍵などから導出）
    slotSecret: env.SLOT_SESSION_SECRET || env.FIREBASE_SERVICE_ACCOUNT || DEFAULT_ADMIN_UID,
    random: () => { const b = new Uint32Array(1); crypto.getRandomValues(b); return b[0] / 4294967296; },
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
