import { okResponse, type PluginHandler } from '../../../../core/plugins/request-response.js';

export const semanticReleaseTool: PluginHandler = {
  async observe(request) {
    const explicitTag = readString(request.inputs.args.tag)
      ?? readString(request.inputs.args.release_tag)
      ?? readString(request.inputs.env.RELEASE_TAG);

    if (!request.release) {
      throw new Error('semantic-release observe requires an existing release document');
    }

    const tag = explicitTag ?? request.release.release.tag;
    if (!tag) {
      throw new Error('semantic-release observe requires an explicit tag or a precomputed release.tag');
    }

    return okResponse(
      {
        release: {
          tag,
          record: {
            owner: 'tool',
            status: 'observed',
            system: 'github',
            idempotency_key: `${request.release.repository.full_name}:${tag}`,
          },
        },
        extensions: {
          'builtin:semantic-release': {
            observed: true,
          },
        },
      },
      {},
      'observed semantic-release output',
    );
  },
};

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
