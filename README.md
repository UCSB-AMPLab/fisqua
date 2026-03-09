# Zasqua: Catalogación

Online collaborative cataloguing platform for archival materials, built on Cloudflare Workers. Part of the [Zasqua](https://zasqua.org) open-source archival platform.

## Overview

Zasqua: Catalogación enables students and researchers to segment multi-page archival volumes into discrete items through a web-based interface. Volumes already published on Zasqua — with IIIF manifests and tiled images on R2 — are loaded by URL. Cataloguers scroll through a continuous-page viewer, place boundaries where items begin and end, and build an outline of the volume's structure. Reviewers verify the segmentation before it is approved.

The platform supports both page-level boundaries (item starts at a new page) and within-page boundaries (item starts partway through a page), making it suitable for notarial records, account books, legal case files, and correspondence bundles.

**Key features:**

- Virtualised continuous-scroll viewer with OpenSeadragon tiles and zoom
- Page and within-page boundary placement with click-to-place, drag-to-move, and autosave
- Outline panel with tree structure, metadata editing, and scroll sync
- Assignment workflow with three roles (Lead, Reviewer, Cataloguer)
- Status workflow: unstarted, in progress, segmented, reviewed, approved
- Role-dependent dashboards with progress tracking

## Requirements

- Node.js 18+
- npm
- A [Resend](https://resend.com) API key (for magic link authentication emails)

## Setup

```bash
npm install
```

Create a `.dev.vars` file for local secrets:

```
RESEND_API_KEY=re_your_key_here
```

Set your app identity in `wrangler.jsonc` under `vars`:

```jsonc
"vars": {
  "APP_NAME": "Zasqua: Catalogación",
  "SENDER_EMAIL": "noreply@example.com"
}
```

Initialize the local database and start the dev server:

```bash
npx wrangler d1 migrations apply DB --local
npm run dev
```

## Deployment

```bash
npm run deploy
```

Set secrets for production:

```bash
npx wrangler secret put RESEND_API_KEY
```

Apply migrations to production D1:

```bash
npx wrangler d1 migrations apply DB --remote
```

## Architecture

Built from [zasqua-cloudflare-template](https://github.com/zasqua/zasqua-cloudflare-template), which provides authentication, project management, roles, and member invites on Cloudflare Workers infrastructure (D1, R2, Vite, React Router v7, Drizzle ORM).

The viewer renders IIIF Image API tiles from existing Zasqua volumes on R2 — no image processing or storage is needed. Only visible pages plus a two-page buffer are rendered at any time, enabling smooth scrolling through volumes of 500+ pages.

## Related tools

- [zasqua-frontend](https://github.com/zasqua/zasqua-frontend) — Static public site for Zasqua collections
- [zasqua-transcription](https://github.com/zasqua/zasqua-transcription) — Transcription tool for catalogued items
- [zasqua-cat](https://github.com/zasqua/zasqua-cat) — Translation tool for transcribed items

## License

To be determined.
