import { Config } from "./config.js";

/**
 * Check that ossgard setup has been completed.
 * Returns true if setup is complete, false otherwise (with error message).
 */
export function requireSetup(configDir?: string): boolean {
  const config = new Config(configDir);
  if (!config.isComplete()) {
    console.error('ossgard is not configured. Run "ossgard setup" first.');
    process.exitCode = 1;
    return false;
  }
  return true;
}
