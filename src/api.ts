import { invoke } from '@tauri-apps/api/core';

export interface PortInfo {
  path: string;
  label: string;
  likely_inverter: boolean;
}

export interface BlockResult {
  addr: number;
  values: number[] | null;
  error: string | null;
}

export interface WriteReport {
  addr: number;
  previous: number;
  written: number;
  readback: number;
  ok: boolean;
}

export const listPorts = () => invoke<PortInfo[]>('list_ports');

export const connect = (path: string, baud: number, slave: number) =>
  invoke<void>('connect', { path, baud, slave });

export const disconnect = () => invoke<void>('disconnect');

export const isConnected = () => invoke<boolean>('is_connected');

export const readBlocks = (blocks: { addr: number; count: number }[]) =>
  invoke<BlockResult[]>('read_blocks', { blocks });

/**
 * Guarded write. `expect` is the value the UI last read; the backend refuses if
 * the device disagrees. Never call this with a fabricated `expect`.
 */
export const writeRegister = (addr: number, value: number, expect: number) =>
  invoke<WriteReport>('write_register', { addr, value, expect });

export const discoverBlocks = (stride: number) =>
  invoke<number[]>('discover_blocks', { stride });

/** Flatten block results into an address -> value map. */
export function toRegisterMap(blocks: BlockResult[]): Map<number, number> {
  const map = new Map<number, number>();
  for (const block of blocks) {
    if (!block.values) continue;
    block.values.forEach((value, i) => map.set(block.addr + i, value));
  }
  return map;
}
