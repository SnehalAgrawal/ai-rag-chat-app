# Backend image (Express API). Weaviate runs from docker-compose.yml;
# the frontend runs with `npm run dev` in frontend/.
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev
COPY backend ./
EXPOSE 4000
CMD ["node", "index.js"]
