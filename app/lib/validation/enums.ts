/**
 * Shared Enum Arrays
 *
 * This module deals with the single source of truth for the
 * controlled-vocabulary arrays used by the Drizzle schema, the Zod
 * validation schemas, and the vocabularies admin surfaces. Several of
 * the description-side vocabularies still mirror the legacy Django
 * backend (`catalog/models.py`) exactly so a payload that validates
 * here validates there too; the workflow-side enums (entry types,
 * project roles, QC vocabularies) are Fisqua-native.
 *
 * The contract is simple: every enum here is consumed in three places
 * — the Drizzle column hint (`enum: [...CONST]`), the Zod validator
 * (`z.enum(CONST)` or `(CONST as readonly string[]).includes(x)`), and
 * the derived TypeScript type (`(typeof CONST)[number]`). Adding a
 * value here therefore propagates everywhere, which is the whole point:
 * it removes the hand-copied literal lists that previously let a value
 * be settable in the UI and valid in the DB yet rejected by a stale
 * validator (the `test_images` autosave hang). `tests/db/enum-drift.test.ts`
 * pins each schema column's enum against the constant it must equal.
 *
 * @version v0.8.0
 */

// Description levels
export const DESCRIPTION_LEVELS = [
  "fonds", "subfonds", "series", "subseries",
  "file", "item", "collection", "section", "volume",
] as const;

// Resource types
export const RESOURCE_TYPES = [
  "text", "still_image", "cartographic", "mixed",
] as const;

// Entity types
export const ENTITY_TYPES = ["person", "family", "corporate"] as const;

// EntityFunction certainty levels (from EntityFunction.Certainty)
export const CERTAINTY_LEVELS = ["certain", "probable", "possible"] as const;

// Place types
export const PLACE_TYPES = [
  "country", "region", "department", "province", "partido",
  "city", "town", "parish", "hacienda", "mine", "river", "other",
] as const;

// Entity roles in descriptions
export const ENTITY_ROLES = [
  "creator", "author", "editor", "publisher",
  "sender", "recipient",
  "mentioned", "subject",
  "scribe", "witness", "notary",
  "photographer", "artist",
  "plaintiff", "defendant", "petitioner", "judge", "appellant",
  "apoderado",
  "official",
  "heir", "albacea", "spouse", "victim",
  "grantor", "donor", "seller", "buyer",
  "mortgagor", "mortgagee", "creditor", "debtor", "fiador",
] as const;

export type EntityRole = (typeof ENTITY_ROLES)[number];

// Place roles in descriptions
export const PLACE_ROLES = [
  "created", "subject", "mentioned",
  "sent_from", "sent_to", "published", "venue",
] as const;

export type PlaceRole = (typeof PLACE_ROLES)[number];

// Entity-role grouping for grouped pickers (optgroups). The seven groups
// and their membership are the canonical zasqua-backend structure
// (`catalog/models.py` `DescriptionEntity.Role`, 7 comment-delimited
// groups). The contract this constant must hold: the union of every
// group's `roles` equals ENTITY_ROLES exactly — same members, no
// duplicates, nothing extra. `satisfies …EntityRole[]` enforces at
// compile time that no group can name a value absent from ENTITY_ROLES;
// `tests/lib/role-vocabulary.test.ts` enforces the reverse (every
// ENTITY_ROLES member sits in exactly one group) so adding an enum value
// without grouping it fails loudly. The picker renders groups in this
// order; ENTITY_ROLES keeps its own (schema-pinned) order untouched.
// Group-label i18n keys are `role_group_<key>`; role-label keys are
// `role_<value>` — both live in the locale namespaces the pickers use.
export const ENTITY_ROLE_GROUPS = [
  {
    key: "production",
    roles: ["creator", "author", "editor", "publisher", "mentioned", "subject", "official"],
  },
  {
    key: "correspondence",
    roles: ["sender", "recipient"],
  },
  {
    key: "notarial",
    roles: ["scribe", "witness", "notary"],
  },
  {
    key: "legal",
    roles: ["plaintiff", "defendant", "petitioner", "judge", "appellant", "fiador", "apoderado", "victim"],
  },
  {
    key: "family",
    roles: ["heir", "albacea", "spouse"],
  },
  {
    key: "transactions",
    roles: ["grantor", "donor", "seller", "buyer", "mortgagor", "mortgagee", "creditor", "debtor"],
  },
  {
    key: "visual",
    roles: ["photographer", "artist"],
  },
] as const satisfies readonly { key: string; roles: readonly EntityRole[] }[];

// Vocabulary term statuses
export const VOCABULARY_STATUSES = ["approved", "proposed", "deprecated"] as const;

