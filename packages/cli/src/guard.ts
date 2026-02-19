import { Config } from "./config.js";
import { exitWithError } from "./errors.js";

/**
 * Check that ossgard setup has been completed.
 * Exits with structured error if not configured.
 */
export function requireSetup(configDir?: string): true {
  const config = new Config(configDir);
  if (!config.isComplete()) {
    exitWithError("NOT_CONFIGURED", 'ossgard is not configured. Run "ossgard setup" first.', {
      suggestion: "ossgard setup",
      exitCode: 3,
    });
  }
  return true;
}
