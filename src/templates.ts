export function buildDispatcherScript(): string {
  return `#!/usr/bin/env bash
set -euo pipefail

cmd_name="\${RTK_SHIM_COMMAND:-$(basename "$0")}"
# Don't leak the shim command name into the real command's children: nested
# agent shells re-prepend the shim dir and would mistake every shim for it.
unset RTK_SHIM_COMMAND
shim_bin_dir="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"

log_event() {
  local decision="$1"
  local original="$2"
  local target="$3"

  if [[ -n "\${RTK_SHIM_LOG_FILE:-}" ]]; then
    mkdir -p "$(dirname "\${RTK_SHIM_LOG_FILE}")"
    {
      [[ -e "\${RTK_SHIM_LOG_FILE}" ]] || { : >> "\${RTK_SHIM_LOG_FILE}"; chmod 600 "\${RTK_SHIM_LOG_FILE}"; }
      printf '%s\\t%s\\t%s\\t%s\\n' \\
        "$(date '+%Y-%m-%dT%H:%M:%S%z')" \\
        "\${decision}" \\
        "\${original}" \\
        "\${target}" >> "\${RTK_SHIM_LOG_FILE}"
    } 2>/dev/null || true
  fi

  if [[ "\${RTK_SHIM_DEBUG:-0}" == "1" ]]; then
    printf '[rtk-shim] %s: %s => %s\\n' "\${decision}" "\${original}" "\${target}" >&2
  fi
}

build_command_line() {
  local args=("\${cmd_name}")
  local quoted

  for arg in "$@"; do
    printf -v quoted '%q' "\${arg}"
    args+=("\${quoted}")
  done

  local joined
  printf -v joined '%s ' "\${args[@]}"
  printf '%s' "\${joined% }"
}

derive_real_path() {
  if [[ -n "\${RTK_SHIM_REAL_PATH:-}" ]]; then
    printf '%s' "\${RTK_SHIM_REAL_PATH}"
    return
  fi

  local clean_entries=()
  local entry
  IFS=':' read -r -a current_entries <<< "\${PATH:-}"

  for entry in "\${current_entries[@]}"; do
    if [[ "\${entry%/}" == "\${shim_bin_dir%/}" ]]; then
      continue
    fi
    clean_entries+=("\${entry}")
  done

  local clean_path
  printf -v clean_path '%s:' "\${clean_entries[@]}"
  printf '%s' "\${clean_path%:}"
}

real_path="$(derive_real_path)"
original_command="$(build_command_line "$@")"

if command -v rtk >/dev/null 2>&1; then
  rewritten_command="$(rtk rewrite "\${original_command}" 2>/dev/null || true)"

  # Only trust single-line output that invokes rtk; anything else (warnings,
  # trust prompts, multi-line noise) must not reach bash -c.
  # %q-escaped input never produces bare shell metacharacters, so both env
  # values and the tail accept any backslash-escaped char (\\., incl. \\ for
  # spaces) but reject unescaped ; & | < > $ \` — those only appear in
  # non-compliant rtk stdout, which must not reach bash -c.
  rtk_shape='^(sudo +)?(env +([A-Za-z_][A-Za-z0-9_]*=(\\\\.|[^ ;&|<>$\`\\\\])* +)*)?rtk (\\\\.|[^;&|<>$\`\\\\])+$'
  if [[ -n "\${rewritten_command}" && "\${rewritten_command}" != "\${original_command}" \\
        && "\${rewritten_command}" != *$'\\n'* \\
        && "\${rewritten_command}" =~ \$rtk_shape ]]; then
    log_event "rewrite" "\${original_command}" "\${rewritten_command}"
    if [[ "\${RTK_SHIM_DRY_RUN:-0}" == "1" ]]; then
      printf 'REWRITE\\t%s\\t%s\\n' "\${original_command}" "\${rewritten_command}"
      exit 0
    fi
    exec /usr/bin/env PATH="\${real_path}" bash -c "\${rewritten_command}"
  fi
fi

real_cmd="$(PATH="\${real_path}" command -v -- "\${cmd_name}" || true)"

if [[ -z "\${real_cmd}" ]]; then
  printf 'rtk-shim: could not resolve real binary for %s\\n' "\${cmd_name}" >&2
  exit 127
fi

log_event "fallback" "\${original_command}" "\${real_cmd}"
if [[ "\${RTK_SHIM_DRY_RUN:-0}" == "1" ]]; then
  printf 'FALLBACK\\t%s\\t%s\\n' "\${original_command}" "\${real_cmd}"
  exit 0
fi
exec /usr/bin/env PATH="\${real_path}" "\${real_cmd}" "$@"
`;
}

export function buildWrapperScript(commandName: string): string {
  return `#!/usr/bin/env bash
set -euo pipefail

export RTK_SHIM_COMMAND="${commandName}"
exec "$(dirname "$0")/rtk-shim" "$@"
`;
}
