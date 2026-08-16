// D1Database 互換の最小スタブ。node:sqlite（実SQLite）で実行するため、
// 条件付きUPDATE・changes()・トランザクションの意味論を本物と同じに検証できる。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface D1StubOptions {
  // 一致したSQLの実行時にthrowさせる（batchのrollback検証用）
  failOn?: RegExp;
}

interface RunResult {
  meta: { changes: number };
}

class StubPreparedStatement {
  private values: unknown[] = [];

  constructor(private readonly stub: D1Stub, readonly sql: string) {}

  bind(...values: unknown[]): this {
    this.values = values;
    return this;
  }

  executeSync(): RunResult {
    if (this.stub.options.failOn?.test(this.sql)) {
      throw new Error(`Injected failure for: ${this.sql.slice(0, 60)}`);
    }
    const result = this.stub.database.prepare(this.sql).run(...(this.values as never[]));
    return { meta: { changes: Number(result.changes) } };
  }

  async run(): Promise<RunResult> {
    return this.executeSync();
  }

  async first<T>(): Promise<T | null> {
    if (this.stub.options.failOn?.test(this.sql)) {
      throw new Error(`Injected failure for: ${this.sql.slice(0, 60)}`);
    }
    const row = this.stub.database.prepare(this.sql).get(...(this.values as never[]));
    return (row as T | undefined) ?? null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    if (this.stub.options.failOn?.test(this.sql)) {
      throw new Error(`Injected failure for: ${this.sql.slice(0, 60)}`);
    }
    return { results: this.stub.database.prepare(this.sql).all(...(this.values as never[])) as T[] };
  }
}

export class D1Stub {
  readonly database: DatabaseSync;

  constructor(readonly options: D1StubOptions = {}) {
    this.database = new DatabaseSync(':memory:');
    const migration = readFileSync(
      path.resolve(import.meta.dirname, '..', '..', 'workers', 'console', 'migrations', '0001_init.sql'),
      'utf8',
    );
    this.database.exec(migration);
  }

  prepare(sql: string): StubPreparedStatement {
    return new StubPreparedStatement(this, sql);
  }

  // D1のbatch()と同じく1トランザクションで実行し、途中失敗で全体をrollbackする
  async batch(statements: StubPreparedStatement[]): Promise<RunResult[]> {
    this.database.exec('BEGIN');
    try {
      const results = statements.map((statement) => statement.executeSync());
      this.database.exec('COMMIT');
      return results;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}

export interface R2StubObject {
  body: string;
  contentType?: string;
}

// R2Bucket 互換の最小スタブ（get のみ）
export class R2Stub {
  constructor(private readonly objects: Map<string, R2StubObject> = new Map()) {}

  put(key: string, value: R2StubObject): void {
    this.objects.set(key, value);
  }

  async get(key: string): Promise<{ body: string; httpMetadata?: { contentType?: string } } | null> {
    const found = this.objects.get(key);
    if (!found) return null;
    return { body: found.body, httpMetadata: { contentType: found.contentType } };
  }
}

export function executionContextStub(): ExecutionContext {
  return {
    waitUntil(promise: Promise<unknown>): void {
      promise.catch(() => {});
    },
    passThroughOnException(): void {},
    props: {},
  } as unknown as ExecutionContext;
}
