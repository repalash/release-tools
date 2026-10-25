#!/usr/bin/env bash
# Sets up npm releases through npm-release.yml for one or more repositories. Safe to run again:
# it checks first, skips what is already set, and prints what it did.
#
# For each repository:
#   1. the `npm-publish` environment, with you (the gh user) as required reviewer
#   2. the repository secrets DISCORD_WEBHOOK_URL, CLAUDE_REVIEW_FIRE_URL, CLAUDE_REVIEW_TOKEN
#      (only the missing ones, or all with --replace-secrets; asked once, typed hidden, never printed;
#      an empty answer leaves that secret unset)
#   3. the npm trusted publisher of each package (`npm trust github`, run in your terminal so the
#      npm 2FA prompt works; with --skip-trust it only prints the commands)
#
# Needs: gh logged in with admin rights on the repositories, jq, and for step 3 npm logged in.
#
# Usage: scripts/setup-repos.sh [--replace-secrets] [--skip-trust] <spec>...
#   spec = owner/repo:workflow-file:package[,package...]
#   e.g.   scripts/setup-repos.sh repalash/ts-browser-helpers:publish.yml:ts-browser-helpers
set -euo pipefail

REPLACE_SECRETS=false
SKIP_TRUST=false
SPECS=()
for a in "$@"; do
    case "$a" in
        --replace-secrets) REPLACE_SECRETS=true ;;
        --skip-trust) SKIP_TRUST=true ;;
        -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
        *) SPECS+=("$a") ;;
    esac
done
[ ${#SPECS[@]} -gt 0 ] || { sed -n '2,19p' "$0"; exit 2; }

for tool in gh jq; do command -v "$tool" > /dev/null || { echo "missing: $tool"; exit 1; }; done
gh auth status > /dev/null 2>&1 || { echo "gh is not logged in: run 'gh auth login'"; exit 1; }
ME=$(gh api user --jq .login)
MY_ID=$(gh api user --jq .id)
echo "gh user: $ME"

# Number of required-reviewer entries for $ME on npm-publish (0 when the environment does not exist).
reviewer_count() {
    local n
    n=$(gh api "repos/$1/environments/npm-publish" --jq "[.protection_rules[]? | select(.type == \"required_reviewers\") | .reviewers[]? | select(.reviewer.login == \"$ME\")] | length" 2> /dev/null) || n=0
    case "$n" in ''|*[!0-9]*) echo 0 ;; *) echo "$n" ;; esac
}
FAILED=false

SECRETS=(DISCORD_WEBHOOK_URL CLAUDE_REVIEW_FIRE_URL CLAUDE_REVIEW_TOKEN)
# Values are kept in VAL_<NAME> (no associative arrays: macOS ships bash 3.2).
ask() { # ask NAME: reads a secret value once, hidden
    local var="VAL_$1" v
    if [ -z "${!var+x}" ]; then
        read -rsp "Value for $1 (empty: skip): " v < /dev/tty; echo
        printf -v "$var" '%s' "$v"
    fi
}

TRUST_CMDS=()
for spec in "${SPECS[@]}"; do
    IFS=: read -r repo workflow packages <<< "$spec"
    [ -n "$repo" ] && [ -n "$workflow" ] && [ -n "$packages" ] || { echo "bad spec: $spec (owner/repo:workflow-file:package[,package])"; exit 2; }
    echo
    echo "== $repo"

    # 1. environment npm-publish with a required reviewer (checked again after the change)
    if [ "$(reviewer_count "$repo")" -gt 0 ]; then
        echo "  npm-publish: $ME is a required reviewer"
    else
        jq -n --argjson id "$MY_ID" '{reviewers: [{type: "User", id: $id}]}' \
            | gh api -X PUT "repos/$repo/environments/npm-publish" --input - > /dev/null
        if [ "$(reviewer_count "$repo")" -gt 0 ]; then
            echo "  npm-publish: set $ME as required reviewer"
        else
            echo "  npm-publish: ERROR: $ME is still not a required reviewer; set it at https://github.com/$repo/settings/environments"
            FAILED=true
        fi
    fi

    # 2. repository secrets
    existing=$(gh secret list -R "$repo" --json name --jq '.[].name')
    for s in "${SECRETS[@]}"; do
        if grep -qx "$s" <<< "$existing" && [ "$REPLACE_SECRETS" = false ]; then
            echo "  secret $s: set"
            continue
        fi
        ask "$s"
        var="VAL_$s"
        if [ -z "${!var}" ]; then
            echo "  secret $s: skipped (empty)"
        else
            printf '%s' "${!var}" | gh secret set "$s" -R "$repo" > /dev/null
            echo "  secret $s: stored"
        fi
    done

    # 3. npm trusted publishers (collected; run after all repositories)
    IFS=, read -ra pkgs <<< "$packages"
    for p in "${pkgs[@]}"; do
        TRUST_CMDS+=("npm trust github $p --file $workflow --repo $repo --env npm-publish --allow-publish --allow-stage-publish --yes")
    done
done

if [ "$FAILED" = true ]; then echo; echo "Some steps failed: see the ERROR lines above."; fi

echo
echo "== npm trusted publishers"
printf '  %s\n' "${TRUST_CMDS[@]}"
if [ "$SKIP_TRUST" = true ]; then
    echo "  (--skip-trust: not run)"
    exit 0
fi
command -v npm > /dev/null || { echo "missing: npm"; exit 1; }
echo "  At the first command npm may open a 2FA page: approve it and choose 'skip 2FA for 5 minutes'."
echo "  A package that already has this publisher reports an error; the next command still runs."
for c in "${TRUST_CMDS[@]}"; do
    echo "  -> $c"
    $c || echo "     (failed: see the message above)"
    sleep 2
done
