-- The institution records: the publisher on each federation, an ISDIAH
-- record on each repository, and a federation's credit lines,
-- repository funders, controlled vocabularies and authority sources.
--
-- `federations` gains the rest of the publisher record beside the four
-- `publisher_*` columns of migration 0118: a contact email, the object
-- key of its logo, a short description, the catalogue licence URI (the
-- licence on the metadata itself; its label is derived from the URI),
-- the terms of use, privacy and takedown statements, and the citation
-- template. `federations.name` is the publisher's display name.
--
-- `repositories` gains the fields of a simplified ISDIAH record: other
-- names (a JSON list of strings), the type of institution, the object
-- key of its logo, region, postal code, telephone and email beside the
-- existing address columns, holdings and history, opening times, access
-- conditions, accessibility, reproduction services, and the language
-- the record is written in. `subtitle_en` holds the English subtitle;
-- `subtitle` holds the Spanish.
--
-- Prose is held as an `_es`/`_en` column pair, either of which may be
-- null. Every added column is nullable, so rows written before this
-- migration stay valid. A `*_logo_key` holds the object key of an image
-- in the federation's manifests bucket, under `institutions/`; the
-- export builds the absolute URL from the federation's public manifest
-- address.
--
-- `federation_credits` lists the partners, funders, developers and
-- hosts a federation credits, in `position` order, and
-- `repository_funders` lists the funders and projects behind a
-- repository's holdings, in the same way. Both are parts of their
-- parent's record and are deleted with it (ON DELETE CASCADE).
--
-- `vocabulary_values` holds each federation's own controlled lists:
-- entity types, place types, entity roles, place roles and role groups.
-- A code is unique within its federation and list; two federations may
-- use the same code with different labels. A role names its group in
-- `group_code`, a code of the same federation's `role_group` list, and
-- `position` orders roles within a group and the groups themselves. A
-- place type may carry an external term: the scheme, the concept URI
-- (for the AAT, `http://vocab.getty.edu/aat/<id>`) and its label.
-- `status` is approved, proposed or deprecated.
--
-- `authority_sources` holds the external authority files a federation
-- links its records to: a key unique within the federation, its labels,
-- a URL template (for example `https://viaf.org/viaf/{id}`), the kinds
-- of record it applies to (a JSON list) and the same status.
--
-- Vocabulary values and authority sources keep their federation from
-- being deleted (ON DELETE RESTRICT), as the federation's other
-- authority tables do.
--
-- Version: v0.9.0

ALTER TABLE federations ADD COLUMN publisher_email TEXT;
--> statement-breakpoint
ALTER TABLE federations ADD COLUMN publisher_logo_key TEXT;
--> statement-breakpoint
ALTER TABLE federations ADD COLUMN description_es TEXT;
--> statement-breakpoint
ALTER TABLE federations ADD COLUMN description_en TEXT;
--> statement-breakpoint
ALTER TABLE federations ADD COLUMN catalogue_licence_uri TEXT;
--> statement-breakpoint
ALTER TABLE federations ADD COLUMN terms_of_use_es TEXT;
--> statement-breakpoint
ALTER TABLE federations ADD COLUMN terms_of_use_en TEXT;
--> statement-breakpoint
ALTER TABLE federations ADD COLUMN privacy_es TEXT;
--> statement-breakpoint
ALTER TABLE federations ADD COLUMN privacy_en TEXT;
--> statement-breakpoint
ALTER TABLE federations ADD COLUMN takedown_es TEXT;
--> statement-breakpoint
ALTER TABLE federations ADD COLUMN takedown_en TEXT;
--> statement-breakpoint
ALTER TABLE federations ADD COLUMN citation_template_es TEXT;
--> statement-breakpoint
ALTER TABLE federations ADD COLUMN citation_template_en TEXT;
--> statement-breakpoint
ALTER TABLE repositories ADD COLUMN subtitle_en TEXT;
--> statement-breakpoint
ALTER TABLE repositories ADD COLUMN other_names TEXT
  CHECK (other_names IS NULL OR (json_valid(other_names) AND json_type(other_names) = 'array'));
