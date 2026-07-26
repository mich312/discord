# Verifying what you are actually running

quorum's encryption is delivered as web code, which means the operator serves
the software that holds your keys. `docs/THREAT_MODEL.md` §6.2 calls this the
single largest gap in the design, and it is not closed by anything on the
server. The only real answer is that **you can rebuild the source yourself and
check it matches what you were served**.

This page is how to do that. It takes about ten minutes.

It is worth being blunt about what this buys. Doing this once tells you the
deployment matched its source *at that moment*. It does not stop an operator
serving you something else tomorrow, or serving something different to one
person. What it gives you is a check that a targeted build cannot pass — so
tampering has to survive anyone deciding to look.

---

## 1. Ask the deployment what it claims to be

Every build publishes a manifest at `/integrity.json`:

```sh
SITE=https://quorum.example
curl -s "$SITE/integrity.json" | tee served.json
```

```json
{
  "algorithm": "sha384",
  "commit": "36c0b1d28f2c21535b3d8b3f58d5ace44ab1506d",
  "wasm": "/pkg/crypto_core_bg.wasm",
  "files": {
    "/assets/index-CUquekH-.js": "sha384-nZXAM2If…",
    "/pkg/crypto_core_bg.wasm": "sha384-IlBahQkq…",
    "/worker.js": "sha384-Eu+3owvX…"
  }
}
```

## 2. Check the files served match that manifest

```sh
jq -r '.files | to_entries[] | "\(.key) \(.value)"' served.json |
while read -r path want; do
  got="sha384-$(curl -fsS "$SITE$path" | openssl dgst -sha384 -binary | base64)"
  [ "$got" = "$want" ] && echo "ok        $path" || echo "MISMATCH  $path"
done
```

**On its own this proves very little.** An operator who tampered with a file
would regenerate the manifest to match. What it does catch is the accidental
kind of wrong: a half-finished deploy, a stale CDN edge, a cache serving one
file from an older build. Those are real and this is the cheap way to see them.

Step 3 is the one that matters.

## 3. Rebuild the source and compare

```sh
git clone https://github.com/mich312/discord && cd discord
git checkout "$(jq -r .commit ../served.json)"

./crypto-core/build-wasm.sh          # needs rustup + wasm-pack + wasm-opt ≥116
cd client && npm ci && npm run build

diff <(jq -S 'del(.commit)' ../../served.json) \
     <(jq -S 'del(.commit)' dist/integrity.json) && echo "✅ identical"
```

The toolchain is pinned in `rust-toolchain.toml`, so rustup fetches the same
compiler this was built with; binaryen is pinned in the build script and the
Dockerfile. You do not need to match the build machine — see the limits below.

If the diff is empty, the code you were served is the code in that commit.

## 4. Check the crypto core specifically

The worker refuses to start a wasm whose hash it does not recognise, so this is
already enforced at runtime — but you can see the pinned value yourself:

```sh
curl -fsS "$SITE/worker.js" | grep -o "WASM_INTEGRITY = '[^']*'"
jq -r '.files["/pkg/crypto_core_bg.wasm"]' served.json
```

Those two must be equal. If they are not, the served worker and the served
crypto core came from different builds, and the app will refuse to start rather
than run a core it was not built against.

---

## What is established, and what is not

CI proves on **every commit** that an independent rebuild on a different
machine produces byte-identical artifacts — different cargo cache, different
`wasm-pack` install, different `RUSTFLAGS`. That last difference is the useful
one: the build that stamps `--remap-path-prefix` and the build that does not
produce the same bytes, which means **checkout paths are not embedded in the
artifact**. You can therefore build in any directory and still match.

Not established:

- **A different OS, architecture or libc.** Everything so far is
  `ubuntu-latest` x86_64. If you reproduce this on something else — or fail to
  — that is genuinely useful information; please open an issue either way.
- **That anyone is checking routinely.** The mechanism exists; a mechanism
  nobody exercises detects nothing.
- **Anything about the relay binary.** This covers the client — the part that
  holds your keys. The server handles ciphertext it cannot read, so its build
  is a smaller concern, but it is not covered here.
