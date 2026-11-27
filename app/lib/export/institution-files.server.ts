/**
 * Institution Files Reader
 *
 * This module deals with reading, from D1, the rows the institution
 * builders in `./institution-records.server.ts` take, so the export's
 * repositories step can write `publisher.json`, `vocabulary.json` and
 * the full repository record of `repositories.json` from them. The
 * builders read nothing themselves; the fixture command reads the same
 * rows through wrangler, and this module reads them through Drizzle in
 * the Worker.
 *
 * `readFederationPublisher` reads one federation's row: its publisher
 * columns, its manifest base address (logos are object keys made
 * absolute against it) and its hosting statement. The repositories step
 * needs only this, for the logo URLs and the attribution lines. A
 * federation id that names no row is an error, since a publish without
 * its publisher record would write the files empty.
 *
 * `readFederationInstitution` reads the same row and, for the institution
 * step, the federation's credit lines, vocabulary values and authority
 * sources, the relation lists' connectors, inverses, hiding groups and
 * label forms included. Every list is the federation's own: the lists are held per
 * federation, and a publish reads only the federation it publishes.
 *
 * `readRepositoryFunders` reads the funders of a set of repositories,
 * grouped by repository, in chunks within D1's 100 bound parameters.
 *
 * Credits and funders are read in `position` order, ties broken by id,
 * so two rows with the same position always come out in the same order;
 * the builders sort by position again, keeping that order for ties.
 *
 * Nothing here is specific to any federation or repository.
 *
 * @version v0.9.0
 */

import { asc, eq, inArray } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import {
  authoritySources,
  federationCredits,
  federations,
  repositoryFunders,
  vocabularyValues,
} from "../../db/schema";
import type {
  AuthoritySourceSource,
  CreditSource,
  FederationHosting,
  FunderSource,
  PublisherSource,
  VocabularyValueSource,
} from "./institution-records.server";

/** What the repository records need from the federation's row. */
export interface FederationPublisher {
  publisher: PublisherSource;
  manifestBaseUrl: string | null;
  hosting: FederationHosting;
}

/** What the publisher and vocabulary files need from the federation. */
export interface FederationInstitution extends FederationPublisher {
  credits: CreditSource[];
  values: VocabularyValueSource[];
  sources: AuthoritySourceSource[];
}

/** Repository ids per funder query; 90 of D1's 100 bound parameters. */
const FUNDER_CHUNK = 90;

export async function readFederationPublisher(
  db: DrizzleD1Database<any>,
  federationId: string,
): Promise<FederationPublisher> {
  const fed = await db
    .select({
      slug: federations.slug,
      name: federations.name,
      publisherName: federations.publisherName,
      publisherTaxId: federations.publisherTaxId,
      publisherLocation: federations.publisherLocation,
      publisherUrl: federations.publisherUrl,
      publisherEmail: federations.publisherEmail,
      publisherLogoKey: federations.publisherLogoKey,
      descriptionEs: federations.descriptionEs,
      descriptionEn: federations.descriptionEn,
      termsOfUseEs: federations.termsOfUseEs,
      termsOfUseEn: federations.termsOfUseEn,
      privacyEs: federations.privacyEs,
      privacyEn: federations.privacyEn,
      takedownEs: federations.takedownEs,
      takedownEn: federations.takedownEn,
      citationTemplateSiteEs: federations.citationTemplateSiteEs,
      citationTemplateSiteEn: federations.citationTemplateSiteEn,
      citationTemplateRecordEs: federations.citationTemplateRecordEs,
      citationTemplateRecordEn: federations.citationTemplateRecordEn,
      manifestBaseUrl: federations.manifestBaseUrl,
      hostingStatementEs: federations.hostingStatementEs,
      hostingStatementEn: federations.hostingStatementEn,
    })
    .from(federations)
    .where(eq(federations.id, federationId))
    .get();
  if (!fed) throw new Error(`Federation ${federationId} not found`);
  const { manifestBaseUrl, hostingStatementEs, hostingStatementEn, ...publisher } = fed;
  return { publisher, manifestBaseUrl, hosting: { hostingStatementEs, hostingStatementEn } };
}

export async function readFederationInstitution(
  db: DrizzleD1Database<any>,
  federationId: string,
): Promise<FederationInstitution> {
  const record = await readFederationPublisher(db, federationId);

  const credits = await db
    .select({
      name: federationCredits.name,
      role: federationCredits.role,
      url: federationCredits.url,
      logoKey: federationCredits.logoKey,
      position: federationCredits.position,
    })
    .from(federationCredits)
    .where(eq(federationCredits.federationId, federationId))
    .orderBy(asc(federationCredits.position), asc(federationCredits.id))
    .all();

  const values = await db
    .select({
      list: vocabularyValues.list,
      code: vocabularyValues.code,
      labelEs: vocabularyValues.labelEs,
      labelEn: vocabularyValues.labelEn,
      groupCode: vocabularyValues.groupCode,
      position: vocabularyValues.position,
      externalScheme: vocabularyValues.externalScheme,
      externalUri: vocabularyValues.externalUri,
      externalLabel: vocabularyValues.externalLabel,
      status: vocabularyValues.status,
      connectorEs: vocabularyValues.connectorEs,
      connectorEn: vocabularyValues.connectorEn,
      inverseCode: vocabularyValues.inverseCode,
      hideWhenGroup: vocabularyValues.hideWhenGroup,
      labelEsFemale: vocabularyValues.labelEsFemale,
      labelEsMale: vocabularyValues.labelEsMale,
      labelEsUnrecorded: vocabularyValues.labelEsUnrecorded,
      labelEsAlone: vocabularyValues.labelEsAlone,
      labelEnFemale: vocabularyValues.labelEnFemale,
      labelEnMale: vocabularyValues.labelEnMale,
      labelEnUnrecorded: vocabularyValues.labelEnUnrecorded,
      labelEnAlone: vocabularyValues.labelEnAlone,
    })
    .from(vocabularyValues)
    .where(eq(vocabularyValues.federationId, federationId))
    .all();

  const sources = await db
    .select({
      key: authoritySources.key,
      labelEs: authoritySources.labelEs,
      labelEn: authoritySources.labelEn,
      urlTemplate: authoritySources.urlTemplate,
      appliesTo: authoritySources.appliesTo,
      position: authoritySources.position,
      status: authoritySources.status,
    })
    .from(authoritySources)
    .where(eq(authoritySources.federationId, federationId))
    .all();

  return { ...record, credits, values, sources };
}

export async function readRepositoryFunders(
  db: DrizzleD1Database<any>,
  repositoryIds: string[],
): Promise<Map<string, FunderSource[]>> {
  const byRepository = new Map<string, FunderSource[]>(repositoryIds.map((id) => [id, []]));
  for (let i = 0; i < repositoryIds.length; i += FUNDER_CHUNK) {
    const rows = await db
      .select({
        repositoryId: repositoryFunders.repositoryId,
        name: repositoryFunders.name,
        programme: repositoryFunders.programme,
        projectId: repositoryFunders.projectId,
        url: repositoryFunders.url,
        position: repositoryFunders.position,
      })
      .from(repositoryFunders)
      .where(inArray(repositoryFunders.repositoryId, repositoryIds.slice(i, i + FUNDER_CHUNK)))
      .orderBy(asc(repositoryFunders.position), asc(repositoryFunders.id))
      .all();
    for (const { repositoryId, ...funder } of rows) byRepository.get(repositoryId)?.push(funder);
  }
  return byRepository;
}

// @version v0.9.0
