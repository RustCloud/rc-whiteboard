# The whiteboard service: the board (frontend/, Excalidraw) built into one
# static binary (service/). A few MB, no shell, runs as nobody.
#
#   docker build -t rc-whiteboard-service .
#   docker run -d --name whiteboard rc-whiteboard-service     # listens on 8080, no port outside needed
#
# The cloud reaches it inside its network (the plugin's setting service_url,
# e.g. http://whiteboard:8080); browsers only through the cloud's address.

FROM node:22-alpine AS frontend
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npx vitest run && npm run build

FROM rust:1-alpine AS service
RUN apk add --no-cache musl-dev
WORKDIR /src
COPY service/Cargo.toml service/Cargo.lock service/
COPY service/src service/src
COPY --from=frontend /src/frontend/dist frontend/dist
RUN cd service && cargo test --release --locked && cargo build --release --locked

FROM scratch
COPY --from=service /src/service/target/release/rc-whiteboard-service /rc-whiteboard-service
ENV LISTEN=0.0.0.0:8080
EXPOSE 8080
USER 65534:65534
HEALTHCHECK --interval=30s --timeout=5s CMD ["/rc-whiteboard-service", "--health"]
ENTRYPOINT ["/rc-whiteboard-service"]
