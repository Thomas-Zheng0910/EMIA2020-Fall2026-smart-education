import { resolve } from 'node:path';
import { Store } from './db';
import { ModelGateway, envConfig } from './ai';
import { buildApp } from './app';
import { ensureStudents } from './seed';

const dataDir = resolve(process.env.DATA_DIR || 'data');
const store = new Store(resolve(dataDir, 'notebook.sqlite'));
ensureStudents(store);
const ai = new ModelGateway(envConfig());
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean);
const { app } = await buildApp({ store, ai, dataDir, allowedOrigins, indexDelayMs: Number(process.env.INDEX_DELAY_MS || 6000) });
const address = await app.listen({ port: Number(process.env.PORT || 4310), host: '127.0.0.1' });
console.log(`Notebook API ${address} · AI ${ai.configured ? ai.config.model : 'NOT CONFIGURED'} · data ${dataDir}`);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await app.close();
  store.close();
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
