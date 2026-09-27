# glibc base: onnxruntime-node (local embedding model) has no musl/Alpine build.
FROM node:22-slim

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/app/data

COPY package*.json ./
# This container is Linux-only and only ever uses onnxruntime's default CPU
# provider, so drop the GPU providers, other-OS binaries, and the web/wasm
# build (transformers.js only stubs it in Node) that npm ci pulls in.
RUN npm ci --omit=dev && npm cache clean --force \
 && rm -rf node_modules/onnxruntime-web \
           node_modules/onnxruntime-node/bin/napi-v3/win32 \
           node_modules/onnxruntime-node/bin/napi-v3/darwin \
           node_modules/onnxruntime-node/bin/napi-v3/linux/*/libonnxruntime_providers_cuda.so \
           node_modules/onnxruntime-node/bin/napi-v3/linux/*/libonnxruntime_providers_tensorrt.so
RUN mkdir -p /app/data/models && chown -R node:node /app/data

COPY --chown=node:node server.js ./
COPY --chown=node:node lib ./lib
COPY --chown=node:node public ./public

USER node

EXPOSE 3000

CMD ["npm", "start"]
