/* 💸 コインの送金（管理者の承認制）の画面
   ・ゆう経済タブの「コインを送る」（申請・取り消し）／ユーザー管理タブの「コイン送金の申請」（管理者が OK・却下）
   ・申請の確定・コインの移動・返金はすべて通知 Worker が行う。ここは表示と、ボタンを押して頼むだけ。
   ・ゆう経済の画面（renderEconomyView）は残高が変わるたびに描き直されるので、入力欄は別の枠（#transferPanel）に置いて描き直しに巻き込まれないようにしている */

let cfg = null;
let mine = [];
let adminList = null;
let busy = false;
let adminBusy = false;
let draft = { to: "", amount: "" };

const MESSAGES = {
  self: "自分には送れません。",
  user_not_found: "その名前のユーザーが見つかりません。名前をもう一度確かめてください。",
  invalid_receiver: "送る相手の名前が正しくありません。",
  invalid_amount: "金額は1以上の整数で入力してください。",
  insufficient_coins: "手持ちのコインが足りません。",
  seated: "ゆうスロに座っている間は申請できません。台から立ってからもう一度お試しください。",
  busy: "ほかの操作と重なりました。もう一度お試しください。",
  not_pending: "この申請はすでに処理されています。",
  not_found: "申請が見つかりません。",
  receiver_missing: "受け取る人のアカウントが見つかりません。「却下」で送った人に戻してください。",
  balance_too_large: "相手のコインが多くなりすぎるため、送れません。",
  NETWORK: "サーバーに接続できませんでした。時間をおいてもう一度お試しください。",
  network: "サーバーに接続できませんでした。時間をおいてもう一度お試しください。",
  NOT_LOGGED_IN: "ログインしてください。",
  NO_USER: "ユーザー情報が見つかりません。",
  not_admin: "管理者だけが操作できます。"
};
const messageOf = (error) => MESSAGES[error?.economyCode || error?.code] || "処理できませんでした。時間をおいてもう一度お試しください。";

