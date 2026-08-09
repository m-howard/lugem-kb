FROM mcr.microsoft.com/devcontainers/base:bullseye

# Update and install dependencies
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    bubblewrap \
    curl \
    lsb-release \
    gnupg \
    ca-certificates \
    software-properties-common \
    apt-transport-https \
    jq \
    shellcheck \
    socat \
    unzip \
    libc6 \
    &&  rm -rf /var/lib/apt/lists/*

# Install GitHub CLI
RUN mkdir -p /usr/share/keyrings && \
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | tee /usr/share/keyrings/githubcli-archive-keyring.gpg > /dev/null && \
    chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends gh && \
    rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && npm install -g npm@latest

RUN npm install -g --allow-scripts=bun bun \
    && corepack enable \
    && corepack prepare pnpm@latest --activate \
    && bun --version \
    && pnpm --version

# Install Python 3 and pip
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 python3-pip && \
    ln -s /usr/bin/python3 /usr/bin/python && \
    pip3 install --upgrade pip setuptools && \
    rm -rf /var/lib/apt/lists/*

RUN python --version && \
    pip --version

# Install uv
RUN pip install uv

RUN curl -fsSL https://claude.ai/install.sh | bash

RUN curl -sS https://starship.rs/install.sh | sh -s -- -y

RUN npm install -g @nestjs/cli

# COPY .devcontainer/.zshrc /home/vscode/
