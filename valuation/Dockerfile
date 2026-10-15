FROM node:22-slim AS build

WORKDIR /app
COPY valuation/package.json /app/package.json
COPY valuation/package-lock.json /app/package-lock.json
RUN npm ci
COPY valuation/tsconfig.json /app/tsconfig.json
COPY valuation/src /app/src
RUN npm run build

FROM node:22-slim
WORKDIR /app
COPY valuation/package.json /app/package.json
COPY valuation/package-lock.json /app/package-lock.json
RUN npm ci --omit=dev
COPY --from=build /app/dist /app/dist
CMD ["node", "dist/index.js"]
