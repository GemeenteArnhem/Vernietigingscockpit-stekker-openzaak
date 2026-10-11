import { laadEnvBestand } from './config/env-bestand.js';

// Eerst .env laden, dan pas de rest importeren: de configuratie wordt bij het
// importeren uit process.env gelezen.
laadEnvBestand();
await import('./start.js');
