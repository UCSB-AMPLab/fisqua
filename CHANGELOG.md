# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **License.** Fisqua is now licensed under the [GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0). The `LICENSE` file ships in the repository root; the README licence section is updated to match. AGPL closes the SaaS loophole that GPL leaves open: anyone running a modified Fisqua as a network service for third parties must publish their modifications under the same license, while self-deploying partners have no additional obligation.
- **Citation file.** The repo now ships a `CITATION.cff` file with author and project metadata, enabling GitHub's "Cite this repository" button. Authors are Juan Cobo Betancourt, with AMPL and Neogranadina credited as institutional contributors.
- **Trademark notice.** README clarifies that AGPL covers the code, not the names "Fisqua", "Zasqua", or "AMPL".
- **Author and license metadata in `package.json`.** `license`, `author`, and `contributors` fields populated to reflect the new licence and authorship.

## [0.3.2] - 2026-04-29

### Changed

- **Fisqua design-system foundations.** The visual identity inherited from the Zasqua era — DM Sans + Crimson Text + Cormorant Garamond on burgundy with cut-pomegranate imagery — is fully retired. Fisqua now uses **Spectral** (display + body prose), **Bricolage Grotesque** (UI chrome), and **JetBrains Mono** (reference codes), set on a three-colour pre-industrial dye palette: **indigo** ink (`#1F2E4D`) for body text and primary buttons, **verdigris** (`#3E7A6E`) for the brand mark and the wordmark, **madder** (`#B5533D`) for reviewer actions and destructive buttons. Saffron, sage, and a parchment off-white round out the status palette; Tailwind's `stone` ramp carries every neutral. Colour and type tokens live in `app/app.css` under a Tailwind v4 `@theme` block; every utility class in the app resolves against them.
- **Header and sidebar aligned to the design system.** The wordmark renders in verdigris Spectral, the active nav rail is indigo, group headings are eyebrow-style (uppercase, tracked wide, stone-400).
- **Brand assets.** The pomegranate-tree mark and the Neogranadina wordmark ship as clean SVG sources at `public/brand/`; the favicon, apple-touch icon, and OG image are regenerated from the new mark.
- **Buttons across the app.** Primary buttons now darken on hover (default `bg-indigo`, hover `bg-indigo-deep`) instead of the inverted state where the default was the deeper shade. Destructive buttons use `bg-madder` darkening to `bg-madder-deep`. White text on saturated brand surfaces switched to parchment (`#F4EFE6`), per the design system's hard-ban list — pure white on a saturated brand colour reads cheap. Button radius is rounded-md (6px) per spec.
- **Project-role chips.** Lead, cataloguer, and reviewer chips on the user admin pages now match the design-system colour table: lead and cataloguer share the verdigris pair (brand / approved); reviewer uses the madder pair (sent-back / review). Previously the chips were scrambled across saffron, indigo, and verdigris, so the reviewer chip read as "approved" and the lead chip read as "warning". The chip palette now matches the IIIF viewer's boundary markers.
- Footer redesigned. The version link and partner logos no longer sit inside a bordered strip that reserves a row of vertical space; they're pinned to the bottom-left and bottom-right of the content area as floating attribution. Page content scrolls underneath, and the gap between the two clusters is click-through so it doesn't intercept interactions.
- Viewer per-page chrome. The page label and flag button now sit together in a left-hand gutter aligned to the page image, instead of floating in separate corners; the flag button is sized to read as a control rather than a status pip. The page image is left-aligned so the label and flag track it on every viewport.
- UI strings move to sentence case across English and Spanish locales.
- TypeScript types tightened across server, schema, and tests: drizzle role/enum columns narrowed at insert/update sites, `users.lastActiveAt` and `projects.archivedAt` exposed, comment + qc-flag events added to the `ActivityEvent` union, `ProvidedEnv` declared, fixtures topped up. `scripts/` and `tests/` are now part of the typecheck graph.

### Fixed

