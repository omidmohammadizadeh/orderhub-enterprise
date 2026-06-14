# USB printing

## Library

[`usb`](https://www.npmjs.com/package/usb) — `libusb` wrapper. Native
build; ships as `optionalDependencies`.

## Permission setup

### Linux

Add a udev rule so the bridge user can claim USB without root:

```
# /etc/udev/rules.d/99-orderhub.rules
SUBSYSTEM=="usb", ATTR{idVendor}=="04b8", MODE="0666"   # Epson
SUBSYSTEM=="usb", ATTR{idVendor}=="0519", MODE="0666"   # Star
SUBSYSTEM=="usb", ATTR{idVendor}=="0fe6", MODE="0666"   # XPrinter
```

```bash
sudo udevadm control --reload-rules
sudo udevadm trigger
```

### macOS

No setup needed if the printer is connected directly (not via a hub
with composite devices). For trouble, run the bridge with
`sudo orderhub-print-bridge` once to confirm; if root works but user
doesn't, you have a permissions issue.

### Windows

Install the **WinUSB driver** with [Zadig](https://zadig.akeo.ie/) for
the printer's USB interface. Without WinUSB, libusb returns `LIBUSB_ERROR_NOT_SUPPORTED`.

## Finding vendor/product IDs

Linux/macOS:
```bash
lsusb | grep -i print
# Bus 002 Device 003: ID 04b8:0e15 Seiko Epson Corp. TM-m30
```

Windows:
- Device Manager → expand "Universal Serial Bus controllers"
- Right-click the printer → Properties → Details → "Hardware Ids"
- `USB\VID_04B8&PID_0E15` ⇒ vendor `0x04b8`, product `0x0e15`

## Config

```json
{
  "transport": "usb",
  "usbVendor":  4280,        // 0x04b8
  "usbProduct": 3605,        // 0x0e15
  "paperWidth": 80
}
```

JSON doesn't support `0x…` literals — convert via `parseInt("0x04b8")`.

## Common errors

| Error                                  | Cause                              | Fix                                          |
|----------------------------------------|------------------------------------|----------------------------------------------|
| `LIBUSB_ERROR_NOT_SUPPORTED` (Windows) | No WinUSB driver                   | Install via Zadig                            |
| `LIBUSB_ERROR_ACCESS` (Linux)          | udev rule missing                  | Add the rule above + reload                  |
| `LIBUSB_ERROR_NO_DEVICE`               | Device unplugged or sleeping       | Replug; some printers sleep after idle       |
| `USB device has no OUT endpoint`       | Wrong interface picked             | Print firmware update or check `lsusb -v`    |

## Hot-plug

The bridge currently opens the device on each print. Hot-plug
detection (USB attached after agent start) just works because we
re-query `findByIds()` per job. If we ever need persistent handles
for high throughput, register `usb.on('attach' / 'detach')`.
