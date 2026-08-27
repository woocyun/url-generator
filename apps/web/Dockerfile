# syntax=docker/dockerfile:1

# ---- base -------------------------------------------------------------------
FROM node:22-alpine AS base
WORKDIR /app

# ---- deps -------------------------------------------------------------------
FROM base AS deps
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci

# ---- dev --------------------------------------------------------------------
FROM deps AS dev
ENV NODE_ENV=development
COPY . .
EXPOSE 3000
CMD ["npm", "run", "dev", "--workspace", "@url-generator/web"]

# ---- build ------------------------------------------------------------------
FROM deps AS build
ENV NODE_ENV=production
COPY . .
RUN npm run build --workspace @url-generator/web

# ---- runner -----------------------------------------------------------------
# `output: 'standalone'` emits a server bundle with only the traced
# dependencies, so node_modules is not copied into the final image.
FROM base AS runner
ENV NODE_ENV=production
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
