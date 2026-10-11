import crypto from 'node:crypto';
import { ConflictError } from './errors.js';

// Idempotency-Key per endpoint (scope), ADR-0004. Dezelfde key met dezelfde inhoud levert
// dezelfde resource in de actuele stand; dezelfde key met andere inhoud geeft 409.
// Of de key verplicht is, bewaakt de HTTP-laag (Stekker API v2: altijd verplicht).
export class Idempotentie {
  constructor(repository) {
    this.repository = repository;
  }

  controleer(scope, idempotencyKey, request) {
    const key = typeof idempotencyKey === 'string' ? idempotencyKey.trim() : '';

    if (!key) {
      return {};
    }

    const vingerafdruk = vingerafdrukVan(request);
    const registratie = this.repository.find(scope, key);

    if (registratie && registratie.vingerafdruk !== vingerafdruk) {
      throw new ConflictError(
        'IDEMPOTENCY_KEY_REUSED',
        'Idempotency-Key is al gebruikt voor een verzoek met een andere inhoud.'
      );
    }

    return { scope, key, vingerafdruk, registratie };
  }

  registreer({ scope, key, vingerafdruk }, gegevens) {
    if (key) {
      this.repository.save(scope, key, { vingerafdruk, ...gegevens });
    }
  }
}

export function vingerafdrukVan(waarde) {
  return crypto.createHash('sha256').update(canoniekeJson(waarde)).digest('hex');
}

// JSON met gesorteerde sleutels, zodat de volgorde van velden in het verzoek niet uitmaakt.
export function canoniekeJson(waarde) {
  if (Array.isArray(waarde)) {
    return `[${waarde.map(canoniekeJson).join(',')}]`;
  }

  if (waarde && typeof waarde === 'object') {
    return `{${Object.keys(waarde)
      .filter((sleutel) => waarde[sleutel] !== undefined)
      .sort()
      .map((sleutel) => `${JSON.stringify(sleutel)}:${canoniekeJson(waarde[sleutel])}`)
      .join(',')}}`;
  }

  return JSON.stringify(waarde) ?? 'null';
}
