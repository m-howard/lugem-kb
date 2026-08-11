#!/usr/bin/env bash
#
# Runs once, as the remote user, after the dev container features have been layered on top of the
# image. Anything user-scoped belongs here rather than in the Dockerfile: the Dockerfile's RUN
# steps execute as root, so a per-user install there lands in /root and is invisible to the user
# who actually gets the terminal.
set -euo pipefail

echo '==> Installing workspace dependencies'
bun install --frozen-lockfile

echo '==> Installing the Claude Code CLI'
curl -fsSL https://claude.ai/install.sh | bash

# The common-utils feature creates this file, which is why the wiring cannot live in the image.
# Idempotent: post-create can run again on a rebuild that reuses the volume.
if [ -f "${HOME}/.zshrc" ] && ! grep -q 'starship init zsh' "${HOME}/.zshrc"; then
    echo '==> Enabling the starship prompt'
    # shellcheck disable=SC2016  # The literal $(...) is written to .zshrc, to run at shell start.
    printf '\neval "$(starship init zsh)"\n' >>"${HOME}/.zshrc"
fi

# Deliberately NOT installed: Playwright browsers. They add roughly half a gigabyte to every
# rebuild for a suite most changes never touch. Run `bunx playwright install chromium` when you
# need `bun run test:e2e`, or point PLAYWRIGHT_CHROMIUM_EXECUTABLE at a browser you already have.
echo '==> Done. For e2e: bunx playwright install chromium'
