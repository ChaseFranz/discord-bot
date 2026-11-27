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
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
CMD ["node", "dist/aws/voiceTask.js"]