- Volume viewer and description editor cropped the footer below the fold. The two work surfaces declared their own `h-screen` layouts, but the chrome's content slot had `p-6` padding plus `overflow-y-auto`, so the inner `100vh` block ended up taller than the available chrome content area and pushed the footer past the bottom of the window. Switched both pages to `h-full` and gave the chrome a focused-surface mode that drops the padding and the page-level scroll, fits the work area between header and footer, and forces the left-hand sidebar into its narrow (collapsed) configuration to maximise working space.
- Outline panel scroll lock. The right-hand outline in the volume viewer would snap back within a frame of any user scroll, leaving the panel effectively unusable on volumes with more rows than fit in view. Two compounding mistakes drove an infinite resize cascade: a `useEffect` in `OutlineEntry` re-fired every render because its dependency was an inline closure (`() => virtualizer.measure()`) with fresh identity per render, calling the cache-invalidating `measure()` continuously; and the inline row-wrapper ref also had per-render identity, re-arming the `ResizeObserver` pathway. Stabilised the row-wrapper ref via `useCallback` and removed every `virtualizer.measure()`/`onHeightChange` call site — `measureElement` already installs a `ResizeObserver` that picks up genuine height changes (expand/collapse, reseg flag mounting) without manual prodding.
- Description Miller-column ancestor row. The breadcrumb row showing the path from the root to the selected description rendered with a half-opacity burgundy fill that survived the rebrand. Now indigo at 50% opacity, with parchment text — the Fisqua palette's stand-in for "selected, but not focal".
- Destructive-button hover. The "Send back for revision" dialog confirm, the vocabularies inline-reject submit, and the volume-approve button each ended up with identical default and hover background colours after the red-and-green palette sweep, so hovering produced no visible feedback. Default state corrected to the lighter brand tier; hover continues to darken to the deep tier.
- Region-pin draft and final fills. The pin overlay used Tailwind's amber-500 for drafts and a stranded burgundy `rgba(139, 41, 66, …)` for finals, whose adjacent comment falsely claimed `#1F2E4D`. The fills now use saffron at 20% (draft) and indigo at 20% (final), matching the intent of the original code without the colour drift.
- Cloudflare cutover regressions. The `generateProjectId` helper, the `ActivityEvent` type export, and the lead-membership wiring inside `createProject` were all dropped during the v0.3.0 sync; admin user creation and activity-feed type-checking restored.
- Repositories edit page typo. Two single-line comments had been concatenated with the const decls that should have followed them, so `getConflictDraft` and the autosave `draftFetcher` were both commented out and the edit page wouldn't type-check (and would 500 at runtime as soon as the loader ran). The new-repository form's `rightsText` field now flows through the create schema, so its errors surface like the rest of the fields and edits persist.
- Removed a stale `_auth.admin.projects.tsx` route that lingered in the public repo after the v0.3.0 IA restructure moved it under `/admin/cataloguing/projects`.

### Removed

- **DM Sans, Crimson Text, Cormorant Garamond** are no longer loaded — the three Google-Fonts families that backed the Zasqua-era visual identity are gone from the head, and every inline `font-['…']` class is rewritten onto Tailwind aliases (`font-sans`, `font-serif`, `font-display`, `font-mono`).

## [0.3.1] - 2026-04-24

### Changed

- **Cloudflare rename.** The Worker, D1 database, and R2 bucket are renamed from `zasqua-catalogacion` to `fisqua` to match the repository name. The primary domain moves from `catalogacion.zasqua.org` to **fisqua.org**; old URLs 301-redirect automatically, so IIIF manifests, bookmarks, and external citations continue to work. The v0.3.0 release note that "service and database names stay the same for continuity" is superseded by this work.
- **Repository home.** The canonical repository moves from `neogranadina/zasqua-catalogacion` to **`UCSB-AMPLab/fisqua`**. GitHub automatically redirects the old URL, so existing clones, issue links, and PR references continue to resolve.
- **GitHub OAuth User-Agent.** The User-Agent header sent on GitHub OAuth callbacks renamed from `Zasqua` to `Fisqua`, so server-side audit logs read coherently with the user-facing brand.

## [0.3.0] - 2026-04-19

### Renamed to Fisqua

The platform is now **Fisqua** — a Muisca verb meaning "to gather up things that are scattered." The name pairs with Zasqua ("to settle"): where Zasqua places documentary collections in a stable home, Fisqua gathers the volumes, people, places, and links that run through them. The repository, package name, and user-facing brand all move from `zasqua-catalogacion` to `fisqua` in this release; the underlying service and database names stay the same for continuity.

### Added

