/**
 * Pipeline IPC.
 *
 * `runSource` and `runAll` deliberately return as soon as the run is accepted.
 * A full sweep is measured in minutes; holding an IPC promise open for that long
 * would make the renderer look hung, and progress already streams over
 * 'pipeline:progress' and 'pipeline:log'.
 *
 * Argument validation lives in src/shared/schemas.ts (sourceKeySchema), applied
 * by the guarded `handle` — no second key list here to drift out of sync.
 */

import { handle } from './guard.js';
import { appendLog, getPipelineState, runAll, runSource, setSourceEnabled, stopPipeline } from '../pipeline/run.js';
import type { SourceKey } from '../../shared/ipc.js';

export function registerPipelineIpc(): void {
  handle('getPipeline', async () => getPipelineState());

  handle('runSource', async (key: SourceKey) => {
    void runSource(key).catch((err) => {
      appendLog(key, 'error', err instanceof Error ? err.message : String(err));
    });
  });

  handle('runAll', async () => {
    void runAll().catch((err) => {
      appendLog('pipeline', 'error', err instanceof Error ? err.message : String(err));
    });
  });

  handle('stopPipeline', async () => {
    stopPipeline();
  });

  handle('setSourceEnabled', async (key: SourceKey, enabled: boolean) => {
    setSourceEnabled(key, enabled);
  });
}
