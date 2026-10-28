# 智服 Agent 前端镜像：多阶段构建，产物由 nginx 托管
# 构建：docker build -t zhifu-web ./web
FROM node:24-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
# 生成 PWA 图标 + 生产构建
RUN node scripts/make-icons.js && npm run build

# —— 运行阶段 ——
FROM nginx:alpine

COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
