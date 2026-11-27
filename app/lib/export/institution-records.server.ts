/**
 * Institution Records Builders
 *
 * This module deals with building the three institution records an
 * export publishes beside the catalogue, from rows already read from
 * D1: `publisher.json`, the federation as publisher of its members'
 * records; the full record of one repository, as `repositories.json`
 * carries it; and `vocabulary.json`, the federation's controlled lists
 * and authority sources. It reads nothing itself, so the export pipeline
 * and the fixture command share it.
 *
 * `buildPublisherJson` takes the federation row and its credit lines.
 * `buildRepositoryRecord` takes a repository row, its funders, its
 * description count and root descriptions. `buildVocabularyJson` takes
 * a federation's vocabulary values and authority sources. Each writes
 * its keys in the order the downstream site's contract gives them. Prose
 * held as an `_es`/`_en` column pair becomes `{ es, en }`, either of which
 * may be null.
 *
 * Logos are stored as object keys in the federation's manifests bucket;
 * `joinAssetUrl` makes them absolute against the federation's public
 * manifest address. Licences are stored as URIs and labelled by
 * `licenceLabel`.
 *
 * A repository's `attribution` is the one line every output carries,
 * built by `repositoryAttribution` in `./attribution.ts`, which the media
 * pipeline's manifest inputs also use: the stored override in its own
 * language, else the line composed from the repository's name, place and
 * credit statement, the federation's hosting statement and the image
 * licence label. `buildRepositoryRecord` takes the federation's hosting
 * statement for it; null means the federation has none. The structured
 * funders do not feed the line. `text`, `licenceLabel`,
 * `composeAttribution` and `repositoryAttribution` are re-exported here
 * for the callers that already import them from this module.
 *
 * Every text field is exported as null when its stored value is null or
 * holds only whitespace; any other text is exported unchanged. This holds
 * for names, flat fields, contact fields, prose pairs, URLs, object keys
 * and licence URIs alike. Identifiers (ids, codes, slugs, keys) and the
 * members of a JSON list are exported as stored. A credit or a funder is
 * named by its name and the contract requires one, so a credit or funder
 * whose name is blank is left out of the file rather than exported with
 * a null name.
 *
 * Timestamps are stored as integers in two units: most rows hold
 * milliseconds, some older rows hold seconds. `isoTimestamp` reads a value
 * below 1e11 as seconds and multiplies it by 1000, and reads any other
 * value as milliseconds; 1e11 milliseconds is in 1973, and 1e11 seconds is
 * in the year 5138, so the two ranges cannot be confused.
 *
 * `vocabulary.json` carries approved and deprecated values and authority
 * sources, and leaves out proposed ones, which are not yet in use. A
 * deprecated value stays valid on the records that already use it but is
 * not offered for new ones, so its entry carries `deprecated: true`, and
 * an approved entry has no such member.
 *
 * Beside the lists it has always carried, `vocabulary.json` carries the
 * federation's relation vocabulary, whatever its `relation_role`,
 * `link_attribute` and `gender` lists hold; this module names none of
 * their values. `relation_roles` gives each role's label in four forms
 * per language (female, male, unrecorded, and alone only where it is
 * stored and differs from the unrecorded form), its connector, its
 * inverse and its group, ordered by its group's position and then its
 * own (a role whose group is not exported comes after the rest).
 * `link_attributes` gives each key with its label, its stored position
 * as `order` and the group that hides it (`hide_when_group`, null when
 * none). `genders` has the shape of the other simple lists. The relation
 * groups are `role_group` values and appear in `role_groups`. Labels and
 * connectors are exported as stored, blank ones as null.
 *
 * Today's flat repository fields (`city`, `country`, `country_code`,
 * `address`, `website`) are kept at the top level beside `contact` until
 * the site reads `contact`. `image_reproduction_text` follows them: the
 * stored `rights_text`, or an empty string when it is null. The site
 * keeps reading it while it moves to `attribution`.
 *
 * @version v0.9.0
 */

import type { ExportDescription } from "./types";
import {
  licenceLabel,
  repositoryAttribution,
  text,
  type Bilingual,
  type FederationHosting,
} from "./attribution";
import type {
  FederationCreditRole,
  VOCABULARY_STATUSES,
  VocabularyList,
} from "../validation/enums";

