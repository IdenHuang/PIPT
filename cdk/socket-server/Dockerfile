ARG REGISTRY=""
FROM ${REGISTRY}node:22-alpine

WORKDIR /app

# Install Python and pip
RUN apk add --no-cache python3 py3-pip

# Install Node.js dependencies
COPY package.json package-lock.json ./
RUN npm ci

# Copy Python files and install requirements
COPY *.py ./
COPY requirements.txt ./
RUN pip3 install --break-system-packages -r requirements.txt

# Copy server files
COPY server.js ./
COPY auth.js ./
COPY media-bridge.js ./
COPY session-auth.js ./
COPY session-guard.js ./
COPY stream-relay.js ./
COPY voice-preview-limiter.js ./
COPY relay-token.js ./
COPY patient-context.js ./
COPY logger.js ./

ENV AWS_DEFAULT_REGION=us-east-1

# Alpine's CA bundle (ca-certificates-bundle, in the base image). The Python DB
# clients verify the RDS Proxy certificate against it (sslmode=verify-full).
ENV PGSSLROOTCERT=/etc/ssl/certs/ca-certificates.crt

# Listen on HTTP port
EXPOSE 80

# Add container health check (uses Node.js already in the image — no extra dependencies)
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD node -e "require('http').get('http://localhost:80/health', r => { if (r.statusCode === 200) process.exit(0); else process.exit(1); }).on('error', () => process.exit(1));"

# Launch your HTTP + WebSocket server
CMD ["node", "server.js"]
