# Deploying SD POS

This app runs on any Node.js host. The recommended path is a **Docker-based deploy** because PDF invoice generation needs Chromium with system libraries.

## Files included

| File | Purpose |
| --- | --- |
| `Procfile` | Heroku / generic PaaS start command |
| `Dockerfile` | Chromium + Node 20 image (works on Render, Railway, Fly.io, Cloud Run, DigitalOcean) |
| `.dockerignore` | Excludes `node_modules`, Replit configs, etc. from image |
| `.nvmrc` | Pins Node 20 for buildpack hosts |
| `render.yaml` | One-click Render Blueprint |
| `app.json` | Heroku container deploy spec |

---

## Required environment variables

| Variable | Required? | Default | Notes |
| --- | --- | --- | --- |
| `PORT` | Auto-set by host | `5000` | App reads `process.env.PORT` |
| `HOST` | No | `0.0.0.0` | Bind address |
| `PUPPETEER_EXECUTABLE_PATH` | **Yes** for PDF | (auto-detect) | `/usr/bin/chromium` if using the included Dockerfile |
| `PUPPETEER_SKIP_DOWNLOAD` | Recommended | unset | Set to `true` when using system chromium to skip the 200 MB Chrome download |
| `GOOGLE_CHROME_BIN` | Heroku alt | unset | Heroku Chrome buildpack sets this |

> The **Mistral / NVIDIA NIM API key** for the smart sales assistant is stored in `database/settings.json` (admin Settings → Smart Sales Assistant). It is not an env var.

---

## Persistence ⚠️ READ THIS

The app stores all data as **JSON files in `database/`** and the WhatsApp session in **`auth/`**. Free tiers of Heroku and Render use an **ephemeral filesystem** — every restart wipes both folders, meaning:

- All products, customers, invoices reset
- WhatsApp logs out and you need to re-pair

**Solutions:**
- **Render:** Upgrade to a plan with persistent disks and use the included `render.yaml` (mounts `/app/data`).
- **Railway:** Attach a Volume mounted at `/app/database` and `/app/auth`.
- **Fly.io:** Use Fly Volumes (`fly volumes create`).
- **Heroku:** Not recommended for production (no persistent disk on dynos). Use only for testing.
- **DIY VPS (DigitalOcean droplet, Hetzner, etc.):** Easiest — the filesystem is permanent. Just `git clone`, `npm install`, `npm start` behind a reverse proxy.

---

## Platform-specific quick start

### 🚂 Railway

1. Push this repo to GitHub.
2. **New Project → Deploy from GitHub Repo** → select your repo.
3. Railway auto-detects the Dockerfile and builds.
4. **Settings → Variables** → add `PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium` and `PUPPETEER_SKIP_DOWNLOAD=true`.
5. **Settings → Networking → Generate Domain.**
6. (Recommended) **Settings → Volumes → New Volume**, mount path: `/app/database`. Repeat for `/app/auth`.

### 🎨 Render

1. Push this repo to GitHub.
2. **New → Blueprint** → point at your repo. Render reads `render.yaml`.
3. Pick the **Starter** plan (Free has no disks → data lost on restart).
4. Deploy.

### 🟪 Heroku (with Docker)

```bash
heroku create sd-pos-yourname
heroku stack:set container
heroku config:set PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium PUPPETEER_SKIP_DOWNLOAD=true
git push heroku main
```

> Heroku has no persistent disk. Use a daily backup to S3/GitHub or migrate to PostgreSQL for real production use.

### 🐳 Plain Docker (any VPS)

```bash
docker build -t sd-pos .
docker run -d \
  --name sd-pos \
  -p 80:5000 \
  -v $PWD/database:/app/database \
  -v $PWD/auth:/app/auth \
  --restart unless-stopped \
  sd-pos
```

### 🪶 Fly.io

```bash
fly launch          # picks up the Dockerfile
fly volumes create sd_pos_data --size 1
# In fly.toml add: [mounts] source="sd_pos_data" destination="/app"
fly deploy
```

---

## After first deploy

1. Open the URL → log in with default `admin` / `admin` (then change it in Settings → Users).
2. **Settings → WhatsApp** → scan the QR code or use pairing code.
3. **Settings → Smart Sales Assistant** → paste your NVIDIA NIM / Mistral API key.
4. Add products, customers, and start selling.
