// Track AI settings (docs/explore.md, docs/mining.md "Branch mining"): mineBranchY (text: auto or a
// whole number -64..320) and exploreRadius (16..1024 blocks), through RuntimeSettings like `!set`.
import { describe, expect, it } from 'vitest';
import { exploreCacheOf } from '../../src/chat/commands-explore.ts';
import { describeSetting, parseSettingValue, RuntimeSettings, SettingError } from '../../src/config/settings.ts';

describe('Track AI settings', () => {
  it('mineBranchY: auto by default, a whole number -64..320 overrides, anything else is refused', () => {
    const s = new RuntimeSettings();
    expect(s.get('mineBranchY')).toBe('auto');
    expect(parseSettingValue('mineBranchY', ' AUTO ')).toBe('auto');
    expect(parseSettingValue('mineBranchY', '-58')).toBe('-58');
    expect(parseSettingValue('mineBranchY', 16)).toBe('16');
    expect(() => parseSettingValue('mineBranchY', '-65')).toThrow(SettingError);
    expect(() => parseSettingValue('mineBranchY', '12.5')).toThrow('mineBranchY must be auto or a whole number -64..320, got "12.5"');
    expect(() => parseSettingValue('mineBranchY', 'deep')).toThrow(SettingError);
    s.set('mineBranchY', '-40');
    expect(s.get('mineBranchY')).toBe('-40');
    expect(describeSetting('mineBranchY', 'auto')).toMatch(/^mineBranchY auto \(auto\|-64\.\.320, default auto\): branch mining: /);
  });

  it('exploreRadius: 128 by default, 16..1024 whole blocks', () => {
    const s = new RuntimeSettings();
    expect(s.get('exploreRadius')).toBe(128);
    s.set('exploreRadius', '64');
    expect(s.get('exploreRadius')).toBe(64);
    expect(() => parseSettingValue('exploreRadius', '8')).toThrow('exploreRadius must be a whole number 16..1024, got "8"');
    expect(() => parseSettingValue('exploreRadius', '2000')).toThrow(SettingError);
  });

  it('the explorer reads a world cache only when it has known() and summary()', () => {
    expect(exploreCacheOf(undefined)).toBeUndefined();
    expect(exploreCacheOf({ blockAt: () => undefined })).toBeUndefined();
    const c = { known: () => true, summary: () => undefined };
    expect(exploreCacheOf(c)).toBe(c);
  });
});