// Function categories for vocabulary terms
export const FUNCTION_CATEGORIES = [
  "civil_office", "military_rank", "ecclesiastical_office", "academic_degree",
  "honorific", "occupation_trade", "documentary_role", "kinship",
  "status_condition", "institutional_ref",
] as const;

// --- Workflow-side enums (Fisqua-native, not Django-mirrored) ---

// Segmentation entry types. `null` (unset) is allowed at the column and
// validator level and is NOT a member here — it is the "no type chosen
// yet" state, distinct from the closed set of chosen types.
export const ENTRY_TYPES = [
  "item", "blank", "front_matter", "back_matter", "test_images",
] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];

// Editor-side (Spanish) resource types used by the entries table and the
// description editor. Distinct from the English `RESOURCE_TYPES` above,
// which is the published/Dublin-Core vocabulary; `lib/promote/types.ts`
// bridges the two (e.g. `texto` -> `text`). Do not conflate them.
export const RESOURCE_TYPES_ES = [
  "texto", "imagen", "cartografico", "mixto",
] as const;
export type ResourceTypeEs = (typeof RESOURCE_TYPES_ES)[number];

// Project membership roles. Used both as a closed validation set ("is
// this a real role") and as the allow-list for member-only mutation
// endpoints. Adding a role here grants it access to every endpoint that
// guards on the full set — intended, but worth knowing.
export const PROJECT_ROLES = ["lead", "cataloguer", "reviewer"] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];

// The roles a comment can snapshot at post time: project roles on volume
// surfaces, plus "admin" on decision threads (the tenant role the
// decisions surface runs under). A snapshot vocabulary, not a grant —
// widening PROJECT_ROLES widens this automatically.
export const COMMENT_AUTHOR_ROLES = [...PROJECT_ROLES, "admin"] as const;
export type CommentAuthorRole = (typeof COMMENT_AUTHOR_ROLES)[number];

// Volume segmentation-lifecycle statuses. The allowed transitions
// between them live in `app/lib/workflow.ts` (a state machine, not a
// flat set); this is just the closed set of valid status values shared
// by the schema column and the `VolumeStatus` type.
export const VOLUME_STATUSES = [
  "unstarted", "in_progress", "segmented", "sent_back", "reviewed", "approved",
] as const;
export type VolumeStatus = (typeof VOLUME_STATUSES)[number];

// Tenant descriptive standards.
export const DESCRIPTIVE_STANDARDS = ["isadg", "dacs", "rad"] as const;

// QC flag problem types and resolution actions (page-level quality
// control). Mirrored by the `qcFlags` table columns.
export const QC_PROBLEM_TYPES = [
  "damaged", "repeated", "out_of_order", "missing", "blank", "other",
] as const;
export const QC_RESOLUTION_ACTIONS = [
  "retake_requested", "reordered", "marked_duplicate", "ignored", "other",
] as const;

// GeoNames feature classes (fixed external vocabulary).
export const GEONAMES_FCLASSES = ["P", "H", "A", "T", "S"] as const;

// Coordinate-precision vocabulary for `places.coordinate_precision`
// (migration 0060). NULL/absent = not recorded; it is NOT a member here.
// `uncertain` also drives the derived "to review" coordinate status on
// the combined places surface. The `places.coordinate_precision` column
// carries no Drizzle `enum:` hint — legacy rows may still hold
// out-of-vocabulary values — so this constant is enforced only at the
// Zod boundary, not by enum-drift.
export const COORDINATE_PRECISIONS = [
  "exact", "approximate", "centroid", "uncertain",
] as const;
export type CoordinatePrecision = (typeof COORDINATE_PRECISIONS)[number];

// ---------------------------------------------------------------------------
// Media pipeline
// ---------------------------------------------------------------------------
//
// The vocabularies of the media pipeline: the run spec Fisqua writes for
// the runner, the callbacks the runner posts back, and the ledger tables
// that record runs, volumes and review. The runner reads and writes the
// same values, so a change here is a change to that contract too.

// What a run produces: tiles, OCR and a held manifest for whole volumes,
// or a PDF rendered per item.
export const PIPELINE_RUN_KINDS = ["volume_run", "item_pdf"] as const;
export type PipelineRunKind = (typeof PIPELINE_RUN_KINDS)[number];

// The run Fisqua starts by itself when it registers a capture delivery:
// it tiles the delivery's previews as captured for capture QC. Nobody
// starts one from the run form, so it is kept apart from the kinds
// above, which the start-run request takes.
export const PIPELINE_REVIEW_RUN_KINDS = ["review_run"] as const;
export type PipelineReviewRunKind = (typeof PIPELINE_REVIEW_RUN_KINDS)[number];

// Every kind the run ledger records.
export const PIPELINE_LEDGER_RUN_KINDS = [...PIPELINE_RUN_KINDS, ...PIPELINE_REVIEW_RUN_KINDS] as const;
export type PipelineLedgerRunKind = (typeof PIPELINE_LEDGER_RUN_KINDS)[number];