type VocabularyStatus = (typeof VOCABULARY_STATUSES)[number];

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

export type { AttributionRepository, Bilingual, FederationHosting } from "./attribution";
export { composeAttribution, licenceLabel, repositoryAttribution, text } from "./attribution";

export interface Licence {
  uri: string | null;
  label: Bilingual;
}

const pair = (es: string | null | undefined, en: string | null | undefined): Bilingual => ({
  es: text(es),
  en: text(en),
});

/** An ISO 8601 timestamp from a stored integer in seconds (below 1e11) or milliseconds. */
export function isoTimestamp(stored: number): string {
  return new Date(stored < 1e11 ? stored * 1000 : stored).toISOString();
}

/** `deprecated: true` for a deprecated entry; nothing for any other. */
const deprecatedMark = (status: VocabularyStatus): { deprecated?: true } =>
  status === "deprecated" ? { deprecated: true } : {};

/**
 * An object key made absolute against a public base address, with one
 * slash between them. Null when either is null.
 */
export function joinAssetUrl(base: string | null, key: string | null): string | null {
  const b = text(base);
  const k = text(key);
  if (b === null || k === null) return null;
  return `${b.replace(/\/+$/, "")}/${k.replace(/^\/+/, "")}`;
}

/** A JSON list of strings, or an empty list for anything else. */
function stringList(text: string | null): string[] {
  if (text === null) return [];
  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed) && parsed.every((v) => typeof v === "string")) return parsed;
  } catch {
    // Not JSON: no names.
  }
  return [];
}

// ---------------------------------------------------------------------------
// Licences
// ---------------------------------------------------------------------------

function licence(uri: string | null): Licence {
  const stored = text(uri);
  return { uri: stored, label: licenceLabel(stored) };
}

// ---------------------------------------------------------------------------
// publisher.json
// ---------------------------------------------------------------------------

/** The federation columns the publisher record reads. */
export interface PublisherSource {
  slug: string;
  name: string;
  publisherName: string | null;
  publisherTaxId: string | null;
  publisherLocation: string | null;
  publisherUrl: string | null;
  publisherEmail: string | null;
  publisherLogoKey: string | null;
  descriptionEs: string | null;
  descriptionEn: string | null;
  termsOfUseEs: string | null;
  termsOfUseEn: string | null;
  privacyEs: string | null;
  privacyEn: string | null;
  takedownEs: string | null;
  takedownEn: string | null;
  citationTemplateSiteEs: string | null;
  citationTemplateSiteEn: string | null;
  citationTemplateRecordEs: string | null;
  citationTemplateRecordEn: string | null;
}

export interface CreditSource {
  name: string;
  role: FederationCreditRole;
  url: string | null;
  logoKey: string | null;
  position: number;
}

export interface ExportCredit {
  name: string;
  role: FederationCreditRole;
  url: string | null;
  logo_url: string | null;
}

export interface ExportPublisher {
  federation: string;
  legal_name: string | null;
  display_name: string | null;
  tax_id: string | null;
  location: string | null;
  website: string | null;
  email: string | null;
  logo_url: string | null;
  description: Bilingual;
  terms_of_use: Bilingual;
  privacy: Bilingual;
  takedown: Bilingual;
  citation_template: { site: Bilingual; record: Bilingual };
  credits: ExportCredit[];
}

export function buildPublisherJson(
  federation: PublisherSource,
  credits: CreditSource[],
  manifestBaseUrl: string | null,
): ExportPublisher {
  return {
    federation: federation.slug,
    legal_name: text(federation.publisherName),
    display_name: text(federation.name),
    tax_id: text(federation.publisherTaxId),
    location: text(federation.publisherLocation),
    website: text(federation.publisherUrl),
    email: text(federation.publisherEmail),
    logo_url: joinAssetUrl(manifestBaseUrl, federation.publisherLogoKey),
    description: pair(federation.descriptionEs, federation.descriptionEn),
    terms_of_use: pair(federation.termsOfUseEs, federation.termsOfUseEn),
    privacy: pair(federation.privacyEs, federation.privacyEn),
    takedown: pair(federation.takedownEs, federation.takedownEn),
    citation_template: {
      site: pair(federation.citationTemplateSiteEs, federation.citationTemplateSiteEn),
      record: pair(federation.citationTemplateRecordEs, federation.citationTemplateRecordEn),
    },
    credits: [...credits]
      .sort((a, b) => a.position - b.position)
      .flatMap((c) => {
        const name = text(c.name);
        return name === null
          ? []
          : [{ name, role: c.role, url: text(c.url), logo_url: joinAssetUrl(manifestBaseUrl, c.logoKey) }];
      }),
  };
}

