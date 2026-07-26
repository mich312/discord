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
# binaryen is pinned and fetched from its own release rather than apt:
# Debian's package predates 116, and versions below that miscompile modules
# from current rustc (table growth breaks at runtime).
ARG BINARYEN_VERSION=119
RUN rustup target add wasm32-unknown-unknown \
    && curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh \
    && curl -fsSL "https://github.com/WebAssembly/binaryen/releases/download/version_${BINARYEN_VERSION}/binaryen-version_${BINARYEN_VERSION}-x86_64-linux.tar.gz" \
       | tar -xz -C /tmp \
    && install -m755 "/tmp/binaryen-version_${BINARYEN_VERSION}/bin/wasm-opt" /usr/local/bin/wasm-opt
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crypto-core crypto-core
COPY relay relay
RUN cargo build --release -p relay
# The same script CI runs, with the same hard failure. Building the wasm two
# different ways here and in CI would make the published integrity manifest
# describe a binary this image never contained.
RUN WASM_REQUIRE_OPT=1 bash crypto-core/build-wasm.sh

# --- stage 2: node — client bundle ------------------------------------------
FROM node:22-bookworm AS client-build
# Stamped into dist/integrity.json so the served manifest names the commit it
# was built from. Unset in a local `docker build` — the field is then omitted
# rather than guessed.
ARG SOURCE_COMMIT=""
ENV SOURCE_COMMIT=$SOURCE_COMMIT
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
    VAPID_KEY_FILE=/data/vapid.key \
    RELAY_PORT=80 \
    RELAY_BIND=0.0.0.0
VOLUME /data
EXPOSE 80
CMD ["relay"]
