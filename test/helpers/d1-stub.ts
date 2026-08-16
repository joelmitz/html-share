// D1Database 互換の最小スタブ。node:sqlite（実SQLite）で実行するため、
// 条件付きUPDATE・changes()・トランザクションの意味論を本物と同じに検証できる。
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
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
    const migrationsDir = path.resolve(import.meta.dirname, '..', '..', 'workers', 'console', 'migrations');
    const files = readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort();
    for (const file of files) {
      this.database.exec(readFileSync(path.join(migrationsDir, file), 'utf8'));
    }
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
  // 省略時はbodyのmd5から自動算出する（本物のR2の単一パートPutObjectのetagは
  // コンテンツのmd5そのもの、という意味論に合わせる。マルチパートを模擬したい
  // テストだけ明示的に非hex値を渡す）
  etag?: string;
}

// R2Bucket 互換の最小スタブ（get・list・delete）。
// list はキーの辞書順で cursor=返した件数の文字列 という単純な実装（本物の
// カーソル形式とは異なるが、truncated・ページング挙動の検証には十分）。
export class R2Stub {
  private readonly objects: Map<string, R2StubObject> = new Map();

  constructor(initial: Map<string, R2StubObject> = new Map()) {
    for (const [key, value] of initial) this.objects.set(key, value);
  }

  put(key: string, value: R2StubObject): void {
    this.objects.set(key, value);
  }

  async get(key: string): Promise<{ body: string; httpMetadata?: { contentType?: string } } | null> {
    const found = this.objects.get(key);
    if (!found) return null;
    return { body: found.body, httpMetadata: { contentType: found.contentType } };
  }

  async list(
    options: { prefix?: string; cursor?: string; limit?: number } = {},
  ): Promise<{ objects: { key: string; size: number; etag: string }[]; truncated: boolean; cursor?: string }> {
    const prefix = options.prefix ?? '';
    const limit = options.limit ?? 1000;
    const matched = [...this.objects.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .sort(([a], [b]) => a.localeCompare(b));
    // cursorは「直前に返した最後のキー」そのもの（数値インデックスではない）。
    // purge/GCはlist→delete→（同じcursorで）listを繰り返すため、位置インデックスの
    // cursorだと直前のdeleteでmatchedが縮み、意味がずれる（本物のR2の一覧は
    // カーソル発行後の削除でも後続ページの取得が壊れない。実測で判明したバグ:
    // 1501件を1000件ずつ2ページで取得する際、1ページ目削除後の2ページ目取得が
    // 空になっていた）。キー文字列そのものをcursorにすれば、direct順序を
    // 保ったまま「そのキーより後」を返すだけなので、間の削除に影響されない。
    const startIndex = options.cursor
      ? matched.findIndex(([key]) => key > options.cursor!)
      : 0;
    const from = startIndex === -1 ? matched.length : startIndex;
    const page = matched.slice(from, from + limit);
    const truncated = from + page.length < matched.length;
    return {
      objects: page.map(([key, value]) => ({
        key,
        size: Buffer.byteLength(value.body),
        etag: value.etag ?? createHash('md5').update(value.body).digest('hex'),
      })),
      truncated,
      ...(truncated ? { cursor: page[page.length - 1][0] } : {}),
    };
  }

  async delete(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key);
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
