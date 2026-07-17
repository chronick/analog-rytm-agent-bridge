import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface JournalEntry<TEvent> {
  cursor: number;
  receivedAt: string;
  event: TEvent;
}

export class EventJournal<TEvent> {
  private entries: JournalEntry<TEvent>[] = [];
  private nextCursor = 1;
  private readonly journalPath?: string;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: { directory?: string } = {}) {
    this.journalPath = options.directory ? join(options.directory, "journal", "events.jsonl") : undefined;
  }

  async init(): Promise<void> {
    if (!this.journalPath) return;
    try {
      const contents = await readFile(this.journalPath, "utf8");
      const entries: JournalEntry<TEvent>[] = [];
      for (const line of contents.split("\n").filter(Boolean)) {
        try {
          entries.push(parseEntry<TEvent>(line));
        } catch {
          // A crash mid-append leaves a torn trailing line; recovery must
          // skip it instead of refusing to start forever.
          console.error(`EventJournal: skipping malformed journal line: ${line}`);
        }
      }
      entries.sort((a, b) => a.cursor - b.cursor);
      this.entries = entries;
      this.nextCursor = (entries.at(-1)?.cursor ?? 0) + 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async append(event: TEvent): Promise<JournalEntry<TEvent>> {
    const entry: JournalEntry<TEvent> = {
      cursor: this.nextCursor++,
      receivedAt: new Date().toISOString(),
      event,
    };
    this.entries.push(entry);
    if (this.journalPath) {
      this.writeChain = this.writeChain.catch(() => undefined).then(async () => {
        await mkdir(dirname(this.journalPath as string), { recursive: true });
        await appendFile(this.journalPath as string, `${JSON.stringify(entry)}\n`, "utf8");
      });
      await this.writeChain;
    }
    return entry;
  }

  page(afterCursor = 0, limit = 100): JournalEntry<TEvent>[] {
    if (!Number.isInteger(afterCursor) || afterCursor < 0) throw new Error("afterCursor must be a non-negative integer");
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) throw new Error("limit must be an integer between 1 and 1000");
    return this.entries.filter((entry) => entry.cursor > afterCursor).slice(0, limit).map((entry) => structuredClone(entry));
  }

  tail(limit = 100): JournalEntry<TEvent>[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) throw new Error("limit must be an integer between 1 and 1000");
    return this.entries.slice(-limit).map((entry) => structuredClone(entry));
  }
}

function parseEntry<TEvent>(line: string): JournalEntry<TEvent> {
  const entry = JSON.parse(line) as JournalEntry<TEvent>;
  if (!Number.isInteger(entry.cursor) || entry.cursor < 1 || typeof entry.receivedAt !== "string" || !entry.event) {
    throw new Error("invalid event journal entry");
  }
  return entry;
}

