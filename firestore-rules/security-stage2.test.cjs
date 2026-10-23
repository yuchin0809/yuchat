// 第2段階（チャット・通知）の Firestore Rules セキュリティテスト（Emulator で許可/拒否を実際に確かめる）
// ・他人の1対1チャット／グループチャットを読めない
// ・他人のメッセージを編集・削除できない
// ・FCM 通知トークンを他人の UID で登録・削除できない
// ・画像・既読・未読・グループ・通知などの正規操作は今まで通りできる
// 一般ユーザー・名前クレームの無いユーザー（匿名ゲスト相当）・未ログインの不正操作が拒否されることを確かめる
const { initializeTestEnvironment, assertSucceeds, assertFails } = require("@firebase/rules-unit-testing");
const fs = require("fs");
const path = require("path");
const { doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, addDoc, collection, query, where, orderBy, limit, or, and, deleteField, serverTimestamp } = require("firebase/firestore");

let pass = 0, fail = 0; const logs = [];
async function ok(n, p) { try { await assertSucceeds(p); pass++; logs.push("PASS 許可 " + n); } catch (e) { fail++; logs.push("FAIL(許可されるべき) " + n + ": " + String(e.message).split("\n")[0]); } }
async function ng(n, p) { try { await assertFails(p); pass++; logs.push("PASS 拒否 " + n); } catch (e) { fail++; logs.push("FAIL(拒否されるべき) " + n); } }

