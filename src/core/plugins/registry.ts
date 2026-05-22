import path from 'node:path';

import { githubActionsProvider } from '../../plugins/builtin/providers/github-actions/index.js';
import { circleCiProvider } from '../../plugins/builtin/providers/circleci/index.js';
import { genericEnvProvider } from '../../plugins/builtin/providers/generic-env/index.js';
import { builtinProfileHandlers } from '../../plugins/builtin/profiles/index.js';
import { semanticReleaseTool } from '../../plugins/builtin/release-tools/semantic-release/index.js';
import { slackWebhookNotifier } from '../../plugins/builtin/notifiers/slack-webhook/index.js';
import { builtinArtifactPublisherHandlers } from '../../plugins/builtin/artifact-publishers/index.js';
import { builtinMetadataEnricherHandlers } from '../../plugins/builtin/metadata-enrichers/index.js';
import type { PluginHandler, PluginType } from './request-response.js';

interface BuiltinPluginRefMap<Value> {
  [pluginRef: string]: Value;
}

type BuiltinPluginTypeMap<Value> = Partial<{
  [pluginType in PluginType]: BuiltinPluginRefMap<Value>;
}>;

const packageRoot = path.resolve(import.meta.dirname, '../../../');

function builtin(relativePath: string): string {
  return path.resolve(packageRoot, 'src/plugins/builtin', relativePath, 'manifest.json');
}

export const builtinManifestPaths: BuiltinPluginTypeMap<string> = {
  provider: {
    'builtin:github-actions': builtin('providers/github-actions'),
    'builtin:circleci': builtin('providers/circleci'),
    'builtin:generic-env': builtin('providers/generic-env'),
  },
  profile: {
    'builtin:deploy-release': builtin('profiles/deploy-release'),
    'builtin:manual-release-pr': builtin('profiles/manual-release-pr'),
    'builtin:semantic-release': builtin('profiles/semantic-release'),
    'builtin:npm-package': builtin('profiles/npm-package'),
    'builtin:asset-release': builtin('profiles/asset-release'),
    'builtin:tag-only-module': builtin('profiles/tag-only-module'),
  },
  release_tool: {
    'builtin:semantic-release': builtin('release-tools/semantic-release'),
  },
  notifier: {
    'builtin:slack-webhook': builtin('notifiers/slack-webhook'),
  },
  artifact_publisher: {
    'builtin:github-release-assets': builtin('artifact-publishers/github-release-assets'),
    'builtin:npm-registry-verify': builtin('artifact-publishers/npm-registry-verify'),
    'builtin:s3-manifest-publish': builtin('artifact-publishers/s3-manifest-publish'),
  },
  metadata_enricher: {
    'builtin:github-associated-prs': builtin('metadata-enrichers/github-associated-prs'),
    'builtin:github-release-body-pr-parser': builtin('metadata-enrichers/github-release-body-pr-parser'),
  },
};

export const builtinHandlers: BuiltinPluginTypeMap<PluginHandler> = {
  provider: {
    'builtin:github-actions': githubActionsProvider,
    'builtin:circleci': circleCiProvider,
    'builtin:generic-env': genericEnvProvider,
  },
  profile: builtinProfileHandlers,
  release_tool: {
    'builtin:semantic-release': semanticReleaseTool,
  },
  notifier: {
    'builtin:slack-webhook': slackWebhookNotifier,
  },
  artifact_publisher: builtinArtifactPublisherHandlers,
  metadata_enricher: builtinMetadataEnricherHandlers,
};
