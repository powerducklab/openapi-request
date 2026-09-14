declare module "postman-runtime" {
  /** Callback map accepted by run.start(). All handlers are optional. */
  export interface RunCallbacks {
    start?: (error: Error | null, cursor: any) => void;
    beforeIteration?: (error: Error | null, cursor: any) => void;
    iteration?: (error: Error | null, cursor: any) => void;
    beforeItem?: (error: Error | null, cursor: any, item: any) => void;
    item?: (
      error: Error | null,
      cursor: any,
      item: any,
      visualizer: any,
      result?: { isSkipped?: boolean },
    ) => void;
    beforePrerequest?: (
      error: Error | null,
      cursor: any,
      events: any[],
      item: any,
    ) => void;
    prerequest?: (
      error: Error | null,
      cursor: any,
      results: any[],
      item: any,
    ) => void;
    beforeTest?: (
      error: Error | null,
      cursor: any,
      events: any[],
      item: any,
    ) => void;
    test?: (
      error: Error | null,
      cursor: any,
      results: any[],
      item: any,
    ) => void;
    beforeRequest?: (
      error: Error | null,
      cursor: any,
      request: any,
      item: any,
    ) => void;
    request?: (
      error: Error | null,
      cursor: any,
      response: any,
      request: any,
      item: any,
      cookies: any[],
      history: any,
    ) => void;
    responseStart?: (
      error: Error | null,
      cursor: any,
      response: any,
      request: any,
      item: any,
      cookies: any[],
      history: any,
    ) => void;
    /** Fired for each complete server-sent event or body chunk. */
    responseData?: (cursor: any, data: Buffer) => void;
    response?: (
      error: Error | null,
      cursor: any,
      response: any,
      request: any,
      item: any,
      cookies: any[],
      history: any,
    ) => void;
    assertion?: (cursor: any, assertions: any[]) => void;
    console?: (cursor: any, level: string, ...logs: unknown[]) => void;
    exception?: (cursor: any, error: Error) => void;
    io?: (error: Error | null, cursor: any, trace: any, ...args: any[]) => void;
    done?: (error: Error | null) => void;
    [key: string]: ((...args: any[]) => void) | undefined;
  }

  export interface Run {
    start(callbacks: RunCallbacks): void;
    abort(): void;
    pause(callback?: (error?: Error | null) => void): void;
    resume(callback?: (error?: Error | null) => void): void;
  }

  export class Runner {
    constructor(options?: Record<string, any>);
    run(
      collection: any,
      options: Record<string, any>,
      callback: (error: Error | null, run: Run) => void,
    ): void;
  }

  export const Requester: {
    jar(store?: any): any;
    [key: string]: any;
  };

  export const version: string;

  const runtime: {
    Runner: typeof Runner;
    Requester: typeof Requester;
    version: string;
  };
  export default runtime;
}
