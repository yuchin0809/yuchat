/* iPhone アプリに入れる画面（ios-app/www）を、サイトのファイルから作る。
   ・アプリには、賭けに関係する機能（競馬・スロット・くじ・確変台）を、隠すのではなく、最初から入れない。
     サイトのソースにある「#if WEB … #else … #endif」の行（JS は「//」、CSS は「スラッシュ＋アスタリスク」、HTML は「<!--」の中に書く）の、WEB のほうを取り除いて書き出す。
     「//#else」の側は、アプリだけに入る（置きかえの短いコード）。
   ・アプリに入れないファイル（競馬・くじ・確変台・管理者用）は、コピーしない。
   ・書き出したあとに、賭けに関係する言葉が1つでも残っていないか調べる（残っていたら失敗する）。
   使い方：node ios-app/build-www.mjs [出力先（省略すると ios-app/www）]
   テスト：node --test ios-app/test/build-www.test.mjs */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/* アプリに入れない、ルートのファイル（賭け系・管理者用・サイトだけの物） */
export const EXCLUDE_FILES = new Set([
  "derby-extra.js", "derby-odds.js", "derby-show.js",
  "yulottery.js", "yulotteryshow.js", "yubankuji.js",
  "yukaku.js", "yukakuwinners.js", "yuticket.js", "yurank.js", "yuworld-fx.js",
  "yueconomy-admin.js", "yukeshi-admin.js",
  "firebase-messaging-sw.js"
]);
const INCLUDE_DIRS = ["assets", "icons", "vendor", "mart-img"];
const INCLUDE_EXT = new Set([".html", ".css", ".js", ".json", ".png", ".jpg", ".svg", ".ico", ".webmanifest"]);
const ROOT_JSON_OK = new Set(["manifest.json"]);

/* 書き出した中に、あってはいけない言葉（賭けに関係するもの）。「yuslot」は、サーバーの窓口の名前（ヨットや消しバトも使う）なので、対象にしない */
const FORBIDDEN_CI = /ダービー|競馬|馬券|オッズ|スロット|宝くじ|番くじ|確変|ゆうスロ|lottery|bankuji|kaku|jackpot|ジャックポット|ywOpenSlot/i;
const FORBIDDEN_CS = /(?<![A-Za-z])derby|Derby|DERBY/;   // orderBy のような、関係ない英単語に当たらないように、大文字・小文字を区別する
export const FORBIDDEN = { test: (line) => FORBIDDEN_CI.test(line) || FORBIDDEN_CS.test(line) };

const DIRECTIVE = /^\s*(?:\/\/|\/\*|<!--)\s*#(if WEB|else|endif)\s*(?:\*\/|-->)?\s*$/;

/* 1つのファイルの中身から、WEB のほうを取り除く（入れ子にも対応） */
export function preprocess(text, name = "", keepLines = false) {
  const out = [], stack = [];   // keepLines：取り除いた行を、空行にして残す（エラーの行番号を、元のファイルと合わせたいとき）   // stack：{ web: その if が WEB 側か, inElse: else に入ったか }
  const keep = () => stack.every((s) => (s.inElse ? true : !s.web) );
  text.split("\n").forEach((line, i) => {
    const m = DIRECTIVE.exec(line);
    if (m) {
      if (m[1] === "if WEB") stack.push({ web: true, inElse: false, at: i + 1 });
      else if (m[1] === "else") { if (!stack.length) throw new Error(`${name}:${i + 1} #else に対する #if がありません`); stack[stack.length - 1].inElse = true; }
      else { if (!stack.length) throw new Error(`${name}:${i + 1} #endif に対する #if がありません`); stack.pop(); }
      if (keepLines) out.push("");
      return;
    }
    if (keep()) out.push(line); else if (keepLines) out.push("");
  });
  if (stack.length) throw new Error(`${name}:${stack[stack.length - 1].at} #if WEB が閉じていません`);
  return out.join("\n");
}

/* CSS：賭けに関係する言葉を含む「ルール」「コメント」を取り除く（アプリには、その見た目を当てる画面が無いので、使われない）。
   セレクタが「,」でつながっているときは、言葉を含むセレクタだけを取り、残りは残す。@media などの中も同じように処理する */
