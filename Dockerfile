FROM golang:1.23-alpine AS build
WORKDIR /src
COPY server/go.mod server/go.sum ./server/
WORKDIR /src/server
RUN go mod download
WORKDIR /src
COPY server ./server
COPY web ./web
WORKDIR /src/server
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags='-s -w' -o /out/linkwatch-server ./cmd/linkwatch-server

FROM alpine:3.21
RUN apk add --no-cache ca-certificates wget
WORKDIR /app
COPY --from=build /out/linkwatch-server /app/linkwatch-server
COPY --from=build /src/web /app/web
ENV LINKWATCH_ADDR=:8080 \
    LINKWATCH_WEB_DIR=/app/web \
    LINKWATCH_ENV=development
EXPOSE 8080
USER 65532:65532
ENTRYPOINT ["/app/linkwatch-server"]
