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

// prismarine-auth is bedrock-protocol's dependency (not ours): resolve it from bedrock-protocol so
// the title ids always match the auth code that uses them.
const bedrockRequire = createRequire(require.resolve('bedrock-protocol'));
const prismarineAuth = bedrockRequire('prismarine-auth') as { Titles: Record<string, string> };

/** Xbox Live title ids known to prismarine-auth (`authTitle` option). */
export const authTitles: Readonly<Record<string, string>> = prismarineAuth.Titles;
