/**
 * Shared function-id contract. Used by BOTH graph analysis and debug integration,
 * so ids produced on either side match exactly.
 *
 * Format: `<absolutePath>::<functionName>`, e.g. `/Users/me/project/app.py::sum`.
 */
export function makeId(absoluteFilePath: string, functionName: string): string {
  return `${absoluteFilePath}::${functionName}`;
}
