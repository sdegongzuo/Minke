/**
 * Match a navigation against the exact origins owned by the desktop shell.
 * Paths and query strings may vary, while lookalike hosts remain external.
 */
export function isInternalNavigation(
  value: string,
  roots: readonly (string | undefined)[],
): boolean {
  let origin: string;
  try {
    origin = new URL(value).origin;
  } catch {
    return false;
  }
  return roots.some((root) => {
    if (root === undefined) return false;
    try {
      return new URL(root).origin === origin;
    } catch {
      return false;
    }
  });
}

/**
 * Whether a URL is safe to hand to the operating system's external
 * handler (browser or mail client) when the shell refuses to navigate.
 */
export function canOpenExternally(value: string): boolean {
  try {
    return ["https:", "http:", "mailto:"].includes(
      new URL(value).protocol,
    );
  } catch {
    return false;
  }
}
