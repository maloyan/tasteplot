#!/usr/bin/env bash
# USAGE: scripts/publish.sh <check|key|deploy|repo|all> [--yes]
#
#   check         Run tests, typecheck and build. Scan tracked files for secrets. Local only.
#   key           Ask for the Qloo API key (hidden input), write it to .env, run the live spike.
#   deploy --yes  Create the KV namespace (once), set the QLOO_API_KEY secret, deploy the Worker.
#   repo --yes    Create the PUBLIC GitHub repo maloyan/tasteplot (once) and push the current branch as main.
#   all --yes     check, then deploy, then repo.
#
# "deploy" and "repo" publish to the internet. They refuse to run without --yes.
# Run them only after the owner approves the publish. Every step is safe to run again:
# it reuses the KV namespace, the secret and the repo when they already exist.
set -euo pipefail

cd "$(dirname "$0")/.."
REPO="${TASTEPLOT_REPO:-maloyan/tasteplot}"
CMD="${1:-}"
YES="${2:-}"

need_yes() {
  if [[ "$YES" != "--yes" ]]; then
    echo "Refused: '$CMD' publishes to the internet. Add --yes after the owner approves." >&2
    exit 2
  fi
}

check() {
  echo "== tests, typecheck, build"
  npm test --silent
  npm run --silent typecheck
  npm run --silent build >/dev/null
  echo "== secret scan of tracked files"
  if git grep -nIE "sk-ant-[A-Za-z0-9_-]{10,}|gho_[A-Za-z0-9]{20,}|(QLOO|ANTHROPIC)_API_KEY=[A-Za-z0-9]{8,}" -- . ':!scripts/publish.sh'; then
    echo "FAIL: a tracked file looks like it holds a secret." >&2; exit 1
  fi
  for p in notes .env .dev.vars; do
    if [[ -n "$(git ls-files "$p")" ]]; then echo "FAIL: $p is tracked by git." >&2; exit 1; fi
  done
  echo "check OK"
}

key() {
  [[ -f .env ]] || cp .env.example .env
  chmod 600 .env
  printf "Paste the Qloo API key (input is hidden), then press Enter: "
  read -rs K; echo
  [[ -n "$K" ]] || { echo "No key given." >&2; exit 1; }
  # Replace the QLOO_API_KEY line in place. The key never goes to stdout or to git.
  K="$K" python3 - <<'PY'
import os, re
p = ".env"; k = os.environ["K"].strip()
s = open(p).read()
s = re.sub(r"(?m)^QLOO_API_KEY=.*$", "QLOO_API_KEY=" + k, s) if re.search(r"(?m)^QLOO_API_KEY=", s) else s + "\nQLOO_API_KEY=" + k + "\n"
open(p, "w").write(s)
PY
  echo "Key saved to .env (mode 600, gitignored)."
  mkdir -p notes
  echo "== live coverage spike (about 36 Qloo calls, no LLM calls)"
  npx tsx --env-file=.env scripts/spike.ts | tee notes/spike.md
  echo "Spike table saved to notes/spike.md."
}

deploy() {
  need_yes
  npx wrangler whoami >/dev/null || { echo "Run: npx wrangler login" >&2; exit 1; }
  if grep -qE '^\[\[kv_namespaces\]\]' wrangler.toml; then
    echo "KV namespace already in wrangler.toml."
  else
    ID="$(npx wrangler kv namespace list 2>/dev/null | python3 -c 'import json,sys
for n in json.load(sys.stdin):
    if n["title"].endswith("TASTEPLOT_CACHE"): print(n["id"]); break')"
    if [[ -z "$ID" ]]; then
      npx wrangler kv namespace create TASTEPLOT_CACHE >/dev/null
      ID="$(npx wrangler kv namespace list | python3 -c 'import json,sys
for n in json.load(sys.stdin):
    if n["title"].endswith("TASTEPLOT_CACHE"): print(n["id"]); break')"
    fi
    [[ -n "$ID" ]] || { echo "Could not find or create the KV namespace." >&2; exit 1; }
    ID="$ID" python3 - <<'PY'
import os
p = "wrangler.toml"; s = open(p).read()
s = s.replace('# [[kv_namespaces]]\n# binding = "CACHE"\n# id = "<paste id here>"',
              '[[kv_namespaces]]\nbinding = "CACHE"\nid = "%s"' % os.environ["ID"])
open(p, "w").write(s)
PY
    grep -qE '^\[\[kv_namespaces\]\]' wrangler.toml || { echo "Could not patch wrangler.toml." >&2; exit 1; }
    echo "KV namespace $ID written to wrangler.toml."
  fi
  QK="$(grep -E '^QLOO_API_KEY=' .env 2>/dev/null | cut -d= -f2- || true)"
  if [[ -n "$QK" ]]; then
    printf "%s" "$QK" | npx wrangler secret put QLOO_API_KEY >/dev/null
    echo "Secret QLOO_API_KEY set. The site runs on LIVE Qloo data."
  else
    echo "No QLOO_API_KEY in .env. The site runs on FIXTURE data (badge shows it)."
  fi
  npm run deploy
}

repo() {
  need_yes
  check
  if gh repo view "$REPO" >/dev/null 2>&1; then
    echo "Repo $REPO exists."
  else
    gh repo create "$REPO" --public --description "Tasteplot: a site-finder agent that maps where a brand's customers' taste lives, on Qloo Taste AI. Qloo Agentic Hackathon 2026." >/dev/null
    echo "Repo $REPO created (public)."
  fi
  git remote get-url origin >/dev/null 2>&1 || git remote add origin "git@github.com:$REPO.git"
  git push -u origin HEAD:main
  gh repo edit "$REPO" --add-topic qloo --add-topic agent --add-topic hackathon --add-topic cloudflare-workers >/dev/null
  [[ -n "${TASTEPLOT_URL:-}" ]] && gh repo edit "$REPO" --homepage "$TASTEPLOT_URL" >/dev/null
  echo "Pushed. Check https://github.com/$REPO shows 'MIT license' in About."
}

case "$CMD" in
  check) check ;;
  key) key ;;
  deploy) deploy ;;
  repo) repo ;;
  all) need_yes; check; deploy; repo ;;
  *) sed -n '2,13p' "$0"; exit 1 ;;
esac
