FROM node:24-alpine AS wfc-builder
RUN apk add --no-cache build-base bash git glib-dev python3 pkgconf
WORKDIR /build
RUN git init libslirp && git -C libslirp remote add origin https://gitlab.freedesktop.org/slirp/libslirp.git && git -C libslirp fetch --depth 1 origin ce12dcddf710a71dc0de6450ec95edbadf8e9f66 && git -C libslirp checkout --detach FETCH_HEAD
COPY wfc/slirp-gateway.c wfc/slirp-gateway.c
COPY scripts/build-wfc-gateway.sh scripts/build-wfc-gateway.sh
RUN bash scripts/build-wfc-gateway.sh /build/libslirp /build/output

FROM node:24-alpine
RUN apk add --no-cache glib
COPY --from=wfc-builder /build/output/wfc-slirp /usr/local/bin/wfc-slirp
COPY --from=wfc-builder /build/output/libslirp-COPYRIGHT /usr/share/licenses/wfc/libslirp-COPYRIGHT
ENV NETPLAY_WFC_HELPER=/usr/local/bin/wfc-slirp
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
RUN mkdir -p /data/saves && chown -R node:node /data
COPY --chown=node:node *.mjs ./
COPY --chown=node:node admin-ui ./admin-ui
COPY --chown=node:node client/link-core.js ./client/link-core.js
COPY --chown=node:node LICENSE NOTICE ./
USER node
EXPOSE 8080 55435-55442
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