// A sample run tries a recipe on a few volumes; a wave runs it at scale
// and needs a gate pass for every volume's recipe.
export const PIPELINE_RUN_PURPOSES = ["sample", "wave"] as const;
export type PipelineRunPurpose = (typeof PIPELINE_RUN_PURPOSES)[number];

// Run status records what happened. Whether a run still accepts
// requests is decided by its token revocation time, not by this list.
export const PIPELINE_RUN_STATUSES = [
  "pending", "dispatched", "running", "completed", "halted", "error", "cancelled",
] as const;
export type PipelineRunStatus = (typeof PIPELINE_RUN_STATUSES)[number];

// The statuses a callback may move forward (to running, halted or
// completed).
export const PIPELINE_ACTIVE_RUN_STATUSES = ["pending", "dispatched", "running"] as const;

// One row per dispatch chunk. `failed` means the request ended in a
// server error, a timeout or a network error, so the chunk may have
// started; `not_sent` means GitHub refused it or it was never attempted.
export const PIPELINE_RUN_CHUNK_STATUSES = [
  "pending", "dispatched", "failed", "not_sent", "completed",
] as const;
export type PipelineRunChunkStatus = (typeof PIPELINE_RUN_CHUNK_STATUSES)[number];

// A volume's place in the pipeline, from registration to publication.
export const PIPELINE_VOLUME_STATES = ["received", "prepared", "ready", "published"] as const;
export type PipelineVolumeState = (typeof PIPELINE_VOLUME_STATES)[number];

// A volume's outcome within one run.
export const PIPELINE_RUN_VOLUME_STATUSES = [
  "dispatched", "prepared", "review_pending", "aborted", "halted",
] as const;
export type PipelineRunVolumeStatus = (typeof PIPELINE_RUN_VOLUME_STATUSES)[number];

// A review run's outcome for its delivery: dispatched, then the
// runner's report, `review_ready` once the tiles are written and
// verified.
export const CAPTURE_REVIEW_RUN_STATUSES = ["dispatched", "review_ready", "aborted", "halted"] as const;
export type CaptureReviewRunStatus = (typeof CAPTURE_REVIEW_RUN_STATUSES)[number];

// What a processing run reports of the review prefixes it was asked to
// delete, and what a review row records of its own prefix.
export const PIPELINE_REVIEW_PURGE_STATUSES = ["purged", "failed", "not_reached"] as const;
export type PipelineReviewPurgeStatus = (typeof PIPELINE_REVIEW_PURGE_STATUSES)[number];
export const CAPTURE_REVIEW_PURGE_STATUSES = ["purged", "failed"] as const;
export type CaptureReviewPurgeStatus = (typeof CAPTURE_REVIEW_PURGE_STATUSES)[number];

// Recipe vocabularies: the output image class, the platen used at
// capture, and the background behind the page.
export const PIPELINE_OUTPUT_CLASSES = ["tonal", "bilevel"] as const;
export type PipelineOutputClass = (typeof PIPELINE_OUTPUT_CLASSES)[number];
export const PIPELINE_PLATENS = ["v", "none"] as const;
export type PipelinePlaten = (typeof PIPELINE_PLATENS)[number];
export const PIPELINE_BACKGROUNDS = ["dark", "light"] as const;
export type PipelineBackground = (typeof PIPELINE_BACKGROUNDS)[number];

// The runner's stages, in the order it runs them.
export const PIPELINE_STAGES = ["preprocess", "render", "ocr", "tile"] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

// Review verdicts on a flagged page.
export const PIPELINE_VERDICTS = ["accept", "amend", "accept_with_record"] as const;
export type PipelineVerdict = (typeof PIPELINE_VERDICTS)[number];

// Error classes the runner reports. The systemic subset halts the run
// and pairs with a `halted` callback; every other runner class pairs
// with `aborted`. `fixity` is a pulled master whose SHA-256 differs from
// the digest its page carries in the spec: the volume stops, naming the
// failing page keys, and the run goes on.
export const PIPELINE_RUNNER_ERROR_CLASSES = [
  "image", "qc", "source_pull", "fixity", "spec", "destination", "auth", "internal",
] as const;
export type PipelineRunnerErrorClass = (typeof PIPELINE_RUNNER_ERROR_CLASSES)[number];
export const PIPELINE_SYSTEMIC_ERROR_CLASSES = ["source_pull", "destination", "auth"] as const;

