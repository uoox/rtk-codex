import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdtemp, mkdir, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildDispatcherScript, buildWrapperScript } from "./templates.js";

export type CliPaths = {
  repoRoot: string;
  shimsRoot: string;
  rtkUpstreamRefFile: string;
  shimCommandsExtraFile: string;
  shimCommandsFile: string;
  shimCommandsUpstreamFile: string;
};

export function getCliPaths(): CliPaths {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const shimsRoot = path.join(repoRoot, "shims");
  return {
    repoRoot,
    shimsRoot,
    rtkUpstreamRefFile: path.join(shimsRoot, "rtk-upstream-ref.txt"),
    shimCommandsExtraFile: path.join(shimsRoot, "shim-commands.extra.txt"),
    shimCommandsFile: path.join(shimsRoot, "shim-commands.txt"),
    shimCommandsUpstreamFile: path.join(shimsRoot, "shim-commands.upstream.txt"),
  };
}

const MANAGED_START = "# BEGIN RTK SHIM CONFIG";
const MANAGED_END = "# END RTK SHIM CONFIG";

export function getDefaultShimHome(): string {
  return process.env.RTK_SHIM_HOME ?? path.join(os.homedir(), ".rtk-codex");
}

export function getCodexHome(): string {
  return process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
}

export function getDefaultLogFile(): string {
  return process.env.RTK_SHIM_LOG_FILE ?? path.join(getDefaultShimHome(), "shim.log");
}

function tomlEscape(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
}

function normalizeNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

function normalizeSpacing(text: string): string {
  return normalizeNewline(text).replace(/\n{3,}/g, "\n\n");
}

function shellToken(input: string): string {
  let current = "";
  let quote: "'" | "\"" | null = null;
  let escaping = false;

  for (const char of input) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      break;
    }

    current += char;
  }

  return current;
}

function parseCommandNames(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    // Path-like entries (./gradlew, bin/phpstan) bypass PATH lookup and
    // cannot be shimmed.
    .filter((line) => line.length > 0 && !line.startsWith("#") && !line.includes("/"));
}

async function readTextIfExists(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function uniqSorted(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).sort();
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  return await response.text();
}

export async function updateSupportedCommands(options: { refOverride?: string; skipSync?: boolean } = {}): Promise<void> {
  const paths = getCliPaths();
  const upstreamRepo = "rtk-ai/rtk";
  const ref = options.refOverride
    ? options.refOverride
    : (await readFile(paths.rtkUpstreamRefFile, "utf8")).trim();
  const rulesUrl = `https://raw.githubusercontent.com/${upstreamRepo}/${ref}/src/discover/rules.rs`;
  const rulesText = await fetchText(rulesUrl);

  const commands = new Set<string>();
  const blockRegex = /rewrite_prefixes:\s*&\[(.*?)\]/gs;

  for (const blockMatch of rulesText.matchAll(blockRegex)) {
    const block = blockMatch[1] ?? "";
    for (const prefixMatch of block.matchAll(/"([^"]+)"/g)) {
      const prefix = prefixMatch[1] ?? "";
      const token = shellToken(prefix);
      if (token) {
        commands.add(token);
      }
    }
  }

  const extraText = (await readTextIfExists(paths.shimCommandsExtraFile)) ?? "";
  const extraCommands = parseCommandNames(extraText);
  const upstreamCommands = uniqSorted(commands);
  const mergedCommands = uniqSorted([...upstreamCommands, ...extraCommands]);

  await writeFile(
    paths.shimCommandsUpstreamFile,
    `# Generated from rtk-ai/rtk\n# Source ref: ${ref}\n\n${upstreamCommands.join("\n")}\n`,
    "utf8",
  );
  await writeFile(
    paths.shimCommandsFile,
    `# Generated: upstream manifest plus local extras\n# Upstream ref: ${ref}\n\n${mergedCommands.join("\n")}\n`,
    "utf8",
  );

  if (options.refOverride) {
    await writeFile(paths.rtkUpstreamRefFile, `${ref}\n`, "utf8");
  }

  if (!options.skipSync) {
    await syncShims();
  }

  process.stdout.write(`Updated shim manifest from ${upstreamRepo} at ${ref}\n`);
}

