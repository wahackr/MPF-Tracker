FROM node:22-slim AS build

WORKDIR /app
COPY src/purchase/package.json /app/package.json
COPY src/purchase/package-lock.json /app/package-lock.json
RUN npm ci
COPY src/purchase/tsconfig.json /app/tsconfig.json
COPY src/purchase/src /app/src
RUN npm run build

FROM node:22-slim
WORKDIR /app
COPY src/purchase/package.json /app/package.json
COPY src/purchase/package-lock.json /app/package-lock.json
RUN npm ci --omit=dev
COPY --from=build /app/dist /app/dist
CMD ["node", "dist/index.js"]
