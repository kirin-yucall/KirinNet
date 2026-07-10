FROM node:20-slim

# DuckDB comes with prebuilt binaries — no heavy build deps needed
WORKDIR /app

# Install deps
COPY package.json .
RUN npm install --production && npm cache clean --force

# Copy source
COPY server.js .
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
