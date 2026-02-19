let _jsonMode = false;

export function setJsonMode(v: boolean): void {
  _jsonMode = v;
}

export function globalJsonMode(): boolean {
  return _jsonMode;
}
