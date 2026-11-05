FROM oven/bun:1.4.4

WORKDIR /app

COPY package.json bun.lock ./

RUN bun install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src

RUN bun run typecheck

ENV NODE_ENV=production

USER bun

EXPOSE 3000

CMD ["bun", "src/main.ts"]