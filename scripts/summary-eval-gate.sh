#!/usr/bin/env bash
# Decides whether the real-model summary eval runs (.github/workflows/checks.yml,
# job summary-eval). Writes run=true or run=false to $GITHUB_OUTPUT, and says why in a
# notice and in the job summary.
#
#   * No SUMMARY_API_KEY secret (HAS_KEY != true): skip.
#   * Started by hand (EVENT=workflow_dispatch): run.
#   * Pull request: run only if a file under EVAL_PATHS changed between the base branch
#     (BASE_SHA) and the pull request's head (HEAD_SHA). If the files cannot be listed,
#     run anyway (fail safe towards a fresh score).
# Decided 2026-11-24 (PROGRESS.md, option (b)). Tested in tests/eval/summary-eval-gate.test.ts.

set -euo pipefail

# Files the eval score depends on.
EVAL_PATHS='^(lib/summarizer/|lib/eval/|fixtures/newsletters/|tests/eval/|vitest\.eval\.config\.mts$|\.github/workflows/checks\.yml$|scripts/summary-eval-gate\.sh$)'

out="${GITHUB_OUTPUT:-/dev/null}"
summary="${GITHUB_STEP_SUMMARY:-/dev/null}"

decide() {
  local run="$1" title="$2" message="$3"
  echo "run=$run" >>"$out"
  echo "::notice title=$title::$message"
  printf '### %s\n\n%s\n' "$title" "$message" >>"$summary"
}

if [[ "${HAS_KEY:-false}" != "true" ]]; then
  decide false "Summary eval skipped" "No SUMMARY_API_KEY secret is set, so no model was evaluated. Add the secret and the SUMMARY_BASE_URL and SUMMARY_MODEL variables to run it."
  exit 0
fi

case "${EVENT:-}" in
  workflow_dispatch)
    decide true "Summary eval runs" "Started by hand."
    exit 0
    ;;
  pull_request) ;;
  *)
    decide false "Summary eval skipped" "The eval runs on pull requests and by hand only (event: ${EVENT:-none})."
    exit 0
    ;;
esac

sha='^[0-9a-f]{40}$'
changed=""
if [[ "${BASE_SHA:-}" =~ $sha && "${HEAD_SHA:-}" =~ $sha ]] && changed="$(git diff --name-only "${BASE_SHA}...${HEAD_SHA}" 2>/dev/null)"; then
  :
else
  decide true "Summary eval runs" "The gate could not list the pull request's changed files, so the eval runs to be safe."
  exit 0
fi

hits="$(printf '%s\n' "$changed" | grep -E "$EVAL_PATHS" || true)"
if [[ -n "$hits" ]]; then
  decide true "Summary eval runs" "This pull request changes files the score depends on: $(printf '%s' "$hits" | tr '\n' ' ')"
else
  decide false "Summary eval skipped" "This pull request changes no summarizer, eval, fixture or eval-workflow file, so the score cannot have moved. No model was called. Run the workflow by hand for a fresh score."
fi
