FROM node:20-slim

WORKDIR /app

# Install deps
COPY package.json .
RUN npm install --production && npm cache clean --force

# Copy source
COPY backend/   ./backend/
COPY models/    ./models/
COPY public/    ./public/
COPY utils/     ./utils/

# Create data directories for DuckDB + media files
RUN mkdir -p /app/data/duckdb /app/data/media

EXPOSE 3000

ENV NODE_ENV=production
ENV DATA_DIR=/app/data
ENV JWT_SECRET=change-in-production-use-random-string

VOLUME ["/app/data"]

CMD ["node", "backend/server.js"]
