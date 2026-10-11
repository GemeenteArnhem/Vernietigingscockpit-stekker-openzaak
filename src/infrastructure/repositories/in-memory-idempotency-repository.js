export class InMemoryIdempotencyRepository {
  #registraties = new Map();

  save(scope, key, registratie) {
    this.#registraties.set(`${scope}\n${key}`, structuredClone(registratie));
    return registratie;
  }

  find(scope, key) {
    const registratie = this.#registraties.get(`${scope}\n${key}`);
    return registratie ? structuredClone(registratie) : undefined;
  }
}
