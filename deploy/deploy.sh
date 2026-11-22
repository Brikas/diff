#!/usr/bin/env bash
# Build and roll out, as an admin on the remote box, from /srv/apps/diff.
# The image is built by the admin's Docker and handed to the jailed user's rootless Docker, which has no network.
set -euo pipefail
APP=diff
DIR=/srv/apps/$APP
UID_=$(id -u $APP)
cd "$DIR"

docker build -t $APP:latest .
docker save $APP:latest | sudo -iu $APP env DOCKER_HOST=unix:///run/user/$UID_/docker.sock docker load
sudo -iu $APP env DOCKER_HOST=unix:///run/user/$UID_/docker.sock docker compose -f "$DIR/docker-compose.yml" up -d --remove-orphans
sudo -iu $APP env DOCKER_HOST=unix:///run/user/$UID_/docker.sock docker image prune -f >/dev/null
docker image prune -f >/dev/null

# Health: the container itself, then the public route.
source "$DIR/.env"
for i in $(seq 1 30); do
  curl -fsS "http://$PUBLISH_IP:$PUBLISH_PORT/healthz" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "http://$PUBLISH_IP:$PUBLISH_PORT/healthz" >/dev/null || { echo "FAIL: container not healthy"; exit 1; }
curl -fsS "https://diff.brikas.dev/healthz" >/dev/null || { echo "FAIL: public route not answering"; exit 1; }
echo "deployed"