export function stripCss(css) {
  const out = [];
  let i = 0;
  const n = css.length;
  const skipString = (j) => { const q = css[j]; j++; while (j < n && css[j] !== q) { if (css[j] === "\\") j++; j++; } return j + 1; };
  const matchBrace = (j) => {   // css[j] === "{"：対応する "}" の次の位置
    let depth = 0;
    for (; j < n; j++) {
      const c = css[j];
      if (c === "/" && css[j + 1] === "*") { j = css.indexOf("*/", j + 2); if (j < 0) return n; j++; continue; }
      if (c === '"' || c === "'") { j = skipString(j) - 1; continue; }
      if (c === "{") depth++;
      else if (c === "}") { depth--; if (depth === 0) return j + 1; }
    }
    return n;
  };
  const splitTop = (sel) => {   // 括弧・[] の外の "," で分ける
    const parts = []; let depth = 0, cur = "";
    for (let j = 0; j < sel.length; j++) {
      const c = sel[j];
      if (c === "(" || c === "[") depth++; else if (c === ")" || c === "]") depth--;
      if (c === "," && depth === 0) { parts.push(cur); cur = ""; } else cur += c;
    }
    parts.push(cur);
    return parts;
  };
  while (i < n) {
    if (css[i] === "/" && css[i + 1] === "*") {   // コメント
      const e = css.indexOf("*/", i + 2), end = e < 0 ? n : e + 2, text = css.slice(i, end);
      if (!FORBIDDEN.test(text)) out.push(text);
      i = end; continue;
    }
    if (/\s/.test(css[i])) { out.push(css[i]); i++; continue; }
    // 次の "{" か ";" まで（コメントは飛ばす）
    let j = i;
    while (j < n && css[j] !== "{" && css[j] !== ";") {
      if (css[j] === "/" && css[j + 1] === "*") { const e = css.indexOf("*/", j + 2); j = e < 0 ? n : e + 2; continue; }
      if (css[j] === '"' || css[j] === "'") { j = skipString(j); continue; }
      j++;
    }
    if (j >= n) { out.push(css.slice(i)); break; }
    if (css[j] === ";") { const text = css.slice(i, j + 1); if (!FORBIDDEN.test(text)) out.push(text); i = j + 1; continue; }
    const head = css.slice(i, j), end = matchBrace(j), body = css.slice(j + 1, end - 1);
    if (head.trim().startsWith("@")) {
      if (/^@(media|supports|layer|container)\b/i.test(head.trim())) {
        const inner = stripCss(body);
        if (inner.trim()) out.push(`${head}{${inner}}`);
      } else if (!FORBIDDEN.test(head) && !FORBIDDEN.test(body)) out.push(css.slice(i, end));
    } else {
      const keep = splitTop(head).filter((sel) => !FORBIDDEN.test(sel));
      if (keep.length && !FORBIDDEN.test(body)) out.push(`${keep.join(",")}{${body}}`);
    }
    i = end;
  }
  return out.join("");
}

function listFiles(root) {
  const files = [];
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (!e.isFile()) continue;
    const ext = path.extname(e.name);
    if (!INCLUDE_EXT.has(ext) || EXCLUDE_FILES.has(e.name)) continue;
    if (ext === ".json" && !ROOT_JSON_OK.has(e.name)) continue;
    files.push(e.name);
  }
  for (const d of INCLUDE_DIRS) {
    const base = path.join(root, d);
    if (!fs.existsSync(base)) continue;
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p); else files.push(path.relative(root, p));
    });
    walk(base);
  }
  return files.sort();
}

const TEXT_EXT = new Set([".html", ".css", ".js", ".json", ".svg", ".webmanifest"]);
/* 出力先に書き出す。戻り値：{ files, problems }（problems：残っていた賭けの言葉の場所） */
export function build(outDir = path.join(ROOT, "ios-app", "www"), root = ROOT, keepLines = false) {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const files = listFiles(root), problems = [];
  for (const f of files) {
    const src = path.join(root, f), dst = path.join(outDir, f);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    const ext = path.extname(f);
    if (!TEXT_EXT.has(ext)) { fs.copyFileSync(src, dst); continue; }
    let text = preprocess(fs.readFileSync(src, "utf8"), f, keepLines);
    if (ext === ".css") text = stripCss(text);
    fs.writeFileSync(dst, text);
    if (ext !== ".json" || f === "manifest.json") text.split("\n").forEach((line, i) => { if (FORBIDDEN.test(line)) problems.push(`${f}:${i + 1}: ${line.trim().slice(0, 90)}`); });
  }
  return { files, problems };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
  const { files, problems } = build(out);
  console.log(`${files.length} 個のファイルを書き出しました`);
  if (problems.length) {
    console.error(`賭けに関係する言葉が ${problems.length} か所残っています：`);
    problems.slice(0, 80).forEach((p) => console.error("  " + p));
    process.exit(1);
  }
  console.log("賭けに関係する言葉は、残っていません");
}
