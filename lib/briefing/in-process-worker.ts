// A WorkerLike that runs the worker core in the same thread, for unit tests and the Node
// model test. Messages cross with structuredClone and their transfer lists, as they
// would between a page and a real worker, and arrive on a later task, never at once.

import type { WorkerLike } from "./worker-renderer";
import { createWorkerCore, type WorkerCoreDeps } from "./worker-core";
import type { WorkerReply, WorkerRequest } from "./worker-protocol";

export interface InProcessWorker extends WorkerLike {
  /** Every request the page side sent, in order. */
  readonly sent: WorkerRequest[];
  /** Simulates a worker crash (an "error" event). */
  crash(message: string): void;
  readonly terminated: boolean;
}

const later = (fn: () => void) => setTimeout(fn, 0);

export function inProcessWorker(deps: Omit<WorkerCoreDeps, "post">): InProcessWorker {
  const messageListeners: ((event: { data: WorkerReply }) => void)[] = [];
  const errorListeners: ((event: { message?: string }) => void)[] = [];
  const sent: WorkerRequest[] = [];
  let terminated = false;

  const core = createWorkerCore({
    ...deps,
    post(reply, transfer = []) {
      if (terminated) return;
      const copy = structuredClone(reply, { transfer: transfer as Transferable[] });
      later(() => {
        if (!terminated) for (const listener of messageListeners) listener({ data: copy });
      });
    },
  });

  return {
    sent,
    get terminated() {
      return terminated;
    },
    postMessage(message, transfer = []) {
      if (terminated) return;
      sent.push(message);
      const copy = structuredClone(message, { transfer: transfer as Transferable[] });
      later(() => {
        if (!terminated) void core.handle(copy);
      });
    },
    addEventListener(type: "message" | "error", listener: never) {
      if (type === "message") messageListeners.push(listener);
      else errorListeners.push(listener);
    },
    crash(message) {
      later(() => {
        for (const listener of errorListeners) listener({ message });
      });
    },
    terminate() {
      terminated = true;
    },
  } as InProcessWorker;
}
