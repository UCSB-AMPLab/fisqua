# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
