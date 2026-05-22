import path from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';

import { readJsonObjectFile } from '../io/files.js';
import type { NormalizedRelease } from './schema.js';

const schemaPath = path.resolve(import.meta.dirname, '../../../schemas/normalized-release.schema.json');
const schema = readJsonObjectFile(schemaPath);
const ajv = new Ajv2020({ allErrors: true, strict: false });
const validate = ajv.compile<NormalizedRelease>(schema);

export class ReleaseInvariantError extends Error {
  constructor(message: string, readonly details: string[]) {
    super(message);
  }
}

export function validateNormalizedRelease(candidate: unknown): NormalizedRelease {
  if (!validate(candidate)) {
    const details = (validate.errors ?? []).map((error: { instancePath?: string; message?: string }) => `${error.instancePath || '/'} ${error.message ?? 'validation error'}`);
    throw new ReleaseInvariantError('normalized release JSON failed schema validation', details);
  }

  const release = candidate;
  const errors: string[] = [];
  if (!release.repository.full_name) {
    errors.push('repository.full_name is required');
  }
  if (!release.git.sha) {
    errors.push('git.sha is required');
  }
  if (!release.profile.name) {
    errors.push('profile.name is required');
  }
  if (!release.release.tag) {
    errors.push('release.tag is required');
  }
  if (!['core', 'tool', 'external'].includes(release.release.record.owner)) {
    errors.push('release.record.owner must be core, tool, or external');
  }
  if (release.completion.status !== 'completed' && !release.run.dry_run && release.notifications.deliveries.length > 0) {
    errors.push('notifications.deliveries must stay empty before completion unless dry_run=true');
  }

  if (errors.length > 0) {
    throw new ReleaseInvariantError('normalized release JSON invariant failure', errors);
  }
  return release;
}