--> statement-breakpoint
ALTER TABLE repositories ADD COLUMN institution_type TEXT;
--> statement-breakpoint
ALTER TABLE repositories ADD COLUMN logo_key TEXT;
--> statement-breakpoint
ALTER TABLE repositories ADD COLUMN region TEXT;
--> statement-breakpoint
ALTER TABLE repositories ADD COLUMN postal_code TEXT;
--> statement-breakpoint
ALTER TABLE repositories ADD COLUMN telephone TEXT;
--> statement-breakpoint
ALTER TABLE repositories ADD COLUMN email TEXT;
--> statement-breakpoint
ALTER TABLE repositories ADD COLUMN holdings_es TEXT;
--> statement-breakpoint
ALTER TABLE repositories ADD COLUMN holdings_en TEXT;
--> statement-breakpoint
ALTER TABLE repositories ADD COLUMN history_es TEXT;
--> statement-breakpoint
ALTER TABLE repositories ADD COLUMN history_en TEXT;
--> statement-breakpoint
ALTER TABLE repositories ADD COLUMN opening_times_es TEXT;
--> statement-breakpoint
ALTER TABLE repositories ADD COLUMN opening_times_en TEXT;
--> statement-breakpoint
ALTER TABLE repositories ADD COLUMN access_conditions_es TEXT;
--> statement-breakpoint
ALTER TABLE repositories ADD COLUMN access_conditions_en TEXT;
--> statement-breakpoint
ALTER TABLE repositories ADD COLUMN accessibility_es TEXT;
--> statement-breakpoint
ALTER TABLE repositories ADD COLUMN accessibility_en TEXT;
--> statement-breakpoint
ALTER TABLE repositories ADD COLUMN reproduction_services_es TEXT;
--> statement-breakpoint
ALTER TABLE repositories ADD COLUMN reproduction_services_en TEXT;
--> statement-breakpoint
ALTER TABLE repositories ADD COLUMN description_language TEXT;
--> statement-breakpoint
CREATE TABLE federation_credits (
  id TEXT PRIMARY KEY NOT NULL,
  federation_id TEXT NOT NULL REFERENCES federations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('partner','funder','developer','host')),
  url TEXT,
  logo_key TEXT,
  position INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE INDEX federation_credits_federation_idx ON federation_credits (federation_id, position);
--> statement-breakpoint
CREATE TABLE repository_funders (
  id TEXT PRIMARY KEY NOT NULL,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  programme TEXT,
  project_id TEXT,
  url TEXT,
  position INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE INDEX repository_funders_repository_idx ON repository_funders (repository_id, position);
--> statement-breakpoint
CREATE TABLE vocabulary_values (
  id TEXT PRIMARY KEY NOT NULL,
  federation_id TEXT NOT NULL REFERENCES federations(id) ON DELETE RESTRICT,
  list TEXT NOT NULL
    CHECK (list IN ('entity_type','place_type','entity_role','place_role','role_group')),
  code TEXT NOT NULL,
  label_es TEXT,
  label_en TEXT,
  group_code TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  external_scheme TEXT,
  external_uri TEXT,
  external_label TEXT,
  status TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('approved','proposed','deprecated')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX vocabulary_values_federation_list_code_idx ON vocabulary_values (federation_id, list, code);
--> statement-breakpoint
CREATE INDEX vocabulary_values_position_idx ON vocabulary_values (federation_id, list, position);
--> statement-breakpoint
CREATE TABLE authority_sources (
  id TEXT PRIMARY KEY NOT NULL,
  federation_id TEXT NOT NULL REFERENCES federations(id) ON DELETE RESTRICT,
  key TEXT NOT NULL,
  label_es TEXT,
  label_en TEXT,
  url_template TEXT,
  applies_to TEXT
    CHECK (applies_to IS NULL OR (json_valid(applies_to) AND json_type(applies_to) = 'array')),
  position INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('approved','proposed','deprecated'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX authority_sources_federation_key_idx ON authority_sources (federation_id, key);
--> statement-breakpoint
CREATE INDEX authority_sources_position_idx ON authority_sources (federation_id, position);
