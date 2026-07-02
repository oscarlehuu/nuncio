import * as SecureStore from 'expo-secure-store';
import type { KeyValueStore } from './connection-store';

/** expo-secure-store keys must be alphanumeric plus ".", "-", "_". */
const sanitize = (key: string) => key.replace(/[^A-Za-z0-9._-]/g, '_');

export const secureStore: KeyValueStore = {
  get: (key) => SecureStore.getItemAsync(sanitize(key)),
  set: (key, value) => SecureStore.setItemAsync(sanitize(key), value),
  delete: (key) => SecureStore.deleteItemAsync(sanitize(key)),
};
