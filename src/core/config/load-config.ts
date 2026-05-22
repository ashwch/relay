import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

import type { LoadedConfig } from './types.js';
import { validateConfig } from './validate-config.js';

export function loadConfig(configPath: string): LoadedConfig {
  const absolutePath = path.resolve(configPath);
  const raw = fs.readFileSync(absolutePath, 'utf8');
  const parsed: unknown = YAML.parse(raw);
  const config = validateConfig(parsed);

  return {
    path: absolutePath,
    dir: path.dirname(absolutePath),
    config,
  };
}
