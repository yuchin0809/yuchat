// 管理者機能の Firestore Rules セキュリティテスト（Rules Emulator で実際に許可・拒否を確かめる）
// イベント機能（events / eventParticipants）は廃止したので、残っている過去のデータをブラウザから読み書きできないことを確かめる
const { initializeTestEnvironment, assertSucceeds, assertFails } = require("@firebase/rules-unit-testing");
const fs = require("fs");
const path = require("path");
const { doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, addDoc, collection, query, where, orderBy, limit, runTransaction, writeBatch, serverTimestamp } = require("firebase/firestore");

const ADMIN = "g51wzTvJFsZiYEfre5aDuDckJXY2";
let pass = 0, fail = 0;
const log = [];
async function ok(name, p) { try { await assertSucceeds(p); pass++; log.push(`PASS 許可 ${name}`); } catch (e) { fail++; log.push(`FAIL (許可されるべき) ${name}: ${String(e.message).split("\n")[0]}`); } }
async function ng(name, p) { try { await assertFails(p); pass++; log.push(`PASS 拒否 ${name}`); } catch (e) { fail++; log.push(`FAIL (拒否されるべき) ${name}`); } }
const min = (m) => new Date(Date.now() + m * 60000);

(async () => {
  const env = await initializeTestEnvironment({ projectId: "demo-yuuchat-rules", firestore: { rules: fs.readFileSync(process.env.RULES || path.join(__dirname, "..", "firestore.rules"), "utf8"), host: "127.0.0.1", port: 8080 } });
  const admin = env.authenticatedContext(ADMIN).firestore();
  const A = env.authenticatedContext("userA").firestore();
  const B = env.authenticatedContext("userB").firestore();
  // メールアドレスやユーザー名が管理者っぽくても、UID が違えば管理者ではない
  const fake = env.authenticatedContext("fakeAdmin", { email: "admin@example.com", name: "admin" }).firestore();
  const anon = env.unauthenticatedContext().firestore();

  const race = (o) => ({ raceId: o.id, dayId: o.id.slice(0, 10), openAt: o.openAt, closeAt: o.closeAt, raceAt: o.raceAt, status: o.status || "scheduled", betCount: o.betCount || 0, createdByUid: ADMIN, createdAt: new Date() });
  const ev = (o) => ({ title: o.title || "テスト", description: "", location: "", startAt: o.startAt, entryOpenAt: o.entryOpenAt, entryCloseAt: o.entryCloseAt, capacity: o.capacity || 0, status: o.status || "scheduled", participantCount: o.participantCount || 0, createdByUid: ADMIN, createdByName: "admin", createdAt: new Date() });

  await env.withSecurityRulesDisabled(async (ctx) => {
    const d = ctx.firestore();
    await setDoc(doc(d, "users/alice"), { uid: "userA", name: "alice", coins: 1000, totalBetAmount: 0 });
    await setDoc(doc(d, "users/bob"), { uid: "userB", name: "bob", coins: 1000 });
    await setDoc(doc(d, "derbyManualRaces/2030-01-01-m1200"), race({ id: "2030-01-01-m1200", openAt: min(-10), closeAt: min(10), raceAt: min(20) }));
    await setDoc(doc(d, "derbyManualRaces/2030-01-01-m1300"), race({ id: "2030-01-01-m1300", openAt: min(-30), closeAt: min(-5), raceAt: min(5) }));
    await setDoc(doc(d, "derbyManualRaces/2030-01-01-m1400"), race({ id: "2030-01-01-m1400", openAt: min(-10), closeAt: min(10), raceAt: min(20), status: "cancelled" }));
    await setDoc(doc(d, "derbyManualRaces/2030-01-01-m1500"), race({ id: "2030-01-01-m1500", openAt: min(30), closeAt: min(40), raceAt: min(50) }));
    // 廃止したイベント機能の過去のデータ（Firestore に残したまま）
    await setDoc(doc(d, "events/ev-old"), ev({ startAt: min(120), entryOpenAt: min(-10), entryCloseAt: min(60), participantCount: 1 }));
    await setDoc(doc(d, "eventParticipants/ev-old_userA"), { eventId: "ev-old", uid: "userA", username: "alice", joinedAt: new Date() });
  });

  // アプリと同じ形のトランザクション
  const createManualRace = (db, id) => runTransaction(db, async (t) => {
    const ref = doc(db, "derbyManualRaces", id);
    await t.get(ref); await t.get(doc(db, "races", id));
    t.set(ref, race({ id, openAt: min(60), closeAt: min(70), raceAt: min(80) }));
  });
  const cancelManualRace = (db, id) => runTransaction(db, async (t) => {
    const ref = doc(db, "derbyManualRaces", id);
    await t.get(ref);
    t.update(ref, { status: "cancelled", cancelledAt: serverTimestamp(), cancelledByUid: ADMIN });
  });
  const bet = (db, uid, username, raceId) => runTransaction(db, async (t) => {
    const userRef = doc(db, "users", username), manualRef = doc(db, "derbyManualRaces", raceId);
    const u = await t.get(userRef); const m = await t.get(manualRef);
    t.update(manualRef, { betCount: Number(m.data().betCount || 0) + 1 });
    t.update(userRef, { coins: u.data().coins - 100, totalBetAmount: Number(u.data().totalBetAmount || 0) + 100 });
    t.set(doc(collection(db, "raceBets")), { raceId, uid, username, type: "win", horses: [1], amount: 100, settled: false, win: null, payout: null, createdAt: serverTimestamp() });
  });
  // 廃止したイベント機能：以前のアプリと同じ形の書き込み（いまは拒否されることを確かめる）
  const createEvent = (db, id) => runTransaction(db, async (t) => {
    const ref = doc(db, "events", id); await t.get(ref);
    t.set(ref, ev({ title: "新イベント", startAt: min(300), entryOpenAt: min(100), entryCloseAt: min(200) }));
  });
  const join = (db, uid, name, id) => runTransaction(db, async (t) => {
    const ref = doc(db, "events", id), entryRef = doc(db, "eventParticipants", `${id}_${uid}`);
    const s = await t.get(ref); await t.get(entryRef);
    t.set(entryRef, { eventId: id, uid, username: name, joinedAt: serverTimestamp() });
    t.update(ref, { participantCount: Number(s.data().participantCount || 0) + 1 });
  });

  log.push("--- ① 管理者 → 管理操作が成功する");
  await ok("管理者：手動レースの作成（アプリと同じトランザクション）", createManualRace(admin, "2030-02-01-m1000"));
  await ok("管理者：手動レースのキャンセル", cancelManualRace(admin, "2030-02-01-m1000"));
  await ok("管理者：キャンセル済みの手動レースを作り直す", createManualRace(admin, "2030-02-01-m1000"));
  await ok("管理者：手動レースの削除", deleteDoc(doc(admin, "derbyManualRaces/2030-02-01-m1000")));

  log.push("--- ② 一般ユーザー → 手動レースを直接 Firestore に書き込もうとしても拒否される");
  await ng("一般：手動レースの作成（アプリと同じトランザクション）", createManualRace(A, "2030-03-01-m1000"));
  await ng("一般：手動レースの作成（setDoc）", setDoc(doc(A, "derbyManualRaces/2030-03-01-m1100"), race({ id: "2030-03-01-m1100", openAt: min(1), closeAt: min(2), raceAt: min(3) })));
  await ng("一般：手動レースの作成（addDoc）", addDoc(collection(A, "derbyManualRaces"), { status: "scheduled" }));
  await ng("一般：手動レースのキャンセル", cancelManualRace(A, "2030-01-01-m1500"));
  await ng("一般：手動レースの時刻の書き換え", updateDoc(doc(A, "derbyManualRaces/2030-01-01-m1200"), { raceAt: min(1) }));
  await ng("一般：手動レースの上書き（set）", setDoc(doc(A, "derbyManualRaces/2030-01-01-m1200"), { status: "cancelled" }));
  await ng("一般：手動レースの削除", deleteDoc(doc(A, "derbyManualRaces/2030-01-01-m1500")));
  await ng("一般：betCount を0に戻す（キャンセル可能にする改ざん）", updateDoc(doc(A, "derbyManualRaces/2030-01-01-m1200"), { betCount: 0 }));
  await ng("一般：betCount を一気に増やす", updateDoc(doc(A, "derbyManualRaces/2030-01-01-m1200"), { betCount: 50 }));
  await ng("一般：betCount と status を同時に変更", updateDoc(doc(A, "derbyManualRaces/2030-01-01-m1200"), { betCount: 1, status: "cancelled" }));
  await ng("メールアドレス・名前が管理者風でも UID が違えば拒否（作成）", createManualRace(fake, "2030-03-02-m1000"));
  await ng("未ログイン：手動レースの読み取り", getDoc(doc(anon, "derbyManualRaces/2030-01-01-m1200")));

  log.push("--- ③ 廃止したイベント（events / eventParticipants）→ 管理者も一般ユーザーもブラウザからは読み書きできない");
  await ok("一般：手動レースの読み取り（今まで通り）", getDocs(collection(A, "derbyManualRaces")));
  await ng("管理者：イベントの読み取り", getDoc(doc(admin, "events/ev-old")));
  await ng("管理者：イベント一覧の読み取り", getDocs(collection(admin, "events")));
  await ng("管理者：イベントの作成（以前のアプリと同じトランザクション）", createEvent(admin, "ev-new"));
  await ng("管理者：イベントの編集", updateDoc(doc(admin, "events/ev-old"), { title: "変更後" }));
  await ng("管理者：イベントの削除", deleteDoc(doc(admin, "events/ev-old")));
  await ng("管理者：参加者一覧の読み取り", getDocs(query(collection(admin, "eventParticipants"), where("eventId", "==", "ev-old"))));
  await ng("管理者：参加記録の削除", deleteDoc(doc(admin, "eventParticipants/ev-old_userA")));
  await ng("一般：イベントの読み取り", getDoc(doc(A, "events/ev-old")));
  await ng("一般：イベント一覧の読み取り", getDocs(collection(A, "events")));
  await ng("一般：イベントの作成（setDoc）", setDoc(doc(A, "events/ev-by-user"), ev({ startAt: min(100), entryOpenAt: min(10), entryCloseAt: min(50) })));
  await ng("一般：イベントの作成（addDoc）", addDoc(collection(A, "events"), { title: "x" }));
  await ng("一般：イベントの人数の書き換え", updateDoc(doc(A, "events/ev-old"), { participantCount: 999 }));
  await ng("一般：イベントの削除", deleteDoc(doc(A, "events/ev-old")));
  await ng("一般：イベントの下にデータを作る", setDoc(doc(A, "events/ev-old/x/y"), { a: 1 }));
  await ng("一般：自分の参加記録の読み取り", getDocs(query(collection(A, "eventParticipants"), where("uid", "==", "userA"))));
  await ng("一般：イベントに参加（以前のアプリと同じトランザクション）", join(A, "userA", "alice", "ev-old"));
  await ng("一般：参加記録だけ作る", setDoc(doc(A, "eventParticipants/ev-old_userB"), { eventId: "ev-old", uid: "userB", username: "bob", joinedAt: serverTimestamp() }));
  await ng("一般：自分の参加記録の削除", deleteDoc(doc(A, "eventParticipants/ev-old_userA")));
  await ng("メールアドレス・名前が管理者風でも UID が違えば拒否（イベント作成）", createEvent(fake, "ev-fake"));
  {
    let e, p; await env.withSecurityRulesDisabled(async (ctx) => { const d = ctx.firestore(); e = (await getDoc(doc(d, "events/ev-old"))).data(); p = (await getDoc(doc(d, "eventParticipants/ev-old_userA"))).exists(); });
    if (e && e.title === "テスト" && e.participantCount === 1 && p) { pass++; log.push("PASS 過去のイベントのデータは消えずにそのまま残っている"); } else { fail++; log.push("FAIL 過去のイベントのデータが変わった"); }
  }

  log.push("--- ④ 馬券の購入・betCount の加算はブラウザからはできない（通知 Worker が行う）");
  await ng("一般：受付中の手動レースにブラウザから直接投票（コイン・馬券・betCount の書き込み）", bet(A, "userA", "alice", "2030-01-01-m1200"));
  await ng("一般：手動レースの betCount だけをブラウザから増やす", updateDoc(doc(A, "derbyManualRaces/2030-01-01-m1200"), { betCount: 1 }));
  await ng("一般：ブラウザから raceBets を直接作る", setDoc(doc(A, "raceBets/direct1"), { raceId: "2030-01-01-m1200", uid: "userA", username: "alice", type: "win", horses: [1], amount: 100, settled: false }));

  log.push("--- ⑤ 既存のデータは今まで通り（ログイン済みなら読み書き可・未ログインは不可）");
  await ok("users：自分のデータ更新", updateDoc(doc(A, "users/alice"), { online: true, lastSeen: serverTimestamp() }));
  await ok("users：新規登録（経済項目なし。初期コインは Worker が付ける）", setDoc(doc(A, "users/alice_new"), { uid: "userA", name: "alice_new" }));
  await ng("users：新規登録で経済項目（コイン）を入れる", setDoc(doc(A, "users/alice_rich"), { uid: "userA", name: "alice_rich", coins: 1000000 }));
  await ok("friends：友達追加", setDoc(doc(A, "friends/alice_bob"), { user1: "alice", user2: "bob", createdAt: serverTimestamp() }));
  await ok("groups：グループ作成", addDoc(collection(A, "groups"), { name: "g", members: ["alice", "bob"] }));
  await ok("messages：メッセージ送信", addDoc(collection(A, "messages"), { sender: "alice", receiver: "bob", text: "hi", createdAt: serverTimestamp() }));
  await ok("messages：既読（他人のメッセージ更新）", (async () => { const r = await addDoc(collection(B, "messages"), { sender: "bob", receiver: "alice", readBy: [] }); await updateDoc(r, { readBy: ["alice"] }); })());
  await ok("gameRooms：部屋作成・更新・削除", (async () => { const r = doc(A, "gameRooms/room1"); await setDoc(r, { host: "alice" }); await updateDoc(doc(B, "gameRooms/room1"), { guest: "bob" }); await deleteDoc(r); })());
  await ok("gameInvites：招待", setDoc(doc(A, "gameInvites/inv1"), { from: "alice", to: "bob" }));
  await ok("fcmTokens：トークン保存・削除", (async () => { await setDoc(doc(A, "fcmTokens/tok1"), { uid: "userA" }); await deleteDoc(doc(A, "fcmTokens/tok1")); })());
  await ng("races：ブラウザからレース結果を作る（結果の改ざん防止。結果は Worker が作る）", setDoc(doc(A, "races/2030-01-02"), { raceId: "2030-01-02", resultOrder: [1, 2, 3], status: "finished", generatedBy: "client" }));
  await ng("raceLogs：ブラウザから開催ログを書く", setDoc(doc(A, "raceLogs/2030-01-02"), { raceId: "2030-01-02" }, { merge: true }));
  await ok("derbyNotifications など他のコレクションも今まで通り", setDoc(doc(A, "derbyNotifications/2030-01-02"), { a: 1 }));
  await ok("サブコレクション（既存データ）も今まで通り", setDoc(doc(A, "users/alice/sub/x"), { a: 1 }));
  await ok("一括書き込み（batch）も今まで通り", (() => { const b = writeBatch(A); b.update(doc(A, "users/alice"), { online: false }); b.set(doc(A, "friends/x_y"), { user1: "x" }); return b.commit(); })());
  await ng("未ログイン：users の読み取り（今まで通り拒否）", getDoc(doc(anon, "users/alice")));
  await ng("未ログイン：messages への書き込み（今まで通り拒否）", addDoc(collection(anon, "messages"), { text: "x" }));
  await ng("未ログイン：イベントの読み取り", getDocs(collection(anon, "events")));

  log.push("--- ⑥ ゆう経済：株価（market）・総資産ランキング（rankings）は読み取りだけ（書くのは自動処理だけ）");
  await env.withSecurityRulesDisabled(async (ctx) => {
    const d = ctx.firestore();
    await setDoc(doc(d, "market/current"), { date: "2030-01-01", companies: { YGM: { price: 180 } } });
    await setDoc(doc(d, "rankings/assets"), { date: "2030-01-01", users: [{ name: "alice", total: 1000, rank: 1 }] });
  });
  await ok("market：株価の読み取り", getDoc(doc(A, "market/current")));
  await ok("rankings：総資産ランキングの読み取り", getDoc(doc(A, "rankings/assets")));
  await ng("market：株価の書き換え", updateDoc(doc(A, "market/current"), { "companies.YGM.price": 99999 }));
  await ng("market：株価の上書き", setDoc(doc(A, "market/current"), { date: "x" }));
  await ng("market：株価の削除", deleteDoc(doc(A, "market/current")));
  await ng("market：新しいドキュメントの作成", setDoc(doc(A, "market/other"), { a: 1 }));
  await ng("rankings：総資産ランキングの書き換え", updateDoc(doc(A, "rankings/assets"), { users: [] }));
  await ng("rankings：ランキングの作成", setDoc(doc(A, "rankings/coins"), { users: [] }));
  await ng("market：管理者でもブラウザからは書けない", updateDoc(doc(admin, "market/current"), { date: "y" }));
  await ng("market：売買と同じトランザクションの中でも書けない", runTransaction(A, async (t) => { await t.get(doc(A, "market/current")); t.update(doc(A, "market/current"), { date: "z" }); t.update(doc(A, "users/alice"), { coins: 1 }); }));
  await ng("users：自分のコインをブラウザから書き換える", updateDoc(doc(A, "users/alice"), { coins: 900 }));
  await ng("users：自分の銀行（預金）をブラウザから書き換える", updateDoc(doc(A, "users/alice"), { bank: { deposit: 100000, interestBase: 0, loan: 0 } }));
  await ng("users：自分の株をブラウザから書き換える", updateDoc(doc(A, "users/alice"), { "stocks.YGM": { qty: 99999, cost: 0 } }));
  await ng("users：ログインボーナス日・累計賭け金・ボーナスをブラウザから書き換える", updateDoc(doc(A, "users/alice"), { lastLoginBonusDate: "2030-01-01", totalBetAmount: 0, bonus500Granted: true }));
  await ng("users：経済項目と普通の項目をまとめて更新しても拒否（経済項目が含まれる）", updateDoc(doc(A, "users/alice"), { online: true, coins: 5 }));
  await ok("users：経済項目でない更新（オンライン・通知設定・プロフィール画像・名前・お知らせ既読）は今まで通り", updateDoc(doc(A, "users/alice"), { online: true, notificationSetupDone: true, profileImage: "x", lastAnnouncementReadAt: serverTimestamp() }));
  await ng("未ログイン：株価の読み取り", getDoc(doc(anon, "market/current")));

  log.push("--- ⑦ ゆうダービーの馬券（raceBets）：購入・精算・改変はブラウザからはできない（通知 Worker が行う）。読み取りだけできる");
  const betDoc = (raceId, uid = "userA", extra = {}) => ({ raceId, uid, username: uid === "userA" ? "alice" : "bob", type: "win", horses: [3], amount: 100, settled: false, win: null, payout: null, createdAt: new Date(), ...extra });
  await env.withSecurityRulesDisabled(async (ctx) => {
    const d = ctx.firestore();
    await setDoc(doc(d, "raceBets/fixedA"), betDoc("2026-10-09", "userA", { oddsVersion: 1, oddsTenths: 60 }));
    await setDoc(doc(d, "raceBets/fixedB"), betDoc("2026-10-09", "userB"));
  });
  const settleFixed = (db, id, payout = 600) => updateDoc(doc(db, "raceBets", id), { settled: true, win: true, payout, payoutRule: "fixed-v1", settledOddsTenths: 60 });
  await ng("自分の馬券をブラウザから精算（固定オッズの目印付きでも）", settleFixed(A, "fixedA"));
  await ng("自分の馬券を好きな払い戻し額で精算", updateDoc(doc(A, "raceBets/fixedA"), { settled: true, win: true, payout: 99999999, payoutRule: "fixed-v1" }));
  await ng("他ユーザーの馬券を精算", settleFixed(A, "fixedB", 99999));
  await ng("他ユーザーの馬券の中身（馬・金額）を書き換える", updateDoc(doc(A, "raceBets/fixedB"), { horses: [1], amount: 1 }));
  await ng("馬券を削除する", deleteDoc(doc(A, "raceBets/fixedA")));
  await ng("精算済みの馬券の表示用の項目だけでも書き換えられない", updateDoc(doc(A, "raceBets/fixedA"), { username: "alice2" }));
  await ng("ブラウザから新しい馬券を作る（コインを払わずに）", setDoc(doc(A, "raceBets/free"), betDoc("2026-10-12", "userA", { amount: 1000000 })));
  await ng("未ログイン：馬券の購入", addDoc(collection(anon, "raceBets"), { raceId: "2026-10-12", uid: "x" }));
  await ok("馬券の読み取り（自分の馬券・レースごと）は今まで通り", getDocs(query(collection(A, "raceBets"), where("uid", "==", "userA"))));
  {
    let f; await env.withSecurityRulesDisabled(async (ctx) => { f = (await getDoc(doc(ctx.firestore(), "raceBets/fixedA"))).data(); });
    if (f.settled === false && f.payout === null) { pass++; log.push("PASS ブラウザからの精算は反映されていない"); } else { fail++; log.push("FAIL 馬券が変わった"); }
  }

  log.push("--- ⑧ お知らせ（announcements）：読み取りはログイン済みなら誰でも・作成/編集/削除は管理者だけ");
  const annData = (o = {}) => ({ title: "メンテナンスのお知らせ", body: "本文です", createdAt: serverTimestamp(), updatedAt: serverTimestamp(), createdByUid: ADMIN, createdByName: "かんりしゃ", ...o });
  const ja50 = "あ".repeat(50), ja500 = "本".repeat(500);
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), "announcements/ann-old"), { title: "既存", body: "既存の本文", createdAt: new Date(), updatedAt: new Date(), createdByUid: ADMIN, createdByName: "かんりしゃ" });
  });
  await ok("管理者：お知らせの作成（自動ID・アプリと同じ書き込み）", setDoc(doc(collection(admin, "announcements")), annData()));
  await ok("管理者：タイトル50文字・本文500文字（日本語）で作成", setDoc(doc(admin, "announcements/ann-max"), annData({ title: ja50, body: ja500 })));
  // 文字数はアプリの入力欄（maxlength）・JavaScript の length と同じ数え方（絵文字は1つで2文字分）
  await ok("管理者：絵文字・改行を含むお知らせ（絵文字25個＝50文字分）", setDoc(doc(admin, "announcements/ann-emoji"), annData({ title: "📢".repeat(25), body: "1行目\n2行目 🎉" })));
  await ng("管理者：絵文字26個（52文字分）のタイトルは拒否（アプリの入力欄でも入らない）", setDoc(doc(admin, "announcements/ann-x8"), annData({ title: "📢".repeat(26) })));
  await ok("管理者：お知らせの編集（タイトル・本文・更新日時）", updateDoc(doc(admin, "announcements/ann-max"), { title: "変更後", body: "変更後の本文", updatedAt: serverTimestamp() }));
  await ok("管理者：お知らせの削除", deleteDoc(doc(admin, "announcements/ann-emoji")));
  await ng("管理者：タイトル51文字は拒否", setDoc(doc(admin, "announcements/ann-x1"), annData({ title: ja50 + "あ" })));
  await ng("管理者：本文501文字は拒否", setDoc(doc(admin, "announcements/ann-x2"), annData({ body: ja500 + "本" })));
  await ng("管理者：空のタイトルは拒否", setDoc(doc(admin, "announcements/ann-x3"), annData({ title: "" })));
  await ng("管理者：決められた項目以外は拒否", setDoc(doc(admin, "announcements/ann-x4"), annData({ pinned: true })));
  await ng("管理者：項目が足りないと拒否", setDoc(doc(admin, "announcements/ann-x5"), { title: "t", body: "b", createdAt: serverTimestamp(), updatedAt: serverTimestamp(), createdByUid: ADMIN }));
  await ng("管理者：作成者を他人にして作成は拒否", setDoc(doc(admin, "announcements/ann-x6"), annData({ createdByUid: "userA" })));
  await ng("管理者：作成日時を過去にして作成は拒否", setDoc(doc(admin, "announcements/ann-x7"), annData({ createdAt: new Date("2000-01-01") })));
  await ng("管理者：編集で作成日時・作成者は変えられない", updateDoc(doc(admin, "announcements/ann-max"), { createdAt: new Date("2000-01-01"), updatedAt: serverTimestamp() }));
  await ng("管理者：編集で本文を501文字にはできない", updateDoc(doc(admin, "announcements/ann-max"), { body: ja500 + "本", updatedAt: serverTimestamp() }));
  await ok("一般：お知らせ一覧の読み取り（新しい順）", getDocs(query(collection(A, "announcements"), orderBy("createdAt", "desc"), limit(50))));
  await ok("一般：最新のお知らせ1件だけの読み取り（未読マーク用）", getDocs(query(collection(A, "announcements"), orderBy("createdAt", "desc"), limit(1))));
  await ng("一般：お知らせの作成", setDoc(doc(collection(A, "announcements")), annData({ createdByUid: "userA" })));
  await ng("一般：管理者を名乗ってお知らせの作成", setDoc(doc(A, "announcements/ann-fake"), annData()));
  await ng("一般：お知らせの編集", updateDoc(doc(A, "announcements/ann-old"), { title: "乗っ取り", updatedAt: serverTimestamp() }));
  await ng("一般：お知らせの削除", deleteDoc(doc(A, "announcements/ann-old")));
  await ng("一般：お知らせの下にデータを作る", setDoc(doc(A, "announcements/ann-old/x/y"), { a: 1 }));
  await ng("メールアドレス・名前が管理者風でも UID が違えば拒否（お知らせ作成）", setDoc(doc(fake, "announcements/ann-fake2"), annData({ createdByUid: "fakeAdmin" })));
  await ng("未ログイン：お知らせの読み取り", getDocs(collection(anon, "announcements")));
  await ok("users：自分の lastAnnouncementReadAt の更新（既存の users のルールのまま・書き込み1回）", updateDoc(doc(A, "users/alice"), { lastAnnouncementReadAt: serverTimestamp() }));
  await ng("未ログイン：lastAnnouncementReadAt の更新（今まで通り拒否）", updateDoc(doc(anon, "users/alice"), { lastAnnouncementReadAt: serverTimestamp() }));
  {
    let n; await env.withSecurityRulesDisabled(async (ctx) => { n = (await getDocs(collection(ctx.firestore(), "announcements"))).size; });
    if (n === 3) { pass++; log.push("PASS お知らせは許可された書き込みだけが反映（既存・自動ID・50/500文字の3件）"); } else { fail++; log.push(`FAIL お知らせの件数が ${n}`); }
  }

  log.push("--- ⑨ users（ドキュメントIDはユーザー名）：書き込みは自分のデータだけ。管理者は名前の強制変更だけできる");
  await env.withSecurityRulesDisabled(async (ctx) => {
    const d = ctx.firestore();
    await setDoc(doc(d, "users/carol"), { uid: "userC", name: "carol", coins: 777, bank: { deposit: 10, loan: 0 }, stocks: { YGM: { qty: 2, cost: 180 } }, totalBetAmount: 5, createdAt: new Date() });
    await setDoc(doc(d, "users/dave"), { uid: "userD", name: "dave", coins: 300 });
    await setDoc(doc(d, "users/erin"), { uid: "userE", name: "erin", coins: 100 });
    await setDoc(doc(d, "rankings/assets"), { date: "2030-01-01", complete: true, prices: { YGM: 180 }, users: [{ name: "carol", total: 1500, rank: 1 }, { name: "dave", total: 300, rank: 2 }], userCount: 2 });
  });
  const C = env.authenticatedContext("userC").firestore();
  /* アプリと同じ：管理者の名前変更（users の移動・記録・ランキングを1つのトランザクションで） */
  const adminRename = (db, from, to, tweak = (x) => x, opts = {}) => runTransaction(db, async (t) => {
    const oldRef = doc(db, "users", from), newRef = doc(db, "users", to), rRef = doc(db, "rankings/assets");
    const o = await t.get(oldRef); await t.get(newRef); const r = await t.get(rRef);
    t.set(newRef, tweak({ ...o.data(), name: to, nameChangedByAdmin: true, nameChangedAt: serverTimestamp(), nameChangedByUid: opts.byUid || ADMIN, nameChangedFrom: from }));
    if (!opts.keepOld) t.delete(oldRef);
    if (!opts.noLog) t.set(doc(db, "adminNameChanges", from), { from, to, uid: o.data().uid, changedByUid: opts.byUid || ADMIN, changedAt: opts.logAt || serverTimestamp() });
    if (!opts.noRanking && r.exists()) t.update(rRef, { users: r.data().users.map((u) => (u.name === from ? { ...u, name: to } : u)) });
  });
  /* アプリと同じ：通常の名前変更（自分で） */
  const selfRename = async (db, uid, from, to) => {
    // 新しい名前のドキュメント（経済項目なし）を作り、古い名前を消す。経済項目の引き継ぎは Worker が行う（ブラウザは書けない）
    const old = (await getDoc(doc(db, "users", from))).data();
    await setDoc(doc(db, "users", to), { uid, name: to, photoURL: "", profileImage: "", updatedAt: serverTimestamp(), createdAt: old.createdAt || serverTimestamp() });
    await deleteDoc(doc(db, "users", from));
  };
  await ok("1. 一般ユーザーが自分の名前を通常変更（新しい名前を作成→引き継ぎ→古い名前を削除）", selfRename(C, "userC", "carol", "carol2"));
  await ok("1. 一般ユーザー：自分のデータの更新（コイン・通知設定など今まで通り）", updateDoc(doc(C, "users/carol2"), { notificationSetupDone: true }));
  await ng("2. 一般ユーザーが他人の名前を変更（他人のデータを新しい名前で作る）", setDoc(doc(A, "users/dave-x"), { uid: "userD", name: "dave-x", coins: 300 }));
  await ng("2. 一般ユーザーが他人の名前を変更（他人のデータを消す）", deleteDoc(doc(A, "users/dave")));
  await ng("2. 一般ユーザーが他人の名前を書き換える（name の更新）", updateDoc(doc(A, "users/dave"), { name: "へんななまえ" }));
  await ng("2. 一般ユーザーが管理者と同じ書き込みで他人の名前を変更", adminRename(A, "dave", "dave-x", (x) => x, { byUid: "userA" }));
  await ng("2. 一般ユーザーが他人のコインを書き換える", updateDoc(doc(A, "users/dave"), { coins: 999999 }));
  await ng("2. 一般ユーザーが自分のデータの uid を他人にする", updateDoc(doc(A, "users/alice"), { uid: "userD" }));
  await ng("2. 一般ユーザーが他人の名前（既存の名前）を自分の名前として上書き", setDoc(doc(A, "users/dave"), { uid: "userA", name: "dave" }, { merge: true }));
  await ng("メールアドレス・名前が管理者風でも UID が違えば他人の名前を変更できない", adminRename(fake, "dave", "dave-x", (x) => x, { byUid: "fakeAdmin" }));
  await ok("3. 管理者が他ユーザーの名前を変更（アプリと同じトランザクション）", adminRename(admin, "dave", "でぃぶ"));
  {
    let nu, old, r, lg; await env.withSecurityRulesDisabled(async (ctx) => { const d = ctx.firestore(); nu = (await getDoc(doc(d, "users/でぃぶ"))).data(); old = (await getDoc(doc(d, "users/dave"))).exists(); r = (await getDoc(doc(d, "rankings/assets"))).data(); lg = (await getDoc(doc(d, "adminNameChanges/dave"))).data(); });
    const okk = nu && nu.uid === "userD" && nu.coins === 300 && nu.name === "でぃぶ" && nu.nameChangedByAdmin === true && nu.nameChangedFrom === "dave" && !old && r.users.map((u) => u.name).join() === "carol,でぃぶ" && r.date === "2030-01-01" && lg.to === "でぃぶ" && lg.uid === "userD";
    if (okk) { pass++; log.push("PASS 名前変更の結果：中身はそのまま・古い名前は削除・ランキングと記録も新しい名前"); } else { fail++; log.push(`FAIL 名前変更の結果 ${JSON.stringify({ nu, old, r, lg })}`); }
  }
  await ok("3. 管理者が自分自身の名前を変更", (async () => { await env.withSecurityRulesDisabled(async (ctx) => { await setDoc(doc(ctx.firestore(), "users/かんりしゃ"), { uid: ADMIN, name: "かんりしゃ", coins: 50 }); }); await adminRename(admin, "かんりしゃ", "かんりしゃ2"); })());
  await ng("4. 管理者が名前変更と一緒にコインを書き換える", adminRename(admin, "erin", "erin2", (x) => ({ ...x, coins: 999999 })));
  await ng("4. 管理者が名前変更と一緒に uid を書き換える", adminRename(admin, "erin", "erin2", (x) => ({ ...x, uid: "userA" })));
  await ng("4. 管理者が名前変更と一緒に項目を足す", adminRename(admin, "erin", "erin2", (x) => ({ ...x, isVip: true })));
  await ng("4. 管理者が古い名前を消さずに新しい名前を作る（データの複製）", adminRename(admin, "erin", "erin2", (x) => x, { keepOld: true }));
  await ng("4. 管理者が記録を残さずに古い名前を消す", adminRename(admin, "erin", "erin2", (x) => x, { noLog: true }));
  await ng("4. 管理者が他ユーザーの users を直接書き換える（コイン）", updateDoc(doc(admin, "users/erin"), { coins: 1 }));
  await ng("4. 管理者が他ユーザーの users を直接書き換える（名前の項目だけ）", updateDoc(doc(admin, "users/erin"), { name: "x" }));
  await ng("4. 管理者が名前変更と関係なく他ユーザーを削除", deleteDoc(doc(admin, "users/erin")));
  await ng("4. 管理者がランキングの名前以外（日付）を書き換える", updateDoc(doc(admin, "rankings/assets"), { date: "2099-01-01" }));
  await ng("4. 管理者がランキングの人数を変える", updateDoc(doc(admin, "rankings/assets"), { users: [] }));
  await ng("4. 管理者が名前変更の記録を消す", deleteDoc(doc(admin, "adminNameChanges/dave")));
  await ok("管理者は名前変更の記録を読める", getDoc(doc(admin, "adminNameChanges/dave")));
  await ng("一般ユーザーは名前変更の記録を読めない", getDoc(doc(A, "adminNameChanges/dave")));
  await ng("一般ユーザーがランキングの名前を書き換える", updateDoc(doc(A, "rankings/assets"), { users: [{ name: "x", total: 1, rank: 1 }, { name: "y", total: 1, rank: 2 }] }));
  await ng("5. 未ログイン：users の作成", setDoc(doc(anon, "users/nobody"), { uid: "x", name: "nobody" }));
  await ng("5. 未ログイン：users の更新（名前）", updateDoc(doc(anon, "users/erin"), { name: "x" }));
  await ng("5. 未ログイン：users の削除", deleteDoc(doc(anon, "users/erin")));
  await ok("users の読み取り（他人のデータ・友達追加やランキング用）は今まで通り", getDoc(doc(A, "users/erin")));
  await ok("新しい名前での新規登録（自分の uid）は今まで通り", setDoc(doc(A, "users/alice-new2"), { uid: "userA", name: "alice-new2", createdAt: serverTimestamp() }, { merge: true }));

  log.push("--- 👤 ユーザー管理：停止の記録・操作の記録・削除の進み具合は、通知サーバー（サービスアカウント）だけが書く");
  await env.withSecurityRulesDisabled(async (ctx) => {
    const d = ctx.firestore();
    await setDoc(doc(d, "suspendedUsers/userB"), { uid: "userB", name: "bob", reason: "", byUid: ADMIN });
    await setDoc(doc(d, "adminAuditLogs/log1"), { action: "setPassword", targetUid: "userB", byUid: ADMIN });
    await setDoc(doc(d, "userDeletions/userB"), { uid: "userB", name: "bob", status: "failed" });
  });
  const suspendedB = env.authenticatedContext("userB").firestore();
  await ng("停止されたユーザー本人も、停止の記録は読めない（理由は管理者だけ）", getDoc(doc(suspendedB, "suspendedUsers/userB")));
  await ng("一般ユーザーは、他人の停止の記録を読めない", getDoc(doc(A, "suspendedUsers/userB")));
  await ng("一般ユーザーは、停止中のユーザーの一覧を読めない", getDocs(collection(A, "suspendedUsers")));
  await ok("管理者は停止の記録を読める", getDoc(doc(admin, "suspendedUsers/userB")));
  await ok("管理者は停止中のユーザーの一覧を読める", getDocs(collection(admin, "suspendedUsers")));
  await ng("停止されたユーザー本人が、停止の記録を消す", deleteDoc(doc(suspendedB, "suspendedUsers/userB")));
  await ng("一般ユーザーが他人を停止する（記録を作る）", setDoc(doc(A, "suspendedUsers/userC"), { uid: "userC" }));
  await ng("管理者でも、ブラウザから停止の記録は書けない（Worker だけ）", setDoc(doc(admin, "suspendedUsers/userC"), { uid: "userC" }));
  await ok("管理者は操作の記録を読める", getDocs(collection(admin, "adminAuditLogs")));
  await ng("一般ユーザーは操作の記録を読めない", getDoc(doc(A, "adminAuditLogs/log1")));
  await ng("一般ユーザーが操作の記録を作る", addDoc(collection(A, "adminAuditLogs"), { action: "setPassword" }));
  await ng("管理者でも、ブラウザから操作の記録は書き換えられない", updateDoc(doc(admin, "adminAuditLogs/log1"), { action: "x" }));
  await ng("管理者でも、ブラウザから操作の記録は消せない", deleteDoc(doc(admin, "adminAuditLogs/log1")));
  await ok("管理者は削除の進み具合を読める", getDoc(doc(admin, "userDeletions/userB")));
  await ng("一般ユーザーは削除の進み具合を読めない", getDoc(doc(suspendedB, "userDeletions/userB")));
  await ng("一般ユーザーが削除の進み具合を書き換える", setDoc(doc(suspendedB, "userDeletions/userB"), { status: "completed" }));
  await ng("管理者でも、ブラウザから削除の進み具合は書けない", setDoc(doc(admin, "userDeletions/userB"), { status: "completed" }));
  await ng("未ログイン：停止の記録の読み取り", getDoc(doc(anon, "suspendedUsers/userB")));

  log.push("--- 🔔 通知の送信記録（notificationLogs）は、通知サーバー（サービスアカウント）だけが書く（先に作って通知を止められないように）");
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), "notificationLogs/derby-2030-01-01"), { kind: "derby", by: "notify-worker" });
  });
  await ng("一般ユーザーが、これから始まるダービーの通知記録を先に作る", setDoc(doc(A, "notificationLogs/derby-2030-01-02"), { kind: "derby" }));
  await ng("一般ユーザーが、お知らせの通知記録を先に作る", setDoc(doc(A, "notificationLogs/announcement-pr-99"), { kind: "announcement" }));
  await ng("一般ユーザーが、チャットの通知記録を作る", addDoc(collection(A, "notificationLogs"), { createdAt: 1 }));
  await ng("一般ユーザーが、通知記録を書き換える", updateDoc(doc(A, "notificationLogs/derby-2030-01-01"), { by: "x" }));
  await ng("一般ユーザーが、通知記録を消す", deleteDoc(doc(A, "notificationLogs/derby-2030-01-01")));
  await ng("管理者でも、ブラウザから通知記録は書けない（Worker だけ）", setDoc(doc(admin, "notificationLogs/derby-2030-01-03"), { kind: "derby" }));
  await ng("一般ユーザーは通知記録を読めない", getDoc(doc(A, "notificationLogs/derby-2030-01-01")));
  await ng("管理者でも、ブラウザから通知記録は読めない（アプリは使わない）", getDoc(doc(admin, "notificationLogs/derby-2030-01-01")));
  await ng("未ログイン：通知記録を作る", setDoc(doc(anon, "notificationLogs/derby-2030-01-04"), { kind: "derby" }));
  await ok("通知トークンの保存（fcmTokens）は今まで通り", setDoc(doc(A, "fcmTokens/token-a"), { uid: "userA" }));

  log.push("--- 友達関係の解除（friends の削除）は当事者だけ。作成・更新は今まで通り");
  await env.withSecurityRulesDisabled(async (ctx) => {
    const d = ctx.firestore();
    await setDoc(doc(d, "users/carol"), { uid: "userC", name: "carol" });
    await setDoc(doc(d, "friends/alice_bob"), { user1: "alice", user2: "bob", user1Uid: "userA", user2Uid: "userB" });
    await setDoc(doc(d, "friends/bob_carol"), { user1: "bob", user2: "carol", user1Uid: "userB", user2Uid: "userC" });
    await setDoc(doc(d, "friends/alice_carol"), { user1: "alice", user2: "carol", user1Uid: "userA", user2Uid: "userC" });
    await setDoc(doc(d, "friends/alice_dave"), { user1: "alice", user2: "dave" }); /* uid の項目が無い古い友達関係 */
    await setDoc(doc(d, "friends/bob_dave"), { user1: "bob", user2: "dave" });
    await setDoc(doc(d, "messages/fm1"), { type: "friend", friendshipId: "alice_bob", sender: "alice", receiver: "bob", text: "やあ" });
  });
  const carol = env.authenticatedContext("userC").firestore();
  await ng("友達削除：当事者でない人（carol）が alice と bob の友達関係を消す", deleteDoc(doc(carol, "friends/alice_bob")));
  await ng("友達削除：当事者でない人（alice）が bob と carol の友達関係を消す", deleteDoc(doc(A, "friends/bob_carol")));
  await ng("友達削除：未ログインで消す", deleteDoc(doc(anon, "friends/alice_bob")));
  await ng("友達削除：uid の項目が無い古い友達関係を、当事者でない人（carol）が消す", deleteDoc(doc(carol, "friends/bob_dave")));
  await ng("友達削除：一括書き込み（batch）でも、他人の友達関係は消せない", (() => { const b = writeBatch(carol); b.delete(doc(carol, "friends/alice_bob")); return b.commit(); })());
  await ok("友達削除：当事者（user1 の alice）が消せる", deleteDoc(doc(A, "friends/alice_carol")));
  await ok("友達削除：当事者（user2 の bob）が消せる", deleteDoc(doc(B, "friends/alice_bob")));
  await ok("友達削除：uid の項目が無い古い友達関係も、名前の持ち主（alice）なら消せる", deleteDoc(doc(A, "friends/alice_dave")));
  await ok("友達削除のあとも、1対1のメッセージは残っていて読める", (async () => { const m = await getDoc(doc(A, "messages/fm1")); if (!m.exists()) throw new Error("メッセージが消えた"); })());
  await ok("友達削除のあとも、別の友達関係（bob と carol）は残っている", (async () => { const f = await getDoc(doc(carol, "friends/bob_carol")); if (!f.exists()) throw new Error("消えた"); })());
  await ok("友達追加（作成）は今まで通り", setDoc(doc(A, "friends/alice_bob"), { user1: "alice", user2: "bob", user1Uid: "userA", user2Uid: "userB", createdAt: serverTimestamp() }));
  await ok("友達関係の更新（最新メッセージ・既読）は今まで通り", updateDoc(doc(B, "friends/alice_bob"), { lastMessagePreview: "x", user2LastReadAt: serverTimestamp() }));
  await ok("名前変更の引き継ぎ（他人も含む友達関係の更新）は今まで通り", updateDoc(doc(carol, "friends/bob_carol"), { user2: "carol2", updatedAt: serverTimestamp() }));

  await env.cleanup();
  console.log(log.join("\n"));
  console.log(`\nRules セキュリティテスト: ${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
