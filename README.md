# RallyRoom

A browser-based, first-person table tennis game for two players. One player opens a private room and shares the generated URL; the second player joins from any modern browser.

## Features

- Real-time peer-to-peer multiplayer over WebRTC
- Shareable private room links
- Host-authoritative ball physics and first-to-seven scoring
- First-person perspective for both sides of the table
- Pointer, touch, arrow-key, and A/D controls
- Responsive desktop and mobile layout
- No accounts or database required

## Run locally

Requires Node.js 22.13 or newer.

```bash
npm install
npm run dev
```

Open the local URL, select **Create a private room**, and send the invite URL to the second player.

## Build

```bash
npm run build
```

The project is a vinext/React app configured for Cloudflare Workers-compatible output. Multiplayer signaling uses the public PeerJS broker, while game data travels directly between the two browsers.

## Publish from GitHub

Create an empty GitHub repository, then from this folder:

```bash
git remote add origin https://github.com/YOUR_USERNAME/rallyroom.git
git push -u origin main
```

You can then connect the repository to a compatible Cloudflare Workers deployment or keep using OpenAI Sites hosting. The site must be served over HTTPS for reliable WebRTC connectivity.
