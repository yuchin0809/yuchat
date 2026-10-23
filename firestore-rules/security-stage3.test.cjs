// 第3段階（ゲーム・ユーザー作成）の Firestore Rules セキュリティテスト（Emulator で許可/拒否を実際に確かめる）
// ・ゲームルームの参加者以外が不正操作できない（参加・対局・退出・削除・招待）
// ・ユーザー作成時の UID・ユーザー名の不正取得や重複登録（他人の名前の横取り・なりすまし）を防ぐ
// ・既存のゲーム（大富豪・オセロ・将棋）の正規操作は今まで通りできる
const { initializeTestEnvironment, assertSucceeds, assertFails } = require("@firebase/rules-unit-testing");
const fs = require("fs");
const path = require("path");
const { doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, collection, query, where, serverTimestamp, runTransaction } = require("firebase/firestore");

let pass = 0, fail = 0; const logs = [];
async function ok(n, p) { try { await assertSucceeds(p); pass++; logs.push("PASS 許可 " + n); } catch (e) { fail++; logs.push("FAIL(許可されるべき) " + n + ": " + String(e.message).split("\n")[0]); } }
async function ng(n, p) { try { await assertFails(p); pass++; logs.push("PASS 拒否 " + n); } catch (e) { fail++; logs.push("FAIL(拒否されるべき) " + n); } }

