FROM node:22-slim AS build

WORKDIR /app
COPY src/valuation/package.json /app/package.json
COPY src/valuation/package-lock.json /app/package-lock.json
RUN npm ci
COPY src/valuation/tsconfig.json /app/tsconfig.json
COPY src/valuation/src /app/src
RUN npm run build

FROM node:22-slim
WORKDIR /app
COPY src/valuation/package.json /app/package.json
COPY src/valuation/package-lock.json /app/package-lock.json
RUN npm ci --omit=dev
COPY --from=build /app/dist /app/dist
CMD ["node", "dist/index.js"]