export async function syncShims(targetRoot?: string): Promise<void> {
  const paths = getCliPaths();
  const resolvedTargetRoot = targetRoot ?? paths.shimsRoot;
  const binDir = path.join(resolvedTargetRoot, "bin");
  const commandsFile = paths.shimCommandsFile;
  const dispatcherFile = path.join(binDir, "rtk-shim");

  if (!existsSync(commandsFile)) {
    await updateSupportedCommands({ skipSync: true });
  }

  await mkdir(binDir, { recursive: true });
  await writeFile(dispatcherFile, buildDispatcherScript(), "utf8");
  await chmod(dispatcherFile, 0o755);

  const currentFiles = await readdir(binDir);
  for (const fileName of currentFiles) {
    if (fileName !== "rtk-shim") {
      await unlink(path.join(binDir, fileName));
    }
  }

  const commandNames = parseCommandNames(await readFile(commandsFile, "utf8"));
  for (const commandName of commandNames) {
    const wrapperPath = path.join(binDir, commandName);
    await writeFile(wrapperPath, buildWrapperScript(commandName), "utf8");
    await chmod(wrapperPath, 0o755);
  }
}

export async function installShims(shimRoot = getDefaultShimHome()): Promise<void> {
  const paths = getCliPaths();
  await mkdir(shimRoot, { recursive: true });
  await syncShims(shimRoot);
  await copyFile(paths.shimCommandsFile, path.join(shimRoot, "shim-commands.txt"));
  process.stdout.write(`Installed RTK shims into ${shimRoot}\n`);
}

export function buildRealPath(repoRoot: string, shimBinDir: string, basePath = process.env.RTK_SHIM_REAL_PATH ?? process.env.PATH ?? ""): string {
  return basePath
    .split(":")
    .filter((part) => part.length > 0)
    .filter((part) => part !== shimBinDir)
    .filter((part) => part !== path.join(repoRoot, "shims", "bin"))
    .filter((part) => !part.includes("/.codex/tmp/arg0/"))
    .join(":");
}

function findShellEnvironmentBlock(source: string): { prefix: string; block: string; suffix: string } | null {
  const lines = source.split(/\r?\n/);
  let start = -1;
  let end = lines.length;

  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]?.trim() === "[shell_environment_policy]") {
      start = i;
      break;
    }
  }

  if (start === -1) {
    return null;
  }

  for (let i = start + 1; i < lines.length; i += 1) {
    const stripped = lines[i]?.trim() ?? "";
    if (stripped.startsWith("[") && stripped !== "[shell_environment_policy]" && stripped !== "[shell_environment_policy.set]") {
      end = i;
      break;
    }
  }

  const prefix = lines.slice(0, start).join("\n");
  const block = lines.slice(start, end).join("\n");
  const suffix = lines.slice(end).join("\n");
  return { prefix, block, suffix };
}

function replaceManagedBlock(existingText: string, managedBlock: string): string {
  const normalizedBlock = normalizeNewline(managedBlock.trimEnd());
  const managedRegex = new RegExp(
    `^\\s*${MANAGED_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n[\\s\\S]*?^\\s*${MANAGED_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n?`,
    "m",
  );

  if (managedRegex.test(existingText)) {
    return existingText.replace(managedRegex, normalizedBlock).replace(/\n{3,}/g, "\n\n");
  }

  const existingBlock = findShellEnvironmentBlock(existingText);
  if (existingBlock) {
    const { prefix, block, suffix } = existingBlock;
    if (block.includes("RTK_SHIM_ROOT") || block.includes("RTK_SHIM_REAL_PATH") || block.includes("RTK_SHIM_LOG_FILE")) {
      const trimmedPrefix = prefix.trimEnd();
      const trimmedSuffix = suffix.trimStart();
      return [
        trimmedPrefix,
        trimmedPrefix ? "" : null,
        normalizedBlock.trimEnd(),
        trimmedSuffix ? "" : null,
        trimmedSuffix,
      ]
        .filter((part): part is string => part !== null)
        .join("\n\n")
        .replace(/\n{3,}/g, "\n\n");
    }
    throw new Error("refusing to overwrite existing shell_environment_policy");
  }

  const base = existingText.trimEnd();
  return base ? `${base}\n\n${normalizedBlock}` : normalizedBlock;
}

