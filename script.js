/* =========================================================
   ゆうChat script.js  完全書き直し版
   ・構文エラー修正
   ・重複実装の統合（ゲーム部屋 / 大富豪の二重実装など）
   ・存在しない変数・関数参照の修正
   ・HTMLのid・data属性との整合を確認済み
========================================================= */

import {
  initializeApp
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";

/* ゆうダービーのレース演出（決まった結果を見せるだけ。Firebase には触らない） */
import {
  buildRaceShow,
  createRaceStage,
  getHorseColors,
  RACE_SHOW_MAX_SECONDS
} from "./derby-show.js?v=20261006-derby";

/* ゆうダービーの固定オッズ（derby-runner と同じ計算） */
import {
  isFixedOddsRace,
  getRaceOddsTable,
  getTicketOddsTenths,
  computeFixedPayout,
  computeFixedBetSettlement,
  formatOddsTenths,
  buildRaceOddsRecord,
  generateFixedOddsRaceOrder,
  FIXED_PAYOUT_RULE
} from "./derby-odds.js?v=20261013-fixed-odds";

import {
  getFirestore, collection, addDoc, getDocs, getDoc, doc, setDoc,
  updateDoc, deleteDoc, query, where, onSnapshot, orderBy, limit, arrayUnion, arrayRemove, deleteField,
  serverTimestamp, writeBatch, runTransaction, or, and, startAfter,
  getAggregateFromServer, count as aggregateCount, sum as aggregateSum
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
/* ゆう銀行の返済期限（Timestamp）に使う */
import { Timestamp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

import {
  getMessaging, getToken, onMessage, isSupported, deleteToken
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-messaging.js";

import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInAnonymously,
  onAuthStateChanged, signOut,
  signInWithEmailAndPassword, linkWithCredential, EmailAuthProvider, deleteUser
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";

/* =========================================================
   Firebase設定
========================================================= */

const firebaseConfig = {
  apiKey: "AIzaSyDJFat47USz6KKaGuvj1dVjfELhRmH_2Tw",
  authDomain: "yuuchat-be666.firebaseapp.com",
  projectId: "yuuchat-be666",
  storageBucket: "yuuchat-be666.firebasestorage.app",
  messagingSenderId: "89509274877",
  appId: "1:89509274877:web:978a6179645ce88c3d4a94"
};

const VAPID_PUBLIC_KEY =
  "BNKlLucsJnYok43m4muAEkcQq8cOcNrUKFyNYkCeo2jKhm1RwJVAU6tC7p3PjoaidOU08Hh7oEeRz43S8X73Ppw";

/* 通知を送る Cloudflare Worker（notify-worker）の URL
   空にすると、アプリを閉じている端末への通知は送られない（アプリ内の通知はこれまで通り動く） */
const NOTIFY_ENDPOINT = "https://yuuchat-notify.yuchin08092010.workers.dev/notify";

const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);
const auth = getAuth(firebaseApp);

/* =========================================================
   アプリ状態
========================================================= */

let currentUser = null;
let username = null;
let pendingRecovery = false;

let friendsData = [];
let groupsData = [];

let selectedChat = null;
let selectedChatType = null;
let selectedFriendshipId = null;

let replyingMessage = null;
/* 送信前に選んだ画像（選択中の表示・解除・送信に使う）
   { id, name, size, status: "preparing" | "ready" | "error", dataURL, sentBytes, error } */
let pendingImage = null;
let pendingImageSeq = 0;
let isSendingMessage = false;

let unsubscribeFriends = null;
let unsubscribeFriendsAsUser2 = null;
let unsubscribeGroups = null;
let unsubscribeMessages = null;

let fcmMessaging = null;
let fcmForegroundListenerReady = false;

/* ゲーム関連の状態 */
let currentGameType = "daifugo";
let selectedGameRoomId = null;
let unsubscribeGameRooms = null;
let messagesListenerFailed = false;
let unsubscribeCurrentGame = null;
let selectedDaifugoCards = [];
let selectedShogiPiece = null;
let unsubscribeGameInvites = null;
let pendingGameInvites = [];
let gameInvitesInitialized = false;

/* ゆうダービー関連の状態 */
let myCoins = 0;
let unsubscribeMyCoins = null;
let unsubscribeLiveRace = null;
let unsubscribeWinBets = null;
let unsubscribeMyBetHistory = null;
let raceCountdownTimer = null;
let currentWinPool = {};
let liveRaceResult = null;
/* 手動レース（derbyManualRaces）：raceId → 予定。管理者が作ったものを全員が読む */
let manualRaces = new Map();
let unsubscribeManualRaces = null;
/* 📢 お知らせ（announcements）：一覧は「お知らせ」タブを開いている間だけ購読する。
   未読は users/{名前}.lastAnnouncementReadAt（購読中の自分のユーザーデータ）と、お知らせの createdAt を比べて判定する */
let announcements = [];
let unsubscribeAnnouncements = null;
let latestAnnouncementAt = null;
let lastGenerationAttemptAt = -999;
let lastActiveBettingRaceId = null;
let lastLiveRaceId = null;
let selectedBetHorses = [];
let myAllBets = [];
let cachedPopularityForRaceId = null;
let cachedPopularity = null;

/* =========================================================
   HTML要素取得（index.htmlのidと一致させています）
========================================================= */

const loginScreen = document.getElementById("loginScreen");
const nameScreen = document.getElementById("nameScreen");
const appElement = document.getElementById("app");

const googleLoginButton = document.getElementById("googleLoginButton");
const guestLoginButton = document.getElementById("guestLoginButton");
const existingLoginButton = document.getElementById("existingLoginButton");
const passwordLoginButton = document.getElementById("passwordLoginButton");
const loginError = document.getElementById("loginError");

const nameInput = document.getElementById("nameInput");
const startChatButton = document.getElementById("startChatButton");
const nameError = document.getElementById("nameError");

const passwordLoginScreen = document.getElementById("passwordLoginScreen");
const passwordLoginUsernameInput = document.getElementById("passwordLoginUsernameInput");
const passwordLoginPasswordInput = document.getElementById("passwordLoginPasswordInput");
const passwordLoginSubmitButton = document.getElementById("passwordLoginSubmitButton");
const passwordLoginError = document.getElementById("passwordLoginError");
const passwordLoginBackButton = document.getElementById("passwordLoginBackButton");

const modalEl = document.getElementById("modal");

const recoverScreen = document.getElementById("recoverScreen");
const recoverStepText = document.getElementById("recoverStepText");
const recoverAuthStep = document.getElementById("recoverAuthStep");
const recoverGoogleButton = document.getElementById("recoverGoogleButton");
const recoverGuestButton = document.getElementById("recoverGuestButton");
const recoverNameStep = document.getElementById("recoverNameStep");
const recoverUsernameInput = document.getElementById("recoverUsernameInput");
const recoverConfirmButton = document.getElementById("recoverConfirmButton");
const recoverNewAccountButton = document.getElementById("recoverNewAccountButton");
const recoverError = document.getElementById("recoverError");
const recoverBackButton = document.getElementById("recoverBackButton");

const myName = document.getElementById("myName");

const friendsList = document.getElementById("friendsList");
const groupsList = document.getElementById("groupsList");

const addFriendButton = document.getElementById("addFriendButton");
const createGroupButton = document.getElementById("createGroupButton");
const logoutButton = document.getElementById("logoutButton");

const chatHeader = document.getElementById("chatHeader");
const messagesElement = document.getElementById("messages");
const messageInput = document.getElementById("messageInput");
const sendButton = document.getElementById("sendButton");

const replyBar = document.getElementById("replyBar");
const replyText = document.getElementById("replyText");
const cancelReplyButton = document.getElementById("cancelReplyButton");

const profileImageInput = document.getElementById("profileImageInput");
const myProfileImage = document.getElementById("myProfileImage");
const profileImagePlaceholder = document.getElementById("profileImagePlaceholder");
const changeNameButton = document.getElementById("changeNameButton");

const imageButton = document.getElementById("imageButton");
const imageInput = document.getElementById("imageInput");
const imagePreviewBar = document.getElementById("imagePreviewBar");
const imagePreviewThumb = document.getElementById("imagePreviewThumb");
const imagePreviewName = document.getElementById("imagePreviewName");
const imagePreviewStatus = document.getElementById("imagePreviewStatus");
const imagePreviewClear = document.getElementById("imagePreviewClear");

const chatView = document.getElementById("chatView");
const derbyView = document.getElementById("derbyView");
const gamesView = document.getElementById("gamesView");
const mypageView = document.getElementById("mypageView");
const announcementsView = document.getElementById("announcementsView");
const userManageView = document.getElementById("userManageView");
const economyView = document.getElementById("economyView");
const economyContent = document.getElementById("economyContent");

const derbyCountdown = document.getElementById("derbyCountdown");
const raceTrack = document.getElementById("raceTrack");
const raceInfo = document.getElementById("raceInfo");
const oddsList = document.getElementById("oddsList");
const betType = document.getElementById("betType");
const betHorsesHint = document.getElementById("betHorsesHint");
const betHorsesPicker = document.getElementById("betHorsesPicker");
const betHorsesSelection = document.getElementById("betHorsesSelection");
const betAmount = document.getElementById("betAmount");
const betButton = document.getElementById("betButton");
const horseList = document.getElementById("horseList");

const gameRoomsEl = document.getElementById("gameRooms");
const gameAreaEl = document.getElementById("gameArea");
const createGameRoomButton = document.getElementById("createGameRoom");
const gameInvitesEl = document.getElementById("gameInvites");

const myCoinLarge = document.getElementById("myCoinLarge");
const myBetCount = document.getElementById("myBetCount");
const myHitCount = document.getElementById("myHitCount");
const myProfit = document.getElementById("myProfit");
const rankingEl = document.getElementById("ranking");
const historyEl = document.getElementById("history");
const coinBalanceEl = document.getElementById("coinBalance");

/* =========================================================
   共通関数
========================================================= */

function showError(element, text) {
  if (element) element.textContent = text || "";
}

function escapeHTML(value) {
  const div = document.createElement("div");
  div.textContent = value ?? "";
  return div.innerHTML;
}

function createFriendshipId(userA, userB) {
  return [userA, userB].sort((a, b) => a.localeCompare(b)).join("_");
}

/* =========================================================
   ログイン前の画面の切り替え
   ・起動直後は「読み込み中」を表示し、ログイン状態の確認が終わってから画面を決める
   ・名前設定画面は、この画面でユーザーがログイン操作をしたときだけ開く
     （前回のログインが自動で復元されただけのときは開かない）
   ・ログアウト状態の画面（最初の画面・パスワード・アカウントを探す）を表示中は、
     ログイン状態の変化で勝手に画面を切り替えない
========================================================= */

const authLoadingScreen = document.getElementById("authLoadingScreen");
const authLoadingText = document.getElementById("authLoadingText");
const authLoadingActions = document.getElementById("authLoadingActions");
const authRetryButton = document.getElementById("authRetryButton");
const authToLoginButton = document.getElementById("authToLoginButton");
const nameBackButton = document.getElementById("nameBackButton");

const AUTH_SCREENS = [authLoadingScreen, loginScreen, passwordLoginScreen, nameScreen, recoverScreen];

let loginIntent = false;        /* この画面でユーザーがログイン操作をしたか */
let authFlowLock = false;       /* パスワードログインの途中は、onAuthStateChanged で画面を動かさない */
let authResolveSeq = 0;         /* 古い確認処理の結果で画面を上書きしないための番号 */
let resolvedUid = null;         /* アプリに入った uid（同じユーザーで二重に起動しないため） */
let nameScreenOrigin = "login"; /* 名前設定画面の「戻る」の行き先（"login" / "recover"） */

function isShown(element) {
  return Boolean(element) && !element.classList.contains("hidden");
}

function showAuthScreen(screen) {
  appElement?.classList.add("hidden");
  AUTH_SCREENS.forEach((element) => element?.classList.toggle("hidden", element !== screen));
}

function showAuthLoading(text = "読み込み中...") {
  if (authLoadingText) authLoadingText.textContent = text;
  authLoadingActions?.classList.add("hidden");
  showAuthScreen(authLoadingScreen);
}

function showAuthLoadError(text) {
  if (authLoadingText) authLoadingText.textContent = text;
  authLoadingActions?.classList.remove("hidden");
  showAuthScreen(authLoadingScreen);
}

function showLoginScreen() {
  loginIntent = false;
  showError(loginError, "");
  showAuthScreen(loginScreen);
}

/* ログアウトしたままでよい画面を表示中か */
function isSignedOutScreenShown() {
  if (isShown(loginScreen) || isShown(passwordLoginScreen)) return true;
  return isShown(recoverScreen) && !isShown(recoverNameStep);
}

/* 開発者向け：Firebase から返ってきた本当のエラー（コードとメッセージ）をコンソールに出す */
function logFirebaseError(label, error) {
  console.error(`[${label}] code=${error?.code || "(なし)"} message=${error?.message || String(error)}`, error);
}

/* Firebase のエラーを、原因が分かるメッセージにする */
function describeFirebaseError(error, fallback) {
  const code = String(error?.code || "").replace(/^(auth|firestore)\//, "");
  const message = String(error?.message || "");

  if (code === "unavailable" || code === "network-request-failed" || /offline/i.test(message)) {
    return "通信できませんでした。インターネット接続を確認して、もう一度お試しください。";
  }
  if (code === "deadline-exceeded") return "通信がタイムアウトしました。もう一度お試しください。";
  if (code === "permission-denied") return "権限がないため処理できませんでした。一度ログインし直してからお試しください。";
  if (code === "unauthenticated" || code === "user-token-expired" || code === "requires-recent-login") {
    return "ログインの有効期限が切れました。ログインし直してください。";
  }
  if (code === "resource-exhausted" || code === "too-many-requests") return "混み合っています。しばらく待ってからお試しください。";
  if (code === "invalid-argument") return "保存できないデータが含まれていました。別の名前やプロフィール画像でお試しください。";
  if (code === "operation-not-allowed") return "このログイン方法は現在使えません。";
  if (code === "user-disabled") return "このアカウントは管理者によって停止されています。";
  return code ? `${fallback}（${code}）` : fallback;
}

/* ----- ユーザー名のルール -----
   ひらがな・カタカナ（長音「ー」を含む）・漢字（「々」「〆」を含む）・英数字（全角も可）・スペース・「_」「-」
   先頭と末尾が「__」の名前は Firestore のドキュメントIDとして使えないので拒否する */
const USERNAME_PATTERN = /^[ぁ-ゖゝゞァ-ヺーヽヾ々〆〇一-鿿㐀-䶿a-zA-Z0-9Ａ-Ｚａ-ｚ０-９ _\-]+$/u;

function validateUsername(name) {
  if (!name) return "名前を入力してください。";
  if (name.length > 20) return "名前は20文字以内にしてください。";
  if (!USERNAME_PATTERN.test(name)) {
    return "使用できない文字が含まれています。（ひらがな・カタカナ・漢字・英数字・スペース・「_」「-」が使えます）";
  }
  if (/^__.*__$/.test(name)) return "先頭と末尾が「__」の名前は使えません。";
  return "";
}

/* =========================================================
   ログイン（最初の画面）
========================================================= */

function isPopupCancelled(error) {
  return error?.code === "auth/popup-closed-by-user" || error?.code === "auth/cancelled-popup-request";
}

/* 同じユーザーのままだと onAuthStateChanged が呼ばれないので、そのときは自分で画面を決める */
function resolveIfSameUser(uidBefore) {
  if (auth.currentUser && auth.currentUser.uid === uidBefore) resolveAuthState(auth.currentUser);
}

googleLoginButton?.addEventListener("click", async () => {
  const uidBefore = auth.currentUser?.uid || null;
  try {
    showError(loginError, "");
    loginIntent = true;
    nameScreenOrigin = "login";
    pendingRecovery = false;
    await signInWithPopup(auth, new GoogleAuthProvider());
    resolveIfSameUser(uidBefore);
  } catch (error) {
    loginIntent = false;
    if (isPopupCancelled(error)) return;
    console.error("Googleログインエラー:", error);
    showError(loginError, describeFirebaseError(error, "ログインに失敗しました。"));
  }
});

guestLoginButton?.addEventListener("click", async () => {
  const uidBefore = auth.currentUser?.uid || null;
  try {
    showError(loginError, "");
    loginIntent = true;
    nameScreenOrigin = "login";
    pendingRecovery = false;
    await signInAnonymously(auth);
    resolveIfSameUser(uidBefore);
  } catch (error) {
    loginIntent = false;
    console.error("ゲストログインエラー:", error);
    showError(loginError, describeFirebaseError(error, "ゲストログインに失敗しました。"));
  }
});

/* =========================================================
   ログイン（既存アカウントを探す）
   ・パスワードは使わず、Firebase Authの uid が一致する場合のみ
     そのユーザー名のアカウントを復元できる仕組み
   ・他人のユーザー名を入力しても uid が一致しなければ復元できない
========================================================= */

function showRecoverAuthStep() {
  showAuthScreen(recoverScreen);
  recoverAuthStep?.classList.remove("hidden");
  recoverNameStep?.classList.add("hidden");
  if (recoverStepText) recoverStepText.textContent = "まずはログイン方法を選んでください";
  showError(recoverError, "");
  if (recoverUsernameInput) recoverUsernameInput.value = "";
}

function showRecoverNameStepIfReady() {
  if (pendingRecovery && currentUser) {
    showAuthScreen(recoverScreen);
    recoverAuthStep?.classList.add("hidden");
    recoverNameStep?.classList.remove("hidden");
    if (recoverStepText) recoverStepText.textContent = "以前使っていた名前を入力してください";
  }
}

existingLoginButton?.addEventListener("click", () => {
  pendingRecovery = true;
  showRecoverAuthStep();
});

/* =========================================================
   ユーザー名＋パスワードでログイン
   （パスワードそのものはメールを使わず、Firebase Authの
    email/password機能を「ユーザーのuidから作った内部専用のダミーアドレス」で
    利用する。ユーザー名が後で変更されても、uidは変わらないのでログインは壊れない）
   ・Firestore は「ログイン済みのみ読める」ので、ユーザー名から uid を調べる間だけ
     一時的なゲストログインを使い、調べ終わったらその一時アカウントは削除する
========================================================= */

function makePasswordAuthEmail(uid) {
  return `u-${uid}@yuuchat.local`;
}

function clearPasswordLoginForm() {
  showError(passwordLoginError, "");
  if (passwordLoginUsernameInput) passwordLoginUsernameInput.value = "";
  if (passwordLoginPasswordInput) passwordLoginPasswordInput.value = "";
}

function showPasswordLoginScreen() {
  clearPasswordLoginForm();
  showAuthScreen(passwordLoginScreen);
}

passwordLoginButton?.addEventListener("click", showPasswordLoginScreen);

passwordLoginBackButton?.addEventListener("click", () => {
  clearPasswordLoginForm();
  showLoginScreen();
});

/* 一時的なゲストアカウントを片付ける（削除できなければログアウトだけする） */
async function discardTemporaryUser(tempUser) {
  if (!tempUser || auth.currentUser?.uid !== tempUser.uid) return;
  try {
    await deleteUser(tempUser);
  } catch (error) {
    console.warn("一時アカウントの削除に失敗:", error);
    try { await signOut(auth); } catch (signOutError) { console.warn("サインアウト失敗:", signOutError); }
  }
}

passwordLoginSubmitButton?.addEventListener("click", async () => {
  const name = passwordLoginUsernameInput?.value.trim();
  const password = passwordLoginPasswordInput?.value || "";

  showError(passwordLoginError, "");

  if (!name) return showError(passwordLoginError, "ユーザー名を入力してください。");
  if (!password) return showError(passwordLoginError, "パスワードを入力してください。");

  const previousSavedName = localStorage.getItem("yuuchat_username");
  let tempUser = null;
  let signedIn = false;

  try {
    passwordLoginSubmitButton.disabled = true;
    authFlowLock = true;

    /* 1. ユーザー名から uid を調べる（未ログインなら一時的なゲストログインで読む） */
    if (!auth.currentUser) {
      const credential = await signInAnonymously(auth);
      tempUser = credential.user;
    }

    let userDoc;
    try {
      userDoc = await getDoc(doc(db, "users", name));
    } finally {
      await discardTemporaryUser(tempUser);
    }

    if (!userDoc.exists() || !userDoc.data().uid) {
      showError(passwordLoginError, "そのユーザー名のアカウントが見つかりません。");
      return;
    }

    /* 2. パスワードでログイン。成功したらこのユーザー名で自動的にアプリへ進む */
    localStorage.setItem("yuuchat_username", name);
    loginIntent = true;
    await signInWithEmailAndPassword(auth, makePasswordAuthEmail(userDoc.data().uid), password);
    signedIn = true;
  } catch (error) {
    logFirebaseError("パスワードログインエラー", error);
    await discardTemporaryUser(tempUser);
    loginIntent = false;

    if (previousSavedName) localStorage.setItem("yuuchat_username", previousSavedName);
    else localStorage.removeItem("yuuchat_username");

    if (error.code === "auth/wrong-password" || error.code === "auth/invalid-credential") {
      showError(passwordLoginError, "パスワードが正しくありません。（パスワードを設定していないアカウントの場合も、このように表示されます）");
    } else if (error.code === "auth/user-not-found") {
      showError(passwordLoginError, "このアカウントはまだパスワードが設定されていません。パスワードを設定した端末でアプリを開いてください。");
    } else {
      showError(passwordLoginError, describeFirebaseError(error, "ログインに失敗しました。"));
    }
  } finally {
    authFlowLock = false;
    passwordLoginSubmitButton.disabled = false;
  }

  if (signedIn && auth.currentUser) resolveAuthState(auth.currentUser);
});

recoverGoogleButton?.addEventListener("click", async () => {
  try {
    showError(recoverError, "");
    pendingRecovery = true;
    await signInWithPopup(auth, new GoogleAuthProvider());
    currentUser = auth.currentUser;
    showRecoverNameStepIfReady();
  } catch (error) {
    if (isPopupCancelled(error)) return;
    console.error("Googleログインエラー:", error);
    showError(recoverError, describeFirebaseError(error, "ログインに失敗しました。"));
  }
});

recoverGuestButton?.addEventListener("click", async () => {
  try {
    showError(recoverError, "");
    pendingRecovery = true;
    await signInAnonymously(auth);
    currentUser = auth.currentUser;
    showRecoverNameStepIfReady();
  } catch (error) {
    console.error("ゲストログインエラー:", error);
    showError(recoverError, describeFirebaseError(error, "ゲストログインに失敗しました。"));
  }
});

recoverConfirmButton?.addEventListener("click", async () => {
  const name = recoverUsernameInput?.value.trim();
  showError(recoverError, "");

  if (!name) return showError(recoverError, "名前を入力してください。");
  if (!currentUser) return showError(recoverError, "ログインが完了していません。");

  try {
    recoverConfirmButton.disabled = true;
    const userDoc = await getDoc(doc(db, "users", name));

    if (!userDoc.exists()) {
      showError(recoverError, "そのアカウントは見つかりませんでした。");
      return;
    }

    if (userDoc.data().uid !== currentUser.uid) {
      showError(recoverError, "このアカウントの持ち主ではないため、ログインできません。");
      return;
    }

    pendingRecovery = false;
    await enterAppAs(name, userDoc.data(), ++authResolveSeq);
  } catch (error) {
    console.error("アカウント確認エラー:", error);
    showError(recoverError, describeFirebaseError(error, "確認中にエラーが発生しました。"));
  } finally {
    recoverConfirmButton.disabled = false;
  }
});

recoverNewAccountButton?.addEventListener("click", () => {
  pendingRecovery = false;
  if (currentUser) {
    loginIntent = true;
    showNameScreen("recover");
  } else {
    pendingRecovery = true;
    showRecoverAuthStep();
  }
});

/* 戻る：名前入力の段階 → ログイン方法を選ぶ段階（ログアウトする）／ログイン方法を選ぶ段階 → 最初の画面 */
recoverBackButton?.addEventListener("click", async () => {
  if (isShown(recoverNameStep)) {
    pendingRecovery = true;
    showRecoverAuthStep();
    if (auth.currentUser && !username) {
      try { await signOut(auth); } catch (error) { console.error("サインアウトエラー:", error); }
    }
    return;
  }

  pendingRecovery = false;
  showError(recoverError, "");
  showLoginScreen();
});

/* =========================================================
   Firebase認証状態
========================================================= */

/* 自分のユーザー名を探す：①この端末で最後に使った名前 ②uid が一致するユーザー */
async function findOwnUserProfile(user) {
  const savedName = localStorage.getItem("yuuchat_username");

  if (savedName) {
    const snapshot = await getDoc(doc(db, "users", savedName));
    if (snapshot.exists() && snapshot.data().uid === user.uid) {
      return { name: savedName, data: snapshot.data() };
    }
  }

  const result = await getDocs(query(collection(db, "users"), where("uid", "==", user.uid), limit(1)));
  if (!result.empty) return { name: result.docs[0].id, data: result.docs[0].data() };
  return null;
}

async function resolveAuthState(user) {
  if (!user) return;
  const seq = ++authResolveSeq;
  currentUser = user;

  if (pendingRecovery) {
    showRecoverNameStepIfReady();
    return;
  }

  /* すでにこのユーザーでアプリに入っていれば何もしない */
  if (resolvedUid === user.uid && username && isShown(appElement)) return;

  showAuthLoading();

  try {
    const profile = await findOwnUserProfile(user);
    if (seq !== authResolveSeq) return;

    if (profile) {
      await enterAppAs(profile.name, profile.data, seq);
      return;
    }

    /* 前回のログインが自動で復元されただけなら、名前設定画面は開かずに最初の画面を出す */
    if (!loginIntent) {
      showLoginScreen();
      return;
    }

    /* Googleの表示名がまだ誰にも使われていなければ、今まで通りその名前で始める */
    const suggestedName = (user.displayName || "").trim();
    if (suggestedName && !validateUsername(suggestedName)) {
      const snapshot = await getDoc(doc(db, "users", suggestedName));
      if (seq !== authResolveSeq) return;
      if (!snapshot.exists()) {
        await enterAppAs(suggestedName, null, seq);
        return;
      }
    }

    showNameScreen(nameScreenOrigin);
  } catch (error) {
    if (seq !== authResolveSeq) return;
    logFirebaseError("ユーザー確認エラー", error);
    showAuthLoadError(describeFirebaseError(error, "アカウント情報を読み込めませんでした。"));
  }
}

function handleSignedOut() {
  authResolveSeq++;
  appSessionSeq++;
  currentUser = null;
  username = null;
  resolvedUid = null;
  if (authFlowLock) return;

  /* ログアウト状態の画面を表示中なら、そのまま（戻るボタンやパスワード入力中の画面を上書きしない） */
  if (!isSignedOutScreenShown()) {
    pendingRecovery = false;
    showLoginScreen();
  }
}

onAuthStateChanged(auth, (user) => {
  if (!user) {
    handleSignedOut();
    return;
  }
  if (authFlowLock) return;
  resolveAuthState(user);
});

authRetryButton?.addEventListener("click", () => {
  if (auth.currentUser) resolveAuthState(auth.currentUser);
  else showLoginScreen();
});

authToLoginButton?.addEventListener("click", () => {
  authResolveSeq++;
  pendingRecovery = false;
  showLoginScreen();
});

/* =========================================================
   名前画面
========================================================= */

function showNameScreen(origin = "login") {
  nameScreenOrigin = origin;
  showError(nameError, "");
  if (nameInput) nameInput.value = "";
  showAuthScreen(nameScreen);
}

startChatButton?.addEventListener("click", async () => {
  const name = nameInput?.value.trim() || "";
  showError(nameError, "");

  const invalidReason = validateUsername(name);
  if (invalidReason) return showError(nameError, invalidReason);
  if (!currentUser) return showError(nameError, "ログイン状態を確認できませんでした。「戻る」からもう一度ログインしてください。");

  try {
    startChatButton.disabled = true;

    /* 1. 名前が使えるか確認 */
    let existing;
    try {
      existing = await getDoc(doc(db, "users", name));
    } catch (error) {
      logFirebaseError("名前確認エラー", error);
      showError(nameError, describeFirebaseError(error, "名前を確認できませんでした。"));
      return;
    }

    if (existing.exists() && existing.data().uid !== currentUser.uid) {
      showError(nameError, "その名前はすでに使われています。");
      return;
    }

    /* 2. 保存してアプリへ（保存後の画面表示で起きたエラーは「保存失敗」として扱わない） */
    try {
      await enterAppAs(name, existing.exists() ? existing.data() : null, ++authResolveSeq);
    } catch (error) {
      logFirebaseError("名前設定エラー", error);
      showError(nameError, describeFirebaseError(error, "名前を保存できませんでした。"));
    }
  } finally {
    startChatButton.disabled = false;
  }
});

/* 戻る：ログイン済みなのでログアウトして、来た画面（最初の画面／アカウントを探す）に戻る */
nameBackButton?.addEventListener("click", async () => {
  showError(nameError, "");
  if (nameInput) nameInput.value = "";
  loginIntent = false;

  if (nameScreenOrigin === "recover") {
    pendingRecovery = true;
    showRecoverAuthStep();
  } else {
    pendingRecovery = false;
    showLoginScreen();
  }

  if (auth.currentUser && !username) {
    try { await signOut(auth); } catch (error) { console.error("サインアウトエラー:", error); }
  }
});

/* =========================================================
   ユーザープロフィール
========================================================= */

/* このユーザーとしてアプリに入る。
   existingData が null（新しく名前を作る）ときは、保存に失敗したらエラーを投げる */
async function enterAppAs(name, existingData, seq) {
  username = name;
  localStorage.setItem("yuuchat_username", name);

  /* プロフィール画像はこのアカウントのものだけを使う（新しいアカウントは画像なし） */
  myProfileImageData = await normalizeProfileImage(existingData?.profileImage || "");

  try {
    await saveUserProfile();
  } catch (error) {
    if (!existingData) {
      username = null;
      localStorage.removeItem("yuuchat_username");
      myProfileImageData = "";
      throw error;
    }
    /* 既存のアカウントはプロフィールの更新に失敗してもログインは続ける */
    logFirebaseError("プロフィール更新エラー（ログインは続行）", error);
  }

  if (seq !== authResolveSeq) return;
  resolvedUid = currentUser?.uid || null;
  loginIntent = false;

  try {
    showApp();
  } catch (error) {
    logFirebaseError("アプリ表示エラー（名前の保存は成功済み）", error);
  }
}

async function saveUserProfile() {
  if (!currentUser || !username) return;

  const userRef = doc(db, "users", username);
  const existing = await getDoc(userRef);
  const oldData = existing.exists() ? existing.data() : {};

  await setDoc(userRef, {
    uid: currentUser.uid,
    name: username,
    photoURL: currentUser.photoURL || "",
    profileImage: getMyProfileImage(),
    updatedAt: serverTimestamp(),
    createdAt: oldData.createdAt || serverTimestamp()
  }, { merge: true });
}

function showApp() {
  AUTH_SCREENS.forEach((element) => element?.classList.add("hidden"));
  appElement?.classList.remove("hidden");
  if (myName) myName.textContent = username || "ユーザー";
  loadProfileImage();
  startApp();
  maybePromptSetPassword();
}

/* =========================================================
   パスワード未設定のアカウントに、設定を促す
   （今のログイン方法＝Google/ゲストはそのまま維持しつつ、
    同じアカウントにパスワードを追加で紐づけるだけなので、
    既存のデータ・ログイン方法は一切失われない） */

function hasPasswordLinked() {
  return Boolean(currentUser?.providerData?.some((p) => p.providerId === "password"));
}

function maybePromptSetPassword() {
  if (!currentUser || !username || !modalEl) return;
  if (hasPasswordLinked()) return;

  modalEl.classList.remove("hidden");
  modalEl.innerHTML = `
    <div class="modal-card">
      <h3>🔐 パスワードを設定しませんか？</h3>
      <p style="font-size:13px; color:#666; margin-bottom:14px;">
        パスワードを設定すると、他の端末でも「ユーザー名とパスワード」でこのアカウントに入れるようになります。
      </p>
      <input id="setPasswordInput1" type="password" placeholder="新しいパスワード（6文字以上）" autocomplete="new-password">
      <input id="setPasswordInput2" type="password" placeholder="もう一度入力" autocomplete="new-password">
      <div id="setPasswordError" class="error"></div>
      <div class="modal-buttons">
        <button id="setPasswordSkipButton" class="modal-secondary" type="button">あとで</button>
        <button id="setPasswordConfirmButton" class="modal-primary" type="button">設定する</button>
      </div>
    </div>
  `;

  document.getElementById("setPasswordSkipButton")?.addEventListener("click", () => {
    modalEl.classList.add("hidden");
    modalEl.innerHTML = "";
  });

  document.getElementById("setPasswordConfirmButton")?.addEventListener("click", async () => {
    const errorEl = document.getElementById("setPasswordError");
    const p1 = document.getElementById("setPasswordInput1")?.value || "";
    const p2 = document.getElementById("setPasswordInput2")?.value || "";
    const confirmButton = document.getElementById("setPasswordConfirmButton");

    showError(errorEl, "");

    if (p1.length < 6) return showError(errorEl, "パスワードは6文字以上にしてください。");
    if (p1 !== p2) return showError(errorEl, "パスワードが一致しません。");

    try {
      if (confirmButton) confirmButton.disabled = true;

      const authEmail = makePasswordAuthEmail(currentUser.uid);
      const credential = EmailAuthProvider.credential(authEmail, p1);
      await linkWithCredential(currentUser, credential);

      alert("パスワードを設定しました。他の端末では「ユーザー名とパスワードでログイン」から入れます。");
      modalEl.classList.add("hidden");
      modalEl.innerHTML = "";
    } catch (error) {
      console.error("パスワード設定エラー:", error);
      if (error.code === "auth/requires-recent-login") {
        showError(errorEl, "セキュリティのため、一度ログインし直してからもう一度お試しください。");
      } else {
        showError(errorEl, "パスワードの設定に失敗しました。");
      }
    } finally {
      if (confirmButton) confirmButton.disabled = false;
    }
  });
}

/* =========================================================
   アプリ開始
========================================================= */

/* ログイン直後は、Firestore がログイン情報を受け取る前に読み取りが出て拒否されることがある。
   購読や読み取りを始める前に、自分のユーザー情報を1回読めることを確かめる（拒否されたら少し待ってやり直す） */
async function waitForFirestoreAuth() {
  const uid = currentUser?.uid;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await getDoc(doc(db, "users", username));
      return true;
    } catch (error) {
      if (error?.code !== "permission-denied" || currentUser?.uid !== uid) return false;
      await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
    }
  }
  return false;
}

/* ログインのたびに番号を振る。ログアウトしたら番号を進め、待っている途中の古い起動処理はそこでやめる
   （ログアウトの後に購読や読み取りを始めないように） */
let appSessionSeq = 0;

/* ログアウト（やアカウントの切り替え）で途中になった読み取りの失敗は、エラーとして扱わない
   （結果が返る前にログアウトすると、Firestore がログアウト後の状態で問い合わせ直して拒否されるため） */
function isInterruptedBySignOut(session) {
  return session !== appSessionSeq || !currentUser;
}

async function startApp() {
  if (!currentUser || !username) return;

  const session = ++appSessionSeq;
  const startedUid = currentUser.uid;
  await waitForFirestoreAuth();
  if (session !== appSessionSeq || !currentUser || currentUser.uid !== startedUid || !username) return;

  try {
    resetNewMessageWatch();
    listenFriends();
    listenGroups();
    restoreNotificationsIfGranted();
    updateNotifyAnnouncement();
    listenMyCoins();
    listenMyBetHistory();
    listenGameInvites();
    listenManualRaces();
    checkLatestAnnouncement();
    updateAdminVisibility();
    catchUpMissedRaces();
    try { initializeSafeRace(); } catch (e) { console.error("レース初期化エラー:", e); }
  } catch (error) {
    console.error("アプリ起動エラー:", error);
  }
}

/* =========================================================
   プロフィール画像
   ・選んだ画像は 256px 以内の JPEG に縮小・圧縮してから使う
     （Firestore の 1ドキュメント 1MiB の上限に十分余裕を持たせる。メッセージの senderPhoto も小さくなる）
   ・画像はアカウントごと（users/{username}.profileImage）に持ち、端末（localStorage）には残さない
     （以前は端末に1つだけ保存していたため、別のアカウントに引き継がれていた）
========================================================= */

const PROFILE_IMAGE_MAX_SIZE = 256;
const PROFILE_IMAGE_MAX_LENGTH = 120 * 1024;
const PROFILE_IMAGE_MAX_FILE_BYTES = 20 * 1024 * 1024;
const LEGACY_PROFILE_IMAGE_KEY = "yuuchat_profile_image";

let myProfileImageData = "";

/* 以前の「端末に1つだけ」の保存場所は使わないので消す */
try { localStorage.removeItem(LEGACY_PROFILE_IMAGE_KEY); } catch (error) { /* 使えなくても動作に影響なし */ }

function getMyProfileImage() {
  return myProfileImageData || "";
}

function loadImageElement(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("IMAGE_LOAD_FAILED"));
    image.src = src;
  });
}

async function compressImageSource(src) {
  const image = await loadImageElement(src);
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  if (!width || !height) throw new Error("IMAGE_LOAD_FAILED");

  const scale = Math.min(1, PROFILE_IMAGE_MAX_SIZE / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));

  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff"; /* 透過PNGの背景が黒くならないように */
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  for (const quality of [0.85, 0.75, 0.6, 0.45]) {
    const dataURL = canvas.toDataURL("image/jpeg", quality);
    if (dataURL.length <= PROFILE_IMAGE_MAX_LENGTH) return dataURL;
  }
  throw new Error("IMAGE_TOO_LARGE");
}

async function compressProfileImageFile(file) {
  const url = URL.createObjectURL(file);
  try {
    return await compressImageSource(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/* 以前に保存された大きい画像は、ログイン時に小さくしてから使う */
async function normalizeProfileImage(dataURL) {
  if (!dataURL) return "";
  if (dataURL.length <= PROFILE_IMAGE_MAX_LENGTH) return dataURL;
  try {
    return await compressImageSource(dataURL);
  } catch (error) {
    console.warn("プロフィール画像を縮小できませんでした:", error);
    return "";
  }
}

profileImageInput?.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;

  if (!file.type.startsWith("image/")) {
    alert("画像ファイルを選択してください。");
    profileImageInput.value = "";
    return;
  }

  if (file.size > PROFILE_IMAGE_MAX_FILE_BYTES) {
    alert("画像は20MB以下にしてください。");
    profileImageInput.value = "";
    return;
  }

  const previousImage = myProfileImageData;

  try {
    const compressed = await compressProfileImageFile(file);
    myProfileImageData = compressed;
    loadProfileImage();
    await saveUserProfile();
    await updateProfileImageEverywhere(compressed);
  } catch (error) {
    console.error("プロフィール画像更新エラー:", error);
    myProfileImageData = previousImage;
    loadProfileImage();

    if (error.message === "IMAGE_LOAD_FAILED") alert("この画像は読み込めませんでした。別の画像（JPEG / PNG など）をお試しください。");
    else if (error.message === "IMAGE_TOO_LARGE") alert("画像を小さくできませんでした。別の画像をお試しください。");
    else alert(describeFirebaseError(error, "プロフィール画像の更新に失敗しました。"));
  } finally {
    profileImageInput.value = "";
  }
});

function loadProfileImage() {
  const savedImage = getMyProfileImage();

  if (savedImage && myProfileImage) {
    myProfileImage.src = savedImage;
    myProfileImage.classList.remove("hidden");
    profileImagePlaceholder?.classList.add("hidden");
  } else {
    if (myProfileImage) myProfileImage.removeAttribute("src");
    myProfileImage?.classList.add("hidden");
    profileImagePlaceholder?.classList.remove("hidden");
  }
}

async function updateProfileImageEverywhere(image) {
  if (!username) return;

  try {
    /* 自分が入っている友達関係だけを読む（以前は friends を全件読んでいた） */
    const [asUser1, asUser2] = await Promise.all([
      getDocs(query(collection(db, "friends"), where("user1", "==", username))),
      getDocs(query(collection(db, "friends"), where("user2", "==", username)))
    ]);
    const updates = new Map();
    const add = (ref, data) => updates.set(ref.path, { ref, data: { ...(updates.get(ref.path)?.data || {}), ...data } });
    [...asUser1.docs, ...asUser2.docs].forEach((item) => {
      const data = item.data();
      if (data.user1 === username) add(item.ref, { user1Photo: image });
      if (data.user2 === username) add(item.ref, { user2Photo: image });
    });

    /* 1回の書き込みは500件まで */
    const list = [...updates.values()];
    for (let i = 0; i < list.length; i += 400) {
      const batch = writeBatch(db);
      list.slice(i, i + 400).forEach(({ ref, data }) => batch.update(ref, data));
      await batch.commit();
    }
  } catch (error) {
    console.error("プロフィール画像同期エラー:", error);
  }
}

/* =========================================================
   名前変更
========================================================= */

changeNameButton?.addEventListener("click", async () => {
  if (!currentUser || !username) return;

  const newName = prompt("新しい名前を入力してください。", username);
  if (newName === null) return;

  const trimmed = newName.trim();
  if (trimmed === username) return;
  const invalidReason = validateUsername(trimmed);
  if (invalidReason) return alert(invalidReason);

  try {
    const newUserRef = doc(db, "users", trimmed);
    const existing = await getDoc(newUserRef);

    if (existing.exists() && existing.data().uid !== currentUser.uid) {
      alert("その名前はすでに使われています。");
      return;
    }

    const oldName = username;

    await setDoc(newUserRef, {
      uid: currentUser.uid,
      name: trimmed,
      photoURL: currentUser.photoURL || "",
      profileImage: getMyProfileImage(),
      updatedAt: serverTimestamp(),
      createdAt: existing.exists() ? existing.data().createdAt : serverTimestamp(),
      ...(isNotifySetupDoneLocally() ? { notificationSetupDone: true } : {})
    });

    /* コイン・ゆう銀行・ゆう株・累計賭け金・ボーナス・お知らせ既読の引き継ぎと、古い名前のデータの削除は Worker が行う
       （ブラウザは経済項目を書けない。引き継がないと、次に開いたときに初期コインやボーナスがもう一度付いてしまう）。
       古い名前と新しい名前のどちらも自分（uid）であることをサーバーが確かめる */
    try {
      await callEconomyApi("renameCarry", { from: oldName, to: trimmed });
    } catch (error) {
      console.error("ゆうcoinの引き継ぎエラー:", error?.economyCode || error);
    }

    username = trimmed;
    localStorage.setItem("yuuchat_username", username);

    await migrateUsername(oldName, username);

    if (myName) myName.textContent = username;
    updateFcmTokenUsername();
    alert("名前を変更しました。");

    listenFriends();
    listenGroups();
    if (selectedChat) listenSelectedChatMessages();
  } catch (error) {
    console.error("名前変更エラー:", error);
    alert("名前の変更に失敗しました。");
  }
});

/* =========================================================
   名前変更時のデータ移行
========================================================= */

async function migrateUsername(oldName, newName) {
  if (!oldName || !newName || oldName === newName) return;

  try {
    /* 古い名前が入っている友達・グループ・メッセージだけを読んで書き換える
       （以前は friends・groups・messages を全件読んでいた。管理者の名前変更と同じ migrateRenamedUserData を使う） */
    await migrateRenamedUserData(oldName, newName);

    /* メンバーには入っていないが作成者（owner）が古い名前のグループも、以前と同じように書き換える */
    const ownedSnap = await getDocs(query(collection(db, "groups"), where("owner", "==", oldName)));
    const owned = ownedSnap.docs.filter((d) => !(Array.isArray(d.data().members) ? d.data().members : []).includes(oldName));
    for (let i = 0; i < owned.length; i += 400) {
      const batch = writeBatch(db);
      owned.slice(i, i + 400).forEach((d) => batch.update(d.ref, { owner: newName, updatedAt: serverTimestamp() }));
      await batch.commit();
    }
  } catch (error) {
    console.error("名前変更データ移行エラー:", error);
    throw error;
  }
}

/* =========================================================
   友達一覧
========================================================= */

/* 自分が含まれる友達関係だけを購読する（自分が user1 のもの・user2 のものの2つ）。
   以前は friends コレクション全体を購読していたため、他の人どうしの更新まで全員に届いていた */
let friendDocsAsUser1 = null;
let friendDocsAsUser2 = null;

function stopFriendListeners() {
  if (unsubscribeFriends) { unsubscribeFriends(); unsubscribeFriends = null; }
  if (unsubscribeFriendsAsUser2) { unsubscribeFriendsAsUser2(); unsubscribeFriendsAsUser2 = null; }
  friendDocsAsUser1 = null;
  friendDocsAsUser2 = null;
}

function toFriendEntry(item, meIsUser1) {
  const data = item.data();
  const me = meIsUser1 ? "user1" : "user2";
  const other = meIsUser1 ? "user2" : "user1";
  const entry = {
    id: item.id,
    friend: data[other],
    friendshipId: item.id,
    photo: data[`${other}Photo`] || "",
    lastMessageAt: data.lastMessageAt || null,
    lastMessageSenderUid: data.lastMessageSenderUid || "",
    lastMessageId: data.lastMessageId || "",
    lastMessageSender: data.lastMessageSender || "",
    lastMessagePreview: data.lastMessagePreview || "",
    lastMessageHasImage: data.lastMessageHasImage === true,
    myLastReadAt: data[`${me}LastReadAt`] || null,
    friendLastReadAt: data[`${other}LastReadAt`] || null,
    myReadField: `${me}LastReadAt`
  };
  entry.unread = isChatUnread(entry.lastMessageAt, entry.lastMessageSenderUid, entry.myLastReadAt);
  return entry;
}

function listenFriends() {
  if (!username) return;
  stopFriendListeners();

  const rebuild = () => {
    if (!friendDocsAsUser1 || !friendDocsAsUser2) return; /* 両方そろってから表示する */
    const byId = new Map();
    friendDocsAsUser1.forEach((item) => byId.set(item.id, toFriendEntry(item, true)));
    friendDocsAsUser2.forEach((item) => { if (!byId.has(item.id)) byId.set(item.id, toFriendEntry(item, false)); });
    friendsData = [...byId.values()].sort((a, b) => (a.friendshipId < b.friendshipId ? -1 : 1));
    /* 開いていた友達との友達関係が解除されたら（自分・相手のどちらが解除しても）チャットを閉じる */
    if (selectedChatType === "friend" && selectedFriendshipId && !friendsData.some((f) => f.friendshipId === selectedFriendshipId)) resetChat();
    notifyNewChatMessages("friend", friendsData);
    renderFriends();
    refreshSelectedChatReadMarks();
    applyPendingNotificationTarget("friends");
  };
  const onError = (error) => console.error("友達監視エラー:", error);

  unsubscribeFriends = onSnapshot(
    query(collection(db, "friends"), where("user1", "==", username)),
    (snapshot) => { friendDocsAsUser1 = snapshot.docs; rebuild(); },
    onError
  );
  unsubscribeFriendsAsUser2 = onSnapshot(
    query(collection(db, "friends"), where("user2", "==", username)),
    (snapshot) => { friendDocsAsUser2 = snapshot.docs; rebuild(); },
    onError
  );
}

function renderFriends() {
  if (!friendsList) return;
  friendsList.innerHTML = "";

  if (friendsData.length === 0) {
    friendsList.innerHTML = `<div class="empty-state">友達がいません</div>`;
    return;
  }

  friendsData.forEach((friend) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "friend-item";
    if (selectedChatType === "friend" && selectedChat === friend.friend) {
      item.classList.add("active");
    }

    const avatar = document.createElement("div");
    avatar.className = "friend-avatar";
    if (friend.photo) {
      avatar.style.backgroundImage = `url("${friend.photo}")`;
    } else {
      avatar.textContent = friend.friend?.charAt(0)?.toUpperCase() || "?";
    }

    const info = document.createElement("div");
    info.className = "friend-info";

    const name = document.createElement("div");
    name.className = "friend-name";
    name.textContent = friend.friend;

    info.append(buildNameWithUnreadMark(name, friend.unread && !isViewingChat("friend", friend.friendshipId)));
    item.append(avatar, info);

    /* タップ：その友達との1対1チャットを開く（ほかのタブを表示中でもチャット画面に切り替える）
       長押し（スマホ・iPad）・右クリック（パソコン）：友達の削除 */
    item.addEventListener("click", (event) => {
      if (item.dataset.longPressed === "1") { delete item.dataset.longPressed; event.preventDefault(); return; }
      openFriendChat(friend);
    });
    item.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      openDeleteFriendDialog(friend);
    });
    attachLongPress(item, () => openDeleteFriendDialog(friend));

    friendsList.appendChild(item);
  });

  /* 選択中の友達チャットのヘッダーも最新の内容（プロフィール画像など）に更新 */
  if (selectedChatType === "friend" && selectedChat) {
    const current = friendsData.find((f) => f.friend === selectedChat);
    if (current) renderChatHeaderForFriend(current);
  }
}

addFriendButton?.addEventListener("click", async () => {
  const friendName = prompt("追加したい友達の名前を入力してください。");
  if (friendName === null) return;

  const trimmed = friendName.trim();
  if (!trimmed) return alert("名前を入力してください。");
  if (trimmed === username) return alert("自分自身は追加できません。");

  try {
    const userDoc = await getDoc(doc(db, "users", trimmed));
    if (!userDoc.exists()) return alert("そのユーザーは見つかりません。");

    const userData = userDoc.data();
    const friendshipId = createFriendshipId(username, trimmed);
    const friendshipRef = doc(db, "friends", friendshipId);
    const existing = await getDoc(friendshipRef);
    if (existing.exists()) return alert("すでに友達です。");

    const myImage = getMyProfileImage();
    const isUser1 = username < trimmed;

    await setDoc(friendshipRef, {
      user1: isUser1 ? username : trimmed,
      user2: isUser1 ? trimmed : username,
      user1Uid: isUser1 ? currentUser.uid : userData.uid,
      user2Uid: isUser1 ? userData.uid : currentUser.uid,
      user1Photo: isUser1 ? myImage : (userData.profileImage || ""),
      user2Photo: isUser1 ? (userData.profileImage || "") : myImage,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });

    alert(`${trimmed}を友達に追加しました。`);
  } catch (error) {
    console.error("友達追加エラー:", error);
    alert("友達追加に失敗しました。");
  }
});

/* 友達関係の解除：friends/{friendshipId} だけを消す（自分と相手の両方の友達一覧から消える）
   1対1のメッセージ（messages）・グループ・通知の登録には触れない（もう一度友達になれば、過去のメッセージも表示される） */
async function deleteFriend(friend) {
  if (!friend?.friendshipId) return false;
  try {
    await deleteDoc(doc(db, "friends", friend.friendshipId));
    if (selectedChatType === "friend" && selectedFriendshipId === friend.friendshipId) resetChat();
    showAppToast("👥 友達", `${friend.friend}との友達関係を解除しました`);
    return true;
  } catch (error) {
    console.error("友達削除エラー:", error);
    alert("友達の削除に失敗しました。");
    return false;
  }
}

/* 友達をタップしたとき：その友達との1対1チャットを開く（チャットタブから開いたときと同じ画面・同じデータ） */
function openFriendChat(friend) {
  if (!friend) return;
  if (!chatView?.classList.contains("active")) switchView("chat");
  selectFriendChat(friend);
}

/* 長押し（タッチ・ペン）。マウスは右クリック（contextmenu）で扱う */
function attachLongPress(element, onLongPress, delay = 550) {
  let timer = null;
  let startX = 0, startY = 0;
  const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
  element.addEventListener("pointerdown", (event) => {
    delete element.dataset.longPressed;
    if (event.pointerType === "mouse") return;
    cancel();
    startX = event.clientX; startY = event.clientY;
    timer = setTimeout(() => { timer = null; element.dataset.longPressed = "1"; onLongPress(); }, delay);
  });
  element.addEventListener("pointermove", (event) => {
    if (timer && Math.hypot(event.clientX - startX, event.clientY - startY) > 10) cancel();
  });
  ["pointerup", "pointercancel", "pointerleave"].forEach((type) => element.addEventListener(type, cancel));
}

/* 友達のメニュー（チャット画面の「⋯」） */
function openFriendMenu(friend) {
  if (!friend) return;
  const modal = openChatModal(`
    <h3>${escapeHTML(friend.friend)}</h3>
    <div class="friend-menu-actions">
      <button class="modal-danger" type="button" data-friend-delete>友達を削除</button>
    </div>
    <div class="modal-buttons">
      <button class="modal-secondary" type="button" data-modal-close>閉じる</button>
    </div>`);
  modal?.querySelector("[data-friend-delete]")?.addEventListener("click", () => openDeleteFriendDialog(friend));
}

/* 削除の確認（誤操作を防ぐため、必ずこの画面で「友達を削除」を押したときだけ消す） */
function openDeleteFriendDialog(friend) {
  if (!friend?.friendshipId || !modalEl) return;
  /* 長押しと右クリックが両方起きたときなど、同じ確認を二重に開かない */
  if (!modalEl.classList.contains("hidden") && modalEl.querySelector("[data-friend-delete-confirm]")?.dataset.friendDeleteConfirm === friend.friendshipId) return;
  const modal = openChatModal(`
    <h3>友達を削除</h3>
    <p class="group-modal-note">${escapeHTML(friend.friend)}との友達関係を解除しますか？<br>これまでの1対1のメッセージは消えません。</p>
    <div class="modal-buttons">
      <button class="modal-secondary" type="button" data-modal-close>キャンセル</button>
      <button class="modal-danger" type="button" data-friend-delete-confirm="${escapeHTML(friend.friendshipId)}">友達を削除</button>
    </div>`);
  if (!modal) return;
  const confirmButton = modal.querySelector("[data-friend-delete-confirm]");
  confirmButton?.addEventListener("click", async () => {
    confirmButton.disabled = true;
    const done = await deleteFriend(friend);
    if (done) closeChatModal(); else confirmButton.disabled = false;
  });
}

/* =========================================================
   グループ
========================================================= */

function listenGroups() {
  if (!username) return;
  if (unsubscribeGroups) { unsubscribeGroups(); unsubscribeGroups = null; }

  unsubscribeGroups = onSnapshot(
    query(collection(db, "groups"), where("members", "array-contains", username)),
    (snapshot) => {
      groupsData = snapshot.docs.map((item) => {
        const group = { id: item.id, ...item.data() };
        group.myLastReadAt = group.lastReadAt?.[currentUser?.uid] || null;
        group.unread = isChatUnread(group.lastMessageAt, group.lastMessageSenderUid, group.myLastReadAt);
        return group;
      });

      /* 開いているグループから外された・グループが削除されたときは、チャットを閉じる */
      if (selectedChatType === "group" && selectedChat && !snapshot.metadata.fromCache &&
          !groupsData.some((g) => g.id === selectedChat)) {
        resetChat();
        showAppToast("👥 グループ", "このグループから退出しました（または削除されました）");
      }

      notifyNewChatMessages("group", groupsData);
      renderGroups();
      refreshSelectedChatReadMarks();
      refreshOpenGroupManageModal();
      applyPendingNotificationTarget("groups");
    },
    (error) => console.error("グループ監視エラー:", error)
  );
}

function renderGroups() {
  if (!groupsList) return;
  groupsList.innerHTML = "";

  if (groupsData.length === 0) {
    groupsList.innerHTML = `<div class="empty-state">グループがありません</div>`;
    return;
  }

  groupsData.forEach((group) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "group-item";
    if (selectedChatType === "group" && selectedChat === group.id) item.classList.add("active");

    const avatar = document.createElement("div");
    avatar.className = "group-avatar";
    avatar.textContent = "👥";

    const info = document.createElement("div");
    info.className = "group-info";

    const name = document.createElement("div");
    name.className = "group-name";
    name.textContent = group.name || "グループ";

    const members = document.createElement("div");
    members.className = "group-members";
    const memberCount = Array.isArray(group.members) ? group.members.length : 0;
    members.textContent = `${memberCount}人`;

    info.append(buildNameWithUnreadMark(name, group.unread && !isViewingChat("group", group.id)), members);
    item.append(avatar, info);
    item.addEventListener("click", () => selectGroupChat(group));
    groupsList.appendChild(item);
  });

  if (selectedChatType === "group" && selectedChat) {
    const current = groupsData.find((g) => g.id === selectedChat);
    if (current) renderChatHeaderForGroup(current);
  }
}

createGroupButton?.addEventListener("click", () => openGroupCreateModal());

/* ----- グループの作成・管理 -----
   ・作成者がそのグループの管理者（ownerUid。以前のグループは owner の名前で判定）
   ・管理者：メンバーの追加・削除、グループの削除
   ・メンバー：自分の退出（管理者が退出したときは、残ったメンバーの先頭が管理者になる）
   ・メンバーの変更は groups の購読（自分が members に入っているもの）で全員に反映される */

const GROUP_NAME_MAX = 30;
let openGroupManageId = null;
let groupActionBusy = false;

function isGroupAdmin(group) {
  if (!group || !currentUser) return false;
  return group.ownerUid ? group.ownerUid === currentUser.uid : group.owner === username;
}

function closeChatModal() {
  openGroupManageId = null;
  if (!modalEl) return;
  modalEl.classList.add("hidden");
  modalEl.innerHTML = "";
}

function openChatModal(html) {
  if (!modalEl) return null;
  modalEl.innerHTML = `<div class="modal-card group-modal">${html}</div>`;
  modalEl.classList.remove("hidden");
  modalEl.querySelectorAll("[data-modal-close]").forEach((button) => button.addEventListener("click", closeChatModal));
  return modalEl;
}

function buildFriendCheckboxes(names, emptyText) {
  if (names.length === 0) return `<p class="group-modal-note">${escapeHTML(emptyText)}</p>`;
  return `<div class="group-member-picker">${names.map((name) => `
    <label class="group-member-option">
      <input type="checkbox" value="${escapeHTML(name)}">
      <span>${escapeHTML(name)}</span>
    </label>`).join("")}</div>`;
}

function checkedNames(container) {
  return [...container.querySelectorAll(".group-member-picker input:checked")].map((input) => input.value);
}

function openGroupCreateModal() {
  if (!currentUser || !username) return;
  const friendNames = friendsData.map((f) => f.friend).filter(Boolean);
  const modal = openChatModal(`
    <h3>👥 グループを作成</h3>
    <input id="groupNameInput" type="text" maxlength="${GROUP_NAME_MAX}" placeholder="グループ名（${GROUP_NAME_MAX}文字以内）">
    <div class="group-modal-subtitle">メンバーにする友達を選んでください</div>
    ${buildFriendCheckboxes(friendNames, "友達を追加すると、メンバーに選べます（自分だけのグループも作れます）")}
    <p id="groupModalError" class="group-modal-error"></p>
    <div class="modal-buttons">
      <button type="button" class="modal-secondary" data-modal-close>キャンセル</button>
      <button type="button" class="modal-primary" id="groupCreateConfirm">作成する</button>
    </div>`);
  if (!modal) return;
  const nameInput = modal.querySelector("#groupNameInput");
  nameInput?.focus();
  nameInput?.addEventListener("input", () => { const errorEl = modal.querySelector("#groupModalError"); if (errorEl) errorEl.textContent = ""; });
  modal.querySelector("#groupCreateConfirm")?.addEventListener("click", async (event) => {
    const errorEl = modal.querySelector("#groupModalError");
    const name = modal.querySelector("#groupNameInput")?.value.trim() || "";
    if (!name) { errorEl.textContent = "グループ名を入力してください。"; return; }
    if (name.length > GROUP_NAME_MAX) { errorEl.textContent = `グループ名は${GROUP_NAME_MAX}文字以内にしてください。`; return; }
    if (groupActionBusy) return;
    groupActionBusy = true;
    event.currentTarget.disabled = true;
    try {
      const members = [username, ...checkedNames(modal).filter((n) => n !== username)];
      const groupRef = await addDoc(collection(db, "groups"), {
        name,
        owner: username,
        ownerUid: currentUser.uid,
        members,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
      closeChatModal();
      showAppToast("👥 グループ", `「${name}」を作成しました`);
      selectGroupChat({ id: groupRef.id, name, owner: username, ownerUid: currentUser.uid, members });
    } catch (error) {
      console.error("グループ作成エラー:", error);
      errorEl.textContent = "グループを作成できませんでした。通信状態を確認して、もう一度お試しください。";
      event.currentTarget.disabled = false;
    } finally {
      groupActionBusy = false;
    }
  });
}

function openGroupManageModal(groupId) {
  const group = groupsData.find((g) => g.id === groupId);
  if (!group) return;
  openGroupManageId = groupId;
  renderGroupManageModal(group);
}

/* グループの情報が変わったら（他の人の操作も）、開いている設定画面を描き直す */
function refreshOpenGroupManageModal() {
  if (!openGroupManageId) return;
  const group = groupsData.find((g) => g.id === openGroupManageId);
  if (!group) { closeChatModal(); return; }
  renderGroupManageModal(group);
}

function renderGroupManageModal(group) {
  const admin = isGroupAdmin(group);
  const members = Array.isArray(group.members) ? group.members : [];
  const ownerName = group.owner || "";
  const addable = friendsData.map((f) => f.friend).filter((name) => name && !members.includes(name));

  const memberRows = members.map((name) => `
    <li class="group-manage-member">
      <span>${name === ownerName ? "👑 " : ""}${escapeHTML(name)}${name === username ? "（あなた）" : ""}</span>
      ${admin && name !== username ? `<button type="button" class="group-remove-member" data-remove-member="${escapeHTML(name)}">外す</button>` : ""}
    </li>`).join("");

  const modal = openChatModal(`
    <h3>👥 ${escapeHTML(group.name || "グループ")}</h3>
    <div class="group-modal-subtitle">メンバー（${members.length}人）${admin ? "・あなたは管理者です" : ""}</div>
    <ul class="group-manage-members">${memberRows}</ul>
    ${admin ? `
      <div class="group-modal-subtitle">メンバーを追加</div>
      ${buildFriendCheckboxes(addable, "追加できる友達がいません")}
      ${addable.length ? `<button type="button" class="modal-primary group-add-button" id="groupAddMembers">選んだ友達を追加</button>` : ""}
    ` : ""}
    <p id="groupModalError" class="group-modal-error"></p>
    <div class="group-manage-actions">
      <button type="button" class="group-leave-button" id="groupLeave">グループから退出</button>
      ${admin ? `<button type="button" class="group-delete-button" id="groupDelete">グループを削除</button>` : ""}
    </div>
    <div class="modal-buttons">
      <button type="button" class="modal-secondary" data-modal-close>閉じる</button>
    </div>`);
  if (!modal) return;
  openGroupManageId = group.id;
  const errorEl = modal.querySelector("#groupModalError");
  const fail = (message, error) => { if (error) console.error(message, error); if (errorEl) errorEl.textContent = message; };

  modal.querySelectorAll("[data-remove-member]").forEach((button) => button.addEventListener("click", () => {
    removeGroupMember(group.id, button.dataset.removeMember).catch((e) => fail("メンバーを外せませんでした。もう一度お試しください。", e));
  }));
  modal.querySelector("#groupAddMembers")?.addEventListener("click", () => {
    const names = checkedNames(modal);
    if (names.length === 0) { fail("追加する友達を選んでください。"); return; }
    addGroupMembers(group.id, names).catch((e) => fail("メンバーを追加できませんでした。もう一度お試しください。", e));
  });
  modal.querySelector("#groupLeave")?.addEventListener("click", () => {
    leaveGroup(group.id).catch((e) => fail("退出できませんでした。もう一度お試しください。", e));
  });
  modal.querySelector("#groupDelete")?.addEventListener("click", () => {
    deleteGroup(group.id).catch((e) => fail("グループを削除できませんでした。もう一度お試しください。", e));
  });
}

async function withGroupAction(action) {
  if (groupActionBusy) return;
  groupActionBusy = true;
  try { await action(); } finally { groupActionBusy = false; }
}

async function addGroupMembers(groupId, names) {
  const group = groupsData.find((g) => g.id === groupId);
  if (!isGroupAdmin(group)) throw new Error("NOT_ADMIN");
  const friendNames = new Set(friendsData.map((f) => f.friend));
  const toAdd = names.filter((name) => friendNames.has(name) && !(group.members || []).includes(name));
  if (toAdd.length === 0) return;
  await withGroupAction(async () => {
    const update = { members: arrayUnion(...toAdd), updatedAt: serverTimestamp() };
    if (!group.ownerUid) update.ownerUid = currentUser.uid; /* 以前のグループは、管理者の UID をここで記録する */
    await updateDoc(doc(db, "groups", groupId), update);
    showAppToast("👥 グループ", `${toAdd.join("、")} を追加しました`);
  });
}

async function removeGroupMember(groupId, name) {
  const group = groupsData.find((g) => g.id === groupId);
  if (!isGroupAdmin(group) || !name || name === username) throw new Error("NOT_ADMIN");
  if (!confirm(`${name} をグループから外しますか？`)) return;
  await withGroupAction(async () => {
    await updateDoc(doc(db, "groups", groupId), { members: arrayRemove(name), updatedAt: serverTimestamp() });
    showAppToast("👥 グループ", `${name} をグループから外しました`);
  });
}

async function leaveGroup(groupId) {
  const group = groupsData.find((g) => g.id === groupId);
  if (!group) return;
  const admin = isGroupAdmin(group);
  const others = (group.members || []).filter((name) => name !== username);
  const message = others.length === 0
    ? "あなたが最後のメンバーです。退出するとグループは削除されます。退出しますか？"
    : admin ? `退出すると、${others[0]} さんが管理者になります。退出しますか？` : "このグループから退出しますか？";
  if (!confirm(message)) return;

  let deleteAfter = false;
  await withGroupAction(async () => {
    await runTransaction(db, async (transaction) => {
      const ref = doc(db, "groups", groupId);
      const snap = await transaction.get(ref);
      if (!snap.exists()) return;
      const data = snap.data();
      const remaining = (Array.isArray(data.members) ? data.members : []).filter((name) => name !== username);
      if (remaining.length === 0) { deleteAfter = true; transaction.delete(ref); return; }

      const update = { members: remaining, [`lastReadAt.${currentUser.uid}`]: deleteField(), updatedAt: serverTimestamp() };
      const iAmAdmin = data.ownerUid ? data.ownerUid === currentUser.uid : data.owner === username;
      if (iAmAdmin) {
        const nextOwner = remaining[0];
        const nextOwnerSnap = await transaction.get(doc(db, "users", nextOwner));
        update.owner = nextOwner;
        update.ownerUid = nextOwnerSnap.exists() ? (nextOwnerSnap.data().uid || "") : "";
      }
      transaction.update(ref, update);
    });
  });
  closeChatModal();
  if (selectedChatType === "group" && selectedChat === groupId) resetChat();
  showAppToast("👥 グループ", `「${group.name || "グループ"}」から退出しました`);
  if (deleteAfter) await deleteGroupMessages(groupId);
}

async function deleteGroup(groupId) {
  const group = groupsData.find((g) => g.id === groupId);
  if (!isGroupAdmin(group)) throw new Error("NOT_ADMIN");
  if (!confirm(`「${group.name || "グループ"}」を削除しますか？\nメンバー全員のグループとメッセージが消え、元に戻せません。`)) return;
  await withGroupAction(async () => {
    await deleteDoc(doc(db, "groups", groupId));
  });
  closeChatModal();
  if (selectedChatType === "group" && selectedChat === groupId) resetChat();
  showAppToast("👥 グループ", `「${group.name || "グループ"}」を削除しました`);
  await deleteGroupMessages(groupId);
}

/* 削除したグループのメッセージを消す（グループを削除したときだけ。500件ずつ） */
async function deleteGroupMessages(groupId) {
  try {
    const snap = await getDocs(query(collection(db, "messages"), where("groupId", "==", groupId)));
    for (let i = 0; i < snap.docs.length; i += 450) {
      const batch = writeBatch(db);
      snap.docs.slice(i, i + 450).forEach((item) => batch.delete(item.ref));
      await batch.commit();
    }
  } catch (error) {
    console.error("グループのメッセージ削除エラー:", error);
  }
}

/* =========================================================
   アバター表示（友達一覧・チャットヘッダー・メッセージで共通利用）
========================================================= */

function buildAvatarElement(photo, fallbackText, extraClass) {
  const el = document.createElement("div");
  el.className = extraClass ? `avatar-circle ${extraClass}` : "avatar-circle";
  if (photo) {
    el.style.backgroundImage = `url("${photo}")`;
  } else {
    el.textContent = (fallbackText || "?").trim().charAt(0).toUpperCase() || "?";
  }
  return el;
}

/* =========================================================
   チャットヘッダー（アバター＋名前＋状態）
========================================================= */

function renderChatHeaderForFriend(friend) {
  if (!chatHeader || !friend) return;
  chatHeader.innerHTML = "";

  const wrap = document.createElement("div");
  wrap.className = "chat-header-profile";

  const avatar = buildAvatarElement(friend.photo, friend.friend, "avatar-circle--md");

  const info = document.createElement("div");
  info.className = "chat-header-info";

  const name = document.createElement("div");
  name.className = "chat-header-name";
  name.textContent = friend.friend;

  info.append(name);
  wrap.append(avatar, info);

  const menu = document.createElement("button");
  menu.type = "button";
  menu.className = "group-manage-button friend-menu-button";
  menu.title = "友達のメニュー";
  menu.setAttribute("aria-label", `${friend.friend}のメニュー`);
  menu.textContent = "⋯";
  menu.addEventListener("click", () => openFriendMenu(friend));
  wrap.appendChild(menu);

  chatHeader.appendChild(wrap);
}

function renderChatHeaderForGroup(group) {
  if (!chatHeader || !group) return;
  chatHeader.innerHTML = "";

  const wrap = document.createElement("div");
  wrap.className = "chat-header-profile";

  const avatar = document.createElement("div");
  avatar.className = "avatar-circle avatar-circle--md avatar-circle--group";
  avatar.textContent = "👥";

  const info = document.createElement("div");
  info.className = "chat-header-info";

  const name = document.createElement("div");
  name.className = "chat-header-name";
  name.textContent = group.name || "グループ";

  const count = Array.isArray(group.members) ? group.members.length : 0;
  const status = document.createElement("div");
  status.className = "chat-header-status";
  status.textContent = `メンバー ${count}人`;

  info.append(name, status);
  wrap.append(avatar, info);

  const manage = document.createElement("button");
  manage.type = "button";
  manage.className = "group-manage-button";
  manage.title = "グループの設定";
  manage.textContent = "⚙️ 設定";
  manage.addEventListener("click", () => openGroupManageModal(group.id));
  wrap.appendChild(manage);

  chatHeader.appendChild(wrap);
}

/* =========================================================
   チャット選択
========================================================= */

/* すでに開いていて、メッセージの監視が正常に動いているチャットか（同じチャットをもう一度選んでも監視を作り直さない） */
function isMessagesListenerActiveFor(type, chatId, friendshipId = null) {
  if (!unsubscribeMessages || messagesListenerFailed) return false;
  if (selectedChatType !== type || selectedChat !== chatId) return false;
  return type !== "friend" || selectedFriendshipId === friendshipId;
}

function selectFriendChat(friend) {
  if (!friend) return;
  const alreadyListening = isMessagesListenerActiveFor("friend", friend.friend, friend.friendshipId);
  selectedChatType = "friend";
  selectedChat = friend.friend;
  selectedFriendshipId = friend.friendshipId;
  replyingMessage = null;
  updateReplyBar();
  renderChatHeaderForFriend(friend);
  if (messageInput) messageInput.disabled = false;
  if (sendButton) sendButton.disabled = false;
  renderFriends();
  renderGroups();
  if (alreadyListening) markSelectedChatAsRead();
  else listenSelectedChatMessages();
}

function selectGroupChat(group) {
  if (!group) return;
  const alreadyListening = isMessagesListenerActiveFor("group", group.id);
  selectedChatType = "group";
  selectedChat = group.id;
  selectedFriendshipId = null;
  replyingMessage = null;
  updateReplyBar();
  renderChatHeaderForGroup(group);
  if (messageInput) messageInput.disabled = false;
  if (sendButton) sendButton.disabled = false;
  renderFriends();
  renderGroups();
  if (alreadyListening) markSelectedChatAsRead();
  else listenSelectedChatMessages();
}

function resetChat() {
  chatPaging = null;
  selectedChat = null;
  selectedChatType = null;
  selectedFriendshipId = null;
  replyingMessage = null;

  if (unsubscribeMessages) { unsubscribeMessages(); unsubscribeMessages = null; }
  if (chatHeader) chatHeader.textContent = "相手を選択してください";
  if (messageInput) messageInput.disabled = true;
  if (sendButton) sendButton.disabled = true;
  if (!isSendingMessage) clearPendingImage();
  if (messagesElement) {
    messagesElement.innerHTML = `<div class="empty-state">チャットを選択してください</div>`;
  }

  updateReplyBar();
  renderFriends();
  renderGroups();
}

/* =========================================================
   メッセージ監視・表示
========================================================= */

function isMessageForSelectedChat(message) {
  if (!message || !selectedChat) return false;

  if (selectedChatType === "group") {
    return message.type === "group" && message.groupId === selectedChat;
  }

  if (selectedChatType === "friend") {
    const sender = message.sender;
    const receiver = message.receiver;
    if (selectedFriendshipId && message.friendshipId) {
      return message.friendshipId === selectedFriendshipId;
    }
    return (
      (sender === username && receiver === selectedChat) ||
      (sender === selectedChat && receiver === username)
    );
  }

  return false;
}

/* =========================================================
   選んだチャットのメッセージ
   ・開いたときは最新 MESSAGE_PAGE_SIZE 件だけを onSnapshot で購読する（新着・既読・送信取り消しなどはリアルタイムで反映）
       グループ：groupId が一致するもの
       友達：「自分→相手」または「相手→自分」（or で1つの問い合わせにまとめる）
       どちらも createdAt の新しい順＋limit。保存の形は今まで通り
   ・上へスクロールしたら（または一番上の「過去のメッセージを読み込む」を押したら）、いちばん古い読み込み済みのメッセージより前を
     MESSAGE_PAGE_SIZE 件ずつ1回だけ読む（getDocs）。それより前が無くなったら、もう問い合わせない
   ・読み込んだメッセージは ID ごとに1つだけ持つ（同じメッセージを重ねて表示しない）。新着で購読の範囲から外れたメッセージも表示し続ける
   ・必要な複合インデックス（messages：sender＋receiver＋createdAt 降順／groupId＋createdAt 降順）が無くて問い合わせが失敗したときは、
     以前と同じ「全件を購読する」方式に自動で切り替える（チャットが表示されなくなることはない）
========================================================= */

const MESSAGE_PAGE_SIZE = 15;
let selectedChatMessages = [];
let chatPaging = null;

function buildChatMessagesQuery(type, chatId, extra = []) {
  const base = collection(db, "messages");
  if (type === "group") return query(base, where("groupId", "==", chatId), orderBy("createdAt", "desc"), ...extra);
  return query(base, or(
    and(where("sender", "==", username), where("receiver", "==", chatId)),
    and(where("sender", "==", chatId), where("receiver", "==", username))
  ), orderBy("createdAt", "desc"), ...extra);
}

function toChatMessage(snap) {
  return { id: snap.id, ...snap.data({ serverTimestamps: "estimate" }) };
}

/* 読み込んだメッセージ（購読分＋過去分）を古い順に並べて描く */
function renderPagedChat(paging, scrollMode) {
  if (paging !== chatPaging) return;
  selectedChatMessages = [...paging.messages.values()]
    .filter(isMessageForSelectedChat)
    .sort((a, b) => timestampMillis(a.createdAt, Infinity) - timestampMillis(b.createdAt, Infinity));
  renderSelectedMessages(selectedChatMessages, { scrollMode, olderState: paging.fallback ? null : paging.olderState });
  markSelectedChatAsRead();
}

function listenSelectedChatMessages() {
  if (unsubscribeMessages) { unsubscribeMessages(); unsubscribeMessages = null; }
  messagesListenerFailed = false;
  selectedChatMessages = [];
  chatPaging = null;
  if (!username || !selectedChat) return;

  if (messagesElement) messagesElement.innerHTML = `<div class="loading">読み込み中...</div>`;

  const paging = {
    key: `${selectedChatType}:${selectedChat}`,
    type: selectedChatType,
    chatId: selectedChat,
    messages: new Map(),   /* id → メッセージ（購読分と過去分をまとめて1つ） */
    snaps: new Map(),      /* id → ドキュメント（過去分を読むときの起点に使う） */
    liveIds: new Set(),    /* いま購読している最新分の id */
    olderState: "unknown", /* "more"：まだ前がある／"loading"：読み込み中／"none"：もう無い（サーバーの結果を受け取るまでは "unknown"） */
    serverSynced: false,   /* サーバーから最新 MESSAGE_PAGE_SIZE 件を受け取ったか */
    firstRendered: false,
    fallback: false
  };
  chatPaging = paging;

  /* 開き直したときなどは、まず端末に残っていたデータ（fromCache）だけで結果が届くことがある。
     その件数は最新 MESSAGE_PAGE_SIZE 件とは限らない（足りない・間が抜けている）ので、
     ・端末のデータの段階では表示だけして、「過去のメッセージがあるか」は決めない（ボタンも出さず、過去分も読まない）
     ・サーバーからの最初の結果を受け取ったら、表示をその最新件数で置き換え、そこで「過去のメッセージがあるか」を決める
     サーバーの結果が端末のデータと同じでも届くように includeMetadataChanges を付ける。
     受け取ったあとの「中身が変わらない知らせ」（送信中→送信済み・オンライン／オフラインの切り替えだけ）は描き直さない。
     includeMetadataChanges は知らせの種類が増えるだけで、読み取り回数は増えない */
  const unsubscribe = onSnapshot(
    buildChatMessagesQuery(paging.type, paging.chatId, [limit(MESSAGE_PAGE_SIZE)]),
    { includeMetadataChanges: true },
    (snapshot) => {
      if (chatPaging !== paging) return;
      const fromServer = !snapshot.metadata.fromCache;
      const firstFromServer = fromServer && !paging.serverSynced;
      if (paging.serverSynced && snapshot.docChanges().length === 0) {
        /* 中身の変わらない知らせ：描き直さず、過去分を読む起点の判断に使う送信中の印（hasPendingWrites）だけ新しくする */
        snapshot.docs.forEach((item) => { if (paging.snaps.has(item.id)) paging.snaps.set(item.id, item); });
        return;
      }
      if (firstFromServer) {
        /* 端末のデータで先に描いた分を、サーバーの最新件数で置き換える（範囲の外の古いメッセージを残さない） */
        paging.serverSynced = true;
        paging.messages = new Map();
        paging.snaps = new Map();
        paging.olderState = snapshot.size < MESSAGE_PAGE_SIZE ? "none" : "more";
      }
      paging.liveIds = new Set(snapshot.docs.map((item) => item.id));
      snapshot.docs.forEach((item) => {
        paging.messages.set(item.id, toChatMessage(item));
        paging.snaps.set(item.id, item);
      });
      renderPagedChat(paging, paging.firstRendered ? "auto" : "bottom");
      paging.firstRendered = true;
    },
    (error) => {
      if (chatPaging !== paging) return;
      if (error?.code === "failed-precondition") {
        /* 複合インデックスがまだ無い：以前と同じ全件の購読に切り替える */
        console.warn("チャットの最新件数だけの読み込みに必要なインデックスが無いため、全件の読み込みに切り替えます:", error.message);
        listenSelectedChatMessagesUnlimited(paging);
        return;
      }
      console.error("チャット読み込みエラー:", error);
      messagesListenerFailed = true; /* もう一度選んだときは監視を作り直す */
      if (messagesElement) {
        messagesElement.innerHTML = `<div class="empty-state">メッセージの読み込みに失敗しました</div>`;
      }
    }
  );
  unsubscribeMessages = () => unsubscribe();
}

/* いちばん古い読み込み済みのメッセージより前を MESSAGE_PAGE_SIZE 件読む（1回だけ。それ以上前が無ければ以後は読まない） */
async function loadOlderChatMessages() {
  const paging = chatPaging;
  if (!paging || paging.fallback || paging.olderState !== "more") return;

  let oldest = null;
  paging.snaps.forEach((snap, id) => {
    const message = paging.messages.get(id);
    if (!message?.createdAt || snap.metadata?.hasPendingWrites) return;
    if (!oldest || timestampMillis(message.createdAt) < timestampMillis(paging.messages.get(oldest.id).createdAt)) oldest = snap;
  });
  if (!oldest) { paging.olderState = "none"; renderPagedChat(paging, "keep"); return; }

  paging.olderState = "loading";
  renderPagedChat(paging, "keep");
  try {
    const snap = await getDocs(buildChatMessagesQuery(paging.type, paging.chatId, [startAfter(oldest), limit(MESSAGE_PAGE_SIZE)]));
    if (chatPaging !== paging) return;
    snap.docs.forEach((item) => {
      if (!paging.messages.has(item.id)) paging.messages.set(item.id, toChatMessage(item));
      if (!paging.snaps.has(item.id)) paging.snaps.set(item.id, item);
    });
    paging.olderState = snap.size < MESSAGE_PAGE_SIZE ? "none" : "more";
  } catch (error) {
    console.error("過去のメッセージの読み込みエラー:", error);
    if (chatPaging !== paging) return;
    paging.olderState = "more"; /* もう一度試せるように */
  }
  renderPagedChat(paging, "keep");
}

/* 過去分として読んだメッセージに自分がした変更（送信取り消し・リアクション）は購読で届かないので、そのメッセージだけ読み直す */
async function refreshLoadedChatMessage(messageId) {
  const paging = chatPaging;
  if (!paging || paging.fallback || !paging.messages.has(messageId) || paging.liveIds.has(messageId)) return;
  try {
    const snap = await getDoc(doc(db, "messages", messageId));
    if (chatPaging !== paging || !snap.exists()) return;
    paging.messages.set(messageId, toChatMessage(snap));
    renderPagedChat(paging, "keep");
  } catch (error) {
    console.warn("メッセージの読み直しエラー:", error);
  }
}

/* 以前と同じ方式（そのチャットのメッセージを全件購読する）。インデックスが無いときだけ使う */
function listenSelectedChatMessagesUnlimited(paging) {
  if (unsubscribeMessages) { unsubscribeMessages(); unsubscribeMessages = null; }
  paging.fallback = true;
  paging.olderState = "none";

  const queries = paging.type === "group"
    ? [query(collection(db, "messages"), where("groupId", "==", paging.chatId))]
    : [
      query(collection(db, "messages"), where("sender", "==", username), where("receiver", "==", paging.chatId)),
      query(collection(db, "messages"), where("sender", "==", paging.chatId), where("receiver", "==", username))
    ];
  const parts = queries.map(() => null);

  const update = () => {
    if (parts.some((part) => part === null) || chatPaging !== paging) return;
    paging.messages = new Map(parts.flat().map((m) => [m.id, m]));
    renderPagedChat(paging, paging.firstRendered ? "auto" : "bottom");
    paging.firstRendered = true;
  };

  const unsubscribers = queries.map((q, index) => onSnapshot(
    q,
    (snapshot) => {
      parts[index] = snapshot.docs.map(toChatMessage);
      update();
    },
    (error) => {
      console.error("チャット読み込みエラー:", error);
      messagesListenerFailed = true; /* もう一度選んだときは監視を作り直す */
      if (messagesElement) {
        messagesElement.innerHTML = `<div class="empty-state">メッセージの読み込みに失敗しました</div>`;
      }
    }
  ));
  unsubscribeMessages = () => unsubscribers.forEach((unsubscribe) => unsubscribe());
}

/* 上の端までスクロールしたら、過去のメッセージを読み込む */
messagesElement?.addEventListener("scroll", () => {
  if (messagesElement.scrollTop < 60 && chatPaging?.olderState === "more") loadOlderChatMessages();
}, { passive: true });

/* scrollMode：
     "bottom"：一番下へ（チャットを開いた最初）
     "keep"  ：見ていた位置をそのまま（過去のメッセージを上に足したとき）
     "auto"  ：一番下の近くを見ていたとき・自分が新しく送ったときは一番下へ、上の方を読んでいるときは位置をそのまま
   olderState：一番上に出す「過去のメッセージを読み込む」の状態（null なら出さない） */
function renderSelectedMessages(allMessages, { scrollMode = "bottom", olderState = null } = {}) {
  if (!messagesElement) return;

  const messages = allMessages.filter(isMessageForSelectedChat);

  /* 描き直す前に、見ていた位置（画面の一番上に見えているメッセージと、そのずれ）を覚えておく */
  const previousLastId = messagesElement.dataset.lastMessageId || "";
  const nearBottom = messagesElement.scrollHeight - messagesElement.scrollTop - messagesElement.clientHeight < 150;
  let anchorId = null, anchorOffset = 0;
  const viewTop = messagesElement.getBoundingClientRect().top;
  for (const row of messagesElement.querySelectorAll(".message-row[data-message-id]")) {
    const rect = row.getBoundingClientRect();
    if (rect.bottom > viewTop) { anchorId = row.dataset.messageId; anchorOffset = rect.top - viewTop; break; }
  }

  messagesElement.innerHTML = "";

  if (messages.length === 0) {
    messagesElement.dataset.lastMessageId = "";
    messagesElement.innerHTML = `<div class="empty-state">まだメッセージがありません</div>`;
    return;
  }

  if (olderState === "more" || olderState === "loading") {
    const loader = document.createElement("button");
    loader.type = "button";
    loader.className = "messages-older";
    loader.disabled = olderState === "loading";
    loader.textContent = olderState === "loading" ? "読み込み中…" : "↑ 過去のメッセージを読み込む";
    loader.addEventListener("click", () => loadOlderChatMessages());
    messagesElement.appendChild(loader);
  }

  const readInfo = getSelectedChatReadInfo();
  messages.forEach((message, index) => {
    const row = renderMessage(message, readInfo);
    if (index === messages.length - 1) row.classList.add("new");
    messagesElement.appendChild(row);
  });

  const last = messages[messages.length - 1];
  messagesElement.dataset.lastMessageId = last.id || "";
  const sentByMeNow = last.id !== previousLastId && (last.senderUid ? last.senderUid === currentUser?.uid : last.sender === username);
  const toBottom = scrollMode === "bottom" || (scrollMode === "auto" && (nearBottom || sentByMeNow || !anchorId));

  const restore = () => {
    if (toBottom) { messagesElement.scrollTop = messagesElement.scrollHeight; return; }
    const row = anchorId && messagesElement.querySelector(`.message-row[data-message-id="${CSS.escape(anchorId)}"]`);
    if (row) messagesElement.scrollTop += (row.getBoundingClientRect().top - messagesElement.getBoundingClientRect().top) - anchorOffset;
  };
  restore();
  requestAnimationFrame(restore);

  /* 画像はあとから読み込まれて高さが変わるので、読み込まれたら位置を合わせ直す（その間にユーザーが動かしていなければ） */
  const expectedTop = () => messagesElement.scrollTop;
  let settledTop = null;
  requestAnimationFrame(() => { settledTop = expectedTop(); });
  messagesElement.querySelectorAll("img").forEach((img) => {
    if (img.complete) return;
    img.addEventListener("load", () => {
      if (settledTop !== null && Math.abs(messagesElement.scrollTop - settledTop) > 2) return;
      restore();
      settledTop = expectedTop();
    }, { once: true });
  });
}

function renderMessage(message, readInfo = getSelectedChatReadInfo()) {
  const row = document.createElement("div");
  row.className = "message-row";
  row.dataset.messageId = message.id || "";

  const senderName = message.sender || "";
  const isMine = senderName === username;
  row.classList.add(isMine ? "mine" : "other");

  /* 相手のメッセージにはアバターを表示（自分のメッセージは表示しない） */
  if (!isMine) {
    const avatar = buildAvatarElement(message.senderPhoto, senderName, "avatar-circle--sm");
    row.appendChild(avatar);
  }

  const bubble = document.createElement("div");
  bubble.className = "message-bubble";

  if (message.deleted) {
    const deleted = document.createElement("div");
    deleted.className = "deleted-message";
    deleted.textContent = "このメッセージは送信を取り消しました";
    bubble.appendChild(deleted);
  } else {
    if (selectedChatType === "group" && senderName && senderName !== username) {
      const sender = document.createElement("div");
      sender.className = "message-user";
      sender.textContent = senderName;
      bubble.appendChild(sender);
    }

    if (message.replyTo) {
      const reply = document.createElement("div");
      reply.className = "reply-preview";
      reply.textContent = message.replyTo.text || "返信";
      bubble.appendChild(reply);
    }

    if (message.image) {
      const image = document.createElement("img");
      image.className = "message-image";
      image.src = message.image;
      image.alt = "送信された画像";
      image.loading = "lazy";
      image.addEventListener("click", () => openImageViewer(message.image));
      bubble.appendChild(image);
    }

    if (message.text) {
      const text = document.createElement("div");
      text.className = "message-text";
      text.textContent = message.text;
      bubble.appendChild(text);
    }

    if (message.reactions) renderReactions(bubble, message);
  }

  const meta = document.createElement("div");
  meta.className = "message-time";
  if (isMine && !message.deleted) {
    const read = document.createElement("span");
    read.className = "message-read";
    read.textContent = getReadLabel(message, readInfo);
    meta.appendChild(read);
  }
  meta.appendChild(document.createTextNode(formatMessageTime(message.createdAt)));
  bubble.appendChild(meta);

  if (!message.deleted) {
    const actions = document.createElement("div");
    actions.className = "message-actions";

    const replyButton = document.createElement("button");
    replyButton.type = "button";
    replyButton.textContent = "返信";
    replyButton.addEventListener("click", () => setReplyMessage(message));

    const reactionButton = document.createElement("button");
    reactionButton.type = "button";
    reactionButton.textContent = "😊";
    reactionButton.addEventListener("click", () => addReaction(message));

    actions.append(replyButton, reactionButton);

    if (isMine) {
      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.textContent = "取消";
      deleteButton.addEventListener("click", () => unsendMessage(message.id));
      actions.appendChild(deleteButton);
    }

    bubble.appendChild(actions);
  }

  row.appendChild(bubble);
  return row;
}

/* =========================================================
   画像ビューア（チャットの画像をタップしたとき）
   ・アプリの中に全画面で表示し、「戻る」「保存」ボタンを付ける
   ・保存：スマホでは共有メニュー（「画像を保存」）、それ以外はダウンロード
========================================================= */

function closeImageViewer() {
  document.getElementById("imageViewer")?.remove();
  document.removeEventListener("keydown", onImageViewerKeydown);
}

function onImageViewerKeydown(event) {
  if (event.key === "Escape") closeImageViewer();
}

function openImageViewer(src) {
  if (!src) return;
  closeImageViewer();

  const viewer = document.createElement("div");
  viewer.id = "imageViewer";
  viewer.className = "image-viewer";
  viewer.setAttribute("role", "dialog");
  viewer.setAttribute("aria-label", "画像");

  const bar = document.createElement("div");
  bar.className = "image-viewer-bar";

  const back = document.createElement("button");
  back.type = "button";
  back.className = "image-viewer-button";
  back.textContent = "← 戻る";
  back.addEventListener("click", closeImageViewer);

  const save = document.createElement("button");
  save.type = "button";
  save.className = "image-viewer-button image-viewer-save";
  save.textContent = "⬇ 保存";
  save.addEventListener("click", () => saveImageToDevice(src));

  bar.append(back, save);

  const body = document.createElement("div");
  body.className = "image-viewer-body";
  body.addEventListener("click", (event) => { if (event.target === body) closeImageViewer(); });

  const image = document.createElement("img");
  image.src = src;
  image.alt = "受信した画像";
  body.appendChild(image);

  viewer.append(bar, body);
  document.body.appendChild(viewer);
  document.addEventListener("keydown", onImageViewerKeydown);
}

async function saveImageToDevice(src) {
  try {
    const blob = await (await fetch(src)).blob();
    const ext = (blob.type.split("/")[1] || "jpg").replace("jpeg", "jpg").replace(/[^a-z0-9]/gi, "") || "jpg";
    const fileName = `yuuchat-${Date.now()}.${ext}`;
    const file = new File([blob], fileName, { type: blob.type || "image/jpeg" });

    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    if (isMobile && navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
        return;
      } catch (error) {
        if (error?.name === "AbortError") return; /* 共有メニューを閉じただけ */
      }
    }

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } catch (error) {
    console.error("画像の保存エラー:", error);
    alert("画像を保存できませんでした。画像を長押しして保存してください。");
  }
}

function formatMessageTime(timestamp) {
  if (!timestamp) return "";
  try {
    let date;
    if (typeof timestamp.toDate === "function") date = timestamp.toDate();
    else if (timestamp instanceof Date) date = timestamp;
    else date = new Date(timestamp);

    if (Number.isNaN(date.getTime())) return "";
    return new Intl.DateTimeFormat("ja-JP", { hour: "2-digit", minute: "2-digit" }).format(date);
  } catch {
    return "";
  }
}

/* =========================================================
   返信
========================================================= */

function setReplyMessage(message) {
  if (!message) return;
  replyingMessage = { id: message.id, text: message.text || (message.image ? "画像" : "") };
  updateReplyBar();
  messageInput?.focus();
}

function updateReplyBar() {
  if (!replyBar) return;
  if (!replyingMessage) {
    replyBar.classList.add("hidden");
    if (replyText) replyText.textContent = "";
    return;
  }
  replyBar.classList.remove("hidden");
  if (replyText) replyText.textContent = `「${replyingMessage.text || "メッセージ"}」に返信`;
}

cancelReplyButton?.addEventListener("click", () => {
  replyingMessage = null;
  updateReplyBar();
});

/* =========================================================
   リアクション
========================================================= */

function renderReactions(bubble, message) {
  const entries = Object.entries(message.reactions || {});
  if (entries.length === 0) return;

  const container = document.createElement("div");
  container.className = "message-reactions";

  entries.forEach(([emoji, users]) => {
    if (!Array.isArray(users) || users.length === 0) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "reaction";
    button.textContent = `${emoji} ${users.length}`;
    button.addEventListener("click", () => toggleReaction(message, emoji));
    container.appendChild(button);
  });

  if (container.children.length > 0) bubble.appendChild(container);
}

async function addReaction(message) {
  if (!message?.id) return;
  const emoji = prompt("リアクションを入力してください\n\n😊 😂 👍 ❤️ 😮 😢 🎉");
  if (!emoji) return;
  const selectedEmoji = emoji.trim();
  if (!selectedEmoji) return;
  await toggleReaction(message, selectedEmoji);
}

async function toggleReaction(message, emoji) {
  if (!currentUser || !message?.id || !emoji) return;

  try {
    const messageRef = doc(db, "messages", message.id);
    const snapshot = await getDoc(messageRef);
    if (!snapshot.exists()) return;

    const data = snapshot.data();
    const reactions = { ...(data.reactions || {}) };
    const users = Array.isArray(reactions[emoji]) ? [...reactions[emoji]] : [];
    const index = users.indexOf(username);

    if (index >= 0) users.splice(index, 1);
    else users.push(username);

    if (users.length === 0) delete reactions[emoji];
    else reactions[emoji] = users;

    await updateDoc(messageRef, { reactions });
    refreshLoadedChatMessage(message.id);
  } catch (error) {
    console.error("リアクションエラー:", error);
  }
}

/* =========================================================
   送信取り消し
========================================================= */

async function unsendMessage(messageId) {
  if (!currentUser || !messageId) return;
  if (!confirm("このメッセージの送信を取り消しますか？")) return;

  try {
    const messageRef = doc(db, "messages", messageId);
    const snapshot = await getDoc(messageRef);
    if (!snapshot.exists()) return;

    if (snapshot.data().sender !== username) {
      alert("自分が送信したメッセージだけ取り消せます。");
      return;
    }

    /* 画像はこのメッセージのドキュメントの中だけにある（ほかのメッセージ・グループと共有していない）ので、
       取り消したら画像のデータも消す（取り消したメッセージの画像は表示しないので、残しても保存容量と通信量を使うだけ） */
    await updateDoc(messageRef, { deleted: true, deletedAt: serverTimestamp(), image: deleteField() });
    refreshLoadedChatMessage(messageId);
  } catch (error) {
    console.error("送信取り消しエラー:", error);
    alert("送信取り消しに失敗しました。");
  }
}

/* =========================================================
   メッセージ送信
========================================================= */

sendButton?.addEventListener("click", sendMessage);

messageInput?.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
});

/* 送信中は「送信中…」を出し、送信ボタン・画像の選択と解除を止める（二重送信を防ぐ） */
function setSendingState(sending) {
  isSendingMessage = sending;
  if (sendButton) {
    sendButton.textContent = sending ? "送信中…" : "送信";
    sendButton.disabled = sending || !selectedChat;
    sendButton.classList.toggle("sending", sending);
    sendButton.setAttribute("aria-busy", sending ? "true" : "false");
  }
  renderImagePreview();
}

/* 送信の失敗を、ユーザーに分かる言葉にする */
function describeSendError(error, hasImage) {
  const code = String(error?.code || "");
  const message = String(error?.message || "");
  if (code === "unavailable" || code === "deadline-exceeded" || (typeof navigator !== "undefined" && navigator.onLine === false)) {
    return "通信できませんでした。電波の良い場所で、もう一度送信してください。";
  }
  if (hasImage && (code === "invalid-argument" || /maximum|size|too large|exceeds/i.test(message))) {
    return "画像が大きすぎて送信できませんでした。別の画像を選んでください。";
  }
  if (code === "permission-denied" || code === "unauthenticated") {
    return "送信する権限がありませんでした。ログインし直してから、もう一度送信してください。";
  }
  return hasImage ? "画像を送信できませんでした。もう一度送信してください。" : "メッセージを送信できませんでした。";
}

async function sendMessage() {
  if (isSendingMessage) return;
  if (!currentUser || !username) return;
  if (!selectedChat || !selectedChatType) {
    alert("友達またはグループを選択してください。");
    return;
  }

  /* 画像を準備中（小さくしている途中）は送らない。終わったら送れる */
  if (pendingImage?.status === "preparing") {
    renderImagePreview("画像を準備しています。少し待ってから送信してください。");
    return;
  }

  const text = messageInput?.value?.trim() || "";
  const sendingImage = pendingImage?.status === "ready" ? pendingImage : null;
  const image = sendingImage?.dataURL || null;
  if (!text && !image) {
    if (pendingImage?.status === "error") renderImagePreview();
    return;
  }

  if (image && typeof navigator !== "undefined" && navigator.onLine === false) {
    sendingImage.error = "通信できませんでした。電波の良い場所で、もう一度送信してください。";
    renderImagePreview();
    return;
  }

  /* 入力欄は送信した時点ですぐ空にする（以前は保存が終わってから空にしていたため、
     続けて打ち始めた次のメッセージが消えてしまうことがあった）。失敗したら元に戻す
     画像は送信が成功するまで選択したまま（失敗したらそのまま送り直せる） */
  const replyingAtSend = replyingMessage;
  if (messageInput) { messageInput.value = ""; messageInput.placeholder = "メッセージを入力"; }
  if (sendingImage) sendingImage.error = "";
  replyingMessage = null;
  updateReplyBar();
  setSendingState(true);

  try {
    const messageData = {
      sender: username,
      senderUid: currentUser.uid,
      senderPhoto: getMyProfileImage(),
      text,
      image,
      type: selectedChatType,
      createdAt: serverTimestamp(),
      deleted: false,
      readBy: [username]
    };

    if (selectedChatType === "friend") {
      messageData.receiver = selectedChat;
      messageData.friendshipId = selectedFriendshipId || createFriendshipId(username, selectedChat);
    }

    if (selectedChatType === "group") {
      messageData.groupId = selectedChat;
    }

    if (replyingAtSend) {
      messageData.replyTo = { id: replyingAtSend.id, text: replyingAtSend.text || "" };
    }

    /* メッセージの追加と、チャット（友達・グループ）の「最後のメッセージ」「自分がどこまで読んだか」の更新を
       1回の書き込みで行う（同じ時刻になるので、未読の判定がずれない） */
    const batch = writeBatch(db);
    const messageRef = doc(collection(db, "messages"));
    batch.set(messageRef, messageData);
    const chatRef = getSelectedChatRef();
    if (chatRef) {
      const chatUpdate = {
        lastMessageAt: serverTimestamp(),
        lastMessageSenderUid: currentUser.uid,
        lastMessageId: messageRef.id,
        lastMessageSender: username,
        lastMessagePreview: text.slice(0, LAST_MESSAGE_PREVIEW_MAX),
        lastMessageHasImage: Boolean(image)
      };
      if (selectedChatType === "group") chatUpdate.lastReadAt = { [currentUser.uid]: serverTimestamp() };
      else chatUpdate[chatRef.readField] = serverTimestamp();
      batch.set(chatRef.ref, chatUpdate, { merge: true });
    }
    await batch.commit();
    /* 送信が成功したときだけ、送った画像の選択を解除する（送信中に別の画像を選び直していたら、そちらは残す） */
    if (sendingImage && pendingImage === sendingImage) clearPendingImage();
    setSendingState(false);
    requestPushNotification(messageRef.id);
  } catch (error) {
    console.error("メッセージ送信エラー:", error);
    const errorText = describeSendError(error, Boolean(image));
    if (messageInput && !messageInput.value) messageInput.value = text;
    if (replyingAtSend && !replyingMessage) { replyingMessage = replyingAtSend; updateReplyBar(); }
    if (sendingImage && pendingImage === sendingImage) sendingImage.error = errorText;
    setSendingState(false);
    alert(errorText);
  }
}

/* =========================================================
   画像送信
========================================================= */

/* 画像はメッセージ（messages/{id}.image）に data URL のまま保存する（以前からの形。表示側はそのまま）。
   Firestore の1ドキュメントは 1MiB までなので、大きな画像は送る前に端末の中で小さくする
   （以前はそのまま保存していたため、約750KBを超える写真は保存できずに送信が失敗していた）
   ・選べるファイルは今まで通り 5MB まで（制限は緩めない）
   ・元の画像が十分小さければそのまま送る（GIF のアニメーションなども保つ）
   ・大きければ長い辺 1600px まで縮めて JPEG にし、data URL が CHAT_IMAGE_MAX_LENGTH 以下になるまで画質・大きさを下げる
   ・CHAT_IMAGE_MAX_LENGTH は 300KB（以前は 700KB）。Firestore の無料枠（保存容量・通信量）を守るため。
     写真はふつう長い辺 1600〜1280px のまま収まる。これより大きい GIF・PNG は JPEG に変わる（GIF のアニメーションは止まる） */
const CHAT_IMAGE_MAX_FILE_BYTES = 5 * 1024 * 1024;
const CHAT_IMAGE_MAX_LENGTH = 300 * 1024;
const CHAT_IMAGE_SIDES = [1600, 1280, 1024, 800, 640];
const CHAT_IMAGE_QUALITIES = [0.85, 0.75, 0.65, 0.55];
async function prepareChatImage(file) {
  const original = await readFileAsDataURL(file);
  if (original.length <= CHAT_IMAGE_MAX_LENGTH && /^data:image\/(jpeg|png|gif|webp);/.test(original)) return original;

  const url = URL.createObjectURL(file);
  try {
    const image = await loadImageElement(url);
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    if (!width || !height) throw new Error("IMAGE_LOAD_FAILED");
    for (const side of CHAT_IMAGE_SIDES) {
      const scale = Math.min(1, side / Math.max(width, height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const context = canvas.getContext("2d");
      context.fillStyle = "#fff"; // 透明な部分（PNG など）が黒くならないように
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      for (const quality of CHAT_IMAGE_QUALITIES) {
        const dataURL = canvas.toDataURL("image/jpeg", quality);
        if (dataURL.length <= CHAT_IMAGE_MAX_LENGTH) return dataURL;
      }
    }
    throw new Error("IMAGE_TOO_LARGE");
  } finally {
    URL.revokeObjectURL(url);
  }
}

/* data URL の中身のおおよそのバイト数 */
function dataURLBytes(dataURL) {
  const base64 = String(dataURL || "").split(",")[1] || "";
  return Math.floor(base64.length * 3 / 4);
}

function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/* 選択中の画像の表示（プレビュー・ファイル名・サイズ・状態・解除ボタン） */
function renderImagePreview(notice = "") {
  if (!imagePreviewBar) return;
  imageButton?.classList.toggle("has-image", Boolean(pendingImage));
  imageButton?.setAttribute("title", pendingImage ? "画像を選び直す" : "画像を送る");
  if (imageButton) imageButton.disabled = isSendingMessage;
  if (!pendingImage) {
    imagePreviewBar.classList.add("hidden");
    imagePreviewBar.classList.remove("is-error", "is-sending");
    if (imagePreviewThumb) { imagePreviewThumb.removeAttribute("src"); imagePreviewThumb.classList.add("hidden"); }
    if (imagePreviewName) imagePreviewName.textContent = "";
    if (imagePreviewStatus) imagePreviewStatus.textContent = "";
    return;
  }

  const item = pendingImage;
  imagePreviewBar.classList.remove("hidden");
  if (imagePreviewThumb) {
    if (item.dataURL) {
      if (imagePreviewThumb.getAttribute("src") !== item.dataURL) imagePreviewThumb.src = item.dataURL;
      imagePreviewThumb.classList.remove("hidden");
    } else {
      imagePreviewThumb.removeAttribute("src");
      imagePreviewThumb.classList.add("hidden");
    }
  }
  if (imagePreviewName) {
    const size = formatFileSize(item.size);
    imagePreviewName.textContent = size ? `${item.name}（${size}）` : item.name;
    imagePreviewName.title = item.name;
  }

  let status = "";
  if (isSendingMessage && item.status === "ready") status = "送信中…";
  else if (item.error) status = item.error;
  else if (notice) status = notice;
  else if (item.status === "preparing") status = "画像を準備中…";
  else if (item.status === "ready") status = item.sentBytes && item.sentBytes < item.size ? `送信できます（${formatFileSize(item.sentBytes)}に小さくして送ります）` : "送信できます";
  if (imagePreviewStatus) imagePreviewStatus.textContent = status;
  imagePreviewBar.classList.toggle("is-error", Boolean(item.error || notice) && !isSendingMessage);
  imagePreviewBar.classList.toggle("is-sending", isSendingMessage);
  if (imagePreviewClear) imagePreviewClear.disabled = isSendingMessage;
}

/* 選んだ画像の選択を解除する（送信済みのメッセージや履歴には触れない） */
function clearPendingImage() {
  pendingImageSeq++;
  pendingImage = null;
  if (imageInput) imageInput.value = ""; // 同じ画像をもう一度選んでも選び直せるように
  renderImagePreview();
}

imagePreviewClear?.addEventListener("click", () => {
  if (isSendingMessage) return;
  clearPendingImage();
});

imageButton?.addEventListener("click", () => {
  if (isSendingMessage) return;
  imageInput?.click();
});

imageInput?.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  if (isSendingMessage) { imageInput.value = ""; return; }

  if (!file.type.startsWith("image/")) {
    alert("画像ファイルを選択してください。");
    imageInput.value = "";
    return;
  }

  if (file.size > CHAT_IMAGE_MAX_FILE_BYTES) {
    alert("画像は5MB以下にしてください。");
    imageInput.value = "";
    return;
  }

  /* 新しく選んだ画像に切り替える（準備が終わる前に選び直したら、古い方の結果は使わない） */
  const seq = ++pendingImageSeq;
  const item = { id: seq, name: file.name || "画像", size: file.size, status: "preparing", dataURL: "", sentBytes: 0, error: "" };
  pendingImage = item;
  imageInput.value = "";
  renderImagePreview();

  try {
    const dataURL = await prepareChatImage(file);
    if (pendingImageSeq !== seq) return;
    item.dataURL = dataURL;
    item.sentBytes = dataURLBytes(dataURL);
    item.status = "ready";
  } catch (error) {
    console.error("画像読み込みエラー:", error);
    if (pendingImageSeq !== seq) return;
    item.status = "error";
    item.error = error?.message === "IMAGE_TOO_LARGE"
      ? "画像を小さくできませんでした。別の画像を選んでください。"
      : "この画像は読み込めませんでした。別の画像（JPEG / PNG など）を選んでください。";
  }
  renderImagePreview();
});

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/* =========================================================
   既読・未読
   ・メッセージ1件ごとではなく、チャット（友達・グループ）ごとに「どこまで読んだか」の時刻を1つ持つ
       友達：friends/{id}.user1LastReadAt / user2LastReadAt
       グループ：groups/{id}.lastReadAt.{UID}
     最後のメッセージ：lastMessageAt / lastMessageSenderUid（送信と同じ書き込みで更新）
   ・未読マーク：最後のメッセージが相手からで、自分の「読んだ時刻」より新しいとき（購読中の友達・グループの情報だけで判定）
   ・既読にするのは、チャット画面が実際に表示されているときだけ。表示しているメッセージの時刻までにする
     （まだ表示されていないメッセージまで既読にしない）。書き込みはチャットごとに1回
   ・以前のメッセージの readBy も、既読の表示には使う（古いデータとの互換）
========================================================= */

function timestampMillis(value, fallback = 0) {
  const date = toDateValue(value);
  return date ? date.getTime() : fallback;
}

function isChatUnread(lastMessageAt, lastMessageSenderUid, myLastReadAt) {
  if (!lastMessageAt || !currentUser) return false;
  if (lastMessageSenderUid === currentUser.uid) return false;
  return timestampMillis(lastMessageAt) > timestampMillis(myLastReadAt);
}

function isChatScreenVisible() {
  return document.visibilityState === "visible" &&
    !appElement?.classList.contains("hidden") &&
    Boolean(chatView?.classList.contains("active"));
}

function isViewingChat(type, id) {
  if (!isChatScreenVisible() || selectedChatType !== type) return false;
  return type === "group" ? selectedChat === id : selectedFriendshipId === id;
}

function buildNameWithUnreadMark(nameElement, unread) {
  const row = document.createElement("div");
  row.className = "chat-name-row";
  row.appendChild(nameElement);
  if (unread) {
    const mark = document.createElement("span");
    mark.className = "unread-dot";
    mark.title = "未読のメッセージがあります";
    mark.setAttribute("aria-label", "未読あり");
    row.appendChild(mark);
  }
  return row;
}

function getSelectedFriendEntry() {
  if (selectedChatType !== "friend") return null;
  return friendsData.find((f) => f.friendshipId === selectedFriendshipId) || null;
}

function getSelectedGroupEntry() {
  if (selectedChatType !== "group") return null;
  return groupsData.find((g) => g.id === selectedChat) || null;
}

function getSelectedChatRef() {
  if (selectedChatType === "group") {
    return getSelectedGroupEntry() ? { ref: doc(db, "groups", selectedChat) } : null;
  }
  const friend = getSelectedFriendEntry();
  return friend ? { ref: doc(db, "friends", friend.friendshipId), readField: friend.myReadField } : null;
}

/* 自分のメッセージに付ける「既読」の表示に使う情報 */
function getSelectedChatReadInfo() {
  if (selectedChatType === "group") {
    const group = getSelectedGroupEntry();
    const readers = Object.entries(group?.lastReadAt || {})
      .filter(([uid]) => uid !== currentUser?.uid)
      .map(([, at]) => timestampMillis(at));
    return { type: "group", readers };
  }
  const friend = getSelectedFriendEntry();
  return { type: "friend", friendName: selectedChat, friendReadAt: timestampMillis(friend?.friendLastReadAt) };
}

function getReadLabel(message, readInfo) {
  if (!readInfo || !message) return "";
  const sentAt = timestampMillis(message.createdAt, Infinity);
  const legacyReaders = (Array.isArray(message.readBy) ? message.readBy : []).filter((name) => name && name !== username);
  if (readInfo.type === "group") {
    const count = Math.max(readInfo.readers.filter((at) => at >= sentAt).length, legacyReaders.length);
    return count > 0 ? `既読 ${count}` : "";
  }
  return readInfo.friendReadAt >= sentAt || legacyReaders.includes(readInfo.friendName) ? "既読" : "";
}

/* 相手が読んだ（友達・グループの情報が変わった）ときは、表示中のメッセージの「既読」だけを書き換える */
function refreshSelectedChatReadMarks() {
  if (!messagesElement || !selectedChat || selectedChatMessages.length === 0) return;
  const readInfo = getSelectedChatReadInfo();
  selectedChatMessages.forEach((message) => {
    const row = messagesElement.querySelector(`.message-row[data-message-id="${CSS.escape(message.id || "")}"]`);
    const label = row?.querySelector(".message-read");
    if (label) label.textContent = getReadLabel(message, readInfo);
  });
}

let lastReadWriteKey = "";

async function markSelectedChatAsRead() {
  if (!currentUser || !username || !selectedChat || !isChatScreenVisible()) return;
  /* 端末に残っていたデータだけで描いている段階（サーバーの最新をまだ受け取っていない）では既読にしない。
     同じチャットのタップ・アプリに戻ったとき・チャット画面への切り替えなど、どこから呼ばれても同じ */
  if (chatPaging && !chatPaging.fallback && !chatPaging.serverSynced) return;
  const chatRef = getSelectedChatRef();
  if (!chatRef) return;

  /* 表示しているメッセージのうち、相手からの最新のもの */
  let latest = null;
  selectedChatMessages.forEach((message) => {
    const fromOther = message.senderUid ? message.senderUid !== currentUser.uid : message.sender !== username;
    if (!fromOther || !message.createdAt) return;
    if (!latest || timestampMillis(message.createdAt) > timestampMillis(latest)) latest = message.createdAt;
  });
  if (!latest) return;

  const entry = selectedChatType === "group" ? getSelectedGroupEntry() : getSelectedFriendEntry();
  if (timestampMillis(latest) <= timestampMillis(entry?.myLastReadAt)) return;

  const key = `${selectedChatType}:${selectedChat}:${timestampMillis(latest)}`;
  if (key === lastReadWriteKey) return;
  lastReadWriteKey = key;

  try {
    if (selectedChatType === "group") {
      await updateDoc(chatRef.ref, { [`lastReadAt.${currentUser.uid}`]: latest });
    } else {
      await updateDoc(chatRef.ref, { [chatRef.readField]: latest });
    }
  } catch (error) {
    lastReadWriteKey = "";
    console.error("既読更新エラー:", error);
  }
}

/* アプリに戻ってきた・チャット画面に切り替えたときに、表示中のチャットを既読にする */
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  markSelectedChatAsRead();
  renderFriends();
  renderGroups();
});

/* =========================================================
   通知（Firebase Cloud Messaging）
   ・通知の許可はマイページの「🔔 通知をONにする」ボタンからだけ求める
     （iPhone / iPad のPWAでは、ユーザー操作の中で許可を求める必要があるため）
   ・トークンは fcmTokens/{トークン} に端末ごとに保存する（uid で持ち主を判断する）
   ・メッセージを送ったら、Cloudflare Worker（NOTIFY_ENDPOINT）に通知の送信を頼む。
     Worker が受信者の全端末へ FCM で送る（送った本人には送らない）
   ・アプリを開いているときは onMessage と Firestore 監視の両方から同じ出来事が来るので、
     notifyOnce() で1回にまとめる。ブラウザ通知は tag をそろえて1件にまとめる
========================================================= */

const FCM_TOKEN_STORAGE_KEY = "yuuchat_fcm_token";

/* 「通知をONにする」を押したかどうか（この端末・このアカウントごとに記録する）。
   記録がないときは、ブラウザの通知が許可済みでも自動では登録しない（ONにした人にだけ届ける） */
function getNotifyOptInKey() {
  return currentUser ? `yuuchat_notify_on:${currentUser.uid}` : null;
}

function isNotifyOptedIn() {
  const key = getNotifyOptInKey();
  return Boolean(key && localStorage.getItem(key) === "1");
}

function setNotifyOptIn(enabled) {
  const key = getNotifyOptInKey();
  if (!key) return;
  if (enabled) localStorage.setItem(key, "1");
  else localStorage.removeItem(key);
}

/* ----- 通知機能追加のお知らせ -----
   「通知の登録が一度でも成功したか」で判断する（閉じただけでは「済み」にしない）。
   成功の記録は2か所に残す：
     ・この端末：yuuchat_notify_setup_done:{uid}（以前からの「ONにした」記録 yuuchat_notify_on:{uid} も済みとみなす）
     ・アカウント：users/{名前}.notificationSetupDone（別の端末や、端末の記録が消えたときに使う）
   済みのユーザーには、OFF にしたあとも表示しない（ON に戻すのはマイページのボタンからできる） */
const notifyAnnouncementEl = document.getElementById("notifyAnnouncement");
let notifyAnnouncementDismissed = false;
let notifyAnnouncementCheckId = 0;

function getNotifySetupDoneKey() {
  return currentUser ? `yuuchat_notify_setup_done:${currentUser.uid}` : null;
}

function isNotifySetupDoneLocally() {
  const key = getNotifySetupDoneKey();
  return Boolean(key && localStorage.getItem(key) === "1") || isNotifyOptedIn();
}

function setNotifyAnnouncementVisible(visible) {
  notifyAnnouncementEl?.classList.toggle("hidden", !visible);
}

async function saveNotifySetupDoneToServer() {
  if (!currentUser || !username) return;
  try {
    await updateDoc(doc(db, "users", username), { notificationSetupDone: true });
  } catch (error) {
    console.warn("通知設定済みの記録に失敗:", error);
  }
}

/* 通知の登録に成功したとき：お知らせを消し、今後は表示しない */
function markNotifySetupDone() {
  const key = getNotifySetupDoneKey();
  if (key) localStorage.setItem(key, "1");
  notifyAnnouncementCheckId++;
  setNotifyAnnouncementVisible(false);
  saveNotifySetupDoneToServer();
}

/* アプリを開いたとき：まだ通知の設定が済んでいなければ、お知らせを表示する */
async function updateNotifyAnnouncement() {
  const checkId = ++notifyAnnouncementCheckId;
  if (!currentUser || !username || notifyAnnouncementDismissed) {
    setNotifyAnnouncementVisible(false);
    return;
  }

  const doneLocally = isNotifySetupDoneLocally();
  if (doneLocally) setNotifyAnnouncementVisible(false);

  let doneOnServer = false;
  try {
    const snapshot = await getDoc(doc(db, "users", username));
    doneOnServer = snapshot.exists() && snapshot.data().uid === currentUser?.uid && snapshot.data().notificationSetupDone === true;
  } catch (error) {
    console.warn("通知設定状況の確認に失敗:", error);
  }
  if (checkId !== notifyAnnouncementCheckId || !currentUser) return;

  if (doneLocally) {
    /* 以前から ON にしていた人：アカウント側にも記録しておく */
    if (!doneOnServer) saveNotifySetupDoneToServer();
    return;
  }
  if (doneOnServer) {
    const key = getNotifySetupDoneKey();
    if (key) localStorage.setItem(key, "1");
    setNotifyAnnouncementVisible(false);
    return;
  }
  setNotifyAnnouncementVisible(!notifyAnnouncementDismissed);
}

/* ログアウト時：表示を消し、次にログインした人のために「閉じた」状態を戻す */
function resetNotifyAnnouncement() {
  notifyAnnouncementCheckId++;
  notifyAnnouncementDismissed = false;
  setNotifyAnnouncementVisible(false);
}

document.getElementById("notifyAnnouncementCloseButton")?.addEventListener("click", () => {
  /* 閉じても「済み」にはしない（次にアプリを開いたときにまた表示する） */
  notifyAnnouncementDismissed = true;
  setNotifyAnnouncementVisible(false);
});

document.getElementById("notifyAnnouncementOpenButton")?.addEventListener("click", () => {
  notifyAnnouncementDismissed = true;
  setNotifyAnnouncementVisible(false);
  switchView("mypage");
  document.querySelector(".notification-settings")?.scrollIntoView({ behavior: "smooth", block: "center" });
});

const notificationButton = document.getElementById("notificationButton");
const notificationStatusEl = document.getElementById("notificationStatus");

function isIOSDevice() {
  const ua = navigator.userAgent || "";
  return /iPhone|iPad|iPod/.test(ua) || (ua.includes("Macintosh") && navigator.maxTouchPoints > 1);
}

function isStandaloneApp() {
  return window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone === true;
}

function setNotificationStatus(text, state) {
  if (notificationStatusEl) notificationStatusEl.textContent = text;
  if (notificationButton) {
    notificationButton.dataset.state = state || "";
    notificationButton.textContent = state === "on" ? "🔕 通知をOFFにする" : "🔔 通知をONにする";
    notificationButton.disabled = state === "unsupported" || state === "denied" || state === "busy";
  }
}

function getUnsupportedNotificationText() {
  if (isIOSDevice() && !isStandaloneApp()) {
    return "iPhone / iPad では、Safari の共有ボタンから「ホーム画面に追加」したアプリを開くと通知を利用できます。";
  }
  return "この端末・ブラウザでは通知を利用できません。";
}

async function isFcmAvailable() {
  if (typeof Notification === "undefined" || !("serviceWorker" in navigator)) return false;
  try {
    return await isSupported();
  } catch (error) {
    console.error("通知の対応確認エラー:", error);
    return false;
  }
}

/* 今の状態をボタンと説明文に反映する（許可は求めない） */
async function refreshNotificationStatus() {
  if (!(await isFcmAvailable())) {
    setNotificationStatus(getUnsupportedNotificationText(), "unsupported");
    return;
  }
  if (Notification.permission === "denied") {
    setNotificationStatus("通知がブロックされています。ブラウザや端末の設定から、このサイトの通知を許可してください。", "denied");
    return;
  }
  if (Notification.permission === "granted" && isNotifyOptedIn() && localStorage.getItem(FCM_TOKEN_STORAGE_KEY)) {
    setNotificationStatus("この端末に通知が届きます。（ボタンを押すとOFFにできます）", "on");
    return;
  }
  setNotificationStatus("ボタンを押すと、アプリを閉じていてもメッセージの通知が届くようになります。", "off");
}

/* 「🔔 通知をONにする」／「🔕 通知をOFFにする」ボタン */
notificationButton?.addEventListener("click", async () => {
  if (!currentUser || !username) return;

  /* ON のときに押したら OFF：この端末のトークンを消し、以後この端末には送らない */
  if (notificationButton.dataset.state === "on") {
    setNotificationStatus("OFFにしています...", "busy");
    setNotifyOptIn(false);
    await unregisterFcmTokenForThisDevice();
    setNotificationStatus("通知はOFFです。この端末には通知が送られません。", "off");
    return;
  }

  /* iOS Safari はユーザー操作の直後でないと許可ダイアログを出さないので、
     他の await より前に許可を求める */
  let permission = typeof Notification === "undefined" ? "unsupported" : Notification.permission;
  if (permission === "default") {
    try {
      permission = await Notification.requestPermission();
    } catch (error) {
      console.error("通知許可エラー:", error);
    }
  }

  if (!(await isFcmAvailable())) {
    setNotificationStatus(getUnsupportedNotificationText(), "unsupported");
    return;
  }
  if (permission !== "granted") {
    await refreshNotificationStatus();
    return;
  }

  setNotificationStatus("設定しています...", "busy");
  const ok = await registerFcmToken();
  if (ok) {
    setNotifyOptIn(true);
    markNotifySetupDone();
    setNotificationStatus("この端末に通知が届きます。（ボタンを押すとOFFにできます）", "on");
  } else {
    setNotificationStatus("通知の設定に失敗しました。時間をおいてもう一度お試しください。", "off");
  }
});

/* ログイン後：この端末・このアカウントで「通知をONにする」を押していて、許可も残っているときだけ、
   許可を求めずにトークンを更新する（ONにしていない人・OFFにした人には登録しない） */
async function restoreNotificationsIfGranted() {
  try {
    if (isNotifyOptedIn() && await isFcmAvailable() && Notification.permission === "granted") {
      await registerFcmToken();
    }
  } catch (error) {
    console.error("通知の再設定エラー:", error);
  }
  refreshNotificationStatus();
}

async function getFcmMessaging() {
  if (fcmMessaging) return fcmMessaging;
  if (!(await isFcmAvailable())) return null;
  fcmMessaging = getMessaging(firebaseApp);
  return fcmMessaging;
}

async function registerFcmToken() {
  if (!currentUser || !username) return false;

  try {
    const messaging = await getFcmMessaging();
    if (!messaging) return false;

    const registration = await navigator.serviceWorker.register("./firebase-messaging-sw.js");
    const token = await getToken(messaging, {
      vapidKey: VAPID_PUBLIC_KEY,
      serviceWorkerRegistration: registration
    });
    if (!token) return false;

    /* この端末で前に使っていたトークンが変わっていたら、古い方だけ消す */
    const previousToken = localStorage.getItem(FCM_TOKEN_STORAGE_KEY);
    if (previousToken && previousToken !== token) {
      try { await deleteDoc(doc(db, "fcmTokens", previousToken)); } catch (error) { console.warn("古い通知トークン削除失敗:", error); }
    }

    await setDoc(doc(db, "fcmTokens", token), {
      uid: currentUser.uid,
      username,
      userAgent: (navigator.userAgent || "").slice(0, 200),
      updatedAt: serverTimestamp()
    }, { merge: true });

    localStorage.setItem(FCM_TOKEN_STORAGE_KEY, token);
    setupForegroundMessageListener(messaging);
    return true;
  } catch (error) {
    console.error(`[通知トークン登録エラー] code=${error?.code || "(なし)"} message=${error?.message || error}`, error);
    return false;
  }
}

/* ログアウト時：この端末のトークンだけ削除する（他の端末のトークンはそのまま） */
async function unregisterFcmTokenForThisDevice() {
  const token = localStorage.getItem(FCM_TOKEN_STORAGE_KEY);
  localStorage.removeItem(FCM_TOKEN_STORAGE_KEY);
  if (!token) return;

  /* 通知の送り先から外す（ログアウト前に行う必要があるので待つ） */
  try { await deleteDoc(doc(db, "fcmTokens", token)); } catch (error) { console.warn("通知トークン削除失敗:", error); }

  /* FCM 側のトークン無効化は、通信が遅くても画面を待たせないよう待たない */
  getFcmMessaging()
    .then((messaging) => (messaging ? deleteToken(messaging) : null))
    .catch((error) => console.warn("FCMトークン無効化失敗:", error));
}

/* 名前変更時：この端末のトークンの username を新しい名前にする（uid は変わらない） */
async function updateFcmTokenUsername() {
  const token = localStorage.getItem(FCM_TOKEN_STORAGE_KEY);
  if (!token || !currentUser || !username) return;
  try {
    await setDoc(doc(db, "fcmTokens", token), {
      uid: currentUser.uid, username, updatedAt: serverTimestamp()
    }, { merge: true });
  } catch (error) {
    console.warn("通知トークンの名前更新失敗:", error);
  }
}

/* メッセージを送ったあと、Worker に相手への通知を頼む（失敗してもメッセージ送信には影響しない） */
async function requestPushNotification(messageId) {
  if (!NOTIFY_ENDPOINT || !currentUser || !messageId) return;
  try {
    const idToken = await currentUser.getIdToken();
    const response = await fetch(NOTIFY_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
      body: JSON.stringify({ messageId })
    });
    if (!response.ok) console.warn("通知の送信依頼に失敗:", response.status, await response.text());
  } catch (error) {
    console.warn("通知の送信依頼エラー:", error);
  }
}

/* アプリを開いて見ているときに FCM で届いた通知 → アプリ内トースト */
function setupForegroundMessageListener(messaging) {
  if (fcmForegroundListenerReady || !messaging) return;
  fcmForegroundListenerReady = true;

  onMessage(messaging, (payload) => {
    const data = payload?.data || {};
    const title = data.title || payload?.notification?.title || "ゆうChat";
    const body = data.body || payload?.notification?.body || "新しい通知があります。";
    const key = data.messageId ? `message:${data.messageId}` : null;

    /* 今まさに開いているチャットのメッセージならトーストは出さない */
    if (isChatOpenAndFocused(data.friendshipId, data.groupId)) {
      markNotified(key);
      return;
    }

    notifyOnce(key, title, body);
  });
}

function isChatOpenAndFocused(friendshipId, groupId) {
  if (document.visibilityState !== "visible" || !document.hasFocus()) return false;
  if (friendshipId && selectedChatType === "friend" && selectedFriendshipId === friendshipId) return true;
  if (groupId && selectedChatType === "group" && selectedChat === groupId) return true;
  return false;
}

/* ----- 同じ出来事の通知を1回にまとめる ----- */

const NOTIFIED_KEY_TTL_MS = 10 * 60 * 1000;
const notifiedKeys = new Map();

function markNotified(key) {
  if (!key) return;
  const now = Date.now();
  notifiedKeys.forEach((time, k) => { if (now - time > NOTIFIED_KEY_TTL_MS) notifiedKeys.delete(k); });
  notifiedKeys.set(key, now);
}

/* key が同じ通知は10分以内に1回だけ表示する。options.browser でブラウザ通知も出す */
function notifyOnce(key, title, body, options = {}) {
  if (key && notifiedKeys.has(key) && Date.now() - notifiedKeys.get(key) < NOTIFIED_KEY_TTL_MS) return;
  markNotified(key);
  showAppToast(title, body);
  if (options.browser) showBrowserNotification(options.browserTitle || title, options.browserBody || body, { tag: options.tag, link: options.link });
}

/* ----- 通知をタップして開いたときの移動先 -----
   リンクは「./?open=chat&friendship=…」のような相対URL。
   公開URL（GitHub Pages のサブパス）は Service Worker のスコープから決まるので決め打ちしない */

let pendingNotificationTarget = parseNotificationTarget(window.location.search);

function parseNotificationTarget(search) {
  try {
    const params = new URLSearchParams(search || "");
    const open = params.get("open");
    /* 🏇 ゆうダービー開始前・📢 新しいお知らせの通知は、その画面を開く */
    if (open === "derby" || open === "announcements") return { open };
    if (open !== "chat") return null;
    return { open: "chat", friendship: params.get("friendship") || null, group: params.get("group") || null };
  } catch (error) {
    return null;
  }
}

function clearNotificationParamsFromUrl() {
  try {
    const url = new URL(window.location.href);
    ["open", "friendship", "group"].forEach((key) => url.searchParams.delete(key));
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  } catch (error) {
    /* URLを書き換えられなくても動作には影響しない */
  }
}

/* ログイン後・友達/グループ読み込み後に呼ばれる。開けたら保留を消す。
   source: "friends" / "groups" は、その一覧を読み込み終わった直後の呼び出し */
function applyPendingNotificationTarget(source) {
  const target = pendingNotificationTarget;
  if (!target || !currentUser || !username) return;

  if (target.open !== "chat") {
    pendingNotificationTarget = null;
    clearNotificationParamsFromUrl();
    switchView(target.open);
    return;
  }

  if (!target.viewApplied) { target.viewApplied = true; switchView("chat"); }

  if (target.friendship) {
    const friend = friendsData.find((f) => f.friendshipId === target.friendship);
    if (!friend) {
      /* 友達一覧を読み込んでも見つからない（削除済みなど）ならあきらめる */
      if (source === "friends") { pendingNotificationTarget = null; clearNotificationParamsFromUrl(); }
      return;
    }
    selectFriendChat(friend);
  } else if (target.group) {
    const group = groupsData.find((g) => g.id === target.group);
    if (!group) {
      if (source === "groups") { pendingNotificationTarget = null; clearNotificationParamsFromUrl(); }
      return;
    }
    selectGroupChat(group);
  }

  pendingNotificationTarget = null;
  clearNotificationParamsFromUrl();
}

/* アプリがすでに開いていて通知をタップした場合は、Service Worker から知らせが来る */
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type !== "yuuchat-open-link" || !event.data.link) return;
    try {
      pendingNotificationTarget = parseNotificationTarget(new URL(event.data.link, window.location.href).search);
      applyPendingNotificationTarget();
    } catch (error) {
      console.error("通知リンク処理エラー:", error);
    }
  });
}

/* =========================================================
   アプリ内トースト通知／ブラウザ通知
   （メッセージ受信・ゆうダービー開始などに使用。
    FCM/サービスワーカーの設定に依存せず、常に動く軽量版）
========================================================= */

function showAppToast(title, body) {
  const notification = document.createElement("div");
  notification.className = "notification";

  const titleElement = document.createElement("div");
  titleElement.className = "notification-title";
  titleElement.textContent = title;

  const bodyElement = document.createElement("div");
  bodyElement.className = "notification-body";
  bodyElement.textContent = body;

  notification.append(titleElement, bodyElement);
  document.body.appendChild(notification);

  requestAnimationFrame(() => notification.classList.add("show"));

  setTimeout(() => {
    notification.classList.remove("show");
    setTimeout(() => notification.remove(), 300);
  }, 4000);
}

async function showBrowserNotification(title, body, options = {}) {
  if (typeof Notification === "undefined") return;
  if (Notification.permission !== "granted") return;

  /* 今まさにこのタブを見ている間は、ブラウザ通知は出さない（アプリ内トーストだけで十分なため） */
  if (document.visibilityState === "visible" && document.hasFocus()) return;

  /* tag を FCM（Service Worker）側と同じにしておくと、両方から出ても1件にまとまる */
  const notificationOptions = {
    body,
    icon: "./icons/icon-192.png",
    badge: "./icons/icon-192.png",
    data: { link: options.link || "./" }
  };
  if (options.tag) notificationOptions.tag = options.tag;

  try {
    /* スマホのブラウザは new Notification() が使えないので、Service Worker 経由を優先する */
    const registration = "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration() : null;
    if (registration) {
      await registration.showNotification(title, notificationOptions);
      return;
    }
    new Notification(title, notificationOptions);
  } catch (error) {
    console.error("ブラウザ通知エラー:", error);
  }
}

/* ----- メッセージ受信通知 ----- */

/* 新しいメッセージのアプリ内通知。
   以前は messages 全体の最新1件を全員が購読していた（誰かが送るたびにログイン中の全員に読み取りが発生）。
   今は、すでに購読している友達・グループの「最後のメッセージ」（送信と同じ書き込みで更新される）が
   変わったときに通知する。新しい読み取りは発生しない。
   ・ログイン直後に読み込んだ分・新しく一覧に加わったチャットの既存のメッセージは通知しない
   ・自分が送ったもの、今まさに開いて見ているチャットのものは通知しない
   ・重複防止のキー（message:{ID}）は、プッシュ通知（FCM）のアプリ内表示と同じ */
const LAST_MESSAGE_PREVIEW_MAX = 100;
const seenLastMessageIds = { friend: null, group: null };

function resetNewMessageWatch() {
  seenLastMessageIds.friend = null;
  seenLastMessageIds.group = null;
}

function notifyNewChatMessages(type, chats) {
  const previous = seenLastMessageIds[type];
  const next = new Map(chats.map((chat) => [type === "group" ? chat.id : chat.friendshipId, chat.lastMessageId || ""]));
  seenLastMessageIds[type] = next;
  if (!previous || !currentUser || !username) return; /* 最初の読み込みは通知しない */

  chats.forEach((chat) => {
    const chatId = type === "group" ? chat.id : chat.friendshipId;
    const messageId = chat.lastMessageId || "";
    if (!messageId || !previous.has(chatId) || previous.get(chatId) === messageId) return;
    if (chat.lastMessageSenderUid === currentUser.uid) return;

    const isCurrentlyOpenChat = type === "group"
      ? (selectedChatType === "group" && selectedChat === chat.id)
      : (selectedChatType === "friend" && selectedFriendshipId === chat.friendshipId);
    /* 今まさにその相手とのチャットを開いて見ている場合は、うるさいので通知しない */
    if (isCurrentlyOpenChat && document.visibilityState === "visible" && document.hasFocus()) return;

    const sender = chat.lastMessageSender || (type === "friend" ? chat.friend : "") || "メンバー";
    const title = type === "group" ? `${sender}（グループ）` : sender;
    const body = chat.lastMessageHasImage ? "画像を送信しました" : (chat.lastMessagePreview || "メッセージが届きました");
    const link = type === "group"
      ? `./?open=chat&group=${encodeURIComponent(chat.id || "")}`
      : `./?open=chat&friendship=${encodeURIComponent(chat.friendshipId || "")}`;

    notifyOnce(`message:${messageId}`, title, body, {
      browser: true,
      browserTitle: "ゆうChat",
      browserBody: type === "group" ? `${chat.name || "グループ"}グループに新しいメッセージがあります` : `${sender}さんからメッセージが届きました`,
      tag: `message-${messageId}`,
      link
    });
  });
}

/* =========================================================
   タブ切り替え
========================================================= */

const tabButtons = document.querySelectorAll(".tabs button[data-view]");

tabButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const view = button.dataset.view;
    if (view) switchView(view);
  });
});

function switchView(view) {
  /* 👤 ユーザー管理は管理者だけ（タブも管理者にだけ表示） */
  if (view === "usermanage" && !isAdminUser()) view = "chat";
  const views = { chat: chatView, derby: derbyView, economy: economyView, games: gamesView, announcements: announcementsView, mypage: mypageView, usermanage: userManageView };

  Object.entries(views).forEach(([name, element]) => {
    if (!element) return;
    element.classList.toggle("active", name === view);
    element.classList.toggle("hidden", name !== view);
  });

  tabButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.view === view);
  });

  if (view === "chat") { markSelectedChatAsRead(); renderFriends(); renderGroups(); }
  if (view === "mypage") loadMyPage();
  if (view === "derby") { refreshDerbySubscriptionsIfNeeded(); renderRaceInfo(); }
  else stopDerbySubscriptions();
  /* ルーム一覧の監視はゲーム画面を開いている間だけ（戻ったときに最新の一覧を読み直す）。開いているルームの監視は続ける */
  if (view === "games") loadGameRooms();
  else stopGameRoomsSubscription();
  if (view === "economy") openEconomyView();
  if (view === "announcements") openAnnouncementsView();
  else stopAnnouncementsSubscription();
  if (view === "usermanage") openUserManageView();
}

/* =========================================================
   ログアウト
========================================================= */

logoutButton?.addEventListener("click", async () => {
  if (!confirm("ログアウトしますか？")) return;

  appSessionSeq++;
  try {
    stopFriendListeners();
    if (unsubscribeGroups) { unsubscribeGroups(); unsubscribeGroups = null; }
    if (unsubscribeMessages) { unsubscribeMessages(); unsubscribeMessages = null; }
    selectedChatMessages = [];
    lastReadWriteKey = "";
    closeChatModal();
    if (unsubscribeGameRooms) { unsubscribeGameRooms(); unsubscribeGameRooms = null; }
    if (unsubscribeCurrentGame) { unsubscribeCurrentGame(); unsubscribeCurrentGame = null; }
    if (unsubscribeGameInvites) { unsubscribeGameInvites(); unsubscribeGameInvites = null; }
    if (unsubscribeManualRaces) { unsubscribeManualRaces(); unsubscribeManualRaces = null; }
    manualRaces = new Map();
    selectedBetRaceId = null;
    document.getElementById("derbyAdminPanel")?.classList.add("hidden");
    resetAnnouncementsState();
    resetUserManageState();
    pendingGameInvites = [];
    gameInvitesInitialized = false;
    if (unsubscribeMyCoins) { unsubscribeMyCoins(); unsubscribeMyCoins = null; }
    stopDerbySubscriptions();
    if (unsubscribeMyBetHistory) { unsubscribeMyBetHistory(); unsubscribeMyBetHistory = null; }
    resetNewMessageWatch();
    if (raceCountdownTimer) { clearInterval(raceCountdownTimer); raceCountdownTimer = null; }
    derbyReplay = null;
    lastActiveBettingRaceId = null;
    lastLiveRaceId = null;
    liveRaceResult = null;
    lastGenerationAttemptAt = -999;
    currentWinPool = {};
    myCoins = 0;
    myAllBets = [];
    betHistoryErrorCode = "";
    myPageStatsShownForUid = "";
    myLatestUserData = null;
    resetLoginBonusState();
    economyBankAmount = "";
    cachedPopularityForRaceId = null;
    cachedPopularity = null;
    lastRaceInfoRenderAt = -999;

    resetNotifyAnnouncement();
    await unregisterFcmTokenForThisDevice();

    /* 次に別のアカウントでログインしたときに引き継がれないようにする */
    myProfileImageData = "";
    loadProfileImage();
    localStorage.removeItem("yuuchat_username");

    await signOut(auth);
  } catch (error) {
    console.error("ログアウトエラー:", error);
    alert("ログアウトに失敗しました。");
  }
});

/* =========================================================
   マイページ
========================================================= */

async function loadMyPage() {
  if (!currentUser) return;
  if (myName) myName.textContent = username || "ゲスト";

  /* 馬券の購読がエラーで止まっていたら、マイページを開いたこのときに1回だけ作り直す（自動では繰り返さない） */
  refreshMyBetHistoryWindow({ retryAfterError: true });
  await loadMyPageStats();
  await loadCoinRanking();
}

async function loadMyPageStats() {
  const session = appSessionSeq;
  if (!currentUser || !username) return;

  /* 自分の全馬券を読む代わりに、Firestore の集計（件数・合計）だけを読む（集計1回は、1,000件ごとに読み取り1回）。
     条件は等号だけなので複合インデックスは不要。
     集計そのものが使えないとき（BET_STATS_FALLBACK_CODES）だけ、以前と同じく全件を読んで数える。
     無料枠の超過・権限・通信などのエラーでは全件を読まない（読み取りが増えるだけで直らず、オフラインでは手元の古いデータで誤った値になる）。
     そのときは前に表示した値をそのまま残し、まだ一度も表示していなければ「—」にする（0 とは表示しない） */
  const uid = currentUser.uid;
  const render = (betCount, hitCount, profit) => {
    if (myBetCount) myBetCount.textContent = betCount;
    if (myHitCount) myHitCount.textContent = hitCount;
    if (myProfit) myProfit.textContent = (profit >= 0 ? "+" : "") + profit;
    myPageStatsShownForUid = uid;
  };
  const renderUnavailable = () => {
    if (myPageStatsShownForUid === uid) return;
    [myBetCount, myHitCount, myProfit].forEach((el) => { if (el) el.textContent = "—"; });
  };

  try {
    const mine = query(collection(db, "raceBets"), where("uid", "==", currentUser.uid));
    const settled = query(mine, where("settled", "==", true));
    const [all, totals, hits] = await Promise.all([
      getAggregateFromServer(mine, { n: aggregateCount() }),
      getAggregateFromServer(settled, { amount: aggregateSum("amount"), payout: aggregateSum("payout") }),
      getAggregateFromServer(query(settled, where("win", "==", true)), { n: aggregateCount() })
    ]);
    if (session !== appSessionSeq) return;
    render(all.data().n, hits.data().n, Number(totals.data().payout || 0) - Number(totals.data().amount || 0));
    return;
  } catch (error) {
    if (isInterruptedBySignOut(session)) return;
    if (!BET_STATS_FALLBACK_CODES.has(error?.code)) {
      console.warn("マイページ統計を読み込めませんでした（全件は読みません）:", error?.code || error);
      renderUnavailable();
      return;
    }
    console.warn("マイページ統計の集計が使えないため、全件を読んで数えます:", error.code);
  }

  try {
    const snapshot = await getDocs(query(collection(db, "raceBets"), where("uid", "==", currentUser.uid)));
    let betCount = 0;
    let hitCount = 0;
    let profit = 0;

    snapshot.forEach((item) => {
      const bet = item.data();
      betCount++;
      if (bet.settled) {
        if (bet.win) hitCount++;
        profit += (bet.payout || 0) - Number(bet.amount || 0);
      }
    });

    if (session !== appSessionSeq) return;
    render(betCount, hitCount, profit);
  } catch (error) {
    if (isInterruptedBySignOut(session)) return;
    console.error("マイページ統計エラー:", error);
    renderUnavailable();
  }
}

/* 「🏆 総資産ランキング」（マイページ／ゆうダービー画面の両方から呼べる共通版）
   ・毎日 13:00 に自動処理（derby-runner）が作るまとめ rankings/assets を1件読むだけ（users は読まない）
   ・総資産 = 手持ちコイン + 銀行預金 + 保有株の評価額 − 借入残高。全ユーザーが対象・同額は同じ順位
   ・まとめは1日1回しか変わらないので、読み込んだものを次の更新まで使い回す（画面を開くたびに読み直さない） */
async function renderAssetRankingInto(targetEl) {
  const session = appSessionSeq;
  if (!targetEl) return;
  if (!rankingCacheIsFresh()) targetEl.innerHTML = `<div class="loading">ランキングを読み込み中...</div>`;

  try {
    const ranking = await loadAssetRanking();
    if (session !== appSessionSeq) return;
    const users = Array.isArray(ranking?.users) ? ranking.users : [];
    const updatedNote = ranking?.date ? `<div class="ranking-updated">${escapeHTML(formatEconomyDate(ranking.date))} 13:00 更新（毎日13:00に更新）</div>` : "";

    if (users.length === 0) {
      targetEl.innerHTML = `<div class="empty-state">総資産ランキングは毎日13:00に集計されます（まだ集計前です）</div>`;
      return;
    }

    targetEl.innerHTML = updatedNote;
    const top = users.slice(0, 20);
    const medal = (rank) => (rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : rank);
    const row = (user, extraClass = "") => {
      const item = document.createElement("div");
      item.className = `ranking-item ${extraClass}`.trim();
      if (user.rank <= 3 && !extraClass) item.classList.add(`rank-${user.rank}`);
      if (user.name === username) item.classList.add("me");
      item.innerHTML = `
        <div class="ranking-number">${medal(user.rank)}</div>
        <div class="ranking-info">
          <div class="ranking-name">${escapeHTML(user.name)}${user.name === username ? "（あなた）" : ""}</div>
          <div class="ranking-score">💰 ${formatCoins(user.total)}</div>
        </div>
        ${isAdminUser() ? `<button type="button" class="ranking-admin-rename secondary" data-admin-rename="${escapeHTML(user.name)}">名前を変更</button>` : ""}`;
      return item;
    };
    top.forEach((user) => targetEl.appendChild(row(user)));

    /* 自分が上位20人に入っていない場合も、自分の順位が分かるようにする */
    const mine = users.find((u) => u.name === username);
    if (mine && !top.includes(mine)) targetEl.appendChild(row(mine, "me ranking-item-self"));
  } catch (error) {
    if (isInterruptedBySignOut(session)) return;
    console.error("ランキング取得エラー:", error);
    targetEl.innerHTML = `<div class="empty-state">ランキングを取得できませんでした</div>`;
  }
}

async function loadCoinRanking() {
  await renderAssetRankingInto(rankingEl);
}

async function loadDerbyCoinRanking() {
  await renderAssetRankingInto(document.getElementById("raceRankingPanel"));
}

/* =========================================================
   ゆうダービー：ゆうcoin・オッズ・投票・精算
========================================================= */

const YUU_START_COINS = 1000;
/* 初期コインとは別の「全ユーザーへの追加ボーナス」。1ユーザー1回だけ（users/{名前}.bonus500Granted で判定） */
const YUU_BONUS_COINS = 500;
const RACE_TAKEOUT_RATE = 0.8;
const RACE_HOUR = 15;
const RACE_MINUTE = 2;
const RACE_CLOSE_MINUTES_BEFORE = 10;
/* 1日2回開催：15:02 の回に加えて 11:30 の回を開催する（どちらも締切は10分前）。
   ・15:02 の回の raceId は従来どおり「YYYY-MM-DD」（過去のレース・馬券はそのまま使える）
   ・11:30 の回の raceId は「YYYY-MM-DD-1130」（同じ日の2レースが衝突しない）
   ・11:30 の回は TWICE_DAILY_FROM の日から（それより前の日にさかのぼって作らない）
   derby-runner/run.mjs と同じ設定にすること */
const MORNING_RACE_HOUR = 11;
const MORNING_RACE_MINUTE = 30;
const MORNING_RACE_SUFFIX = "-1130";
const TWICE_DAILY_FROM = "2026-10-07";
/* 管理者が作る手動レース（特別レース）：raceId は「YYYY-MM-DD-mHHMM」（例：2026-10-10-m1800）。
   自動開催の raceId（「YYYY-MM-DD」「YYYY-MM-DD-1130」）とは形が違うので衝突しない。
   予定（投票受付開始・終了・開催時刻・キャンセル）は derbyManualRaces/{raceId} に保存する */
const MANUAL_RACE_ID_PATTERN = /^(\d{4}-\d{2}-\d{2})-m(\d{2})(\d{2})$/;
/* 他のレースと開催時刻をこれ以上あける（演出・結果表示が重ならないように） */
const MANUAL_RACE_MIN_GAP_MINUTES = 3;
const ODDS_VIRTUAL_SEED_TOTAL = 200;

/* style: start=逃げ / front=先行 / mid=差し / closer=追込 / stamina=スタミナ / longshot=大穴
   （能力にはランダム性も加えるため「能力が高い＝必ず勝つ」にはならない） */
const SAFE_RACE_HORSES = [
  { number: 1, name: "ユウウキ", character: "気まぐれな逃げ馬", power: 6, style: "start" },
  { number: 2, name: "ユウセイ", character: "堅実な先行馬", power: 7, style: "front" },
  { number: 3, name: "ユウヤン", character: "末脚が鋭い差し馬", power: 8, style: "mid" },
  { number: 4, name: "ユウチュウ", character: "スタミナ自慢の追込馬", power: 5, style: "closer" },
  { number: 5, name: "ユウガ", character: "重賞実績もある実力馬", power: 9, style: "stamina" },
  { number: 6, name: "ユウバエ", character: "新人ながら期待の一頭", power: 4, style: "front" },
  { number: 7, name: "ユウキカイ", character: "安定感抜群のベテラン", power: 6, style: "stamina" },
  { number: 8, name: "ユウマグレ", character: "一発があるクセ馬", power: 3, style: "longshot" },
  { number: 9, name: "ユウジン", character: "人気先行のスター候補", power: 7, style: "front" },
  { number: 10, name: "ユウシャ", character: "底力のある大物", power: 8, style: "closer" }
];

const RACE_STYLE_LABELS = {
  start: "逃げ", front: "先行", mid: "差し", closer: "追込", stamina: "スタミナ", longshot: "大穴"
};

const BET_TYPE_NAMES = { win: "単勝", place: "複勝", quinella: "馬連", trio: "三連複", trifecta: "三連単" };
const BET_TYPE_COUNT = { win: 1, place: 1, quinella: 2, trio: 3, trifecta: 3 };

function getBetTypeName(type) { return BET_TYPE_NAMES[type] || type; }
function getHorseName(number) { return SAFE_RACE_HORSES.find((h) => h.number === number)?.name || `${number}番`; }

/* ----- 時刻の基準（日本時間 15:02:00）-----
   ・開催時刻・レースID（YYYY-MM-DD）は、端末のタイムゾーンに関係なく日本時間で計算する
     （自動開催 derby-runner/run.mjs と同じ基準。日本の端末では以前と同じ結果になる）
   ・端末の時計がずれていてもカウントダウンや演出がずれないよう、サーバー（GitHub Pages）の時刻との差を補正する */

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
let derbyClockOffsetMs = 0;

/* サーバーの時刻に合わせた「今」 */
function derbyNow() {
  return new Date(Date.now() + derbyClockOffsetMs);
}

/* サーバーが返す Date ヘッダーとの差を測る（2秒以内の差は補正しない） */
async function syncDerbyClock() {
  try {
    const sentAt = Date.now();
    const response = await fetch(`./manifest.json?clock=${sentAt}`, { method: "HEAD", cache: "no-store" });
    const receivedAt = Date.now();
    const serverDate = Date.parse(response.headers.get("Date") || "");
    if (!Number.isFinite(serverDate)) return;
    /* Date ヘッダーは秒単位なので +500ms、通信の往復の半分を足して推定する */
    const offset = serverDate + 500 + (receivedAt - sentAt) / 2 - receivedAt;
    derbyClockOffsetMs = Math.abs(offset) > 2000 ? Math.round(offset) : 0;
  } catch (error) {
    console.warn("時刻の確認に失敗（端末の時計を使います）:", error);
  }
}

/* 日本時間での年・月・日（UTCのメソッドで読むための Date） */
function toJstFields(date) {
  return new Date(date.getTime() + JST_OFFSET_MS);
}

function formatRaceId(date) {
  const jst = toJstFields(date);
  const year = jst.getUTCFullYear();
  const month = String(jst.getUTCMonth() + 1).padStart(2, "0");
  const day = String(jst.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getTodayRaceId() { return formatRaceId(derbyNow()); }

/* raceId → 開催時刻（日本時間）。「YYYY-MM-DD」は 15:02、「YYYY-MM-DD-1130」は 11:30 */
function isMorningRaceId(raceId) {
  return String(raceId).endsWith(MORNING_RACE_SUFFIX);
}

function isManualRaceId(raceId) {
  return MANUAL_RACE_ID_PATTERN.test(String(raceId));
}

function parseRaceIdToDate(raceId) {
  const manual = String(raceId).match(MANUAL_RACE_ID_PATTERN);
  if (manual) {
    const [my, mm, md] = manual[1].split("-").map(Number);
    return new Date(Date.UTC(my, mm - 1, md, Number(manual[2]), Number(manual[3]), 0, 0) - JST_OFFSET_MS);
  }
  const [y, m, d] = String(raceId).slice(0, 10).split("-").map(Number);
  const morning = isMorningRaceId(raceId);
  return new Date(Date.UTC(y, m - 1, d, morning ? MORNING_RACE_HOUR : RACE_HOUR, morning ? MORNING_RACE_MINUTE : RACE_MINUTE, 0, 0) - JST_OFFSET_MS);
}

function makeRaceContextFromId(raceId) {
  const manual = manualRaces.get(raceId);
  if (manual) {
    /* 手動レース：投票受付の開始・終了は管理者が決めた時刻 */
    return { raceId, dayId: manual.dayId, raceTime: manual.raceTime, openTime: manual.openTime, closeTime: manual.closeTime, manual: true };
  }
  const raceTime = parseRaceIdToDate(raceId);
  const closeTime = new Date(raceTime.getTime() - RACE_CLOSE_MINUTES_BEFORE * 60000);
  return { raceId, dayId: String(raceId).slice(0, 10), raceTime, closeTime };
}

/* その日（日本時間）に開催されるレース（開催時刻の早い順）。キャンセルされていない手動レースも含む */
function getRaceContextsForDay(dayId) {
  const ids = [];
  if (dayId >= TWICE_DAILY_FROM) ids.push(`${dayId}${MORNING_RACE_SUFFIX}`);
  ids.push(dayId);
  manualRaces.forEach((race) => {
    if (race.dayId === dayId && race.status !== "cancelled") ids.push(race.raceId);
  });
  return ids.map(makeRaceContextFromId).sort((a, b) => a.raceTime - b.raceTime);
}

/* 前日・当日・翌日のレース（開催時刻の早い順） */
function getRaceContextsAround(now) {
  return [-1, 0, 1].flatMap((offset) => getRaceContextsForDay(formatRaceId(new Date(now.getTime() + offset * DAY_MS))));
}

/* いま投票を受け付けているレース（開催時刻の早い順）。
   ・自動開催の回は、これまでどおり「締切前のいちばん早い回」の1つだけ（前の回の締切から受付）
   ・手動レースは、管理者が決めた受付開始〜受付終了のあいだだけ */
function getOpenBettingRaceContexts(now = derbyNow()) {
  const contexts = getRaceContextsAround(now);
  const nextAuto = contexts.find((c) => !c.manual && now < c.closeTime);
  const manualOpen = contexts.filter((c) => c.manual && now >= c.openTime && now < c.closeTime);
  return [...(nextAuto ? [nextAuto] : []), ...manualOpen].sort((a, b) => a.raceTime - b.raceTime);
}

/* 受付中のレースが複数あるときに、投票フォームで選んだレース */
let selectedBetRaceId = null;

/* 投票の対象：受付中のいちばん早いレース（受付中が複数あるときは選んだレース）。
   締切を過ぎたら、その瞬間から次の回（11:30→15:02→翌日11:30）が対象になる
   （1日のどこかの時間帯で投票が完全に止まることがないようにする） */
function getActiveBettingRaceContext(now = derbyNow()) {
  const open = getOpenBettingRaceContexts(now);
  return open.find((c) => c.raceId === selectedBetRaceId) || open[0];
}

/* 直近に発走した（または、まさに発走中の）レース。演出・結果表示・精算の対象。 */
function getLiveRaceContext(now = derbyNow()) {
  const started = getRaceContextsAround(now).filter((c) => now >= c.raceTime);
  return started[started.length - 1];
}

/* 次に始まるレース（カウントダウンの対象）。締切ではなく開催時刻で切り替える */
function getNextRaceStartContext(now = derbyNow()) {
  return getRaceContextsAround(now).find((c) => now < c.raceTime);
}

/* 画面に出すレース名（例：10/7 11:30） */
function formatRaceLabel(raceId) {
  const [, m, d] = String(raceId).slice(0, 10).split("-").map(Number);
  return `${m}/${d} ${formatJstHourMinute(parseRaceIdToDate(raceId))}${isManualRaceId(raceId) ? " 特別" : ""}`;
}

/* 右上のカウントダウンの文字（レース中は「レース中」、それ以外は次のレースまでの残り） */
function getDerbyCountdownText(now = derbyNow()) {
  const live = getLiveRaceContext(now);
  const sinceStart = now.getTime() - live.raceTime.getTime();
  const liveShow = live.raceId === getLiveRaceContext().raceId ? getLiveShow() : null;
  const showSeconds = liveShow ? liveShow.revealTime : RACE_DURATION_SECONDS;
  if (sinceStart >= 0 && sinceStart < showSeconds * 1000) return "🏇 レース中";

  const next = getNextRaceStartContext(now);
  const dayLabel = next.dayId === formatRaceId(now) ? "本日" : "明日";
  return `${dayLabel} ${formatCountdown(next.raceTime.getTime() - now.getTime())}`;
}

function formatJstHourMinute(date) {
  const jst = toJstFields(date);
  return `${String(jst.getUTCHours()).padStart(2, "0")}:${String(jst.getUTCMinutes()).padStart(2, "0")}`;
}


function formatCountdown(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/* ----- ゆうcoin残高 ----- */

function updateCoinDisplays(coins) {
  myCoins = coins;
  if (coinBalanceEl) coinBalanceEl.textContent = String(coins);
  if (myCoinLarge) myCoinLarge.textContent = String(coins);
}

async function grantStartingCoinsIfNeeded() {
  if (!username) return;
  try {
    await callEconomyApi("startingCoins");
  } catch (error) {
    console.warn("ゆうcoin初期付与エラー:", error?.economyCode || error);
  }
}

/* 追加ボーナス500コイン：初期コイン（coins）が付いたあと、まだ受け取っていなければ1回だけ加算する。
   トランザクションの中で bonus500Granted を確かめてから加算するので、
   再読み込み・再ログイン・複数端末から同時に開いても二重には加算されない。
   （ブラウザで受け取れなかった人の分は、ゆうダービー自動開催（derby-runner）でも同じ条件で配布する） */
let bonusGrantInFlight = false;

async function grantBonusCoinsIfNeeded() {
  if (!username || bonusGrantInFlight) return;
  bonusGrantInFlight = true;
  try {
    await callEconomyApi("bonus500");
  } catch (error) {
    console.warn("ゆうcoin追加ボーナスの付与に失敗:", error?.economyCode || error);
  } finally {
    bonusGrantInFlight = false;
  }
}

/* 自分の users ドキュメントの最新の内容（listenMyCoins で受け取る。ランキングの自分の行に使う） */
let myLatestUserData = null;

function listenMyCoins() {
  if (unsubscribeMyCoins) { unsubscribeMyCoins(); unsubscribeMyCoins = null; }
  myLatestUserData = null;
  resetLoginBonusState();
  if (!username) return;

  unsubscribeMyCoins = onSnapshot(
    doc(db, "users", username),
    async (snap) => {
      if (!snap.exists()) {
        /* 使っていた名前のデータが消えた：管理者に名前を変えられた可能性があるので、uid で自分のデータを探し直す */
        if (myLatestUserData) checkRenamedByAdmin();
        return;
      }
      const data = snap.data();
      if (typeof data.coins !== "number") {
        await grantStartingCoinsIfNeeded();
        return;
      }
      myLatestUserData = { ...data, docId: snap.id };
      updateCoinDisplays(data.coins);
      /* ログインボーナス（1日1回）は、追加ボーナスを受け取ったあとに行う（同じドキュメントへのトランザクションが重なって
         やり直しになり、読み書きが増えないように）。「💰 ゆう経済」の表示も、この購読で受け取った内容を使う（新しい読み取りは無い） */
      if (data.bonus500Granted !== true) grantBonusCoinsIfNeeded();
      else grantLoginBonusIfNeeded(data);
      if (isEconomyViewActive()) renderEconomyView();
      updateAnnouncementUnreadMark();
    },
    (error) => console.error("コイン監視エラー:", error)
  );
}

/* ----- オッズ（賭けられている金額から計算） ----- */

function computeWinOdds(horseNumber) {
  /* ユーザーがまだ少ない今は、馬の能力(power)に応じた「仮想の種銭」を
     あらかじめ敷いておく（強い馬ほど種銭が多い＝オッズが低い）。
     これを初期値として、実際の投票が増えるほどその影響は相対的に小さくなり、
     本物の人気投票（実際の賭け金）が支配的になっていく。 */
  const horse = SAFE_RACE_HORSES.find((h) => h.number === horseNumber);
  if (!horse) return null;

  const totalPower = SAFE_RACE_HORSES.reduce((a, h) => a + h.power, 0);
  const virtualOnHorse = (horse.power / totalPower) * ODDS_VIRTUAL_SEED_TOTAL;

  const realTotal = Object.values(currentWinPool).reduce((a, b) => a + b, 0);
  const totalPool = ODDS_VIRTUAL_SEED_TOTAL + realTotal;
  const onHorse = virtualOnHorse + (currentWinPool[horseNumber] || 0);

  if (totalPool <= 0 || onHorse <= 0) return null;
  return Math.max(1.1, (totalPool * RACE_TAKEOUT_RATE) / onHorse);
}

function listenWinBets(raceId) {
  if (unsubscribeWinBets) { unsubscribeWinBets(); unsubscribeWinBets = null; }

  unsubscribeWinBets = onSnapshot(
    query(collection(db, "raceBets"), where("raceId", "==", raceId), where("type", "==", "win")),
    (snapshot) => {
      const pool = {};
      snapshot.forEach((item) => {
        const bet = item.data();
        const horse = bet.horses?.[0];
        if (!horse) return;
        pool[horse] = (pool[horse] || 0) + Number(bet.amount || 0);
      });
      currentWinPool = pool;
      renderOdds();
    },
    (error) => console.error("オッズ監視エラー:", error)
  );
}

/* 投票先のレースが固定オッズ方式なら、そのレースのオッズ表（投票では変わらない） */
function getActiveFixedOddsTable() {
  const raceId = getActiveBettingRaceContext()?.raceId;
  return raceId && isFixedOddsRace(raceId) ? getRaceOddsTable(raceId) : null;
}

function renderOdds() {
  const fixedTable = getActiveFixedOddsTable();
  if (oddsList && fixedTable) {
    oddsList.innerHTML = "";
    SAFE_RACE_HORSES.forEach((horse) => {
      const item = document.createElement("div");
      item.className = "odds-item";
      item.innerHTML = `<strong>${horse.number} ${escapeHTML(horse.name)}</strong><span>${formatOddsTenths(fixedTable.win[horse.number])}倍</span>`;
      oddsList.appendChild(item);
    });
  } else if (oddsList) {
    oddsList.innerHTML = "";
    SAFE_RACE_HORSES.forEach((horse) => {
      const odds = computeWinOdds(horse.number);
      const item = document.createElement("div");
      item.className = "odds-item";
      item.innerHTML = `<strong>${horse.number} ${escapeHTML(horse.name)}</strong><span>${odds ? odds.toFixed(1) + "倍" : "---"}</span>`;
      oddsList.appendChild(item);
    });
  }
  renderHorseList();
}

function renderHorseList() {
  if (!horseList) return;

  /* 固定オッズ方式：人気順・オッズはレースごとに決まった値（投票では変わらない） */
  const fixedTable = getActiveFixedOddsTable();
  if (fixedTable) {
    horseList.innerHTML = "";
    [...SAFE_RACE_HORSES].sort((a, b) => fixedTable.popRank[a.number] - fixedTable.popRank[b.number]).forEach((horse) => {
      const item = document.createElement("div");
      item.className = "horse-card";
      item.innerHTML = `
      <strong>${horse.number}番　${escapeHTML(horse.name)}</strong>
      <span>${escapeHTML(horse.character)}（${escapeHTML(RACE_STYLE_LABELS[horse.style] || "")}）</span>
      <div style="margin-top:6px; font-size:11px; color:#777;">
        ${fixedTable.popRank[horse.number]}番人気　単勝 ${formatOddsTenths(fixedTable.win[horse.number])}倍　複勝 ${formatOddsTenths(fixedTable.place[horse.number])}倍
      </div>`;
      horseList.appendChild(item);
    });
    return;
  }

  const withPopularity = SAFE_RACE_HORSES
    .map((h) => ({ ...h, pool: currentWinPool[h.number] || 0 }))
    .sort((a, b) => b.pool - a.pool);

  horseList.innerHTML = "";
  withPopularity.forEach((horse, index) => {
    const odds = computeWinOdds(horse.number);
    const item = document.createElement("div");
    item.className = "horse-card";
    item.innerHTML = `
      <strong>${horse.number}番　${escapeHTML(horse.name)}</strong>
      <span>${escapeHTML(horse.character)}（${escapeHTML(RACE_STYLE_LABELS[horse.style] || "")}）</span>
      <div style="margin-top:6px; font-size:11px; color:#777;">
        人気 ${horse.pool > 0 ? index + 1 : "-"}位　オッズ ${odds ? odds.toFixed(1) + "倍" : "未定"}
      </div>`;
    horseList.appendChild(item);
  });
}

/* ----- 投票フォームの有効/無効 ----- */

function updateBetFormEnabled() {
  /* 毎日11:30・15:02に開催される仕組み上、締切(11:20・14:52)を過ぎた瞬間から
     投票対象が自動的に「次の日のレース」に切り替わるため、
     ログインさえしていれば常に投票できる（投票自体が止まることはない） */
  /* 前回レースのリプレイを見ている間は投票を受け付けない（リプレイ終了で元に戻る） */
  const canBet = Boolean(currentUser && username) && !derbyReplay;
  if (betType) betType.disabled = !canBet;
  if (betHorsesPicker) betHorsesPicker.classList.toggle("disabled", !canBet);
  if (betAmount) betAmount.disabled = !canBet;
  if (betButton) {
    betButton.disabled = !canBet;
    betButton.textContent = derbyReplay ? "📼 リプレイ中は投票できません" : "🪙 投票する";
  }
}

/* ----- 馬番号タップ選択 ----- */

function getBetTypeHint(type, count) {
  const need = BET_TYPE_COUNT[type] || 1;
  if (type === "trifecta") {
    const labels = ["1着", "2着", "3着"];
    if (count >= need) return "選択完了。もう一度タップすると選び直せます。";
    return `${labels[count]}を選んでください。`;
  }
  if (need === 1) return "1頭選んでください。";
  return `${need}頭選んでください（順番は関係ありません）。`;
}

/* 選んでいる馬券が的中した場合、いくら返ってくるかの「目安」を計算する。
   単勝はその馬の実際のオッズから正確に計算できるが、
   複勝・馬連・三連複・三連単は最終的な払戻がレース締切時点の全員の投票額で決まるため、
   ここではオッズを組み合わせた概算値を「目安」として示す（実際の払戻とは異なる場合がある）。 */
function estimateBetPayout(type, horses, amount) {
  if (!horses || horses.length === 0 || !amount) return null;

  const oddsOf = (n) => computeWinOdds(n) || 8;

  if (type === "win") return amount * oddsOf(horses[0]);
  if (type === "place") return amount * Math.max(1.1, oddsOf(horses[0]) * 0.35);

  if (type === "quinella") {
    const combined = (oddsOf(horses[0]) * oddsOf(horses[1])) / 4.5;
    return amount * Math.max(1.5, combined);
  }

  if (type === "trio") {
    const combined = horses.reduce((acc, n) => acc * oddsOf(n), 1) / 20;
    return amount * Math.max(2, combined);
  }

  if (type === "trifecta") {
    const combined = horses.reduce((acc, n) => acc * oddsOf(n), 1) / 8;
    return amount * Math.max(3, combined);
  }

  return null;
}

function renderBetHorsesSelectionText() {
  if (!betHorsesSelection) return;
  const type = betType?.value || "win";
  const need = BET_TYPE_COUNT[type] || 1;

  if (selectedBetHorses.length === 0) {
    betHorsesSelection.innerHTML = "";
    return;
  }

  let html = "";
  if (type === "trifecta") {
    const labels = ["1着", "2着", "3着"];
    html = selectedBetHorses
      .map((num, i) => `<div>${escapeHTML(labels[i] || "")}：${num}番 ${escapeHTML(getHorseName(num))}</div>`)
      .join("");
  } else {
    const text = selectedBetHorses.map((num) => `${num}番 ${getHorseName(num)}`).join("・");
    html = `<div>選択中：${escapeHTML(text)}</div>`;
  }

  if (selectedBetHorses.length === need) {
    const amount = Number(betAmount?.value || 0);
    const fixedTable = getActiveFixedOddsTable();
    const fixedTenths = fixedTable ? getTicketOddsTenths(fixedTable, type, selectedBetHorses) : null;
    if (fixedTenths !== null) {
      /* 固定オッズ方式：表示するオッズと払戻額は、実際の精算とまったく同じ計算 */
      html += `<div class="bet-payout-estimate">🎯 確定オッズ ${formatOddsTenths(fixedTenths)}倍${amount > 0 ? `　的中時の払戻：${computeFixedPayout(amount, fixedTenths).toLocaleString()} コイン` : ""}</div>`;
    } else if (amount > 0) {
      const estimate = estimateBetPayout(type, selectedBetHorses, amount);
      if (estimate) {
        html += `<div class="bet-payout-estimate">🎯 的中した場合の予想払戻：約 ${Math.floor(estimate).toLocaleString()} コイン（目安）</div>`;
      }
    }
  }

  betHorsesSelection.innerHTML = html;
}

betAmount?.addEventListener("input", renderBetHorsesSelectionText);

function renderBetHorsesPicker() {
  if (!betHorsesPicker) return;

  const type = betType?.value || "win";
  const need = BET_TYPE_COUNT[type] || 1;

  betHorsesPicker.innerHTML = "";

  SAFE_RACE_HORSES.forEach((horse) => {
    const selectedIndex = selectedBetHorses.indexOf(horse.number);
    const isSelected = selectedIndex !== -1;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "bet-horse-button";
    if (isSelected) btn.classList.add("selected");
    if (!isSelected && selectedBetHorses.length >= need) btn.classList.add("disabled-choice");

    let orderBadge = "";
    if (isSelected && type === "trifecta") {
      const labels = ["1着", "2着", "3着"];
      orderBadge = `<span class="bet-horse-order">${escapeHTML(labels[selectedIndex] || "")}</span>`;
    }

    btn.innerHTML = `${orderBadge}<span class="bet-horse-number">${horse.number}</span><span class="bet-horse-name">${escapeHTML(horse.name)}</span>`;
    btn.addEventListener("click", () => toggleBetHorseSelection(horse.number));
    betHorsesPicker.appendChild(btn);
  });

  if (betHorsesHint) betHorsesHint.textContent = getBetTypeHint(type, selectedBetHorses.length);
  renderBetHorsesSelectionText();
}

function toggleBetHorseSelection(number) {
  const type = betType?.value || "win";
  const need = BET_TYPE_COUNT[type] || 1;
  const index = selectedBetHorses.indexOf(number);

  if (index !== -1) {
    selectedBetHorses.splice(index, 1);
  } else {
    if (selectedBetHorses.length >= need) return;
    selectedBetHorses.push(number);
  }
  renderBetHorsesPicker();
}

function resetBetHorsesSelection() {
  selectedBetHorses = [];
  renderBetHorsesPicker();
}

betType?.addEventListener("change", resetBetHorsesSelection);

betButton?.addEventListener("click", async () => {
  if (!currentUser || !username) return alert("ログインしてください。");
  if (derbyReplay) return alert("リプレイ中は投票できません。リプレイを終了してから投票してください。");

  const type = betType?.value || "win";
  const amount = Number(betAmount?.value || 0);
  const need = BET_TYPE_COUNT[type] || 1;

  if (selectedBetHorses.length !== need) {
    return alert(`${getBetTypeName(type)}は馬を${need}頭選んでください。`);
  }
  if (!Number.isInteger(amount) || amount < 10) {
    return alert("投票額は10ゆうcoin以上で入力してください。");
  }
  if (amount > myCoins) {
    return alert(`ゆうcoinが足りません。${myCoins <= BANK_LOAN_MAX_COINS ? `\n「💰 ゆう経済」の緊急融資（${BANK_LOAN_AMOUNT}コイン）を利用できます。` : ""}`);
  }

  const horses = [...selectedBetHorses];

  try {
    betButton.disabled = true;
    const raceId = getActiveBettingRaceContext().raceId;

    /* 馬券の購入は Worker に頼む（残高・締切・オッズ・手動レースの受付をサーバーで確かめる）。
       コインの引き落とし・累計賭け金・馬券の作成（・手動レースの betCount）はサーバーが1回で行う */
    await callEconomyApi("placeBet", { raceId, type, horses, amount });

    alert("投票しました！");
    resetBetHorsesSelection();
  } catch (error) {
    const code = error?.economyCode || error?.message;
    console.error("投票エラー:", code, error);
    if (code === "NOT_ENOUGH_COINS") alert("ゆうcoinが足りません。");
    else if (code === "MANUAL_RACE_CANCELLED") alert("このレースはキャンセルされました。");
    else if (code === "MANUAL_RACE_CLOSED" || code === "RACE_CLOSED") alert("このレースは投票を受け付けていません（締切・発走済みなど）。");
    else if (code === "invalid_horses" || code === "invalid_bet_type" || code === "invalid_amount") alert("投票の内容が正しくありません。");
    else if (code === "NETWORK") alert("サーバーに接続できませんでした。時間をおいてもう一度お試しください。");
    else alert("投票に失敗しました。");
  } finally {
    updateBetFormEnabled();
  }
});


/* ----- 結果判定・払い戻し（パリミュチュエル方式） ----- */

function evaluateBetWin(bet, resultOrder) {
  const top1 = resultOrder[0], top2 = resultOrder[1], top3 = resultOrder[2];
  const top3set = [top1, top2, top3];
  const horses = bet.horses || [];

  if (bet.type === "win") return horses[0] === top1;
  if (bet.type === "place") return top3set.includes(horses[0]);

  if (bet.type === "quinella") {
    if (horses.length !== 2) return false;
    const a = [...horses].sort((x, y) => x - y);
    const b = [top1, top2].sort((x, y) => x - y);
    return a[0] === b[0] && a[1] === b[1];
  }

  if (bet.type === "trio") {
    if (horses.length !== 3) return false;
    const a = [...horses].sort((x, y) => x - y);
    const b = [...top3set].sort((x, y) => x - y);
    return a.every((n, i) => n === b[i]);
  }

  if (bet.type === "trifecta") {
    return horses.length === 3 && horses[0] === top1 && horses[1] === top2 && horses[2] === top3;
  }

  return false;
}

async function computePoolPayout(raceId, bet, resultOrder) {
  const snap = await getDocs(query(collection(db, "raceBets"), where("raceId", "==", raceId), where("type", "==", bet.type)));

  let totalPool = 0;
  let totalWinningStake = 0;

  snap.forEach((d) => {
    const data = d.data();
    const amount = Number(data.amount || 0);
    totalPool += amount;
    if (evaluateBetWin(data, resultOrder)) totalWinningStake += amount;
  });

  if (totalWinningStake <= 0) return 0;
  return Math.floor((Number(bet.amount || 0) / totalWinningStake) * totalPool * RACE_TAKEOUT_RATE);
}

function showRaceHitAnimation(bet, payout) {
  const el = document.createElement("div");
  el.className = "notification";
  const title = document.createElement("div");
  title.className = "notification-title";
  title.textContent = "🎯 的中！";
  const body = document.createElement("div");
  body.className = "notification-body";
  body.textContent = `${getBetTypeName(bet.type)}　+${payout} ゆうcoin`;
  el.append(title, body);
  document.body.appendChild(el);

  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 300);
  }, 4500);
}

async function settleMyBets(raceId) {
  const session = appSessionSeq;
  if (!currentUser || !username) return;

  /* 精算（結果の確認・払い戻しの計算・コインの加算）はすべて Worker に任せる（固定オッズも山分け方式も）。
     ブラウザは払い戻し額を自分で決めない・馬券やコインを直接書き換えない。
     結果を待っている自分の馬券があるときだけ頼む（毎回は呼ばない） */
  try {
    const pendingSnap = await getDocs(query(
      collection(db, "raceBets"),
      where("raceId", "==", raceId),
      where("uid", "==", currentUser.uid),
      where("settled", "==", false)
    ));
    if (pendingSnap.empty || session !== appSessionSeq) return;
    const result = await callEconomyApi("settleMyBets", { raceId });
    if (session !== appSessionSeq) return;
    (result?.settled || []).forEach((b) => { if (b.win && b.payout > 0) showRaceHitAnimationWhenRevealed(raceId, b, b.payout); });
    loadMyPageStats();
  } catch (error) {
    if (isInterruptedBySignOut(session)) return;
    /* まだ結果が無い（no_result）などはよくあることなので、警告だけにとどめる */
    console.warn("ベット精算（Worker）エラー:", error?.economyCode || error);
  }
}

/* 【重要】サイトを閉じていて、レースが行われたのを見ていなくても、
   次にログインしたときに「まだ精算されていない自分の馬券」をすべて確認し、
   ・レース結果がまだ無ければ（発走時刻を過ぎていれば）今すぐ生成
   ・結果があれば、その場で精算
   を行う。これにより、何日 log-inしなくても、賭けた結果は必ず反映される。 */
async function catchUpMissedRaces(attempt = 1) {
  if (!currentUser || !username) return;
  /* 途中でログアウト・別のアカウントに切り替わったら、そこでやめる（ログアウト後に読みに行かない） */
  const uid = currentUser.uid;
  const session = appSessionSeq;
  const isSameUser = () => currentUser?.uid === uid;

  try {
    const pendingSnap = await getDocs(query(
      collection(db, "raceBets"),
      where("uid", "==", uid),
      where("settled", "==", false)
    ));
    if (pendingSnap.empty) return;

    const raceIds = [...new Set(pendingSnap.docs.map((d) => d.data().raceId))];

    for (const raceId of raceIds) {
      if (!isSameUser()) return;
      const raceRef = doc(db, "races", raceId);
      let raceSnap = await getDoc(raceRef);

      if (!raceSnap.exists()) {
        const scheduledTime = parseRaceIdToDate(raceId);
        if (derbyNow() >= scheduledTime) {
          await tryGenerateRaceResult(raceId);
          raceSnap = await getDoc(raceRef);
        }
      }

      if (raceSnap.exists() && raceSnap.data().status === "finished") {
        await settleMyBets(raceId);
      }
    }
  } catch (error) {
    if (!isSameUser() || isInterruptedBySignOut(session)) return; /* ログアウト・切り替えの途中で失敗しただけ */
    /* ログイン直後は認証の受け渡しが間に合わず拒否されることがあるので、同じユーザーのまま1回だけやり直す */
    if (error?.code === "permission-denied" && attempt === 1) {
      setTimeout(() => { if (isSameUser()) catchUpMissedRaces(2); }, 3000);
      return;
    }
    console.error("未精算レースの確認エラー:", error);
  }
}

/* ----- 自分の投票（すべてのレース分）を一括管理。
   ここから「購入した馬券」「コイン増減」「自分の馬ハイライト」などを組み立てる ----- */

/* =========================================================
   自分の馬券（ゆうダービー）
   ・以前は自分の馬券を全件（過去すべて）購読していた。今は次の2つだけを購読する
       ① 最近のレース（今日から7日前まで・明日の自動開催の回・読み込み済みの手動レース）の自分の馬券
          （where uid ＋ where raceId in [...]。等号と in だけなので複合インデックスは不要）
       ② 未精算の自分の馬券（where uid ＋ where settled == false）… 古いレースの未精算も取りこぼさない
   ・購読するレースの範囲は、日付が変わった・手動レースが増えたときに作り直す（refreshMyBetHistoryWindow）
   ・それより前の履歴は「過去の投票履歴をすべて読み込む」を押したときだけ1回読む
   ・問い合わせが失敗したときは、以前と同じ全件の購読に切り替える
   ・精算（settleMyBets・catchUpMissedRaces）は今まで通り Firestore を直接確かめるので、この範囲に関係なく取りこぼさない
========================================================= */

const BET_HISTORY_RECENT_DAYS = 7;
const BET_HISTORY_MAX_RACES = 30; /* Firestore の in に渡せる数の上限 */
let betHistoryParts = { recent: new Map(), unsettled: new Map(), older: new Map() };
let betHistoryWindowKey = "";
let betHistoryFullLoaded = false;
let betHistoryFallback = false;
/* 最近の分・未精算の購読がエラーで止まった理由（空なら正常）。止まっても全件には切り替えず、最後に受け取ったデータのまま表示する */
let betHistoryErrorCode = "";
let myPageStatsShownForUid = "";

/* 全件の読み込みに切り替えてよいのは「その問い合わせの形が使えない」ときだけ（必要最小限）。
   failed-precondition：複合インデックスが無い・作成中（全件の問い合わせは単一項目のインデックスで動く）
   unimplemented     ：集計（count・sum）が使えない
   それ以外（resource-exhausted＝無料枠の超過・permission-denied・unauthenticated・unavailable などの通信エラー・internal など）は
   全件に切り替えても同じ理由で失敗するか、読み取りが増えるだけなので切り替えない */
const BET_QUERY_FALLBACK_CODES = new Set(["failed-precondition"]);
const BET_STATS_FALLBACK_CODES = new Set(["failed-precondition", "unimplemented"]);

function getRecentBetRaceIds() {
  const now = derbyNow();
  const ids = new Set();
  for (let d = -1; d < BET_HISTORY_RECENT_DAYS; d++) {
    const dayId = formatRaceId(new Date(now.getTime() - d * DAY_MS));
    getRaceContextsForDay(dayId).forEach((c) => ids.add(c.raceId));
  }
  /* 新しいレースを優先して、上限までにする */
  return [...ids].sort().reverse().slice(0, BET_HISTORY_MAX_RACES);
}

function rebuildMyAllBets() {
  const merged = new Map();
  [betHistoryParts.older, betHistoryParts.recent, betHistoryParts.unsettled].forEach((part) => part.forEach((bet, id) => merged.set(id, bet)));
  myAllBets = [...merged.values()].sort((a, b) => {
    const at = a.createdAt?.toMillis ? a.createdAt.toMillis() : 0;
    const bt = b.createdAt?.toMillis ? b.createdAt.toMillis() : 0;
    return bt - at;
  });
  renderBetHistory(myAllBets);
  renderMyActiveTickets();
}

function stopMyBetHistory() {
  if (unsubscribeMyBetHistory) { unsubscribeMyBetHistory(); unsubscribeMyBetHistory = null; }
}

function listenMyBetHistory() {
  stopMyBetHistory();
  betHistoryParts = { recent: new Map(), unsettled: new Map(), older: new Map() };
  betHistoryWindowKey = "";
  betHistoryFullLoaded = false;
  betHistoryFallback = false;
  betHistoryErrorCode = "";
  if (!currentUser) return;
  subscribeMyBetHistoryWindow();
}

function subscribeMyBetHistoryWindow() {
  if (!currentUser) return;
  stopMyBetHistory();
  const uid = currentUser.uid;
  const raceIds = getRecentBetRaceIds();
  betHistoryWindowKey = raceIds.join(",");
  betHistoryErrorCode = "";
  const toBets = (snap) => new Map(snap.docs.map((d) => [d.id, { id: d.id, ...d.data() }]));
  /* 2つの購読は別々に扱う。片方が止まっても、もう片方の購読と、止まった方が最後に受け取ったデータはそのまま残す */
  let stopThis = null;
  const onError = (error) => {
    if (currentUser?.uid !== uid || unsubscribeMyBetHistory !== stopThis) return;
    const code = error?.code || "unknown";
    if (BET_QUERY_FALLBACK_CODES.has(code)) {
      console.warn("馬券の購読（最近の分）に必要なインデックスが無いため、全件の購読に切り替えます:", code);
      listenMyBetHistoryUnlimited();
      return;
    }
    console.warn("馬券の購読が止まりました（全件には切り替えません。マイページを開くか、レースの範囲が変わったときに作り直します）:", code);
    betHistoryErrorCode = code;
    rebuildMyAllBets();
  };

  const unsubscribers = [
    onSnapshot(query(collection(db, "raceBets"), where("uid", "==", uid), where("raceId", "in", raceIds)), (snap) => {
      betHistoryParts.recent = toBets(snap);
      rebuildMyAllBets();
    }, onError),
    onSnapshot(query(collection(db, "raceBets"), where("uid", "==", uid), where("settled", "==", false)), (snap) => {
      betHistoryParts.unsettled = toBets(snap);
      rebuildMyAllBets();
    }, onError)
  ];
  stopThis = () => unsubscribers.forEach((u) => u());
  unsubscribeMyBetHistory = stopThis;
}

/* 日付が変わった・手動レースが増えたなど、購読するレースの範囲が変わったときだけ作り直す。
   retryAfterError：購読がエラーで止まっていたら作り直す（マイページを開いたときだけ渡す。
   手動レースの更新などのたびに作り直すと、無料枠の超過中に何度も試すことになるので、ほかのきっかけでは作り直さない） */
function refreshMyBetHistoryWindow({ retryAfterError = false } = {}) {
  if (!currentUser || betHistoryFallback || !unsubscribeMyBetHistory) return;
  if ((retryAfterError && betHistoryErrorCode) || getRecentBetRaceIds().join(",") !== betHistoryWindowKey) subscribeMyBetHistoryWindow();
}

/* 以前と同じ方式（自分の馬券を全件購読）。問い合わせが失敗したときだけ使う */
function listenMyBetHistoryUnlimited() {
  stopMyBetHistory();
  betHistoryFallback = true;
  betHistoryFullLoaded = true;
  betHistoryErrorCode = "";
  if (!currentUser) return;
  unsubscribeMyBetHistory = onSnapshot(
    query(collection(db, "raceBets"), where("uid", "==", currentUser.uid)),
    (snap) => {
      betHistoryParts = { recent: new Map(snap.docs.map((d) => [d.id, { id: d.id, ...d.data() }])), unsettled: new Map(), older: new Map() };
      rebuildMyAllBets();
    },
    (error) => console.error("投票履歴監視エラー:", error)
  );
}

/* 「過去の投票履歴をすべて読み込む」：それより前の履歴を1回だけ読む */
async function loadOlderBetHistory() {
  if (!currentUser || betHistoryFullLoaded) return;
  betHistoryFullLoaded = true;
  try {
    const snap = await getDocs(query(collection(db, "raceBets"), where("uid", "==", currentUser.uid)));
    betHistoryParts.older = new Map(snap.docs.map((d) => [d.id, { id: d.id, ...d.data() }]));
    rebuildMyAllBets();
  } catch (error) {
    betHistoryFullLoaded = false;
    console.error("過去の投票履歴の読み込みエラー:", error);
    alert("過去の投票履歴を読み込めませんでした。");
  }
}

function getMyBetsForRace(raceId) {
  return myAllBets.filter((b) => b.raceId === raceId);
}

function getMyBetHorseNumbersForRace(raceId) {
  const set = new Set();
  getMyBetsForRace(raceId).forEach((b) => (b.horses || []).forEach((h) => set.add(h)));
  return [...set];
}

function formatBetHorsesForTicket(bet) {
  const names = (bet.horses || []).map((n) => `${n}番 ${getHorseName(n)}`);
  return names.join(bet.type === "trifecta" ? " → " : "－");
}

/* 【① 購入した馬券】次のレースに賭けた内容を、発走前ならいつでも確認できるように表示 */
/* 固定オッズ方式の馬券のオッズ（レースIDから計算。山分け方式のレースは null） */
function getFixedTicketOddsTenths(bet) {
  if (!bet?.raceId || !isFixedOddsRace(bet.raceId)) return null;
  return getTicketOddsTenths(getRaceOddsTable(bet.raceId), bet.type, bet.horses);
}

function renderMyActiveTickets() {
  const el = document.getElementById("raceMyTickets");
  if (!el) return;

  const raceId = getActiveBettingRaceContext().raceId;
  const tickets = getMyBetsForRace(raceId);

  if (tickets.length === 0) {
    el.innerHTML = `
      <div class="race-tickets-title">🎫 購入した馬券</div>
      <div class="empty-state">まだこのレースには投票していません</div>`;
    return;
  }

  let total = 0;
  let html = `<div class="race-tickets-title">🎫 購入した馬券</div>`;
  tickets.forEach((bet) => {
    total += Number(bet.amount || 0);
    const tenths = getFixedTicketOddsTenths(bet);
    html += `
      <div class="race-ticket-item">
        <span class="race-ticket-type">${escapeHTML(getBetTypeName(bet.type))}</span>
        <span class="race-ticket-horses">${escapeHTML(formatBetHorsesForTicket(bet))}</span>
        <span class="race-ticket-amount">${Number(bet.amount || 0).toLocaleString()}コイン</span>
        ${tenths !== null ? `<span class="race-ticket-odds">${formatOddsTenths(tenths)}倍・的中で${computeFixedPayout(bet.amount, tenths).toLocaleString()}コイン</span>` : ""}
      </div>`;
  });
  html += `<div class="race-tickets-total">合計投票額：${total.toLocaleString()}コイン</div>`;
  el.innerHTML = html;
}

/* 【② レース終了後のコイン増減】投票額→払戻→増減→現在の所持コイン、の順で表示 */
function renderMyRaceResultSummary(raceId) {
  const el = document.getElementById("raceMyResult");
  if (!el) return;

  const bets = getMyBetsForRace(raceId);
  if (bets.length === 0) { el.innerHTML = ""; return; }

  const allSettled = bets.every((b) => b.settled);
  if (!allSettled) {
    el.innerHTML = `<div class="race-my-result-pending">あなたの馬券を精算中です…</div>`;
    return;
  }

  const totalBet = bets.reduce((a, b) => a + Number(b.amount || 0), 0);
  const totalPayout = bets.reduce((a, b) => a + Number(b.payout || 0), 0);
  const net = totalPayout - totalBet;

  el.innerHTML = `
    <div class="race-my-result ${net >= 0 ? "win" : "lose"}">
      <div class="race-my-result-title">【今回のレース結果】</div>
      <div class="race-my-result-row"><span>投票額</span><span>${totalBet.toLocaleString()}コイン</span></div>
      <div class="race-my-result-row"><span>払戻</span><span>${totalPayout.toLocaleString()}コイン</span></div>
      <div class="race-my-result-row net"><span>今回の増減</span><span>${net >= 0 ? "＋" : "－"}${Math.abs(net).toLocaleString()}コイン</span></div>
      <div class="race-my-result-row balance"><span>現在の所持コイン</span><span>${myCoins.toLocaleString()}コイン</span></div>
    </div>`;
}

function renderBetHistory(bets) {
  if (!historyEl) return;
  historyEl.innerHTML = "";

  if (betHistoryErrorCode) {
    /* 止まった購読がある：手元の履歴が最新とは限らないことを知らせる（「投票はありません」とは言わない） */
    const notice = document.createElement("div");
    notice.className = "empty-state history-error";
    notice.textContent = "最新の投票履歴を読み込めませんでした。しばらくしてからマイページを開き直してください。";
    historyEl.appendChild(notice);
  } else if (bets.length === 0) {
    historyEl.innerHTML = betHistoryFullLoaded
      ? `<div class="empty-state">まだ投票履歴がありません</div>`
      : `<div class="empty-state">最近（7日以内）の投票はありません</div>`;
  }

  bets.slice(0, 30).forEach((bet) => {
    const horsesText = formatBetHorsesForTicket(bet);

    let resultText = "結果待ち";
    if (bet.settled) resultText = bet.win ? `的中！ +${bet.payout || 0}coin` : "不的中";
    const tenths = getFixedTicketOddsTenths(bet);
    if (tenths !== null) resultText = `${formatOddsTenths(tenths)}倍　${resultText}`;

    const item = document.createElement("div");
    item.className = "history-item";
    item.innerHTML = `
      <div><strong>${escapeHTML(getBetTypeName(bet.type))}</strong>　${escapeHTML(horsesText)}　${bet.amount}coin</div>
      <div style="font-size:11px; color:#888; margin-top:3px;">${escapeHTML(bet.raceId)}　${escapeHTML(resultText)}</div>`;
    historyEl.appendChild(item);
  });

  if (!betHistoryFullLoaded) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "secondary history-more";
    more.textContent = "過去の投票履歴をすべて読み込む";
    more.addEventListener("click", () => loadOlderBetHistory());
    historyEl.appendChild(more);
  }
}


/* ----- レース結果の抽選（発走時刻になった最初のクライアントが実行） ----- */

const RACE_DURATION_SECONDS = 60;
const RACE_SEGMENTS = 48;

function generateWeightedRaceOrder() {
  const withKey = SAFE_RACE_HORSES.map((h) => {
    const effectivePower = Math.max(0.1, h.power * (0.4 + Math.random() * 1.3));
    const key = Math.pow(Math.random(), 1 / effectivePower);
    return { number: h.number, key };
  });
  withKey.sort((a, b) => b.key - a.key);
  return withKey.map((h) => h.number);
}

/* 脚質ごとに「レースのどのタイミングで伸びるか」の形を変える。
   （順位を決めるのではなく、あくまで“進み方”だけを変えるので、
    能力の高い馬が必ず勝つわけではない） */
function getStyleCurveMultiplier(style, frac) {
  switch (style) {
    case "start": return frac < 0.3 ? 1.5 : (frac < 0.7 ? 1.0 : 0.7);
    case "front": return frac < 0.5 ? 1.25 : 0.9;
    case "mid": return frac < 0.3 ? 0.8 : (frac < 0.75 ? 1.2 : 1.1);
    case "closer": return frac < 0.6 ? 0.65 : 1.6;
    case "stamina": return 1.0;
    case "longshot": return 0.5 + Math.random() * 1.3;
    default: return 1.0;
  }
}

/* 最終着順(resultOrder)と矛盾しないように、各馬の「経過時間ごとの進み具合」をあらかじめ作っておく。
   これをレース結果と一緒にFirestoreへ保存することで、あとから見るどの端末でも
   まったく同じレース展開を再現できる（サーバーを使わずに演出を同期させるための仕組み）。 */
function buildRaceCheckpoints(resultOrder) {
  const gapStep = 0.015 + Math.random() * 0.025;
  const finalProgress = {};

  resultOrder.forEach((horseNumber, rankIndex) => {
    finalProgress[horseNumber] = Math.max(0.7, 1 - rankIndex * gapStep);
  });
  finalProgress[resultOrder[0]] = 1;

  const rawWeights = {};
  SAFE_RACE_HORSES.forEach((h) => {
    rawWeights[h.number] = Array.from({ length: RACE_SEGMENTS }, (_, s) => {
      const frac = s / RACE_SEGMENTS;
      return getStyleCurveMultiplier(h.style, frac) * (0.3 + Math.random());
    });
  });

  SAFE_RACE_HORSES.forEach((h) => {
    const total = rawWeights[h.number].reduce((a, b) => a + b, 0);
    const scale = finalProgress[h.number] / total;
    rawWeights[h.number] = rawWeights[h.number].map((w) => w * scale);
  });

  const cumulative = {};
  SAFE_RACE_HORSES.forEach((h) => { cumulative[h.number] = 0; });

  const checkpoints = [];
  for (let s = 0; s < RACE_SEGMENTS; s++) {
    const frame = {};
    SAFE_RACE_HORSES.forEach((h) => {
      cumulative[h.number] += rawWeights[h.number][s];
      frame[h.number] = Math.min(1, Number(cumulative[h.number].toFixed(4)));
    });
    checkpoints.push(frame);
  }

  return checkpoints;
}

/* 【⑥ 詳細結果】タイム・着差を、実況と矛盾しない自然な数値で作る */
function formatRaceTime(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

function getMarginLabel(gapSeconds) {
  if (gapSeconds < 0.05) return "ハナ";
  if (gapSeconds < 0.12) return "アタマ";
  if (gapSeconds < 0.2) return "クビ";
  if (gapSeconds < 0.35) return "1/2馬身";
  if (gapSeconds < 0.55) return "3/4馬身";
  if (gapSeconds < 0.8) return "1馬身";
  if (gapSeconds < 1.2) return "1馬身1/2";
  if (gapSeconds < 1.8) return "2馬身";
  return `${Math.round(gapSeconds / 0.8)}馬身`;
}

function buildFinishStats(resultOrder) {
  let currentSeconds = 116 + Math.random() * 10;
  const stats = [{ number: resultOrder[0], seconds: currentSeconds, gapSeconds: 0 }];

  for (let i = 1; i < resultOrder.length; i++) {
    const gapSeconds = 0.05 + Math.random() * 0.55;
    currentSeconds += gapSeconds;
    stats.push({ number: resultOrder[i], seconds: currentSeconds, gapSeconds });
  }

  return stats.map((s, index) => ({
    number: s.number,
    timeText: formatRaceTime(s.seconds),
    marginText: index === 0 ? "" : getMarginLabel(s.gapSeconds)
  }));
}

/* 開催ログ（管理用）：raceLogs/{raceId}。一般の画面には表示しない（Firebase Console で確認する）。
   GitHub Actions の自動開催（derby-runner）も同じドキュメントに記録する */
async function tryGenerateRaceResult(raceId) {
  /* 固定オッズ方式のレースの結果は Worker（サーバー）が作る。ブラウザは結果を書き込まない。
     発走時刻を過ぎていれば作り、まだ結果が無ければ作られる（二重には作らない） */
  if (isFixedOddsRace(raceId)) {
    try {
      await callEconomyApi("ensureRaceResult", { raceId });
    } catch (error) {
      if (error?.economyCode !== "race_not_started") console.warn("レース結果の生成（Worker）エラー:", error?.economyCode || error);
    }
    return;
  }

  /* 以前の山分け方式のレース（FIXED_ODDS_FROM より前）は、これまで通り（この分は derby-runner も作る） */
  const raceRef = doc(db, "races", raceId);
  const logRef = doc(db, "raceLogs", raceId);
  try {
    await runTransaction(db, async (transaction) => {
      const snap = await transaction.get(raceRef);
      if (snap.exists()) return;
      const resultOrder = generateWeightedRaceOrder();
      transaction.set(raceRef, {
        raceId, resultOrder,
        checkpoints: buildRaceCheckpoints(resultOrder),
        finishStats: buildFinishStats(resultOrder),
        status: "finished", generatedAt: serverTimestamp(), generatedBy: "client"
      });
      transaction.set(logRef, { raceId, scheduledAt: parseRaceIdToDate(raceId), resultGeneratedAt: serverTimestamp(), resultGeneratedBy: "client", resultStatus: "created" }, { merge: true });
    });
  } catch (error) {
    console.error(`[レース抽選エラー] raceId=${raceId} code=${error?.code || "(なし)"} message=${error?.message || error}`, error);
  }
}

/* ----- レース演出（derby-show.js）
   ・レース結果（races/{raceId} の resultOrder・checkpoints）を読んで、見せ方だけを作る。
   ・全馬が着順どおりにゴールするまで再生し、最後の馬のゴール後に「レース終了」→結果表示。
   ・結果・コイン・投票・払い戻し・Firestore には一切触れない（リプレイも同じ）。 ----- */

const RACE_PHASE_LABELS = {
  gate: "🚦 スタートゲート",
  start: "🏁 ゲートオープン！全馬スタート！",
  early: "序盤",
  mid: "🔄 中盤の攻防",
  late: "終盤",
  straight: "🔥 最終直線",
  finishing: "ゴール目前の競り合い！",
  goal: "🏁 続々とゴール！",
  finished: "🏆 全馬ゴール！",
  results: "📋 結果発表"
};

const REPLAY_LEAD_IN_SECONDS = 3;

let lastElapsedWasNegative = null;
let raceStage = null;
let raceStageLoopStarted = false;
let raceStageErrorLogged = false;
let raceStageSnapCamera = true;
let raceStartFlashRaceId = null;
let liveShowCache = { key: "", show: null };
let derbyReplay = null;
let recentRacesCache = [];
let revealedLiveRaceId = null;
const raceStageOverlayCache = {};

function buildShowForRace(raceId, raceData) {
  return buildRaceShow(raceData, { horses: SAFE_RACE_HORSES, raceId });
}

/* 今日（直近）のレースの演出。結果データが変わらない限り作り直さない */
function getLiveShow() {
  if (!liveRaceResult || !Array.isArray(liveRaceResult.resultOrder)) return null;
  const raceId = getLiveRaceContext().raceId;
  const key = `${raceId}:${liveRaceResult.resultOrder.join("-")}:${liveRaceResult.checkpoints ? liveRaceResult.checkpoints.length : 0}`;
  if (liveShowCache.key !== key) liveShowCache = { key, show: buildShowForRace(raceId, liveRaceResult) };
  return liveShowCache.show;
}

function getLiveElapsedSeconds(now = derbyNow()) {
  return (now.getTime() - getLiveRaceContext(now).raceTime.getTime()) / 1000;
}

/* 全馬がゴールして「レース終了」になったか（それまでは結果・的中表示を出さない） */
function isLiveRaceResultRevealed(now = derbyNow()) {
  if (!liveRaceResult) return false;
  const show = getLiveShow();
  return getLiveElapsedSeconds(now) >= (show ? show.revealTime : RACE_DURATION_SECONDS);
}

/* 的中の表示：レース演出が終わるまで待ってから出す（払い戻しの処理そのものは今までどおり） */
function showRaceHitAnimationWhenRevealed(raceId, bet, payout) {
  if (raceId !== getLiveRaceContext().raceId || isLiveRaceResultRevealed()) {
    showRaceHitAnimation(bet, payout);
    return;
  }
  const show = getLiveShow();
  const waitMs = ((show ? show.revealTime : RACE_DURATION_SECONDS) - getLiveElapsedSeconds()) * 1000;
  setTimeout(() => showRaceHitAnimation(bet, payout), Math.min(Math.max(0, waitMs), RACE_SHOW_MAX_SECONDS * 1000));
}

function triggerStartFlash() {
  if (!raceTrack) return;
  const flash = document.createElement("div");
  flash.className = "race-start-flash";
  flash.textContent = "🏁 ゲートオープン！";
  raceTrack.appendChild(flash);
  setTimeout(() => flash.remove(), 1500);
}

/* レース画面（Canvas）と字幕などの重ね表示を一度だけ作る */
function ensureRaceStage() {
  if (raceStage || !raceTrack) return;
  raceTrack.innerHTML = "";
  raceTrack.classList.add("race-stage");
  raceStage = createRaceStage(raceTrack, { horses: SAFE_RACE_HORSES });
  raceTrack.insertAdjacentHTML("beforeend", `
    <div id="raceStageBadge" class="race-stage-badge"></div>
    <div id="raceStageTop3" class="race-stage-top3"></div>
    <div id="raceSubtitle" class="race-subtitle hidden" aria-live="polite"></div>
    <div id="raceReplayEnd" class="race-replay-end hidden"></div>`);
  startRaceStageLoop();
}

function startRaceStageLoop() {
  if (raceStageLoopStarted) return;
  raceStageLoopStarted = true;
  const frame = () => {
    requestAnimationFrame(frame);
    try {
      drawRaceStageFrame();
    } catch (error) {
      if (!raceStageErrorLogged) {
        raceStageErrorLogged = true;
        console.error("レース演出エラー:", error);
      }
    }
  };
  requestAnimationFrame(frame);
}

function setStageOverlay(id, html, visible = true) {
  const el = document.getElementById(id);
  if (!el) return;
  const key = `${visible ? 1 : 0}|${html}`;
  if (raceStageOverlayCache[id] === key) return;
  raceStageOverlayCache[id] = key;
  el.innerHTML = html;
  el.classList.toggle("hidden", !visible || !html);
}

function renderStageTop3(show, t) {
  if (!show || t <= 0) return "";
  return show.standingsAt(t).slice(0, 3).map((s, i) => {
    const [bg, fg] = getHorseColors(s.number);
    return `<span class="race-stage-pos"><small>${i + 1}</small><b style="background:${bg};color:${fg}">${s.number}</b></span>`;
  }).join("");
}

/* 毎フレーム：今の場面を描き、字幕・表示を更新する（ライブとリプレイで同じ仕組み） */
function drawRaceStageFrame() {
  if (!raceStage || !derbyView || !derbyView.classList.contains("active") || document.hidden) return;

  if (derbyReplay) {
    const show = derbyReplay.show;
    const t = (performance.now() - derbyReplay.startedAt) / 1000 - REPLAY_LEAD_IN_SECONDS;
    raceStage.render({ show: t >= 0 ? show : null, t: Math.min(t, show.revealTime + 2), myHorses: getMyBetHorseNumbersForRace(derbyReplay.raceId), snapCamera: raceStageSnapCamera });
    raceStageSnapCamera = false;
    setStageOverlay("raceStageBadge", `📼 前回レース リプレイ（${escapeHTML(formatRaceLabel(derbyReplay.raceId))}）`);
    setStageOverlay("raceStageTop3", renderStageTop3(show, t), t > 0 && t < show.revealTime);
    const subtitle = t < 0 ? `まもなくスタート… ${Math.ceil(-t)}` : show.commentaryAt(t);
    setStageOverlay("raceSubtitle", escapeHTML(subtitle), !derbyReplay.ended);
    if (!derbyReplay.ended && t >= show.revealTime + 1) finishDerbyReplay();
    return;
  }

  const now = derbyNow();
  const liveContext = getLiveRaceContext(now);
  const elapsed = getLiveElapsedSeconds(now);
  const show = getLiveShow();
  const myHorses = getMyBetHorseNumbersForRace(liveContext.raceId);
  const next = getNextRaceStartContext(now);
  const secondsToNext = (next.raceTime.getTime() - now.getTime()) / 1000;
  const showOver = !show || elapsed >= show.revealTime;

  if (showOver && secondsToNext <= 90) {
    /* 次のレースの発走直前：全馬ゲートに並ぶ */
    raceStage.render({ show: null, t: 0, myHorses: getMyBetHorseNumbersForRace(next.raceId), snapCamera: raceStageSnapCamera });
    setStageOverlay("raceStageBadge", "🚦 まもなく発走");
    setStageOverlay("raceStageTop3", "", false);
    setStageOverlay("raceSubtitle", `まもなく発走です（あと${Math.max(0, Math.ceil(secondsToNext))}秒）`);
  } else if (!show) {
    /* 発走したが、結果（展開）がまだ届いていない数秒間 */
    raceStage.render({ show: null, t: 0, myHorses, snapCamera: raceStageSnapCamera });
    setStageOverlay("raceStageBadge", "🔴 LIVE");
    setStageOverlay("raceStageTop3", "", false);
    setStageOverlay("raceSubtitle", "ゲートオープン！");
  } else if (elapsed < show.revealTime + 4) {
    /* 最後の馬のゴール →「レース終了」の字幕を少し見せてから、次のレースの案内に切り替える */
    raceStage.render({ show, t: elapsed, myHorses, snapCamera: raceStageSnapCamera });
    setStageOverlay("raceStageBadge", elapsed < show.revealTime ? "🔴 LIVE" : `🏁 ${escapeHTML(formatRaceLabel(liveContext.raceId))} レース終了`);
    setStageOverlay("raceStageTop3", renderStageTop3(show, elapsed), elapsed > 0 && elapsed < show.revealTime);
    setStageOverlay("raceSubtitle", escapeHTML(show.commentaryAt(elapsed)));
  } else {
    /* レースが終わったあと：ゴール後の全体の様子で止めておく */
    raceStage.render({ show, t: show.revealTime + 2, myHorses, snapCamera: raceStageSnapCamera });
    setStageOverlay("raceStageBadge", `🏁 ${escapeHTML(formatRaceLabel(liveContext.raceId))} レース終了`);
    setStageOverlay("raceStageTop3", "", false);
    const dayLabel = next.dayId === formatRaceId(now) ? "本日" : "明日";
    setStageOverlay("raceSubtitle", `次のレースは${dayLabel} ${formatJstHourMinute(next.raceTime)} 発走`);
  }
  raceStageSnapCamera = false;
}

/* ----- 前回のレースを再生（閲覧専用。結果を読み込むだけで、何も書き込まない） ----- */

function getPreviousRaceForReplay(now = derbyNow()) {
  const live = getLiveRaceContext(now);
  const liveId = live.raceId;
  if (liveRaceResult && Array.isArray(liveRaceResult.resultOrder) && isLiveRaceResultRevealed(now)) {
    return { raceId: liveId, data: liveRaceResult };
  }
  /* recentRacesCache は開催時刻の新しい順。今のレースより前に開催されたうち、いちばん新しいもの */
  const found = recentRacesCache.find((r) => r && /^\d{4}-\d{2}-\d{2}/.test(String(r.raceId)) && parseRaceIdToDate(r.raceId) < live.raceTime && Array.isArray(r.resultOrder) && r.resultOrder.length > 0);
  return found ? { raceId: found.raceId, data: found } : null;
}

function formatRaceIdShort(raceId) {
  return /^\d{4}-\d{2}-\d{2}/.test(String(raceId || "")) ? formatRaceLabel(raceId) : raceId;
}

function updateReplayControls() {
  const startButton = document.getElementById("raceReplayButton");
  const exitButton = document.getElementById("raceReplayExitButton");
  const target = derbyReplay ? null : getPreviousRaceForReplay();
  if (startButton) {
    startButton.classList.toggle("hidden", !target);
    const text = target ? `▶ 前回のレースを再生（${formatRaceIdShort(target.raceId)}）` : "";
    if (startButton.textContent !== text) startButton.textContent = text;
  }
  exitButton?.classList.toggle("hidden", !derbyReplay);
}

function startDerbyReplay() {
  const target = getPreviousRaceForReplay();
  if (!target) return;
  ensureRaceStage();
  derbyReplay = {
    raceId: target.raceId,
    show: buildShowForRace(target.raceId, target.data),
    startedAt: performance.now(),
    liveRaceIdAtStart: getLiveRaceContext().raceId,
    ended: false
  };
  raceStageSnapCamera = true;
  setStageOverlay("raceReplayEnd", "", false);
  updateReplayControls();
  updateBetFormEnabled();
}

function finishDerbyReplay() {
  if (!derbyReplay) return;
  derbyReplay.ended = true;
  const order = derbyReplay.show.resultOrder;
  const medals = ["🥇", "🥈", "🥉"];
  const rows = order.slice(0, 3).map((n, i) => `<div>${medals[i]} ${i + 1}着　${n}番 ${escapeHTML(getHorseName(n))}</div>`).join("");
  setStageOverlay("raceReplayEnd", `
    <div class="race-replay-end-title">📼 リプレイ終了（${escapeHTML(formatRaceLabel(derbyReplay.raceId))}）</div>
    ${rows}
    <div class="race-replay-end-buttons">
      <button type="button" data-replay-action="again">↺ もう一度見る</button>
      <button type="button" data-replay-action="close">✕ 閉じる</button>
    </div>`);
}

function stopDerbyReplay() {
  if (!derbyReplay) return;
  derbyReplay = null;
  raceStageSnapCamera = true;
  setStageOverlay("raceReplayEnd", "", false);
  updateReplayControls();
  updateBetFormEnabled();
}

document.getElementById("raceReplayButton")?.addEventListener("click", startDerbyReplay);
document.getElementById("raceReplayExitButton")?.addEventListener("click", stopDerbyReplay);
raceTrack?.addEventListener("click", (event) => {
  const action = event.target?.closest?.("[data-replay-action]")?.dataset.replayAction;
  if (action === "again") startDerbyReplay();
  if (action === "close") stopDerbyReplay();
});

/* ----- レース情報パネル（スケジュール・実況・順位・結果・過去結果） ----- */

function ensureDerbyLiveStructure() {
  if (!raceInfo || raceInfo.dataset.liveReady === "1") return;
  raceInfo.dataset.liveReady = "1";
  raceInfo.innerHTML = `
    <div id="raceScheduleLine" class="race-schedule-line"></div>
    <div id="raceUpcomingLine" class="race-upcoming-line"></div>
    <div id="racePhaseBanner" class="race-phase-banner hidden"></div>
    <div id="raceCommentary" class="race-commentary hidden"></div>
    <div id="raceLeaderboard" class="race-leaderboard"></div>
    <div id="raceMyTickets" class="race-my-tickets"></div>
    <div id="raceFinalResult"></div>
    <div id="raceDetailedResult" class="race-detailed-result"></div>
    <div id="raceMyResult"></div>
    <div id="racePastResults"></div>
    <div class="race-ranking-title">🏆 総資産ランキング</div>
    <div id="raceRankingPanel" class="ranking"></div>
  `;
}

/* 【⑥ 詳細結果】人気順はそのレースの最終的な単勝の賭け金から計算（既存のコイン・投票の仕組みをそのまま利用） */
async function computeFinalPopularity(raceId) {
  const session = appSessionSeq;
  try {
    const snap = await getDocs(query(collection(db, "raceBets"), where("raceId", "==", raceId), where("type", "==", "win")));
    const pool = {};
    snap.forEach((d) => {
      const bet = d.data();
      const h = bet.horses?.[0];
      if (h) pool[h] = (pool[h] || 0) + Number(bet.amount || 0);
    });

    return SAFE_RACE_HORSES
      .map((h) => ({ number: h.number, pool: pool[h.number] || 0 }))
      .sort((a, b) => b.pool - a.pool)
      .map((h, i) => ({ ...h, rank: i + 1 }));
  } catch (error) {
    if (isInterruptedBySignOut(session)) return [];
    console.error("人気順取得エラー:", error);
    return [];
  }
}

async function renderDetailedRaceResults(raceId, raceData) {
  const el = document.getElementById("raceDetailedResult");
  if (!el || !raceData?.resultOrder) return;

  if (cachedPopularityForRaceId !== raceId) {
    cachedPopularityForRaceId = raceId;
    /* 固定オッズ方式のレースの人気順はレースごとに決まっているので、馬券は読まない */
    const fixedTable = isFixedOddsRace(raceId) ? getRaceOddsTable(raceId) : null;
    cachedPopularity = fixedTable
      ? SAFE_RACE_HORSES.map((h) => ({ number: h.number, rank: fixedTable.popRank[h.number] }))
      : await computeFinalPopularity(raceId);
  }
  const popularityMap = {};
  (cachedPopularity || []).forEach((p) => { popularityMap[p.number] = p.rank; });

  const medals = ["🥇", "🥈", "🥉"];
  const stats = raceData.finishStats || [];

  let html = `<div class="race-detailed-title">【レース結果】</div>`;
  raceData.resultOrder.forEach((horseNumber, index) => {
    const stat = stats.find((s) => s.number === horseNumber) || {};
    const medal = medals[index] || `${index + 1}着`;
    html += `
      <div class="race-result-row">
        <span class="race-result-rank">${medal}</span>
        <span class="race-result-horse">${horseNumber}番 ${escapeHTML(getHorseName(horseNumber))}</span>
        <span class="race-result-time">${escapeHTML(stat.timeText || "")}</span>
        <span class="race-result-margin">${escapeHTML(stat.marginText || "")}</span>
        <span class="race-result-pop">人気${popularityMap[horseNumber] || "-"}位</span>
      </div>`;
  });
  el.innerHTML = html;
}

function renderRaceInfo() {
  if (!raceInfo) return;
  ensureDerbyLiveStructure();

  const activeContext = getActiveBettingRaceContext();
  const now = derbyNow();
  const isToday = formatRaceId(now) === activeContext.dayId;

  const scheduleLine = document.getElementById("raceScheduleLine");
  if (scheduleLine) {
    scheduleLine.textContent = `次のレース：${isToday ? "本日" : "明日"} ${formatJstHourMinute(activeContext.raceTime)}（${formatRaceLabel(activeContext.raceId)}）`;
  }

  renderUpcomingRacesLine();
  renderBetRaceSelect();

  /* 馬券表示は手元のデータ(myAllBets)だけで組み立てられるので、毎ティック更新してもチラつかない */
  renderMyActiveTickets();

  const liveContext = getLiveRaceContext();
  /* 結果は、全馬がゴールして「レース終了」になってから表示する（レース中に結果が見えないように） */
  const revealed = isLiveRaceResultRevealed();
  const finalResultEl = document.getElementById("raceFinalResult");
  if (finalResultEl) {
    finalResultEl.innerHTML = revealed ? `
      <div class="race-final-result">
        <div class="race-final-result-title">レース結果（${escapeHTML(formatRaceLabel(liveContext.raceId))}）</div>
        <div>🥇 1着　${escapeHTML(getHorseName(liveRaceResult.resultOrder[0]))}</div>
        <div>🥈 2着　${escapeHTML(getHorseName(liveRaceResult.resultOrder[1]))}</div>
        <div>🥉 3着　${escapeHTML(getHorseName(liveRaceResult.resultOrder[2]))}</div>
      </div>` : "";
  }

  if (revealed) {
    renderMyRaceResultSummary(liveContext.raceId);
  } else {
    const myResultEl = document.getElementById("raceMyResult");
    if (myResultEl) myResultEl.innerHTML = "";
  }
}

/* 通信を伴う「重い」部分（詳細結果・過去結果・コインランキング）は、
   毎ティック(1秒に1回)ではなく、実際にレース結果が変わったときだけ更新する。
   これを1秒ごとに呼んでしまうと、ランキング等が「読み込み中…」→表示 を
   繰り返して画面がチラつくバグの原因になっていたため分離した。 */
function renderRaceInfoHeavyParts() {
  const liveContext = getLiveRaceContext();
  const detailedEl = document.getElementById("raceDetailedResult");

  if (liveRaceResult && isLiveRaceResultRevealed()) {
    revealedLiveRaceId = liveContext.raceId;
    renderDetailedRaceResults(liveContext.raceId, liveRaceResult).catch((e) => console.error("詳細結果描画エラー:", e));
  } else if (detailedEl) {
    detailedEl.innerHTML = "";
  }

  loadRecentRaceResults(liveContext.raceId);
  loadDerbyCoinRanking();
}

async function loadRecentRaceResults(excludeRaceId) {
  const session = appSessionSeq;
  const el = document.getElementById("racePastResults");
  if (!el) return;

  try {
    /* raceId の並び（「日付-1130」が「日付」より後ろ）ではなく、開催時刻の新しい順に並べ直す */
    const snap = await getDocs(query(collection(db, "races"), orderBy("raceId", "desc"), limit(8)));
    recentRacesCache = snap.docs
      .map((d) => d.data())
      .filter((r) => /^\d{4}-\d{2}-\d{2}/.test(String(r.raceId)))
      .sort((a, b) => parseRaceIdToDate(b.raceId) - parseRaceIdToDate(a.raceId));
    const races = recentRacesCache.filter((r) => r.raceId !== excludeRaceId && r.resultOrder);

    if (races.length === 0) { el.innerHTML = ""; return; }

    let html = `<div class="race-past-title">過去のレース結果</div>`;
    races.slice(0, 5).forEach((race) => {
      html += `<div class="race-past-item">
        ${escapeHTML(formatRaceLabel(race.raceId))}　1着:${escapeHTML(getHorseName(race.resultOrder[0]))}　
        2着:${escapeHTML(getHorseName(race.resultOrder[1]))}　
        3着:${escapeHTML(getHorseName(race.resultOrder[2]))}
      </div>`;
    });
    el.innerHTML = html;
  } catch (error) {
    if (isInterruptedBySignOut(session)) return;
    console.error("過去レース取得エラー:", error);
  }
}

/* ----- 毎ティック：カウントダウン・演出・順位・実況の更新 ----- */

/* ダービーの読み取り（オッズ・直近のレース・過去の結果・ランキングなど）は、ダービー画面を開いている間だけ行う。
   画面を離れたら購読を解除する（以前はアプリを開いている間ずっと購読し、起動時にも重い読み取りをしていた）。
   開催・結果確定・精算は、自動開催（GitHub Actions）と、起動時の未精算の確認でこれまでどおり行われる */
let liveRaceSnapshotReady = false;

function isDerbyViewActive() {
  return Boolean(currentUser && derbyView?.classList.contains("active") && !appElement?.classList.contains("hidden"));
}

function stopDerbySubscriptions() {
  if (unsubscribeLiveRace) { unsubscribeLiveRace(); unsubscribeLiveRace = null; }
  if (unsubscribeWinBets) { unsubscribeWinBets(); unsubscribeWinBets = null; }
  lastActiveBettingRaceId = null;
  lastLiveRaceId = null;
  liveRaceResult = null;
  liveRaceSnapshotReady = false;
  revealedLiveRaceId = null;
  lastGenerationAttemptAt = -999;
  currentWinPool = {};
}

function refreshDerbySubscriptionsIfNeeded() {
  if (!isDerbyViewActive()) {
    if (unsubscribeLiveRace || unsubscribeWinBets) stopDerbySubscriptions();
    return;
  }

  const activeId = getActiveBettingRaceContext().raceId;
  const liveId = getLiveRaceContext().raceId;

  if (activeId !== lastActiveBettingRaceId) {
    lastActiveBettingRaceId = activeId;
    refreshMyBetHistoryWindow();
    /* 固定オッズ方式のレースは、オッズのために馬券を購読しない（投票でオッズは変わらない） */
    if (isFixedOddsRace(activeId)) {
      if (unsubscribeWinBets) { unsubscribeWinBets(); unsubscribeWinBets = null; }
      currentWinPool = {};
      renderOdds();
    } else {
      listenWinBets(activeId);
    }
    renderMyActiveTickets();
  }

  if (liveId !== lastLiveRaceId) {
    lastLiveRaceId = liveId;
    liveRaceResult = null;
    lastElapsedWasNegative = null;
    revealedLiveRaceId = null;
    lastGenerationAttemptAt = -999;
    /* 人気順（cachedPopularity）はレースIDごとのキャッシュなので、ここでは消さない（画面に入り直しても読み直さない） */

    /* 重い部分（詳細結果・過去の結果・ランキング）は、直近のレースの最初の読み込みのあとに1回だけ描く */
    listenLiveRace(liveId);
  }
}

function listenLiveRace(raceId) {
  if (unsubscribeLiveRace) { unsubscribeLiveRace(); unsubscribeLiveRace = null; }
  liveRaceSnapshotReady = false;

  unsubscribeLiveRace = onSnapshot(
    doc(db, "races", raceId),
    (snap) => {
      const firstSnapshot = !liveRaceSnapshotReady;
      liveRaceSnapshotReady = true;
      const wasFinished = Boolean(liveRaceResult);

      if (snap.exists() && snap.data().status === "finished") {
        liveRaceResult = snap.data();
        settleMyBets(raceId);
      } else {
        liveRaceResult = null;
      }

      renderRaceInfo();

      /* ダービー画面を開いて最初の読み込み、または「未生成→生成された」の瞬間だけ、重い部分（詳細結果・ランキング等）を更新する */
      if (firstSnapshot || (!wasFinished && liveRaceResult)) {
        renderRaceInfoHeavyParts();
      }
    },
    (error) => console.error("本日のレース監視エラー:", error)
  );
}

let lastRaceInfoRenderAt = -999;

function tickDerbyCountdown() {
  refreshDerbySubscriptionsIfNeeded();

  const now = derbyNow();
  const liveContext = getLiveRaceContext(now);
  const elapsed = (now.getTime() - liveContext.raceTime.getTime()) / 1000;

  /* 以前は「馬券を買える対象のレース」の時刻を使っていたため、締切〜開催の間は
     次の回までの時間が表示されていた。開催時刻（11:30:00・15:02:00 JST）を基準にする */
  if (derbyCountdown) derbyCountdown.textContent = getDerbyCountdownText(now);

  /* 結果がまだ無ければ作る（ダービー画面を開いていて、直近のレースを読み込み終えたときだけ） */
  if (isDerbyViewActive() && liveRaceSnapshotReady && now >= liveContext.raceTime && !liveRaceResult && elapsed - lastGenerationAttemptAt > 5) {
    /* 一度失敗しても(通信エラー等)5秒おきに再試行する。
       tryGenerateRaceResult自体はすでに結果がある場合は何もしないだけなので、
       何度呼んでも安全（二重生成はされない）。 */
    lastGenerationAttemptAt = elapsed;
    tryGenerateRaceResult(liveContext.raceId);
  }

  /* ここから演出（レース画面は derby-show.js が毎フレーム描く。ここでは表示パネルだけ更新） */
  ensureRaceStage();

  if (lastElapsedWasNegative === true && elapsed >= 0) {
    triggerStartFlash();
    showAppToast("🏇 ゆうダービー", "レースがスタートしました！");
    showBrowserNotification("🏇 ゆうダービー", "レースがスタートしました！");
  }
  lastElapsedWasNegative = elapsed < 0;

  if (elapsed >= 0 && elapsed < 2 && raceStartFlashRaceId !== liveContext.raceId && !derbyReplay) {
    raceStartFlashRaceId = liveContext.raceId;
    triggerStartFlash();
  }

  /* 見ている途中で今日のレースが始まったら、リプレイを終えてライブに戻す */
  if (derbyReplay && derbyReplay.liveRaceIdAtStart !== liveContext.raceId && elapsed < RACE_SHOW_MAX_SECONDS) {
    stopDerbyReplay();
    showAppToast("🏇 ゆうダービー", "レースが始まったので、リプレイを終了しました");
  }

  /* 全馬ゴール→「レース終了」になった瞬間に、結果・詳細結果を表示する */
  if (liveRaceResult && revealedLiveRaceId !== liveContext.raceId && isLiveRaceResultRevealed(now)) {
    renderRaceInfoHeavyParts();
    renderRaceInfo();
  }

  updateReplayControls();

  const show = getLiveShow();
  const phase = show ? show.phaseAt(elapsed) : (elapsed < 0 ? "gate" : "start");
  const banner = document.getElementById("racePhaseBanner");
  const commentaryEl = document.getElementById("raceCommentary");
  const leaderboardEl = document.getElementById("raceLeaderboard");

  /* 実況はレース画面の下に字幕で出すので、下の情報欄の実況は表示しない */
  commentaryEl?.classList.add("hidden");

  if (phase === "gate") {
    banner?.classList.add("hidden");
    if (leaderboardEl) leaderboardEl.innerHTML = "";
  } else {
    if (banner) { banner.classList.remove("hidden"); banner.textContent = RACE_PHASE_LABELS[phase]; }

    if (leaderboardEl) {
      const myHorses = getMyBetHorseNumbersForRace(liveContext.raceId);
      const standings = show ? show.standingsAt(elapsed) : [];
      const html = standings.slice(0, 5).map((horse, index) => {
        const mine = myHorses.includes(horse.number) ? " ⭐" : "";
        return `<div class="race-leaderboard-item"><span class="rank">${index + 1}</span><span>${horse.number}番 ${escapeHTML(horse.name)}${mine}</span></div>`;
      }).join("");
      if (leaderboardEl.dataset.html !== html) {
        leaderboardEl.dataset.html = html;
        leaderboardEl.innerHTML = html;
      }
    }
  }

  /* スケジュール行・馬券・詳細結果・ランキングなどは重い処理を含むので1秒に1回だけ更新 */
  if (elapsed - lastRaceInfoRenderAt > 1 || lastRaceInfoRenderAt === -999) {
    lastRaceInfoRenderAt = elapsed;
    renderRaceInfo();
  }
}

let derbyClockSyncTimer = null;

function initializeSafeRace() {
  derbyReplay = null;
  syncDerbyClock();
  if (!derbyClockSyncTimer) derbyClockSyncTimer = setInterval(syncDerbyClock, 10 * 60 * 1000);
  resetBetHorsesSelection();
  updateBetFormEnabled();
  tickDerbyCountdown();
  if (raceCountdownTimer) clearInterval(raceCountdownTimer);
  raceCountdownTimer = setInterval(tickDerbyCountdown, 150);
}

/* =========================================================
   管理者（ゆうダービー管理）
   ・管理者は Firebase Authentication の UID だけで判定する（メールアドレスや名前では判定しない）
   ・管理者以外には管理画面・管理ボタンを表示しない
   ・Firestore のルール（firestore.rules）でも同じ UID を確かめていて、
     管理者以外が手動レースを直接書き換えようとしても拒否される
========================================================= */

const ADMIN_UID = "g51wzTvJFsZiYEfre5aDuDckJXY2";

function isAdminUser() {
  return Boolean(currentUser && currentUser.uid === ADMIN_UID);
}

/* 手動レースの投票数（betCount）は、
   Firestore のルールで「読んだ値 + 1」になっているかを確かめている。
   同時に何人かが書き込むと、古い値で計算した側は（競合なのに自動でやり直されず）permission-denied で拒否されるので、
   そのときは少し待って最新の値で数回やり直す（拒否された書き込みは何も反映されていないので、二重にはならない） */
async function runCountedTransaction(updateFunction, attempts = 8) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await runTransaction(db, updateFunction);
    } catch (error) {
      if (error?.code !== "permission-denied" || attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt + Math.random() * 300 * attempt));
    }
  }
}

function updateAdminVisibility() {
  const admin = isAdminUser();
  document.getElementById("derbyAdminPanel")?.classList.toggle("hidden", !admin);
  document.getElementById("announcementAdminPanel")?.classList.toggle("hidden", !admin);
  updateUserManageVisibility();
  if (admin) renderManualRaceAdminList();
}

/* =========================================================
   管理者によるユーザー名の強制変更（ランキングの「名前を変更」から）
   ・ユーザーのデータは users/{名前}（名前がドキュメントID）なので、通常の名前変更と同じく
     「新しい名前のドキュメントを作り、古い名前のドキュメントを消す」。中身（コイン・銀行・株など）はそのまま引き継ぐ
   ・users の移動・総資産ランキング（rankings/assets）の名前・変更記録（adminNameChanges/{古い名前}）は1つのトランザクションで行う
     （firestore.rules で「管理者だけ」「名前と記録用の項目以外は変えていない」ことを確かめる）
   ・そのあと、友達・グループ・メッセージのうち、その人の名前が入っているものだけを探して書き換える
     （通常の名前変更のように、コレクション全体は読まない）
   ・変更されたユーザーがアプリを開いていた場合は、そのユーザーの画面が新しい名前で読み込み直す（checkRenamedByAdmin）
========================================================= */

let adminRenameInFlight = false;

async function adminRenameUser(oldName, newName) {
  if (!isAdminUser()) throw new Error("NOT_ADMIN");
  const oldRef = doc(db, "users", oldName);
  const newRef = doc(db, "users", newName);
  const rankingRef = doc(db, "rankings", "assets");
  const logRef = doc(db, "adminNameChanges", oldName);

  let targetUid = "";
  await runTransaction(db, async (transaction) => {
    const oldSnap = await transaction.get(oldRef);
    const newSnap = await transaction.get(newRef);
    const rankingSnap = await transaction.get(rankingRef);
    if (!oldSnap.exists()) throw new Error("USER_NOT_FOUND");
    if (newSnap.exists()) throw new Error("NAME_TAKEN");
    const oldData = oldSnap.data();
    targetUid = oldData.uid || "";

    transaction.set(newRef, {
      ...oldData,
      name: newName,
      nameChangedByAdmin: true,
      nameChangedAt: serverTimestamp(),
      nameChangedByUid: currentUser.uid,
      nameChangedFrom: oldName
    });
    transaction.delete(oldRef);
    transaction.set(logRef, {
      from: oldName, to: newName, uid: targetUid,
      changedByUid: currentUser.uid, changedAt: serverTimestamp()
    });

    const ranking = rankingSnap.exists() ? rankingSnap.data() : null;
    if (Array.isArray(ranking?.users) && ranking.users.some((u) => u?.name === oldName)) {
      transaction.update(rankingRef, { users: ranking.users.map((u) => (u?.name === oldName ? { ...u, name: newName } : u)) });
    }
  });

  rankingCache = null;
  const migrated = await migrateRenamedUserData(oldName, newName);
  return { targetUid, migrated };
}

/* 友達・グループ・メッセージのうち、古い名前が入っているものだけを書き換える（通常の名前変更と同じ項目） */
async function migrateRenamedUserData(oldName, newName) {
  const updates = new Map();
  const add = (ref, data) => updates.set(ref.path, { ref, data: { ...(updates.get(ref.path)?.data || {}), ...data } });

  const [asUser1, asUser2, groupsSnap, sent, received] = await Promise.all([
    getDocs(query(collection(db, "friends"), where("user1", "==", oldName))),
    getDocs(query(collection(db, "friends"), where("user2", "==", oldName))),
    getDocs(query(collection(db, "groups"), where("members", "array-contains", oldName))),
    getDocs(query(collection(db, "messages"), where("sender", "==", oldName))),
    getDocs(query(collection(db, "messages"), where("receiver", "==", oldName)))
  ]);

  [...asUser1.docs, ...asUser2.docs].forEach((d) => {
    const data = d.data();
    const change = {};
    if (data.user1 === oldName) change.user1 = newName;
    if (data.user2 === oldName) change.user2 = newName;
    if (data.requestedBy === oldName) change.requestedBy = newName;
    if (data.acceptedBy === oldName) change.acceptedBy = newName;
    if (Object.keys(change).length) add(d.ref, { ...change, updatedAt: serverTimestamp() });
  });
  groupsSnap.docs.forEach((d) => {
    const data = d.data();
    const change = { members: (Array.isArray(data.members) ? data.members : []).map((m) => (m === oldName ? newName : m)) };
    if (data.owner === oldName) change.owner = newName;
    add(d.ref, { ...change, updatedAt: serverTimestamp() });
  });
  sent.docs.forEach((d) => add(d.ref, { sender: newName }));
  received.docs.forEach((d) => add(d.ref, { receiver: newName }));

  /* 1回の書き込みは500件まで */
  const list = [...updates.values()];
  for (let i = 0; i < list.length; i += 400) {
    const batch = writeBatch(db);
    list.slice(i, i + 400).forEach(({ ref, data }) => batch.update(ref, data));
    await batch.commit();
  }
  return { friends: asUser1.size + asUser2.size, groups: groupsSnap.size, messages: sent.size + received.size };
}

async function promptAdminRename(oldName) {
  if (!isAdminUser() || adminRenameInFlight) return;
  const input = prompt(`「${oldName}」の新しい名前を入力してください。`, oldName);
  if (input === null) return;
  const newName = input.trim();
  if (newName === oldName) return;
  const invalidReason = validateUsername(newName);
  if (invalidReason) return alert(invalidReason);
  if (!confirm(`このユーザーの名前を『${newName}』に変更しますか？\n（変更前：${oldName}）`)) return;

  adminRenameInFlight = true;
  try {
    const { targetUid, migrated } = await adminRenameUser(oldName, newName);
    alert(`名前を「${newName}」に変更しました。\n（友達 ${migrated.friends}件・グループ ${migrated.groups}件・メッセージ ${migrated.messages}件を更新）`);
    /* 自分自身の名前を変えたときは、新しい名前で読み込み直す */
    if (targetUid && targetUid === currentUser?.uid) { location.reload(); return; }
    loadCoinRanking();
    if (isDerbyViewActive()) loadDerbyCoinRanking();
  } catch (error) {
    const messages = { USER_NOT_FOUND: "そのユーザーは見つかりませんでした（すでに名前が変わった可能性があります）。", NAME_TAKEN: "その名前はすでに使われています。", NOT_ADMIN: "管理者だけが変更できます。" };
    if (!messages[error.message]) console.error("管理者の名前変更エラー:", error);
    alert(messages[error.message] || "名前の変更に失敗しました。");
    rankingCache = null;
    loadCoinRanking();
  } finally {
    adminRenameInFlight = false;
  }
}

document.addEventListener("click", (event) => {
  const button = event.target?.closest?.("[data-admin-rename]");
  if (!button || !isAdminUser()) return;
  event.preventDefault();
  promptAdminRename(button.dataset.adminRename);
});

/* 自分のユーザーデータが消えたとき：uid で探し直し、別の名前になっていれば（管理者が変更した）その名前で読み込み直す */
let renameCheckInFlight = false;
async function checkRenamedByAdmin() {
  /* 管理者が自分自身の名前を変えている途中は、変更の処理（友達・グループ・メッセージの書き換え）が終わってから読み込み直す */
  if (!currentUser || !username || renameCheckInFlight || adminRenameInFlight) return;
  renameCheckInFlight = true;
  const session = appSessionSeq;
  try {
    const result = await getDocs(query(collection(db, "users"), where("uid", "==", currentUser.uid), limit(1)));
    if (session !== appSessionSeq || result.empty) return;
    const newName = result.docs[0].id;
    if (newName === username) return;   /* 自分で名前を変えた途中（新しい名前はすでに使っている） */
    localStorage.setItem("yuuchat_username", newName);
    alert(`管理者によって名前が「${newName}」に変更されました。画面を読み込み直します。`);
    location.reload();
  } catch (error) {
    console.warn("名前の確認に失敗:", error);
  } finally {
    renameCheckInFlight = false;
  }
}

/* Firestore の Timestamp / Date / 文字列 → Date */
/* =========================================================
   👤 ユーザー管理（管理者だけ）
   ・パスワード設定・停止・削除は、ブラウザ（Firebase のクライアント）からは他人のアカウントに対してできないので、
     通知サーバー（Cloudflare Worker）の /admin に、管理者の ID トークンを付けて頼む
     （Worker は ID トークンの uid が管理者のときだけ実行する。タブを隠しているのは見た目のためだけ）
   ・パスワードは Firebase Authentication にだけ設定し、Firestore・ログには残さない。あとから表示もしない（必要なら再設定）
   ・停止したアカウントは、アプリを開き直したとき Firebase Authentication がログアウトさせる（開いたままの端末は最大1時間ほど）
   ・サブアカウントかどうかは自動で判定しない。一覧を見て、管理者が1件ずつ判断する
     （確信がないときは、まず「停止」。完全削除は取り消せないので、ユーザー名の入力が必須）
========================================================= */

const ADMIN_ENDPOINT = NOTIFY_ENDPOINT.replace(/\/notify$/, "/admin");
const ECONOMY_ENDPOINT = NOTIFY_ENDPOINT.replace(/\/notify$/, "/economy");
const ADMIN_PASSWORD_MIN_LENGTH = 8;
const ADMIN_PASSWORD_MAX_LENGTH = 128;

const userManageTabButton = document.getElementById("userManageTabButton");
const userManageListEl = document.getElementById("userManageList");
const userManageStatusEl = document.getElementById("userManageStatus");
const userManagePendingEl = document.getElementById("userManagePending");
const userManageAuthOnlyEl = document.getElementById("userManageAuthOnly");
const userManageAuthOnlyListEl = document.getElementById("userManageAuthOnlyList");
const userManageAuthOnlySummaryEl = document.getElementById("userManageAuthOnlySummary");
const userManageSearchInput = document.getElementById("userManageSearchInput");
const userManageSortSelect = document.getElementById("userManageSortSelect");

let userManageData = null;
let userManageLoading = false;
let userManageBusy = false;
let userManageSeq = 0;

const ADMIN_COIN_ADJUST_MAX = 1000000;
/* 総資産の増減（Worker の ADMIN_ASSET_ADJUST_MAX と同じ） */
const ADMIN_ASSET_ADJUST_MAX = 10000000;

const ADMIN_ERROR_MESSAGES = {
  invalid_amount: `金額は1〜${ADMIN_COIN_ADJUST_MAX.toLocaleString()}の整数で入力してください。`,
  insufficient_coins: "残高がマイナスになるため、減らせません。",
  balance_changed: "表示したあとに残高が変わっていました。最新の残高を表示し直したので、もう一度操作してください。",
  balance_too_large: "残高が大きくなりすぎるため、増やせません。",
  invalid_balance: "このユーザーのコインの値が正しくないため、変更できません。",
  busy: "ほかの操作と重なったため変更できませんでした。もう一度お試しください。",
  insufficient_assets: "回収できる資産（預金＋保有株）を超えるか、総資産がマイナスになるため、減らせません。",
  assets_changed: "表示したあとに預金・株・株価が変わっていました。最新の内訳を表示し直したので、もう一度操作してください。",
  not_admin: "管理者としてログインしていないため、操作できません。",
  invalid_uid: "対象のユーザーが正しくありません。",
  invalid_password: `パスワードは${ADMIN_PASSWORD_MIN_LENGTH}文字以上${ADMIN_PASSWORD_MAX_LENGTH}文字以内にしてください。`,
  user_not_found: "このユーザーのデータ（users）が見つかりません。",
  multiple_user_docs: "同じ uid のユーザーデータが複数あります。先にどちらかを整理してください。",
  auth_user_not_found: "Firebase Authentication にこのユーザーがありません。",
  other_email: "このユーザーには別のメールアドレスが設定されているため、パスワードを設定しませんでした。",
  deletion_in_progress: "このユーザーは削除の途中です。「完全削除」から続きを実行してください。",
  cannot_target_admin: "管理者のアカウントは停止・削除できません。",
  confirm_mismatch: "入力したユーザー名が一致しません。",
  has_user_doc: "このログイン情報にはユーザーデータがあるため、「完全削除」を使ってください。",
  has_data: "このログイン情報に関係するデータが残っているため、削除しませんでした。",
  verify_failed: "設定の確認に失敗しました。もう一度お試しください。",
  auth_EMAIL_EXISTS: "内部用のメールアドレスが別のアカウントで使われています。",
  invalid_message_id: "通知サーバー（Cloudflare Worker）がまだ管理機能に対応していません。Worker を更新してください。",
  invalid_token: "ログインの確認に失敗しました。ログインし直してください。",
  unauthenticated: "ログインの確認に失敗しました。ログインし直してください。"
};

function describeAdminError(error) {
  const code = error?.code || "";
  if (code === "blocked") {
    const blockers = error.detail?.blockers || [];
    if (blockers.includes("unsettled_bets")) return `未精算のゆうダービーの馬券が ${error.detail?.counts?.raceBetsUnsettled || 1} 件あるため、削除できません。精算されてから削除してください。`;
    if (blockers.includes("admin")) return ADMIN_ERROR_MESSAGES.cannot_target_admin;
    return "削除できない理由があります。";
  }
  if (code === "delete_failed") return `削除の途中で止まりました（${error.detail?.step || "不明"}）。もう一度「完全削除」を実行すると、続きから削除します。`;
  if (ADMIN_ERROR_MESSAGES[code]) return ADMIN_ERROR_MESSAGES[code];
  if (code === "network") return "通知サーバー（Cloudflare Worker）に接続できませんでした。";
  if (code.startsWith("auth_")) return `Firebase Authentication でエラーになりました（${code.slice(5)}）。`;
  return `処理できませんでした（${code || "不明なエラー"}）。`;
}

/* 💰 ゆう経済・🏇 ゆうダービー：本人の操作を Worker（残高・締切・結果・払い戻しをサーバーで検証）に頼む。
   ログインしていない・ネットワークエラーのときは code を付けた Error を投げる */
async function callEconomyApi(action, payload = {}) {
  if (!currentUser || !username) throw economyError("NOT_LOGGED_IN");
  const token = await currentUser.getIdToken();
  let response;
  try {
    response = await fetch(ECONOMY_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ action, username, ...payload })
    });
  } catch (error) {
    throw economyError("NETWORK");
  }
  const json = await response.json().catch(() => ({}));
  if (!response.ok) { const e = economyError(json.error || `http_${response.status}`); e.detail = json; throw e; }
  return json;
}

async function callAdminApi(action, payload = {}) {
  if (!isAdminUser()) throw Object.assign(new Error("not_admin"), { code: "not_admin" });
  const token = await currentUser.getIdToken();
  let response;
  try {
    response = await fetch(ADMIN_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...payload })
    });
  } catch (error) {
    throw Object.assign(new Error("network"), { code: "network" });
  }
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(json.error || `http_${response.status}`), { code: json.error || `http_${response.status}`, detail: json });
  return json;
}

function updateUserManageVisibility() {
  const admin = isAdminUser();
  userManageTabButton?.classList.toggle("hidden", !admin);
  if (!admin && userManageView && !userManageView.classList.contains("hidden")) switchView("chat");
}

function resetUserManageState() {
  userManageSeq++;
  userManageData = null;
  userManageLoading = false;
  userManageBusy = false;
  if (userManageListEl) userManageListEl.innerHTML = "";
  if (userManageAuthOnlyListEl) userManageAuthOnlyListEl.innerHTML = "";
  userManagePendingEl?.classList.add("hidden");
  userManageAuthOnlyEl?.classList.add("hidden");
  if (userManageStatusEl) userManageStatusEl.textContent = "";
  userManageTabButton?.classList.add("hidden");
}

function formatUmDate(value) {
  const date = typeof value === "number" ? new Date(value) : toDateValue(value);
  if (!date) return "-";
  const jst = toJstFields(date);
  return `${jst.getUTCFullYear()}/${jst.getUTCMonth() + 1}/${jst.getUTCDate()} ${formatJstHourMinute(date)}`;
}

function umLastLogin(entry) {
  const auth = entry.auth;
  return Math.max(auth?.lastLoginAt || 0, auth?.lastRefreshAt || 0) || null;
}

function umCreated(entry) {
  return entry.auth?.createdAt || toDateValue(entry.createdAt)?.getTime() || null;
}

function umLoginMethods(auth) {
  if (!auth) return "ログイン情報なし";
  const labels = [];
  if (auth.providers.includes("google.com")) labels.push("Google");
  if (auth.providers.includes("password")) labels.push("パスワード");
  if (auth.anonymous) labels.push("ゲスト");
  auth.providers.filter((p) => !["google.com", "password"].includes(p)).forEach((p) => labels.push(p));
  return labels.join("・") || "不明";
}

function umBadges(entry) {
  const badges = [];
  if (entry.isAdmin) badges.push(["admin", "管理者"]);
  if (!entry.auth) badges.push(["warn", "ログイン情報なし"]);
  else {
    if (entry.auth.providers.includes("google.com")) badges.push(["", "Google"]);
    if (entry.auth.anonymous) badges.push(["", "ゲスト"]);
    badges.push(entry.auth.hasPassword ? ["ok", "パスワード設定済み"] : ["", "パスワード未設定"]);
  }
  if (entry.suspended || entry.auth?.disabled) badges.push(["stop", "停止中"]);
  if (entry.deletion && entry.deletion !== "completed") badges.push(["stop", "削除途中"]);
  if (entry.sameUidCount > 1) badges.push(["warn", `同じ uid が ${entry.sameUidCount} 件`]);
  return badges.map(([kind, text]) => `<span class="um-badge ${kind}">${escapeHTML(text)}</span>`).join("");
}

async function openUserManageView() {
  if (!isAdminUser()) { switchView("chat"); return; }
  if (!userManageData && !userManageLoading) await loadUserManageList();
  else renderUserManageList();
}

async function loadUserManageList() {
  if (!isAdminUser() || userManageLoading) return;
  const seq = ++userManageSeq;
  userManageLoading = true;
  if (userManageStatusEl) userManageStatusEl.textContent = "読み込み中…";
  try {
    const data = await callAdminApi("listUsers");
    if (seq !== userManageSeq) return;
    userManageData = data;
    if (userManageStatusEl) userManageStatusEl.textContent = `ユーザー ${data.users.length} 人（ログイン情報だけのアカウント ${data.authOnly.length} 件）`;
    renderUserManageList();
  } catch (error) {
    if (seq !== userManageSeq) return;
    console.error("ユーザー一覧の読み込みエラー:", error);
    if (userManageStatusEl) userManageStatusEl.textContent = describeAdminError(error);
  } finally {
    if (seq === userManageSeq) userManageLoading = false;
  }
}

function renderUserManageList() {
  if (!userManageListEl || !userManageData) return;
  const keyword = (userManageSearchInput?.value || "").trim().toLowerCase();
  const sort = userManageSortSelect?.value || "created";
  const match = (text) => !keyword || String(text || "").toLowerCase().includes(keyword);

  const users = userManageData.users.filter((u) => match(u.name) || match(u.uid) || match(u.auth?.googleEmail));
  users.sort((a, b) => {
    if (sort === "name") return a.name.localeCompare(b.name, "ja");
    if (sort === "login") return (umLastLogin(b) || 0) - (umLastLogin(a) || 0);
    return (umCreated(b) || 0) - (umCreated(a) || 0);
  });

  userManageListEl.innerHTML = users.length === 0
    ? `<p class="um-note">該当するユーザーはいません。</p>`
    : users.map((u) => `
      <button class="um-item" type="button" data-um-uid="${escapeHTML(u.uid)}" data-um-name="${escapeHTML(u.name)}">
        <span class="um-item-main">
          <strong>${escapeHTML(u.name)}</strong>
          <span class="um-badges">${umBadges(u)}</span>
          <small>作成 ${escapeHTML(formatUmDate(umCreated(u)))} ・ 最終ログイン ${escapeHTML(formatUmDate(umLastLogin(u)))}${u.coins === null ? "" : ` ・ 🪙 ${u.coins.toLocaleString()}`}</small>
        </span>
        <span class="um-chevron" aria-hidden="true">›</span>
      </button>`).join("");

  const pending = userManageData.pendingDeletions || [];
  userManagePendingEl?.classList.toggle("hidden", pending.length === 0);
  if (userManagePendingEl) {
    userManagePendingEl.innerHTML = pending.length === 0 ? "" : `
      <h3>⚠ 削除の途中で止まっているアカウント</h3>
      ${pending.map((p) => `
        <button class="um-item" type="button" data-um-uid="${escapeHTML(p.uid)}" data-um-name="${escapeHTML(p.name)}">
          <span class="um-item-main">
            <strong>${escapeHTML(p.name || "（名前なし）")}</strong>
            <small>${escapeHTML(p.status === "failed" ? `途中で止まりました（${p.failedStep || "不明"}）` : "削除中")} ・ タップして続きから削除</small>
          </span>
          <span class="um-chevron" aria-hidden="true">›</span>
        </button>`).join("")}`;
  }

  const authOnly = userManageData.authOnly.filter((a) => !a.isAdmin && (match(a.uid) || match(a.auth?.googleEmail)));
  authOnly.sort((a, b) => (umCreated(b) || 0) - (umCreated(a) || 0));
  userManageAuthOnlyEl?.classList.toggle("hidden", userManageData.authOnly.length === 0);
  if (userManageAuthOnlySummaryEl) userManageAuthOnlySummaryEl.textContent = `ログイン情報だけのアカウント（${userManageData.authOnly.length} 件）`;
  if (userManageAuthOnlyListEl) {
    userManageAuthOnlyListEl.innerHTML = authOnly.map((a) => `
      <button class="um-item" type="button" data-um-uid="${escapeHTML(a.uid)}" data-um-name="">
        <span class="um-item-main">
          <strong>${escapeHTML(a.auth?.googleEmail || `uid ${a.uid.slice(0, 8)}…`)}</strong>
          <span class="um-badges">${umBadges(a)}</span>
          <small>作成 ${escapeHTML(formatUmDate(umCreated(a)))} ・ 最終ログイン ${escapeHTML(formatUmDate(umLastLogin(a)))}</small>
        </span>
        <span class="um-chevron" aria-hidden="true">›</span>
      </button>`).join("");
  }
}

function openUserManageModal(html) {
  if (!modalEl) return null;
  modalEl.innerHTML = `<div class="modal-card um-modal">${html}</div>`;
  modalEl.classList.remove("hidden");
  modalEl.querySelectorAll("[data-um-close]").forEach((button) => button.addEventListener("click", closeUserManageModal));
  return modalEl;
}

/* パスワードを表示していた画面も、閉じたら中身ごと消す */
function closeUserManageModal() {
  if (!modalEl) return;
  modalEl.classList.add("hidden");
  modalEl.innerHTML = "";
}

async function openUserManageDetail(uid) {
  if (!isAdminUser() || !uid) return;
  openUserManageModal(`<h3>👤 ユーザーの詳細</h3><p class="um-note">読み込み中…</p><div class="modal-buttons"><button class="modal-secondary" type="button" data-um-close>閉じる</button></div>`);
  let info;
  try {
    info = await callAdminApi("inspectUser", { uid });
  } catch (error) {
    openUserManageModal(`<h3>👤 ユーザーの詳細</h3><p class="admin-form-error">${escapeHTML(describeAdminError(error))}</p><div class="modal-buttons"><button class="modal-secondary" type="button" data-um-close>閉じる</button></div>`);
    return;
  }
  renderUserManageDetail(info);
}

function renderUserManageDetail(info) {
  const auth = info.auth;
  const hasUserDoc = info.userDocNames.length === 1;
  const deleting = info.deletion && info.deletion.status !== "completed";
  const suspended = Boolean(info.suspended || auth?.disabled);
  const rows = [
    ["名前", info.name || "（なし）"],
    ["uid", info.uid],
    ["ログイン方法", umLoginMethods(auth)],
    ["パスワード", auth ? (auth.hasPassword ? "設定済み" : "未設定") : "-"],
    ...(auth?.googleEmail ? [["Google", auth.googleEmail]] : []),
    ["作成日", formatUmDate(auth?.createdAt || info.user?.createdAt)],
    ["最終ログイン", formatUmDate(Math.max(auth?.lastLoginAt || 0, auth?.lastRefreshAt || 0) || null)],
    ...(info.user ? [["コイン", info.user.coins === null ? "-" : `🪙 ${info.user.coins.toLocaleString()}`]] : []),
    ...(info.user?.nameChangedFrom ? [["前の名前", info.user.nameChangedFrom]] : []),
    ["状態", deleting ? `削除の途中（${info.deletion.failedStep || info.deletion.status}）` : suspended ? `停止中${info.suspended?.reason ? `（${info.suspended.reason}）` : ""}` : "利用中"],
    ...(info.userDocNames.length > 1 ? [["注意", `同じ uid のユーザーデータが ${info.userDocNames.length} 件あります（${info.userDocNames.join("、")}）`]] : [])
  ];

  const buttons = [];
  if (hasUserDoc && auth && !deleting) buttons.push(`<button type="button" data-um-action="password">🔑 パスワードを${auth.hasPassword ? "再設定" : "設定"}</button>`);
  if (!info.isAdmin && auth && !deleting) buttons.push(suspended
    ? `<button type="button" class="secondary" data-um-action="unsuspend">▶ 停止を解除</button>`
    : `<button type="button" class="secondary" data-um-action="suspend">⏸ アカウントを停止</button>`);
  if (!info.isAdmin && (hasUserDoc || deleting)) buttons.push(`<button type="button" class="um-danger" data-um-action="delete">🗑 完全削除…</button>`);
  if (!info.isAdmin && !hasUserDoc && !deleting && auth) buttons.push(`<button type="button" class="um-danger" data-um-action="deleteAuthOnly">🗑 ログイン情報を削除…</button>`);

  /* ゆうコインの増減（users があるユーザーだけ） */
  const coins = Number.isSafeInteger(info.user?.coins) ? info.user.coins : 0;
  const coinHtml = hasUserDoc && info.user && !deleting ? `
    <section class="um-coins" aria-label="ゆうコインの増減">
      <div class="um-coins-balance">ゆうコイン <b id="umCoinBalance">🪙 ${coins.toLocaleString()}</b></div>
      <div class="um-coins-row">
        <input id="umCoinAmount" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="7" placeholder="金額" aria-label="増減する金額" autocomplete="off">
        <button type="button" data-um-coin="increase">＋増やす</button>
        <button type="button" class="secondary" data-um-coin="decrease">−減らす</button>
      </div>
      <p id="umCoinError" class="admin-form-error"></p>
    </section>` : "";

  /* 総資産の増減（内訳は開いたときに Worker から読む） */
  const assetHtml = hasUserDoc && info.user && !deleting ? `
    <section class="um-coins um-assets" aria-label="総資産の増減" data-um-assets-uid="${escapeHTML(info.uid)}">
      <div class="um-coins-balance">総資産 <b id="umAssetTotal">…</b></div>
      <div id="umAssetBreakdown" class="um-assets-breakdown">内訳を読み込み中…</div>
      <div class="um-coins-row">
        <input id="umAssetAmount" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="8" placeholder="金額" aria-label="総資産を増減する金額" autocomplete="off">
        <button type="button" data-um-asset="increase">＋増やす</button>
        <button type="button" class="secondary" data-um-asset="decrease">−減らす（回収）</button>
      </div>
      <p class="um-note">増やす：銀行預金に足します。減らす：預金から先に減らし、足りない分は保有株を評価額の高い銘柄から回収します（代金は戻しません）。手持ちコインは上の「ゆうコイン」で別に変更してください。</p>
      <p id="umAssetError" class="admin-form-error"></p>
    </section>` : "";

  openUserManageModal(`
    <h3>👤 ${escapeHTML(info.name || "ログイン情報だけのアカウント")}</h3>
    <dl class="um-detail">${rows.map(([k, v]) => `<dt>${escapeHTML(k)}</dt><dd>${escapeHTML(v)}</dd>`).join("")}</dl>
    ${coinHtml}
    ${assetHtml}
    ${info.isAdmin ? `<p class="um-note">管理者のアカウントは停止・削除できません。</p>` : `<p class="um-note">サブアカウントかどうか確信がないときは、まず「停止」を使ってください（あとで解除できます）。完全削除は取り消せません。</p>`}
    <div class="um-actions">${buttons.join("")}</div>
    <div class="modal-buttons"><button class="modal-secondary" type="button" data-um-close>閉じる</button></div>
  `);
  modalEl.querySelector('[data-um-action="password"]')?.addEventListener("click", () => renderUserManagePassword(info));
  modalEl.querySelector('[data-um-action="suspend"]')?.addEventListener("click", () => renderUserManageSuspend(info));
  modalEl.querySelector('[data-um-action="unsuspend"]')?.addEventListener("click", () => runUserManageUnsuspend(info));
  modalEl.querySelector('[data-um-action="delete"]')?.addEventListener("click", () => renderUserManageDelete(info));
  modalEl.querySelector('[data-um-action="deleteAuthOnly"]')?.addEventListener("click", () => renderUserManageDeleteAuthOnly(info));
  modalEl.querySelectorAll("[data-um-coin]").forEach((button) => button.addEventListener("click", () => runUserManageAdjustCoins(info, button.dataset.umCoin)));
  modalEl.querySelectorAll("[data-um-asset]").forEach((button) => button.addEventListener("click", () => previewUserManageAssets(info, button.dataset.umAsset)));
  if (assetHtml) loadUserManageAssets(info);
}

/* ----- 総資産（手持ちコイン + 預金 + 保有株の評価額 − 借入）の内訳・増減 -----
   内訳と「何がどれだけ減るか」は Worker（previewAssets）が計算したものをそのまま表示し、確認のあと adjustAssets で実行する */
function umStockLabel(code) {
  const company = STOCK_COMPANIES.find((c) => c.code === code);
  return company ? `${company.emoji} ${company.name}（${code}）` : code;
}

function umAssetBreakdownHtml(b) {
  const stocks = (b.stocks || []).map((s) => `<li>${escapeHTML(umStockLabel(s.code))}：${s.qty.toLocaleString()}株 × ${formatCoins(s.price)} = ${formatCoins(s.value)}</li>`).join("");
  return `
    <dl class="um-assets-list">
      <dt>手持ちコイン</dt><dd>🪙 ${formatCoins(b.coins)}</dd>
      <dt>銀行預金</dt><dd>🏦 ${formatCoins(b.deposit)}</dd>
      <dt>保有株の評価額</dt><dd>📈 ${formatCoins(b.stockValue)}</dd>
      <dt>借入残高</dt><dd>− ${formatCoins(b.loan)}</dd>
    </dl>
    ${stocks ? `<ul class="um-assets-stocks">${stocks}</ul>` : `<p class="um-assets-none">保有株はありません</p>`}`;
}

function isUserManageAssetsShown(info) {
  return Boolean(modalEl?.querySelector(`[data-um-assets-uid="${CSS.escape(info.uid)}"]`));
}

async function loadUserManageAssets(info, notice = "") {
  try {
    const result = await callAdminApi("previewAssets", { uid: info.uid });
    if (!isUserManageAssetsShown(info)) return;
    document.getElementById("umAssetTotal").textContent = `💰 ${formatCoins(result.breakdown.total)}`;
    document.getElementById("umAssetBreakdown").innerHTML = umAssetBreakdownHtml(result.breakdown);
    if (notice) showError(document.getElementById("umAssetError"), notice);
  } catch (error) {
    if (!isUserManageAssetsShown(info)) return;
    console.error("総資産の内訳の読み込みエラー:", error.code || error.message);
    document.getElementById("umAssetBreakdown").textContent = "内訳を読み込めませんでした。";
    showError(document.getElementById("umAssetError"), describeAdminError(error));
  }
}

function describeAssetError(error) {
  if (error?.code === "insufficient_assets" && Number.isSafeInteger(error.detail?.max)) {
    return `${ADMIN_ERROR_MESSAGES.insufficient_assets}（今回収できるのは最大 ${formatCoins(error.detail.max)}）`;
  }
  return describeAdminError(error);
}

/* 金額を確かめ、Worker に「何がどれだけ変わるか」を計算してもらい、確認の画面を出す */
async function previewUserManageAssets(info, direction) {
  if (userManageBusy) return;
  const input = document.getElementById("umAssetAmount");
  const errorEl = document.getElementById("umAssetError");
  showError(errorEl, "");
  const text = (input?.value || "").trim();
  const amount = /^[0-9]{1,8}$/.test(text) ? Number(text) : NaN;
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > ADMIN_ASSET_ADJUST_MAX) {
    return showError(errorEl, `金額は1〜${ADMIN_ASSET_ADJUST_MAX.toLocaleString()}の整数で入力してください。`);
  }
  userManageBusy = true;
  modalEl.querySelectorAll("[data-um-asset]").forEach((b) => { b.disabled = true; });
  try {
    const result = await callAdminApi("previewAssets", { uid: info.uid, direction, amount });
    userManageBusy = false;
    renderUserManageAssetConfirm(info, result);
  } catch (error) {
    userManageBusy = false;
    console.error("総資産の増減の確認エラー:", error.code || error.message);
    if (!isUserManageAssetsShown(info)) return;
    showError(errorEl, describeAssetError(error));
    modalEl.querySelectorAll("[data-um-asset]").forEach((b) => { b.disabled = false; });
  }
}

function renderUserManageAssetConfirm(info, preview) {
  const { breakdown: b, plan } = preview;
  const increase = plan.direction === "increase";
  const changes = increase
    ? [`銀行預金 +${formatCoins(plan.amount)}（${formatCoins(b.deposit)} → ${formatCoins(plan.depositAfter)}）`]
    : [
      ...(plan.fromDeposit > 0 ? [`銀行預金から ${formatCoins(plan.fromDeposit)} を回収`] : []),
      ...plan.removed.map((r) => `${umStockLabel(r.code)}：${r.qty.toLocaleString()}株を回収（${r.qtyBefore.toLocaleString()} → ${r.qtyAfter.toLocaleString()}株・1株 ${formatCoins(r.price)}・評価額 ${formatCoins(r.value)}）`),
      ...(plan.change > 0 ? [`株の端数の調整：${formatCoins(plan.change)} を銀行預金に戻す`] : []),
      `銀行預金：${formatCoins(b.deposit)} → ${formatCoins(plan.depositAfter)}`
    ];
  openUserManageModal(`
    <h3>💰 総資産を${increase ? "増やす" : "減らす（回収）"}（${escapeHTML(preview.name)}）</h3>
    <p class="um-note">対象：${escapeHTML(preview.name)}（uid ${escapeHTML(info.uid)}）</p>
    <div class="um-coins um-assets">
      <div class="um-coins-balance">今の総資産 <b>💰 ${formatCoins(b.total)}</b></div>
      ${umAssetBreakdownHtml(b)}
    </div>
    <div class="um-assets-plan">
      <div class="um-assets-plan-title">変更する内容</div>
      <ul>${changes.map((c) => `<li>${escapeHTML(c)}</li>`).join("")}</ul>
      <div class="um-assets-total-change">総資産：${formatCoins(b.total)} → <b id="umAssetAfter">${formatCoins(plan.totalAfter)}</b>（${increase ? "+" : "−"}${formatCoins(plan.amount)}）</div>
      <p class="um-note">手持ちコイン・借入は変わりません。${increase ? "" : "回収した株の代金はコインにも預金にも戻しません。"}総資産ランキングのこのユーザーの行と順位も、すぐに更新します。</p>
    </div>
    <p id="umAssetConfirmError" class="admin-form-error"></p>
    <div class="modal-buttons">
      <button class="modal-secondary" type="button" data-um-asset-back>戻る</button>
      <button id="umAssetSubmit" class="modal-primary ${increase ? "" : "modal-danger"}" type="button">実行する</button>
    </div>
  `);
  modalEl.querySelector("[data-um-asset-back]").addEventListener("click", () => renderUserManageDetail(info));
  document.getElementById("umAssetSubmit").addEventListener("click", () => runUserManageAdjustAssets(info, preview));
}

async function runUserManageAdjustAssets(info, preview) {
  if (userManageBusy) return;
  const { breakdown: b, plan } = preview;
  const submit = document.getElementById("umAssetSubmit");
  const errorEl = document.getElementById("umAssetConfirmError");
  userManageBusy = true;
  if (submit) submit.disabled = true;
  try {
    const expected = { deposit: b.deposit, stocks: Object.fromEntries((b.stocks || []).map((s) => [s.code, s.qty])), prices: b.prices };
    const result = await callAdminApi("adjustAssets", { uid: info.uid, direction: plan.direction, amount: plan.amount, expected });
    userManageBusy = false;
    info.user = { ...info.user, coins: result.breakdown.coins };
    const rankNote = result.ranking ? `・ランキング ${result.ranking.rankBefore ?? "-"}位 → ${result.ranking.rankAfter}位` : "";
    showAppToast("👤 ユーザー管理", `${result.name}の総資産を${formatCoins(result.amount)}${result.direction === "increase" ? "増やしました" : "減らしました"}（${formatCoins(result.beforeTotal)} → ${formatCoins(result.afterTotal)}${rankNote}）`);
    rankingCache = null;
    renderUserManageDetail(info);
  } catch (error) {
    userManageBusy = false;
    console.error("総資産の増減エラー:", error.code || error.message);
    if (error.code === "assets_changed" || error.code === "insufficient_assets") {
      renderUserManageDetail(info);
      const message = describeAssetError(error);
      setTimeout(() => { const el = document.getElementById("umAssetError"); if (el) showError(el, message); }, 0);
      return;
    }
    showError(errorEl, describeAdminError(error));
    if (submit) submit.disabled = false;
  } finally {
    userManageBusy = false;
  }
}

/* ゆうコインを増やす・減らす（確認のあと Worker に頼む。残高の計算・確認は Worker でも必ず行う） */
async function runUserManageAdjustCoins(info, direction) {
  if (userManageBusy) return;
  const input = document.getElementById("umCoinAmount");
  const errorEl = document.getElementById("umCoinError");
  showError(errorEl, "");
  const text = (input?.value || "").trim();
  const amount = /^[0-9]{1,7}$/.test(text) ? Number(text) : NaN;
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > ADMIN_COIN_ADJUST_MAX) return showError(errorEl, ADMIN_ERROR_MESSAGES.invalid_amount);

  const before = Number.isSafeInteger(info.user?.coins) ? info.user.coins : 0;
  const after = direction === "increase" ? before + amount : before - amount;
  if (after < 0) return showError(errorEl, ADMIN_ERROR_MESSAGES.insufficient_coins);
  if (!confirm(`ゆうコインを${amount.toLocaleString()}${direction === "increase" ? "増やし" : "減らし"}ますか？\n現在：${before.toLocaleString()} → ${after.toLocaleString()}`)) return;

  userManageBusy = true;
  modalEl.querySelectorAll("[data-um-coin]").forEach((b) => { b.disabled = true; });
  try {
    const result = await callAdminApi("adjustCoins", { uid: info.uid, direction, amount, expectedCoins: before });
    info.user = { ...info.user, coins: result.afterCoins };
    showAppToast("👤 ユーザー管理", `${info.name}のゆうコインを${amount.toLocaleString()}${direction === "increase" ? "増やしました" : "減らしました"}（${result.beforeCoins.toLocaleString()} → ${result.afterCoins.toLocaleString()}）`);
    userManageBusy = false;
    renderUserManageDetail(info);
    loadUserManageList();
  } catch (error) {
    userManageBusy = false;
    console.error("ゆうコインの増減エラー:", error.code || error.message);
    if (error.code === "balance_changed" || error.code === "insufficient_coins") {
      if (Number.isSafeInteger(error.detail?.coins)) info.user = { ...info.user, coins: error.detail.coins };
      renderUserManageDetail(info);
      showError(document.getElementById("umCoinError"), describeAdminError(error));
      return;
    }
    showError(errorEl, describeAdminError(error));
    modalEl.querySelectorAll("[data-um-coin]").forEach((b) => { b.disabled = false; });
  } finally {
    userManageBusy = false;
  }
}

/* 読み間違えにくい文字だけで、ランダムなパスワードを作る */
function generateAdminPassword(length = 12) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const limit = 256 - (256 % chars.length);
  let out = "";
  while (out.length < length) {
    const bytes = crypto.getRandomValues(new Uint8Array(length * 2));
    for (const b of bytes) {
      if (b < limit && out.length < length) out += chars[b % chars.length];
    }
  }
  return out;
}

function renderUserManagePassword(info) {
  openUserManageModal(`
    <h3>🔑 パスワードを${info.auth?.hasPassword ? "再設定" : "設定"}（${escapeHTML(info.name)}）</h3>
    <p class="um-note">今の uid のまま、Firebase Authentication にパスワードを設定します。設定したパスワードは保存されず、あとから表示できません（必要になったら再設定してください）。</p>
    <input id="umPasswordInput1" type="password" placeholder="新しいパスワード（${ADMIN_PASSWORD_MIN_LENGTH}文字以上）" autocomplete="new-password" maxlength="${ADMIN_PASSWORD_MAX_LENGTH}">
    <input id="umPasswordInput2" type="password" placeholder="もう一度入力" autocomplete="new-password" maxlength="${ADMIN_PASSWORD_MAX_LENGTH}">
    <label class="um-check"><input id="umPasswordShow" type="checkbox"> パスワードを表示する</label>
    <button id="umPasswordGenerate" class="secondary um-wide" type="button">🎲 ランダムに作る</button>
    <p id="umPasswordError" class="admin-form-error"></p>
    <div id="umPasswordDone" class="um-done hidden"></div>
    <div class="modal-buttons">
      <button class="modal-secondary" type="button" data-um-close>閉じる</button>
      <button id="umPasswordSubmit" class="modal-primary" type="button">設定する</button>
    </div>
  `);
  const input1 = document.getElementById("umPasswordInput1");
  const input2 = document.getElementById("umPasswordInput2");
  const errorEl = document.getElementById("umPasswordError");
  const submit = document.getElementById("umPasswordSubmit");
  const setVisible = (visible) => { input1.type = input2.type = visible ? "text" : "password"; };
  document.getElementById("umPasswordShow").addEventListener("change", (e) => setVisible(e.target.checked));
  document.getElementById("umPasswordGenerate").addEventListener("click", () => {
    const password = generateAdminPassword();
    input1.value = input2.value = password;
    document.getElementById("umPasswordShow").checked = true;
    setVisible(true);
  });
  submit.addEventListener("click", async () => {
    showError(errorEl, "");
    const p1 = input1.value, p2 = input2.value;
    if (p1.length < ADMIN_PASSWORD_MIN_LENGTH || p1.length > ADMIN_PASSWORD_MAX_LENGTH) return showError(errorEl, ADMIN_ERROR_MESSAGES.invalid_password);
    if (p1 !== p2) return showError(errorEl, "パスワードが一致しません。");
    if (userManageBusy) return;
    userManageBusy = true;
    submit.disabled = true;
    try {
      await callAdminApi("setPassword", { uid: info.uid, password: p1 });
      input1.readOnly = input2.readOnly = true;
      submit.classList.add("hidden");
      document.getElementById("umPasswordGenerate").classList.add("hidden");
      const done = document.getElementById("umPasswordDone");
      done.classList.remove("hidden");
      done.textContent = `設定しました。「ユーザー名とパスワードでログイン」から、ユーザー名「${info.name}」とこのパスワードで入れます。この画面を閉じるとパスワードは表示できなくなるので、本人に伝えてから閉じてください。`;
      loadUserManageList();
    } catch (error) {
      console.error("パスワード設定エラー:", error.code || error.message);
      showError(errorEl, describeAdminError(error));
    } finally {
      userManageBusy = false;
      submit.disabled = false;
    }
  });
}

function renderUserManageSuspend(info) {
  openUserManageModal(`
    <h3>⏸ アカウントを停止（${escapeHTML(info.name || info.uid)}）</h3>
    <p class="um-note">ログインできなくなります。すでに開いている端末も、最大1時間ほどで使えなくなります（アプリを開き直したときは、すぐにログアウトします）。データは消えず、あとで「停止を解除」できます。</p>
    <input id="umSuspendReason" type="text" maxlength="200" placeholder="理由（任意・管理者だけが見られます）">
    <p id="umSuspendError" class="admin-form-error"></p>
    <div class="modal-buttons">
      <button class="modal-secondary" type="button" data-um-close>やめる</button>
      <button id="umSuspendSubmit" class="modal-primary" type="button">停止する</button>
    </div>
  `);
  const submit = document.getElementById("umSuspendSubmit");
  submit.addEventListener("click", async () => {
    if (userManageBusy) return;
    if (!confirm(`「${info.name || info.uid}」を停止しますか？`)) return;
    userManageBusy = true;
    submit.disabled = true;
    try {
      await callAdminApi("suspend", { uid: info.uid, reason: document.getElementById("umSuspendReason").value });
      closeUserManageModal();
      showAppToast("👤 ユーザー管理", `「${info.name || info.uid}」を停止しました`);
      loadUserManageList();
    } catch (error) {
      showError(document.getElementById("umSuspendError"), describeAdminError(error));
    } finally {
      userManageBusy = false;
      submit.disabled = false;
    }
  });
}

async function runUserManageUnsuspend(info) {
  if (userManageBusy) return;
  if (!confirm(`「${info.name || info.uid}」の停止を解除しますか？`)) return;
  userManageBusy = true;
  try {
    await callAdminApi("unsuspend", { uid: info.uid });
    closeUserManageModal();
    showAppToast("👤 ユーザー管理", `「${info.name || info.uid}」の停止を解除しました`);
    loadUserManageList();
  } catch (error) {
    alert(describeAdminError(error));
  } finally {
    userManageBusy = false;
  }
}

function describeDeletionPlan(plan) {
  const c = plan.counts;
  const line = (text, n, kind = "del") => `<li class="${kind}">${escapeHTML(text)}：${n}件</li>`;
  const groupLines = plan.groups.map((g) => g.action === "transfer"
    ? `<li class="change">グループ「${escapeHTML(g.name)}」：退出して、${escapeHTML(g.nextOwner)} さんに管理者を引き継ぐ</li>`
    : g.action === "delete"
      ? `<li class="del">グループ「${escapeHTML(g.name)}」：ほかにメンバーがいないので、グループとそのメッセージを削除</li>`
      : `<li class="change">グループ「${escapeHTML(g.name)}」：メンバーから外す</li>`).join("");
  return `
    <ul class="um-plan">
      ${line("1対1のメッセージ（削除）", c.friendMessages)}
      ${line("フレンド関係（削除）", c.friends)}
      ${groupLines}
      ${line("グループで送ったメッセージ（残す）", c.groupMessagesKept, "keep")}
      ${line("ゆうダービーの精算済みの馬券（削除）", c.raceBetsSettled)}
      ${c.raceBetsUnsettled ? line("ゆうダービーの未精算の馬券（あるため削除できません）", c.raceBetsUnsettled, "block") : ""}
      ${c.gameRoomsDelete + c.gameRoomsLeave ? line("ゲームルーム（作ったものは削除・参加中は退出）", c.gameRoomsDelete + c.gameRoomsLeave, "change") : ""}
      ${c.gameInvites + c.gameRoomOwners ? line("ゲームの招待・ルームの記録（削除）", c.gameInvites + c.gameRoomOwners) : ""}
      ${c.fcmTokens ? line("通知を受け取る端末の登録（削除）", c.fcmTokens) : ""}
      ${c.adminNameChanges ? line("名前変更の記録（削除）", c.adminNameChanges) : ""}
      ${c.rankingEntry ? line("総資産ランキングの行（削除）", c.rankingEntry) : ""}
      ${line("ユーザーデータ（コイン・銀行・株など）（削除）", c.userDoc + c.userSubDocs)}
      <li class="del">ログイン情報（Firebase Authentication）：最後に削除</li>
    </ul>`;
}

function renderUserManageDelete(info) {
  const name = info.name;
  const blocked = info.plan.blockers.length > 0;
  openUserManageModal(`
    <h3>🗑 完全削除（${escapeHTML(name)}）</h3>
    <p class="um-warning">完全削除は取り消せません。サブアカウントかどうか確信がないときは、先に「停止」を使ってください。</p>
    <p class="um-note">削除すると、次のようになります（削除後、この名前はすぐに別の人が使えるようになります）。</p>
    ${describeDeletionPlan(info.plan)}
    ${blocked ? `<p class="admin-form-error">${escapeHTML(describeAdminError({ code: "blocked", detail: { blockers: info.plan.blockers, counts: info.plan.counts } }))}</p>` : ""}
    <label class="um-confirm-label" for="umDeleteConfirm">削除するには、ユーザー名「${escapeHTML(name)}」を入力してください</label>
    <input id="umDeleteConfirm" type="text" autocomplete="off" ${blocked ? "disabled" : ""}>
    <p id="umDeleteError" class="admin-form-error"></p>
    <div class="modal-buttons">
      <button class="modal-secondary" type="button" data-um-close>やめる</button>
      <button id="umDeleteSubmit" class="modal-primary um-danger" type="button" disabled>完全に削除する</button>
    </div>
  `);
  const input = document.getElementById("umDeleteConfirm");
  const submit = document.getElementById("umDeleteSubmit");
  input.addEventListener("input", () => { submit.disabled = blocked || input.value !== name; });
  submit.addEventListener("click", async () => {
    if (userManageBusy || blocked || input.value !== name) return;
    if (!confirm(`「${name}」を完全に削除します。取り消せません。本当に削除しますか？`)) return;
    userManageBusy = true;
    submit.disabled = true;
    input.disabled = true;
    try {
      await callAdminApi("deleteUser", { uid: info.uid, confirmName: input.value });
      closeUserManageModal();
      showAppToast("👤 ユーザー管理", `「${name}」を完全に削除しました`);
      loadUserManageList();
    } catch (error) {
      console.error("ユーザー削除エラー:", error.code || error.message);
      showError(document.getElementById("umDeleteError"), describeAdminError(error));
      input.disabled = false;
      submit.disabled = input.value !== name;
      loadUserManageList();
    } finally {
      userManageBusy = false;
    }
  });
}

function renderUserManageDeleteAuthOnly(info) {
  const key = info.uid.slice(0, 6);
  const total = Object.values(info.plan.counts).reduce((sum, n) => sum + n, 0);
  openUserManageModal(`
    <h3>🗑 ログイン情報を削除</h3>
    <p class="um-note">Firestore にユーザーデータが無いログイン情報です（uid ${escapeHTML(info.uid)}）。関係するデータが1件も無いことを確かめてから、Firebase Authentication のログイン情報だけを削除します。取り消せません。</p>
    ${total > 0 ? `<p class="admin-form-error">関係するデータが ${total} 件あるため削除できません。</p>` : ""}
    <label class="um-confirm-label" for="umDeleteAuthConfirm">削除するには、uid の最初の6文字「${escapeHTML(key)}」を入力してください</label>
    <input id="umDeleteAuthConfirm" type="text" autocomplete="off" ${total > 0 ? "disabled" : ""}>
    <p id="umDeleteAuthError" class="admin-form-error"></p>
    <div class="modal-buttons">
      <button class="modal-secondary" type="button" data-um-close>やめる</button>
      <button id="umDeleteAuthSubmit" class="modal-primary um-danger" type="button" disabled>削除する</button>
    </div>
  `);
  const input = document.getElementById("umDeleteAuthConfirm");
  const submit = document.getElementById("umDeleteAuthSubmit");
  input.addEventListener("input", () => { submit.disabled = total > 0 || input.value !== key; });
  submit.addEventListener("click", async () => {
    if (userManageBusy || input.value !== key) return;
    if (!confirm("このログイン情報を削除します。取り消せません。よろしいですか？")) return;
    userManageBusy = true;
    submit.disabled = true;
    try {
      await callAdminApi("deleteAuthOnly", { uid: info.uid });
      closeUserManageModal();
      showAppToast("👤 ユーザー管理", "ログイン情報を削除しました");
      loadUserManageList();
    } catch (error) {
      showError(document.getElementById("umDeleteAuthError"), describeAdminError(error));
      submit.disabled = false;
    } finally {
      userManageBusy = false;
    }
  });
}

document.getElementById("userManageRefreshButton")?.addEventListener("click", () => loadUserManageList());
userManageSearchInput?.addEventListener("input", renderUserManageList);
userManageSortSelect?.addEventListener("change", renderUserManageList);
userManageView?.addEventListener("click", (event) => {
  const item = event.target.closest("[data-um-uid]");
  if (item) openUserManageDetail(item.dataset.umUid);
});


function toDateValue(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value.toDate === "function") return value.toDate();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/* 入力欄の日付（YYYY-MM-DD）と時刻（HH:MM）を日本時間として Date にする。正しくなければ null */
function parseJstDateTimeInput(dateText, timeText) {
  const dm = String(dateText || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const tm = String(timeText || "").match(/^(\d{2}):(\d{2})$/);
  if (!dm || !tm) return null;
  const [y, mo, d, h, mi] = [Number(dm[1]), Number(dm[2]), Number(dm[3]), Number(tm[1]), Number(tm[2])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, 0, 0) - JST_OFFSET_MS);
  /* 2/30 などの存在しない日付は弾く */
  if (formatRaceId(date) !== `${dm[1]}-${dm[2]}-${dm[3]}`) return null;
  return date;
}

function formatJstDateTime(date) {
  if (!date) return "-";
  const jst = toJstFields(date);
  return `${jst.getUTCMonth() + 1}/${jst.getUTCDate()} ${formatJstHourMinute(date)}`;
}

/* ----- ゆうダービー：手動レース（特別レース） ----- */

function listenManualRaces() {
  startAdminListsRefresh();
  if (unsubscribeManualRaces) { unsubscribeManualRaces(); unsubscribeManualRaces = null; }
  const since = new Date(derbyNow().getTime() - 2 * DAY_MS);
  unsubscribeManualRaces = onSnapshot(
    query(collection(db, "derbyManualRaces"), where("raceAt", ">=", since)),
    (snap) => {
      const next = new Map();
      snap.forEach((d) => {
        const data = d.data();
        if (!MANUAL_RACE_ID_PATTERN.test(d.id)) return;
        const raceTime = toDateValue(data.raceAt), openTime = toDateValue(data.openAt), closeTime = toDateValue(data.closeAt);
        if (!raceTime || !openTime || !closeTime) return;
        next.set(d.id, {
          raceId: d.id, dayId: d.id.slice(0, 10), raceTime, openTime, closeTime,
          status: data.status || "scheduled", betCount: Number(data.betCount || 0)
        });
      });
      manualRaces = next;
      renderManualRaceAdminList();
      refreshMyBetHistoryWindow();
    },
    (error) => console.error("手動レースの読み込みエラー:", error)
  );
}

function getManualRaceStatusText(race, now = derbyNow()) {
  if (race.status === "cancelled") return "キャンセル済み";
  if (now < race.openTime) return "受付前";
  if (now < race.closeTime) return "投票受付中";
  if (now < race.raceTime) return "締切（開催待ち）";
  return "開催済み";
}

function renderManualRaceAdminList() {
  const el = document.getElementById("manualRaceAdminList");
  if (!el || !isAdminUser()) return;
  const now = derbyNow();
  const races = [...manualRaces.values()].sort((a, b) => b.raceTime - a.raceTime);
  if (races.length === 0) {
    el.innerHTML = `<div class="empty-state">まだ手動レースはありません</div>`;
    return;
  }
  el.innerHTML = races.map((race) => {
    const canCancel = race.status !== "cancelled" && now < race.raceTime && race.betCount === 0;
    const note = race.status !== "cancelled" && now < race.raceTime && race.betCount > 0 ? `<small>投票があるためキャンセルできません</small>` : "";
    return `<div class="admin-item ${race.status === "cancelled" ? "cancelled" : ""}">
      <div class="admin-item-main">
        <b>${escapeHTML(formatRaceLabel(race.raceId))}</b>
        <span class="admin-badge">${escapeHTML(getManualRaceStatusText(race, now))}</span>
        <div class="admin-item-sub">受付 ${escapeHTML(formatJstDateTime(race.openTime))}〜${escapeHTML(formatJstHourMinute(race.closeTime))} ／ 投票 ${race.betCount}件</div>
        ${note}
      </div>
      ${canCancel ? `<button type="button" class="secondary" data-cancel-manual-race="${escapeHTML(race.raceId)}">キャンセル</button>` : ""}
    </div>`;
  }).join("");
}

function validateManualRaceInput(dateText, openText, closeText, startText) {
  const raceTime = parseJstDateTimeInput(dateText, startText);
  const openTime = parseJstDateTimeInput(dateText, openText);
  const closeTime = parseJstDateTimeInput(dateText, closeText);
  if (!raceTime || !openTime || !closeTime) return { error: "開催日と時刻を正しく入力してください。" };
  const now = derbyNow();
  if (dateText < formatRaceId(now)) return { error: "開催日が過去の日付です。" };
  if (raceTime <= now) return { error: "レース開催の日時が過去です。" };
  if (openTime >= closeTime) return { error: "投票受付開始は、投票受付終了より前の時刻にしてください。" };
  if (closeTime >= raceTime) return { error: "投票受付終了は、レース開催より前の時刻にしてください。" };
  if (raceTime.getTime() - now.getTime() > 60 * DAY_MS) return { error: "レースは60日以内の日付で作成してください。" };

  const raceId = `${dateText}-m${startText.replace(":", "")}`;
  if (!MANUAL_RACE_ID_PATTERN.test(raceId)) return { error: "開催日と時刻を正しく入力してください。" };
  /* 同じ日の他のレース（自動開催・手動レース）と開催時刻が近すぎないか */
  const gap = MANUAL_RACE_MIN_GAP_MINUTES * 60000;
  const near = getRaceContextsForDay(dateText).find((c) => c.raceId !== raceId && Math.abs(c.raceTime - raceTime) < gap);
  if (near) return { error: `${formatRaceLabel(near.raceId)} のレースと開催時刻が近すぎます（前後${MANUAL_RACE_MIN_GAP_MINUTES}分以上あけてください）。` };
  return { raceId, raceTime, openTime, closeTime };
}

let manualRaceSubmitting = false;

document.getElementById("manualRaceForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!isAdminUser() || manualRaceSubmitting) return;
  const errorEl = document.getElementById("manualRaceFormError");
  const button = document.getElementById("manualRaceSubmitButton");
  const value = (id) => document.getElementById(id)?.value || "";
  const result = validateManualRaceInput(value("manualRaceDateInput"), value("manualRaceOpenInput"), value("manualRaceCloseInput"), value("manualRaceStartInput"));
  if (result.error) { if (errorEl) errorEl.textContent = result.error; return; }

  manualRaceSubmitting = true;
  if (button) button.disabled = true;
  if (errorEl) errorEl.textContent = "";
  try {
    /* 同じ raceId（日付＋開催時刻）が無いときだけ作る。連打・再読み込み・複数端末でも1つだけになる */
    await runTransaction(db, async (transaction) => {
      const ref = doc(db, "derbyManualRaces", result.raceId);
      const snap = await transaction.get(ref);
      const raceSnap = await transaction.get(doc(db, "races", result.raceId));
      if (raceSnap.exists()) throw new Error("RACE_EXISTS");
      if (snap.exists() && snap.data().status !== "cancelled") throw new Error("DUPLICATE");
      transaction.set(ref, {
        raceId: result.raceId,
        dayId: result.raceId.slice(0, 10),
        openAt: result.openTime,
        closeAt: result.closeTime,
        raceAt: result.raceTime,
        status: "scheduled",
        betCount: 0,
        createdByUid: currentUser.uid,
        createdAt: serverTimestamp()
      });
    });
    showAppToast("🏇 ゆうダービー管理", `${formatRaceLabel(result.raceId)} のレースを作成しました`);
    document.getElementById("manualRaceForm")?.reset();
  } catch (error) {
    const messages = {
      DUPLICATE: "同じ日時の手動レースはすでに作成されています。",
      RACE_EXISTS: "この日時のレースはすでに開催されています。別の時刻にしてください。"
    };
    if (!messages[error.message]) console.error("手動レース作成エラー:", error);
    if (errorEl) errorEl.textContent = messages[error.message] || "レースを作成できませんでした。通信状態を確認して、もう一度お試しください。";
  } finally {
    manualRaceSubmitting = false;
    if (button) button.disabled = false;
  }
});

/* キャンセル：開催前で、まだ投票が1件も無いレースだけ（投票数はトランザクションの中で確かめる） */
document.getElementById("manualRaceAdminList")?.addEventListener("click", async (event) => {
  const raceId = event.target?.closest?.("[data-cancel-manual-race]")?.dataset.cancelManualRace;
  if (!raceId || !isAdminUser()) return;
  if (!confirm(`${formatRaceLabel(raceId)} のレースをキャンセルしますか？\n（キャンセルすると元に戻せません）`)) return;
  try {
    await runTransaction(db, async (transaction) => {
      const ref = doc(db, "derbyManualRaces", raceId);
      const snap = await transaction.get(ref);
      if (!snap.exists() || snap.data().status === "cancelled") throw new Error("ALREADY_CANCELLED");
      if (Number(snap.data().betCount || 0) > 0) throw new Error("HAS_BETS");
      if (derbyNow() >= toDateValue(snap.data().raceAt)) throw new Error("ALREADY_STARTED");
      transaction.update(ref, { status: "cancelled", cancelledAt: serverTimestamp(), cancelledByUid: currentUser.uid });
    });
    showAppToast("🏇 ゆうダービー管理", `${formatRaceLabel(raceId)} のレースをキャンセルしました`);
  } catch (error) {
    const messages = {
      ALREADY_CANCELLED: "このレースはすでにキャンセルされています。",
      HAS_BETS: "投票があるため、このレースはキャンセルできません。",
      ALREADY_STARTED: "開催時刻を過ぎたレースはキャンセルできません。"
    };
    if (!messages[error.message]) console.error("手動レースのキャンセルエラー:", error);
    alert(messages[error.message] || "キャンセルできませんでした。もう一度お試しください。");
  }
});

/* 投票するレースの選択（受付中のレースが複数あるときだけ表示） */
function renderBetRaceSelect() {
  const select = document.getElementById("betRaceSelect");
  const label = document.getElementById("betRaceLabel");
  if (!select) return;
  const now = derbyNow();
  const open = getOpenBettingRaceContexts(now);
  const active = getActiveBettingRaceContext(now);
  const multiple = open.length > 1;
  select.classList.toggle("hidden", !multiple);
  label?.classList.toggle("hidden", !multiple);
  const key = open.map((c) => c.raceId).join("|");
  if (select.dataset.key !== key) {
    select.dataset.key = key;
    select.innerHTML = open.map((c) => {
      const day = c.dayId === formatRaceId(now) ? "本日" : (c.raceTime > now ? "明日" : "");
      return `<option value="${escapeHTML(c.raceId)}">${escapeHTML(`${day} ${formatJstHourMinute(c.raceTime)}${c.manual ? " 特別レース" : ""}（締切 ${formatJstHourMinute(c.closeTime)}）`)}</option>`;
    }).join("");
  }
  if (active && select.value !== active.raceId) select.value = active.raceId;
}

document.getElementById("betRaceSelect")?.addEventListener("change", (event) => {
  selectedBetRaceId = event.target.value || null;
  resetBetHorsesSelection();
  refreshDerbySubscriptionsIfNeeded();
  renderOdds();
  renderRaceInfo();
});

/* 今後のレース（自動開催・手動レース）を一行で案内する */
function renderUpcomingRacesLine() {
  const el = document.getElementById("raceUpcomingLine");
  if (!el) return;
  const now = derbyNow();
  const upcoming = getRaceContextsAround(now).filter((c) => c.raceTime > now).slice(0, 4);
  const text = upcoming.map((c) => {
    const day = c.dayId === formatRaceId(now) ? "本日" : "明日";
    return `${day} ${formatJstHourMinute(c.raceTime)}${c.manual ? `（特別・受付 ${formatJstHourMinute(c.openTime)}〜${formatJstHourMinute(c.closeTime)}）` : ""}`;
  }).join(" ／ ");
  const html = text ? `今後のレース：${escapeHTML(text)}` : "";
  if (el.dataset.html !== html) { el.dataset.html = html; el.innerHTML = html; }
}

/* 管理者の手動レース一覧は、受付開始・締切などの状態が時間で変わるので 15 秒ごとに描き直す（Firestore の読み取りはしない） */
let adminListsRefreshTimer = null;

function startAdminListsRefresh() {
  if (adminListsRefreshTimer) return;
  adminListsRefreshTimer = setInterval(() => {
    if (!currentUser) return;
    if (derbyView?.classList.contains("active")) renderManualRaceAdminList();
  }, 15000);
}

/* =========================================================
   📢 お知らせ
   ・announcements/{自動ID}：title・body・createdAt・updatedAt・createdByUid・createdByName（作成・編集・削除は管理者だけ）
   ・一覧は「お知らせ」タブを開いている間だけ onSnapshot で購読し、タブを離れたら止める（お知らせごとのリスナーは作らない）
   ・未読：createdAt が users/{名前}.lastAnnouncementReadAt より新しいお知らせ。
     既読にするときは lastAnnouncementReadAt を「今」に更新する1回の書き込みだけ（お知らせごとの既読データは作らない）
   ・タブの未読マーク：ログイン時に最新の1件だけを読んで判定する（タブを開いている間は購読の内容で更新）
========================================================= */

const ANNOUNCEMENT_TITLE_MAX = 50;
const ANNOUNCEMENT_BODY_MAX = 500;
const ANNOUNCEMENT_LIST_LIMIT = 50;
/* この端末で既読にした「いちばん新しいお知らせの投稿日時」（保存された lastAnnouncementReadAt と新しいほうで判定する） */
let announcementReadLocalAt = null;
let announcementReadInFlight = false;
const openedAnnouncementIds = new Set();
let editingAnnouncementId = null;
let announcementSubmitting = false;

function normalizeAnnouncement(snap) {
  /* 作成直後（サーバーの時刻がまだ無いとき）は、見積もりの時刻で並べる */
  const data = snap.data({ serverTimestamps: "estimate" });
  return {
    id: snap.id,
    title: String(data.title || ""),
    body: String(data.body || ""),
    createdAt: toDateValue(data.createdAt),
    updatedAt: toDateValue(data.updatedAt),
    createdByName: String(data.createdByName || "")
  };
}

function getAnnouncementReadAt() {
  const stored = toDateValue(myLatestUserData?.lastAnnouncementReadAt);
  if (stored && announcementReadLocalAt) return stored > announcementReadLocalAt ? stored : announcementReadLocalAt;
  return stored || announcementReadLocalAt;
}

function isAnnouncementUnread(createdAt) {
  if (!createdAt || !myLatestUserData) return false;
  const readAt = getAnnouncementReadAt();
  return !readAt || createdAt > readAt;
}

function updateAnnouncementUnreadMark() {
  const button = document.querySelector('.tabs button[data-view="announcements"]');
  button?.classList.toggle("has-unread", isAnnouncementUnread(latestAnnouncementAt));
  if (announcementsView?.classList.contains("active")) renderAnnouncements();
}

/* ログイン時：最新のお知らせ1件だけを読む（タブの未読マーク用・読み取り1回） */
async function checkLatestAnnouncement() {
  const session = appSessionSeq;
  try {
    const snap = await getDocs(query(collection(db, "announcements"), orderBy("createdAt", "desc"), limit(1)));
    if (session !== appSessionSeq) return;
    latestAnnouncementAt = snap.empty ? null : normalizeAnnouncement(snap.docs[0]).createdAt;
    updateAnnouncementUnreadMark();
  } catch (error) {
    console.error("お知らせの確認エラー:", error);
  }
}

function openAnnouncementsView() {
  renderAnnouncements();
  if (unsubscribeAnnouncements || !currentUser) return;
  unsubscribeAnnouncements = onSnapshot(
    query(collection(db, "announcements"), orderBy("createdAt", "desc"), limit(ANNOUNCEMENT_LIST_LIMIT)),
    (snap) => {
      announcements = snap.docs.map(normalizeAnnouncement).filter((a) => a.createdAt);
      latestAnnouncementAt = announcements[0]?.createdAt || null;
      updateAnnouncementUnreadMark();
      renderAnnouncements();
    },
    (error) => console.error("お知らせの読み込みエラー:", error)
  );
}

function stopAnnouncementsSubscription() {
  if (unsubscribeAnnouncements) { unsubscribeAnnouncements(); unsubscribeAnnouncements = null; }
}

function resetAnnouncementsState() {
  stopAnnouncementsSubscription();
  announcements = [];
  latestAnnouncementAt = null;
  announcementReadLocalAt = null;
  announcementReadInFlight = false;
  openedAnnouncementIds.clear();
  resetAnnouncementForm();
  document.getElementById("announcementAdminPanel")?.classList.add("hidden");
  document.querySelector('.tabs button[data-view="announcements"]')?.classList.remove("has-unread");
  const list = document.getElementById("announcementsList");
  if (list) list.innerHTML = "";
  const adminList = document.getElementById("announcementAdminList");
  if (adminList) adminList.innerHTML = "";
}

/* 2026/10/7 14:05（日本時間） */
function formatAnnouncementDate(date) {
  if (!date) return "";
  const jst = toJstFields(date);
  return `${jst.getUTCFullYear()}/${jst.getUTCMonth() + 1}/${jst.getUTCDate()} ${formatJstHourMinute(date)}`;
}

function renderAnnouncements() {
  const el = document.getElementById("announcementsList");
  if (!el) return;
  if (!unsubscribeAnnouncements && announcements.length === 0) {
    el.innerHTML = `<div class="announcement-empty">読み込み中…</div>`;
  } else if (announcements.length === 0) {
    el.innerHTML = `<div class="announcement-empty">お知らせはまだありません</div>`;
  } else {
    el.innerHTML = announcements.map((a) => {
      const unread = isAnnouncementUnread(a.createdAt);
      const open = openedAnnouncementIds.has(a.id);
      const edited = a.updatedAt && a.createdAt && a.updatedAt - a.createdAt > 60000;
      return `<article class="announcement-card${unread ? " unread" : ""}${open ? " open" : ""}" data-announcement-id="${escapeHTML(a.id)}" role="button" tabindex="0" aria-expanded="${open}">
        <div class="announcement-card-head">
          ${unread ? `<span class="announcement-unread" aria-label="未読">🔴</span>` : ""}
          <span class="announcement-title">${escapeHTML(a.title)}</span>
        </div>
        <div class="announcement-date">${escapeHTML(formatAnnouncementDate(a.createdAt))}${edited ? `（編集 ${escapeHTML(formatAnnouncementDate(a.updatedAt))}）` : ""}</div>
        <div class="announcement-body">${escapeHTML(a.body)}</div>
        <div class="announcement-more">${open ? "▲ 閉じる" : "▼ タップして全文を表示"}</div>
      </article>`;
    }).join("");
  }
  renderAnnouncementAdminList();
}

/* お知らせを開いたら、その時点までのお知らせをすべて既読にする（users/{名前} を1回更新するだけ） */
async function markAnnouncementsRead() {
  if (!username || !currentUser || announcementReadInFlight) return;
  if (!announcements.some((a) => isAnnouncementUnread(a.createdAt))) return;
  announcementReadInFlight = true;
  /* この端末では「表示中のいちばん新しいお知らせの投稿日時」までを既読として覚えておく（端末の時計は使わない）。
     名前を変えたあとは、購読中のユーザーデータが古い名前のまま更新されないことがあるので、
     書き込みが終わったあともこの値を残し、保存された値と新しいほうで判定する（再読み込みなしでも既読のまま） */
  const previousLocalAt = announcementReadLocalAt;
  const newest = announcements.reduce((max, a) => (a.createdAt && (!max || a.createdAt > max) ? a.createdAt : max), null);
  announcementReadLocalAt = previousLocalAt && previousLocalAt > newest ? previousLocalAt : newest;
  updateAnnouncementUnreadMark();
  try {
    await updateDoc(doc(db, "users", username), { lastAnnouncementReadAt: serverTimestamp() });
  } catch (error) {
    announcementReadLocalAt = previousLocalAt;
    console.error("お知らせの既読エラー:", error);
    updateAnnouncementUnreadMark();
  } finally {
    announcementReadInFlight = false;
  }
}

function toggleAnnouncement(id) {
  if (openedAnnouncementIds.has(id)) openedAnnouncementIds.delete(id);
  else openedAnnouncementIds.add(id);
  const a = announcements.find((x) => x.id === id);
  if (openedAnnouncementIds.has(id) && a && isAnnouncementUnread(a.createdAt)) markAnnouncementsRead();
  renderAnnouncements();
}

document.getElementById("announcementsList")?.addEventListener("click", (event) => {
  const card = event.target?.closest?.("[data-announcement-id]");
  if (card && currentUser) toggleAnnouncement(card.dataset.announcementId);
});
document.getElementById("announcementsList")?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const card = event.target?.closest?.("[data-announcement-id]");
  if (!card || !currentUser) return;
  event.preventDefault();
  toggleAnnouncement(card.dataset.announcementId);
});

/* ----- 📢 お知らせ管理（管理者だけ） ----- */

function renderAnnouncementAdminList() {
  const el = document.getElementById("announcementAdminList");
  if (!el || !isAdminUser()) return;
  el.innerHTML = announcements.length ? announcements.map((a) => `<div class="admin-item">
      <div class="admin-item-main">
        <b>${escapeHTML(a.title)}</b>
        <div class="admin-item-sub">${escapeHTML(formatAnnouncementDate(a.createdAt))}</div>
      </div>
      <div class="admin-item-buttons">
        <button type="button" class="secondary" data-announcement-edit="${escapeHTML(a.id)}">編集</button>
        <button type="button" class="secondary" data-announcement-delete="${escapeHTML(a.id)}">削除</button>
      </div>
    </div>`).join("") : `<div class="admin-item-sub">公開中のお知らせはありません</div>`;
}

function resetAnnouncementForm() {
  editingAnnouncementId = null;
  document.getElementById("announcementForm")?.reset();
  const submit = document.getElementById("announcementSubmitButton");
  if (submit) submit.textContent = "お知らせを公開する";
  document.getElementById("announcementEditCancelButton")?.classList.add("hidden");
  const errorEl = document.getElementById("announcementFormError");
  if (errorEl) errorEl.textContent = "";
}

document.getElementById("announcementForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!isAdminUser() || announcementSubmitting) return;
  const errorEl = document.getElementById("announcementFormError");
  const button = document.getElementById("announcementSubmitButton");
  const title = (document.getElementById("announcementTitleInput")?.value || "").trim();
  const body = (document.getElementById("announcementBodyInput")?.value || "").trim();
  const error = !title ? "タイトルを入力してください。"
    : title.length > ANNOUNCEMENT_TITLE_MAX ? `タイトルは${ANNOUNCEMENT_TITLE_MAX}文字までです。`
    : !body ? "本文を入力してください。"
    : body.length > ANNOUNCEMENT_BODY_MAX ? `本文は${ANNOUNCEMENT_BODY_MAX}文字までです。`
    : "";
  if (errorEl) errorEl.textContent = error;
  if (error) return;
  announcementSubmitting = true;
  if (button) button.disabled = true;
  try {
    if (editingAnnouncementId) {
      await updateDoc(doc(db, "announcements", editingAnnouncementId), { title, body, updatedAt: serverTimestamp() });
    } else {
      /* ID は Firestore の自動ID（端末側で作る・衝突しない） */
      const ref = doc(collection(db, "announcements"));
      await setDoc(ref, {
        title, body,
        createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
        createdByUid: currentUser.uid, createdByName: username || ""
      });
      notifyNewAnnouncementToAll(ref.id);
    }
    resetAnnouncementForm();
  } catch (err) {
    console.error("お知らせの保存エラー:", err);
    if (errorEl) errorEl.textContent = editingAnnouncementId ? "保存できませんでした（削除された可能性があります）。" : "公開できませんでした。もう一度お試しください。";
  } finally {
    announcementSubmitting = false;
    if (button) button.disabled = false;
  }
});

/* 新しいお知らせのプッシュ通知を、通知サーバーに頼む（管理者だけ。同じお知らせは通知サーバーが1回だけ送る）。
   お知らせはすでに保存済みなので、通知に失敗してもお知らせはそのまま */
async function notifyNewAnnouncementToAll(announcementId) {
  try {
    await callAdminApi("notifyAnnouncement", { announcementId });
  } catch (error) {
    console.warn("お知らせの通知に失敗しました（お知らせは公開済み）:", error?.code || error?.message || error);
  }
}

document.getElementById("announcementEditCancelButton")?.addEventListener("click", resetAnnouncementForm);

document.getElementById("announcementAdminList")?.addEventListener("click", async (event) => {
  if (!isAdminUser()) return;
  const target = event.target?.closest?.("button");
  if (!target) return;
  const a = announcements.find((x) => x.id === (target.dataset.announcementEdit || target.dataset.announcementDelete));
  if (!a) return;
  if (target.dataset.announcementEdit) {
    editingAnnouncementId = a.id;
    document.getElementById("announcementTitleInput").value = a.title;
    document.getElementById("announcementBodyInput").value = a.body;
    document.getElementById("announcementSubmitButton").textContent = "変更を保存する";
    document.getElementById("announcementEditCancelButton")?.classList.remove("hidden");
    document.getElementById("announcementFormError").textContent = "";
    document.getElementById("announcementForm")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  if (target.dataset.announcementDelete) {
    if (!confirm(`お知らせ「${a.title}」を削除しますか？\n削除すると元に戻せません。`)) return;
    try {
      await deleteDoc(doc(db, "announcements", a.id));
      if (editingAnnouncementId === a.id) resetAnnouncementForm();
    } catch (err) {
      console.error("お知らせの削除エラー:", err);
      alert("削除できませんでした。もう一度お試しください。");
    }
  }
});

/* =========================================================
   ゲーム部屋 共通
========================================================= */

function getGameTypeName(type) {
  if (type === "daifugo") return "大富豪";
  if (type === "othello") return "オセロ";
  if (type === "shogi") return "将棋";
  return "ゲーム";
}

function getMaxGamePlayers(type) {
  if (type === "daifugo") return 4;
  return 2;
}

/* =========================================================
   ゲームの緊急メンテナンス
   ・DAIFUGO_MAINTENANCE が true の間、大富豪は「新しいルーム作成・参加・ゲーム開始・カードを出す／パス・ルール変更」ができない
     （画面の表示だけでなく、それぞれの処理の入口でも止める）
   ・すでにあるルームと対局のデータ・履歴は消さない。参加中の人はルームを開いて「ルームを閉じる」（退出）だけできる
   ・オセロ・将棋・チャットなど、ほかの機能には影響しない
   ・メンテナンスを終えるときは DAIFUGO_MAINTENANCE を false にする
========================================================= */

const DAIFUGO_MAINTENANCE = true;

function isGameUnderMaintenance(type) {
  return DAIFUGO_MAINTENANCE && type === "daifugo";
}

const GAME_MAINTENANCE_ALERT = "大富豪は緊急メンテナンス中のため、現在ご利用いただけません。";

function buildGameMaintenanceNotice() {
  const notice = document.createElement("div");
  notice.className = "game-maintenance";
  notice.setAttribute("role", "alert");
  notice.innerHTML = `
    <div class="game-maintenance-title">🛠️ 緊急メンテナンス中</div>
    <p>現在、ゲームルールの修正を行っているため、大富豪を一時的にご利用いただけません。</p>
    <p>ご利用の皆様にはご迷惑をおかけし、誠に申し訳ございません。</p>
    <p>お詫びにつきましては、後日改めて報告させていただきます。</p>
    <p>ご理解とご協力のほど、よろしくお願いいたします。</p>`;
  return notice;
}

/* =========================================================
   盤面の保存形式の変換（オセロ・将棋）
   ・Firestoreは「配列の中の配列」を保存できないため、
     保存するときは1次元配列（オセロ64マス / 将棋81マス）にする
   ・アプリ内部のゲーム処理は今まで通り2次元配列で扱う
========================================================= */

function getBoardSize(type) {
  if (type === "othello") return 8;
  if (type === "shogi") return 9;
  return 0;
}

function boardToFirestore(board) {
  if (!Array.isArray(board)) return board;
  if (!board.every((row) => Array.isArray(row))) return board;
  return board.flat().map((cell) => cell ?? null);
}

function boardFromFirestore(board, size) {
  if (!Array.isArray(board) || !size) return null;
  /* すでに2次元配列ならそのまま使う */
  if (board.length === size && board.every((row) => Array.isArray(row) && row.length === size)) return board;
  if (board.length !== size * size) return null;
  return Array.from({ length: size }, (_, row) => board.slice(row * size, (row + 1) * size).map((cell) => cell ?? null));
}

/* 保存用：gameState.board を1次元配列にしたコピーを返す（大富豪などはそのまま） */
function gameStateToFirestore(type, state) {
  if (!state || !getBoardSize(type)) return state;
  return { ...state, board: boardToFirestore(state.board) };
}

/* 読み込み用：gameState.board を2次元配列に戻したコピーを返す（大富豪などはそのまま） */
function gameStateFromFirestore(type, state) {
  const size = getBoardSize(type);
  if (!state || !size) return state;
  return { ...state, board: boardFromFirestore(state.board, size) };
}

const gameTypeButtons = document.querySelectorAll(".game-type");

gameTypeButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const type = button.dataset.game;
    if (!type) return;
    gameTypeButtons.forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    currentGameType = type;
    renderGameRooms(latestGameRooms);
  });
});

let latestGameRooms = [];

function stopGameRoomsSubscription() {
  if (unsubscribeGameRooms) { unsubscribeGameRooms(); unsubscribeGameRooms = null; }
}

/* ゲームのルーム一覧（ゲーム画面を開いている間だけ購読する）
   ・新しいルーム GAME_ROOM_LIST_LIMIT 件（以前は全ルームを購読していた）
   ・自分が参加しているルーム（memberUids に自分の uid）… 古くても必ず一覧に出す
   どちらも単一項目の並び替え・条件だけなので、複合インデックスは不要 */
const GAME_ROOM_LIST_LIMIT = 50;

function loadGameRooms() {
  if (!gameRoomsEl) return;
  if (unsubscribeGameRooms) { unsubscribeGameRooms(); unsubscribeGameRooms = null; }
  if (!currentUser) return;

  const parts = { recent: null, mine: null };
  const update = () => {
    if (!parts.recent || !parts.mine) return;
    const merged = new Map();
    [...parts.recent, ...parts.mine].forEach((room) => merged.set(room.id, room));
    latestGameRooms = [...merged.values()].sort((a, b) => timestampMillis(b.createdAt) - timestampMillis(a.createdAt));
    renderGameRooms(latestGameRooms);
  };
  const onError = (error) => {
    console.error("ゲーム部屋監視エラー:", error);
    gameRoomsEl.innerHTML = `<div class="empty-state">ゲーム部屋を読み込めませんでした</div>`;
  };
  const toRooms = (snapshot) => snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));

  const unsubscribers = [
    onSnapshot(query(collection(db, "gameRooms"), orderBy("createdAt", "desc"), limit(GAME_ROOM_LIST_LIMIT)), (snapshot) => { parts.recent = toRooms(snapshot); update(); }, onError),
    onSnapshot(query(collection(db, "gameRooms"), where("memberUids", "array-contains", currentUser.uid)), (snapshot) => { parts.mine = toRooms(snapshot); update(); }, onError)
  ];
  unsubscribeGameRooms = () => unsubscribers.forEach((u) => u());
}

function renderGameRooms(allRooms) {
  if (!gameRoomsEl) return;
  gameRoomsEl.innerHTML = "";

  /* 緊急メンテナンス中のゲームは、ルーム一覧の代わりにお知らせを出し、ルーム作成ボタンを止める */
  const underMaintenance = isGameUnderMaintenance(currentGameType);
  if (createGameRoomButton) {
    createGameRoomButton.disabled = underMaintenance;
    createGameRoomButton.title = underMaintenance ? "緊急メンテナンス中" : "";
  }
  if (underMaintenance) {
    gameRoomsEl.appendChild(buildGameMaintenanceNotice());
    /* 参加中のルームだけは開ける（お知らせと「ルームを閉じる」だけの画面。対局はできない） */
    (allRooms || [])
      .filter((room) => room.gameType === currentGameType && Array.isArray(room.members) && room.members.includes(username))
      .forEach((room) => {
        const card = document.createElement("div");
        card.className = "room-card";
        card.innerHTML = `
          <div class="room-title">${escapeHTML(getGameTypeName(room.gameType))}（参加中）</div>
          <div class="room-owner">作成者：${escapeHTML(room.owner || "不明")}</div>
          <div class="room-status">メンテナンス中のため、対局はできません</div>`;
        const openButton = document.createElement("button");
        openButton.type = "button";
        openButton.className = "primary-button";
        openButton.textContent = "開く（退出のみ）";
        openButton.addEventListener("click", () => joinGameRoom(room));
        card.appendChild(openButton);
        gameRoomsEl.appendChild(card);
      });
    return;
  }

  /* 現在選択しているゲーム種類の部屋だけ表示する */
  const rooms = (allRooms || []).filter((room) => room.gameType === currentGameType);

  if (rooms.length === 0) {
    gameRoomsEl.innerHTML = `<div class="empty-state">参加できる${escapeHTML(getGameTypeName(currentGameType))}のルームはありません</div>`;
    return;
  }

  rooms.forEach((room) => {
    const members = Array.isArray(room.members) ? room.members : [];
    const card = document.createElement("div");
    card.className = "room-card";
    card.innerHTML = `
      <div class="room-title">${escapeHTML(getGameTypeName(room.gameType))}</div>
      <div class="room-owner">作成者：${escapeHTML(room.owner || "不明")}</div>
      <div class="room-members">参加者 ${members.length}/${getMaxGamePlayers(room.gameType)}人</div>
      <div class="room-status">${room.status === "playing" ? "プレイ中" : "参加者募集中"}</div>`;

    const joinButton = document.createElement("button");
    joinButton.type = "button";
    joinButton.className = "primary-button";
    joinButton.textContent = members.includes(username) ? "開く" : (room.status === "playing" ? "観戦" : "参加");
    joinButton.addEventListener("click", () => joinGameRoom(room));

    card.appendChild(joinButton);
    gameRoomsEl.appendChild(card);
  });
}

/* 自分が作成者で、まだ自分が参加している同じゲームのルーム（あれば新しく作れない） */
function isMyOpenRoom(room, type) {
  if (!room || room.gameType !== type || !currentUser) return false;
  const mine = room.ownerUid ? room.ownerUid === currentUser.uid : room.owner === username;
  const stillIn = (Array.isArray(room.memberUids) && room.memberUids.includes(currentUser.uid)) ||
    (Array.isArray(room.members) && room.members.includes(username));
  return mine && stillIn;
}

/* ルームの作成は「自分が作成者の同じゲームのルームは1個まで」。
   連打・複数の端末で同時に作られないよう、gameRoomOwners/{UID}_{ゲーム} に今のルームを記録し、
   トランザクションの中で「そのルームがまだあって自分が参加しているか」を確かめてから作る */
createGameRoomButton?.addEventListener("click", async () => {
  if (!currentUser || !username) return alert("ログインしてください。");

  const type = currentGameType || "daifugo";
  if (isGameUnderMaintenance(type)) return alert(GAME_MAINTENANCE_ALERT);
  const gameName = getGameTypeName(type);
  const existing = latestGameRooms.find((room) => isMyOpenRoom(room, type));
  if (existing) {
    if (confirm(`作成した${gameName}のルームがすでにあります。\n${gameName}のルームは1人1個までです（そのルームを閉じると新しく作れます）。\n\nそのルームを開きますか？`)) {
      joinGameRoom(existing);
    }
    return;
  }

  try {
    createGameRoomButton.disabled = true;

    const roomRef = doc(collection(db, "gameRooms"));
    const lockRef = doc(db, "gameRoomOwners", `${currentUser.uid}_${type}`);
    await runTransaction(db, async (transaction) => {
      const lockSnap = await transaction.get(lockRef);
      const previousRoomId = lockSnap.exists() ? lockSnap.data().roomId : null;
      if (previousRoomId) {
        const previousRoom = await transaction.get(doc(db, "gameRooms", previousRoomId));
        if (previousRoom.exists() && isMyOpenRoom({ id: previousRoom.id, ...previousRoom.data() }, type)) {
          throw Object.assign(new Error("ROOM_LIMIT"), { roomId: previousRoomId });
        }
      }
      transaction.set(roomRef, {
        gameType: type,
        owner: username,
        ownerUid: currentUser.uid,
        members: [username],
        memberUids: [currentUser.uid],
        maxPlayers: getMaxGamePlayers(type),
        status: "waiting",
        gameState: gameStateToFirestore(type, createInitialGameState(type)),
        ...(type === "daifugo" ? { rules: { ...DAIFUGO_DEFAULT_RULES } } : {}),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
      transaction.set(lockRef, { uid: currentUser.uid, gameType: type, roomId: roomRef.id, updatedAt: serverTimestamp() });
    });

    joinGameRoom({ id: roomRef.id, gameType: type, members: [username], memberUids: [currentUser.uid] });
  } catch (error) {
    if (error.message === "ROOM_LIMIT") {
      alert(`作成した${gameName}のルームがすでにあります。${gameName}のルームは1人1個までです。\nそのルームを閉じると、新しく作れます。`);
      return;
    }
    console.error("ゲームルーム作成エラー:", error);
    alert(`ゲームルームを作成できませんでした。（${gameName} / ${error.code || error.message || "不明なエラー"}）`);
  } finally {
    createGameRoomButton.disabled = false;
  }
});

function createInitialGameState(type) {
  if (type === "othello") {
    return { board: createInitialOthelloBoard(), currentPlayer: "black", started: false, winner: null };
  }
  if (type === "shogi") {
    return { board: createInitialShogiBoard(), captured: { sente: [], gote: [] }, currentPlayer: "sente", winner: null, moveCount: 0 };
  }
  if (type === "daifugo") {
    return applyDaifugoRules({
      phase: "waiting", players: [], hands: {}, currentPlayerUid: null,
      lastPlayedCards: [], lastPlayerUid: null, passedPlayers: [],
      revolution: false, elevenBack: false, lockSuit: null, winner: null
    });
  }
  return {};
}

async function joinGameRoom(room) {
  if (!currentUser || !username || !room?.id) return false;

  try {
    const roomRef = doc(db, "gameRooms", room.id);
    const snapshot = await getDoc(roomRef);
    if (!snapshot.exists()) { alert("このルームは存在しません。"); return false; }

    const data = snapshot.data();
    const members = Array.isArray(data.members) ? [...data.members] : [];
    const memberUids = Array.isArray(data.memberUids) ? [...data.memberUids] : [];
    const maxPlayers = getMaxGamePlayers(data.gameType);

    /* 緊急メンテナンス中：新しく参加はできない（参加中の人は、お知らせと「ルームを閉じる」だけの画面を開ける） */
    if (isGameUnderMaintenance(data.gameType) && !members.includes(username)) {
      alert(GAME_MAINTENANCE_ALERT);
      return false;
    }

    if (!members.includes(username)) {
      if (data.status === "playing") { alert("このゲームはすでに開始されています。"); return false; }
      if (members.length >= maxPlayers) { alert("このルームは満員です。"); return false; }

      members.push(username);
      memberUids.push(currentUser.uid);

      const updateData = { members, memberUids, updatedAt: serverTimestamp() };

      /* オセロ・将棋は2人そろった時点で対戦開始（大富豪は開始ボタンで切り替えるので対象外） */
      const isBoardGame = data.gameType === "othello" || data.gameType === "shogi";
      if (isBoardGame && members.length >= maxPlayers) updateData.status = "playing";

      await updateDoc(roomRef, updateData);
    }

    openGameArea(room.id, data.gameType || room.gameType);
    listenSelectedGame(room.id);
    return true;
  } catch (error) {
    console.error("ゲームルーム参加エラー:", error);
    alert("ゲームルームに参加できませんでした。");
    return false;
  }
}

function openGameArea(roomId, gameType) {
  selectedGameRoomId = roomId;
  if (!gameAreaEl) return;

  gameAreaEl.innerHTML = `
    <div class="panel">
      <div class="panel-head">
        <strong>${escapeHTML(getGameTypeName(gameType))}</strong>
        <button type="button" id="leaveGameRoomButton">ルームを閉じる</button>
      </div>
      <div id="currentGameStatus" class="game-status">読み込み中...</div>
      <div id="currentGameInvite"></div>
      <div id="currentGameBoard" class="game-board"></div>
    </div>`;

  document.getElementById("leaveGameRoomButton")?.addEventListener("click", () => leaveGameRoom(roomId));
}

function listenSelectedGame(roomId) {
  if (unsubscribeCurrentGame) { unsubscribeCurrentGame(); unsubscribeCurrentGame = null; }

  unsubscribeCurrentGame = onSnapshot(
    doc(db, "gameRooms", roomId),
    (snapshot) => {
      if (!snapshot.exists()) { closeGameArea(); return; }
      const data = snapshot.data();
      renderCurrentGame({ id: snapshot.id, ...data, gameState: gameStateFromFirestore(data.gameType, data.gameState) });
    },
    (error) => console.error("現在のゲーム監視エラー:", error)
  );
}

async function leaveGameRoom(roomId) {
  if (!currentUser || !roomId) return;

  try {
    const roomRef = doc(db, "gameRooms", roomId);
    const snapshot = await getDoc(roomRef);
    if (!snapshot.exists()) { closeGameArea(); return; }

    const data = snapshot.data();
    const members = (data.members || []).filter((name) => name !== username);
    const memberUids = (data.memberUids || []).filter((uid) => uid !== currentUser.uid);

    if (members.length === 0) {
      await deleteDoc(roomRef);
    } else {
      await updateDoc(roomRef, { members, memberUids, status: "waiting", updatedAt: serverTimestamp() });
    }

    closeGameArea();
  } catch (error) {
    console.error("ゲームルーム退出エラー:", error);
  }
}

function closeGameArea() {
  if (unsubscribeCurrentGame) { unsubscribeCurrentGame(); unsubscribeCurrentGame = null; }
  selectedGameRoomId = null;
  selectedShogiPiece = null;
  selectedDaifugoCards = [];

  if (gameAreaEl) {
    gameAreaEl.innerHTML = `<div class="empty-state">ゲームを選択してください</div>`;
  }
}

/* =========================================================
   現在のゲームを描画（種類ごとに振り分けるだけ）
========================================================= */

function renderCurrentGame(room) {
  const statusEl = document.getElementById("currentGameStatus");
  const boardEl = document.getElementById("currentGameBoard");
  if (!boardEl) return;

  if (statusEl) {
    const members = Array.isArray(room.members) ? room.members : [];
    statusEl.textContent = `参加者 ${members.length}/${getMaxGamePlayers(room.gameType)}人`;
  }

  if (isGameUnderMaintenance(room.gameType)) {
    const inviteEl = document.getElementById("currentGameInvite");
    if (inviteEl) inviteEl.innerHTML = "";
    boardEl.innerHTML = "";
    boardEl.appendChild(buildGameMaintenanceNotice());
    return;
  }

  renderGameInvitePanel(room);

  if (room.gameType === "othello") return renderOthelloBoard(boardEl, room);
  if (room.gameType === "shogi") return renderShogiBoard(boardEl, room);
  if (room.gameType === "daifugo") return renderDaifugoGame(boardEl, room);

  boardEl.innerHTML = `<div class="empty-state">ゲームを準備中です</div>`;
}

/* =========================================================
   ゲーム招待（将棋・オセロのみ）
   ・gameInvites/{roomId}_{招待相手のuid} に保存（同じ部屋・同じ相手は1件だけ）
   ・gameRooms/{roomId}.invitedUsers に招待中のユーザー名を保存
   ・参加するときは既存の joinGameRoom() を使う
========================================================= */

const INVITABLE_GAME_TYPES = ["othello", "shogi"];

function canInviteToGameRoom(room) {
  if (!room || !INVITABLE_GAME_TYPES.includes(room.gameType)) return false;
  if (room.ownerUid !== currentUser?.uid) return false;
  if (room.status === "playing") return false;
  const members = Array.isArray(room.members) ? room.members : [];
  return members.length < getMaxGamePlayers(room.gameType);
}

/* 部屋を作った人に表示する「友達を招待」欄 */
function renderGameInvitePanel(room) {
  const panelEl = document.getElementById("currentGameInvite");
  if (!panelEl) return;
  panelEl.innerHTML = "";
  if (!canInviteToGameRoom(room)) return;

  const members = Array.isArray(room.members) ? room.members : [];
  const invitedUsers = Array.isArray(room.invitedUsers) ? room.invitedUsers : [];
  const candidates = friendsData
    .map((f) => f.friend)
    .filter((name) => name && !members.includes(name) && !invitedUsers.includes(name));

  const panel = document.createElement("div");
  panel.className = "game-invite-panel";

  const title = document.createElement("div");
  title.className = "game-invite-title";
  title.textContent = "👥 友達を招待";
  panel.appendChild(title);

  if (candidates.length === 0) {
    const empty = document.createElement("div");
    empty.className = "game-invite-note";
    empty.textContent = "招待できる友達がいません";
    panel.appendChild(empty);
  } else {
    const row = document.createElement("div");
    row.className = "game-invite-row";

    const select = document.createElement("select");
    candidates.forEach((name) => {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      select.appendChild(option);
    });

    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "招待する";
    button.addEventListener("click", async () => {
      button.disabled = true;
      await sendGameInvite(room.id, select.value);
      button.disabled = false;
    });

    row.append(select, button);
    panel.appendChild(row);
  }

  if (invitedUsers.length) {
    const invited = document.createElement("div");
    invited.className = "game-invite-note";
    invited.textContent = `招待中：${invitedUsers.join("、")}`;
    panel.appendChild(invited);
  }

  panelEl.appendChild(panel);
}

async function sendGameInvite(roomId, friendName) {
  if (!currentUser || !username || !roomId || !friendName) return;

  const roomRef = doc(db, "gameRooms", roomId);
  const friendUserRef = doc(db, "users", friendName);

  try {
    await runTransaction(db, async (transaction) => {
      const roomSnap = await transaction.get(roomRef);
      if (!roomSnap.exists()) throw new Error("ROOM_NOT_FOUND");

      const room = roomSnap.data();
      const members = Array.isArray(room.members) ? room.members : [];
      if (!INVITABLE_GAME_TYPES.includes(room.gameType)) throw new Error("NOT_SUPPORTED");
      if (room.ownerUid !== currentUser.uid) throw new Error("NOT_HOST");
      if (room.status === "playing") throw new Error("ROOM_PLAYING");
      if (members.length >= getMaxGamePlayers(room.gameType)) throw new Error("ROOM_FULL");
      if (members.includes(friendName)) throw new Error("ALREADY_MEMBER");
      if (!friendsData.some((f) => f.friend === friendName)) throw new Error("NOT_FRIEND");

      const friendSnap = await transaction.get(friendUserRef);
      const toUid = friendSnap.exists() ? friendSnap.data().uid : null;
      if (!toUid) throw new Error("USER_NOT_FOUND");

      const inviteRef = doc(db, "gameInvites", `${roomId}_${toUid}`);
      const inviteSnap = await transaction.get(inviteRef);
      if (inviteSnap.exists() && inviteSnap.data().status === "pending") throw new Error("ALREADY_INVITED");

      const invitedUsers = (Array.isArray(room.invitedUsers) ? room.invitedUsers : []).filter((name) => name !== friendName);
      invitedUsers.push(friendName);

      transaction.set(inviteRef, {
        roomId,
        gameType: room.gameType,
        from: username,
        fromUid: currentUser.uid,
        to: friendName,
        toUid,
        status: "pending",
        createdAt: serverTimestamp(),
        respondedAt: null
      });
      transaction.update(roomRef, { invitedUsers, updatedAt: serverTimestamp() });
    });

    showAppToast("招待しました", `${friendName}さんを招待しました`);
  } catch (error) {
    console.error("ゲーム招待エラー:", error);
    const messages = {
      ROOM_NOT_FOUND: "このルームは存在しません。",
      NOT_SUPPORTED: "このゲームでは招待できません。",
      NOT_HOST: "部屋を作った人だけが招待できます。",
      ROOM_PLAYING: "ゲームがすでに開始されています。",
      ROOM_FULL: "このルームは満員です。",
      ALREADY_MEMBER: "その友達はすでに参加しています。",
      NOT_FRIEND: "友達だけを招待できます。",
      USER_NOT_FOUND: "そのユーザーが見つかりません。",
      ALREADY_INVITED: "その友達はすでに招待中です。"
    };
    alert(messages[error.message] || "招待できませんでした。");
  }
}

/* 自分あてに届いている保留中の招待を監視する */
function listenGameInvites() {
  if (unsubscribeGameInvites) { unsubscribeGameInvites(); unsubscribeGameInvites = null; }
  if (!currentUser) return;

  gameInvitesInitialized = false;

  unsubscribeGameInvites = onSnapshot(
    query(collection(db, "gameInvites"), where("toUid", "==", currentUser.uid), where("status", "==", "pending")),
    (snapshot) => {
      const previousIds = new Set(pendingGameInvites.map((invite) => invite.id));

      pendingGameInvites = snapshot.docs
        .map((item) => ({ id: item.id, ...item.data() }))
        .filter((invite) => INVITABLE_GAME_TYPES.includes(invite.gameType))
        .sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));

      /* ログイン直後の一覧はトーストを出さず、その後に新しく届いた招待だけ知らせる */
      if (gameInvitesInitialized) {
        pendingGameInvites
          .filter((invite) => !previousIds.has(invite.id))
          .forEach((invite) => showAppToast("🎮 ゲームの招待", `${invite.from}さんから${getGameTypeName(invite.gameType)}に招待されました`));
      }
      gameInvitesInitialized = true;

      renderGameInvites();
    },
    (error) => console.error("ゲーム招待監視エラー:", error)
  );
}

function renderGameInvites() {
  const gamesTabButton = document.querySelector('.tabs button[data-view="games"]');
  gamesTabButton?.classList.toggle("has-invite", pendingGameInvites.length > 0);

  if (!gameInvitesEl) return;
  gameInvitesEl.innerHTML = "";
  gameInvitesEl.classList.toggle("hidden", pendingGameInvites.length === 0);

  pendingGameInvites.forEach((invite) => {
    const card = document.createElement("div");
    card.className = "game-invite-card";

    const text = document.createElement("div");
    text.className = "game-invite-text";
    text.textContent = `${invite.from}さんから${getGameTypeName(invite.gameType)}の招待`;

    const actions = document.createElement("div");
    actions.className = "game-invite-actions";

    const acceptButton = document.createElement("button");
    acceptButton.type = "button";
    acceptButton.className = "game-invite-accept";
    acceptButton.textContent = "参加する";

    const declineButton = document.createElement("button");
    declineButton.type = "button";
    declineButton.className = "game-invite-decline";
    declineButton.textContent = "辞退する";

    acceptButton.addEventListener("click", async () => {
      acceptButton.disabled = true; declineButton.disabled = true;
      await acceptGameInvite(invite);
      acceptButton.disabled = false; declineButton.disabled = false;
    });
    declineButton.addEventListener("click", async () => {
      acceptButton.disabled = true; declineButton.disabled = true;
      await resolveGameInvite(invite, "declined");
      acceptButton.disabled = false; declineButton.disabled = false;
    });

    actions.append(acceptButton, declineButton);
    card.append(text, actions);
    gameInvitesEl.appendChild(card);
  });
}

/* 招待の状態を更新し、部屋の invitedUsers から自分を外す */
async function resolveGameInvite(invite, status) {
  if (!currentUser || !invite?.id) return false;

  const inviteRef = doc(db, "gameInvites", invite.id);
  const roomRef = doc(db, "gameRooms", invite.roomId);

  try {
    await runTransaction(db, async (transaction) => {
      const inviteSnap = await transaction.get(inviteRef);
      if (!inviteSnap.exists() || inviteSnap.data().status !== "pending") return;
      const roomSnap = await transaction.get(roomRef);

      transaction.update(inviteRef, { status, respondedAt: serverTimestamp() });

      if (roomSnap.exists()) {
        const toName = inviteSnap.data().to;
        const invitedUsers = (roomSnap.data().invitedUsers || []).filter((name) => name !== toName && name !== username);
        transaction.update(roomRef, { invitedUsers, updatedAt: serverTimestamp() });
      }
    });
    return true;
  } catch (error) {
    console.error("ゲーム招待更新エラー:", error);
    if (status === "declined") alert("招待を辞退できませんでした。");
    return false;
  }
}

async function acceptGameInvite(invite) {
  if (!currentUser || !username || !invite?.roomId) return;

  try {
    const roomSnap = await getDoc(doc(db, "gameRooms", invite.roomId));
    let reason = null;

    if (!roomSnap.exists()) {
      reason = "この部屋はもうありません。";
    } else {
      const room = roomSnap.data();
      const members = Array.isArray(room.members) ? room.members : [];
      if (!members.includes(username)) {
        if (room.status === "playing") reason = "このゲームはすでに開始されています。";
        else if (members.length >= getMaxGamePlayers(room.gameType)) reason = "このルームは満員です。";
      }
    }

    /* 参加できない招待は期限切れにして一覧から消す */
    if (reason) {
      await resolveGameInvite(invite, "expired");
      alert(reason);
      return;
    }

    switchView("games");
    const joined = await joinGameRoom({ id: invite.roomId, gameType: invite.gameType });
    if (joined) await resolveGameInvite(invite, "accepted");
  } catch (error) {
    console.error("ゲーム招待参加エラー:", error);
    alert("ゲームに参加できませんでした。");
  }
}

/* =========================================================
   オセロ
========================================================= */

function createInitialOthelloBoard() {
  const board = Array.from({ length: 8 }, () => Array(8).fill(null));
  board[3][3] = "white"; board[3][4] = "black";
  board[4][3] = "black"; board[4][4] = "white";
  return board;
}

function getOthelloPlayerColor(room) {
  if (!currentUser || !room) return null;
  const members = Array.isArray(room.members) ? room.members : [];
  const index = members.indexOf(username);
  if (index === 0) return "black";
  if (index === 1) return "white";
  return null;
}

function getOthelloFlips(board, row, col, color) {
  const opponent = color === "black" ? "white" : "black";
  const directions = [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
  const result = [];

  directions.forEach(([dr, dc]) => {
    const line = [];
    let r = row + dr, c = col + dc;
    while (r >= 0 && r < 8 && c >= 0 && c < 8) {
      const value = board[r][c];
      if (value === opponent) {
        line.push([r, c]);
      } else {
        if (value === color && line.length > 0) result.push(...line);
        break;
      }
      r += dr; c += dc;
    }
  });

  return result;
}

function getOthelloValidMoves(board, color) {
  const moves = [];
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      if (board[row][col]) continue;
      if (getOthelloFlips(board, row, col, color).length > 0) moves.push({ row, col });
    }
  }
  return moves;
}

function getOthelloWinner(board) {
  let black = 0, white = 0;
  board.forEach((row) => row.forEach((cell) => {
    if (cell === "black") black++;
    if (cell === "white") white++;
  }));

  const full = board.every((row) => row.every((cell) => cell !== null));
  const blackMoves = getOthelloValidMoves(board, "black");
  const whiteMoves = getOthelloValidMoves(board, "white");

  if (!full && (blackMoves.length > 0 || whiteMoves.length > 0)) return null;
  if (black > white) return "black";
  if (white > black) return "white";
  return "draw";
}

function countOthelloStones(board) {
  let black = 0, white = 0;
  (Array.isArray(board) ? board : []).forEach((row) => (Array.isArray(row) ? row : []).forEach((cell) => {
    if (cell === "black") black++;
    if (cell === "white") white++;
  }));
  return { black, white };
}

/* 対局終了の表示用：勝敗（自分から見て）・最終枚数・何枚差か
   勝敗そのものは今まで通り保存された state.winner（getOthelloWinner で決めたもの）を使う。ここでは表示を作るだけ */
function getOthelloResultSummary(state, room, board) {
  const { black, white } = countOthelloStones(board);
  const members = Array.isArray(room?.members) ? room.members : [];
  const names = { black: members[0] || "", white: members[1] || "" };
  const myColor = getOthelloPlayerColor(room);
  const winner = state?.winner;
  const colorText = { black: "黒", white: "白" };
  const diff = Math.abs(black - white);

  if (winner === "draw") {
    return {
      tone: "draw", black, white, names, myColor, winner, diff: 0,
      headline: "🤝 引き分け",
      detail: `黒も白も ${black}枚ずつ、同じ枚数でした`
    };
  }

  const winnerName = names[winner] ? `（${names[winner]}）` : "";
  const winnerLabel = `${colorText[winner] || ""}${winnerName}の勝ち`;
  const margin = diff > 0 ? `・${diff}枚差` : "";
  if (myColor) {
    const iWon = myColor === winner;
    return {
      tone: iWon ? "win" : "lose", black, white, names, myColor, winner, diff,
      headline: iWon ? "🎉 あなたの勝ち！" : "😢 相手の勝ち",
      detail: iWon ? `${winnerLabel}${diff > 0 ? `・${diff}枚差で勝ちました` : ""}` : `${winnerLabel}${diff > 0 ? `・${diff}枚差で負けました` : ""}`
    };
  }
  return {
    tone: "neutral", black, white, names, myColor, winner, diff,
    headline: `🏆 ${winnerLabel}！`,
    detail: `${winnerLabel}${margin}`
  };
}

/* 対局終了の結果（勝者を大きく・黒と白の最終枚数・何枚差か・自分の勝ち／負け／引き分け） */
function buildOthelloResultElement(summary) {
  const result = document.createElement("div");
  result.className = `othello-result othello-result--${summary.tone}`;
  result.setAttribute("role", "status");

  const headline = document.createElement("div");
  headline.className = "othello-result-headline";
  headline.textContent = summary.headline;
  result.appendChild(headline);

  const detail = document.createElement("div");
  detail.className = "othello-result-detail";
  detail.textContent = summary.detail;
  result.appendChild(detail);

  const score = document.createElement("div");
  score.className = "othello-score";
  const side = (color) => {
    const item = document.createElement("div");
    const isWinner = summary.winner === color;
    item.className = `othello-score-side ${color}${isWinner ? " is-winner" : ""}${summary.myColor === color ? " is-me" : ""}`;
    item.dataset.color = color;

    const stone = document.createElement("span");
    stone.className = `othello-stone ${color} othello-score-stone`;
    item.appendChild(stone);

    const label = document.createElement("span");
    label.className = "othello-score-label";
    const who = summary.names[color] ? ` ${summary.names[color]}` : "";
    label.textContent = `${color === "black" ? "黒" : "白"}${who}${summary.myColor === color ? "（あなた）" : ""}`;
    item.appendChild(label);

    const count = document.createElement("span");
    count.className = "othello-score-count";
    count.textContent = `${summary[color]}枚`;
    item.appendChild(count);

    if (isWinner) {
      const badge = document.createElement("span");
      badge.className = "othello-score-badge";
      badge.textContent = "勝ち";
      item.appendChild(badge);
    }
    return item;
  };
  score.appendChild(side("black"));
  const vs = document.createElement("span");
  vs.className = "othello-score-vs";
  vs.textContent = summary.winner === "draw" ? "＝" : "対";
  score.appendChild(vs);
  score.appendChild(side("white"));
  result.appendChild(score);

  return result;
}

function renderOthelloBoard(container, room) {
  if (!container) return;

  const state = room.gameState || createInitialGameState("othello");
  const board = Array.isArray(state.board) ? state.board : createInitialOthelloBoard();

  container.innerHTML = "";
  const wrapper = document.createElement("div");
  wrapper.className = "othello-wrapper";

  if (state.winner) {
    wrapper.appendChild(buildOthelloResultElement(getOthelloResultSummary(state, room, board)));
  } else {
    const info = document.createElement("div");
    info.className = "game-info";
    info.textContent = (state.currentPlayer || "black") === "black" ? "黒の番" : "白の番";
    wrapper.appendChild(info);
  }

  const boardElement = document.createElement("div");
  boardElement.className = "othello-board";

  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "othello-cell";

      const value = board[row]?.[col] || null;
      if (value) {
        const stone = document.createElement("span");
        stone.className = `othello-stone ${value}`;
        cell.appendChild(stone);
      }

      cell.addEventListener("click", () => playOthelloMove(room, row, col));
      boardElement.appendChild(cell);
    }
  }

  wrapper.appendChild(boardElement);
  container.appendChild(wrapper);
}

async function playOthelloMove(room, row, col) {
  if (!currentUser || !username || !room?.id) return;

  const roomRef = doc(db, "gameRooms", room.id);

  try {
    await runTransaction(db, async (transaction) => {
      const snapshot = await transaction.get(roomRef);
      if (!snapshot.exists()) throw new Error("ルームが存在しません");

      const latest = snapshot.data();
      const state = gameStateFromFirestore("othello", latest.gameState);
      if (!state?.board) throw new Error("ゲーム状態がありません");
      if (state.winner) throw new Error("すでに終了しています");

      const members = Array.isArray(latest.members) ? latest.members : [];
      if (members.length < 2) throw new Error("2人そろってから開始できます");

      const playerColor = getOthelloPlayerColor(latest);
      if (!playerColor) throw new Error("参加者ではありません");
      if (state.currentPlayer !== playerColor) throw new Error("あなたの番ではありません");

      const board = state.board;
      if (board[row][col]) throw new Error("そこには置けません");

      const flips = getOthelloFlips(board, row, col, playerColor);
      if (flips.length === 0) throw new Error("そこには置けません");

      const newBoard = board.map((line) => [...line]);
      newBoard[row][col] = playerColor;
      flips.forEach(([r, c]) => { newBoard[r][c] = playerColor; });

      let nextPlayer = playerColor === "black" ? "white" : "black";

      /* 次の人が置けない場合はさらに手番を回す */
      if (getOthelloValidMoves(newBoard, nextPlayer).length === 0) {
        if (getOthelloValidMoves(newBoard, playerColor).length > 0) {
          nextPlayer = playerColor;
        }
      }

      const winner = getOthelloWinner(newBoard);

      transaction.update(roomRef, {
        gameState: gameStateToFirestore("othello", { ...state, board: newBoard, currentPlayer: nextPlayer, started: true, winner }),
        updatedAt: serverTimestamp()
      });
    });
  } catch (error) {
    console.error("オセロ更新エラー:", error);
    if (error.message && error.message !== "ルームが存在しません") alert(error.message);
  }
}

/* =========================================================
   将棋
   ・駒は「持ち主＋駒」で保存する（"s:歩" は先手の歩、"g:歩" は後手の歩）。
     以前は持ち主を保存しておらず、盤の上下の位置で判定していたため、駒が中央を越えると持ち主を取り違えていた。
     持ち主の無い古い盤（"歩" だけ）は、読み込むときに位置から持ち主を補う（対局開始時の配置なら正しく変換される）
   ・盤のデータ（Firestore）は回転させない。画面だけ、後手の人には180度回して表示する（自分の駒がいつも下）
   ・合法手の判定（駒の動き・成り・持ち駒・二歩・行き所のない駒・打ち歩詰め・王手放置／自殺手の禁止・詰み）は
     下の「将棋のルール」で行い、表示（動けるマス）と指したときの確認（トランザクションの中）の両方で同じものを使う
========================================================= */

/* ===== 将棋のルール（SHOGI-ENGINE-START：画面に依存しない純粋な関数。テストでもこの部分をそのまま使う） ===== */
const SHOGI_PROMOTED = { "歩": "と", "香": "成香", "桂": "成桂", "銀": "成銀", "角": "馬", "飛": "龍" };
const SHOGI_UNPROMOTED = { "と": "歩", "成香": "香", "成桂": "桂", "成銀": "銀", "馬": "角", "龍": "飛" };
const SHOGI_HAND_ORDER = ["飛", "角", "金", "銀", "桂", "香", "歩"];
const SHOGI_GOLD_LIKE = ["金", "と", "成香", "成桂", "成銀"];

function shogiOpponent(owner) { return owner === "sente" ? "gote" : "sente"; }
function getUnpromotedShogiPiece(piece) { return SHOGI_UNPROMOTED[piece] || piece; }
function isPromotedShogiPiece(piece) { return Boolean(SHOGI_UNPROMOTED[piece]); }

/* 1マス分のデータ → { p: 駒, o: 持ち主 }。持ち主の無い古いデータは位置（上半分＝後手）から補う */
function decodeShogiCell(cell, row) {
  if (!cell) return null;
  if (typeof cell === "object" && cell.p) return { p: cell.p, o: cell.o === "gote" ? "gote" : "sente" };
  const text = String(cell);
  if (text.startsWith("s:")) return { p: text.slice(2), o: "sente" };
  if (text.startsWith("g:")) return { p: text.slice(2), o: "gote" };
  return { p: text, o: row < 4 ? "gote" : "sente" };
}

function encodeShogiCell(piece) {
  return piece ? `${piece.o === "gote" ? "g" : "s"}:${piece.p}` : null;
}

function decodeShogiBoard(board) {
  return Array.from({ length: 9 }, (_, row) => Array.from({ length: 9 }, (_, col) => decodeShogiCell(board?.[row]?.[col] ?? null, row)));
}

function encodeShogiBoard(board) {
  return board.map((line) => line.map(encodeShogiCell));
}

function createInitialShogiBoard() {
  const back = ["香", "桂", "銀", "金", null, "金", "銀", "桂", "香"];
  const rows = [
    back.map((p, col) => (col === 4 ? "王" : p)).map((p) => `g:${p}`),
    [null, "g:飛", null, null, null, null, null, "g:角", null],
    Array(9).fill("g:歩"),
    Array(9).fill(null), Array(9).fill(null), Array(9).fill(null),
    Array(9).fill("s:歩"),
    [null, "s:角", null, null, null, null, null, "s:飛", null],
    back.map((p, col) => (col === 4 ? "玉" : p)).map((p) => `s:${p}`)
  ];
  return rows;
}

function shogiForward(owner) { return owner === "sente" ? -1 : 1; }
function isShogiInside(row, col) { return row >= 0 && row < 9 && col >= 0 && col < 9; }

/* 1マスずつ動く方向と、どこまでも進める方向 */
function getShogiVectors(piece, owner) {
  const f = shogiForward(owner);
  const orth = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const diag = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
  if (piece === "歩") return { steps: [[f, 0]], slides: [] };
  if (piece === "香") return { steps: [], slides: [[f, 0]] };
  if (piece === "桂") return { steps: [[2 * f, -1], [2 * f, 1]], slides: [] };
  if (piece === "銀") return { steps: [[f, 0], [f, -1], [f, 1], [-f, -1], [-f, 1]], slides: [] };
  if (SHOGI_GOLD_LIKE.includes(piece)) return { steps: [[f, 0], [f, -1], [f, 1], [0, -1], [0, 1], [-f, 0]], slides: [] };
  if (piece === "王" || piece === "玉") return { steps: [...orth, ...diag], slides: [] };
  if (piece === "角") return { steps: [], slides: diag };
  if (piece === "飛") return { steps: [], slides: orth };
  if (piece === "馬") return { steps: orth, slides: diag };
  if (piece === "龍") return { steps: diag, slides: orth };
  return { steps: [], slides: [] };
}

/* 駒の動きだけで行けるマス（王手の確認は含まない）。自分の駒のマスは除き、相手の駒は取れる */
function getShogiPseudoMoves(board, row, col) {
  const piece = board[row]?.[col];
  if (!piece) return [];
  const { steps, slides } = getShogiVectors(piece.p, piece.o);
  const result = [];
  steps.forEach(([dr, dc]) => {
    const r = row + dr, c = col + dc;
    if (!isShogiInside(r, c)) return;
    const target = board[r][c];
    if (target && target.o === piece.o) return;
    result.push({ row: r, col: c, capture: Boolean(target) });
  });
  slides.forEach(([dr, dc]) => {
    let r = row + dr, c = col + dc;
    while (isShogiInside(r, c)) {
      const target = board[r][c];
      if (target) {
        if (target.o !== piece.o) result.push({ row: r, col: c, capture: true });
        break;
      }
      result.push({ row: r, col: c, capture: false });
      r += dr; c += dc;
    }
  });
  return result;
}

function findShogiKing(board, owner) {
  for (let row = 0; row < 9; row++) {
    for (let col = 0; col < 9; col++) {
      const piece = board[row][col];
      if (piece && piece.o === owner && (piece.p === "王" || piece.p === "玉")) return { row, col };
    }
  }
  return null;
}

function isShogiSquareAttacked(board, row, col, byOwner) {
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      const piece = board[r][c];
      if (!piece || piece.o !== byOwner) continue;
      if (getShogiPseudoMoves(board, r, c).some((m) => m.row === row && m.col === col)) return true;
    }
  }
  return false;
}

function isShogiInCheck(board, owner) {
  const king = findShogiKing(board, owner);
  if (!king) return false;
  return isShogiSquareAttacked(board, king.row, king.col, shogiOpponent(owner));
}

function isInShogiPromotionZone(row, owner) {
  return owner === "sente" ? row <= 2 : row >= 6;
}

/* 成れるか（成れる駒が、相手陣に入る・相手陣の中で動く・相手陣から出るとき） */
function canPromoteShogiMove(piece, fromRow, toRow, owner) {
  if (!SHOGI_PROMOTED[piece]) return false;
  return isInShogiPromotionZone(fromRow, owner) || isInShogiPromotionZone(toRow, owner);
}

/* 行き所のない駒になる段（歩・香は最奥段、桂は奥2段）。成らずに進む・打つことはできない */
function isShogiDeadEndRow(piece, row, owner) {
  const last = owner === "sente" ? 0 : 8;
  if (piece === "歩" || piece === "香") return row === last;
  if (piece === "桂") return owner === "sente" ? row <= 1 : row >= 7;
  return false;
}

function cloneShogiBoard(board) {
  return board.map((line) => line.map((cell) => (cell ? { ...cell } : null)));
}

/* 盤に手を反映した新しい盤（確認はしない） */
function applyShogiMoveToBoard(board, move, owner) {
  const next = cloneShogiBoard(board);
  let captured = null;
  if (move.type === "drop") {
    next[move.to.row][move.to.col] = { p: move.piece, o: owner };
  } else {
    const moving = next[move.from.row][move.from.col];
    captured = next[move.to.row][move.to.col];
    next[move.to.row][move.to.col] = { p: move.promote ? SHOGI_PROMOTED[moving.p] : moving.p, o: owner };
    next[move.from.row][move.from.col] = null;
  }
  return { board: next, captured };
}

/* 盤上の駒の合法手（自分の玉が王手のままになる手・王手になる手は除く）。成れるか・成らなければならないかも返す */
function getShogiLegalMovesFrom(board, row, col) {
  const piece = board[row]?.[col];
  if (!piece) return [];
  return getShogiPseudoMoves(board, row, col).filter((m) => {
    const { board: next } = applyShogiMoveToBoard(board, { type: "move", from: { row, col }, to: m }, piece.o);
    return !isShogiInCheck(next, piece.o);
  }).map((m) => ({
    ...m,
    canPromote: canPromoteShogiMove(piece.p, row, m.row, piece.o),
    mustPromote: isShogiDeadEndRow(piece.p, m.row, piece.o)
  }));
}

/* 持ち駒を打てるマス（空きマス・行き所のない駒にならない・二歩でない・自玉が王手にならない・打ち歩詰めでない） */
function getShogiLegalDrops(board, hand, piece, owner, checkUchifuzume = true) {
  if (!Array.isArray(hand) || !hand.includes(piece)) return [];
  const result = [];
  for (let row = 0; row < 9; row++) {
    for (let col = 0; col < 9; col++) {
      if (board[row][col]) continue;
      if (isShogiDeadEndRow(piece, row, owner)) continue;
      if (piece === "歩" && board.some((line) => line[col] && line[col].o === owner && line[col].p === "歩")) continue; /* 二歩 */
      const { board: next } = applyShogiMoveToBoard(board, { type: "drop", piece, to: { row, col } }, owner);
      if (isShogiInCheck(next, owner)) continue;
      if (piece === "歩" && checkUchifuzume) {
        const enemy = shogiOpponent(owner);
        /* 打ち歩詰め：歩を打って王手にし、相手に逃げる手が無いときは打てない */
        if (isShogiInCheck(next, enemy) && !hasShogiLegalMove(next, null, enemy, false)) continue;
      }
      result.push({ row, col, capture: false, canPromote: false, mustPromote: false });
    }
  }
  return result;
}

/* その持ち主に、指せる手が1つでもあるか（詰みの判定に使う）。hands は { sente: [...], gote: [...] } */
function hasShogiLegalMove(board, hands, owner, checkUchifuzume = true) {
  for (let row = 0; row < 9; row++) {
    for (let col = 0; col < 9; col++) {
      if (board[row][col]?.o === owner && getShogiLegalMovesFrom(board, row, col).length) return true;
    }
  }
  const hand = hands?.[owner] || [];
  return [...new Set(hand)].some((piece) => getShogiLegalDrops(board, hand, piece, owner, checkUchifuzume).length > 0);
}

/* 手を指したあとの対局の状態。合法でなければ Error を投げる（指したときに、トランザクションの中で必ず確かめる）
   move: { type: "move", from: {row, col}, to: {row, col}, promote: true/false } または { type: "drop", piece: "歩", to: {row, col} } */
function applyShogiMove(state, move, owner) {
  if (state.winner) throw new Error("対局は終了しています");
  if (state.currentPlayer !== owner) throw new Error("現在の手番ではありません");
  const board = state.board;
  const hands = { sente: [...(state.captured?.sente || [])], gote: [...(state.captured?.gote || [])] };
  let promote = false;

  if (move.type === "drop") {
    const legal = getShogiLegalDrops(board, hands[owner], move.piece, owner);
    if (!legal.some((m) => m.row === move.to.row && m.col === move.to.col)) throw new Error("そこには打てません");
    hands[owner].splice(hands[owner].indexOf(move.piece), 1);
  } else {
    const piece = board[move.from.row]?.[move.from.col];
    if (!piece || piece.o !== owner) throw new Error("動かせる駒がありません");
    const target = getShogiLegalMovesFrom(board, move.from.row, move.from.col).find((m) => m.row === move.to.row && m.col === move.to.col);
    if (!target) throw new Error("その駒はそこへ動けません");
    promote = target.mustPromote || (Boolean(move.promote) && target.canPromote);
  }

  const { board: next, captured } = applyShogiMoveToBoard(board, { ...move, promote }, owner);
  if (captured) hands[owner].push(getUnpromotedShogiPiece(captured.p)); /* 成った駒を取ったら、元の駒に戻して持ち駒にする */

  const enemy = shogiOpponent(owner);
  const check = isShogiInCheck(next, enemy);
  const winner = hasShogiLegalMove(next, hands, enemy) ? null : owner; /* 相手に指せる手が無い＝詰み */
  return {
    ...state,
    board: next,
    captured: hands,
    currentPlayer: enemy,
    winner,
    winReason: winner ? (check ? "checkmate" : "noMoves") : null,
    check,
    moveCount: Number(state.moveCount || 0) + 1,
    lastMove: move.type === "drop"
      ? { type: "drop", piece: move.piece, to: move.to, by: owner }
      : { type: "move", from: move.from, to: move.to, promote, by: owner }
  };
}
/* ===== SHOGI-ENGINE-END ===== */

/* 保存されている状態 → 画面・ルールで使う形（盤は持ち主付き） */
function ensureShogiState(state) {
  if (!state) return state;
  const board = Array.isArray(state.board) ? state.board : createInitialShogiBoard();
  const captured = state.captured || {};
  return {
    ...state,
    board: decodeShogiBoard(board),
    captured: { sente: Array.isArray(captured.sente) ? captured.sente.map(getUnpromotedShogiPiece) : [], gote: Array.isArray(captured.gote) ? captured.gote.map(getUnpromotedShogiPiece) : [] },
    currentPlayer: state.currentPlayer === "gote" ? "gote" : "sente",
    winner: state.winner || null,
    moveCount: Number(state.moveCount || 0)
  };
}

/* 保存用（盤は "s:歩" などの文字列） */
function shogiStateForSave(state) {
  return { ...state, board: encodeShogiBoard(state.board) };
}

function getShogiPlayer(room) {
  if (!currentUser || !room) return null;
  const members = Array.isArray(room.members) ? room.members : [];
  const index = members.indexOf(username);
  if (index === 0) return "sente";
  if (index === 1) return "gote";
  return null;
}

/* ----- 画面 ----- */
let shogiSelectionMoveCount = null;
let shogiPromotionPending = false;

function getShogiTargets(state, viewer) {
  if (!selectedShogiPiece || !viewer || state.winner || state.currentPlayer !== viewer) return [];
  if (selectedShogiPiece.type === "hand") return getShogiLegalDrops(state.board, state.captured[viewer], selectedShogiPiece.piece, viewer);
  const piece = state.board[selectedShogiPiece.row]?.[selectedShogiPiece.col];
  if (!piece || piece.o !== viewer) return [];
  return getShogiLegalMovesFrom(state.board, selectedShogiPiece.row, selectedShogiPiece.col);
}

function renderShogiHand(state, owner, viewer, room) {
  const hand = state.captured[owner] || [];
  const box = document.createElement("div");
  box.className = `shogi-hand ${owner === viewer ? "mine" : "theirs"}`;
  box.dataset.owner = owner;
  const label = document.createElement("span");
  label.className = "shogi-hand-label";
  const members = Array.isArray(room.members) ? room.members : [];
  const name = owner === "sente" ? members[0] : members[1];
  label.textContent = `${owner === "sente" ? "☗先手" : "☖後手"}${name ? `（${name}）` : ""} 持ち駒`;
  box.appendChild(label);

  const counts = SHOGI_HAND_ORDER.map((piece) => [piece, hand.filter((p) => p === piece).length]).filter(([, n]) => n > 0);
  if (!counts.length) {
    const none = document.createElement("span");
    none.className = "shogi-hand-empty";
    none.textContent = "なし";
    box.appendChild(none);
  }
  const canUse = owner === viewer && state.currentPlayer === viewer && !state.winner;
  counts.forEach(([piece, n]) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "shogi-hand-piece";
    button.dataset.piece = piece;
    button.innerHTML = `<span class="shogi-piece${owner === viewer ? "" : " theirs"}">${escapeHTML(piece)}</span>${n > 1 ? `<small>×${n}</small>` : ""}`;
    if (selectedShogiPiece?.type === "hand" && selectedShogiPiece.piece === piece && owner === viewer) button.classList.add("selected");
    button.disabled = !canUse;
    if (canUse) button.addEventListener("click", () => handleShogiHandClick(room, piece));
    box.appendChild(button);
  });
  return box;
}

function renderShogiBoard(container, room) {
  if (!container) return;

  const state = ensureShogiState(room.gameState || createInitialGameState("shogi"));
  const viewer = getShogiPlayer(room);
  const view = viewer || "sente"; /* 観戦者は先手側から見る */
  const flip = view === "gote";

  /* 盤面が進んだら（自分・相手が指したら）選択を解除する */
  if (shogiSelectionMoveCount !== state.moveCount) { selectedShogiPiece = null; shogiSelectionMoveCount = state.moveCount; }
  const targets = getShogiTargets(state, viewer);

  container.innerHTML = "";
  const wrapper = document.createElement("div");
  wrapper.className = "shogi-wrapper";
  wrapper.dataset.view = view;

  const members = Array.isArray(room.members) ? room.members : [];
  const info = document.createElement("div");
  info.className = "game-info shogi-info";
  const turnText = state.currentPlayer === "sente" ? "☗ 先手の番" : "☖ 後手の番";
  let status;
  if (state.winner) {
    status = `${state.winner === "sente" ? "☗ 先手" : "☖ 後手"}の勝ち${state.winReason === "checkmate" ? "（詰み）" : ""}`;
    if (viewer) status += viewer === state.winner ? "　🎉 あなたの勝ちです" : "　あなたの負けです";
  } else if (members.length < 2) {
    status = "対戦相手の参加を待っています";
  } else {
    status = viewer ? (state.currentPlayer === viewer ? `${turnText}（あなたの番です）` : `${turnText}（相手の番です）`) : turnText;
    if (isShogiInCheck(state.board, state.currentPlayer)) status += "　⚠️ 王手";
  }
  info.innerHTML = `<div class="shogi-status">${escapeHTML(status)}</div>${viewer ? `<div class="shogi-you">あなたは ${viewer === "sente" ? "☗先手" : "☖後手"}（自分の駒が下）</div>` : `<div class="shogi-you">観戦中（先手側から表示）</div>`}`;
  wrapper.appendChild(info);

  wrapper.appendChild(renderShogiHand(state, shogiOpponent(view), viewer, room));

  const boardElement = document.createElement("div");
  boardElement.className = "shogi-board";
  const kingInCheck = !state.winner && isShogiInCheck(state.board, state.currentPlayer) ? findShogiKing(state.board, state.currentPlayer) : null;
  const last = state.lastMove;

  for (let displayRow = 0; displayRow < 9; displayRow++) {
    for (let displayCol = 0; displayCol < 9; displayCol++) {
      const row = flip ? 8 - displayRow : displayRow;
      const col = flip ? 8 - displayCol : displayCol;
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "shogi-cell";
      cell.dataset.row = row;
      cell.dataset.col = col;

      const piece = state.board[row][col];
      if (piece) {
        const pieceElement = document.createElement("span");
        pieceElement.className = "shogi-piece";
        if (piece.o !== view) pieceElement.classList.add("theirs"); /* 相手の駒は逆向き（自分から見て読めない向き） */
        if (isPromotedShogiPiece(piece.p)) pieceElement.classList.add("promoted");
        if (piece.p.length > 1) pieceElement.classList.add("two");
        pieceElement.dataset.owner = piece.o;
        pieceElement.textContent = piece.p;
        cell.appendChild(pieceElement);
      }

      if (selectedShogiPiece?.type === "board" && selectedShogiPiece.row === row && selectedShogiPiece.col === col) cell.classList.add("selected");
      const target = targets.find((t) => t.row === row && t.col === col);
      if (target) cell.classList.add(target.capture ? "capture-target" : "move-target");
      if (last && ((last.to?.row === row && last.to?.col === col) || (last.from?.row === row && last.from?.col === col))) cell.classList.add("last-move");
      if (kingInCheck && kingInCheck.row === row && kingInCheck.col === col) cell.classList.add("in-check");

      cell.addEventListener("click", () => handleShogiCellClick(room, row, col));
      boardElement.appendChild(cell);
    }
  }
  wrapper.appendChild(boardElement);
  wrapper.appendChild(renderShogiHand(state, view, viewer, room));

  container.appendChild(wrapper);
}

function canOperateShogi(room, state, viewer) {
  if (!viewer || state.winner || shogiPromotionPending) return false;
  const members = Array.isArray(room.members) ? room.members : [];
  if (members.length < 2) return false;
  return state.currentPlayer === viewer;
}

function handleShogiHandClick(room, piece) {
  const state = ensureShogiState(room.gameState);
  const viewer = getShogiPlayer(room);
  if (!state || !canOperateShogi(room, state, viewer)) return;
  if (!state.captured[viewer].includes(piece)) return;
  selectedShogiPiece = selectedShogiPiece?.type === "hand" && selectedShogiPiece.piece === piece ? null : { type: "hand", piece };
  renderCurrentGame(room);
}

async function handleShogiCellClick(room, row, col) {
  const state = ensureShogiState(room.gameState);
  const viewer = getShogiPlayer(room);
  if (!state || !canOperateShogi(room, state, viewer)) return;

  const piece = state.board[row][col];
  const targets = getShogiTargets(state, viewer);
  const target = targets.find((t) => t.row === row && t.col === col);

  if (selectedShogiPiece && target) {
    let move;
    if (selectedShogiPiece.type === "hand") {
      move = { type: "drop", piece: selectedShogiPiece.piece, to: { row, col } };
    } else {
      const from = { row: selectedShogiPiece.row, col: selectedShogiPiece.col };
      let promote = target.mustPromote;
      if (!promote && target.canPromote) {
        const answer = await askShogiPromotion(state.board[from.row][from.col].p);
        if (answer === null) return; /* やめた */
        promote = answer;
      }
      move = { type: "move", from, to: { row, col }, promote };
    }
    await executeShogiMove(room, move, viewer);
    return;
  }

  if (piece && piece.o === viewer) {
    const same = selectedShogiPiece?.type === "board" && selectedShogiPiece.row === row && selectedShogiPiece.col === col;
    selectedShogiPiece = same ? null : { type: "board", row, col };
  } else {
    selectedShogiPiece = null;
  }
  renderCurrentGame(room);
}

/* 成る・成らないを選ぶ（画面の上に出す。選ぶまで他の操作はできない）。true＝成る、false＝成らない、null＝やめる */
function askShogiPromotion(piece) {
  shogiPromotionPending = true;
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "shogi-promote-overlay";
    overlay.innerHTML = `
      <div class="shogi-promote-dialog" role="dialog" aria-label="成りますか？">
        <div class="shogi-promote-title">成りますか？</div>
        <div class="shogi-promote-options">
          <button type="button" data-answer="yes"><span class="shogi-piece promoted">${escapeHTML(SHOGI_PROMOTED[piece])}</span>成る</button>
          <button type="button" data-answer="no"><span class="shogi-piece">${escapeHTML(piece)}</span>成らない</button>
        </div>
        <button type="button" class="shogi-promote-cancel" data-answer="cancel">やめる</button>
      </div>`;
    const finish = (answer) => {
      shogiPromotionPending = false;
      overlay.remove();
      resolve(answer);
    };
    overlay.addEventListener("click", (event) => {
      const button = event.target.closest("[data-answer]");
      if (!button) return;
      finish(button.dataset.answer === "yes" ? true : button.dataset.answer === "no" ? false : null);
    });
    document.body.appendChild(overlay);
  });
}

/* 手を指す：最新の対局データをトランザクションで読み、同じルールで合法かを確かめてから保存する
   （相手と同時に操作しても、手番・盤面が食い違った手は保存されない。保存後は購読中のスナップショットで画面が更新される） */
async function executeShogiMove(room, move, viewer) {
  const roomRef = doc(db, "gameRooms", room.id);
  try {
    await runTransaction(db, async (transaction) => {
      const snapshot = await transaction.get(roomRef);
      if (!snapshot.exists()) throw new Error("ルームが存在しません");
      const latest = snapshot.data();
      const members = Array.isArray(latest.members) ? latest.members : [];
      if (members.length < 2) throw new Error("対戦相手がいません");
      const owner = members.indexOf(username) === 0 ? "sente" : members.indexOf(username) === 1 ? "gote" : null;
      if (!owner || owner !== viewer) throw new Error("このゲームの参加者ではありません");
      const state = ensureShogiState(gameStateFromFirestore("shogi", latest.gameState));
      const next = applyShogiMove(state, move, owner);
      transaction.update(roomRef, {
        gameState: gameStateToFirestore("shogi", shogiStateForSave(next)),
        updatedAt: serverTimestamp()
      });
    });
    selectedShogiPiece = null;
  } catch (error) {
    /* ルール上指せない手（手番違い・同時操作で先に別の手が保存された等）は警告だけ。通信などの失敗はエラーとして記録 */
    if (error?.code) console.error("将棋の手エラー:", error); else console.warn("将棋：指せない手", error.message);
    selectedShogiPiece = null;
    if (error.message !== "ルームが存在しません") alert(error.message || "駒を動かせませんでした。");
  }
}

/* =========================================================
   大富豪
========================================================= */

const DAIHUGO_SUITS = ["♠", "♥", "♦", "♣"];
const DAIHUGO_RANK_LABELS = { 3:"3",4:"4",5:"5",6:"6",7:"7",8:"8",9:"9",10:"10",11:"J",12:"Q",13:"K",14:"A",15:"2" };

function applyDaifugoRules(state) {
  if (!state) return state;
  if (typeof state.revolution !== "boolean") state.revolution = false;
  if (typeof state.elevenBack !== "boolean") state.elevenBack = false;
  if (!("lockSuit" in state)) state.lockSuit = null;
  if (!Array.isArray(state.passedPlayers)) state.passedPlayers = [];
  return state;
}

/* ----- ルール設定 -----
   ・部屋作成者が gameRooms/{id}.rules に保存し、開始時に gameState.rules へコピーする
   ・rules が無い古い部屋・ゲームはデフォルト（今までの動きと同じ）として扱う */

const DAIFUGO_DEFAULT_RULES = {
  revolution: true, eightCut: true, elevenBack: true, suitLock: true,
  sequence: true, joker: true, spade3: false, miyakoOchi: false
};

const DAIFUGO_RULE_LABELS = {
  revolution: "革命", eightCut: "8切り", elevenBack: "11バック", suitLock: "しばり",
  sequence: "階段", joker: "ジョーカー", spade3: "スペ3返し", miyakoOchi: "都落ち"
};

function getDaifugoRules(source) {
  const saved = source?.rules || {};
  const rules = {};
  Object.keys(DAIFUGO_DEFAULT_RULES).forEach((key) => {
    rules[key] = typeof saved[key] === "boolean" ? saved[key] : DAIFUGO_DEFAULT_RULES[key];
  });
  return rules;
}

function getDaifugoRuleSummary(rules) {
  const enabled = Object.keys(DAIFUGO_RULE_LABELS).filter((key) => rules[key]).map((key) => DAIFUGO_RULE_LABELS[key]);
  return enabled.length ? enabled.join(" / ") : "特殊ルールなし";
}

async function updateDaifugoRule(roomId, key, value) {
  if (!currentUser || !(key in DAIFUGO_DEFAULT_RULES)) return false;
  if (isGameUnderMaintenance("daifugo")) { alert(GAME_MAINTENANCE_ALERT); return false; }
  const roomRef = doc(db, "gameRooms", roomId);

  try {
    await runTransaction(db, async (transaction) => {
      const snapshot = await transaction.get(roomRef);
      if (!snapshot.exists()) throw new Error("ROOM_NOT_FOUND");

      const room = snapshot.data();
      if (room.ownerUid !== currentUser.uid) throw new Error("NOT_HOST");
      if (room.gameState?.phase === "playing") throw new Error("GAME_PLAYING");

      const rules = getDaifugoRules(room);
      rules[key] = Boolean(value);
      transaction.update(roomRef, { rules, updatedAt: serverTimestamp() });
    });
    return true;
  } catch (error) {
    console.error("大富豪ルール変更エラー:", error);
    if (error.message === "NOT_HOST") alert("部屋を作った人だけがルールを変更できます。");
    else if (error.message === "GAME_PLAYING") alert("ゲーム中はルールを変更できません。");
    else alert("ルールを変更できませんでした。");
    return false;
  }
}

/* 革命と11バックが両方かかっている場合は元に戻る */
function isDaifugoReversed(game) {
  return Boolean(game?.revolution) !== Boolean(game?.elevenBack);
}

function isDaifugoSpade3Return(selectedCards, lastPlayed, rules) {
  if (!rules.spade3) return false;
  if (selectedCards.length !== 1 || (lastPlayed || []).length !== 1) return false;
  const card = selectedCards[0];
  return Boolean(lastPlayed[0].isJoker) && !card.isJoker && card.suit === "♠" && card.value === 3;
}

/* まだ使われていない一番上の順位（都落ちで最下位が先に埋まっても正しく数える） */
function getNextDaifugoRank(players) {
  const taken = new Set(players.filter((p) => p.finished && p.rank).map((p) => p.rank));
  let rank = 1;
  while (taken.has(rank)) rank++;
  return rank;
}

function createDaifugoDeck(includeJoker = true) {
  const deck = [];
  DAIHUGO_SUITS.forEach((suit) => {
    Object.keys(DAIHUGO_RANK_LABELS).forEach((rank) => {
      deck.push({ id: `${suit}-${rank}-${Math.random().toString(36).slice(2)}`, suit, value: Number(rank), label: DAIHUGO_RANK_LABELS[rank], isJoker: false });
    });
  });
  if (includeJoker) {
    deck.push({ id: `joker1-${Math.random().toString(36).slice(2)}`, suit: "🃏", value: 16, label: "Joker", isJoker: true });
    deck.push({ id: `joker2-${Math.random().toString(36).slice(2)}`, suit: "🃏", value: 16, label: "Joker", isJoker: true });
  }
  return deck;
}

function shuffleDaifugoDeck(deck) {
  const result = [...deck];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function dealDaifugoCards(deck, playerCount) {
  const hands = Array.from({ length: playerCount }, () => []);
  deck.forEach((card, index) => hands[index % playerCount].push(card));
  hands.forEach((hand) => hand.sort((a, b) => a.value - b.value));
  return hands;
}

async function startDaifugoGame(roomId) {
  if (!currentUser) return;
  if (isGameUnderMaintenance("daifugo")) return alert(GAME_MAINTENANCE_ALERT);

  try {
    const roomRef = doc(db, "gameRooms", roomId);

    await runTransaction(db, async (transaction) => {
      const snapshot = await transaction.get(roomRef);
      if (!snapshot.exists()) throw new Error("ROOM_NOT_FOUND");

      const room = snapshot.data();
      if (room.ownerUid !== currentUser.uid) throw new Error("NOT_HOST");
      if (room.gameState?.phase === "playing") throw new Error("ALREADY_STARTED");

      const memberUids = Array.isArray(room.memberUids) ? room.memberUids : [];
      const memberNames = Array.isArray(room.members) ? room.members : [];
      if (memberUids.length < 2) throw new Error("NOT_ENOUGH_PLAYERS");

      /* 開始時点の部屋のルールを gameState に固定する（ゲーム中は変わらない） */
      const rules = getDaifugoRules(room);
      const deck = shuffleDaifugoDeck(createDaifugoDeck(rules.joker));
      const hands = dealDaifugoCards(deck, memberUids.length);
      const handsByUid = {};
      memberUids.forEach((uid, index) => { handsByUid[uid] = hands[index]; });

      const players = memberUids.map((uid, index) => ({
        uid, name: memberNames[index] || "プレイヤー", finished: false, rank: null
      }));

      /* 前のゲームが終わっていれば「次のゲーム」として、前回の大富豪（1位）を記録する（都落ち用） */
      const previous = room.gameState || {};
      const isNextGame = previous.phase === "finished";
      const previousDaifugo = isNextGame ? (previous.players || []).find((p) => p.rank === 1) : null;
      const previousDaifugoUid = previousDaifugo && memberUids.includes(previousDaifugo.uid) ? previousDaifugo.uid : null;

      const gameState = applyDaifugoRules({
        phase: "playing", players, hands: handsByUid,
        currentPlayerUid: memberUids[0], lastPlayedCards: [], lastPlayerUid: null,
        passedPlayers: [], revolution: false, elevenBack: false, lockSuit: null, winner: null,
        rules, round: isNextGame ? (previous.round || 1) + 1 : 1, previousDaifugoUid
      });

      transaction.update(roomRef, { status: "playing", gameState, updatedAt: serverTimestamp() });
    });
  } catch (error) {
    console.error("大富豪開始エラー:", error);
    if (error.message === "NOT_HOST") alert("部屋を作った人だけが開始できます。");
    else if (error.message === "NOT_ENOUGH_PLAYERS") alert("2人以上参加してから開始してください。");
    else alert("大富豪を開始できませんでした。");
  }
}

function getMyDaifugoHand(room) {
  const hands = room?.gameState?.hands || {};
  return currentUser && Array.isArray(hands[currentUser.uid]) ? hands[currentUser.uid] : [];
}

function toggleDaifugoCard(cardId) {
  const index = selectedDaifugoCards.indexOf(cardId);
  if (index >= 0) selectedDaifugoCards.splice(index, 1);
  else selectedDaifugoCards.push(cardId);
}

function areSameDaifugoValue(cards) {
  if (!cards.length) return false;
  const normal = cards.filter((c) => !c.isJoker);
  if (normal.length === 0) return true;
  return normal.every((c) => c.value === normal[0].value);
}

function isDaifugoValidSequence(cards) {
  if (cards.length < 3) return false;
  const normal = cards.filter((c) => !c.isJoker);
  if (normal.length !== cards.length) return false;

  const suit = normal[0].suit;
  if (!normal.every((c) => c.suit === suit)) return false;

  const sorted = [...normal].sort((a, b) => a.value - b.value);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].value !== sorted[i - 1].value + 1) return false;
  }
  return true;
}

function getDaifugoCombinationType(cards, rules = DAIFUGO_DEFAULT_RULES) {
  if (!cards.length) return null;
  if (cards.length === 1) return "single";
  if (areSameDaifugoValue(cards)) return "group";
  if (rules.sequence && isDaifugoValidSequence(cards)) return "sequence";
  return null;
}

function getDaifugoCardPower(card, revolution) {
  if (!card) return 0;
  if (card.isJoker) return revolution ? 1 : 100;
  if (!revolution) return card.value;
  const table = { 3:15,4:14,5:13,6:12,7:11,8:10,9:9,10:8,11:7,12:6,13:5,14:4,15:3 };
  return table[card.value] || card.value;
}

function getDaifugoPlayPower(cards, revolution) {
  if (!cards.length) return 0;
  return Math.max(...cards.map((c) => getDaifugoCardPower(c, revolution)));
}

function canUseDaifugoSuitLock(selected, game) {
  if (!getDaifugoRules(game).suitLock) return true;
  if (!game?.lockSuit) return true;
  const normal = selected.filter((c) => !c.isJoker);
  if (!normal.length) return true;
  return normal.every((c) => c.suit === game.lockSuit);
}

function isDaifugoEightCut(cards) {
  return cards.some((c) => !c.isJoker && c.value === 8);
}

function canPlayDaifugoSelection(selectedCards, game) {
  if (!selectedCards.length || !game) return false;
  const rules = getDaifugoRules(game);
  if (!canUseDaifugoSuitLock(selectedCards, game)) return false;

  const type = getDaifugoCombinationType(selectedCards, rules);
  if (!type) return false;

  const lastPlayed = Array.isArray(game.lastPlayedCards) ? game.lastPlayedCards : [];
  if (lastPlayed.length === 0) return true;
  if (selectedCards.length !== lastPlayed.length) return false;
  /* 場と同じ種類（1枚 / 同じ数字 / 階段）でないと出せない */
  if (type !== getDaifugoCombinationType(lastPlayed, rules)) return false;
  if (isDaifugoSpade3Return(selectedCards, lastPlayed, rules)) return true;
  if (rules.eightCut && isDaifugoEightCut(selectedCards)) return true;

  const reversed = isDaifugoReversed(game);
  const selectedPower = getDaifugoPlayPower(selectedCards, reversed);
  const lastPower = getDaifugoPlayPower(lastPlayed, reversed);
  return selectedPower > lastPower;
}

function updateDaifugoLock(game, selectedCards, previousCards) {
  const prevNormal = (previousCards || []).filter((c) => !c.isJoker);
  const selNormal = selectedCards.filter((c) => !c.isJoker);

  if (!prevNormal.length || !selNormal.length) { game.lockSuit = null; return; }

  const prevSuit = prevNormal[0].suit;
  const selSuit = selNormal[0].suit;

  if (prevSuit === selSuit && selNormal.every((c) => c.suit === selSuit)) {
    game.lockSuit = selSuit;
  } else {
    game.lockSuit = null;
  }
}

function clearDaifugoTable(game) {
  game.lastPlayedCards = [];
  game.lastPlayerUid = null;
  game.passedPlayers = [];
  game.lockSuit = null;
  /* 11バックは場が流れるまで */
  game.elevenBack = false;
}

function findNextDaifugoPlayer(room, game, fromUid) {
  const memberUids = Array.isArray(room.memberUids) ? room.memberUids : [];
  const players = game.players || [];
  const fromIndex = memberUids.indexOf(fromUid);

  for (let i = 1; i <= memberUids.length; i++) {
    const idx = (fromIndex + i) % memberUids.length;
    const uid = memberUids[idx];
    const player = players.find((p) => p.uid === uid);
    if (player && !player.finished) return uid;
  }
  return fromUid;
}

function getDaifugoRuleStatus(game) {
  const status = [];
  if (game.revolution) status.push("🔄 革命");
  if (game.elevenBack) status.push("↩️ 11バック");
  if (game.lockSuit) status.push(`🔒 ${game.lockSuit}縛り`);
  return status.length ? status.join("　") : "通常状態";
}

function buildDaifugoCardElement(card, isSelected, interactive) {
  const isRed = card.suit === "♥" || card.suit === "♦";
  const el = document.createElement(interactive ? "button" : "div");
  if (interactive) el.type = "button";
  el.className = `playing-card daifugo-card ${isRed ? "red" : "black"}`;
  if (card.isJoker) el.classList.add("joker");
  if (isSelected) el.classList.add("selected");
  if (!interactive) el.classList.add("daifugo-field-card");

  const suit = document.createElement("span");
  suit.className = "card-suit";
  suit.textContent = card.suit;

  const rank = document.createElement("span");
  rank.className = "card-rank";
  rank.textContent = card.label;

  el.append(suit, rank);
  return el;
}

/* ゲーム開始前のルール設定パネル（部屋作成者だけ変更できる） */
function buildDaifugoRulesPanel(room) {
  const rules = getDaifugoRules(room);
  const isHost = room.ownerUid === currentUser?.uid;

  const panel = document.createElement("div");
  panel.className = "daifugo-rules";

  const title = document.createElement("h4");
  title.textContent = isHost ? "ルール設定（開始前に変更できます）" : "この部屋のルール（部屋を作った人が設定します）";
  panel.appendChild(title);

  const list = document.createElement("div");
  list.className = "daifugo-rules-list";

  Object.keys(DAIFUGO_RULE_LABELS).forEach((key) => {
    const label = document.createElement("label");
    label.className = "daifugo-rule";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = rules[key];
    input.disabled = !isHost;
    input.addEventListener("change", async () => {
      input.disabled = true;
      const ok = await updateDaifugoRule(room.id, key, input.checked);
      if (!ok) input.checked = !input.checked;
      input.disabled = false;
    });

    const text = document.createElement("span");
    text.textContent = DAIFUGO_RULE_LABELS[key] + (key === "spade3" ? "（要ジョーカー）" : "");

    label.append(input, text);
    list.appendChild(label);
  });

  panel.appendChild(list);
  return panel;
}

function renderDaifugoGame(container, room) {
  if (!container) return;
  const game = applyDaifugoRules(room.gameState || createInitialGameState("daifugo"));

  container.innerHTML = "";
  const wrapper = document.createElement("div");
  wrapper.className = "daifugo-wrapper";

  if (game.phase !== "playing") {
    const members = Array.isArray(room.members) ? room.members : [];
    const canStart = room.ownerUid === currentUser?.uid && members.length >= 2;
    const isFinished = game.phase === "finished";

    wrapper.innerHTML = `<div class="game-info">参加者 ${members.length}/${getMaxGamePlayers(room.gameType)}人（2人以上でゲーム開始できます）</div>`;

    /* 前のゲームの結果（都落ちの確認用） */
    if (isFinished && (game.players || []).length) {
      const result = document.createElement("div");
      result.className = "daifugo-last-result";
      const ranked = [...game.players].sort((a, b) => (a.rank || 99) - (b.rank || 99));
      result.innerHTML = `<h4>前回の結果</h4>` + ranked.map((p) =>
        `<div>${p.rank || "-"}位　${escapeHTML(p.name)}${p.fallen ? "（都落ち）" : ""}</div>`).join("");
      wrapper.appendChild(result);
    }

    wrapper.appendChild(buildDaifugoRulesPanel(room));

    if (canStart) {
      const startButton = document.createElement("button");
      startButton.type = "button";
      startButton.className = "primary-button";
      startButton.textContent = isFinished ? "次のゲームを開始する" : "ゲームを開始する";
      startButton.addEventListener("click", () => startDaifugoGame(room.id));
      wrapper.appendChild(startButton);
    }

    container.appendChild(wrapper);
    return;
  }

  const status = document.createElement("div");
  status.className = "game-status";

  if (game.winner) {
    const winnerPlayer = (game.players || []).find((p) => p.uid === game.winner);
    status.textContent = `🏆 ${winnerPlayer?.name || "プレイヤー"} の勝ち！`;
  } else {
    const current = (game.players || []).find((p) => p.uid === game.currentPlayerUid);
    status.textContent = `現在の番：${current?.name || ""}　${getDaifugoRuleStatus(game)}`;
  }
  wrapper.appendChild(status);

  const rulesLine = document.createElement("div");
  rulesLine.className = "daifugo-rules-summary";
  rulesLine.textContent = `ルール：${getDaifugoRuleSummary(getDaifugoRules(game))}`;
  wrapper.appendChild(rulesLine);

  const field = document.createElement("div");
  field.className = "daifugo-field";

  if ((game.lastPlayedCards || []).length) {
    const fieldLabel = document.createElement("div");
    fieldLabel.className = "daifugo-field-label";
    fieldLabel.textContent = "場";
    field.appendChild(fieldLabel);

    const fieldCards = document.createElement("div");
    fieldCards.className = "daifugo-field-cards";
    game.lastPlayedCards.forEach((c) => {
      fieldCards.appendChild(buildDaifugoCardElement(c, false, false));
    });
    field.appendChild(fieldCards);
  } else {
    field.innerHTML = `<div class="daifugo-field-label">場</div><div class="daifugo-field-empty">まだ何も出ていません</div>`;
  }
  wrapper.appendChild(field);

  const myHand = getMyDaifugoHand(room);
  const isMyTurn = game.currentPlayerUid === currentUser?.uid && !game.winner;

  const handTitleRow = document.createElement("div");
  handTitleRow.className = "daifugo-hand-title-row";

  const handTitle = document.createElement("h4");
  handTitle.textContent = `あなたの手札（${myHand.length}枚）`;
  handTitleRow.appendChild(handTitle);

  if (selectedDaifugoCards.length > 0) {
    const selectedCount = document.createElement("span");
    selectedCount.className = "daifugo-selected-count";
    selectedCount.textContent = `${selectedDaifugoCards.length}枚 選択中`;
    handTitleRow.appendChild(selectedCount);
  }
  wrapper.appendChild(handTitleRow);

  const hand = document.createElement("div");
  hand.className = "daifugo-hand";

  myHand.forEach((card) => {
    const isSelected = selectedDaifugoCards.includes(card.id);
    const button = buildDaifugoCardElement(card, isSelected, true);
    button.disabled = !isMyTurn;
    button.addEventListener("click", () => { toggleDaifugoCard(card.id); renderCurrentGame(room); });
    hand.appendChild(button);
  });
  wrapper.appendChild(hand);

  const controls = document.createElement("div");
  controls.className = "game-controls";

  const playButton = document.createElement("button");
  playButton.type = "button";
  playButton.className = "primary-button daifugo-play-button";
  playButton.textContent = selectedDaifugoCards.length > 0 ? `このカードを出す（${selectedDaifugoCards.length}枚）` : "カードを出す";
  playButton.disabled = !isMyTurn || selectedDaifugoCards.length === 0;
  playButton.classList.toggle("is-ready", !playButton.disabled);
  playButton.addEventListener("click", () => playDaifugoCards(room.id));

  const passButton = document.createElement("button");
  passButton.type = "button";
  passButton.className = "secondary-button";
  passButton.textContent = "パス";
  passButton.disabled = !isMyTurn || (game.lastPlayedCards || []).length === 0;
  passButton.addEventListener("click", () => passDaifugoTurn(room.id));

  controls.append(playButton, passButton);
  wrapper.appendChild(controls);

  const playersTitle = document.createElement("h4");
  playersTitle.textContent = "プレイヤー";
  wrapper.appendChild(playersTitle);

  const playersEl = document.createElement("div");
  playersEl.className = "daifugo-players";
  (game.players || []).forEach((player) => {
    const item = document.createElement("div");
    item.className = "daifugo-player";
    if (player.uid === game.currentPlayerUid) item.classList.add("current");
    const handCount = (game.hands?.[player.uid] || []).length;
    const crown = player.uid === game.previousDaifugoUid && getDaifugoRules(game).miyakoOchi ? "👑" : "";
    if (player.fallen) item.textContent = `${crown}${player.name}　都落ち(${player.rank}位)`;
    else item.textContent = player.finished ? `${crown}${player.name}　上がり(${player.rank}位)` : `${crown}${player.name}　${handCount}枚`;
    playersEl.appendChild(item);
  });
  wrapper.appendChild(playersEl);

  container.appendChild(wrapper);
}

async function playDaifugoCards(roomId) {
  if (!currentUser) return;
  if (isGameUnderMaintenance("daifugo")) return alert(GAME_MAINTENANCE_ALERT);
  if (selectedDaifugoCards.length === 0) return alert("カードを選択してください。");

  const roomRef = doc(db, "gameRooms", roomId);

  try {
    await runTransaction(db, async (transaction) => {
      const snapshot = await transaction.get(roomRef);
      if (!snapshot.exists()) throw new Error("ROOM_NOT_FOUND");

      const room = snapshot.data();
      const game = applyDaifugoRules(room.gameState);
      if (!game || game.phase !== "playing") throw new Error("GAME_FINISHED");
      if (game.currentPlayerUid !== currentUser.uid) throw new Error("NOT_YOUR_TURN");

      const hands = game.hands || {};
      const myHand = Array.isArray(hands[currentUser.uid]) ? [...hands[currentUser.uid]] : [];
      const selected = myHand.filter((card) => selectedDaifugoCards.includes(card.id));

      if (selected.length !== selectedDaifugoCards.length) throw new Error("CARD_NOT_FOUND");

      const rules = getDaifugoRules(game);
      const previousCards = Array.isArray(game.lastPlayedCards) ? [...game.lastPlayedCards] : [];

      /* 8切りも含めて、出せる組み合わせかを必ず確認する */
      if (!canPlayDaifugoSelection(selected, game)) {
        throw new Error("INVALID_COMBINATION");
      }

      const isEightCut = rules.eightCut && isDaifugoEightCut(selected);
      const isSpade3Return = isDaifugoSpade3Return(selected, previousCards, rules);
      const isRevolution = rules.revolution && selected.length >= 4 && areSameDaifugoValue(selected);
      const isElevenBack = rules.elevenBack && selected.some((c) => !c.isJoker && c.value === 11);

      hands[currentUser.uid] = myHand.filter((card) => !selectedDaifugoCards.includes(card.id));

      const players = (game.players || []).map((p) => ({ ...p }));
      const myPlayer = players.find((p) => p.uid === currentUser.uid);

      if (hands[currentUser.uid].length === 0 && myPlayer && !myPlayer.finished) {
        const isFirstFinisher = !players.some((p) => p.finished && !p.fallen);
        myPlayer.finished = true;
        myPlayer.rank = getNextDaifugoRank(players);

        /* 都落ち：前回の大富豪以外が最初に上がったら、前回の大富豪はその場で最下位 */
        if (rules.miyakoOchi && isFirstFinisher && game.previousDaifugoUid && game.previousDaifugoUid !== currentUser.uid) {
          const fallenPlayer = players.find((p) => p.uid === game.previousDaifugoUid && !p.finished);
          if (fallenPlayer) {
            fallenPlayer.finished = true;
            fallenPlayer.fallen = true;
            fallenPlayer.rank = players.length;
          }
        }
      }

      game.hands = hands;
      game.players = players;
      game.lastPlayedCards = selected;
      game.lastPlayerUid = currentUser.uid;

      if (isRevolution) game.revolution = !game.revolution;
      if (isElevenBack) game.elevenBack = !game.elevenBack;
      if (rules.suitLock) updateDaifugoLock(game, selected, previousCards);
      else game.lockSuit = null;

      const activePlayers = players.filter((p) => !p.finished);
      if (activePlayers.length <= 1) {
        if (activePlayers.length === 1) {
          activePlayers[0].finished = true;
          activePlayers[0].rank = getNextDaifugoRank(players);
        }
        game.phase = "finished";
        game.winner = players.find((p) => p.rank === 1)?.uid || myPlayer?.uid || null;
      } else if (isEightCut || isSpade3Return) {
        /* 場を流して、出した人からもう一度（上がっていたら次の人） */
        clearDaifugoTable(game);
        game.currentPlayerUid = myPlayer?.finished ? findNextDaifugoPlayer(room, game, currentUser.uid) : currentUser.uid;
      } else {
        game.currentPlayerUid = findNextDaifugoPlayer(room, game, currentUser.uid);
      }

      transaction.update(roomRef, { gameState: game, updatedAt: serverTimestamp() });
    });

    selectedDaifugoCards = [];
  } catch (error) {
    console.error("大富豪エラー:", error);
    if (error.message === "NOT_YOUR_TURN") alert("今はあなたの番ではありません。");
    else if (error.message === "INVALID_COMBINATION") alert("そのカードの組み合わせは出せません。");
    else if (error.message === "GAME_FINISHED") alert("このゲームは終了しています。");
    else if (error.message !== "ROOM_NOT_FOUND") alert("カードを出せませんでした。");
  }
}

async function passDaifugoTurn(roomId) {
  if (!currentUser) return;
  if (isGameUnderMaintenance("daifugo")) return alert(GAME_MAINTENANCE_ALERT);
  const roomRef = doc(db, "gameRooms", roomId);

  try {
    await runTransaction(db, async (transaction) => {
      const snapshot = await transaction.get(roomRef);
      if (!snapshot.exists()) throw new Error("ROOM_NOT_FOUND");

      const room = snapshot.data();
      const game = applyDaifugoRules(room.gameState);
      if (!game || game.currentPlayerUid !== currentUser.uid) throw new Error("NOT_YOUR_TURN");
      if (!(game.lastPlayedCards || []).length) throw new Error("CANNOT_PASS");

      const players = game.players || [];
      const activePlayers = players.filter((p) => !p.finished);
      const passed = Array.isArray(game.passedPlayers) ? [...game.passedPlayers] : [];
      if (!passed.includes(currentUser.uid)) passed.push(currentUser.uid);

      if (activePlayers.every((p) => passed.includes(p.uid) || p.uid === game.lastPlayerUid)) {
        clearDaifugoTable(game);
        const restartUid = game.lastPlayerUid;
        const restartPlayer = players.find((p) => p.uid === restartUid && !p.finished);
        game.currentPlayerUid = restartPlayer ? restartUid : findNextDaifugoPlayer(room, game, currentUser.uid);
      } else {
        game.passedPlayers = passed;
        game.currentPlayerUid = findNextDaifugoPlayer(room, game, currentUser.uid);
      }

      transaction.update(roomRef, { gameState: game, updatedAt: serverTimestamp() });
    });

    selectedDaifugoCards = [];
  } catch (error) {
    console.error("大富豪パスエラー:", error);
    if (error.message === "NOT_YOUR_TURN") alert("今はあなたの番ではありません。");
    else if (error.message === "CANNOT_PASS") alert("最初のカードはパスできません。");
  }
}

/* =========================================================
   💰 ゆう経済（ゆう銀行・ゆう株・総資産・ログインボーナス）

   Firestore の使い方（無料枠を圧迫しないように）
   ・自分の銀行・株・ログインボーナスは users/{名前} の bank / stocks / lastLoginBonusDate に持つ。
     画面は、すでに常時購読している自分の users（listenMyCoins）から受け取る（新しい常時購読は作らない）
   ・株価は market/current、総資産ランキングは rankings/assets の1件ずつ。毎日 13:00 に自動処理（derby-runner）だけが書く。
     画面を開いたときに1回読み、次の 13:00 の更新までは読み直さない
   ・売買・預け入れ・引き出し・借入・返済は、自分の users だけを書き換えるトランザクション1回
   ・株価の更新・利息・返済期限切れの自動返済・ランキングの集計は、ブラウザでは行わない（derby-runner が1日1回）
   会社・銀行の設定は derby-runner/economy.mjs と同じにすること
========================================================= */

const STOCK_COMPANIES = [
  { code: "YGM", emoji: "🎮", name: "ユウゲームズ", sector: "ゲーム・エンタメ", initialPrice: 180 },
  { code: "YMT", emoji: "🛒", name: "ユウマート", sector: "小売・通販", initialPrice: 240 },
  { code: "YFD", emoji: "🍔", name: "ユウフーズ", sector: "食品・飲食", initialPrice: 150 },
  { code: "YEN", emoji: "⚡", name: "ユウエナジー", sector: "エネルギー", initialPrice: 280 },
  { code: "YPY", emoji: "💳", name: "ユウペイ", sector: "決済・金融", initialPrice: 210 }
];
const ECONOMY_UPDATE_HOUR = 13;
const BANK_INTEREST_RATE = 0.01;
const BANK_INTEREST_MAX = 100;
const BANK_LOAN_AMOUNT = 500;
const BANK_LOAN_MAX_COINS = 100;
const BANK_LOAN_DAYS = 7;
const LOGIN_BONUS_COINS = 50;
const ECONOMY_RECHECK_MS = 10 * 60 * 1000; /* 13:00 を過ぎてもまだ更新されていないときに読み直す間隔 */
const ECONOMY_MAX_TRADE_QTY = 100000;

let marketCache = null;   /* { data, fetchedAt } */
let rankingCache = null;  /* { data, fetchedAt } */
let economyBusy = false;
let economyBankAmount = "";
const stockTradeQty = {};

function formatCoins(value) {
  return Math.round(Number(value) || 0).toLocaleString("ja-JP");
}

function formatEconomyDate(dateText) {
  const [, m, d] = String(dateText || "").split("-");
  return m && d ? `${Number(m)}/${Number(d)}` : "";
}

/* いま表示されているべき株価・ランキングの日付（13:00 より前なら前日の分） */
function expectedEconomyDate(now = derbyNow()) {
  const jst = toJstFields(now);
  const beforeUpdate = jst.getUTCHours() < ECONOMY_UPDATE_HOUR;
  return formatRaceId(beforeUpdate ? new Date(now.getTime() - 24 * 3600 * 1000) : now);
}

function economyCacheIsFresh(cache) {
  if (!cache) return false;
  if ((cache.data?.date || "") >= expectedEconomyDate()) return true;
  return Date.now() - cache.fetchedAt < ECONOMY_RECHECK_MS;
}

function rankingCacheIsFresh() {
  return economyCacheIsFresh(rankingCache);
}

function createInitialMarketData() {
  const companies = {};
  STOCK_COMPANIES.forEach((c) => {
    companies[c.code] = { price: c.initialPrice, prevPrice: c.initialPrice, changePct: 0, history: [c.initialPrice] };
  });
  return { date: "", companies, todayNews: [], events: [] };
}

/* 株価（market/current）。まだ一度も更新されていなければ初期株価 */
async function loadMarket() {
  if (economyCacheIsFresh(marketCache)) return marketCache.data;
  const snap = await getDoc(doc(db, "market", "current"));
  const data = snap.exists() ? snap.data() : createInitialMarketData();
  marketCache = { data, fetchedAt: Date.now() };
  return data;
}

async function loadAssetRanking() {
  if (rankingCacheIsFresh()) return rankingCache.data;
  const snap = await getDoc(doc(db, "rankings", "assets"));
  const data = snap.exists() ? snap.data() : null;
  rankingCache = { data, fetchedAt: Date.now() };
  return data;
}

function getStockPrice(market, code) {
  const company = STOCK_COMPANIES.find((c) => c.code === code);
  const price = Number(market?.companies?.[code]?.price);
  return Number.isFinite(price) && price > 0 ? price : (company ? company.initialPrice : 0);
}

function normalizeBankData(bank) {
  const b = bank && typeof bank === "object" ? bank : {};
  return {
    ...b,
    deposit: Math.max(0, Math.floor(Number(b.deposit) || 0)),
    interestBase: Math.max(0, Math.floor(Number(b.interestBase) || 0)),
    loan: Math.max(0, Math.floor(Number(b.loan) || 0))
  };
}

function normalizeStocksData(stocks) {
  const result = {};
  Object.entries(stocks && typeof stocks === "object" ? stocks : {}).forEach(([code, h]) => {
    const qty = Math.max(0, Math.floor(Number(h?.qty) || 0));
    if (qty > 0) result[code] = { qty, cost: Math.max(0, Math.round(Number(h?.cost) || 0)) };
  });
  return result;
}

/* 総資産 = 手持ちコイン + 銀行預金 + 保有株の評価額 − 借入残高 */
function computeMyAssets(data, market) {
  const bank = normalizeBankData(data?.bank);
  const stocks = normalizeStocksData(data?.stocks);
  const coins = Number(data?.coins) || 0;
  const stockValue = Object.entries(stocks).reduce((sum, [code, h]) => sum + h.qty * getStockPrice(market, code), 0);
  return { coins, deposit: bank.deposit, stockValue, loan: bank.loan, total: coins + bank.deposit + stockValue - bank.loan };
}

function isLoanOverdue(bank, now = derbyNow()) {
  const due = toDateValue(bank.loanDueAt);
  return bank.loan > 0 && (bank.overdue === true || (due && due <= now));
}

/* ----- ログインボーナス（1日50コイン・日本時間・1日1回） -----
   その日はじめて自分の users を受け取ったときに、トランザクションの中で lastLoginBonusDate を確かめてから加算する。
   複数のタブ・再読み込み・複数の端末から同時に開いても1回だけ */
let loginBonusInFlight = false;
let loginBonusCheckedDate = null;

function resetLoginBonusState() {
  loginBonusInFlight = false;
  loginBonusCheckedDate = null;
}

async function grantLoginBonusIfNeeded(data) {
  const today = getTodayRaceId();
  if (!username || !currentUser || loginBonusInFlight || loginBonusCheckedDate === today) return;
  if (!data || typeof data.coins !== "number" || data.lastLoginBonusDate === today) return;
  loginBonusInFlight = true;
  const requestedFor = username;
  try {
    const result = await callEconomyApi("loginBonus");
    if (requestedFor === username) loginBonusCheckedDate = today;
    if (result?.granted && requestedFor === username) showAppToast("🎁 ログインボーナス", `今日のログインボーナス +${LOGIN_BONUS_COINS}コイン`);
  } catch (error) {
    console.warn("ログインボーナスの付与に失敗:", error?.economyCode || error);
  } finally {
    loginBonusInFlight = false;
  }
}

/* ----- 自分の users を書き換えるトランザクション（売買・銀行の操作） ----- */
function economyError(code) {
  return Object.assign(new Error(code), { economyCode: code });
}

function parseEconomyAmount(value) {
  const n = Number(String(value ?? "").replace(/[,，\s]/g, ""));
  return Number.isInteger(n) && n > 0 ? n : null;
}

async function bankDeposit(amount) {
  return callEconomyApi("bankDeposit", { amount });
}

async function bankWithdraw(amount) {
  return callEconomyApi("bankWithdraw", { amount });
}

async function bankBorrow() {
  return callEconomyApi("bankBorrow");
}

/* 返済は一括だけ（期限切れの自動返済で一部が返されていれば、残りの全額） */
async function bankRepay() {
  return callEconomyApi("bankRepay");
}

async function tradeStock(code, side, qty) {
  const company = STOCK_COMPANIES.find((c) => c.code === code);
  if (!company) throw economyError("NO_COMPANY");
  return callEconomyApi("stockTrade", { code, side, qty });
}

const ECONOMY_ERROR_MESSAGES = {
  NOT_ENOUGH_COINS: "手持ちのゆうcoinが足りません。",
  NETWORK: "サーバーに接続できませんでした。時間をおいてもう一度お試しください。",
  RACE_CLOSED: "このレースは投票を受け付けていません（締切・発走済みなど）。",
  invalid_amount: "金額が正しくありません。",
  invalid_qty: "株数が正しくありません。",
  invalid_bet_type: "投票の種類が正しくありません。",
  invalid_horses: "馬の選び方が正しくありません。",
  busy: "ほかの操作と重なりました。もう一度お試しください。",
  NOT_ENOUGH_DEPOSIT: "預金が足りません。",
  NOT_ENOUGH_STOCK: "保有している株数が足りません。",
  LOAN_ACTIVE: "借入中は、預け入れ・新しい借入はできません。先に返済してください。",
  TOO_MANY_COINS: `緊急融資は、手持ちのゆうcoinが${BANK_LOAN_MAX_COINS}コイン以下のときだけ利用できます。`,
  NO_LOAN: "借入はありません。",
  NOT_LOGGED_IN: "ログインしてください。"
};

async function runEconomyAction(action, successMessage) {
  if (economyBusy) return;
  economyBusy = true;
  renderEconomyView();
  try {
    const result = await action();
    if (successMessage) showAppToast("💰 ゆう経済", typeof successMessage === "function" ? successMessage(result) : successMessage);
  } catch (error) {
    const message = ECONOMY_ERROR_MESSAGES[error?.economyCode];
    if (!message) console.error("ゆう経済の操作エラー:", error);
    alert(message || "処理できませんでした。時間をおいてもう一度お試しください。");
  } finally {
    economyBusy = false;
    renderEconomyView();
  }
}

/* ----- 画面 ----- */

async function openEconomyView() {
  renderEconomyView();
  const session = appSessionSeq;
  try {
    await Promise.all([loadMarket(), loadAssetRanking()]);
  } catch (error) {
    if (isInterruptedBySignOut(session)) return;
    console.error("ゆう経済の読み込みエラー:", error);
  }
  if (session === appSessionSeq) renderEconomyView();
}

function isEconomyViewActive() {
  return Boolean(economyView?.classList.contains("active"));
}

function renderSparkline(history, up) {
  const values = (Array.isArray(history) ? history : []).map(Number).filter((v) => Number.isFinite(v));
  if (values.length < 2) return `<div class="stock-spark stock-spark-empty">13:00 から値動きを表示します</div>`;
  const min = Math.min(...values), max = Math.max(...values);
  const span = max - min || 1;
  const points = values.map((v, i) => `${(i / (values.length - 1)) * 100},${(30 - ((v - min) / span) * 26 - 2).toFixed(1)}`).join(" ");
  return `<svg class="stock-spark ${up ? "up" : "down"}" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true"><polyline points="${points}" fill="none" vector-effect="non-scaling-stroke" /></svg>`;
}

function changeBadge(pct) {
  const value = Number(pct) || 0;
  const cls = value > 0 ? "up" : value < 0 ? "down" : "flat";
  const mark = value > 0 ? "▲" : value < 0 ? "▼" : "±";
  return `<span class="econ-change ${cls}">${mark}${Math.abs(value).toFixed(1)}%</span>`;
}

function renderEconomyView() {
  if (!economyContent) return;
  if (!currentUser || !username) { economyContent.innerHTML = ""; return; }

  const data = myLatestUserData && myLatestUserData.docId === username ? myLatestUserData : { coins: myCoins };
  const market = marketCache?.data || createInitialMarketData();
  const bank = normalizeBankData(data.bank);
  const stocks = normalizeStocksData(data.stocks);
  const assets = computeMyAssets(data, market);
  const now = derbyNow();
  const disabled = economyBusy ? "disabled" : "";
  const ranking = rankingCache?.data;
  const myRank = ranking?.users?.find?.((u) => u.name === username);

  /* 総資産 */
  const summaryHtml = `
    <section class="econ-card econ-summary" aria-label="総資産">
      <div class="econ-summary-main">
        <span class="econ-label">総資産</span>
        <strong class="econ-total ${assets.total < 0 ? "negative" : ""}">💰 ${formatCoins(assets.total)}</strong>
        <span class="econ-sub">${myRank ? `総資産ランキング ${myRank.rank}位 / ${ranking.users.length}人（${escapeHTML(formatEconomyDate(ranking.date))} 13:00 時点）` : "総資産ランキングは毎日13:00に更新されます"}</span>
      </div>
      <dl class="econ-breakdown">
        <div><dt>手持ち</dt><dd>🪙 ${formatCoins(assets.coins)}</dd></div>
        <div><dt>預金</dt><dd>🏦 ${formatCoins(assets.deposit)}</dd></div>
        <div><dt>株の評価額</dt><dd>📈 ${formatCoins(assets.stockValue)}</dd></div>
        <div><dt>借入</dt><dd class="${assets.loan > 0 ? "negative" : ""}">${assets.loan > 0 ? "−" : ""}${formatCoins(assets.loan)}</dd></div>
      </dl>
    </section>`;

  /* ゆう銀行 */
  const expectedInterest = Math.min(Math.floor(Math.min(bank.deposit, bank.interestBase) * BANK_INTEREST_RATE), BANK_INTEREST_MAX);
  const overdue = isLoanOverdue(bank, now);
  const due = toDateValue(bank.loanDueAt);
  const daysLeft = due ? Math.ceil((due.getTime() - now.getTime()) / (24 * 3600 * 1000)) : null;
  const auto = bank.lastAutoRepay;
  let loanHtml;
  if (bank.loan > 0) {
    loanHtml = `
      ${overdue ? `
        <div class="econ-alert" role="alert">
          <strong>⚠️ 返済期限を過ぎています</strong>
          ${auto ? `<div>自動返済額：<b>${formatCoins(auto.amount)}</b>コイン（預金 ${formatCoins(auto.fromDeposit)}・手持ち ${formatCoins(auto.fromCoins)}／${escapeHTML(formatEconomyDate(auto.date))} 13:00）</div>` : `<div>次の13:00に、預金 → 手持ちの順に自動で返済されます。</div>`}
          <div>残り借入：<b>${formatCoins(bank.loan)}</b>コイン</div>
          <small>残りの借入がある間は、毎日13:00に返せる分だけ自動で返済されます。新しい借入はできません。</small>
        </div>` : ""}
      <div class="econ-row"><span>借入残高</span><b class="negative">${formatCoins(bank.loan)}コイン</b></div>
      <div class="econ-row"><span>返済期限</span><b>${due ? `${escapeHTML(formatJstDateTime(due))}${overdue ? "（期限切れ）" : daysLeft !== null ? `（あと${Math.max(daysLeft, 0)}日）` : ""}` : "-"}</b></div>
      <button type="button" class="econ-button primary" data-econ="repay" ${disabled} ${assets.coins < bank.loan ? "disabled" : ""}>${formatCoins(bank.loan)}コインを返済する</button>
      ${assets.coins < bank.loan ? `<p class="econ-note">返済には手持ちのゆうcoinが${formatCoins(bank.loan)}コイン必要です。</p>` : ""}`;
  } else {
    const canBorrow = assets.coins <= BANK_LOAN_MAX_COINS;
    /* 13:00 の自動返済で完済した場合も、直近（7日以内）の自動返済の結果を表示する（bank.lastAutoRepay。新しい読み取りは無い） */
    const autoAge = auto?.date ? (Date.parse(`${getTodayRaceId()}T00:00:00Z`) - Date.parse(`${auto.date}T00:00:00Z`)) / 86400000 : null;
    const paidOffNotice = auto && Number(auto.amount) > 0 && autoAge !== null && autoAge >= 0 && autoAge <= 7
      ? `<div class="econ-paid-off" role="status">
          <strong>✅ ${escapeHTML(formatEconomyDate(auto.date))} 13:00に自動返済：${formatCoins(auto.amount)}コイン（預金${formatCoins(auto.fromDeposit)}・手持ち${formatCoins(auto.fromCoins)}）</strong>
          <div>返済期限を過ぎていたため、預金 → 手持ちの順に自動で返済され、借入は完済しました。</div>
        </div>`
      : "";
    loanHtml = `${paidOffNotice}
      <p class="econ-note">手持ちが${BANK_LOAN_MAX_COINS}コイン以下のときに、${BANK_LOAN_AMOUNT}コインを借りられます（手数料なし・返済額${BANK_LOAN_AMOUNT}・期限${BANK_LOAN_DAYS}日）。</p>
      <button type="button" class="econ-button" data-econ="borrow" ${disabled} ${canBorrow ? "" : "disabled"}>🆘 緊急融資で${BANK_LOAN_AMOUNT}コイン借りる</button>
      ${canBorrow ? "" : `<p class="econ-note">いまの手持ちは${formatCoins(assets.coins)}コインなので、まだ利用できません。</p>`}`;
  }

  const bankHtml = `
    <section class="econ-card econ-bank" aria-label="ゆう銀行">
      <h3>🏦 ゆう銀行</h3>
      <div class="econ-balance">
        <span class="econ-label">普通預金</span>
        <strong>${formatCoins(bank.deposit)}<small>コイン</small></strong>
        <span class="econ-sub">利息 1日1%（上限${BANK_INTEREST_MAX}コイン）・毎日13:00${bank.deposit > 0 ? `／次回 +${formatCoins(expectedInterest)}コイン（見込み）` : ""}</span>
        ${bank.deposit > bank.interestBase ? `<span class="econ-sub">新しく預けた分は、次の13:00の処理のあとから利息の対象になります。</span>` : ""}
        ${bank.lastInterest > 0 && bank.interestDate ? `<span class="econ-sub">${escapeHTML(formatEconomyDate(bank.interestDate))} の利息 +${formatCoins(bank.lastInterest)}コイン</span>` : ""}
      </div>
      <label class="econ-field">
        <span>金額</span>
        <input id="econBankAmount" type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="off" placeholder="例：100" value="${escapeHTML(economyBankAmount)}">
      </label>
      <div class="econ-chips">
        <button type="button" data-econ-amount="100">100</button>
        <button type="button" data-econ-amount="500">500</button>
        <button type="button" data-econ-amount="coins">手持ち全部</button>
        <button type="button" data-econ-amount="deposit">預金全部</button>
      </div>
      <div class="econ-actions">
        <button type="button" class="econ-button primary" data-econ="deposit" ${disabled} ${bank.loan > 0 ? "disabled" : ""}>預ける</button>
        <button type="button" class="econ-button" data-econ="withdraw" ${disabled} ${bank.deposit > 0 ? "" : "disabled"}>引き出す</button>
      </div>
      ${bank.loan > 0 ? `<p class="econ-note">借入中は預け入れできません（引き出しはできます）。</p>` : ""}
      <h4>借入</h4>
      ${loanHtml}
    </section>`;

  /* ゆう株 */
  const news = Array.isArray(market.todayNews) ? market.todayNews : [];
  const events = Array.isArray(market.events) ? market.events : [];
  const companyOf = (code) => STOCK_COMPANIES.find((c) => c.code === code) || { emoji: "", name: code };
  const newsHtml = market.date
    ? `<div class="econ-news">
        <div class="econ-news-title">📰 ${escapeHTML(formatEconomyDate(market.date))} 13:00 のニュース</div>
        ${news.length ? news.map((n) => `<div class="econ-news-item ${n.kind === "good" ? "good" : "bad"}"><span>${companyOf(n.code).emoji} ${escapeHTML(companyOf(n.code).name)}</span>${escapeHTML(n.text)}</div>`).join("") : `<div class="econ-news-item">ニュースはありません</div>`}
        ${events.map((e) => `<div class="econ-news-item ${e.kind === "surge" ? "good" : "bad"}"><span>${companyOf(e.code).emoji} ${escapeHTML(companyOf(e.code).name)}</span>${e.kind === "surge" ? "🚀 株価が急騰しました" : "💥 株価が暴落しました"}</div>`).join("")}
      </div>`
    : `<div class="econ-news"><div class="econ-news-title">📰 株価は毎日13:00に更新されます（初回の更新まで初期株価です）</div></div>`;

  const cardsHtml = STOCK_COMPANIES.map((c) => {
    const info = market.companies?.[c.code] || {};
    const { price, holding, qty, canBuy, canSell } = getStockTradeState(c.code, stocks, market, assets);
    const value = holding ? holding.qty * price : 0;
    const profit = holding ? value - holding.cost : 0;
    return `
      <article class="stock-card" data-code="${c.code}">
        <div class="stock-head">
          <span class="stock-emoji" aria-hidden="true">${c.emoji}</span>
          <div class="stock-title"><b>${escapeHTML(c.name)}</b><small>${escapeHTML(c.sector)}</small></div>
          <div class="stock-price"><strong>${formatCoins(price)}</strong>${changeBadge(info.changePct)}</div>
        </div>
        ${renderSparkline(info.history, (Number(info.changePct) || 0) >= 0)}
        <div class="stock-holding">${holding
          ? `保有 <b>${formatCoins(holding.qty)}</b>株 ・ 評価額 <b>${formatCoins(value)}</b> ・ 損益 <b class="${profit > 0 ? "up" : profit < 0 ? "down" : ""}">${profit > 0 ? "+" : ""}${formatCoins(profit)}</b>`
          : "保有していません"}</div>
        <div class="stock-trade">
          <div class="stock-qty" role="group" aria-label="${escapeHTML(c.name)}の株数">
            <button type="button" data-qty-step="-1" aria-label="1株減らす">−</button>
            <input type="text" inputmode="numeric" pattern="[0-9]*" data-qty-input value="${qty}" aria-label="株数">
            <button type="button" data-qty-step="1" aria-label="1株増やす">＋</button>
          </div>
          <div class="stock-total">合計 <b>${formatCoins(price * qty)}</b></div>
          <button type="button" class="econ-button buy" data-trade="buy" ${disabled} ${canBuy ? "" : "disabled"}>買う</button>
          <button type="button" class="econ-button sell" data-trade="sell" ${disabled} ${canSell ? "" : "disabled"}>売る</button>
        </div>
      </article>`;
  }).join("");

  const holdingCodes = Object.keys(stocks);
  const holdingsHtml = holdingCodes.length
    ? `<div class="econ-holdings">${holdingCodes.map((code) => {
        const c = companyOf(code); const h = stocks[code]; const v = h.qty * getStockPrice(market, code);
        return `<div class="econ-row"><span>${c.emoji} ${escapeHTML(c.name)} ${formatCoins(h.qty)}株</span><b>${formatCoins(v)}</b></div>`;
      }).join("")}<div class="econ-row total"><span>評価額の合計</span><b>${formatCoins(assets.stockValue)}</b></div></div>`
    : `<p class="econ-note">まだ株を持っていません。</p>`;

  const stocksHtml = `
    <section class="econ-card econ-stocks" aria-label="ゆう株">
      <h3>📈 ゆう株</h3>
      <p class="econ-note">24時間いつでも売買できます（手数料なし）。株価は毎日13:00に更新されます。</p>
      ${newsHtml}
      <div class="stock-grid">${cardsHtml}</div>
      <h4>保有株</h4>
      ${holdingsHtml}
    </section>`;

  /* 入力中の値・フォーカス・スクロール位置を、描き直しても保つ
     （中身を丸ごと入れ替えるので、Safari などでは新しい入力欄への focus やスクロール領域の作り直しで位置が動くことがある） */
  const active = document.activeElement;
  const activeKey = active && economyContent.contains(active)
    ? (active.id || (active.closest(".stock-card")?.dataset.code || "") + (active.matches("[data-qty-input]") ? ":qty" : ""))
    : null;
  const scrollTop = economyView?.scrollTop ?? 0;
  economyContent.innerHTML = `${summaryHtml}<div class="econ-columns">${bankHtml}${stocksHtml}</div>`;
  if (activeKey) {
    const target = activeKey === "econBankAmount" ? document.getElementById("econBankAmount")
      : activeKey.endsWith(":qty") ? economyContent.querySelector(`.stock-card[data-code="${activeKey.split(":")[0]}"] [data-qty-input]`) : null;
    if (target) { target.focus({ preventScroll: true }); const v = target.value; target.value = ""; target.value = v; }
  }
  if (economyView && economyView.scrollTop !== scrollTop) economyView.scrollTop = scrollTop;
}

/* 株を売買するときの値（カードの表示・ボタンの有効／無効に使う） */
function getStockTradeState(code, stocks, market, assets) {
  const price = getStockPrice(market, code);
  const holding = stocks[code];
  const qty = stockTradeQty[code] || 1;
  return { price, holding, qty, canBuy: assets.coins >= price * qty, canSell: Boolean(holding && holding.qty >= qty) };
}

/* 株数（＋／−・入力）を変えたときは、そのカードの株数・合計・ボタンだけを書き換える
   （画面全体を描き直さないので、スクロール位置もフォーカスもそのまま）。カードが無ければ false */
function updateStockCardControls(code) {
  const card = economyContent?.querySelector(`.stock-card[data-code="${code}"]`);
  if (!card || !currentUser || !username) return false;
  const data = myLatestUserData && myLatestUserData.docId === username ? myLatestUserData : { coins: myCoins };
  const market = marketCache?.data || createInitialMarketData();
  const stocks = normalizeStocksData(data.stocks);
  const { price, qty, canBuy, canSell } = getStockTradeState(code, stocks, market, computeMyAssets(data, market));

  const input = card.querySelector("[data-qty-input]");
  const total = card.querySelector(".stock-total b");
  const buy = card.querySelector('[data-trade="buy"]');
  const sell = card.querySelector('[data-trade="sell"]');
  if (!input || !total || !buy || !sell) return false;
  if (input.value !== String(qty)) input.value = String(qty);
  total.textContent = formatCoins(price * qty);
  buy.disabled = economyBusy || !canBuy;
  sell.disabled = economyBusy || !canSell;
  return true;
}

economyContent?.addEventListener("input", (event) => {
  const input = event.target;
  if (input.id === "econBankAmount") { economyBankAmount = input.value.replace(/[^0-9]/g, ""); return; }
  if (input.matches("[data-qty-input]")) {
    const code = input.closest(".stock-card")?.dataset.code;
    const qty = parseEconomyAmount(input.value);
    if (code && qty) { stockTradeQty[code] = Math.min(qty, ECONOMY_MAX_TRADE_QTY); }
  }
});

economyContent?.addEventListener("change", (event) => {
  if (!event.target.matches("[data-qty-input]")) return;
  const code = event.target.closest(".stock-card")?.dataset.code;
  if (!code || !updateStockCardControls(code)) renderEconomyView();
});

economyContent?.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button || button.disabled) return;
  const data = myLatestUserData && myLatestUserData.docId === username ? myLatestUserData : { coins: myCoins };

  if (button.dataset.econAmount) {
    const key = button.dataset.econAmount;
    const value = key === "coins" ? Math.max(0, Math.floor(Number(data.coins) || 0))
      : key === "deposit" ? normalizeBankData(data.bank).deposit : Number(key);
    economyBankAmount = value > 0 ? String(value) : "";
    renderEconomyView();
    return;
  }

  if (button.dataset.qtyStep) {
    const code = button.closest(".stock-card")?.dataset.code;
    if (!code) return;
    stockTradeQty[code] = Math.min(ECONOMY_MAX_TRADE_QTY, Math.max(1, (stockTradeQty[code] || 1) + Number(button.dataset.qtyStep)));
    if (!updateStockCardControls(code)) renderEconomyView();
    return;
  }

  if (button.dataset.trade) {
    const code = button.closest(".stock-card")?.dataset.code;
    const company = STOCK_COMPANIES.find((c) => c.code === code);
    const qty = stockTradeQty[code] || 1;
    if (!company) return;
    const side = button.dataset.trade;
    runEconomyAction(() => tradeStock(code, side, qty),
      (r) => `${company.name}を${formatCoins(qty)}株${side === "buy" ? "買いました" : "売りました"}（1株 ${formatCoins(r.price)}・合計 ${formatCoins(r.amount)}コイン）`);
    return;
  }

  const action = button.dataset.econ;
  if (!action) return;
  if (action === "deposit" || action === "withdraw") {
    const amount = parseEconomyAmount(economyBankAmount);
    if (!amount) return alert("金額を1以上の整数で入力してください。");
    runEconomyAction(() => (action === "deposit" ? bankDeposit(amount) : bankWithdraw(amount)),
      `${formatCoins(amount)}コインを${action === "deposit" ? "預けました" : "引き出しました"}`);
    economyBankAmount = "";
  } else if (action === "borrow") {
    if (!confirm(`${BANK_LOAN_AMOUNT}コインを借ります。\n返済額は${BANK_LOAN_AMOUNT}コイン（手数料なし）、返済期限は${BANK_LOAN_DAYS}日後です。\n期限を過ぎると、毎日13:00に預金・手持ちから自動で返済されます。`)) return;
    runEconomyAction(() => bankBorrow(), `${BANK_LOAN_AMOUNT}コインを借りました（${BANK_LOAN_DAYS}日以内に返済してください）`);
  } else if (action === "repay") {
    runEconomyAction(() => bankRepay(), (r) => `${formatCoins(r.repaid)}コインを返済しました`);
  }
});
