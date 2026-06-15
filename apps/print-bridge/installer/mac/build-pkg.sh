#!/bin/bash
#
# Builds a signed* .pkg installer for the OrderHub Print Bridge on macOS.
#
# *Signing requires DEVELOPER_ID_INSTALLER to be set to the operator's
# Developer ID Installer certificate (e.g. "Developer ID Installer:
# OrderHub Solutions Ltd. (TEAMID)"). If unset, the .pkg is built
# unsigned — Mac users will see a "this app is from an unidentified
# developer" warning the first time they run it, but right-click → Open
# bypasses that. Wire up signing when the org has the cert.
#
# Outputs: dist/print-bridge/orderhub-print-bridge-macos-${ARCH}.pkg
#
# Pre-requisites (CI):
#   * pkg binary already built at apps/print-bridge/dist-bin/
#   * pkgbuild + productbuild (ship with Xcode CLT)

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../../../.." && pwd)"
BRIDGE_DIR="${ROOT_DIR}/apps/print-bridge"
INSTALLER_DIR="${BRIDGE_DIR}/installer/mac"
OUT_DIR="${ROOT_DIR}/dist/print-bridge"

ARCH="${1:-arm64}"   # arm64 (Apple Silicon) or x86_64 (Intel)
case "${ARCH}" in
  arm64|aarch64)  PKG_TARGET="node18-macos-arm64"; PKG_ARCH="arm64" ;;
  x86_64|x64)     PKG_TARGET="node18-macos-x64";   PKG_ARCH="x86_64" ;;
  *) echo "Unknown arch: ${ARCH}"; exit 1 ;;
esac

VERSION=$(node -p "require('${BRIDGE_DIR}/package.json').version")

echo "→ Building Node binary for macOS ${PKG_ARCH}..."
pushd "${BRIDGE_DIR}" >/dev/null
pnpm build
pnpm exec pkg . --targets "${PKG_TARGET}" \
  --output "${OUT_DIR}/orderhub-print-bridge-mac-${PKG_ARCH}"
popd >/dev/null

# Stage the file system layout the .pkg will install. /usr/local/bin
# for the binary, /private/tmp for the plist (post-install copies it
# from there into the operator's LaunchAgents).
echo "→ Staging payload..."
STAGE_ROOT=$(mktemp -d)
mkdir -p "${STAGE_ROOT}/usr/local/bin"
mkdir -p "${STAGE_ROOT}/private/tmp"
cp "${OUT_DIR}/orderhub-print-bridge-mac-${PKG_ARCH}" \
   "${STAGE_ROOT}/usr/local/bin/orderhub-print-bridge"
chmod 755 "${STAGE_ROOT}/usr/local/bin/orderhub-print-bridge"
cp "${INSTALLER_DIR}/com.orderhub.print-bridge.plist" \
   "${STAGE_ROOT}/private/tmp/com.orderhub.print-bridge.plist"

# Scripts directory holds postinstall (no preinstall needed). pkgbuild
# will copy whatever's in there into the package's Scripts payload.
SCRIPTS_DIR=$(mktemp -d)
cp "${INSTALLER_DIR}/postinstall.sh" "${SCRIPTS_DIR}/postinstall"
chmod +x "${SCRIPTS_DIR}/postinstall"

echo "→ Building component .pkg..."
COMPONENT_PKG="${OUT_DIR}/print-bridge-component.pkg"
pkgbuild \
  --root "${STAGE_ROOT}" \
  --scripts "${SCRIPTS_DIR}" \
  --identifier "com.orderhub.print-bridge" \
  --version "${VERSION}" \
  --install-location "/" \
  "${COMPONENT_PKG}"

echo "→ Building product .pkg..."
OUT_PKG="${OUT_DIR}/orderhub-print-bridge-macos-${PKG_ARCH}.pkg"
productbuild \
  --package "${COMPONENT_PKG}" \
  --identifier "com.orderhub.print-bridge.installer" \
  --version "${VERSION}" \
  "${OUT_PKG}"

# Sign if a Developer ID is configured. Skip silently otherwise so local
# builds don't fail for engineers without a cert.
if [[ -n "${DEVELOPER_ID_INSTALLER:-}" ]]; then
  echo "→ Signing with ${DEVELOPER_ID_INSTALLER}..."
  productsign --sign "${DEVELOPER_ID_INSTALLER}" \
    "${OUT_PKG}" "${OUT_PKG}.signed"
  mv "${OUT_PKG}.signed" "${OUT_PKG}"

  # Notarize too if credentials are present. notarytool blocks until
  # Apple finishes scanning the binary (usually <2 min).
  if [[ -n "${NOTARY_APPLE_ID:-}" && -n "${NOTARY_TEAM_ID:-}" && -n "${NOTARY_PASSWORD:-}" ]]; then
    echo "→ Notarizing..."
    xcrun notarytool submit "${OUT_PKG}" \
      --apple-id "${NOTARY_APPLE_ID}" \
      --team-id "${NOTARY_TEAM_ID}" \
      --password "${NOTARY_PASSWORD}" \
      --wait
    xcrun stapler staple "${OUT_PKG}"
  fi
fi

# Clean up staging dirs (component .pkg can stay for inspection).
rm -rf "${STAGE_ROOT}" "${SCRIPTS_DIR}"

echo ""
echo "✓ Built ${OUT_PKG}"
ls -lh "${OUT_PKG}"
