import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import type { JsonValue } from "../domain/types.js";
import { redactForEvidence } from "./redaction.js";

export interface EvidenceEvent {
  sequence: number;
  timestamp: string;
  runId: string;
  type: string;
  payload: JsonValue;
}

export class EvidenceRecorder {
  readonly runId: string;
  readonly directory: string;
  readonly eventsPath: string;
  readonly sensitiveValues: ReadonlySet<string>;
  #sequence = 0;

  private constructor(directory: string, runId: string, sensitiveValues: ReadonlySet<string>) {
    this.directory = directory;
    this.runId = runId;
    this.eventsPath = join(directory, "events.jsonl");
    this.sensitiveValues = sensitiveValues;
  }

  static async create(
    root: string,
    kind: "discovery" | "replay",
    sensitiveValues: ReadonlySet<string> = new Set(),
    runId = `${kind}-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`,
  ): Promise<EvidenceRecorder> {
    const directory = join(root, runId);
    await mkdir(join(directory, "screenshots"), { recursive: true });
    await writeFile(join(directory, "events.jsonl"), "", "utf8");
    return new EvidenceRecorder(directory, runId, sensitiveValues);
  }

  async event(type: string, payload: unknown): Promise<EvidenceEvent> {
    const event: EvidenceEvent = {
      sequence: ++this.#sequence,
      timestamp: new Date().toISOString(),
      runId: this.runId,
      type,
      payload: redactForEvidence(payload, this.sensitiveValues),
    };
    await appendFile(this.eventsPath, `${JSON.stringify(event)}\n`, "utf8");
    return event;
  }

  screenshotPath(label: string): string {
    const safeLabel = label.replace(/[^a-z0-9_-]+/gi, "-").toLowerCase();
    return join(this.directory, "screenshots", `${String(this.#sequence + 1).padStart(3, "0")}-${safeLabel}.png`);
  }

  relativePath(path: string): string {
    return relative(this.directory, path);
  }
}
