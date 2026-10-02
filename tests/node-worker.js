import { parentPort, workerData } from 'node:worker_threads';
globalThis.self = { postMessage: value => parentPort.postMessage(value), onmessage: null };
await import(workerData.url);
parentPort.on('message', data => globalThis.self.onmessage({ data }));