(async () => {
  const env = await initializeTestEnvironment({ projectId: "demo-yuuchat-rules", firestore: { rules: fs.readFileSync(path.join(__dirname, "..", "firestore.rules"), "utf8"), host: "127.0.0.1", port: 8080 } });
  const alice = env.authenticatedContext("uidA", { name: "alice" }).firestore();
  const bob = env.authenticatedContext("uidB", { name: "bob" }).firestore();
  const carol = env.authenticatedContext("uidC", { name: "carol" }).firestore();
  const noname = env.authenticatedContext("uidX").firestore(); // 名前クレームが無い（匿名ゲスト相当・同期前）
  const admin = env.authenticatedContext("g51wzTvJFsZiYEfre5aDuDckJXY2", { name: "admin" }).firestore(); // 最上位のゆうChat管理者
  const anon = env.unauthenticatedContext().firestore();

  await env.withSecurityRulesDisabled(async (ctx) => {
    const d = ctx.firestore();
    await setDoc(doc(d, "users/alice"), { uid: "uidA", name: "alice" });
    await setDoc(doc(d, "users/bob"), { uid: "uidB", name: "bob" });
    await setDoc(doc(d, "users/carol"), { uid: "uidC", name: "carol" });
    await setDoc(doc(d, "users/xname"), { uid: "uidX", name: "xname" });
    // ゲームルーム
    await setDoc(doc(d, "gameRooms/room1"), { gameType: "othello", owner: "alice", ownerUid: "uidA", members: ["alice"], memberUids: ["uidA"], status: "waiting" });
    await setDoc(doc(d, "gameRooms/roomPlay"), { gameType: "othello", owner: "alice", ownerUid: "uidA", members: ["alice", "bob"], memberUids: ["uidA", "uidB"], status: "playing", gameState: { currentPlayer: "black" } });
    await setDoc(doc(d, "gameRooms/roomInvite"), { gameType: "othello", owner: "alice", ownerUid: "uidA", members: ["alice"], memberUids: ["uidA"], status: "waiting", invitedUsers: ["carol"] });
    await setDoc(doc(d, "gameRooms/roomDel"), { gameType: "othello", owner: "alice", ownerUid: "uidA", members: ["alice", "bob"], memberUids: ["uidA", "uidB"], status: "waiting" });
    await setDoc(doc(d, "gameRooms/roomSolo"), { gameType: "othello", owner: "alice", members: ["bob"], memberUids: ["uidB"], status: "waiting" }); // ownerUid 無し・最後の1人が bob
    // ルール作成の記録（ロック）
    await setDoc(doc(d, "gameRoomOwners/uidA_othello"), { uid: "uidA", gameType: "othello", roomId: "room1" });
    await setDoc(doc(d, "gameRoomOwners/uidA_del"), { uid: "uidA", gameType: "shogi", roomId: "roomZ" });
    // 招待
    await setDoc(doc(d, "gameInvites/room1_uidC"), { roomId: "room1", gameType: "othello", from: "alice", fromUid: "uidA", to: "carol", toUid: "uidC", status: "pending" });
    await setDoc(doc(d, "gameInvites/roomInvite_uidC"), { roomId: "roomInvite", gameType: "othello", from: "alice", fromUid: "uidA", to: "carol", toUid: "uidC", status: "pending" });
    // 🎰 ゆうワールド：公開設定（worldConfig/yuslot）と着席（yuslotSeats/{台ID}）。どちらも Worker（サービスアカウント）だけが書く
    await setDoc(doc(d, "worldConfig/yuslot"), { yuslotPublished: false });
    await setDoc(doc(d, "yuslotSeats/yubasic"), { uid: "uidA", name: "alice", nonce: "n1", delta: 0, flushedTotal: 0 });
    // 🎟 ゆう宝くじ：購入枚数（lotteryEntries）と抽選結果（lotteryRounds）は Worker（サービスアカウント）だけが書く
    await setDoc(doc(d, "lotteryEntries/2026-10-23_uidA"), { uid: "uidA", name: "alice", round: "2026-10-23", count: 3 });
    await setDoc(doc(d, "lotteryRounds/2026-10-23"), { round: "2026-10-23", tickets: 3, sales: 30, status: "open" });
    // 🌈 ゆうスロ確変台：枠・申込（yuslotKaku）と通知の好み（yuslotPrefs）は Worker（サービスアカウント）だけが書く
    await setDoc(doc(d, "yuslotKaku/2026-10-21"), { day: "2026-10-21", machine: "yubasic", slots: [], app1: [], app2: [] });
    await setDoc(doc(d, "yuslotPrefs/uidA"), { uid: "uidA", kakuNotify: { result1: true } });
    // 💸 コインの送金：申請と状態（coinTransfers）は Worker（サービスアカウント）だけが書く
    await setDoc(doc(d, "yuslotRank/current"), { weekStart: 1, base: { uidA: 100 }, ranks: { uidA: 1 }, lastWeek: { uidA: 600 } });
    await setDoc(doc(d, "yuslotBattle/uidA"), { day: "2026-10-21", st: 1, as: 1, a: 1, d: true, ms: 9000, g: 0, n: "alice" });
    await setDoc(doc(d, "yuslotBattle/_board"), { rows: [{ uid: "uidA", name: "alice", ms: 9000, day: "2026-10-21", pms: 0, pday: "" }] });
    await setDoc(doc(d, "coinTransfers/t1"), { senderUid: "uidA", senderName: "alice", receiverUid: "uidB", receiverName: "bob", amount: 100, status: "pending", createdAtMs: 1 });
  });

  logs.push("--- ① ゲームルーム：読み取りはロビー公開、作成は作成者が自分");
  await ok("ログイン済みならロビー（gameRooms 一覧）を読める", getDocs(collection(alice, "gameRooms")));
  await ng("未ログインはロビーを読めない", getDocs(collection(anon, "gameRooms")));
  await ok("alice が部屋を作る（ownerUid が自分・memberUids が自分だけ）", setDoc(doc(alice, "gameRooms/newA"), { gameType: "othello", owner: "alice", ownerUid: "uidA", members: ["alice"], memberUids: ["uidA"], status: "waiting", createdAt: serverTimestamp() }));
  await ng("alice が ownerUid を他人にして部屋を作る", setDoc(doc(alice, "gameRooms/evil1"), { gameType: "othello", ownerUid: "uidB", members: ["bob"], memberUids: ["uidB"], status: "waiting" }));
  await ng("alice が最初から他人を入れて部屋を作る", setDoc(doc(alice, "gameRooms/evil2"), { gameType: "othello", ownerUid: "uidA", members: ["alice", "bob"], memberUids: ["uidA", "uidB"], status: "waiting" }));
  await ng("未ログインが部屋を作る", setDoc(doc(anon, "gameRooms/evil3"), { ownerUid: "uidA" }));

  logs.push("--- ② ゲームルーム：参加・対局・退出・招待辞退");
  await ok("bob が room1 に参加（自分を memberUids に追加）", updateDoc(doc(bob, "gameRooms/room1"), { members: ["alice", "bob"], memberUids: ["uidA", "uidB"], updatedAt: serverTimestamp() }));
  await ng("carol が room1 から alice を追い出す（参加者でも参加中でもない）", updateDoc(doc(carol, "gameRooms/roomDel"), { members: ["carol"], memberUids: ["uidC"], updatedAt: serverTimestamp() }));
  await ok("参加者 bob が roomPlay の盤面（gameState）を更新（対局）", updateDoc(doc(bob, "gameRooms/roomPlay"), { gameState: { currentPlayer: "white" }, updatedAt: serverTimestamp() }));
  await ng("非参加者 carol が roomPlay の盤面を更新", updateDoc(doc(carol, "gameRooms/roomPlay"), { gameState: { currentPlayer: "white" } }));
  await ng("参加者 bob が roomPlay にヨットの進み（yacht）を書き込む", updateDoc(doc(bob, "gameRooms/roomPlay"), { yacht: { c0: [50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50] }, updatedAt: serverTimestamp() }));
  await ng("参加者 bob が roomPlay に消しバトの進み（keshi）を書き込む", updateDoc(doc(bob, "gameRooms/roomPlay"), { keshi: { c0: [50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50] }, updatedAt: serverTimestamp() }));
  await ng("alice が最初からヨットの進み（yacht）つきで部屋を作る", setDoc(doc(alice, "gameRooms/evilY"), { gameType: "yacht", owner: "alice", ownerUid: "uidA", members: ["alice"], memberUids: ["uidA"], status: "waiting", yacht: { done: true }, createdAt: serverTimestamp() }));
  await ng("alice が最初から消しバトの進み（keshi）つきで部屋を作る", setDoc(doc(alice, "gameRooms/evilK"), { gameType: "keshi", owner: "alice", ownerUid: "uidA", members: ["alice"], memberUids: ["uidA"], status: "waiting", keshi: { done: true }, createdAt: serverTimestamp() }));
  await ok("招待された carol が invitedUsers から自分だけを外す（辞退）", updateDoc(doc(carol, "gameRooms/roomInvite"), { invitedUsers: [], updatedAt: serverTimestamp() }));
  await ng("非メンバー carol が roomInvite の状態を勝手に変える（参加せず）", updateDoc(doc(carol, "gameRooms/roomInvite"), { status: "playing" }));
  await ng("参加するふりで carol が他の参加者を追い出す（memberUids から他人を消す）", updateDoc(doc(carol, "gameRooms/room1"), { members: ["carol"], memberUids: ["uidC"] }));
  await ng("未ログインが部屋を更新", updateDoc(doc(anon, "gameRooms/room1"), { status: "x" }));

  logs.push("--- ③ ゲームルーム：削除は作成者または最後の1人");
  await ng("参加者だが作成者でない bob が roomDel を削除", deleteDoc(doc(bob, "gameRooms/roomDel")));
  await ng("非参加者 carol が room1 を削除", deleteDoc(doc(carol, "gameRooms/room1")));
  await ok("作成者 alice が roomDel を削除", deleteDoc(doc(alice, "gameRooms/roomDel")));
  await ok("最後の1人 bob が roomSolo を削除", deleteDoc(doc(bob, "gameRooms/roomSolo")));

  logs.push("--- ④ ルーム作成の記録（gameRoomOwners）：自分の UID の記録だけ");
  await ok("alice が自分のロックを読む", getDoc(doc(alice, "gameRoomOwners/uidA_othello")));
  await ng("carol が alice のロックを読む", getDoc(doc(carol, "gameRoomOwners/uidA_othello")));
  await ok("alice が存在しない自分のロックを読む（未作成）", getDoc(doc(alice, "gameRoomOwners/uidA_new")));
  await ok("alice が自分の UID のロックを作る", setDoc(doc(alice, "gameRoomOwners/uidA_daifugo"), { uid: "uidA", gameType: "daifugo", roomId: "r", updatedAt: serverTimestamp() }));
  await ng("alice が他人の UID のロックを作る", setDoc(doc(alice, "gameRoomOwners/uidB_othello"), { uid: "uidB", gameType: "othello", roomId: "r" }));
  await ng("carol が alice のロックを削除", deleteDoc(doc(carol, "gameRoomOwners/uidA_del")));
  await ok("alice が自分のロックを削除", deleteDoc(doc(alice, "gameRoomOwners/uidA_del")));

  logs.push("--- ⑤ ゲームの招待（gameInvites）：当事者だけ");
  await ok("送られた carol が自分あての招待を読む", getDocs(query(collection(carol, "gameInvites"), where("toUid", "==", "uidC"), where("status", "==", "pending"))));
  await ng("bob が carol あての招待を覗く", getDocs(query(collection(bob, "gameInvites"), where("toUid", "==", "uidC"), where("status", "==", "pending"))));
  await ok("ホスト alice が招待を作る（fromUid が自分・pending）", setDoc(doc(alice, "gameInvites/room1_uidB"), { roomId: "room1", gameType: "othello", from: "alice", fromUid: "uidA", to: "bob", toUid: "uidB", status: "pending", createdAt: serverTimestamp() }));
  await ng("bob が alice になりすまして招待を作る", setDoc(doc(bob, "gameInvites/room1_uidC2"), { roomId: "room1", fromUid: "uidA", to: "carol", toUid: "uidC", status: "pending" }));
  await ng("招待を最初から accepted で作る", setDoc(doc(alice, "gameInvites/room1_uidB2"), { roomId: "room1", fromUid: "uidA", toUid: "uidB", status: "accepted" }));
  await ok("送られた carol が招待を辞退（status 更新）", updateDoc(doc(carol, "gameInvites/room1_uidC"), { status: "declined", respondedAt: serverTimestamp() }));
  await ng("当事者でない bob が carol あての招待を更新", updateDoc(doc(bob, "gameInvites/roomInvite_uidC"), { status: "declined" }));
  await ok("まだ無い招待を調べる読み取り（招待を作る前の確認）", getDoc(doc(alice, "gameInvites/nothingYet_uidB")));
  await ok("alice が、招待を作るトランザクション（まだ無い招待を確かめて、作って、ルームの招待中を更新）", runTransaction(alice, async (tx) => {
    const ref = doc(alice, "gameInvites/roomPlay_uidB");
    await tx.get(ref);
    tx.set(ref, { roomId: "roomPlay", gameType: "keshi", from: "alice", fromUid: "uidA", to: "bob", toUid: "uidB", status: "pending", createdAt: serverTimestamp(), respondedAt: null });
    tx.update(doc(alice, "gameRooms/roomPlay"), { invitedUsers: ["bob"], updatedAt: serverTimestamp() });
  }));
  await ok("当事者（送り主 alice）が招待を削除", deleteDoc(doc(alice, "gameInvites/roomInvite_uidC")));
  await ng("当事者でない bob が招待を削除", deleteDoc(doc(bob, "gameInvites/room1_uidC")));

  logs.push("--- ⑥ ユーザー作成：UID・名前の不正取得／なりすまし／重複登録を防ぐ");
  await ok("alice が自分の新しい名前のユーザーを作る（uid 自分・name=ID・経済項目なし）", setDoc(doc(alice, "users/alice2"), { uid: "uidA", name: "alice2" }));
  await ng("alice が他人の UID でユーザーを作る（なりすまし）", setDoc(doc(alice, "users/fakeB"), { uid: "uidB", name: "fakeB" }));
  await ng("alice が name とドキュメントIDが食い違うユーザーを作る", setDoc(doc(alice, "users/mismatch"), { uid: "uidA", name: "別の名前" }));
  await ng("alice が経済項目入りでユーザーを作る", setDoc(doc(alice, "users/richA"), { uid: "uidA", name: "richA", coins: 1000000 }));
  await ng("未ログインがユーザーを作る", setDoc(doc(anon, "users/anonU"), { uid: "uidA", name: "anonU" }));
  await ng("carol が既存の他人（alice）のユーザー名を乗っ取る（上書き）", setDoc(doc(carol, "users/alice"), { uid: "uidC", name: "alice" }));
  await ok("名前クレームありのユーザーが、自分の名前のドキュメントを更新できる", updateDoc(doc(alice, "users/alice"), { online: true, updatedAt: serverTimestamp() }));
  await ng("名前クレームありのユーザーが、別の名前のドキュメントを更新できない（なりすまし）", updateDoc(doc(alice, "users/bob"), { online: true }));
  await ok("名前クレームがまだ無いユーザーは、自分の UID のドキュメントを更新できる（同期前）", updateDoc(doc(noname, "users/xname"), { online: true, updatedAt: serverTimestamp() }));

  logs.push("--- ⑦ ゆうワールド：公開設定（worldConfig）と着席（yuslotSeats）はサーバー（Worker）だけ");
  // worldConfig：公開/非公開はブラウザからは書けない（最上位管理者でも、Worker 経由でしか変えられない）。読み取りはログイン済みなら可
  await ok("ログイン済みユーザーが公開設定（worldConfig/yuslot）を読む", getDoc(doc(alice, "worldConfig/yuslot")));
  await ng("一般ユーザーが公開設定を勝手に公開に書き換える", setDoc(doc(alice, "worldConfig/yuslot"), { yuslotPublished: true }));
  await ng("一般ユーザーが公開設定を更新する", updateDoc(doc(alice, "worldConfig/yuslot"), { yuslotPublished: true }));
  await ng("最上位管理者でもブラウザから直接は公開設定を書き換えられない（Worker 経由だけ）", setDoc(doc(admin, "worldConfig/yuslot"), { yuslotPublished: true }));
  await ng("未ログインが公開設定を書き換える", setDoc(doc(anon, "worldConfig/yuslot"), { yuslotPublished: true }));
  // yuslotSeats：着席の予約・解放・更新は Worker だけ。ブラウザからは読み取りも書き込みもできない
  await ng("一般ユーザーが着席状況（yuslotSeats）を直接読む", getDoc(doc(alice, "yuslotSeats/yubasic")));
  await ng("最上位管理者でも着席状況を直接読めない（Worker 経由だけ）", getDoc(doc(admin, "yuslotSeats/yubasic")));
  await ng("一般ユーザーが勝手に着席する（yuslotSeats を作る）", setDoc(doc(bob, "yuslotSeats/yurush"), { uid: "uidB", name: "bob", nonce: "x", delta: 0, flushedTotal: 0 }));
  await ng("一般ユーザーが他人の着席を書き換えて不正にコインを増やす", updateDoc(doc(bob, "yuslotSeats/yubasic"), { delta: 1000000 }));
  await ng("一般ユーザーが他人の着席を解放（削除）する", deleteDoc(doc(bob, "yuslotSeats/yubasic")));
  await ng("最上位管理者でもブラウザから直接は着席を書き換えられない", updateDoc(doc(admin, "yuslotSeats/yubasic"), { delta: 1000000 }));

  logs.push("--- ⑧ ゆう宝くじ：購入枚数・抽選結果はサーバー（Worker）だけ。ブラウザからは読み書きできない");
  await ng("本人でも自分の購入枚数（lotteryEntries）を直接読めない（Worker 経由だけ）", getDoc(doc(alice, "lotteryEntries/2026-10-23_uidA")));
  await ng("他人の購入枚数を覗く", getDoc(doc(bob, "lotteryEntries/2026-10-23_uidA")));
  await ng("最上位管理者でも購入枚数を直接読めない", getDoc(doc(admin, "lotteryEntries/2026-10-23_uidA")));
  await ng("自分の購入枚数を勝手に増やす（当選確率の水増し）", updateDoc(doc(alice, "lotteryEntries/2026-10-23_uidA"), { count: 100000 }));
  await ng("タダで宝くじを買う（購入枚数を作る）", setDoc(doc(bob, "lotteryEntries/2026-10-23_uidB"), { uid: "uidB", name: "bob", round: "2026-10-23", count: 200 }));
  await ng("購入枚数を削除する", deleteDoc(doc(alice, "lotteryEntries/2026-10-23_uidA")));
  await ng("抽選結果（lotteryRounds）を直接読めない", getDoc(doc(alice, "lotteryRounds/2026-10-23")));
  await ng("抽選結果を書き換えて自分を当選させる", setDoc(doc(alice, "lotteryRounds/2026-10-23"), { status: "done", winners: [{ uid: "uidA", name: "alice", tier: "1等", amount: 999999 }] }));
  await ng("最上位管理者でもブラウザから抽選結果を書けない", updateDoc(doc(admin, "lotteryRounds/2026-10-23"), { status: "done" }));
  await ng("未ログインが購入枚数を作る", setDoc(doc(anon, "lotteryEntries/2026-10-23_uidZ"), { uid: "uidZ", count: 1 }));

  logs.push("--- ⑨ ゆうスロ確変台：枠・申込・通知の好みはサーバー（Worker）だけ。ブラウザからは読み書きできない");
  await ng("確変台の枠・申込（yuslotKaku）を直接読めない", getDoc(doc(alice, "yuslotKaku/2026-10-21")));
  await ng("最上位管理者でも直接読めない", getDoc(doc(admin, "yuslotKaku/2026-10-21")));
  await ng("自分を当選させる（枠の書き換え）", updateDoc(doc(alice, "yuslotKaku/2026-10-21"), { slots: [{ i: 0, uid: "uidA", name: "alice" }] }));
  await ng("勝手に申込を作る", setDoc(doc(bob, "yuslotKaku/2026-10-22"), { day: "2026-10-22", machine: "yubasic", slots: [] }));
  await ng("通知の好み（yuslotPrefs）を直接読めない", getDoc(doc(alice, "yuslotPrefs/uidA")));
  await ng("他人の通知の好みを書き換える", setDoc(doc(bob, "yuslotPrefs/uidA"), { uid: "uidA", kakuNotify: { result1: false } }));

  logs.push("--- ⑩ コインの送金：申請と状態はサーバー（Worker）だけ。ブラウザからは読み書きできない");
  await ng("送金の申請（coinTransfers）を直接読めない", getDoc(doc(alice, "coinTransfers/t1")));
  await ng("最上位管理者でも直接読めない", getDoc(doc(admin, "coinTransfers/t1")));
  await ng("自分で承認する（状態の書き換え）", updateDoc(doc(alice, "coinTransfers/t1"), { status: "approved" }));
  await ng("相手（受け取る人）が承認する", updateDoc(doc(bob, "coinTransfers/t1"), { status: "approved" }));
  await ng("最上位管理者でもブラウザから承認できない（承認は Worker 経由だけ）", updateDoc(doc(admin, "coinTransfers/t1"), { status: "approved" }));
  await ng("金額を書き換える", updateDoc(doc(alice, "coinTransfers/t1"), { amount: 999999 }));
  await ng("勝手に申請を作る", setDoc(doc(bob, "coinTransfers/t2"), { senderUid: "uidA", receiverUid: "uidB", amount: 5, status: "pending" }));
  await ng("申請を消す", deleteDoc(doc(alice, "coinTransfers/t1")));

  logs.push("--- ⑪ ゆうスロの会員ランク：全員のランク・累計はサーバー（Worker）だけ。ブラウザからは読み書きできない");
  await ng("ランク（yuslotRank）を直接読めない", getDoc(doc(alice, "yuslotRank/current")));
  await ng("最上位管理者でも直接読めない", getDoc(doc(admin, "yuslotRank/current")));
  await ng("自分のランクを最高にする", updateDoc(doc(alice, "yuslotRank/current"), { ranks: { uidA: 5 } }));
  await ng("最上位管理者でもブラウザからランクを書けない", updateDoc(doc(admin, "yuslotRank/current"), { ranks: { uidA: 5 } }));
  await ng("勝手にランクのドキュメントを作る", setDoc(doc(bob, "yuslotRank/evil"), { weekStart: 1, ranks: { uidB: 5 } }));
  await ng("ランクのドキュメントを消す", deleteDoc(doc(alice, "yuslotRank/current")));

  logs.push("--- ⑫ 先着ゲーム：一人ひとりの記録とランキングの元データはサーバー（Worker）だけ。ブラウザからは読み書きできない");
  await ng("自分の記録（yuslotBattle）を直接読めない", getDoc(doc(alice, "yuslotBattle/uidA")));
  await ng("ランキングの元データを直接読めない", getDoc(doc(alice, "yuslotBattle/_board")));
  await ng("最上位管理者でも直接読めない", getDoc(doc(admin, "yuslotBattle/_board")));
  await ng("自分のタイムを書き換える", updateDoc(doc(alice, "yuslotBattle/uidA"), { ms: 1 }));
  await ng("ランキングに自分を1位で書き込む", updateDoc(doc(alice, "yuslotBattle/_board"), { rows: [{ uid: "uidA", name: "alice", ms: 1, day: "2026-10-21", pms: 0, pday: "" }] }));
  await ng("最上位管理者でもブラウザから書けない", updateDoc(doc(admin, "yuslotBattle/_board"), { rows: [] }));
  await ng("勝手に記録を作る", setDoc(doc(bob, "yuslotBattle/uidB"), { day: "2026-10-21", d: true, ms: 1, g: 0 }));
  await ng("記録を消す", deleteDoc(doc(alice, "yuslotBattle/uidA")));

  await env.cleanup();
  console.log(logs.join("\n"));
  console.log(`\n第3段階 セキュリティテスト: ${pass} PASS / ${fail} FAIL`);
  if (fail) process.exit(1);
})().catch((e) => { console.error(e); process.exit(2); });
