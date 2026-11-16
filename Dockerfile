# Glaze Journal server: Node (>= 24, for the built-in node:sqlite) and the app's own files. No npm packages.
FROM node:26-slim

WORKDIR /app
COPY package.json server.js importer.js catalog.js idtoken.js ./
COPY public ./public

# The SQLite database (accounts and encrypted journals) and the encrypted photos live here; mount a volume to keep it.
RUN mkdir -p /data && chown node:node /data
VOLUME /data

# ID_ORIGIN (the 6j0.org identity server, e.g. https://id.6j0.org) is required. Set ORIGIN (e.g.
# https://glaze.6j0.org) when serving over HTTPS: it turns on Secure cookies. See README.md for the rest.
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data
EXPOSE 3000
USER node
HEALTHCHECK CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
