# syntax=docker/dockerfile:1
# The voice task: the side of Nimbus that joins calls, run on AWS Fargate only while it's in one
# (see src/aws/voiceTask.ts). Built and pushed by `cdk deploy` (infra/lib/nimbus-cloud-stack.ts).

FROM node:24-bookworm-slim AS build
WORKDIR /app
# Build tools, in case a native module (@discordjs/opus) has no prebuilt binary for this platform.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && apt-get clean && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json && npm prune --omit=dev

FROM node:24-bookworm-slim
# ffmpeg decodes music and speech; certificates for HTTPS to Discord, Claude and AWS.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && apt-get clean && rm -rf /var/lib/apt/lists/*
# yt-dlp fetches YouTube audio for music, using this image's Node for YouTube's player code.
# Pinned and checked: when /play stops working because YouTube changed something, move both the
# version and the checksum to a newer release (https://github.com/yt-dlp/yt-dlp/releases, SHA2-256SUMS).
ADD --chmod=755 --checksum=sha256:fb847a2e4a9ddc8cf5fcfb4bb7f42ba8969ecf72068def0278074f9d300bd13c \
  https://github.com/yt-dlp/yt-dlp/releases/download/2026.11.23/yt-dlp_linux_aarch64 /usr/local/bin/yt-dlp
RUN yt-dlp --version
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Calls can't be heard or played without the native part of @discordjs/opus, which its install
# script fetches or builds (allowed by allowScripts in package.json; npm is starting to skip the
# install scripts of dependencies that aren't). If it is missing, stop the build here rather than
# ship a voice task that fails in calls.
RUN node -e "new (require('@discordjs/opus').OpusEncoder)(48000, 2)"
USER node
CMD ["node", "dist/aws/voiceTask.js"]