// ---------------------------------------------------------------------------
// The repository record
// ---------------------------------------------------------------------------

/** The repository columns the full record reads. Timestamps are milliseconds. */
export interface RepositorySource {
  id: string;
  code: string;
  name: string;
  shortName: string | null;
  countryCode: string | null;
  country: string | null;
  city: string | null;
  address: string | null;
  website: string | null;
  displayTitle: string | null;
  subtitle: string | null;
  subtitleEn: string | null;
  heroImageUrl: string | null;
  otherNames: string | null;
  institutionType: string | null;
  logoKey: string | null;
  region: string | null;
  postalCode: string | null;
  telephone: string | null;
  email: string | null;
  holdingsEs: string | null;
  holdingsEn: string | null;
  historyEs: string | null;
  historyEn: string | null;
  openingTimesEs: string | null;
  openingTimesEn: string | null;
  accessConditionsEs: string | null;
  accessConditionsEn: string | null;
  accessibilityEs: string | null;
  accessibilityEn: string | null;
  reproductionServicesEs: string | null;
  reproductionServicesEn: string | null;
  manifestRights: string | null;
  catalogueLicenceUri: string | null;
  attributionEs: string | null;
  attributionEn: string | null;
  creditStatementEs: string | null;
  creditStatementEn: string | null;
  rightsText: string | null;
  descriptionLanguage: string | null;
  homeOrder: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface FunderSource {
  name: string;
  programme: string | null;
  projectId: string | null;
  url: string | null;
  position: number;
}

export interface ExportFunder {
  name: string;
  programme: string | null;
  project_id: string | null;
  url: string | null;
}

export interface ExportRepositoryContact {
  street_address: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  country_code: string | null;
  postal_code: string | null;
  telephone: string | null;
  email: string | null;
  website: string | null;
}

/** One entry of `repositories.json` in its full form. */
export interface ExportRepositoryRecord {
  id: string;
  code: string;
  name: string | null;
  short_name: string | null;
  display_title: string | null;
  subtitle: Bilingual;
  hero_image_url: string | null;
  other_names: string[];
  institution_type: string | null;
  logo_url: string | null;
  contact: ExportRepositoryContact;
  city: string | null;
  country: string | null;
  country_code: string | null;
  address: string | null;
  website: string | null;
  image_reproduction_text: string;
  holdings: Bilingual;
  history: Bilingual;
  access: { opening_times: Bilingual; conditions: Bilingual; accessibility: Bilingual };
  reproduction_services: Bilingual;
  image_licence: Licence;
  catalogue_licence: Licence;
  funders: ExportFunder[];
  attribution: Bilingual;
  description_language: string | null;
  home_order: number | null;
  created_at: string;
  updated_at: string;
  description_count: number;
  root_descriptions: Omit<ExportDescription, "ocr_text">[];
}

export interface RepositoryExtras {
  descriptionCount: number;
  rootDescriptions: Omit<ExportDescription, "ocr_text">[];
}

export function buildRepositoryRecord(
  repo: RepositorySource,
  funders: FunderSource[],
  extras: RepositoryExtras,
  manifestBaseUrl: string | null,
  hosting: FederationHosting | null,
): ExportRepositoryRecord {
  const ordered = [...funders].sort((a, b) => a.position - b.position);
  return {
    id: repo.id,
    code: repo.code,
    name: text(repo.name),
    short_name: text(repo.shortName),
    display_title: text(repo.displayTitle),
    subtitle: pair(repo.subtitle, repo.subtitleEn),
    hero_image_url: text(repo.heroImageUrl),
    other_names: stringList(repo.otherNames),
    institution_type: text(repo.institutionType),
    logo_url: joinAssetUrl(manifestBaseUrl, repo.logoKey),
    contact: {
      street_address: text(repo.address),
      city: text(repo.city),
      region: text(repo.region),
      country: text(repo.country),
      country_code: text(repo.countryCode),
      postal_code: text(repo.postalCode),
      telephone: text(repo.telephone),
      email: text(repo.email),
      website: text(repo.website),
    },
    city: text(repo.city),
    country: text(repo.country),
    country_code: text(repo.countryCode),
    address: text(repo.address),
    website: text(repo.website),
    image_reproduction_text: repo.rightsText ?? "",
    holdings: pair(repo.holdingsEs, repo.holdingsEn),
    history: pair(repo.historyEs, repo.historyEn),
    access: {
      opening_times: pair(repo.openingTimesEs, repo.openingTimesEn),
      conditions: pair(repo.accessConditionsEs, repo.accessConditionsEn),
      accessibility: pair(repo.accessibilityEs, repo.accessibilityEn),
    },
    reproduction_services: pair(repo.reproductionServicesEs, repo.reproductionServicesEn),
    image_licence: licence(repo.manifestRights),
    catalogue_licence: licence(repo.catalogueLicenceUri),
    funders: ordered.flatMap((f) => {
      const name = text(f.name);
      return name === null
        ? []
        : [{ name, programme: text(f.programme), project_id: text(f.projectId), url: text(f.url) }];
    }),
    attribution: repositoryAttribution(repo, hosting),
    description_language: text(repo.descriptionLanguage),
    home_order: repo.homeOrder,
    created_at: isoTimestamp(repo.createdAt),
    updated_at: isoTimestamp(repo.updatedAt),
    description_count: extras.descriptionCount,
    root_descriptions: extras.rootDescriptions,
  };
}

// ---------------------------------------------------------------------------
// vocabulary.json
// ---------------------------------------------------------------------------

export interface VocabularyValueSource {
  list: VocabularyList;
  code: string;
  labelEs: string | null;
  labelEn: string | null;
  groupCode: string | null;
  position: number;
  externalScheme: string | null;
  externalUri: string | null;
  externalLabel: string | null;
  status: VocabularyStatus;
  // The relation lists only (`relation_role`, `link_attribute`); absent
  // or null on the others.
  connectorEs?: string | null;
  connectorEn?: string | null;
  inverseCode?: string | null;
  hideWhenGroup?: string | null;
  labelEsFemale?: string | null;
  labelEsMale?: string | null;
  labelEsUnrecorded?: string | null;
  labelEsAlone?: string | null;
  labelEnFemale?: string | null;
  labelEnMale?: string | null;
  labelEnUnrecorded?: string | null;
  labelEnAlone?: string | null;
}

export interface AuthoritySourceSource {
  key: string;
  labelEs: string | null;
  labelEn: string | null;
  urlTemplate: string | null;
  appliesTo: string | null;
  position: number;
  status: VocabularyStatus;
}

export interface ExportVocabularyValue {
  code: string;
  label: Bilingual;
  deprecated?: true;
}

export interface ExportPlaceType extends ExportVocabularyValue {
  external?: { scheme: string | null; uri: string; label: string | null };
}

/** A relation label's forms in one language; `alone` only where it differs. */
export interface ExportRelationForms {
  female: string | null;
  male: string | null;
  unrecorded: string | null;
  alone?: string;
}

export interface ExportRelationRole {
  code: string;
  label: { es: ExportRelationForms; en: ExportRelationForms };
  connector: Bilingual;
  inverse: string | null;
  group: string | null;
  deprecated?: true;
}

export interface ExportLinkAttribute {
  key: string;
  label: Bilingual;
  order: number;
  hide_when_group: string | null;
  deprecated?: true;
}

export interface ExportVocabulary {
  entity_types: ExportVocabularyValue[];
  place_types: ExportPlaceType[];
  role_groups: Array<ExportVocabularyValue & { order: number }>;
  entity_roles: Array<ExportVocabularyValue & { group: string | null }>;
  place_roles: ExportVocabularyValue[];
  authority_sources: Array<{
    key: string;
    label: Bilingual;
    url_template: string | null;
    applies_to: string[];
    deprecated?: true;
  }>;
  relation_roles: ExportRelationRole[];
  link_attributes: ExportLinkAttribute[];
  genders: ExportVocabularyValue[];
}

/** One language's forms of a relation label, from its stored columns. */
function relationForms(
  female: string | null | undefined,
  male: string | null | undefined,
  unrecorded: string | null | undefined,
  alone: string | null | undefined,
): ExportRelationForms {
  const u = text(unrecorded);
  const a = text(alone);
  return {
    female: text(female),
    male: text(male),
    unrecorded: u,
    ...(a !== null && a !== u ? { alone: a } : {}),
  };
}

const byPositionThen = <T extends { position: number }>(tie: (v: T) => string) =>
  (a: T, b: T) => a.position - b.position || (tie(a) < tie(b) ? -1 : tie(a) > tie(b) ? 1 : 0);

export function buildVocabularyJson(
  values: VocabularyValueSource[],
  sources: AuthoritySourceSource[],
): ExportVocabulary {
  const exported = values
    .filter((v) => v.status !== "proposed")
    .sort(byPositionThen((v) => v.code));
  const of = (list: VocabularyList) => exported.filter((v) => v.list === list);
  const label = (v: VocabularyValueSource) => pair(v.labelEs, v.labelEn);
  // Each exported group's position, which orders the relation roles.
  const groupOrder = new Map(of("role_group").map((g) => [g.code, g.position]));

  return {
    entity_types: of("entity_type").map((v) => ({
      code: v.code,
      label: label(v),
      ...deprecatedMark(v.status),
    })),
    place_types: of("place_type").map((v) => {
      const uri = text(v.externalUri);
      return {
        code: v.code,
        label: label(v),
        ...(uri === null
          ? {}
          : { external: { scheme: text(v.externalScheme), uri, label: text(v.externalLabel) } }),
        ...deprecatedMark(v.status),
      };
    }),
    role_groups: of("role_group").map((v) => ({
      code: v.code,
      label: label(v),
      order: v.position,
      ...deprecatedMark(v.status),
    })),
    entity_roles: of("entity_role").map((v) => ({
      code: v.code,
      label: label(v),
      group: text(v.groupCode),
      ...deprecatedMark(v.status),
    })),
    place_roles: of("place_role").map((v) => ({
      code: v.code,
      label: label(v),
      ...deprecatedMark(v.status),
    })),
    authority_sources: sources
      .filter((s) => s.status !== "proposed")
      .sort(byPositionThen((s) => s.key))
      .map((s) => ({
        key: s.key,
        label: pair(s.labelEs, s.labelEn),
        url_template: text(s.urlTemplate),
        applies_to: stringList(s.appliesTo),
        ...deprecatedMark(s.status),
      })),

    relation_roles: of("relation_role")
      .map((v, index) => ({ v, index, group: groupOrder.get(v.groupCode ?? "") ?? Number.POSITIVE_INFINITY }))
      // `exported` is already in position-then-code order; keep it within a group.
      .sort((a, b) => a.group - b.group || a.index - b.index)
      .map(({ v }) => ({
        code: v.code,
        label: {
          es: relationForms(v.labelEsFemale, v.labelEsMale, v.labelEsUnrecorded, v.labelEsAlone),
          en: relationForms(v.labelEnFemale, v.labelEnMale, v.labelEnUnrecorded, v.labelEnAlone),
        },
        connector: pair(v.connectorEs, v.connectorEn),
        inverse: text(v.inverseCode),
        group: text(v.groupCode),
        ...deprecatedMark(v.status),
      })),
    link_attributes: of("link_attribute").map((v) => ({
      key: v.code,
      label: label(v),
      order: v.position,
      hide_when_group: text(v.hideWhenGroup),
      ...deprecatedMark(v.status),
    })),
    genders: of("gender").map((v) => ({
      code: v.code,
      label: label(v),
      ...deprecatedMark(v.status),
    })),
  };
}

// @version v0.9.0
