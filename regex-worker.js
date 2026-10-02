import { processRegexRequest } from './core.js';

self.onmessage = event => self.postMessage(processRegexRequest(event.data));
self.postMessage({ ready: true });
