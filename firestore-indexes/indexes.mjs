/* =========================================================
   Firestore の複合インデックス（../firestore.indexes.json）の本番確認・追加（GitHub Actions から実行）

   node indexes.mjs check    本番のインデックスを読み、firestore.indexes.json と比べる（本番は変えない）
   node indexes.mjs deploy   本番に無いものだけを作る。作ったあと、使えるようになる（READY）まで待つ
   node indexes.mjs verify   チャットの問い合わせ（1対1・グループ）を、どの文書にも当たらない値で1回ずつ試し、
                             インデックス不足（FAILED_PRECONDITION）にならないことを確かめる（読むだけ・書き込まない）

   安全のための決まり：
   ・インデックスを「作る」だけ。削除・変更は一切しない（API の DELETE・PATCH を呼ばない）
     firestore.indexes.json に無い本番のインデックスも、そのまま残す
   ・Firestore Rules・データ・その他の設定には触れない（Firebase CLI の deploy は使わない）
   ・サービスアカウントのプロジェクトが yuuchat-be666 でなければ止める
   ・同じ項目のインデックスがすでにあれば作らない（等号の項目の順番だけが違うものも、同じ問い合わせに使えるので作らない）
   ・インデックスの作成は無料プラン（Spark）のままで行える。課金や請求先の設定は変えない

   環境変数：
     FIREBASE_SERVICE_ACCOUNT  サービスアカウントの鍵（JSON）。GitHub Secrets（ゆうダービー自動開催・Firestore ルールと同じもの）
     GITHUB_STEP_SUMMARY       GitHub Actions が設定する。結果をここに書き出す
     INDEX_WAIT_MINUTES        deploy で READY を待つ最長の時間（分。省略時 25）
========================================================= */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

export const EXPECTED_PROJECT_ID = "yuuchat-be666";
const API = "https://firestore.googleapis.com/v1";
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const INDEXES_FILE = path.join(HERE, "..", "firestore.indexes.json");

/* ----- firestore.indexes.json を読む ----- */
export function loadSpec(file = INDEXES_FILE) {
  const spec = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(spec.indexes)) throw new Error("firestore.indexes.json に indexes がありません");
  if (Array.isArray(spec.fieldOverrides) && spec.fieldOverrides.length) {
    throw new Error("fieldOverrides（単一項目の設定）はこの仕組みでは扱いません。空にしてください");
  }
  spec.indexes.forEach((index, i) => {
    if (!index.collectionGroup || !/^[A-Za-z0-9_-]+$/.test(index.collectionGroup)) throw new Error(`indexes[${i}]：collectionGroup が正しくありません`);
    if (!["COLLECTION", "COLLECTION_GROUP"].includes(index.queryScope)) throw new Error(`indexes[${i}]：queryScope が正しくありません`);
    if (!Array.isArray(index.fields) || index.fields.length < 2) throw new Error(`indexes[${i}]：fields は2つ以上必要です`);
    index.fields.forEach((f, j) => {
      if (!f.fieldPath || f.fieldPath === "__name__") throw new Error(`indexes[${i}].fields[${j}]：fieldPath が正しくありません`);
      if (!["ASCENDING", "DESCENDING"].includes(f.order)) throw new Error(`indexes[${i}].fields[${j}]：order は ASCENDING か DESCENDING にしてください`);
    });
  });
  return spec.indexes;
}

