import { okResponse, type PluginHandler, type PluginResponse } from '../../../../core/plugins/request-response.js';

export const semanticReleaseTool: PluginHandler = {
  async observe(request) {
    if (!request.release) {
      throw new Error('semantic-release observe requires an existing release document');
    }

    /**
     * semantic-release has a normal successful no-op mode:
     *
     *   commits analyzed
     *        ↓
     *   no release-worthy changes
     *        ↓
     *   no tag and no GitHub Release are created
     *
     * Core should only verify GitHub when semantic-release gives us an explicit
     * tag to verify. Falling back to the framework's computed tag would turn that
     * normal no-op into a failing pipeline.
     */
    const explicitTag = readString(request.inputs.args.tag)
      ?? readString(request.inputs.args.release_tag)
      ?? readString(request.inputs.env.RELEASE_TAG);

    if (!explicitTag) {
      return noopSemanticReleaseResponse(request.release.repository.full_name);
    }

    return okResponse(
      {
        release: {
          tag: explicitTag,
          record: {
            owner: 'tool',
            status: 'observed',
            system: 'github',
            idempotency_key: `${request.release.repository.full_name}:${explicitTag}`,
          },
        },
        extensions: {
          'builtin:semantic-release': {
            observed: true,
            noop: false,
          },
        },
      },
      {
        release_created: true,
        tag: explicitTag,
      },
      'observed semantic-release output',
    );
  },
};

function noopSemanticReleaseResponse(repositoryFullName: string): PluginResponse {
  return {
    status: 'noop',
    release_patch: {
      release: {
        record: {
          owner: 'tool',
          status: 'noop',
          system: 'github',
        },
      },
      extensions: {
        'builtin:semantic-release': {
          observed: false,
          noop: true,
          reason: 'no release tag was provided by semantic-release',
        },
      },
    },
    outputs: {
      release_created: false,
      repository: repositoryFullName,
      reason: 'no-release-tag',
    },
    logs: [
      {
        level: 'info',
        message: 'semantic-release produced no release tag; treating this run as a release noop',
      },
    ],
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
