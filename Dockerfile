# quorum — single-container build: relay (Rust) + client (built to static
# files, served by the relay). One process, one port.
#
#   docker build -t quorum .
#   docker run -p 80:80 -v quorum-data:/data \
#     -e RP_ID=chat.example.org -e RP_ORIGIN=https://chat.example.org \
#     -e VAPID_PRIVATE_KEY=... -e DATABASE_URL=postgres://... quorum
#
# Without DATABASE_URL the relay runs in-memory (fine for trying it out,
# nothing survives a restart). See docker-compose.yml for the full stack.

# --- stage 1: rust — relay binary + crypto core to WASM ---------------------
FROM rust:1.94-bookworm AS rust-build
RUN rustup target add wasm32-unknown-unknown \
    && curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crypto-core crypto-core
COPY relay relay
RUN cargo build --release -p relay
RUN cd crypto-core && wasm-pack build --target web --release

# --- stage 2: node — client bundle ------------------------------------------
FROM node:22-bookworm AS client-build
WORKDIR /src/client
COPY client/package.json client/package-lock.json ./
RUN npm ci
COPY client ./
COPY --from=rust-build /src/crypto-core/pkg /src/crypto-core/pkg
RUN npm run build

# --- stage 3: runtime --------------------------------------------------------
FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libssl3 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=rust-build /src/target/release/relay /usr/local/bin/relay
COPY --from=client-build /src/client/dist /app/public
ENV CLIENT_DIR=/app/public \
    BLOB_DIR=/data/blobs \
    RELAY_PORT=80 \
    RELAY_BIND=0.0.0.0
VOLUME /data
EXPOSE 80
CMD ["relay"]
