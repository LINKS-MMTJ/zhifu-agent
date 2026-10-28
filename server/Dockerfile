# 智服 Agent 后端镜像
# 构建：docker build -t zhifu-server ./server
FROM node:24-alpine

WORKDIR /app

# 先拷贝依赖清单，利用镜像层缓存：代码改动不会重新装依赖
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# 只拷贝运行所需源码（eval 脚本不进生产镜像）
COPY src ./src
COPY scripts ./scripts
COPY knowledge ./knowledge

# 构建期完成文档入库（多格式解析 → 切块 → 向量化），镜像自带知识索引
# 索引放在 /app/kb-index，与运行期数据目录 /app/data 分开：
# 否则挂载 /app/data 时会把镜像里构建好的索引隐藏掉
RUN node scripts/ingest.js --out kb-index

ENV NODE_ENV=production
ENV KB_INDEX_DIR=/app/kb-index
ENV DATA_DIR=/app/data
ENV PORT=4000
EXPOSE 4000

# 容器健康检查：用 /api/ready 判断依赖是否就绪（模型可用 + 知识库已加载）
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/api/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
