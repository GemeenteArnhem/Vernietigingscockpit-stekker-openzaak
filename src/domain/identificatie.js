import { STANDAARD_MDTO } from '../config/mdto-config.js';

// De technische sleutel uit een identificatielijst (zoals de Cockpit die terugstuurt).
export function technischeSleutel(identificatie, mdto = STANDAARD_MDTO) {
  return Array.isArray(identificatie)
    ? identificatie.find((item) => item?.identificatieBron === mdto.technischeBron)?.identificatieKenmerk
    : undefined;
}
