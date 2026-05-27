/**
 * Shared plugin-loading error.
 *
 * Why keep this in its own tiny file?
 *
 *   loader needs it
 *   git-cache needs it
 *
 * Putting the class in a leaf module keeps those files from importing each
 * other just to share one error type.
 */
export class PluginLoadError extends Error {
  constructor(message: string) {
    super(message);
  }
}
