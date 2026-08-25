FROM node:20-alpine
WORKDIR /workspace

# git is required by simple-git; openssh lets the agent push over SSH remotes.
RUN apk add --no-cache git openssh-client

COPY package.json ./
COPY apps/buggy-backend/package.json ./apps/buggy-backend/
COPY apps/self-healing-agent/package.json ./apps/self-healing-agent/
RUN npm install --include-workspace-root

COPY . .

WORKDIR /workspace/apps/self-healing-agent
CMD ["npm", "run", "dev"]
