export function isLoopbackAddress(remoteAddress: string | undefined): boolean {
  return (
    remoteAddress === '127.0.0.1' ||
    remoteAddress === '::1' ||
    remoteAddress === '::ffff:127.0.0.1'
  );
}
