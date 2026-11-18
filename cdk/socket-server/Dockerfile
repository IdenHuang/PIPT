ARG REGISTRY=""
# Debian trixie, not Alpine: Alpine's vulnerability data flags its zlib for
# CVE-2026-4738 with no fixed package, which fails the ECR scan gate. Debian
# attributes that CVE only to gdal, which this image doesn't include.
# https://security-tracker.debian.org/tracker/CVE-2026-4738
# Trixie (not the bookworm default of "slim") ships Python 3.13;
# aws_sdk_bedrock_runtime requires Python >= 3.12.
FROM ${REGISTRY}node:22-trixie-slim

WORKDIR /app

# Install Python, pip and the CA bundle; upgrade base packages so security
# fixes published after the base image was built are included.
RUN apt-get update \
  && apt-get upgrade -y \
  && apt-get install -y --no-install-recommends python3 python3-pip ca-certificates \
  && rm -rf /var/lib/apt/lists/*

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
COPY socket-auth-lifetime.js ./
COPY patient-context.js ./
COPY logger.js ./
COPY event-guard.js ./

ENV AWS_DEFAULT_REGION=us-east-1

# Debian's CA bundle (ca-certificates package, installed above). The Python DB
# clients verify the RDS Proxy certificate against it (sslmode=verify-full).
ENV PGSSLROOTCERT=/etc/ssl/certs/ca-certificates.crt

# Listen on HTTP port
EXPOSE 80

# Add container health check (uses Node.js already in the image — no extra dependencies)
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD node -e "require('http').get('http://localhost:80/health', r => { if (r.statusCode === 200) process.exit(0); else process.exit(1); }).on('error', () => process.exit(1));"

# Launch your HTTP + WebSocket server
CMD ["node", "server.js"]