export async function installCodexConfig(options: { shimRoot?: string; logFile?: string } = {}): Promise<void> {
  const paths = getCliPaths();
  const shimRoot = options.shimRoot ?? getDefaultShimHome();
  const shimBinDir = path.join(shimRoot, "bin");
  const codexHome = getCodexHome();
  const configFile = path.join(codexHome, "config.toml");
  const logFile = options.logFile ?? getDefaultLogFile();

  await installShims(shimRoot);
  await mkdir(codexHome, { recursive: true });

  const realPath = buildRealPath(paths.repoRoot, shimBinDir);
  const managedBlock = `${MANAGED_START}
[shell_environment_policy]
inherit = "all"

[shell_environment_policy.set]
PATH = "${tomlEscape(`${shimBinDir}:${realPath}`)}"
RTK_SHIM_ROOT = "${tomlEscape(shimRoot)}"
RTK_SHIM_REAL_PATH = "${tomlEscape(realPath)}"
RTK_SHIM_LOG_FILE = "${tomlEscape(logFile)}"
${MANAGED_END}
`;

  const existingText = (await readTextIfExists(configFile)) ?? "";
  const newText = replaceManagedBlock(existingText, managedBlock);
  await writeFile(configFile, normalizeNewline(newText), "utf8");
  process.stdout.write(`Installed RTK shim config block into ${configFile}\n`);
}

export async function uninstallCodexConfig(): Promise<void> {
  const configFile = path.join(getCodexHome(), "config.toml");
  const existingText = await readTextIfExists(configFile);
  if (existingText === null) {
    process.stdout.write(`Removed RTK shim config block from ${configFile}\n`);
    return;
  }

  const managedRegex = new RegExp(
    `^\\s*${MANAGED_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n[\\s\\S]*?^\\s*${MANAGED_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n?`,
    "m",
  );
  const newText = existingText.replace(managedRegex, "").replace(/\n{3,}/g, "\n\n").trimEnd();
  await writeFile(configFile, newText ? `${newText}\n` : "", "utf8");
  process.stdout.write(`Removed RTK shim config block from ${configFile}\n`);
}

const SHELL_HOOK_START = "# BEGIN RTK SHIM SHELL HOOK";
const SHELL_HOOK_END = "# END RTK SHIM SHELL HOOK";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shellHookRegex(): RegExp {
  return new RegExp(`^\\s*${escapeRegExp(SHELL_HOOK_START)}\\n[\\s\\S]*?^\\s*${escapeRegExp(SHELL_HOOK_END)}\\n?`, "m");
}

export function getDefaultShellRcFile(): string {
  return process.env.RTK_SHIM_RC_FILE ?? path.join(os.homedir(), ".zshrc");
}

export function buildShellHookBlock(shimRoot = getDefaultShimHome()): string {
  const shimBinDir = path.join(shimRoot, "bin");
  const logFile = path.join(shimRoot, "shim.log");
  return `${SHELL_HOOK_START}
# Prepend rtk-codex shims inside AI agent sessions (Google Antigravity).
# Force on in any shell with RTK_SHIM_SHELL=1; Codex is covered separately
# via the managed block in ~/.codex/config.toml.
if [ -n "\${ANTIGRAVITY_AGENT:-}" ] || [ "\${RTK_SHIM_SHELL:-0}" = "1" ]; then
  case ":\$PATH:" in
    *":${shimBinDir}:"*) ;;
    *) export PATH="${shimBinDir}:\$PATH" ;;
  esac
  if [ -z "\${RTK_SHIM_LOG_FILE:-}" ]; then
    export RTK_SHIM_LOG_FILE="${logFile}"
  fi
fi
${SHELL_HOOK_END}
`;
}

export async function installShellHook(options: { shimRoot?: string; rcFile?: string } = {}): Promise<void> {
  const shimRoot = options.shimRoot ?? getDefaultShimHome();
  const rcFile = options.rcFile ?? getDefaultShellRcFile();

  await installShims(shimRoot);

  const block = normalizeNewline(buildShellHookBlock(shimRoot).trimEnd());
  const existingText = (await readTextIfExists(rcFile)) ?? "";
  const regex = shellHookRegex();
  const newText = regex.test(existingText)
    ? existingText.replace(regex, block)
    : `${existingText.trimEnd()}${existingText.trim() ? "\n\n" : ""}${block}`;
  await writeFile(rcFile, normalizeSpacing(newText), "utf8");
  process.stdout.write(`Installed RTK shim shell hook into ${rcFile}\n`);
}