- **Publish pipeline foundation.** Scaffolding for the eventual migration of Zasqua's source of truth into Fisqua: a superadmin-only dashboard that drives a durable export run, a pre-flight summary of what would change, live progress tracking, and a per-run history. Each run is wired to export archival descriptions, repositories, people, and places — along with METS metadata for digitised items — to R2. The pipeline is not yet cutting over the public Zasqua site; that happens in a later milestone.
- **Item-level description.** Once a volume is segmented, each item can be described in detail following the ISAD(G) standard. The form runs alongside a tree view of the volume's hierarchy and a column explorer for moving around deep collections. Inline edits, drag-to-reorder, and cross-branch moves all work without leaving the page.
- **Find-as-you-type search.** A fast search sits behind the descriptions, people, and places explorers. It matches even when the user leaves off accents, so "Bogota" finds "Bogotá".
- **People and places admin.** Search a canonical list of people and places, merge duplicates, split mistakes, and see every archival description linked to each one. Links show up on both sides, so opening a person also shows every document they appear in.
- **Repository admin.** Edit how each archival institution appears on the public site — name, city, short description, display order — with a drafts workflow so changes can be reviewed before they go live.
- **Controlled vocabularies.** A hub for the enums, functions, and other controlled terms that descriptions link to. New terms start as drafts, go through review, and then become canonical; merging and splitting terms is handled without losing existing links.
- **Crowdsourcing promotion.** Reviewed entries from a crowdsourcing volume can be promoted into long-lived archival descriptions in a batch. The operator picks the volume, reviews each candidate, sets the reference-code pattern, and commits.
- **Quality-control flags.** Anyone working on a volume can raise a flag on a page to surface a problem — wrong orientation, missing images, a mis-segmented entry. Flags appear on the viewer, in the outline, and on the volume management page. Project leads resolve them with a note.
- **Comments on pages and regions.** Cataloguers and reviewers can leave comments on a specific page, on a rectangular region of a page, or on an outline entry. Replies thread below, and resolved threads can be reopened. Comments show up as chips in the outline for context.
- **Resegmentation requests.** A reviewer who thinks an entry was segmented incorrectly can flag it for resegmentation with a reason. The lead sees the request inline in the outline and can accept or reject.
- **New navigation.** A sidebar replaces the old single-page admin. Projects, volumes, members, and settings now each have their own page; the top-level member dashboard groups work across every project the user belongs to.
- **Role-specific dashboards.** Leads, reviewers, and cataloguers each see the work that concerns them — what is assigned, what is ready for review, what is blocked — with headline stats and announcement banners at the top.
- **Bilingual coverage.** Every new surface — publish, vocabularies, quality-control flags, crowdsourcing, repositories, people, places, settings — works in both English and Colombian Spanish.
- **Bulk import.** A command-line tool for migrating existing archival data into Fisqua, with dry-run validation and resumable runs.
- **Finer-grained permissions.** Five role flags — superadmin, collaboration admin, archive user, user manager, cataloguer — replace the single admin / non-admin split. A user who does not hold any role lands on a no-access page instead of seeing an empty app.

### Changed

- The old single-page admin is gone; every admin surface lives under the sidebar.
- The viewer now shows quality-control flag badges per page, region pins for commented areas, and a three-zone toolbar.
- Volume management is split into a project-wide list and a per-volume deep page, with the open-flag count visible at a glance.
- Footer, login, and header now read "Fisqua".

### Fixed

- The GitHub sign-in routes no longer crash when the secret is missing — they show a clear message instead.

## [0.1] - 2026-03-09

First release of the collaborative cataloguing platform. Delivers a complete volume segmentation workflow — from importing IIIF volumes through boundary editing to reviewer approval.

### Added

- Volume management: add volumes by IIIF manifest URL, list with status, delete
- IIIF manifest parser extracting page images, dimensions, and canvas labels
- Virtualised continuous-scroll viewer using OpenSeadragon with zoom controls and page labels
- Page boundary placement with click-to-place between pages
- Within-page boundary placement with y-position markers for notarial records and account books
- Drag-to-move for all boundary types with ghost line preview and auto-scroll
- Boundary delete with visual popover confirmation
- Outline panel showing volume structure as a tree with sequence numbers, page ranges, and provisional titles
- Expandable outline entries with metadata editing (type, title, reference code)
- Entry nesting with indent/outdent and automatic reference code generation
- Bidirectional scroll sync between outline and viewer (y-position aware)
- Autosave with 1.5-second debounce, retry logic, and visible save status indicator
- Undo/redo with keyboard shortcuts (Cmd+Z, Cmd+Shift+Z)
- Resizable split panel layout (viewer + outline) with pointer-capture divider
- Three roles: Lead, Reviewer, Cataloguer (renamed from template defaults)
- Volume assignment to cataloguers and reviewers (individual and bulk)
- Status workflow: unstarted, in progress, segmented, reviewed, approved
- Reviewer editing experience with red markers for reviewer-modified entries
- Reviewer actions: approve, send back with comment, edit directly
- Cataloguer accept-corrections flow clearing reviewer modifications
- Role-dependent dashboards (cataloguer, reviewer, lead views)
- User activity page with timeline and volume progress tabs
- Project progress overview with stacked status bar
- Activity logging for workflow events
