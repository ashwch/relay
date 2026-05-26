// Minimal example artifact verifier.
//
// Visual model:
//
//   PluginRequest (hook=verify)
//         ↓
//   read expected asset names from plugin config
//         ↓
//   compare against release.artifacts
//         ↓
//   PluginResponse with verification results
//
// This plugin demonstrates how an external verifier inspects the shared
// release document and returns structured verification output without
// performing any real side effects.
//
// Important rule for subprocess plugins:
//   stdout → PluginResponse JSON only
//   stderr → debug/log text
import { errorResponse, okResponse, runPluginCli } from "@ashwch/relay/plugin-sdk";

runPluginCli(async (request) => {
  const releaseArtifacts = Array.isArray(request.release?.artifacts)
    ? request.release.artifacts
    : [];

  const expectedNames = Array.isArray(request.config?.expected_asset_names)
    ? request.config.expected_asset_names
    : [];

  // Compare expected asset names against the release document.
  //
  // For each expected asset, check whether it appears in the release.
  // In a real verifier, you might also check sizes, checksums, or URLs.
  const seen = new Set(releaseArtifacts.map((/** @type {{ name: string }} */ a) => a.name));
  const missing = expectedNames.filter((/** @type {string} */ name) => !seen.has(name));
  const found = expectedNames.filter((/** @type {string} */ name) => seen.has(name));

  const allPresent = missing.length === 0;
  const verification = {
    expected: expectedNames,
    found,
    missing,
    all_present: allPresent,
  };

  const releasePatch = {
    extensions: {
      example_verifier: {
        saw_hook: request.hook,
        dry_run: request.dry_run,
        expected_asset_count: expectedNames.length,
        found_asset_count: found.length,
        missing_asset_count: missing.length,
      },
    },
  };

  if (!allPresent) {
    return errorResponse(
      `${missing.length}/${expectedNames.length} expected assets not found in release: ${missing.join(", ")}`,
      {
        release_patch: releasePatch,
        outputs: {
          verification,
        },
        log_message: `example-verifier: ${missing.length}/${expectedNames.length} assets missing: ${missing.join(", ")}`,
      },
    );
  }

  return okResponse(releasePatch, {
    verification,
  }, `example-verifier: all ${found.length} expected assets present`);
});
