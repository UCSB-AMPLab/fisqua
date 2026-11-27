/**
 * Repository Validation
 *
 * This module deals with the Zod schemas for repository-row writes:
 * display metadata, short code, locality, and enabled flag, and the
 * fields of the repository's simplified ISDIAH record. Shared by the
 * admin routes and the bulk import CLI.
 *
 * The ISDIAH fields are all optional. Other names are a list of
 * non-empty strings, which the caller stores as a JSON array. The email
 * must be an address, the catalogue licence an http or https URI (as the
 * manifest rights URI must), and the home order an integer. The prose
 * fields are Markdown held as plain text, one column per language, and
 * are not checked beyond being strings; so is the credit statement pair,
 * which is plain text rather than Markdown. The create schema leaves
 * other names out, since the create form does not carry them.
 *
 * @version v0.9.0
 */
import { z } from "zod/v4";
import { isHttpUri, URI_SCHEME_MESSAGE } from "./manifest-fields";

export const repositorySchema = z.object({
  id: z.string().uuid(),
  code: z.string().min(1).max(20),
  name: z.string().min(1).max(255),
  shortName: z.string().max(200).optional(),
  countryCode: z.string().max(3).default("COL"),
  country: z.string().max(100).optional(),
  city: z.string().max(100).optional(),
  address: z.string().optional(),
  website: z.string().url().optional(),
  notes: z.string().optional(),
  rightsText: z.string().optional(),
  subtitleEn: z.string().optional(),
  otherNames: z.array(z.string().min(1).max(255)).optional(),
  institutionType: z.string().max(255).optional(),
  region: z.string().max(100).optional(),
  postalCode: z.string().max(20).optional(),
  telephone: z.string().max(100).optional(),
  email: z.string().email().max(255).optional(),
  holdingsEs: z.string().optional(),
  holdingsEn: z.string().optional(),
  historyEs: z.string().optional(),
  historyEn: z.string().optional(),
  openingTimesEs: z.string().optional(),
  openingTimesEn: z.string().optional(),
  accessConditionsEs: z.string().optional(),
  accessConditionsEn: z.string().optional(),
  accessibilityEs: z.string().optional(),
  accessibilityEn: z.string().optional(),
  reproductionServicesEs: z.string().optional(),
  reproductionServicesEn: z.string().optional(),
  descriptionLanguage: z.string().max(20).optional(),
  catalogueLicenceUri: z
    .string()
    .refine(isHttpUri, { message: URI_SCHEME_MESSAGE })
    .optional(),
  homeOrder: z.number().int().optional(),
  creditStatementEs: z.string().optional(),
  creditStatementEn: z.string().optional(),
  enabled: z.boolean().default(true),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});

// The create form writes none of the ISDIAH list fields; other names
// are a list here and JSON text in the row, so the insert would need a
// conversion it has no use for.
export const createRepositorySchema = repositorySchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  otherNames: true,
});

export const updateRepositorySchema = repositorySchema
  .partial()
  .required({ id: true });

export const importRepositorySchema = repositorySchema;

// @version v0.9.0
