import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// De stekker houdt locks en caches in het geheugen; twee processen op dezelfde
// runtime-map zouden elkaars bestanden beschadigen. Deze lease-lock zorgt dat er per
// runtime-map maar één instantie actief is.
//
// - De eigenaar vernieuwt elke heartbeatMs zijn heartbeat in het lockbestand.
// - Een lock waarvan de heartbeat ouder is dan leaseMs, is verlopen en mag worden overgenomen.
// - Een lock van een eerdere incarnatie van hetzelfde proces (zelfde hostname én pid,
//   zoals na `docker restart`) wordt direct overgenomen.
// - Een tweede, levende instantie wacht maximaal wachtMs en weigert dan te starten.
export class RuntimeLock {
  constructor({
    lockPath,
    leaseMs = 15000,
    heartbeatMs = 5000,
    wachtMs = leaseMs + 5000,
    hostname = os.hostname(),
    pid = process.pid,
    now = () => Date.now(),
    onVerloren = () => {}
  }) {
    Object.assign(this, { lockPath, leaseMs, heartbeatMs, wachtMs, hostname, pid, now, onVerloren });
    this.token = crypto.randomUUID();
    this.heartbeat = undefined;
  }

  async verkrijg() {
    const start = this.now();
    fs.mkdirSync(path.dirname(this.lockPath), { recursive: true });

    for (;;) {
      const huidig = this.lees();

      if (!huidig || this.isVorigeIncarnatie(huidig) || this.isVerlopen(huidig)) {
        this.schrijf();
        // Twee instanties die tegelijk starten, kunnen allebei schrijven; de laatste wint.
        // Wie na een korte pauze niet meer eigenaar is, probeert het opnieuw.
        await pauze(Math.min(100, this.heartbeatMs));

        if (this.isEigenaar()) {
          this.heartbeat = setInterval(() => this.vernieuw(), this.heartbeatMs);
          this.heartbeat.unref();
          return;
        }
      }

      if (this.now() - start >= this.wachtMs) {
        const eigenaar = this.lees();
        throw new Error(
          `Runtime-map is in gebruik door een andere stekkerinstantie (${eigenaar?.hostname}, pid ${eigenaar?.pid}). `
          + 'Gebruik per instantie een eigen runtime-volume.'
        );
      }

      await pauze(Math.min(1000, this.heartbeatMs));
    }
  }

  vrijgeven() {
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;

    if (this.isEigenaar()) {
      fs.rmSync(this.lockPath, { force: true });
    }
  }

  vernieuw() {
    if (!this.isEigenaar()) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
      this.onVerloren(this.lees());
      return;
    }

    this.schrijf();
  }

  isEigenaar() {
    return this.lees()?.token === this.token;
  }

  isVorigeIncarnatie(lock) {
    return lock.hostname === this.hostname && lock.pid === this.pid && lock.token !== this.token;
  }

  isVerlopen(lock) {
    return this.now() - lock.heartbeat > this.leaseMs;
  }

  lees() {
    try {
      return JSON.parse(fs.readFileSync(this.lockPath, 'utf8'));
    } catch {
      return undefined;
    }
  }

  schrijf() {
    const tijdelijk = `${this.lockPath}.${this.token}.tmp`;
    fs.writeFileSync(tijdelijk, JSON.stringify({
      hostname: this.hostname,
      pid: this.pid,
      token: this.token,
      heartbeat: this.now()
    }));
    fs.renameSync(tijdelijk, this.lockPath);
  }
}

function pauze(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
