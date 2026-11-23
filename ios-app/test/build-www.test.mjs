/* アプリ用の画面の書き出し（ios-app/build-www.mjs）のテスト。実行：node --test ios-app/test/build-www.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { preprocess, stripCss, build, FORBIDDEN, EXCLUDE_FILES } from "../build-www.mjs";

test("preprocess：WEB 側を取り除き、#else 側を残す（JS・HTML・入れ子）", () => {
  const js = ["a", "//#if WEB", "web", "//#else", "app", "//#endif", "b"].join("\n");
  assert.equal(preprocess(js), "a\napp\nb");
  const html = ["<!--#if WEB-->", "<p>w</p>", "<!--#endif-->", "<i>x</i>"].join("\n");
  assert.equal(preprocess(html), "<i>x</i>");
  const nested = ["//#if WEB", "//#if WEB", "x", "//#else", "y", "//#endif", "//#else", "z", "//#endif"].join("\n");
  assert.equal(preprocess(nested), "z");
  assert.equal(preprocess(js, "t", true).split("\n").length, 7, "keepLines：行数が元と同じ");
  assert.throws(() => preprocess("//#if WEB\nx"), /閉じていません/);
  assert.throws(() => preprocess("//#endif"), /#if/);
});

test("stripCss：賭けの言葉を含むルール・セレクタだけ取り、ほかは残す", () => {
  const out = stripCss(".a{color:red}.derby-x{color:blue}.b,.kaku-y{margin:0}@media (max-width:1px){.lottery-z{top:0}.c{top:1px}}");
  assert.ok(out.includes(".a{color:red}") && out.includes(".b{margin:0}") && out.includes(".c{top:1px}"));
  assert.ok(!FORBIDDEN.test(out));
});

test("build：賭けの言葉がどのファイルにも残らず、賭け系のファイルは入らず、JS の文法が正しい", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "www-"));
  const { files, problems } = build(out);
  assert.deepEqual(problems, []);
  for (const f of EXCLUDE_FILES) assert.equal(fs.existsSync(path.join(out, f)), false, f);
  assert.ok(files.includes("index.html") && files.includes("script.js"));
  for (const f of files.filter((x) => x.endsWith(".js") && !x.startsWith("vendor"))) {
    const r = spawnSync(process.execPath, ["--check", "--input-type=module"], { input: fs.readFileSync(path.join(out, f), "utf8") });
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
  }
  fs.rmSync(out, { recursive: true, force: true });
});

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("サイト（元のファイルのまま配る）：JS が文法エラーにならない（#else 側のコードが二重に読み込まれない）", () => {
  const jsFiles = fs.readdirSync(ROOT).filter((f) => f.endsWith(".js") && f !== "firebase-messaging-sw.js");
  assert.ok(jsFiles.length > 20);
  for (const f of jsFiles) {
    const r = spawnSync(process.execPath, ["--check", "--input-type=module"], { input: fs.readFileSync(path.join(ROOT, f), "utf8") });
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
  }
});

test("#else 側の行は、元のファイルではコメントになっていて、アプリ用に書き出すとコメントが外れる", () => {
  assert.equal(preprocess(["//#if WEB", "a", "//#else", "//@   b();", "//#endif"].join("\n")), "  b();");
  assert.equal(preprocess(["<!--#if WEB-->", "<p>w</p>", "<!--#else-->", "<!--@ <p>a</p> @-->", "<!--#endif-->"].join("\n")), "<p>a</p>");
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "www-"));
  const { files } = build(out);
  for (const f of files.filter((x) => /\.(js|html)$/.test(x) && !x.startsWith("vendor"))) {
    const t = fs.readFileSync(path.join(out, f), "utf8");
    assert.ok(!/^\s*\/\/@ /m.test(t) && !/<!--@ /.test(t), `${f}: コメントが残っている`);
  }
  fs.rmSync(out, { recursive: true, force: true });
});
