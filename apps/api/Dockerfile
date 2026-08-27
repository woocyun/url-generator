# syntax=docker/dockerfile:1

# ---- base -------------------------------------------------------------------
FROM node:22-alpine AS base
WORKDIR /app
# npm workspaces resolve symlinks across the repo, so the whole workspace root
# is the build context rather than just apps/api.

# ---- deps -------------------------------------------------------------------
# Every workspace manifest must be present for `npm ci` to reconstruct the tree,
# even the ones this image does not run. Copying manifests before source keeps
# the install layer cached across source edits.
FROM base AS deps
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci

# ---- dev --------------------------------------------------------------------
# Source is bind-mounted by compose; the COPY here only matters when the image
# is run without a mount.
FROM deps AS dev
ENV NODE_ENV=development
COPY . .
EXPOSE 4000
CMD ["npm", "run", "dev", "--workspace", "@url-generator/api"]

# ---- runner -----------------------------------------------------------------
FROM deps AS runner
ENV NODE_ENV=production
COPY . .
USER node
EXPOSE 4000
CMD ["npm", "run", "start", "--workspace", "@url-generator/api"]
