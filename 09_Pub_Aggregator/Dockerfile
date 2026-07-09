FROM node:18-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --production

# Copy application code
COPY server.js crawler.js ./
COPY routes/ ./routes/
COPY frontend/ ./frontend/

# Create data directory
RUN mkdir -p /app/data/db

# Expose port
EXPOSE 3000

# Start server
CMD ["node", "server.js"]
