ARG NODE_VERSION
FROM node:${NODE_VERSION}-bookworm-slim

SHELL ["/bin/bash", "-o", "pipefail", "-c"]
ARG PACKAGE_MANAGER_PIN
ENV COREPACK_HOME="/corepack"
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME/bin:$PNPM_HOME:$PATH"
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/* \
    && git config --system init.defaultBranch main \
    && install -d -m 0755 "$COREPACK_HOME" "$PNPM_HOME" "$PNPM_HOME/bin" \
    && corepack enable --install-directory "$PNPM_HOME" \
    && corepack prepare "${PACKAGE_MANAGER_PIN}" --activate \
    && chmod -R a+rX "$COREPACK_HOME" "$PNPM_HOME"

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*
