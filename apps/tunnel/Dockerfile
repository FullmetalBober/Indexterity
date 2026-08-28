# The tunnel service (apps/tunnel, D113): WireGuard peerings terminated in
# userspace — wireguard-go for the protocol, gvisor's netstack for IP and TCP.
# Build context = repo root, like the other three images.
#
# Its own image rather than a stage in the api's, because it is its own
# container: it runs as a SIDECAR in the api's pod, listening on loopback in that
# pod's network namespace. The api image consequently no longer carries the binary
# — nothing there spawns it any more.
#
# It asks for no capability, no /dev/net/tun and no volume. That is the whole
# point of terminating the peering in userspace: this runs under the same
# `drop: ALL` and nonroot the app container does, and the chart needs no
# securityContext of its own for it.
FROM docker.io/library/golang:1.27.0-alpine AS build
WORKDIR /src
COPY apps/tunnel/go.mod apps/tunnel/go.sum ./
RUN --mount=type=cache,target=/root/.cache/go-build \
    --mount=type=cache,target=/go/pkg/mod go mod download
COPY apps/tunnel/ ./
RUN --mount=type=cache,target=/root/.cache/go-build \
    --mount=type=cache,target=/go/pkg/mod \
    CGO_ENABLED=0 go build -trimpath -o /out/indexterity-tunnel .

# scratch, and it holds exactly one file.
#
# CGO off means there is nothing to link against, and this process needs nothing
# else from a filesystem: no CA bundle, because it makes no TLS connection —
# WireGuard carries its own cryptography and the SOCKS5 hop is loopback; no
# /etc/resolv.conf, because names inside a tunnel are resolved by the customer's
# own resolver through gvisor's stack; no tzdata, because it only ever measures
# durations. A process that holds customers' private keys should contain as
# little as it can, and this contains nothing that could be executed.
#
# Verified by building and running it, not assumed: the service comes up and both
# listeners bind.
FROM scratch AS runtime
COPY --from=build /out/indexterity-tunnel /indexterity-tunnel
# By number, because scratch has no /etc/passwd for a name to resolve against.
# 65532 is the nonroot uid the distroless images use, so a chart that pins
# runAsUser for every container does not need a special case here.
USER 65532:65532
EXPOSE 9411
ENTRYPOINT ["/indexterity-tunnel"]
