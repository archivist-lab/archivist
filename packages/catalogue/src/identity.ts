import type Database from 'better-sqlite3'
import type { OrganisationIdentityInput, PersonIdentityInput } from './types.js'

export function normalizeIdentityName(value: string): string {
  return String(value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

export function upsertPersonIdentity(db: Database.Database, input: PersonIdentityInput): number {
  const exact = db.prepare(`SELECT person_id FROM catalog_person_external_ids WHERE source=? AND external_id=?`).get(input.source, input.externalId) as { person_id: number } | undefined
  if (exact) {
    db.prepare(`UPDATE catalog_people SET name=?,normalized_name=?,original_name=COALESCE(?,original_name),biography=COALESCE(?,biography),birthday=COALESCE(?,birthday),deathday=COALESCE(?,deathday),place_of_birth=COALESCE(?,place_of_birth),metadata_updated_at=CURRENT_TIMESTAMP,deleted_at=NULL WHERE person_id=?`)
      .run(input.name, normalizeIdentityName(input.name), input.originalName ?? null, input.biography ?? null, input.birthday ?? null, input.deathday ?? null, input.placeOfBirth ?? null, exact.person_id)
    return exact.person_id
  }

  const normalized = normalizeIdentityName(input.name)
  const candidates = db.prepare(`SELECT person_id,birthday,place_of_birth FROM catalog_people WHERE normalized_name=? AND deleted_at IS NULL`).all(normalized) as Array<{ person_id: number; birthday: string | null; place_of_birth: string | null }>
  const verified = candidates.find(candidate => input.birthday && candidate.birthday === input.birthday && (!input.placeOfBirth || !candidate.place_of_birth || candidate.place_of_birth === input.placeOfBirth))
  let personId: number
  if (verified) personId = verified.person_id
  else {
    const result = db.prepare(`INSERT INTO catalog_people(name,normalized_name,original_name,biography,birthday,deathday,place_of_birth,metadata_updated_at) VALUES(?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`)
      .run(input.name, normalized, input.originalName ?? null, input.biography ?? null, input.birthday ?? null, input.deathday ?? null, input.placeOfBirth ?? null)
    personId = Number(result.lastInsertRowid)
    for (const candidate of candidates) {
      db.prepare(`INSERT OR IGNORE INTO catalog_person_matches(person_id,candidate_person_id,match_score,match_reason,status) VALUES(?,?,?,?,'suggested')`)
        .run(personId, candidate.person_id, input.birthday && candidate.birthday && input.birthday !== candidate.birthday ? 0.2 : 0.65, 'Same normalized name; provider identities differ')
    }
  }
  db.prepare(`INSERT INTO catalog_person_external_ids(person_id,source,external_id,is_primary,verified_at) VALUES(?,?,?,1,CURRENT_TIMESTAMP)`).run(personId, input.source, input.externalId)
  db.prepare(`INSERT OR IGNORE INTO catalog_person_aliases(person_id,name,normalized_name,source,is_primary) VALUES(?,?,?,?,1)`).run(personId, input.name, normalized, input.source)
  return personId
}

export function upsertOrganisationIdentity(db: Database.Database, input: OrganisationIdentityInput): number {
  const exact = db.prepare(`SELECT organisation_id FROM catalog_organisation_external_ids WHERE source=? AND external_id=?`).get(input.source, input.externalId) as { organisation_id: number } | undefined
  if (exact) {
    db.prepare(`UPDATE catalog_organisations SET name=?,normalized_name=?,organisation_type=COALESCE(?,organisation_type),country_code=COALESCE(?,country_code),updated_at=CURRENT_TIMESTAMP,deleted_at=NULL WHERE organisation_id=?`)
      .run(input.name, normalizeIdentityName(input.name), input.organisationType ?? null, input.countryCode ?? null, exact.organisation_id)
    return exact.organisation_id
  }
  const result = db.prepare(`INSERT INTO catalog_organisations(name,normalized_name,organisation_type,country_code) VALUES(?,?,?,?)`)
    .run(input.name, normalizeIdentityName(input.name), input.organisationType ?? 'organisation', input.countryCode ?? null)
  const organisationId = Number(result.lastInsertRowid)
  db.prepare(`INSERT INTO catalog_organisation_external_ids(organisation_id,source,external_id,is_primary,verified_at) VALUES(?,?,?,1,CURRENT_TIMESTAMP)`).run(organisationId, input.source, input.externalId)
  return organisationId
}
