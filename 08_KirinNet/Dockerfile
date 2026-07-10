FROM kirinnet-user-node

WORKDIR /app

# Remove user-node source, keep node_modules
RUN rm -rf server.js models routes public

# Install additional deps (cors)
RUN npm install cors --production

# Copy platform source
COPY backend/ ./backend/
COPY models/  ./models/
COPY public/  ./public/
COPY utils/   ./utils/

RUN mkdir -p /app/data/duckdb /app/data/media

EXPOSE 3000

ENV NODE_ENV=production
ENV DATA_DIR=/app/data
ENV JWT_SECRET=change-me-in-production

VOLUME ["/app/data"]

CMD ["node", "backend/server.js"]
