// The same web image serves local Docker and the VPS, so the environment is read from the
// hostname at runtime. Only loopback hosts are labelled; real domains show no badge.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function isLocalHost(hostname: string) {
  return LOCAL_HOSTS.has(hostname.toLowerCase());
}
