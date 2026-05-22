import type { NormalizedRelease } from '../release-json/schema.js';

export interface FinalizeResult {
  status: 'ok' | 'noop';
  release_tag: string;
  release_url: string | null;
  release_mode: string;
  profile: string;
  notification_sent: boolean;
  dry_run: boolean;
  normalized_release: NormalizedRelease;
  phases: string[];
}
