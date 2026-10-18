// SPDX-License-Identifier: MIT
// Errors thrown by emlusb6003. Each has a stable `name`, so a Worker can pass it as text and the page can rebuild the class.
import { ProtocolError } from "./protocol.js";

export class Usb6003Error extends Error {
  constructor(message) { super(message); this.name = this.constructor.name; }
}
export class DeviceNotFound extends Usb6003Error {}
export class HandshakeError extends Usb6003Error {}
export class StartError extends Usb6003Error {}
export class StreamLost extends Usb6003Error {}
export class DeviceNotReturned extends StreamLost {}

export { ProtocolError };
const ALL = { ProtocolError, Usb6003Error, DeviceNotFound, HandshakeError, StartError, StreamLost, DeviceNotReturned };

/** An error object rebuilt from the `name` and `message` text a Worker sends. Unknown names give Usb6003Error. */
export function errorFromText(name, message) {
  const C = ALL[name] || Usb6003Error;
  const e = new C(message);
  if (!ALL[name] && name) e.originalName = name;
  return e;
}