/* ----- 本番のインデックスと比べる ----- */
/* 比べるときは、最後に自動で付く __name__ は除く */
function fieldsOf(index) {
  return (index.fields || []).filter((f) => f.fieldPath !== "__name__").map((f) => `${f.fieldPath}:${f.order || f.arrayConfig || (f.vectorConfig ? "VECTOR" : "?")}`);
}
export function collectionGroupOf(index) {
  if (index.collectionGroup) return index.collectionGroup;
  const m = String(index.name || "").match(/\/collectionGroups\/([^/]+)\/indexes\//);
  return m ? m[1] : "";
}
export function sameIndex(a, b) {
  return collectionGroupOf(a) === collectionGroupOf(b) && (a.queryScope || "COLLECTION") === (b.queryScope || "COLLECTION") && fieldsOf(a).join(",") === fieldsOf(b).join(",");
}
/* 等号に使う項目（最後の1つ＝並び替え以外）の順番だけが違うもの：同じ問い合わせに使えるので、重複して作らない */
export function equivalentIndex(a, b) {
  if (collectionGroupOf(a) !== collectionGroupOf(b) || (a.queryScope || "COLLECTION") !== (b.queryScope || "COLLECTION")) return false;
  const fa = fieldsOf(a), fb = fieldsOf(b);
  if (fa.length !== fb.length || fa.length < 2) return false;
  if (fa[fa.length - 1] !== fb[fb.length - 1]) return false;
  const ea = fa.slice(0, -1), eb = fb.slice(0, -1);
  if (!ea.every((x) => x.endsWith(":ASCENDING")) || !eb.every((x) => x.endsWith(":ASCENDING"))) return false;
  return [...ea].sort().join(",") === [...eb].sort().join(",");
}
export function describe(index) {
  return `${collectionGroupOf(index)}（${index.queryScope || "COLLECTION"}）: ${fieldsOf(index).join(", ").replace(/:ASCENDING/g, " 昇順").replace(/:DESCENDING/g, " 降順")}`;
}

export function plan(wanted, existing) {
  const result = { create: [], exists: [] };
  wanted.forEach((w) => {
    const hit = existing.find((e) => sameIndex(w, e)) || existing.find((e) => equivalentIndex(w, e));
    if (hit) result.exists.push({ wanted: w, existing: hit, exact: sameIndex(w, hit) });
    else result.create.push(w);
  });
  return result;
}

/* ----- 本番の API（読み取り・作成だけ） ----- */
export function loadServiceAccount(env = process.env) {
  const json = env.FIREBASE_SERVICE_ACCOUNT;
  if (!json) throw new Error("FIREBASE_SERVICE_ACCOUNT が設定されていません");
  const credentials = JSON.parse(json);
  if (credentials.project_id !== EXPECTED_PROJECT_ID) {
    throw new Error(`サービスアカウントのプロジェクトが ${EXPECTED_PROJECT_ID} ではありません（${credentials.project_id}）`);
  }
  return credentials;
}

export async function createApi(credentials) {
  const { GoogleAuth } = await import("google-auth-library");
  const auth = new GoogleAuth({ credentials, scopes: ["https://www.googleapis.com/auth/datastore", "https://www.googleapis.com/auth/cloud-platform"] });
  const client = await auth.getClient();
  return async (method, urlPath, data) => {
    if (!["GET", "POST"].includes(method)) throw new Error(`この仕組みでは ${method} は使いません`);
    try {
      const url = /^https:/.test(urlPath) ? urlPath : `${API}/${urlPath}`;
      const response = await client.request({ url, method, data });
      return response.data;
    } catch (error) {
      const status = error.response?.status;
      const message = error.response?.data?.error?.message || error.message;
      const e = new Error(`${method} ${urlPath.replace(/\?.*$/, "")} → ${status || ""} ${message}`);
      e.status = status; e.apiStatus = error.response?.data?.error?.status;
      throw e;
    }
  };
}

const DB = (projectId) => `projects/${projectId}/databases/(default)`;

export async function listIndexes(api, projectId) {
  const out = [];
  let pageToken = "";
  do {
    const data = await api("GET", `${DB(projectId)}/collectionGroups/-/indexes${pageToken ? `?pageToken=${encodeURIComponent(pageToken)}` : ""}`);
    (data.indexes || []).forEach((i) => out.push(i));
    pageToken = data.nextPageToken || "";
  } while (pageToken);
  return out;
}

export async function createIndex(api, projectId, index) {
  return api("POST", `${DB(projectId)}/collectionGroups/${index.collectionGroup}/indexes`, {
    queryScope: index.queryScope,
    fields: index.fields.map((f) => ({ fieldPath: f.fieldPath, order: f.order }))
  });
}

/* チャットの問い合わせ（script.js の buildChatMessagesQuery と同じ形）。どの文書にも当たらない値で、1件だけ */
export function chatQueries() {
  const none = "__index_check__";
  const order = [{ field: { fieldPath: "createdAt" }, direction: "DESCENDING" }];
  const eq = (f, v) => ({ fieldFilter: { field: { fieldPath: f }, op: "EQUAL", value: { stringValue: v } } });
  return [
    { label: "1対1（sender＋receiver を「または」でつなぐ・createdAt の新しい順）", structuredQuery: { from: [{ collectionId: "messages" }], where: { compositeFilter: { op: "OR", filters: [{ compositeFilter: { op: "AND", filters: [eq("sender", none + "a"), eq("receiver", none + "b")] } }, { compositeFilter: { op: "AND", filters: [eq("sender", none + "b"), eq("receiver", none + "a")] } }] } }, orderBy: order, limit: 1 } },
    { label: "グループ（groupId・createdAt の新しい順）", structuredQuery: { from: [{ collectionId: "messages" }], where: eq("groupId", none), orderBy: order, limit: 1 } }
  ];
}

export async function verifyQueries(api, projectId) {
  const results = [];
  for (const q of chatQueries()) {
    try {
      await api("POST", `${DB(projectId)}/documents:runQuery`, { structuredQuery: q.structuredQuery });
      results.push({ label: q.label, ok: true });
    } catch (error) {
      results.push({ label: q.label, ok: false, error: String(error.message).slice(0, 300), needsIndex: error.apiStatus === "FAILED_PRECONDITION" || error.status === 400 && /index/i.test(error.message) });
    }
  }
  return results;
}

/* ----- 実行 ----- */
function summary(lines) {
  const text = lines.join("\n");
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + "\n");
}

