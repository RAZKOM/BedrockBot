// Typed access to bedrock-protocol internals that have no public typings.
// Everything protocol-library specific outside createClient/ping lives here, so a fork swap
// (PLAN.md task 1.5) touches one file.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

interface ProtocolOptionsModule {
  CURRENT_VERSION: string;
  MIN_VERSION: string;
  /** minecraftVersion -> protocol number, release versions only. */
  Versions: Record<string, number>;
}

export interface ParsedPacket {
  data: { name: string; params: Record<string, unknown> };
  metadata: { size: number };
  buffer: Buffer;
  fullBuffer: Buffer;
}

export interface PacketParser {
  parsePacketBuffer(buf: Buffer): ParsedPacket;
  proto: { setVariable(name: string, value: unknown): void };
}

export interface PacketSerializer {
  createPacketBuffer(packet: { name: string; params: unknown }): Buffer;
  proto: { setVariable(name: string, value: unknown): void };
}

interface SerializerModule {
  createDeserializer(version: string): PacketParser;
  createSerializer(version: string): PacketSerializer;
}

const options = require('bedrock-protocol/src/options') as ProtocolOptionsModule;
const serializer = require('bedrock-protocol/src/transforms/serializer') as SerializerModule;

/** Game versions (e.g. '1.26.51') this bedrock-protocol build can speak, mapped to protocol numbers. */
export const supportedVersions: Readonly<Record<string, number>> = options.Versions;
/** The newest version bedrock-protocol targets by default. */
export const currentVersion: string = options.CURRENT_VERSION;

export function createDeserializer(version: string): PacketParser {
  return serializer.createDeserializer(version);
}

export function createSerializer(version: string): PacketSerializer {
  return serializer.createSerializer(version);
}

const packetNameCache = new Map<string, ReadonlyMap<number, string>>();

/**
 * Track P1: packet id -> name for a game version (the `name` mapper of minecraft-data's `mcpe_packet`, the table
 * bedrock-protocol parses with). Empty when the version has no data.
 */
export function packetNames(version: string): ReadonlyMap<number, string> {
  const hit = packetNameCache.get(version);
  if (hit) return hit;
  const out = new Map<number, string>();
  try {
    const bedrockMd = createRequire(require.resolve('bedrock-protocol'))('minecraft-data') as (v: string) => { protocol?: { types?: Record<string, unknown> } } | undefined;
    const t = bedrockMd(`bedrock_${version}`)?.protocol?.types?.mcpe_packet as [string, { name: string; type: [string, { mappings?: Record<string, string> }] }[]] | undefined;
    const mappings = t?.[1]?.find((f) => f.name === 'name')?.type?.[1]?.mappings ?? {};
    for (const [k, v] of Object.entries(mappings)) out.set(Number(k), v);
  } catch {
    // no data for this version: ids stay unnamed
  }
  packetNameCache.set(version, out);
  return out;
}

// prismarine-auth is bedrock-protocol's dependency (not ours): resolve it from bedrock-protocol so
// the title ids always match the auth code that uses them.
const bedrockRequire = createRequire(require.resolve('bedrock-protocol'));
const prismarineAuth = bedrockRequire('prismarine-auth') as { Titles: Record<string, string> };

/** Xbox Live title ids known to prismarine-auth (`authTitle` option). */
export const authTitles: Readonly<Record<string, string>> = prismarineAuth.Titles;
