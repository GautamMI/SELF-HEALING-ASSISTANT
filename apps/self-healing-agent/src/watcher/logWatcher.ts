import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import { config } from '../config/env';
import { createLogger } from '../utils/logger';

const log = createLogger('log-watcher');

export interface LogWatcherEvents {
  line: (line: string) => void;
  error: (error: Error) => void;
}

export declare interface LogWatcher {
  on<E extends keyof LogWatcherEvents>(event: E, listener: LogWatcherEvents[E]): this;
  emit<E extends keyof LogWatcherEvents>(event: E, ...args: Parameters<LogWatcherEvents[E]>): boolean;
}

/**
 * Tails a newline-delimited JSON log file.
 *
 * Implementation notes:
 *  - We track a byte offset and read only the delta, so memory stays flat no
 *    matter how large the file grows.
 *  - Truncation/rotation is detected by comparing size against the offset and
 *    rewinding to 0, which is what happens when `npm run logs:clear` runs.
 *  - Reads are serialised behind `reading`/`rereadRequested` so a burst of
 *    change events can never interleave two partial reads.
 */
export class LogWatcher extends EventEmitter {
  private watcher?: FSWatcher;
  private offset = 0;
  private carry = '';
  private reading = false;
  private rereadRequested = false;
  private closed = false;

  constructor(private readonly filePath: string = config.paths.logFile) {
    super();
  }

  async start(): Promise<void> {
    this.ensureFileExists();

    const stats = await fs.promises.stat(this.filePath);
    this.offset = config.watcher.processExistingOnStart ? 0 : stats.size;

    this.watcher = chokidar.watch(this.filePath, {
      persistent: true,
      ignoreInitial: true,
      usePolling: config.watcher.usePolling,
      interval: config.watcher.pollIntervalMs,
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
    });

    this.watcher
      .on('add', () => void this.read())
      .on('change', () => void this.read())
      .on('unlink', () => {
        log.warn({ file: this.filePath }, 'log file removed; waiting for it to reappear');
        this.offset = 0;
        this.carry = '';
      })
      .on('error', (error) => this.emit('error', error as Error));

    log.info(
      { file: this.filePath, startOffset: this.offset, polling: config.watcher.usePolling },
      'watching error log',
    );

    if (config.watcher.processExistingOnStart) await this.read();
  }

  private ensureFileExists(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, '', 'utf8');
      log.info({ file: this.filePath }, 'created empty log file');
    }
  }

  private async read(): Promise<void> {
    if (this.closed) return;

    if (this.reading) {
      this.rereadRequested = true;
      return;
    }

    this.reading = true;

    try {
      const stats = await fs.promises.stat(this.filePath);

      if (stats.size < this.offset) {
        log.info({ file: this.filePath }, 'log truncated or rotated; rewinding to start');
        this.offset = 0;
        this.carry = '';
      }

      if (stats.size === this.offset) return;

      const chunk = await this.readSlice(this.offset, stats.size);
      this.offset = stats.size;

      const payload = this.carry + chunk;
      const lines = payload.split('\n');
      this.carry = lines.pop() ?? ''; // trailing partial line stays buffered

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) this.emit('line', trimmed);
      }
    } catch (error) {
      this.emit('error', error as Error);
    } finally {
      this.reading = false;
      if (this.rereadRequested) {
        this.rereadRequested = false;
        void this.read();
      }
    }
  }

  private readSlice(start: number, end: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      const stream = fs.createReadStream(this.filePath, { start, end: Math.max(start, end - 1), encoding: undefined });

      stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      stream.on('error', reject);
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
  }

  async stop(): Promise<void> {
    this.closed = true;
    await this.watcher?.close();
    log.info('watcher stopped');
  }
}