export async function run(mode, { api, projectId, wanted = loadSpec(), wait = Number(process.env.INDEX_WAIT_MINUTES || 25), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = summary } = {}) {
  if (!["check", "deploy", "verify"].includes(mode)) throw new Error("モードは check / deploy / verify のどれかです");
  const lines = [`### Firestore 複合インデックス（${mode}）`, `- プロジェクト：${projectId}`, `- firestore.indexes.json：${wanted.length} 件`];
  wanted.forEach((w) => lines.push(`  - ${describe(w)}`));

  if (mode === "verify") {
    const v = await verifyQueries(api, projectId);
    v.forEach((r) => lines.push(`- 問い合わせの確認：${r.label} → ${r.ok ? "OK（インデックスで実行できた）" : `NG：${r.error}`}`));
    log(lines);
    return { verify: v, ok: v.every((r) => r.ok) };
  }

  const existing = await listIndexes(api, projectId);
  const p = plan(wanted, existing);
  lines.push(`- 本番にある複合インデックス：${existing.length} 件（このうち firestore.indexes.json に無いものも、そのまま残します）`);
  p.exists.forEach((x) => lines.push(`  - すでにある：${describe(x.existing)}（状態 ${x.existing.state || "?"}${x.exact ? "" : "・等号の項目の順番だけ違う同じ働きのもの"}）`));
  p.create.forEach((w) => lines.push(`  - 本番に無い：${describe(w)}`));

  if (mode === "check") {
    log(lines);
    return { plan: p, existing };
  }

  /* deploy：無いものだけ作る */
  for (const w of p.create) {
    try {
      await createIndex(api, projectId, w);
      lines.push(`- 作成を始めました：${describe(w)}`);
    } catch (error) {
      if (error.status === 409 || error.apiStatus === "ALREADY_EXISTS") { lines.push(`- すでに作成中・作成済みでした：${describe(w)}`); continue; }
      lines.push(`- 作成に失敗：${describe(w)} → ${error.message}${error.status === 403 ? "（サービスアカウントにインデックスを作る権限がありません。IAM で「Cloud Datastore インデックス管理者」（roles/datastore.indexAdmin）が必要です）" : ""}`);
      log(lines);
      throw new Error("インデックスの作成に失敗しました");
    }
  }

  /* READY になるまで待つ（なっていなければ、そのことをはっきり書く） */
  const deadline = Date.now() + wait * 60 * 1000;
  let states = [];
  for (;;) {
    const now = await listIndexes(api, projectId);
    states = wanted.map((w) => { const hit = now.find((e) => sameIndex(w, e)) || now.find((e) => equivalentIndex(w, e)); return { w, state: hit?.state || "見つからない" }; });
    if (states.every((s) => s.state === "READY") || Date.now() > deadline) break;
    await sleep(30 * 1000);
  }
  states.forEach((s) => lines.push(`- 状態：${describe(s.w)} → ${s.state === "READY" ? "READY（使える）" : `${s.state}（まだ使えない）`}`));
  const ready = states.every((s) => s.state === "READY");
  if (ready) {
    const v = await verifyQueries(api, projectId);
    v.forEach((r) => lines.push(`- 問い合わせの確認：${r.label} → ${r.ok ? "OK（インデックスで実行できた）" : `NG：${r.error}`}`));
    log(lines);
    return { plan: p, ready, verify: v };
  }
  lines.push(`- ${wait} 分待っても READY になっていないものがあります。作成は続いています（Actions の手動実行 check / verify で、あとから確かめられます）`);
  log(lines);
  return { plan: p, ready };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2] || "check";
  (async () => {
    const credentials = loadServiceAccount();
    const api = await createApi(credentials);
    const result = await run(mode, { api, projectId: credentials.project_id });
    if (mode === "verify" && !result.ok) process.exit(1);
    if (mode === "deploy" && !result.ready) process.exit(2);
    if (mode === "deploy" && !result.verify.every((r) => r.ok)) process.exit(1);
  })().catch((error) => { console.error(`エラー：${String(error?.message || error).slice(0, 500)}`); process.exit(1); });
}
