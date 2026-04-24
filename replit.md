# SD POS - Professional Point of Sale System

## Project Overview

A comprehensive Point of Sale (POS) system built with vanilla HTML, CSS, JavaScript frontend and a Node.js + Express backend. Features real-time WhatsApp integration, AI chatbot, PDF invoice generation, and employer management.

## Tech Stack

- **Frontend**: Vanilla HTML5, CSS3, JavaScript (ES6+)
- **Backend**: Node.js + Express
- **Data Visualization**: Chart.js (CDN)
- **Storage**: JSON files in `database/` directory (server-side persistence)
- **Icons**: Font Awesome 6.5
- **WhatsApp**: @whiskeysockets/baileys
- **PDF**: pdfkit
- **AI**: @google/generative-ai

## Project Structure

```
/
├── index.html          # Main POS application
├── login.html          # Login page (server-side auth, no self-registration)
├── app.js              # Core frontend application logic
├── server.js           # Express backend (API, WhatsApp bot, PDF generation)
├── chatbot.js          # AI chatbot logic
├── styles.css          # Dark modern theme + responsive styles
├── config.js           # Business config (name, currency, etc.)
├── backup.config.js    # Backup configuration
├── database/
│   ├── products.json   # Product data
│   ├── customers.json  # Customer data
│   ├── invoices.json   # Invoice data
│   ├── expenses.json   # Expense data
│   ├── purchasing.json # Purchase orders
│   ├── users.json      # User accounts (server-side)
│   └── settings.json   # App settings (server-side)
└── README.md
```

## Running the App

- **Workflow**: "Start application" — runs `npm start` (node server.js)
- **Port**: 5000

## Default Credentials

- **Username**: `admin`
- **Password**: `admin123`
- Stored in `database/users.json`

## Authentication

- Server-side auth via `POST /api/auth/login`
- Login stores `pos_logged_in` (username) and `pos_user` (JSON with role/permissions) in sessionStorage
- No self-registration — accounts are managed by admins only

## Employer Management

Admins can manage employee accounts via **Settings → Employers** tab:
- Add, edit, delete user accounts
- Assign roles: `admin`, `manager`, `cashier`, `custom`
- Control which sections each user can access (Products, Billing, Customers, Invoices, Expenses, Purchasing, Analytics, Settings)
- Cannot delete own account or last admin

### Role presets
- **Admin**: Full access to all sections
- **Manager**: Everything except Settings
- **Cashier**: Billing + Invoices only
- **Custom**: Manually select individual sections

## Settings System

Admin-editable via **Settings** page (4 tabs):
- **Business**: Name, tagline, address, phone, email, timezone, currency
- **Invoice**: Header color, footer, watermark, QR code, terms & conditions
- **Receipt**: Header color, footer, note, show/hide tax/discount
- **Store**: Default tax %, low stock threshold, app name, chatbot API URL

Settings saved to `database/settings.json` and synced back to `config.js`.

## AI Chatbot

- **WhatsApp**: Auto-replies to incoming messages
- **Web**: Floating 🤖 widget in the main app
- Rate limiting: Max 10 messages/minute per session
- Toggle via sidebar "AI Bot" button

## Features

### Billing / Point of Sale
- Product search and add to cart
- Per-item discount %, overall discount (% or fixed)
- Tax support, customer autocomplete
- Invoice or Sales Receipt document types
- Print preview

### Products / Customers / Invoices / Expenses / Purchasing
- Full CRUD for all entities
- PDF invoice/receipt generation
- Purchase order history and printing

### Analytics
- Today/Month/Total sales stats, profit, low stock alerts
- Charts: Daily sales, top items, sales by category

## Responsive Design
- Mobile (< 640px): Hamburger sidebar drawer
- Tablet (640–768px): Drawer with overlay
- Desktop (1024px+): Full two-panel layout

## Deployment to External Hosts (Heroku / Render / Railway / VPS)

The app is portable — see `DEPLOY.md` for full instructions.

### Key files
- `Procfile` — Heroku/PaaS start command
- `Dockerfile` — Chromium + Node 20 image (Render, Railway, Fly.io, VPS)
- `render.yaml` — One-click Render Blueprint
- `app.json` — Heroku container deploy spec
- `.dockerignore`, `.gitignore`, `.nvmrc` — supporting config

### Code changes for portability
- `PORT` reads from `process.env.PORT` (`server.js:19`) — required by all PaaS hosts
- `HOST` reads from `process.env.HOST`, defaults to `0.0.0.0`
- Chromium auto-detection looks at `PUPPETEER_EXECUTABLE_PATH`, `GOOGLE_CHROME_BIN`, system `chromium`/`chrome` binaries, then falls back to puppeteer's bundled chrome
- `package.json` has `engines: node >=20` and a postinstall hook that installs Chrome only when no system chromium is configured

### Persistence warning
JSON DB lives in `database/` and WhatsApp session in `auth/`. Free Heroku/Render dynos have ephemeral filesystems → both folders wipe on restart. Use a host with persistent disks (Render Starter+, Railway volumes, Fly volumes, plain VPS) for production.
