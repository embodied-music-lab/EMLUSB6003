# SPDX-License-Identifier: MIT
"""Exceptions raised by emlusb6003."""
from .protocol import ProtocolError


class Usb6003Error(Exception):
    """Base class for errors from the card or the USB layer."""


class DeviceNotFound(Usb6003Error):
    """No USB-6003 is attached, or libusb was not found."""


class TransportError(Usb6003Error):
    """A USB transfer failed."""


class TransportTimeout(TransportError):
    """A USB transfer got no answer in time."""


class HandshakeError(Usb6003Error):
    """A reply to the startup exchange was not one the card sends."""


class StartError(Usb6003Error):
    """The card did not accept the start sequence."""


class StreamLost(Usb6003Error):
    """The stream stopped and could not be restarted, or the device did not return after a disconnect."""


class DeviceNotReturned(StreamLost):
    """The device left the USB bus and did not come back in time."""


__all__ = ["ProtocolError", "Usb6003Error", "DeviceNotFound", "TransportError", "TransportTimeout",
           "HandshakeError", "StartError", "StreamLost", "DeviceNotReturned"]
