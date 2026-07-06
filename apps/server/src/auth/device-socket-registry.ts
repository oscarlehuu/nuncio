/** WS application close code signalling the connection's device credential was revoked. */
export const DEVICE_REVOKED_CLOSE_CODE = 4401;

/** Minimal slice of a WebSocket the registry needs to sever a live connection. */
export interface ClosableSocket {
  close(code?: number, reason?: string): void;
}

/**
 * Tracks which live sockets a given device authorized, so revoking that device
 * can sever the connections it already opened — revocation must reach live
 * sockets, not just block future upgrades. Sockets untag themselves on close so
 * a later revoke never touches an already-gone connection.
 */
export class DeviceSocketRegistry {
  private readonly byDevice = new Map<string, Set<ClosableSocket>>();

  add(deviceId: string, socket: ClosableSocket): void {
    let set = this.byDevice.get(deviceId);
    if (!set) {
      set = new Set();
      this.byDevice.set(deviceId, set);
    }
    set.add(socket);
  }

  remove(deviceId: string, socket: ClosableSocket): void {
    const set = this.byDevice.get(deviceId);
    if (!set) {
      return;
    }
    set.delete(socket);
    if (set.size === 0) {
      this.byDevice.delete(deviceId);
    }
  }

  /** Closes every socket the device authorized; a no-op when it has none open. */
  closeForDevice(deviceId: string): void {
    const set = this.byDevice.get(deviceId);
    if (!set) {
      return;
    }
    // Snapshot first: close() fires the socket's 'close' handler which calls
    // remove(), mutating the set we would otherwise be iterating.
    for (const socket of [...set]) {
      socket.close(DEVICE_REVOKED_CLOSE_CODE, 'device revoked');
    }
    this.byDevice.delete(deviceId);
  }
}
