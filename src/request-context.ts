import { AsyncLocalStorage } from "async_hooks";

export interface RequestContext {
  channelId: string;
  threadTs: string;
  sessionKey: string;
  cwd: string;
  userId?: string;
}

const als = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(ctx: RequestContext, fn: () => Promise<T>): Promise<T> {
  return als.run(ctx, fn);
}

export function getRequestContext(): RequestContext | undefined {
  return als.getStore();
}
