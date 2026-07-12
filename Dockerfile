# Build local monorepo image
# docker build --no-cache -t flowise-chinese .
#
# Run image
# docker run -d --name flowise-chinese -p 3000:3000 --env-file .env flowise-chinese
#
# Multi-stage build:
#   Stage 1 (builder): 安装编译依赖、安装 pnpm 依赖、构建项目
#   Stage 2 (runtime): 保留运行时系统依赖和构建产物

# ==========================================
# Stage 1: Builder
# ==========================================
ARG NODE_VERSION=24-alpine
FROM node:${NODE_VERSION} AS deps

# 安装编译依赖和中文字体
RUN apk update && \
    apk add --no-cache \
    libc6-compat \
    python3 \
    make \
    g++ \
    build-base \
    cairo-dev \
    pango-dev \
    git \
    font-noto-cjk \
    fontconfig && \
    fc-cache -fv

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

# 构建项目（排除 agentflow 和 observe 以匹配原构建行为），并清理仅构建期需要的配置
RUN pnpm build:docker && rm -f .npmrc

# ==========================================
# Stage 2: Runtime
# ==========================================
FROM node:${NODE_VERSION} AS runtime

# 安装当前运行时节点所需的系统依赖和工具
RUN apk update && \
    apk add --no-cache \
    libc6-compat \
    python3 \
    make \
    g++ \
    build-base \
    cairo-dev \
    pango-dev \
    chromium \
    curl \
    font-noto-cjk \
    fontconfig \
    git && \
    fc-cache -fv

# Puppeteer 环境变量
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

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

# 切换到非 root 用户运行（安全最佳实践）
USER node

# 暴露端口
EXPOSE 3000

# 直接启动已构建的 Oclif CLI；runtime stage 不依赖 pnpm
CMD [ "node", "packages/server/bin/run", "start" ]
