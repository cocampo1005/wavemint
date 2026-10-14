// `const { name } = require("./module.cjs")` silently gives undefined when the
// module doesn't export `name` (e.g. after moving a helper), which lint can't
// see. This checks every such import in the main process and the tests.
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const test = require("node:test");

const ROOT = path.join(__dirname, "..");

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" || entry.name === "fixtures" ? [] : walk(full);
    return full.endsWith(".cjs") ? [full] : [];
  });
}

test("every name imported from a local module is exported by it", () => {
  const problems = [];
  const files = [...walk(path.join(ROOT, "electron")), ...walk(path.join(ROOT, "tests"))];
  const pattern = /const\s*\{([^}]+)\}\s*=\s*require\(\s*"(\.{1,2}\/[^"]+\.cjs)"\s*\)/g;
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8").replace(/^\s*\/\/.*$/gm, ""); // not comments
    for (const [, names, request] of source.matchAll(pattern)) {
      const target = path.resolve(path.dirname(file), request);
      // Loading electron-only modules here would fail; their exports are read statically.
      const exportsText = /require\("electron"\)/.test(fs.readFileSync(target, "utf8")) ? null : require(target);
      for (const raw of names.split(",")) {
        const name = raw.trim().split(":")[0].trim();
        if (!name) continue;
        const exported = exportsText ? Object.hasOwn(exportsText, name) : new RegExp(`module\\.exports[\\s\\S]*\\b${name}\\b`).test(fs.readFileSync(target, "utf8"));
        if (!exported) problems.push(`${path.relative(ROOT, file)}: "${name}" isn't exported by ${request}`);
      }
    }
  }
  assert.deepEqual(problems, []);
});
