# Build local monorepo image
# docker build --no-cache -t flowise-chinese .
#
# Run image
# docker run -d --name flowise-chinese -p 3000:3000 --env-file .env flowise-chinese
#
# Multi-stage build:
#   Stage 1 (builder): 安装编译依赖、安装 pnpm 依赖、构建项目
#   Stage 2 (runtime): 保留运行时系统依赖和构建产物

# Release workflows override this fallback with the exact Git commit epoch.
ARG SOURCE_DATE_EPOCH=0

# ==========================================
# Stage 1: Builder
# ==========================================
FROM docker.io/library/node:24.18.0-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS deps

ARG SOURCE_DATE_EPOCH

# 安装完整版本锁定的编译依赖和中文字体；传递依赖漂移时构建失败。
COPY docker/apk-build.lock /tmp/apk-build.lock
RUN case "$SOURCE_DATE_EPOCH" in \
        ''|*[!0-9]*) echo 'SOURCE_DATE_EPOCH must be a non-negative integer' >&2; exit 1 ;; \
    esac && \
    awk -F: '/^P:/{package=$2} /^V:/{print package "=" $2}' /lib/apk/db/installed | LC_ALL=C sort > /tmp/apk-before.lock && \
    apk add --no-cache \
        gcompat=1.1.0-r4 \
        python3=3.14.5-r0 \
        make=4.4.1-r4 \
        g++=15.2.0-r5 \
        build-base=0.5-r4 \
        cairo-dev=1.18.4-r1 \
        pango-dev=1.57.1-r0 \
        git=2.54.0-r0 \
        font-noto-cjk=0_git20220127-r1 \
        fontconfig=2.17.1-r1 && \
    awk -F: '/^P:/{package=$2} /^V:/{print package "=" $2}' /lib/apk/db/installed | LC_ALL=C sort > /tmp/apk-after.lock && \
    comm -13 /tmp/apk-before.lock /tmp/apk-after.lock > /tmp/apk-actual.lock && \
    cmp -s /tmp/apk-build.lock /tmp/apk-actual.lock && \
    SOURCE_DATE_EPOCH="$SOURCE_DATE_EPOCH" fc-cache -fv && \
    rm -f \
        /tmp/apk-before.lock \
        /tmp/apk-after.lock \
        /tmp/apk-actual.lock \
        /tmp/apk-build.lock \
        /var/log/apk.log

# 安装 pnpm
RUN npm install -g pnpm@10.26.0

# 跳过 Chromium 下载，加速构建
ENV PUPPETEER_SKIP_DOWNLOAD=true

# 增加 Node 内存限制以支持大型 monorepo 构建
ENV NODE_OPTIONS=--max-old-space-size=8192

# 设置工作目录
WORKDIR /usr/src/flowise

# 先复制包管理文件，利用 Docker 缓存层
# .npmrc 定义 workspace hoist/link 布局，必须在依赖安装前生效
COPY package.json pnpm-workspace.yaml .npmrc ./
COPY packages/server/package.json ./packages/server/
COPY packages/ui/package.json ./packages/ui/
COPY packages/components/package.json ./packages/components/
COPY packages/api-documentation/package.json ./packages/api-documentation/
COPY packages/agentflow/package.json ./packages/agentflow/
COPY packages/observe/package.json ./packages/observe/

# 复制 lockfile
COPY pnpm-lock.yaml ./

# 安装依赖（--frozen-lockfile 确保可复现构建）
RUN pnpm install --frozen-lockfile

# 从已验证的完整 workspace 依赖层构建应用
FROM deps AS builder

# 复制完整源代码
COPY . .

# 构建项目（排除 agentflow 和 observe 以匹配原构建行为），并清理仅构建期需要的配置、pnpm 状态和动态 Turbo 输出
RUN pnpm build:docker && \
    rm -f \
        .npmrc \
        node_modules/.modules.yaml \
        node_modules/.pnpm-workspace-state-v1.json && \
    rm -rf \
        .turbo \
        node_modules/.cache/turbo \
        packages/api-documentation/.turbo \
        packages/components/.turbo \
        packages/server/.turbo \
        packages/ui/.turbo

