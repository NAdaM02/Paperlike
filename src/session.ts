/**
 * In-memory session tracking for notebook instances.
 * Persists during the lifetime of this app instance; resets on app restart.
 */

export type NotebookSession = {
  lastNotePath?: string;
  lastCam?: { x: number; y: number; z: number };
  noteCams?: Record<string, { x: number; y: number; z: number }>;
};

const sessionNotebooks = new Map<string, NotebookSession>();

export function hasOpenedNotebookInSession(notebookPath: string): boolean {
  return sessionNotebooks.has(notebookPath);
}

export function getNotebookSession(notebookPath: string): NotebookSession | undefined {
  return sessionNotebooks.get(notebookPath);
}

export function recordNotebookSession(
  notebookPath: string,
  update: Partial<NotebookSession>,
): void {
  const cur = sessionNotebooks.get(notebookPath) ?? {};
  sessionNotebooks.set(notebookPath, {
    ...cur,
    ...update,
    noteCams: {
      ...cur.noteCams,
      ...update.noteCams,
    },
  });
}