// Error classes Fisqua alone writes, on a run or a run volume: an
// expired token, a chunk that failed or was never sent, too large a
// share of volumes pending review, and a halt reported only by a
// chunk's completion job. A volume whose job ended without reporting is
// recorded with the runner class `internal`.
export const PIPELINE_FISQUA_ERROR_CLASSES = [
  "token_expired", "dispatch", "max_review_frac", "unreported_halt",
] as const;
export type PipelineFisquaErrorClass = (typeof PIPELINE_FISQUA_ERROR_CLASSES)[number];

// The characters a page key may use. Page keys name override entries,
// flags, OCR objects and tile directories, so a key cannot start with a
// dot or carry a path separator. The run-spec validator and the page
// table's CHECK use this same pattern.
export const PIPELINE_PAGE_KEY_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

// One attempt to publish a ready volume. `claimed` and `copying` are in
// flight; `copying` means the canonical manifest may already have been
// written. `abandoned` is a claim that expired before it copied
// anything.
export const PIPELINE_PUBLICATION_STATUSES = [
  "claimed", "copying", "published", "failed", "abandoned",
] as const;
export type PipelinePublicationStatus = (typeof PIPELINE_PUBLICATION_STATUSES)[number];

// Whether a publication left a pre-pipeline chain of delivery objects
// waiting to be retired.
export const PIPELINE_RETIREMENT_STATUSES = ["none", "pending"] as const;
export type PipelineRetirementStatus = (typeof PIPELINE_RETIREMENT_STATUSES)[number];

// ---------------------------------------------------------------------------
// Capture link
// ---------------------------------------------------------------------------
//
// The direct link by which a Captua unit delivers its capture manifest
// and follows a volume's progress, under the Captua exchange contract. A
// delivery is one manifest id received: `received` while it is being
// checked, `registered` once its volume holds it, `refused` when a check
// failed (it then holds nothing), `superseded` when a newer manifest for
// the same volume replaced it before any run started.
export const CAPTURE_DELIVERY_STATES = ["received", "registered", "refused", "superseded"] as const;
export type CaptureDeliveryState = (typeof CAPTURE_DELIVERY_STATES)[number];

// The route a delivery came by: `link`, a unit's call with its token, or
// `file`, the registration command reading a manifest file (0095).
export const CAPTURE_DELIVERY_ROUTES = ["link", "file"] as const;
export type CaptureDeliveryRoute = (typeof CAPTURE_DELIVERY_ROUTES)[number];

// The volume states the status call answers with, in the order a
// volume passes through them, plus `unknown` for a reference code Fisqua
// holds nothing for. `preparing_review` (the previews tiled for capture
// QC), `in_capture_qc`, `retakes_requested` and `approved` come from
// capture QC: `preparing_review` from the review run that tiles
// the previews, which nothing starts here, the other three from the
// decisions.
export const CAPTURE_LINK_STATES = [
  "received", "registered", "preparing_review", "in_capture_qc", "retakes_requested", "approved",
  "queued", "running", "review_pending", "published",
  "refused", "superseded", "failed", "unknown",
] as const;
// The four states only capture QC produces.
export const CAPTURE_QC_STATES = ["preparing_review", "in_capture_qc", "retakes_requested", "approved"] as const;
export type CaptureQcState = (typeof CAPTURE_QC_STATES)[number];
export type CaptureLinkState = (typeof CAPTURE_LINK_STATES)[number];

// The states after which the unit stops asking about a volume.
export const CAPTURE_FINAL_STATES = ["published", "refused", "superseded"] as const;

// Capture QC decisions. Each opening of a delivery, one Captua
// record, is approved or rejected for retake with one reason; `other`
// needs a note. The values are the contract's, shared with Captua.
export const CAPTURE_QC_DECISIONS = ["approved", "rejected"] as const;
export type CaptureQcDecision = (typeof CAPTURE_QC_DECISIONS)[number];
export const CAPTURE_QC_REASONS = [
  "blur", "glare", "shadow", "focus", "exposure", "dirt", "framing", "obstruction", "other",
] as const;
export type CaptureQcReason = (typeof CAPTURE_QC_REASONS)[number];
// The image of a two-image opening a rejection asks to have retaken
// as `side`: the left, the right, or both. A rejection of an
// opening with one image names none.
export const CAPTURE_QC_SIDES = ["left", "right", "both"] as const;
export type CaptureQcSide = (typeof CAPTURE_QC_SIDES)[number];
// The image roles a capture carries, as the manifest names them.
export const CAPTURE_IMAGE_ROLES = ["left", "right", "single"] as const;
// The states a delivery's decision set puts its volume in: some openings
// decided and none rejected, any rejected, or every one approved.
// `preparing_review` comes from the review run, not from decisions.
export const CAPTURE_QC_SET_STATES = ["in_capture_qc", "retakes_requested", "approved"] as const;
export type CaptureQcSetState = (typeof CAPTURE_QC_SET_STATES)[number];

