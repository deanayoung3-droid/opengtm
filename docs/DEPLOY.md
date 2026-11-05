# Deploying

OpenGTM is one container plus Postgres. Anything that runs Docker can run it. It needs to be on all the
time (it reads replies every few minutes and sends during business hours), so a small server is better
than a laptop.

## A small server (recommended)

Any VPS with 1 GB of RAM and Docker works (Hetzner, DigitalOcean, Linode, Vultr: about $6-12 a month).
On a fresh Ubuntu server:

```bash
# 1. Docker
curl -fsSL https://get.docker.com | sh

# 2. Node 22 (only the setup script needs it)
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs

# 3. The app
git clone https://github.com/deanayoung3-droid/opengtm.git && cd opengtm
node scripts/setup.mjs
docker compose up -d
```

No Node on the server? Run `node scripts/setup.mjs` on your own computer and copy `.env` and
`config/business.yaml` to the server (they hold secrets: use `scp`, never email or chat).

### HTTPS

Put the dashboard on its own subdomain so people's unsubscribe links work with one click and you can
reach it from anywhere:

1. Create a DNS **A record** for, say, `gtm.yourcompany.com` pointing at the server's IP address.
2. Open ports 80 and 443 in the server's firewall.
3. In `.env`: `GTM_DOMAIN=gtm.yourcompany.com` and `PUBLIC_BASE_URL=https://gtm.yourcompany.com`.
4. `docker compose --profile https up -d`

Caddy gets and renews a free certificate by itself. Then close port 8080 to the outside (only Caddy needs
it), for example with `APP_PORT=127.0.0.1:8080` in `.env`.

Already have a reverse proxy (nginx, Traefik, your platform's)? Point it at port 8080 and skip the
`https` profile. The unsubscribe pages (`/u/...`) and health checks (`/healthz`, `/api/health`) must stay
reachable without a login; everything else asks for the dashboard password.

## Hosting platforms

On a platform that builds a Dockerfile (Railway, Render, Fly.io, Coolify, Dokku...):

- Build from the repo's `Dockerfile`. It listens on port **8080** and answers `GET /healthz` without login.
- Add a Postgres 16 database and set `DATABASE_URL`.
- Copy the variables from your `.env` into the platform's settings.
- `config/business.yaml` isn't in git: either use the dashboard's Project docs instead (stored in the
  database), or commit it to your own private fork.

Migrations run by themselves when the container starts.

## Backups

```bash
docker compose --profile backup up -d
```

Writes a database dump to `./backups` every night (kept 14 days, `BACKUP_KEEP_DAYS`). For copies off the
server, put an [rclone](https://rclone.org) config in `./secrets/rclone.conf` and set `RCLONE_REMOTE`
(for example `b2:my-gtm-backups`). Check that the latest backup restores, once in a while:

```bash
docker compose exec backup restore-check.sh
```

To restore for real: stop the app (`docker compose stop app`), then
`docker compose exec backup sh -c 'pg_restore --clean --no-owner -d gtm /backups/gtm-<date>.dump'`,
then `docker compose start app`.

## Updating

```bash
git pull
docker compose up -d --build
```

Database migrations run on start. Read the release notes first: a new prompt version rewrites unsent
follow-ups, and config options can change.

## Health and logs

- `docker compose logs -f app`: what the worker and dashboard are doing (JSON lines, secrets redacted).
- `GET /healthz`: the container is up. `GET /api/health`: the dashboard can reach the database.
- The **Schedule** page shows every job's last and next run; a job that keeps failing sends you an alert.

## Running without Docker

```bash
pnpm install
pnpm web:build && pnpm bundle
DATABASE_URL=postgres://... node dist/start.mjs     # migrations, dashboard on $PORT (8080), and the worker
```

You'll need your own Postgres 16 and a process manager (systemd, pm2) to keep it running.
