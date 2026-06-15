#!/bin/bash
#
# macOS post-install hook fired by the .pkg installer.
#
# At this point the binary is already at /usr/local/bin/orderhub-print-bridge.
# We need to:
#   1. Drop the launchd plist into the operator's LaunchAgents
#   2. Load it so the bridge starts immediately (without requiring a logout)
#   3. Open the pairing wizard if no config exists yet
#
# Important: this script runs as ROOT (the installer escalates) but the
# bridge has to run as the logged-in user. We grab the user's home dir
# via SUDO_USER + dscl rather than $HOME, which would resolve to /var/root.

set -euo pipefail

# Resolve the actual operator account, not root.
TARGET_USER="${SUDO_USER:-${USER}}"
TARGET_HOME=$(eval echo "~${TARGET_USER}")
LAUNCH_AGENTS_DIR="${TARGET_HOME}/Library/LaunchAgents"
PLIST_PATH="${LAUNCH_AGENTS_DIR}/com.orderhub.print-bridge.plist"

mkdir -p "${LAUNCH_AGENTS_DIR}"

# Source plist ships inside the package payload at /private/tmp/ during
# install; we copy it into the user's LaunchAgents and ensure ownership
# is the operator (otherwise launchd refuses to load it).
cp "/private/tmp/com.orderhub.print-bridge.plist" "${PLIST_PATH}"
chown "${TARGET_USER}":staff "${PLIST_PATH}"
chmod 644 "${PLIST_PATH}"

# Load the agent. `launchctl bootstrap` is the modern API; fall back to
# the legacy `load` verb on older macOS versions (< 10.10) just in case.
TARGET_UID=$(id -u "${TARGET_USER}")
sudo -u "${TARGET_USER}" launchctl bootstrap "gui/${TARGET_UID}" "${PLIST_PATH}" 2>/dev/null \
  || sudo -u "${TARGET_USER}" launchctl load "${PLIST_PATH}"

echo "OrderHub Print Bridge installed and started."
echo "Run 'orderhub-print-bridge pair' to pair this device with a location."

exit 0
