FROM node:20-alpine AS base
WORKDIR /app
ENV NODE_ENV=development

COPY package.json ./
COPY apps/buggy-backend/package.json ./apps/buggy-backend/
COPY apps/self-healing-agent/package.json ./apps/self-healing-agent/
RUN npm install --workspace @self-healing/buggy-backend --include-workspace-root

COPY apps/buggy-backend ./apps/buggy-backend

WORKDIR /app/apps/buggy-backend
RUN mkdir -p /var/log/buggy-backend

EXPOSE 4000
CMD ["npm", "run", "dev"]
