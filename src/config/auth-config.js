// Configuratie voor OAuth2-bearer-tokenvalidatie (zie src/api/jwt-auth.js).
export function parseAuthConfig(env = process.env) {
  const enabled = env.AUTH_ENABLED === 'true';
  const config = {
    enabled,
    issuer: env.AUTH_ISSUER?.trim() || undefined,
    jwksUrl: env.AUTH_JWKS_URL?.trim() || undefined,
    audience: env.AUTH_AUDIENCE?.trim() || undefined
  };

  if (enabled && (!config.issuer || !config.jwksUrl)) {
    throw new Error('AUTH_ENABLED=true vereist AUTH_ISSUER en AUTH_JWKS_URL.');
  }

  return config;
}
