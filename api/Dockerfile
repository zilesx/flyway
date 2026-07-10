FROM node:22-alpine
WORKDIR /app
COPY server.mjs ./server.mjs
ENV NODE_ENV=production PORT=3001
USER node
EXPOSE 3001
CMD ["node", "server.mjs"]
