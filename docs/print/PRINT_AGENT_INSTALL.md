# Print Bridge installation guide

The Order Hub Print Bridge is a small background service that runs on
the device physically connected to your printers (LAN router, kitchen
PC, front-of-house Mac). It claims print jobs from the Order Hub API
and prints them locally.

## System requirements

- Windows 10 / 11, macOS 12+, or Linux x64
- Network access to `orderhub-api-0re6.onrender.com` (HTTPS)
- LAN access to the printer (port 9100 for ESC/POS) OR Bluetooth pairing
  OR USB cable

## Install

### macOS

```bash
curl -L https://orderhubsolutions.com/downloads/orderhub-print-bridge-mac \
  -o /usr/local/bin/orderhub-print-bridge
chmod +x /usr/local/bin/orderhub-print-bridge
```

### Windows

Download `orderhub-print-bridge-win.exe`. Place it under
`C:\Program Files\OrderHub\` and add to the `PATH`.

### Linux

```bash
sudo curl -L https://orderhubsolutions.com/downloads/orderhub-print-bridge-linux \
  -o /usr/local/bin/orderhub-print-bridge
sudo chmod +x /usr/local/bin/orderhub-print-bridge
```

## First-run pairing

1. Sign in to the Order Hub dashboard.
2. Open **Printers → Devices → Pair new device**.
3. Choose the location, click **Generate pair code**. A 6-character
   code (e.g. `K7M2QH`) appears with a QR.
4. On the bridge device:
   ```
   orderhub-print-bridge pair
   ```
5. Paste/type the code, enter a friendly device name (e.g. "Kitchen
   Mac mini"), press Enter.
6. Done — config is saved to `~/.orderhub-print-bridge/config.json`.

## Configure printers

Edit `~/.orderhub-print-bridge/config.json` and fill in the
`printers` array, one entry per printer this device drives:

```json
{
  "printers": [
    {
      "printerId": "cmprinter01...",
      "transport": "lan",
      "host": "192.168.1.50",
      "port": 9100,
      "paperWidth": 80
    },
    {
      "printerId": "cmprinter02...",
      "transport": "bluetooth",
      "btMac": "00:11:22:33:44:55",
      "paperWidth": 58
    }
  ]
}
```

`printerId` is the cuid of the `Printer` row on the server
(visible in the dashboard URL of each printer's edit page).

## Run as a service

### macOS (launchd)

`/Library/LaunchDaemons/com.orderhub.printbridge.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Label</key><string>com.orderhub.printbridge</string>
  <key>ProgramArguments</key>
  <array><string>/usr/local/bin/orderhub-print-bridge</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
```

```bash
sudo launchctl load /Library/LaunchDaemons/com.orderhub.printbridge.plist
```

### Windows (NSSM)

```cmd
nssm install OrderHubPrintBridge "C:\Program Files\OrderHub\orderhub-print-bridge.exe"
nssm start  OrderHubPrintBridge
```

### Linux (systemd)

`/etc/systemd/system/orderhub-print-bridge.service`:

```ini
[Unit]
Description=Order Hub Print Bridge
After=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/orderhub-print-bridge
Restart=always
User=orderhub

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now orderhub-print-bridge
```

## Verify

```bash
orderhub-print-bridge config        # show config
orderhub-print-bridge test-print    # render a sample receipt to stdout
```

On the dashboard, the agent should show as **Online** within ~15s and
last-seen should tick every 15 seconds.