# ==========================================
# Stage 2: Runtime
# ==========================================
FROM docker.io/library/node:24.18.0-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS runtime

# Immutable release provenance is supplied by the release pipeline.
ARG SOURCE_DATE_EPOCH
ARG BUILD_SOURCE
ARG BUILD_REVISION
ARG BUILD_VERSION
ARG BUILD_CREATED
RUN test -n "$BUILD_SOURCE" && \
    test -n "$BUILD_VERSION" && \
    test -n "$BUILD_CREATED" && \
    test "${#BUILD_REVISION}" -eq 40 && \
    ! printf '%s' "$BUILD_REVISION" | grep -q '[^0-9a-f]'
LABEL org.opencontainers.image.source="${BUILD_SOURCE}" \
    org.opencontainers.image.revision="${BUILD_REVISION}" \
    org.opencontainers.image.version="${BUILD_VERSION}" \
    org.opencontainers.image.created="${BUILD_CREATED}"

# 安装完整版本锁定的运行时依赖；传递依赖漂移时构建失败。
COPY docker/apk-runtime.lock /tmp/apk-runtime.lock
RUN case "$SOURCE_DATE_EPOCH" in \
        ''|*[!0-9]*) echo 'SOURCE_DATE_EPOCH must be a non-negative integer' >&2; exit 1 ;; \
    esac && \
    awk -F: '/^P:/{package=$2} /^V:/{print package "=" $2}' /lib/apk/db/installed | LC_ALL=C sort > /tmp/apk-before.lock && \
    apk add --no-cache \
        gcompat=1.1.0-r4 \
        python3=3.14.5-r0 \
        cairo-dev=1.18.4-r1 \
        pango-dev=1.57.1-r0 \
        chromium=150.0.7871.181-r0 \
        curl=8.21.0-r0 \
        font-noto-cjk=0_git20220127-r1 \
        fontconfig=2.17.1-r1 \
        git=2.54.0-r0 && \
    awk -F: '/^P:/{package=$2} /^V:/{print package "=" $2}' /lib/apk/db/installed | LC_ALL=C sort > /tmp/apk-after.lock && \
    comm -13 /tmp/apk-before.lock /tmp/apk-after.lock > /tmp/apk-actual.lock && \
    cmp -s /tmp/apk-runtime.lock /tmp/apk-actual.lock && \
    SOURCE_DATE_EPOCH="$SOURCE_DATE_EPOCH" fc-cache -fv && \
    rm -f \
        /tmp/apk-before.lock \
        /tmp/apk-after.lock \
        /tmp/apk-actual.lock \
        /tmp/apk-runtime.lock \
        /var/log/apk.log

# 本地浏览器加载器统一使用镜像内已安装的 Chromium
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
ENV PLAYWRIGHT_EXECUTABLE_PATH=/usr/bin/chromium-browser

# Node 内存限制（生产环境适当降低）
ENV NODE_OPTIONS=--max-old-space-size=4096

# 中文本地化环境变量
ENV LANG=zh_CN.UTF-8
ENV LC_ALL=zh_CN.UTF-8

# 设置工作目录
WORKDIR /usr/src/flowise

# 从 builder 阶段复制完整应用（含 node_modules + 构建产物）
# 使用 --chown=node:node 确保 node 用户拥有所有文件
COPY --from=builder --chown=node:node /usr/src/flowise .

# Seed the named volume with a mountpoint writable by the non-root runtime user.
RUN mkdir -p /usr/src/flowise/.flowise && chown node:node /usr/src/flowise/.flowise

# 切换到非 root 用户运行（安全最佳实践）
USER node

# 暴露端口
EXPOSE 3000

# 直接启动已构建的 Oclif CLI；runtime stage 不依赖 pnpm
CMD [ "node", "packages/server/bin/run", "start" ]