(async () => {
  const env = await initializeTestEnvironment({ projectId: "demo-yuuchat-rules", firestore: { rules: fs.readFileSync(path.join(__dirname, "..", "firestore.rules"), "utf8"), host: "127.0.0.1", port: 8080 } });
  const alice = env.authenticatedContext("uidA", { name: "alice" }).firestore();
  const bob = env.authenticatedContext("uidB", { name: "bob" }).firestore();
  const carol = env.authenticatedContext("uidC", { name: "carol" }).firestore();
  const noname = env.authenticatedContext("uidX").firestore(); // 名前クレームが無い（匿名ゲスト相当・同期前）
  const anon = env.unauthenticatedContext().firestore();

  const t = (ms) => new Date(Date.now() + ms);
  await env.withSecurityRulesDisabled(async (ctx) => {
    const d = ctx.firestore();
    await setDoc(doc(d, "users/alice"), { uid: "uidA", name: "alice" });
    await setDoc(doc(d, "users/bob"), { uid: "uidB", name: "bob" });
    await setDoc(doc(d, "users/carol"), { uid: "uidC", name: "carol" });
    // グループ
    await setDoc(doc(d, "groups/g1"), { name: "G1", owner: "alice", ownerUid: "uidA", members: ["alice", "bob"] });
    await setDoc(doc(d, "groups/gLeave"), { name: "GL", owner: "alice", ownerUid: "uidA", members: ["alice", "bob"] });
    await setDoc(doc(d, "groups/gRemove"), { name: "GR", owner: "alice", ownerUid: "uidA", members: ["alice", "bob"] });
    await setDoc(doc(d, "groups/gDel"), { name: "GD", owner: "alice", ownerUid: "uidA", members: ["alice", "bob"] });
    await setDoc(doc(d, "groups/gLegacy"), { name: "GLeg", owner: "alice", members: ["alice", "bob"] }); // ownerUid 無し（古いグループ）
    await setDoc(doc(d, "groups/gSolo"), { name: "GS", owner: "alice", ownerUid: "uidA", members: ["bob"] }); // 最後の1人が bob
    // メッセージ（1対1：alice↔bob）
    await setDoc(doc(d, "messages/dm1"), { sender: "alice", senderUid: "uidA", receiver: "bob", type: "friend", text: "hi", image: null, readBy: ["alice"], createdAt: t(-5000) });
    await setDoc(doc(d, "messages/dm2"), { sender: "bob", senderUid: "uidB", receiver: "alice", type: "friend", text: "yo", createdAt: t(-4000) });
    await setDoc(doc(d, "messages/dmReact"), { sender: "alice", senderUid: "uidA", receiver: "bob", type: "friend", text: "r", createdAt: t(-3500) });
    await setDoc(doc(d, "messages/dmDel"), { sender: "alice", senderUid: "uidA", receiver: "bob", type: "friend", text: "d", createdAt: t(-3400) });
    // メッセージ（グループ g1）
    await setDoc(doc(d, "messages/gm1"), { sender: "alice", senderUid: "uidA", groupId: "g1", type: "group", text: "g-hi", createdAt: t(-3000) });
    await setDoc(doc(d, "messages/gmReact"), { sender: "alice", senderUid: "uidA", groupId: "g1", type: "group", text: "g-r", createdAt: t(-2500) });
    await setDoc(doc(d, "messages/gmDel"), { sender: "bob", senderUid: "uidB", groupId: "g1", type: "group", text: "g-d", createdAt: t(-2400) });
    await setDoc(doc(d, "messages/gmSolo"), { sender: "bob", senderUid: "uidB", groupId: "gSolo", type: "group", text: "solo", createdAt: t(-2300) });
    // 古い1対1メッセージ（senderUid / type 無し）
    await setDoc(doc(d, "messages/old1"), { sender: "alice", receiver: "bob", text: "old", createdAt: t(-9000) });
    // 通知トークン
    await setDoc(doc(d, "fcmTokens/tokA"), { uid: "uidA", username: "alice" });
    await setDoc(doc(d, "fcmTokens/tokDel"), { uid: "uidA", username: "alice" });
  });

  const dmQuery = (db, me, other) => query(collection(db, "messages"), or(
    and(where("sender", "==", me), where("receiver", "==", other)),
    and(where("sender", "==", other), where("receiver", "==", me))
  ), orderBy("createdAt", "desc"), limit(15));
  const groupMsgQuery = (db, gid) => query(collection(db, "messages"), where("groupId", "==", gid), orderBy("createdAt", "desc"), limit(15));
  const myGroups = (db, name) => getDocs(query(collection(db, "groups"), where("members", "array-contains", name)));

  logs.push("--- ① メッセージの読み取り：当事者・メンバーだけ");
  await ok("alice が alice↔bob の1対1を読む", getDocs(dmQuery(alice, "alice", "bob")));
  await ok("bob が alice↔bob の1対1を読む", getDocs(dmQuery(bob, "bob", "alice")));
  await ng("carol が alice↔bob の1対1を覗く", getDocs(dmQuery(carol, "alice", "bob")));
  await ng("名前クレーム無しのユーザーが alice↔bob を覗く", getDocs(dmQuery(noname, "alice", "bob")));
  await ng("未ログインが alice↔bob を覗く", getDocs(dmQuery(anon, "alice", "bob")));
  await ok("alice がグループ g1 を読む", getDocs(groupMsgQuery(alice, "g1")));
  await ok("bob がグループ g1 を読む", getDocs(groupMsgQuery(bob, "g1")));
  await ng("carol（非メンバー）がグループ g1 を覗く", getDocs(groupMsgQuery(carol, "g1")));
  await ng("名前クレーム無しがグループ g1 を覗く", getDocs(groupMsgQuery(noname, "g1")));
  await ng("messages 全件読み（フィルタ無し）", getDocs(query(collection(carol, "messages"), limit(15))));
  await ok("alice が自分あての古い1対1メッセージを読む（単体 get）", getDoc(doc(alice, "messages/old1")));
  await ng("carol が alice↔bob の古いメッセージを覗く（単体 get）", getDoc(doc(carol, "messages/old1")));
  await ng("carol が alice↔bob のメッセージを単体 get で覗く", getDoc(doc(carol, "messages/dm1")));
  await ng("carol が g1 のメッセージを単体 get で覗く", getDoc(doc(carol, "messages/gm1")));

  logs.push("--- ② メッセージの作成：送信者が自分のときだけ");
  await ok("alice が自分の1対1メッセージを送る", addDoc(collection(alice, "messages"), { sender: "alice", senderUid: "uidA", receiver: "carol", type: "friend", text: "hi", createdAt: serverTimestamp() }));
  await ng("alice が bob になりすまして送る（sender を偽装）", addDoc(collection(alice, "messages"), { sender: "bob", senderUid: "uidA", receiver: "carol", type: "friend", text: "x", createdAt: serverTimestamp() }));
  await ng("alice が senderUid を他人にして送る", addDoc(collection(alice, "messages"), { sender: "alice", senderUid: "uidB", receiver: "carol", type: "friend", text: "x", createdAt: serverTimestamp() }));
  await ok("bob がグループ g1 にメッセージを送る（メンバー）", addDoc(collection(bob, "messages"), { sender: "bob", senderUid: "uidB", groupId: "g1", type: "group", text: "g", createdAt: serverTimestamp() }));
  await ng("carol がグループ g1 にメッセージを送る（非メンバー）", addDoc(collection(carol, "messages"), { sender: "carol", senderUid: "uidC", groupId: "g1", type: "group", text: "g", createdAt: serverTimestamp() }));
  await ng("名前クレーム無しがメッセージを送る", addDoc(collection(noname, "messages"), { sender: "", senderUid: "uidX", receiver: "bob", type: "friend", text: "x", createdAt: serverTimestamp() }));
  await ng("未ログインがメッセージを送る", addDoc(collection(anon, "messages"), { sender: "alice", text: "x" }));

  logs.push("--- ③ メッセージの更新：リアクションは当事者、送信取り消しは送信者だけ");
  await ok("bob が alice のメッセージにリアクション（当事者）", updateDoc(doc(bob, "messages/dmReact"), { reactions: { "👍": ["bob"] } }));
  await ng("carol が alice↔bob のメッセージにリアクション", updateDoc(doc(carol, "messages/dmReact"), { reactions: { "👍": ["carol"] } }));
  await ok("bob がグループ g1 のメッセージにリアクション（メンバー）", updateDoc(doc(bob, "messages/gmReact"), { reactions: { "👍": ["bob"] } }));
  await ng("carol がグループ g1 のメッセージにリアクション（非メンバー）", updateDoc(doc(carol, "messages/gmReact"), { reactions: { "👍": ["carol"] } }));
  await ok("alice が自分のメッセージを送信取り消し（soft delete）", updateDoc(doc(alice, "messages/dmDel"), { deleted: true, deletedAt: serverTimestamp(), image: deleteField() }));
  await ng("bob が alice のメッセージを送信取り消し", updateDoc(doc(bob, "messages/dm1"), { deleted: true, deletedAt: serverTimestamp() }));
  await ng("alice が自分のメッセージの本文を書き換える（編集は不可）", updateDoc(doc(alice, "messages/dm1"), { text: "書き換え" }));
  await ng("carol が他人のメッセージを書き換える", updateDoc(doc(carol, "messages/dm1"), { text: "x" }));

  logs.push("--- ④ メッセージの完全削除：グループの管理者がグループ削除のときに消す");
  await ng("bob（メンバーだが管理者でない）がグループ g1 のメッセージを完全削除", deleteDoc(doc(bob, "messages/gm1")));
  await ng("carol がグループ g1 のメッセージを完全削除", deleteDoc(doc(carol, "messages/gm1")));
  await ng("alice が1対1メッセージを完全削除（1対1は完全削除しない）", deleteDoc(doc(alice, "messages/dm1")));
  await ok("alice（g1 の管理者）がグループ g1 のメッセージを完全削除", deleteDoc(doc(alice, "messages/gm1")));
  await ng("carol が最後の1人グループ gSolo のメッセージを完全削除", deleteDoc(doc(carol, "messages/gmSolo")));
  await ok("最後の1人 bob が gSolo のメッセージを完全削除（グループを閉じるとき）", deleteDoc(doc(bob, "messages/gmSolo")));

  logs.push("--- ⑤ グループ：メンバーだけ読み書き");
  await ok("alice が自分のグループ一覧を読む", myGroups(alice, "alice"));
  await ng("carol が alice のグループ一覧を覗く（array-contains alice）", myGroups(carol, "alice"));
  await ng("carol が g1 を単体 get で覗く", getDoc(doc(carol, "groups/g1")));
  await ng("未ログインが g1 を読む", getDoc(doc(anon, "groups/g1")));
  await ok("alice が新しいグループを作る（自分が作成者・members に自分）", addDoc(collection(alice, "groups"), { name: "new", owner: "alice", ownerUid: "uidA", members: ["alice", "bob"], createdAt: serverTimestamp() }));
  await ng("alice が自分を入れずにグループを作る", addDoc(collection(alice, "groups"), { name: "x", owner: "alice", ownerUid: "uidA", members: ["bob"], createdAt: serverTimestamp() }));
  await ng("alice が ownerUid を他人にしてグループを作る", addDoc(collection(alice, "groups"), { name: "x", owner: "alice", ownerUid: "uidB", members: ["alice"], createdAt: serverTimestamp() }));
  await ng("未ログインがグループを作る", addDoc(collection(anon, "groups"), { name: "x", members: ["alice"] }));
  await ok("管理者 alice がメンバーを追加", updateDoc(doc(alice, "groups/g1"), { members: ["alice", "bob", "carol"], updatedAt: serverTimestamp() }));
  await ok("メンバー bob が既読（lastReadAt）を更新", updateDoc(doc(bob, "groups/g1"), { "lastReadAt.uidB": serverTimestamp() }));
  // アプリが1回の書き込み（バッチ）で、メッセージの追加と同時に書く「最新メッセージ」の項目（管理者でないメンバーも、これで送れること）
  const chatLast = (uid, name) => ({ lastMessageAt: serverTimestamp(), lastMessageSenderUid: uid, lastMessageId: "m1", lastMessageSender: name, lastMessagePreview: "こんにちは", lastMessageHasImage: false, "lastReadAt": { [uid]: serverTimestamp() } });
  await ok("メンバー bob（管理者でない）が、メッセージ送信と同時に最新メッセージ・既読を更新", setDoc(doc(bob, "groups/g1"), chatLast("uidB", "bob"), { merge: true }));
  await ng("メンバー bob が最新メッセージの更新と一緒にグループ名も変える", setDoc(doc(bob, "groups/g1"), { ...chatLast("uidB", "bob"), name: "勝手に変更" }, { merge: true }));
  await ng("メンバー bob がグループ名を変更（管理者だけ）", updateDoc(doc(bob, "groups/g1"), { name: "勝手に変更" }));
  await ng("非メンバー carol が g1 を更新", updateDoc(doc(carol, "groups/gDel"), { name: "x" }));
  await ok("メンバー bob が gLeave から自分だけ退出", updateDoc(doc(bob, "groups/gLeave"), { members: ["alice"], "lastReadAt.uidB": deleteField(), updatedAt: serverTimestamp() }));
  await ng("メンバー bob が gRemove から他人（alice）を外して自分は残る", updateDoc(doc(bob, "groups/gRemove"), { members: ["bob"], updatedAt: serverTimestamp() }));
  await ok("管理者 alice が gRemove から bob を外す", updateDoc(doc(alice, "groups/gRemove"), { members: ["alice"], updatedAt: serverTimestamp() }));
  await ok("古いグループ（ownerUid 無し）も名前の持ち主 alice が管理者として更新", updateDoc(doc(alice, "groups/gLegacy"), { name: "改名OK", updatedAt: serverTimestamp() }));
  await ng("メンバー bob（最後の1人でない）が gDel を削除", deleteDoc(doc(bob, "groups/gDel")));
  await ok("管理者 alice が gDel を削除", deleteDoc(doc(alice, "groups/gDel")));
  await ok("最後の1人 bob が gSolo を削除", deleteDoc(doc(bob, "groups/gSolo")));

  logs.push("--- ⑥ 通知トークン（fcmTokens）：自分の UID だけ・読み取りはアプリからは不可");
  await ok("alice が自分の UID でトークンを登録", setDoc(doc(alice, "fcmTokens/tokNew"), { uid: "uidA", username: "alice", updatedAt: serverTimestamp() }));
  await ng("alice が他人の UID でトークンを登録", setDoc(doc(alice, "fcmTokens/tokEvil"), { uid: "uidB", username: "bob", updatedAt: serverTimestamp() }));
  await ng("未ログインがトークンを登録", setDoc(doc(anon, "fcmTokens/tokAnon"), { uid: "uidA" }));
  await ng("alice がトークンを読む（アプリからは読めない）", getDoc(doc(alice, "fcmTokens/tokA")));
  await ng("alice がトークン一覧を読む", getDocs(collection(alice, "fcmTokens")));
  await ng("bob が alice の UID のトークンを削除", deleteDoc(doc(bob, "fcmTokens/tokDel")));
  await ok("alice が自分の UID のトークンを削除", deleteDoc(doc(alice, "fcmTokens/tokDel")));

  await env.cleanup();
  console.log(logs.join("\n"));
  console.log(`\n第2段階 セキュリティテスト: ${pass} PASS / ${fail} FAIL`);
  if (fail) process.exit(1);
})().catch((e) => { console.error(e); process.exit(2); });
