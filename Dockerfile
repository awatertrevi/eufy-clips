FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
ENV EUFY_CLIPS_DATA=/data
VOLUME /data
EXPOSE 8787
USER node
CMD ["node", "src/main.mjs"]
