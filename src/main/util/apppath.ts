import path from 'node:path';

/**
 * Map an app:// pathname onto a file inside `root`, or return null if it
 * cannot be served: traversal outside the root (including the sibling-prefix
 * case, `renderer-evil/` beside `renderer/`), or a malformed percent-escape,
 * which decodeURIComponent turns into a thrown URIError.
 *
 * Pure so the boundary cases are unit-testable without an Electron runtime.
 */
export function resolveWithin(root: string, pathname: string): string | null {
  const rel = pathname === '/' || pathname === '' ? '/index.html' : pathname;
  let decoded: string;
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    return null;
  }
  const filePath = path.join(root, decoded);
  if (filePath !== root && !filePath.startsWith(root + path.sep)) return null;
  return filePath;
}
