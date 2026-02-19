/**
 * Non-interactive mode detection.
 * Non-interactive when: --no-interactive flag is set, or stdout is not a TTY.
 */
let _forceNonInteractive = false;

export function setNonInteractive(v: boolean): void {
  _forceNonInteractive = v;
}

export function isInteractive(): boolean {
  if (_forceNonInteractive) return false;
  return !!process.stdout.isTTY;
}
