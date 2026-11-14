FROM node:22-slim AS build

WORKDIR /app
COPY src/portfolio/backend/package.json /app/package.json
COPY src/portfolio/backend/package-lock.json /app/package-lock.json
RUN npm ci
COPY src/portfolio/backend/tsconfig.json /app/tsconfig.json
COPY src/portfolio/backend/src /app/src
RUN npm run build

FROM node:22-slim
WORKDIR /app/backend
COPY src/portfolio/backend/package.json /app/backend/package.json
COPY src/portfolio/backend/package-lock.json /app/backend/package-lock.json
RUN npm ci --omit=dev
COPY --from=build /app/dist /app/backend/dist
COPY src/portfolio/frontend /app/frontend
CMD ["node", "dist/index.js"]
