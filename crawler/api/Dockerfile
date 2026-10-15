FROM node:22-slim AS build

WORKDIR /app
COPY crawler/api/package.json /app/package.json
COPY crawler/api/package-lock.json /app/package-lock.json
RUN npm ci
COPY crawler/api/tsconfig.json /app/tsconfig.json
COPY crawler/api/src /app/src
RUN npm run build

FROM node:22-slim
WORKDIR /app
COPY crawler/api/package.json /app/package.json
COPY crawler/api/package-lock.json /app/package-lock.json
RUN npm ci --omit=dev
COPY --from=build /app/dist /app/dist
CMD ["node", "dist/index.js"]
