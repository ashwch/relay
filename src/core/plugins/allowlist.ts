import type { LoadedConfig } from '../config/types.js';

export class PluginAllowlistError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export function assertPluginAllowed(loaded: LoadedConfig, pluginRef: string, options?: { ci?: boolean }): void {
  if (pluginRef.startsWith('builtin:')) {
    return;
  }

  const allowlist = new Set(loaded.config.plugin_allowlist ?? []);
  const inCi = options?.ci ?? process.env.CI === 'true';

  if (!allowlist.has(pluginRef)) {
    throw new PluginAllowlistError(`plugin ${pluginRef} is not allowlisted`);
  }

  if (pluginRef.startsWith('path:') && inCi && !loaded.config.allow_local_plugins) {
    throw new PluginAllowlistError(`path plugin ${pluginRef} is disabled in CI without allow_local_plugins=true`);
  }
}