export async function uninstallShellHook(options: { rcFile?: string } = {}): Promise<void> {
  const rcFile = options.rcFile ?? getDefaultShellRcFile();
  const existingText = await readTextIfExists(rcFile);
  if (existingText !== null) {
    const newText = existingText.replace(shellHookRegex(), "").replace(/\n{3,}/g, "\n\n").trimEnd();
    await writeFile(rcFile, newText ? `${newText}\n` : "", "utf8");
  }
  process.stdout.write(`Removed RTK shim shell hook from ${rcFile}\n`);
}

export async function testShellHook(): Promise<void> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "rtk-codex-shellhook-"));
  try {
    const rcFile = path.join(tempRoot, ".zshrc");
    const shimRoot = path.join(tempRoot, ".rtk-codex");

    await writeFile(rcFile, "# user rc\nexport FOO=1\n", "utf8");
    await installShellHook({ shimRoot, rcFile });
    const first = await readFile(rcFile, "utf8");
    assert.match(first, /BEGIN RTK SHIM SHELL HOOK/);
    assert.match(first, /export FOO=1/);

    await installShellHook({ shimRoot, rcFile });
    const second = await readFile(rcFile, "utf8");
    assert.equal((second.match(/BEGIN RTK SHIM SHELL HOOK/g) ?? []).length, 1);

    const shimBinDir = path.join(shimRoot, "bin");
    for (const [env, expectShim] of [
      [{ ANTIGRAVITY_AGENT: "1" }, true],
      [{ RTK_SHIM_SHELL: "1" }, true],
      [{}, false],
    ] as Array<[NodeJS.ProcessEnv, boolean]>) {
      const probe = runCommand("bash", ["-c", `. "${rcFile}" && printf '%s' "$PATH"`], {
        env: { ...process.env, ANTIGRAVITY_AGENT: "", RTK_SHIM_SHELL: "", ...env },
      });
      assert.equal(probe.status, 0);
      assert.equal(probe.stdout.startsWith(`${shimBinDir}:`), expectShim, JSON.stringify(env));
    }

    await uninstallShellHook({ rcFile });
    const removed = await readFile(rcFile, "utf8");
    assert.doesNotMatch(removed, /RTK SHIM SHELL HOOK/);
    assert.match(removed, /export FOO=1/);

    process.stdout.write("Shell hook install/uninstall tests passed\n");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

function runCommand(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): { stdout: string; status: number } {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });

  if (result.error) {
    throw result.error;
  }

  return { stdout: result.stdout.trimEnd(), status: result.status ?? 1 };
}

