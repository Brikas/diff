# diff

- Lives on the remote box in `/srv/apps/diff`, owned by the jailed user `diff`.
  - Rootless Docker, slice caps, no outbound network: `deploy/setup-box.sh`.
  - Route: `/srv/traefik/dynamic/diff.yml`, copied from `deploy/traefik-diff.yml`. Access log off: URLs are secrets.
- Change code, then on the box: `deploy/deploy.sh`. It builds, loads the image into the jailed Docker and health-checks the public URL.
- Logs: `sudo -iu diff docker logs diff`. Data: the `diff_data` volume in that user's Docker.
- Tests: `npm test` before every deploy.

## Upstream Intent
- Node base images and npm packages: keep current within the same major; bump majors deliberately.
