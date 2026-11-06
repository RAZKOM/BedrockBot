// What the page's modules share (decision 0061): the helpers, the last state, the banner view and the
// late-bound actions (send, toast, the menu), one object per page built by main.ts start().
import type { Ui } from './dom.ts';
import type { LinkView, MenuAction } from './menu.ts';
import type { PanelStateLite } from '../shared.ts';

export type Lite = PanelStateLite;

export interface Page {
  ui: Ui;
  /** The state the cards show (the embedded one, then each poll's or the stream's). */
  last: Lite;
  /** The banner of the last render (decides what the menus and the command box may send). */
  link: LinkView;
  /** Send one chat command (POST /api/cmd); pop = toast the reply. */
  send(cmd: string, pop?: boolean): Promise<string>;
  toast(t: string): void;
  openMenu(key: string, title: string, actions: MenuAction[], x: number, y: number, local?: (a: MenuAction) => void): void;
  closeMenu(): void;
  /** The key of the open menu (null when closed). */
  menuKey(): string | null;
  /** The banner (link.ts), re-applied by a failed poll too. */
  applyLink(v: LinkView): void;
  /** Ask for the state again soon (after a command): a poll in 300 ms, nothing while the stream pushes. */
  refreshSoon(): void;
  /** Listen to another stream topic (docs/panel.md "Add a topic"; transport.ts `on`); call it in a card's setup. */
  listen(topic: string, fn: (data: string, id: string) => void): void;
  /** Decision 0062: the page streams now (topics arrive); false = it polls, so a topic's data needs its own fallback. */
  streaming(): boolean;
}
