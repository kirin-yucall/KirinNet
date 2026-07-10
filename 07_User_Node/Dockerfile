FROM node:20-slim

# Install curl for password recovery (docker exec)
RUN apt-get update && apt-get install -y --no-install-recommends curl && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps
COPY package.json .
RUN npm install --production && npm cache clean --force

# Copy source
COPY server.js ./
COPY models/        ./models/
COPY routes/        ./routes/
COPY lib/            ./lib/
COPY public/         ./public/

# Create data directories for DuckDB + media files
RUN mkdir -p /app/data/duckdb /app/data/media

EXPOSE 8080

ENV NODE_ENV=production
ENV DATA_DIR=/app/data

VOLUME ["/app/data"]

CMD ["node", "server.js"]
