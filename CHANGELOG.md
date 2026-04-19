# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.3.0] - 2026-04-XX

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
