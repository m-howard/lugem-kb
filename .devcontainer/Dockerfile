# Development container image for lugem-kb.
#
# Node, Bun and the Pulumi CLI are NOT pinned here. They are read at build time out of the same
# files CI reads (`.nvmrc`, `.bun-version`, `infra/pulumi/package.json`), so there is exactly one
# place to bump each of them and the container cannot drift from the repo again. That requires the
# build context to be the repo root — `devcontainer.json` sets `"context": ".."` for this reason.
FROM mcr.microsoft.com/devcontainers/base:bookworm

# `curl | bash` is used below to install Bun, Pulumi and starship. Without pipefail a failed
# download silently pipes an empty script into a shell that exits 0, and the image builds "fine".
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Kept deliberately short. `bubblewrap` is Claude Code's Linux sandbox; `shellcheck` lints
# `post-create.sh`; `jq` reads the Pulumi version out of a manifest below; `unzip` is required by
# both the Bun installer and the AWS CLI archive.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    bubblewrap \
    ca-certificates \
    curl \
    gnupg \
    jq \
    lsb-release \
    shellcheck \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# The repo's version sources. Note that `.dockerignore` excludes `infra/` but negates
# `!infra/pulumi/package.json`, so this manifest — and only this manifest — is in the context.
COPY .nvmrc .bun-version infra/pulumi/package.json /tmp/versions/

# Node, from `.nvmrc`. The repo sets `engines.node: ">=24"` with `engine-strict=true` in `.npmrc`,
# so a mismatch here fails every npm-touching install rather than degrading quietly.
RUN NODE_MAJOR="$(tr -d 'v \n' < /tmp/versions/.nvmrc)" && \
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    rm -rf /var/lib/apt/lists/*

# Bun, from `.bun-version`. Installed to /usr/local so it is on PATH for root and the remote user
# alike — a user-scoped install is invisible to whichever of the two did not run it.
# BUN_INSTALL must be exported, not prefixed: a `VAR=x curl … | bash` prefix applies to curl, on
# the left of the pipe, and the installing shell never sees it.
RUN BUN_VERSION="$(tr -d ' \n' < /tmp/versions/.bun-version)" && \
    export BUN_INSTALL=/usr/local && \
    curl -fsSL https://bun.sh/install | bash -s -- "bun-v${BUN_VERSION}"

# Pulumi CLI, matched to the `@pulumi/pulumi` SDK the infra program already pins so the two move
# together. Pulumi.yaml requires >= 3.226.0; the SDK pin has been comfortably above that.
# The installer derives its install root from `--install-root` alone and overwrites any inherited
# PULUMI_INSTALL_ROOT, so the path has to be a flag or the CLI lands in root's ~/.pulumi, invisible
# to the remote user. `--no-edit-path` then skips the .profile rewrite /usr/local/bin makes moot.
RUN PULUMI_VERSION="$(jq -r '.dependencies["@pulumi/pulumi"]' /tmp/versions/package.json)" && \
    curl -fsSL https://get.pulumi.com | sh -s -- \
    --version "$PULUMI_VERSION" \
    --install-root /usr/local \
    --no-edit-path

# AWS CLI v2. `docs/corpus-repository.md` and the publish workflows shell out to it.
RUN set -eu; \
    case "$(dpkg --print-architecture)" in \
    amd64) aws_arch=x86_64 ;; \
    arm64) aws_arch=aarch64 ;; \
    *) echo "unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-${aws_arch}.zip" -o /tmp/awscliv2.zip; \
    unzip -q /tmp/awscliv2.zip -d /tmp; \
    /tmp/aws/install; \
    rm -rf /tmp/awscliv2.zip /tmp/aws

# Prompt. Lands in /usr/local/bin; the shell wiring is done per-user in `post-create.sh`, because
# the ~/.zshrc it appends to is created by the common-utils feature, which layers on top of this.
RUN curl -fsSL https://starship.rs/install.sh | sh -s -- -y

# Fail the build, not the first terminal, when a version source and the installed toolchain
# disagree. Node is checked on the major only — that is all `.nvmrc` pins.
RUN set -eu; \
    pulumi version; aws --version; \
    node_major="$(node --version | tr -d 'v' | cut -d. -f1)"; \
    test "$node_major" = "$(tr -d 'v \n' < /tmp/versions/.nvmrc)" \
    || { echo "node $(node --version) does not match .nvmrc" >&2; exit 1; }; \
    test "$(bun --version)" = "$(tr -d ' \n' < /tmp/versions/.bun-version)" \
    || { echo "bun $(bun --version) does not match .bun-version" >&2; exit 1; }; \
    echo "node $(node --version), bun $(bun --version)"; \
    rm -rf /tmp/versions

# Hand the default shell back. SHELL is image metadata, so the feature layers the devcontainer CLI
# builds on top of this image would otherwise inherit pipefail and fail on pipes they tolerate.
SHELL ["/bin/sh", "-c"]
