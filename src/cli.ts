#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { doctor, installCodexConfig, installShellHook, testCodexConfig, testShellHook, testShims, uninstallCodexConfig, uninstallShellHook, updateSupportedCommands, validateTmux } from "./core.js";

function printHelp(version: string): void {
  process.stdout.write(`rtk-codex ${version}

Usage:
  rtk-codex <command> [args...]

Commands:
  install         Install machine-level shims and the managed Codex config block
  uninstall       Remove only the managed Codex config block
  install-shell   Install shims plus a shell rc hook for AI agent sessions (Antigravity)
  uninstall-shell Remove the managed shell rc hook
  update          Refresh shim coverage (defaults to the tag of the local rtk binary)
  doctor          Check rtk presence, manifest freshness, config drift, log perms
  validate-tmux   Run end-to-end Codex CLI validation in tmux
  test-config     Run installer/config tests
  test-shims      Run low-level shim rewrite tests
  test-shell      Run shell rc hook install/uninstall tests
  help            Show this help
  version         Print the package version

Examples:
  npx rtk-codex install
  bunx rtk-codex install
  npx rtk-codex update --ref <commit-or-tag>
`);
}

async function main(): Promise<void> {
  const version = await getPackageVersion();
  const args = process.argv.slice(2);
  const subcommand = args[0];

  if (!subcommand || subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    printHelp(version);
    return;
  }

  if (subcommand === "version" || subcommand === "--version") {
    process.stdout.write(`${version}\n`);
    return;
  }

  switch (subcommand) {
    case "install":
      await installCodexConfig();
      return;
    case "uninstall":
      await uninstallCodexConfig();
      return;
    case "install-shell":
      await installShellHook({ rcFile: parseRcFlag(args) });
      return;
    case "uninstall-shell":
      await uninstallShellHook({ rcFile: parseRcFlag(args) });
      return;
    case "update": {
      let refOverride: string | undefined;
      let force = false;
      for (let index = 1; index < args.length; index += 1) {
        if (args[index] === "--ref") {
          refOverride = args[index + 1];
          if (!refOverride) {
            throw new Error("missing value for --ref");
          }
          index += 1;
        } else if (args[index] === "--force") {
          force = true;
        } else {
          throw new Error(`unknown argument: ${args[index]}`);
        }
      }
      await updateSupportedCommands({ refOverride, force });
      return;
    }
    case "doctor":
      await doctor();
      return;
    case "validate-tmux":
      await validateTmux(args[1] ?? "rtk-codex-validate");
      return;
    case "test-config":
      await testCodexConfig();
      return;
    case "test-shell":
      await testShellHook();
      return;
    case "test-shims":
      await testShims();
      return;
    default:
      throw new Error(`unknown command: ${subcommand}`);
  }
}

function parseRcFlag(args: string[]): string | undefined {
  for (let index = 1; index < args.length; index += 1) {
    if (args[index] === "--rc") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("missing value for --rc");
      }
      return value;
    }
    throw new Error(`unknown argument: ${args[index]}`);
  }
  return undefined;
}

async function getPackageVersion(): Promise<string> {
  if (process.env.npm_package_version) {
    return process.env.npm_package_version;
  }

  const cliFile = fileURLToPath(import.meta.url);
  const packageJsonPath = path.resolve(path.dirname(cliFile), "..", "package.json");

  try {
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as { version?: string };
    return packageJson.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
