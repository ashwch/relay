import { okResponse, type PluginHandler } from '../../../core/plugins/request-response.js';

type BuiltinProfileRef =
  | 'builtin:deploy-release'
  | 'builtin:manual-release-pr'
  | 'builtin:semantic-release'
  | 'builtin:npm-package'
  | 'builtin:asset-release'
  | 'builtin:tag-only-module';

interface ProfilePlanPatch {
  profile: {
    completion_gate: string;
    release_record_timing: 'after_completion' | 'at_completion' | 'before_artifacts';
    channel?: string;
    artifact_completion_required?: boolean;
    requires_tool_plugin?: boolean;
    package_visibility_required?: boolean;
  };
}

const profilePlans: Record<BuiltinProfileRef, ProfilePlanPatch> = {
  'builtin:deploy-release': {
    profile: {
      completion_gate: 'deploy_succeeded',
      release_record_timing: 'after_completion',
      channel: 'production',
      artifact_completion_required: false,
    },
  },
  'builtin:manual-release-pr': {
    profile: {
      completion_gate: 'release_pr_merged',
      release_record_timing: 'after_completion',
      channel: 'stable',
      artifact_completion_required: false,
    },
  },
  'builtin:semantic-release': {
    profile: {
      completion_gate: 'semantic_release_succeeded',
      release_record_timing: 'at_completion',
      channel: 'stable',
      requires_tool_plugin: true,
    },
  },
  'builtin:npm-package': {
    profile: {
      completion_gate: 'package_visible',
      release_record_timing: 'after_completion',
      package_visibility_required: true,
    },
  },
  'builtin:asset-release': {
    profile: {
      completion_gate: 'artifacts_visible',
      release_record_timing: 'before_artifacts',
      artifact_completion_required: true,
    },
  },
  'builtin:tag-only-module': {
    profile: {
      completion_gate: 'tag_confirmed',
      release_record_timing: 'after_completion',
      channel: 'module',
    },
  },
};

function buildProfileHandler(pluginRef: BuiltinProfileRef): PluginHandler {
  return {
    async plan() {
      return okResponse(profilePlans[pluginRef], {}, `planned ${pluginRef}`);
    },
  } satisfies PluginHandler;
}

export const builtinProfileHandlers: Record<BuiltinProfileRef, PluginHandler> = {
  'builtin:deploy-release': buildProfileHandler('builtin:deploy-release'),
  'builtin:manual-release-pr': buildProfileHandler('builtin:manual-release-pr'),
  'builtin:semantic-release': buildProfileHandler('builtin:semantic-release'),
  'builtin:npm-package': buildProfileHandler('builtin:npm-package'),
  'builtin:asset-release': buildProfileHandler('builtin:asset-release'),
  'builtin:tag-only-module': buildProfileHandler('builtin:tag-only-module'),
};