const jst = (ms) => new Date(ms + 9 * 3600000);
const fmtDateTime = (ms) => { if (!ms) return "-"; const d = jst(ms); return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, "0")}`; };
const fmtDate = (ms) => { if (!ms) return "-"; const d = jst(ms); return `${d.getUTCFullYear()}/${d.getUTCMonth() + 1}/${d.getUTCDate()}`; };
const fmtLeft = (ms) => { const m = Math.max(0, Math.floor(ms / 60000)); const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60); return d > 0 ? `${d}日${h}時間` : h > 0 ? `${h}時間` : `${m}分`; };
const parseAmount = (v) => { const n = Number(String(v ?? "").replace(/[,，\s]/g, "")); return Number.isSafeInteger(n) && n > 0 ? n : null; };
const coin = (n) => Number(n).toLocaleString();

function ensureStyles() {
  if (document.getElementById("yutransfer-styles")) return;
  const style = document.createElement("style");
  style.id = "yutransfer-styles";
  style.textContent = `
    .yt-panel { margin-top: 16px; }
    .yt-panel h3 { margin: 0 0 6px; font-size: 18px; }
    .yt-note { margin: 4px 0 10px; font-size: 12px; color: #6b7280; line-height: 1.6; }
    .yt-form { display: grid; gap: 8px; }
    .yt-form label { display: grid; gap: 4px; font-size: 13px; font-weight: 700; }
    .yt-form input { padding: 10px 12px; border: 1px solid #d1d5db; border-radius: 12px; font-size: 16px; min-width: 0; }
    .yt-chips { display: flex; flex-wrap: wrap; gap: 6px; }
    .yt-chips button { padding: 6px 10px; border: 1px solid #d1d5db; border-radius: 999px; background: #fff; font-size: 12px; cursor: pointer; }
    .yt-btn { padding: 10px 14px; border: 0; border-radius: 12px; background: #2563eb; color: #fff; font-weight: 800; cursor: pointer; }
    .yt-btn.sub { background: #e5e7eb; color: #111827; }
    .yt-btn.ng { background: #dc2626; }
    .yt-btn:disabled { opacity: .5; cursor: not-allowed; }
    .yt-list { display: grid; gap: 8px; margin-top: 10px; }
    .yt-item { padding: 10px 12px; border: 1px solid #e5e7eb; border-radius: 14px; background: #f9fafb; display: grid; gap: 6px; }
    .yt-item b { font-size: 15px; }
    .yt-item small { color: #6b7280; line-height: 1.6; }
    .yt-actions { display: flex; flex-wrap: wrap; gap: 8px; }
    .yt-warn { padding: 6px 8px; border-radius: 10px; background: #fef3c7; color: #92400e; font-size: 12px; font-weight: 700; }
    .yt-empty { font-size: 13px; color: #6b7280; padding: 6px 0; }
    .yt-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .yt-head h3 { margin: 0; font-size: 14px; }
  `;
  document.head.appendChild(style);
}

export function transferInit(config) { cfg = config; }

export function transferReset() {
  mine = []; adminList = null; busy = false; adminBusy = false; draft = { to: "", amount: "" };
  const a = document.getElementById("transferPanel"); if (a) a.innerHTML = "";
  const b = document.getElementById("userManageTransfers"); if (b) b.innerHTML = "";
}

/* ===== 本人：コインを送る（申請・取り消し） ===== */
export async function transferOpenUser() {
  if (!cfg || !cfg.isLoggedIn()) return;
  ensureStyles();
  renderUser();
  await loadMine();
}

async function loadMine() {
  try { const r = await cfg.callEconomy("transferMine"); mine = r.requests || []; } catch (error) { console.error("送金の申請の読み込みエラー:", error); }
  renderUser();
}

function renderUser() {
  const el = document.getElementById("transferPanel");
  if (!el) return;
  if (!cfg || !cfg.isLoggedIn()) { el.innerHTML = ""; return; }
  const esc = cfg.esc;
  const friends = [...new Set(cfg.getFriends())];
  const now = Date.now();
  const hadFocus = el.contains(document.activeElement) ? document.activeElement.id : "";
  el.innerHTML = `
    <section class="econ-card yt-panel" aria-label="コインを送る">
      <h3>💸 コインを送る</h3>
      <p class="yt-note">送るコインは、申請した時点で手持ちから先に引かれます。管理者が確認して「OK」を押すと相手に届きます（却下されたとき・3日たっても承認されないときは、全額もどります）。ゆうスロに座っている間は申請できません。</p>
      <div class="yt-form">
        <label>送る相手の名前
          <input id="ytTo" type="text" list="ytFriends" autocomplete="off" placeholder="例：ゆうき" value="${esc(draft.to)}">
        </label>
        <datalist id="ytFriends">${friends.map((f) => `<option value="${esc(f)}"></option>`).join("")}</datalist>
        <label>金額（コイン）
          <input id="ytAmount" type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="off" placeholder="例：100" value="${esc(draft.amount)}">
        </label>
        <div class="yt-chips">
          <button type="button" data-yt-amount="100">100</button>
          <button type="button" data-yt-amount="500">500</button>
          <button type="button" data-yt-amount="all">手持ち全部</button>
        </div>
        <button type="button" class="yt-btn" id="ytSubmit" ${busy ? "disabled" : ""}>送る申請をする</button>
      </div>
      <h4 style="margin:16px 0 6px;font-size:14px">承認待ちの申請</h4>
      ${mine.length ? `<div class="yt-list">${mine.map((r) => `
        <div class="yt-item">
          <b>→ ${esc(r.to)} さんへ ${coin(r.amount)} コイン</b>
          <small>申請 ${esc(fmtDateTime(r.createdAtMs))}・あと ${esc(fmtLeft(r.expiresAtMs - now))} で承認されなければ自動で戻ります</small>
          <div class="yt-actions"><button type="button" class="yt-btn sub" data-yt-cancel="${esc(r.id)}" ${busy ? "disabled" : ""}>取り消して戻す</button></div>
        </div>`).join("")}</div>` : `<p class="yt-empty">承認待ちの申請はありません。</p>`}
    </section>`;
  if (hadFocus) { const t = document.getElementById(hadFocus); if (t) { t.focus({ preventScroll: true }); } }
}

document.addEventListener("input", (event) => {
  const t = event.target;
  if (t?.id === "ytTo") draft.to = t.value;
  if (t?.id === "ytAmount") draft.amount = t.value;
});

document.addEventListener("click", async (event) => {
  const chip = event.target.closest?.("[data-yt-amount]");
  if (chip && document.getElementById("transferPanel")?.contains(chip)) {
    const v = chip.dataset.ytAmount;
    draft.amount = v === "all" ? String(Math.max(0, Math.floor(cfg?.getMyCoins?.() || 0))) : v;
    renderUser();
    return;
  }
  if (event.target.id === "ytSubmit") return submitRequest();
  const cancel = event.target.closest?.("[data-yt-cancel]");
  if (cancel && document.getElementById("transferPanel")?.contains(cancel)) return cancelRequest(cancel.dataset.ytCancel);
  const ok = event.target.closest?.("[data-yt-approve]");
  if (ok && document.getElementById("userManageTransfers")?.contains(ok)) return adminResolve("transferApprove", ok.dataset.ytApprove, ok.dataset.ytLabel);
  const ng = event.target.closest?.("[data-yt-reject]");
  if (ng && document.getElementById("userManageTransfers")?.contains(ng)) return adminResolve("transferReject", ng.dataset.ytReject, ng.dataset.ytLabel);
  if (event.target.id === "ytAdminReload") return transferOpenAdmin();
});

async function submitRequest() {
  if (busy || !cfg) return;
  const to = draft.to.trim();
  const amount = parseAmount(draft.amount);
  if (!to) { alert("送る相手の名前を入力してください。"); return; }
  if (!amount) { alert(MESSAGES.invalid_amount); return; }
  if (!confirm(`${to} さんへ ${coin(amount)} コインを送る申請をします。\n\n申請した時点で、手持ちから ${coin(amount)} コインが引かれます。管理者が確認して OK するまで相手には届きません（却下されたら全額もどります）。\n\nよろしいですか？`)) return;
  busy = true; renderUser();
  try {
    await cfg.callEconomy("transferRequest", { to, amount });
    draft = { to: "", amount: "" };
    cfg.toast("💸 コインを送る", `${to} さんへの ${coin(amount)} コインの申請を出しました。管理者の確認をお待ちください。`);
  } catch (error) {
    if (!MESSAGES[error?.economyCode || error?.code]) console.error("送金の申請エラー:", error);
    alert(messageOf(error));
  } finally {
    busy = false;
    await loadMine();
  }
}

async function cancelRequest(id) {
  if (busy || !cfg) return;
  if (!confirm("この申請を取り消して、コインを手持ちに戻します。よろしいですか？")) return;
  busy = true; renderUser();
  try {
    await cfg.callEconomy("transferCancel", { id });
    cfg.toast("💸 コインを送る", "申請を取り消して、コインを戻しました。");
  } catch (error) {
    alert(messageOf(error));
  } finally {
    busy = false;
    await loadMine();
  }
}

/* ===== 管理者：申請の一覧と OK・却下 ===== */
export async function transferOpenAdmin() {
  if (!cfg || !cfg.isAdmin()) return;
  ensureStyles();
  renderAdmin("読み込み中…");
  try { adminList = await cfg.callAdmin("transferList"); renderAdmin(); }
  catch (error) { console.error("送金の申請の読み込みエラー:", error); renderAdmin(messageOf(error)); }
}

function who(info, esc) {
  if (!info) return "";
  if (!info.exists) return `<span class="yt-warn">アカウントが見つかりません</span>`;
  return `手持ち 🪙 ${info.coins === null || info.coins === undefined ? "-" : coin(info.coins)}・作成 ${esc(fmtDate(info.createdAt))}・最終ログイン ${esc(fmtDateTime(info.lastLoginAt))}${info.disabled ? "・<b>停止中</b>" : ""}`;
}

function renderAdmin(status = "") {
  const el = document.getElementById("userManageTransfers");
  if (!el) return;
  if (!cfg || !cfg.isAdmin()) { el.innerHTML = ""; return; }
  const esc = cfg.esc;
  const list = adminList?.requests || [];
  const now = adminList?.serverNowMs || Date.now();
  el.innerHTML = `
    <div class="yt-head"><h3>💸 コイン送金の申請（承認待ち ${list.length} 件）</h3><button type="button" class="yt-btn sub" id="ytAdminReload">更新</button></div>
    ${status ? `<p class="yt-note">${esc(status)}</p>` : ""}
    ${list.length ? `<div class="yt-list">${list.map((r) => {
      const label = `${r.senderName} → ${r.receiverName}（${coin(r.amount)}コイン）`;
      const crowd = r.toReceiver && r.toReceiver.count > 1 ? `<div class="yt-warn">⚠ ${esc(r.receiverName)} さん宛てに、いま ${r.toReceiver.count} 件・合計 ${coin(r.toReceiver.total)} コインの申請が集まっています</div>` : "";
      return `
      <div class="yt-item">
        <b>${esc(r.senderName)} → ${esc(r.receiverName)}　🪙 ${coin(r.amount)}</b>
        <small>申請 ${esc(fmtDateTime(r.createdAtMs))}（あと ${esc(fmtLeft(r.expiresAtMs - now))} で自動却下）</small>
        <small>送る人：${who(r.sender, esc)}</small>
        <small>受け取る人：${who(r.receiver, esc)}</small>
        ${crowd}
        <div class="yt-actions">
          <button type="button" class="yt-btn" data-yt-approve="${esc(r.id)}" data-yt-label="${esc(label)}" ${adminBusy ? "disabled" : ""}>OK（送る）</button>
          <button type="button" class="yt-btn ng" data-yt-reject="${esc(r.id)}" data-yt-label="${esc(label)}" ${adminBusy ? "disabled" : ""}>却下（送った人に戻す）</button>
        </div>
      </div>`;
    }).join("")}</div>` : `<p class="yt-empty">承認待ちの申請はありません。</p>`}`;
}

async function adminResolve(action, id, label) {
  if (adminBusy || !cfg) return;
  const approve = action === "transferApprove";
  if (!confirm(approve ? `${label}\n\nこの送金を承認して、相手にコインを送ります。よろしいですか？` : `${label}\n\nこの申請を却下して、送った人にコインを全額戻します。よろしいですか？`)) return;
  adminBusy = true; renderAdmin();
  try {
    await cfg.callAdmin(action, { id });
    cfg.toast("💸 コイン送金", approve ? "承認して、相手に送りました。" : "却下して、送った人に戻しました。");
  } catch (error) {
    if (!MESSAGES[error?.code]) console.error("送金の承認・却下エラー:", error);
    alert(messageOf(error));
  } finally {
    adminBusy = false;
    await transferOpenAdmin();
  }
}
