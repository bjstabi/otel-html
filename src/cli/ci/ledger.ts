import { z } from 'zod';
import type { FileSystem } from '../../writer/ports.js';

/** D60: the pusher's folder (`.otel-html/publish/`) and the files the pusher and the collect step share. */
const LEDGER_FILE = 'uploads.json';
export const PID_FILE = 'pusher.pid';
export const STOP_FILE = 'pusher.stop';
export const LOG_FILE = 'pusher.log';

/** One finished upload: its artifact name, its sequence, and the manifest sources (`flush:0`, `compact:0..3`) it carried. */
interface UploadRecord {
  name: string;
  sequence: number;
  sources: string[];
  finishedAt: string;
}

/** `sequence`: the last one reserved (never reused); `shipped`: manifest sources already uploaded. */
export interface Ledger {
  sequence: number;
  shipped: string[];
  uploads: UploadRecord[];
}

const LedgerSchema: z.ZodType<Ledger> = z.strictObject({
  sequence: z.number().int().nonnegative(),
  shipped: z.array(z.string()),
  uploads: z.array(
    z.strictObject({
      name: z.string(),
      sequence: z.number().int().positive(),
      sources: z.array(z.string()),
      finishedAt: z.string(),
    }),
  ),
});

const emptyLedger = (): Ledger => ({ sequence: 0, shipped: [], uploads: [] });

/** The ledger in `publishDir`; an absent file is the empty ledger. A malformed one throws: guessing could reuse a sequence. */
export async function readLedger(fs: FileSystem, publishDir: string): Promise<Ledger> {
  const path = `${publishDir}/${LEDGER_FILE}`;
  if (!(await fs.exists(path))) return emptyLedger();
  return LedgerSchema.parse(JSON.parse(await fs.readText(path)));
}

export async function writeLedger(fs: FileSystem, publishDir: string, ledger: Ledger): Promise<void> {
  await fs.mkdirp(publishDir);
  await fs.writeTextAtomic(`${publishDir}/${LEDGER_FILE}`, `${JSON.stringify(ledger)}\n`);
}
