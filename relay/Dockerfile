FROM node:20-alpine AS base

WORKDIR /app

# Install dependencies first for better layer caching
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Copy application code
COPY server.js ./

# Copy portal static files (if present)
COPY portal/ ./portal/

# Non-root user for security
USER node

ENV PORT=8765
EXPOSE 8765

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:8765/health || exit 1

CMD ["node", "server.js"]
