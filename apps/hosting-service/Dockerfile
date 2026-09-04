FROM node:20-slim

WORKDIR /app

# Install Caddy
RUN apt-get update && \
    apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl && \
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg && \
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list && \
    apt-get update && \
    apt-get install -y caddy && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Create directories
RUN mkdir -p /var/www/SMEsAgent/sites /etc/caddy/sites

# Copy Caddyfile
COPY Caddyfile /etc/caddy/Caddyfile

# Copy hosting service
COPY package.json ./
RUN npm ci --omit=dev
COPY server.js ./

EXPOSE 80 443 4000

# Start both Caddy and the hosting service
CMD caddy start --config /etc/caddy/Caddyfile --adapter caddyfile && node server.js
