function canonicalDarwinPath(scope: string): string {
  const normalized = scope.normalize("NFD").toLowerCase();
  if (normalized === "**") return "";
  const recursive = normalized.indexOf("/**");
  return recursive === -1 ? normalized : normalized.slice(0, recursive);
}

export function logicalPathScopesOverlap(first: string, second: string): boolean {
  const left = canonicalDarwinPath(first);
  const right = canonicalDarwinPath(second);
  if (left === "" || right === "") return true;
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export function logicalPathSetsOverlap(first: readonly string[], second: readonly string[]): boolean {
  return first.some((left) => second.some((right) => logicalPathScopesOverlap(left, right)));
}
