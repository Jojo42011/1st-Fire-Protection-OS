# 1st FP Operating System — single-image build
FROM node:20-slim AS build
WORKDIR /app
# native deps for better-sqlite3
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm ci
COPY server ./server
COPY client ./client
RUN npm run build

FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3900
ENV DB_PATH=/data/1stfp.db
COPY package.json package-lock.json* ./
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && npm ci --omit=dev \
  && apt-get purge -y python3 make g++ && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/client ./client
VOLUME /data
EXPOSE 3900
CMD ["node", "server/dist/app.js"]
