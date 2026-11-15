import { PLUGIN_VERSION } from './version.js';

export const GITHUB_REPOSITORY_URL = 'https://github.com/NAS4Killer/Ai-Quota';
export const GITHUB_VERSION_URL = 'https://api.github.com/repos/NAS4Killer/Ai-Quota/contents/de.ai-quota.sdPlugin/manifest.json';

// Stream Deck uses four numeric version components, rather than semver strings.
export function compareVersions(left, right) {
  const parse = value => typeof value === 'string' && /^\d{1,5}(\.\d{1,5}){3}$/.test(value)
    ? value.split('.').map(Number) : null;
  const a = parse(left), b = parse(right);
  if (!a || !b || [...a, ...b].some(value => value > 65535)) return null;
  for (let index = 0; index < 4; index++) {
    if (a[index] !== b[index]) return Math.sign(a[index] - b[index]);
  }
  return 0;
}

export class UpdateChecker {
  constructor({ currentVersion = PLUGIN_VERSION, fetchImpl = globalThis.fetch, timeoutMs = 8000, onChange = () => {} } = {}) {
    this.currentVersion = currentVersion;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.onChange = onChange;
    this.available = false;
    this.checked = false;
    this.pending = null;
    this.controller = null;
    this.disposed = false;
  }

  check() {
    if (this.disposed || this.checked) return Promise.resolve(this.available);
    if (this.pending) return this.pending;
    this.controller = new AbortController();
    this.pending = this.read(this.controller.signal).finally(() => {
      this.checked = true;
      this.pending = null;
      this.controller = null;
    });
    return this.pending;
  }

  async read(signal) {
    const timeout = setTimeout(() => this.controller?.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(GITHUB_VERSION_URL, {
        headers: { Accept: 'application/vnd.github.raw+json', 'User-Agent': `Ai-Quota/${this.currentVersion}` },
        cache: 'no-store',
        signal
      });
      if (!response.ok) return false;
      const manifest = await response.json();
      if (!this.disposed && !signal.aborted && manifest?.UUID === 'de.ai-quota') {
        this.available = compareVersions(manifest.Version, this.currentVersion) === 1;
      }
    } catch {
      // An unavailable update service must not interrupt quota polling or login.
      this.available = false;
    } finally {
      clearTimeout(timeout);
    }
    if (!this.disposed) this.onChange();
    return this.available;
  }

  dispose() {
    this.disposed = true;
    this.controller?.abort();
  }
}
