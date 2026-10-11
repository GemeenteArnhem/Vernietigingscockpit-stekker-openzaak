FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV STEKKER_RUNTIME_SELECTIES_PATH=/app/runtime/selecties
ENV STEKKER_RUNTIME_VERNIETIGINGEN_PATH=/app/runtime/vernietigingen
ENV STEKKER_RUNTIME_JOURNAAL_PATH=/app/runtime/journaal
ENV STEKKER_RUNTIME_IDEMPOTENCY_PATH=/app/runtime/idempotency
ENV STEKKER_RUNTIME_LOCK_PATH=/app/runtime/instance.lock

COPY package.json ./
COPY src ./src
# Het seedscript voor een (test)Open Zaak draait in acceptatie vanuit dit image (openzaak-seed).
COPY scripts ./scripts

# Runtime-state staat op een volume en is van de niet-root gebruiker `node`.
RUN mkdir -p /app/runtime/selecties /app/runtime/vernietigingen /app/runtime/journaal /app/runtime/idempotency \
  && chown -R node:node /app/runtime

USER node

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"

# node direct als PID 1, zodat SIGTERM de stekker netjes laat afsluiten.
CMD ["node", "src/index.js"]
