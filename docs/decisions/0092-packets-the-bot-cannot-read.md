# 0092: Packets the bot cannot read (Track P1)

Date: 2026-11-16. Status: accepted. On by default, no setting. Details and numbers:
[../versions.md](../versions.md) "Packets the bot cannot read".

## Context

bedrock-protocol catches a parse error in `Client.readPacket`, emits `error` and drops the packet. Its
`dumpFailedBuffer` runs only when nothing listens to `error`, and the bot always listens. So a packet the pinned
protocol data cannot read leaves behind one log line without the packet's name, and nothing else. On a Realm such an
error came 0 to 160 ms after three box swaps of the room chore, and each swap then timed out as "refused". The kit
rolled back a swap the server had done, and the room chore's next steps worked on a wrong model. The connection also
took the read error as its end reason, and named it as the cause of a close that came minutes later for another reason.

None of the test servers reproduced it: BDS 1.26.60.6 and 1.26.63.1, RakNet and NetherNet, the Realm's boxes rebuilt
with their NBT, both boxes named, the Realm's slots. That made 34 swaps, all read and answered.

## Decision

1. **Keep the bytes.** The Connection wraps the client's `readPacket` and its batch entry points (`handle` for
   NetherNet, `onDecryptedPacket` for RakNet). For a failed parse it writes one JSON file under
   `<logDir>/read-errors/`. The file holds the id, name, length, error, bytes, the batch's framing and the batch, the
   protocol version and start_game's `game_version`. Files are capped at 20 and 4 MiB, counting files earlier runs
   left. The login packet is never written. One WARN line names the packet and the file.
2. **A read error is not an end reason.** It does not set the session's last reason. A transport error still does.
3. **Resync the inventory after a lost inventory packet.** The model is marked unsure, and the server is asked for the
   whole inventory with an `inventory_mismatch` transaction, which BDS answers within a tick. Stack requests wait for
   the model to be sure (up to 3 s). A request left without its response after a loss ends `lost` once the server's
   inventory is back. The kit's exchange then judges by that inventory, and other callers roll back and the inventory
   is asked for again. With no answer, the bot asks 3 times, 3 s apart, and then uses the model as it is.
4. **No version bump, no protocol patch yet.** The protocol data of this packet is the same in the next minecraft-data
   and bedrock-protocol releases. The fix of the parse waits for a captured Realm packet.

## Consequences

- The next unreadable packet on the Realm leaves a file that can be decoded by hand against `protocol.json`.
- A lost swap response costs one round trip (64 to 92 ms on BDS) instead of a 2 s timeout and a wrong model.
- The mismatch request makes the server send the inventory, armour, offhand and ui windows again: a few hundred bytes,
  only after a loss.
- Unsure lasts at most 9 s. A server that ignores the request costs that wait and then behaves as before.
- Rejected: dropping the stack request's timeout to make the rollback faster. It does not help, because the rollback
  itself is wrong when the server did the swap.
- Rejected: a setting for the resync. Nothing is gained by turning it off. The e2e's before case switches it off in
  code (`InventoryResync.enabled`).
