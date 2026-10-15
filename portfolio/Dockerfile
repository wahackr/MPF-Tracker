FROM node:22-slim AS build

WORKDIR /app
COPY portfolio/package.json /app/package.json
COPY portfolio/package-lock.json /app/package-lock.json
RUN npm ci
COPY portfolio/tsconfig.json /app/tsconfig.json
COPY portfolio/src /app/src
RUN npm run build

FROM node:22-slim
WORKDIR /app
COPY portfolio/package.json /app/package.json
COPY portfolio/package-lock.json /app/package-lock.json
RUN npm ci --omit=dev
COPY --from=build /app/dist /app/dist
COPY portfolio/public /app/public
CMD ["node", "dist/index.js"]
