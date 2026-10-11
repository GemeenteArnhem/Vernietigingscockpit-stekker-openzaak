import crypto from 'node:crypto';
import { JsonFileStore } from './json-file-store.js';

// Scope en key kunnen willekeurige tekens bevatten; de bestandsnaam is daarom een hash.
export class FileIdempotencyRepository {
  #store;

  constructor(idempotencyPath) {
    this.#store = new JsonFileStore(idempotencyPath);
  }

  save(scope, key, registratie) {
    this.#store.save(bestandsId(scope, key), registratie);
    return registratie;
  }

  find(scope, key) {
    return this.#store.findById(bestandsId(scope, key));
  }
}

function bestandsId(scope, key) {
  return crypto.createHash('sha256').update(`${scope}
${key}`).digest('hex');
}
