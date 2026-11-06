// Track AR (wave 10, docs/panel.md "Interaction", decision 0039): the panel's menu model for the
// server side, the unit tests and the panel-actions e2e. Since decision 0061 the model is a typed
// browser module (client/menu.ts) that the page imports directly; this file re-exports it so the
// Node side keeps its import path and runs exactly the code the browser runs.
export {
  cellActions,
  wpName,
  settingActions,
  setCommand,
  settingVisible,
  modeOf,
  modeChanges,
  stackActions,
  paletteMatch,
  parseLog,
  logVisible,
  linkView,
  offlineOk,
  type MenuAction,
  type PaletteCommand,
  type SettingFilterRow,
  type ModeDef,
  type LinkView,
} from './client/menu.ts';
