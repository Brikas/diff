#!/usr/bin/env bash
# One-time, as an admin with sudo, on the remote box: creates the jailed `diff` user and everything around it.
# Same shape as the box's other sandboxed apps (skill remote-devices, docs/sandboxed-app-users.md). Safe to re-run.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
APP=diff
DIR=/srv/apps/$APP

# User with its own group; admins join the group to work in the app folder.
id -u $APP >/dev/null 2>&1 || sudo useradd --create-home --shell /bin/bash --user-group $APP
UID_=$(id -u $APP)
# Admin accounts that work in the app folder, e.g. ADMINS="alice bob" deploy/setup-box.sh
for admin in ${ADMINS:-}; do sudo usermod -aG $APP "$admin"; done
# useradd allocates a free subordinate id range (login.defs SUB_UID_*); rootless Docker needs one.
grep -q "^$APP:" /etc/subuid || { echo "FAIL: no /etc/subuid range for $APP"; exit 1; }

# App folder: group-writable, setgid, closed to others.
sudo mkdir -p $DIR
sudo chown $APP:$APP $DIR
sudo chmod 2770 $DIR

# Resource caps for everything the user runs, including its Docker daemon and container.
DISK=/dev/$(lsblk -no PKNAME "$(findmnt -no SOURCE /)") # the whole disk under /, e.g. /dev/sda
sudo mkdir -p /etc/systemd/system/user-$UID_.slice.d
sudo tee /etc/systemd/system/user-$UID_.slice.d/50-$APP-limits.conf >/dev/null <<EOF
# Caps for everything the \`$APP\` user runs: its shell, its rootless Docker daemon and its container.
# Set by the box owner; the user cannot raise them from inside the slice.
[Slice]
# Memory: reclaim above 640 MiB, kill above 768 MiB, at most 128 MiB in swap.
MemoryHigh=640M
MemoryMax=768M
MemorySwapMax=128M
# CPU: at most one core of time; under contention, half the share of a normal slice.
CPUQuota=100%
CPUWeight=50
TasksMax=512
# Disk: lower priority, and a hard ceiling on speed so a write flood cannot starve the box.
IOWeight=50
IOReadBandwidthMax=$DISK 50M
IOWriteBandwidthMax=$DISK 20M
IOReadIOPSMax=$DISK 1000
IOWriteIOPSMax=$DISK 500
EOF
sudo systemctl daemon-reload

# Storage: the database lives on a fixed-size disk image, so no amount of data can fill the box's disk.
# The app also refuses writes above MAX_DB_BYTES, below this size.
IMG=/srv/apps/$APP-data.img
DATA=$DIR/data
if [ ! -f $IMG ]; then
  sudo fallocate -l "${DATA_SIZE:-3G}" $IMG
  sudo mkfs.ext4 -q -m 0 $IMG
  sudo chmod 600 $IMG
fi
UNIT=$(systemd-escape -p --suffix=mount "$DATA")
sudo mkdir -p $DATA
sudo tee /etc/systemd/system/$UNIT >/dev/null <<EOF
[Unit]
Description=Size-capped data disk for the $APP app
Before=user@$UID_.service

[Mount]
What=$IMG
Where=$DATA
Type=ext4
Options=loop,nodev,nosuid,noexec

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now $UNIT
# The container runs as uid 65532; rootless Docker maps it to the user's subordinate range: start + 65532 - 1.
SUB=$(awk -F: -v u=$APP '$1 == u { print $2 }' /etc/subuid)
sudo chown $((SUB + 65531)):$((SUB + 65531)) $DATA
sudo chmod 700 $DATA

# No outbound network for the user.
sed "s/__UID__/$UID_/" "$here/nftables-$APP.nft" | sudo tee /etc/nftables-$APP.nft >/dev/null
sudo tee /etc/systemd/system/$APP-egress.service >/dev/null <<EOF
[Unit]
Description=Outbound network rules for the $APP user
Before=user@$UID_.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/nft -f /etc/nftables-$APP.nft
ExecStop=/usr/sbin/nft delete table inet ${APP}_egress

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now $APP-egress.service

# Rootless Docker for the user, kept running without a login.
sudo loginctl enable-linger $APP
# `sudo -iu` has no user session, so point the installer at the lingering user manager or it skips systemd.
sudo -iu $APP env XDG_RUNTIME_DIR=/run/user/$UID_ DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$UID_/bus \
  bash -lc 'systemctl --user is-active --quiet docker || dockerd-rootless-setuptool.sh install'
sudo -iu $APP bash -lc "grep -q DOCKER_HOST ~/.bashrc || echo 'export DOCKER_HOST=unix:///run/user/$UID_/docker.sock' >> ~/.bashrc"

# Route, owned by root.
sudo cp "$here/traefik-$APP.yml" /srv/traefik/dynamic/$APP.yml
echo "setup done: user $APP uid $UID_"
