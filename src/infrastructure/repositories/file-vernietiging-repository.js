import { JsonFileStore } from './json-file-store.js';

export class FileVernietigingRepository {
  #store;

  constructor(vernietigingenPath) {
    this.#store = new JsonFileStore(vernietigingenPath);
  }

  save(vernietiging) {
    this.#store.save(vernietiging.vernietigingId, vernietiging);
    return vernietiging;
  }

  findById(vernietigingId) {
    return this.#store.findById(vernietigingId);
  }

  findAll() {
    return this.#store.findAll();
  }
}
