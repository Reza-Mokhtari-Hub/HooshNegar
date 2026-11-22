declare module 'cloudflare:workers' {
  export abstract class DurableObject<Env = Record<string, unknown>> {
    protected readonly ctx: {
      waitUntil(promise: Promise<unknown>): void;
      blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
      storage: {
        sql: {
          exec<T extends Record<string, unknown> = Record<string, unknown>>(
            query: string,
            ...bindings: unknown[]
          ): {
            columnNames: string[];
            raw(): IterableIterator<unknown[]>;
            toArray(): T[];
            one(): T;
          };
        };
        transactionSync<T>(closure: () => T): T;
      };
    };
    protected readonly env: Env;
    constructor(ctx: unknown, env: Env);
    fetch?(request: Request): Response | Promise<Response>;
  }
}
