FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/app/data

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
RUN mkdir -p /app/data && chown node:node /app/data

COPY --chown=node:node server.js ./
COPY --chown=node:node public ./public

USER node

EXPOSE 3000

CMD ["npm", "start"]
