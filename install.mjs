#!/usr/bin/env node
// context-mode-zcode · install.mjs
// 把 context-mode（stdio MCP）包成一个 systemd --user 服务，用 supergateway 暴露 Streamable HTTP，
// 再让 ZCode 通过 HTTP 连它。幂等；--uninstall 卸载。
//
//   node install.mjs [--port 8765] [--workdir ~/develop/app] [--cli <path-to-cli.bundle.mjs>]
//   node install.mjs --uninstall
//   node install.mjs --dry-run

import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOME = homedir();

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
};
const has = (name) => argv.includes(`--${name}`);

const UNIT = "context-mode-mcp";
const unitPath = join(HOME, ".config", "systemd", "user", `${UNIT}.service`);
const PORT = String(flag("port", "8765"));
const WORKDIR = resolve(String(flag("workdir", join(HOME, "develop", "app"))).replace(/^~/, HOME));
const STORE = join(HOME, ".local", "share", "context-mode-mcp");
const DEFAULT_CLI = join(HOME, "develop", "app", "opencode", "context-mode-opencode-v2", "node_modules", "context-mode", "cli.bundle.mjs");
const CLI = String(flag("cli", DEFAULT_CLI)).replace(/^~/, HOME);
const NODE = process.execPath;
const dry = has("dry-run");

const run = (cmd, args, opts = {}) => {
  if (dry) { console.log(`[dry] ${cmd} ${args.join(" ")}`); return ""; }
  return execFileSync(cmd, args, { encoding: "utf8", stdio: opts.stdio ?? "pipe", ...opts });
};

/* --------------------------------------------------------------- uninstall */

if (has("uninstall")) {
  console.log(`removing ${unitPath}`);
  try { run("systemctl", ["--user", "disable", "--now", UNIT, "--no-pager"]); } catch {}
  if (existsSync(unitPath)) { if (!dry) unlinkSync(unitPath); }
  try { run("systemctl", ["--user", "daemon-reload"]); } catch {}
  console.log("done（知识库仍留在 " + STORE + "，要清就 rm -rf）");
  process.exit(0);
}

/* ------------------------------------------------------------ preflight */

if (!existsSync(CLI)) {
  console.error(`找不到 context-mode 的 CLI：${CLI}\n用 --cli 指定，或先装 context-mode（npm i context-mode）。`);
  process.exit(1);
}

let supergateway = "";
try {
  supergateway = execSync("command -v supergateway", { encoding: "utf8", shell: "/bin/bash" }).trim();
} catch {}
if (!supergateway) {
  console.error("找不到 supergateway。先装：npm i -g supergateway");
  process.exit(1);
}

for (const bin of [NODE, supergateway]) {
  if (!existsSync(bin)) { console.error(`not executable: ${bin}`); process.exit(1); }
}

/* ------------------------------------------------------------ write unit */

const tpl = readFileSync(join(HERE, "systemd", "context-mode-mcp.service.template"), "utf8");
const unit = tpl
  .replaceAll("__WORKDIR__", WORKDIR)
  .replaceAll("__NODE_BIN_DIR__", dirname(NODE))
  .replaceAll("__STORE__", STORE)
  .replaceAll("__SUPERGATEWAY__", supergateway)
  .replaceAll("__NODE__", NODE)
  .replaceAll("__CLI__", CLI)
  .replaceAll("__PORT__", PORT);

mkdirSync(dirname(unitPath), { recursive: true });
mkdirSync(STORE, { recursive: true });

if (dry) {
  console.log(`[dry] would write ${unitPath}\n`);
  console.log(unit);
  process.exit(0);
}

writeFileSync(unitPath, unit);
console.log(`unit → ${unitPath}`);
console.log(`store → ${STORE}`);
console.log(`cli   → ${CLI}`);

run("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
run("systemctl", ["--user", "enable", "--now", `${UNIT}.service`], { stdio: "inherit" });

/* ------------------------------------------------------------- verify */

await new Promise((r) => setTimeout(r, 1500));
const healthUrl = `http${"://"}127.0.0.1:${PORT}/healthz`;
let ok = false;
try {
  const res = await fetch(healthUrl, { signal: AbortSignal.timeout(4000) });
  ok = res.ok;
} catch {}
console.log(`\nhealth ${healthUrl} → ${ok ? "ok" : "FAILED"}`);
if (!ok) {
  console.log(`查日志：journalctl --user -u ${UNIT} -n 50 --no-pager`);
  process.exit(1);
}

console.log(`
ZCode 侧配置（~/.zcode/cli/config.json）：

  {
    "mcp": {
      "servers": {
        "context-mode": {
          "type": "http",
          "url": "http://127.0.0.1:${PORT}/mcp"
        }
      }
    }
  }

然后新建一个 ZCode session 生效。
`);
