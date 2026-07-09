FROM node:18-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --production

# Copy application code
COPY server.js ./
COPY routes/ ./routes/
COPY public/ ./public/

# Create data directory for persistent storage
RUN mkdir -p /app/data/media /app/data/db

# Expose port
EXPOSE 8080

# Start server
CMD ["node", "server.js"]
