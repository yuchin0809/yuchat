/* =========================================================
   ゆうChat 通知ロジック
   ・Firestore / FCM は引数（deps）で受け取るので、index.js から呼ぶだけ
   ・FCM には data だけのメッセージを送り、表示は Service Worker
     （firebase-messaging-sw.js）が1回だけ行う（notification を付けると
     FCM の自動表示と二重になるため）
   ・リンクは "./?open=..." の相対URL。公開URLは Service Worker のスコープで決まる
========================================================= */

/* 将来ゲームが増えたら、ここに名前を足すだけでよい */
const GAME_TYPE_NAMES = {
  othello: "オセロ",
  shogi: "将棋",
  daifugo: "大富豪"
};

const MAX_BODY_LENGTH = 100;
const FCM_MULTICAST_LIMIT = 500;
const FIRESTORE_IN_LIMIT = 30;

const TTL_SECONDS = {
  message: 24 * 60 * 60,
  gameInvite: 6 * 60 * 60,
  derby: 30 * 60
};

/* 「このトークンはもう使えない」と分かるエラーだけ削除する */
const INVALID_TOKEN_ERROR_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token"
]);

function getGameTypeName(gameType) {
  return GAME_TYPE_NAMES[gameType] || "ゲーム";
}

function truncateText(text, maxLength = MAX_BODY_LENGTH) {
  const chars = [...String(text || "").replace(/\s+/g, " ").trim()];
  if (chars.length <= maxLength) return chars.join("");
  return chars.slice(0, maxLength - 1).join("") + "…";
}

function chunk(list, size) {
  const result = [];
  for (let i = 0; i < list.length; i += size) result.push(list.slice(i, i + size));
  return result;
}

/* FCM の data は文字列だけ */
function toStringData(data) {
  const result = {};
  Object.entries(data).forEach(([key, value]) => {
    if (value !== undefined && value !== null) result[key] = String(value);
  });
  return result;
}

/* ----- レースID（script.js の formatRaceId と同じ YYYY-MM-DD） ----- */