export async function testShims(): Promise<void> {
  const paths = getCliPaths();
  await syncShims();
  const binDir = path.join(paths.shimsRoot, "bin");
  const commandNames = parseCommandNames(await readFile(paths.shimCommandsFile, "utf8"));

  for (const commandName of commandNames) {
    const wrapperPath = path.join(binDir, commandName);
    const wrapperStat = await stat(wrapperPath);
    assert.equal(Boolean(wrapperStat.mode & 0o111), true, `missing wrapper: ${commandName}`);
  }

  const cases: Array<{ description: string; expected: string; command: string; args: string[] }> = [
    { description: "git status", expected: "REWRITE\tgit status\trtk git status", command: "git", args: ["status"] },
    { description: "env + git status", expected: "REWRITE\tenv GIT_PAGER=cat git status\tenv GIT_PAGER=cat rtk git status", command: "env", args: ["GIT_PAGER=cat", "git", "status"] },
    { description: "sudo + git status", expected: "REWRITE\tsudo git status\tsudo rtk git status", command: "sudo", args: ["git", "status"] },
    { description: "gh release list", expected: "REWRITE\tgh release list\trtk gh release list", command: "gh", args: ["release", "list"] },
    { description: "cargo test", expected: "REWRITE\tcargo test\trtk cargo test", command: "cargo", args: ["test"] },
    { description: "pnpm outdated", expected: "REWRITE\tpnpm outdated\trtk pnpm outdated", command: "pnpm", args: ["outdated"] },
    { description: "npm run build", expected: "REWRITE\tnpm run build\trtk npm run build", command: "npm", args: ["run", "build"] },
    { description: "npx prisma migrate", expected: "REWRITE\tnpx prisma migrate\trtk prisma migrate", command: "npx", args: ["prisma", "migrate"] },
    { description: "cat file", expected: "REWRITE\tcat AGENTS.md\trtk read AGENTS.md", command: "cat", args: ["AGENTS.md"] },
    { description: "head -20 file", expected: "REWRITE\thead -20 AGENTS.md\trtk read AGENTS.md --max-lines 20", command: "head", args: ["-20", "AGENTS.md"] },
    { description: "tail -n 5 file", expected: "REWRITE\ttail -n 5 AGENTS.md\trtk read AGENTS.md --tail-lines 5", command: "tail", args: ["-n", "5", "AGENTS.md"] },
    { description: "grep pattern", expected: "REWRITE\tgrep -rn pattern src/\trtk grep -rn pattern src/", command: "grep", args: ["-rn", "pattern", "src/"] },
    { description: "rg pattern", expected: "REWRITE\trg pattern src/\trtk rg pattern src/", command: "rg", args: ["pattern", "src/"] },
    { description: "ls -la", expected: "REWRITE\tls -la\trtk ls -la", command: "ls", args: ["-la"] },
    { description: "find name", expected: "REWRITE\tfind -name \\*.ts src/\trtk find -name \\*.ts src/", command: "find", args: ["-name", "*.ts", "src/"] },
    { description: "tsc", expected: "REWRITE\ttsc --noEmit\trtk tsc --noEmit", command: "tsc", args: ["--noEmit"] },
    { description: "eslint", expected: "REWRITE\teslint src\trtk lint src", command: "eslint", args: ["src"] },
    { description: "prettier", expected: "REWRITE\tprettier --check .\trtk prettier --check .", command: "prettier", args: ["--check", "."] },
    { description: "next build", expected: "REWRITE\tnext build\trtk next", command: "next", args: ["build"] },
    { description: "vitest", expected: "REWRITE\tvitest run\trtk vitest", command: "vitest", args: ["run"] },
    { description: "playwright", expected: "REWRITE\tplaywright test\trtk playwright test", command: "playwright", args: ["test"] },
    { description: "docker compose logs", expected: "REWRITE\tdocker compose logs web\trtk docker compose logs web", command: "docker", args: ["compose", "logs", "web"] },
    { description: "kubectl describe", expected: "REWRITE\tkubectl describe pod foo\trtk kubectl describe pod foo", command: "kubectl", args: ["describe", "pod", "foo"] },
    { description: "tree", expected: "REWRITE\ttree src/\trtk tree src/", command: "tree", args: ["src/"] },
    { description: "diff", expected: "REWRITE\tdiff a b\trtk diff a b", command: "diff", args: ["a", "b"] },
    { description: "curl", expected: "REWRITE\tcurl -s https://example.com\trtk curl -s https://example.com", command: "curl", args: ["-s", "https://example.com"] },
    { description: "wget", expected: "REWRITE\twget https://example.com/file\trtk wget https://example.com/file", command: "wget", args: ["https://example.com/file"] },
    { description: "python -m mypy", expected: "REWRITE\tpython -m mypy src\trtk mypy src", command: "python", args: ["-m", "mypy", "src"] },
    { description: "ruff check", expected: "REWRITE\truff check src\trtk ruff check src", command: "ruff", args: ["check", "src"] },
    { description: "python -m pytest", expected: "REWRITE\tpython -m pytest tests\trtk pytest tests", command: "python", args: ["-m", "pytest", "tests"] },
    { description: "uv pip install", expected: "REWRITE\tuv pip install requests\trtk uv pip install requests", command: "uv", args: ["pip", "install", "requests"] },
    { description: "go test", expected: "REWRITE\tgo test ./...\trtk go test ./...", command: "go", args: ["test", "./..."] },
    { description: "golangci-lint", expected: "REWRITE\tgolangci-lint run\trtk golangci-lint run", command: "golangci-lint", args: ["run"] },
    { description: "aws", expected: "REWRITE\taws sts get-caller-identity\trtk aws sts get-caller-identity", command: "aws", args: ["sts", "get-caller-identity"] },
    { description: "psql", expected: "REWRITE\tpsql -c select\\ 1\trtk psql -c select\\ 1", command: "psql", args: ["-c", "select 1"] },
    { description: "brew install", expected: "REWRITE\tbrew install jq\trtk brew install jq", command: "brew", args: ["install", "jq"] },
    { description: "dotnet build", expected: "REWRITE\tdotnet build\trtk dotnet build", command: "dotnet", args: ["build"] },
    { description: "terraform plan", expected: "REWRITE\tterraform plan\trtk terraform plan", command: "terraform", args: ["plan"] },
    { description: "tofu plan", expected: "REWRITE\ttofu plan\trtk tofu plan", command: "tofu", args: ["plan"] },
    { description: "uv sync", expected: "REWRITE\tuv sync\trtk uv sync", command: "uv", args: ["sync"] },
    { description: "fallback env true", expected: "FALLBACK\tenv true\t/usr/bin/env", command: "env", args: ["true"] },
  ];

  for (const testCase of cases) {
    const commandPath = path.join(binDir, testCase.command);
    const { stdout, status } = runCommand(commandPath, testCase.args, {
      cwd: paths.repoRoot,
      env: { ...process.env, RTK_SHIM_DRY_RUN: "1" },
    });
    assert.equal(status, 0, `${testCase.description}: exit status ${status}`);
    assert.equal(stdout, testCase.expected, testCase.description);
    process.stdout.write(`PASS  ${testCase.description}\n`);
  }
}

