# Fisqua

Collaborative cataloguing and data-management platform for archival materials, built on Cloudflare Workers. Part of the same open-source ecosystem of tools as [Zasqua](https://zasqua.org) and [Telar](https://telar.org).

The name pairs with Zasqua ("to settle," "to remain in a given place"). Fisqua — "to gather up things that are scattered" — names what must happen first: bringing together the volumes, the people, the places, and the links between them.

Previously released as `zasqua-catalogacion`, the project was renamed to **Fisqua** in v0.3.0.

## Overview

Fisqua brings together two streams of work that originally lived in separate projects:

- **Collaborative cataloguing.** Students and researchers segment multi-page archival volumes into discrete items through a web-based interface. Volumes already published on Zasqua — with IIIF manifests and tiled images on R2 — load by URL. Cataloguers scroll through a continuous-page viewer, place boundaries where items begin and end, build an outline of the volume's structure, and describe each item in ISAD(G). Reviewers verify the segmentation and descriptions before approval.
- **Prosopography and linked entities.** Canonical records for the people, institutions, and places named across the archive. Descriptions link to these authority records, and the records themselves are editable with merge / split / draft-review workflows. A full-text search (SQLite FTS5) backs the explorer surfaces.

The platform supports both page-level boundaries (item starts at a new page) and within-page boundaries (item starts partway through a page), making it suitable for notarial records, account books, legal case files, and correspondence bundles.

**Key features:**

- Virtualised continuous-scroll IIIF viewer with OpenSeadragon tiles and zoom
- Page and within-page boundary placement with click-to-place, drag-to-move, and autosave
- Outline panel with tree structure, ISAD(G) metadata editing, QC flags, and region-anchored comments
- Assignment workflow with three roles (Lead, Reviewer, Cataloguer) and status progression
- Entity, place, and repository administration with linked-descriptions cards
- Vocabularies hub with draft / review / approve flow for controlled terms
- Publish pipeline that exports fonds-level JSON, METS, and manifests to R2 through a durable Cloudflare Workflow
- Role-dependent dashboards with progress tracking
- Bilingual interface (English / Spanish)

## Requirements

- Node.js 18+
- npm
- A [Resend](https://resend.com) API key (for magic-link authentication emails)

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
  "APP_NAME": "Fisqua",
  "SENDER_EMAIL": "noreply@example.com"
}
```

Initialise the local database and start the dev server:

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

Built on Cloudflare Workers with D1 (SQLite) for data, R2 for blob storage, Drizzle ORM for typed queries, React Router v7 for SSR, and Vite for the build. Styling is Tailwind; validation is Zod; testing is Vitest. The publish pipeline runs as a Cloudflare Workflow so each step gets a fresh runtime budget.

The viewer renders IIIF Image API tiles from existing Zasqua volumes on R2 — no image processing or storage is needed inside Fisqua. Only visible pages plus a two-page buffer are rendered at any time, enabling smooth scrolling through volumes of 500+ pages.

## Related tools

- [zasqua-frontend](https://github.com/neogranadina/zasqua-frontend) — Static public site for Zasqua collections
- [zasqua-transcription](https://github.com/neogranadina/zasqua-transcription) — Transcription tool for catalogued items

## License

To be determined.