function getRaceIdForDate(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/* =========================================================
   トークン取得・送信
========================================================= */

async function getTokensForUids(db, uids) {
  const unique = [...new Set(uids.filter(Boolean))];
  const tokens = [];

  for (const group of chunk(unique, FIRESTORE_IN_LIMIT)) {
    const snapshot = await db.collection("fcmTokens").where("uid", "in", group).get();
    snapshot.forEach((doc) => tokens.push(doc.id));
  }
  return [...new Set(tokens)];
}

async function getAllTokens(db) {
  const snapshot = await db.collection("fcmTokens").select("uid").get();
  return snapshot.docs.map((doc) => doc.id);
}

async function deleteTokens(db, tokens, logger) {
  for (const group of chunk(tokens, 400)) {
    const batch = db.batch();
    group.forEach((token) => batch.delete(db.collection("fcmTokens").doc(token)));
    try {
      await batch.commit();
    } catch (error) {
      logger?.warn?.("無効トークン削除失敗", error);
    }
  }
}

/* 1つの無効トークンや1回の送信失敗で、他の端末への送信が止まらないようにする */
async function sendToTokens({ db, messaging, logger }, tokens, data, ttlSeconds) {
  const uniqueTokens = [...new Set(tokens.filter(Boolean))];
  const result = { successCount: 0, failureCount: 0, invalidTokens: [] };
  if (uniqueTokens.length === 0) return result;

  const payloadData = toStringData(data);

  for (const group of chunk(uniqueTokens, FCM_MULTICAST_LIMIT)) {
    try {
      const response = await messaging.sendEachForMulticast({
        tokens: group,
        data: payloadData,
        webpush: {
          headers: { Urgency: "high", TTL: String(ttlSeconds) }
        }
      });

      result.successCount += response.successCount;
      result.failureCount += response.failureCount;

      response.responses.forEach((item, index) => {
        if (!item.success && INVALID_TOKEN_ERROR_CODES.has(item.error?.code)) {
          result.invalidTokens.push(group[index]);
        }
      });
    } catch (error) {
      result.failureCount += group.length;
      logger?.error?.("FCM送信エラー", error);
    }
  }

  if (result.invalidTokens.length) await deleteTokens(db, result.invalidTokens, logger);
  return result;
}

async function sendToUids(deps, uids, data, ttlSeconds) {
  const tokens = await getTokensForUids(deps.db, uids);
  return sendToTokens(deps, tokens, data, ttlSeconds);
}

/* =========================================================
   1. 新しいメッセージ
   ・messages には受信者の uid が無いので、friends / groups から特定する
   ・友達チャット：friends ドキュメントに送信者の uid が含まれる場合だけ、
     もう一方の uid に送る（友達でない人への通知を防ぐ）
   ・グループ：送信者がメンバーの場合だけ、送信者以外のメンバーに送る
========================================================= */

async function findFriendship(db, message) {
  const candidates = [
    message.friendshipId,
    message.sender && message.receiver ? `${message.sender}_${message.receiver}` : null,
    message.sender && message.receiver ? `${message.receiver}_${message.sender}` : null
  ].filter(Boolean);

  for (const id of [...new Set(candidates)]) {
    const snapshot = await db.collection("friends").doc(id).get();
    if (snapshot.exists) return { id: snapshot.id, data: snapshot.data() };
  }
  return null;
}

async function getUidsForUsernames(db, names) {
  const unique = [...new Set(names.filter(Boolean))];
  if (unique.length === 0) return [];
  const refs = unique.map((name) => db.collection("users").doc(name));
  const snapshots = await db.getAll(...refs);
  return snapshots.filter((s) => s.exists && s.data().uid).map((s) => s.data().uid);
}

async function resolveMessageTarget(db, message) {
  if (!message || message.deleted || !message.senderUid) return null;

  if (message.type === "friend") {
    const friendship = await findFriendship(db, message);
    if (!friendship) return null;

    const f = friendship.data;
    let recipientUid = null;
    if (f.user1Uid === message.senderUid) recipientUid = f.user2Uid;
    else if (f.user2Uid === message.senderUid) recipientUid = f.user1Uid;
    else return null;

    /* 古い友達データで uid が無い場合だけ、ユーザー名から探す */
    if (!recipientUid) {
      const otherName = f.user1Uid === message.senderUid ? f.user2 : f.user1;
      if (otherName && otherName === message.receiver) {
        [recipientUid] = await getUidsForUsernames(db, [otherName]);
      }
    }

    if (!recipientUid || recipientUid === message.senderUid) return null;
    return { chatType: "friend", friendshipId: friendship.id, recipientUids: [recipientUid] };
  }

  if (message.type === "group" && message.groupId) {
    const groupSnap = await db.collection("groups").doc(message.groupId).get();
    if (!groupSnap.exists) return null;

    const group = groupSnap.data();
    const members = Array.isArray(group.members) ? group.members : [];
    if (!members.includes(message.sender)) return null;

    const uids = await getUidsForUsernames(db, members.filter((name) => name !== message.sender));
    const recipientUids = [...new Set(uids)].filter((uid) => uid !== message.senderUid);
    return { chatType: "group", groupId: message.groupId, groupName: group.name || "グループ", recipientUids };
  }

  return null;
}

/* 画像の base64 データは絶対に通知に入れない（text だけを使う） */
function buildMessageNotificationData(messageId, message, target) {
  const sender = message.sender || "ユーザー";

  if (target.chatType === "group") {
    return {
      kind: "message",
      messageId,
      senderUid: message.senderUid,
      chatType: "group",
      groupId: target.groupId,
      title: truncateText(target.groupName, 50),
      body: `${truncateText(sender, 30)}さんから新しいメッセージ`,
      link: `./?open=chat&group=${encodeURIComponent(target.groupId)}`,
      tag: `message-${messageId}`
    };
  }

  const text = typeof message.text === "string" ? message.text : "";
  let body = truncateText(text);
  if (!body) body = message.image ? "📷 画像が届きました" : "新しいメッセージが届きました";

  return {
    kind: "message",
    messageId,
    senderUid: message.senderUid,
    chatType: "friend",
    friendshipId: target.friendshipId,
    title: `${truncateText(sender, 30)}さんからメッセージ`,
    body,
    link: `./?open=chat&friendship=${encodeURIComponent(target.friendshipId)}`,
    tag: `message-${messageId}`
  };
}

async function handleNewMessage(deps, messageId, message) {
  const target = await resolveMessageTarget(deps.db, message);
  if (!target || target.recipientUids.length === 0) return { skipped: true };

  const data = buildMessageNotificationData(messageId, message, target);
  return sendToUids(deps, target.recipientUids, data, TTL_SECONDS.message);
}

/* =========================================================
   2. ゲーム招待
   ・gameInvites は「部屋 × 相手」で1件なので、辞退後の再招待は
     ドキュメントの更新になる → pending になった瞬間だけ送る
   ・部屋が存在し、招待した人が部屋の作成者である場合だけ送る
========================================================= */

function isNewPendingInvite(before, after) {
  if (!after || after.status !== "pending") return false;
  return !before || before.status !== "pending";
}

async function handleGameInviteWrite(deps, inviteId, before, after) {
  if (!isNewPendingInvite(before, after)) return { skipped: true };
  if (!after.toUid || !after.fromUid || after.toUid === after.fromUid || !after.roomId) return { skipped: true };

  const roomSnap = await deps.db.collection("gameRooms").doc(after.roomId).get();
  if (!roomSnap.exists || roomSnap.data().ownerUid !== after.fromUid) return { skipped: true };

  const data = {
    kind: "gameInvite",
    inviteId,
    roomId: after.roomId,
    gameType: after.gameType || "",
    title: "🎮 ゲーム招待",
    body: `${truncateText(after.from || "友達", 30)}さんから${getGameTypeName(after.gameType)}への招待`,
    link: `./?open=games&invite=${encodeURIComponent(inviteId)}`,
    tag: `invite-${inviteId}`
  };
  return sendToUids(deps, [after.toUid], data, TTL_SECONDS.gameInvite);
}

/* =========================================================
   3. ゆうダービー開催
   ・レースは毎日決まった時刻に始まる（script.js の RACE_HOUR / RACE_MINUTE）
   ・races/{raceId} は誰かがアプリを開いたときに作られるので、開催の合図には使えない
     → スケジュール実行でその時刻に送る
   ・derbyNotifications/{raceId} を create() で作れた1回だけ送る（再実行でも重複しない）
========================================================= */

async function handleDerbyStart(deps, raceId) {
  const lockRef = deps.db.collection("derbyNotifications").doc(raceId);

  try {
    await lockRef.create({ raceId, status: "sending", createdAt: deps.serverTimestamp() });
  } catch (error) {
    /* ALREADY_EXISTS（gRPC コード 6）= すでに送信済み・送信中 */
    if (error?.code === 6 || error?.code === "already-exists") return { skipped: true };
    throw error;
  }

  try {
    const tokens = await getAllTokens(deps.db);
    const data = {
      kind: "derby",
      raceId,
      title: "🏇 ゆうダービー開催！",
      body: "今回のレースが始まりました！",
      link: "./?open=derby",
      tag: `derby-${raceId}`
    };
    const result = await sendToTokens(deps, tokens, data, TTL_SECONDS.derby);

    await lockRef.update({
      status: "sent",
      successCount: result.successCount,
      failureCount: result.failureCount,
      sentAt: deps.serverTimestamp()
    });
    return result;
  } catch (error) {
    await lockRef.update({ status: "failed", error: String(error?.message || error) }).catch(() => {});
    throw error;
  }
}

module.exports = {
  GAME_TYPE_NAMES,
  getGameTypeName,
  truncateText,
  getRaceIdForDate,
  getTokensForUids,
  sendToTokens,
  resolveMessageTarget,
  buildMessageNotificationData,
  handleNewMessage,
  isNewPendingInvite,
  handleGameInviteWrite,
  handleDerbyStart
};