export async function testCodexConfig(): Promise<void> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "rtk-codex-config-"));

  try {
    const configFile = path.join(tempRoot, "config.toml");
    const shimHome = path.join(tempRoot, ".rtk-codex");
    const basePath = "/Users/rolandk/.codex/tmp/arg0/test:/opt/homebrew/bin:/usr/bin:/bin";
    const logFile = "/tmp/rtk-shim-test.log";

    await writeFile(
      configFile,
      'model = "gpt-5.4"\n\n[notice]\nhide_rate_limit_model_nudge = true\n',
      "utf8",
    );

    const originalEnv = { ...process.env };
    process.env.CODEX_HOME = tempRoot;
    process.env.RTK_SHIM_HOME = shimHome;
    process.env.PATH = basePath;
    process.env.RTK_SHIM_REAL_PATH = basePath;
    process.env.RTK_SHIM_LOG_FILE = logFile;

    await installCodexConfig();

    const expectedRealPath = basePath
      .split(":")
      .filter((part) => !part.includes("/.codex/tmp/arg0/"))
      .join(":");

    const firstContents = await readFile(configFile, "utf8");
    assert.match(firstContents, /# BEGIN RTK SHIM CONFIG/);
    assert.match(firstContents, /# END RTK SHIM CONFIG/);
    assert.match(firstContents, /model = "gpt-5\.4"/);
    assert.match(firstContents, /hide_rate_limit_model_nudge = true/);
    assert.match(firstContents, new RegExp(`PATH = "${tomlEscape(`${shimHome}/bin:${expectedRealPath}`)}"`));
    assert.match(firstContents, new RegExp(`RTK_SHIM_ROOT = "${tomlEscape(shimHome)}"`));
    assert.match(firstContents, new RegExp(`RTK_SHIM_REAL_PATH = "${tomlEscape(expectedRealPath)}"`));
    assert.match(firstContents, new RegExp(`RTK_SHIM_LOG_FILE = "${tomlEscape(logFile)}"`));
    assert.equal(existsSync(path.join(shimHome, "bin", "rtk-shim")), true);
    assert.equal(existsSync(path.join(shimHome, "bin", "git")), true);

    await installCodexConfig();
    const secondContents = await readFile(configFile, "utf8");
    assert.equal((secondContents.match(/# BEGIN RTK SHIM CONFIG/g) ?? []).length, 1);
    assert.equal((secondContents.match(/\[shell_environment_policy\]/g) ?? []).length, 1);
    assert.match(secondContents, new RegExp(`PATH = "${tomlEscape(`${shimHome}/bin:${expectedRealPath}`)}"`));
    assert.match(secondContents, new RegExp(`RTK_SHIM_ROOT = "${tomlEscape(shimHome)}"`));

    await uninstallCodexConfig();
    const afterUninstall = await readFile(configFile, "utf8");
    assert.doesNotMatch(afterUninstall, /# BEGIN RTK SHIM CONFIG/);
    assert.doesNotMatch(afterUninstall, /\[shell_environment_policy\]/);
    assert.match(afterUninstall, /model = "gpt-5\.4"/);
    assert.match(afterUninstall, /hide_rate_limit_model_nudge = true/);

    await writeFile(
      configFile,
      `model = "gpt-5.4"

[shell_environment_policy]
inherit = "all"

[shell_environment_policy.set]
PATH = "${shimHome}/bin:${basePath}"
RTK_SHIM_ROOT = "${shimHome}"
RTK_SHIM_REAL_PATH = "/opt/homebrew/bin:/usr/bin:/bin"
RTK_SHIM_LOG_FILE = "${logFile}"
`,
      "utf8",
    );

    await installCodexConfig();
    const migratedText = await readFile(configFile, "utf8");
    assert.match(migratedText, /# BEGIN RTK SHIM CONFIG/);
    assert.equal((migratedText.match(/\[shell_environment_policy\]/g) ?? []).length, 1);

    await writeFile(
      configFile,
      'model = "gpt-5.4"\n\n[shell_environment_policy]\ninherit = "all"\n',
      "utf8",
    );

    let conflictCaught = false;
    try {
      await installCodexConfig();
    } catch (error) {
      conflictCaught = error instanceof Error && error.message.includes("refusing to overwrite existing shell_environment_policy");
    }
    assert.equal(conflictCaught, true, "expected installer conflict check to fail");

    process.stdout.write("Codex config install/uninstall tests passed\n");

    process.env = originalEnv;
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

export async function validateTmux(sessionName = "rtk-codex-validate"): Promise<void> {
  const paths = getCliPaths();
  const logFile = "/tmp/codex-rtk-shim.log";
  const outputFile = `/tmp/${sessionName}.txt`;
  const consoleFile = `/tmp/${sessionName}.console`;
  const exitFile = `/tmp/${sessionName}.exit`;
  const promptFile = path.join(await mkdtemp(path.join(os.tmpdir(), "rtk-codex-prompt-")), "prompt.txt");

  try {
    const prompt = `Inspect this repository and use ordinary shell commands, not explicit \`rtk ...\` commands, to do the following:
1. Run \`git status\`.
2. Run \`ls\`.
3. Run \`cat AGENTS.md\`.

Do not modify any files. In the final response, summarize what you ran and what you observed.
`;
    await writeFile(promptFile, prompt, "utf8");

    for (const filePath of [logFile, outputFile, consoleFile, exitFile]) {
      await rm(filePath, { force: true });
    }

    spawnSync("tmux", ["kill-session", "-t", sessionName], { stdio: "ignore" });
    const command = `cd '${paths.repoRoot}' && codex exec --full-auto --color never -C '${paths.repoRoot}' -o '${outputFile}' - < '${promptFile}' > '${consoleFile}' 2>&1; rc=$?; printf '%s\n' "$rc" > '${exitFile}'`;
    const tmuxStart = spawnSync("tmux", ["new-session", "-d", "-s", sessionName, command], { stdio: "inherit" });
    if ((tmuxStart.status ?? 1) !== 0) {
      throw new Error(`tmux new-session failed with status ${tmuxStart.status ?? 1}`);
    }

    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline && !existsSync(exitFile)) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }

    assert.equal(existsSync(exitFile), true, `validation failed: timed out waiting for ${exitFile}`);
    const consoleText = await readFile(consoleFile, "utf8");
    process.stdout.write(consoleText);

    const exitCode = (await readFile(exitFile, "utf8")).trim();
    assert.equal(exitCode, "0", `validation failed: Codex exited with ${exitCode}`);
    assert.equal(existsSync(outputFile), true, `validation failed: Codex did not write ${outputFile}`);
    assert.equal(existsSync(logFile), true, "validation failed: shim log was not created");

    const logText = await readFile(logFile, "utf8");
    assert.match(logText, /\trewrite\tgit status( --porcelain)?\trtk git status( --porcelain)?$/m);
    assert.match(logText, /\trewrite\tls(\s.*)?\trtk ls(\s.*)?$/m);
    assert.match(logText, /\trewrite\tcat AGENTS\.md\trtk read AGENTS\.md$/m);

    process.stdout.write(`\nValidation summary\nsession: ${sessionName}\nshim log: ${logFile}\ncodex message: ${outputFile}\n`);
  } finally {
    await rm(path.dirname(promptFile), { recursive: true, force: true });
  }
}
