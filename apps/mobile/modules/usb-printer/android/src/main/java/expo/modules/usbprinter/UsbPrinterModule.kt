package expo.modules.usbprinter

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbConstants
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbDeviceConnection
import android.hardware.usb.UsbEndpoint
import android.hardware.usb.UsbInterface
import android.hardware.usb.UsbManager
import android.os.Build
import android.util.Base64
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

// USB receipt printers over Android's USB host API.
//
// A thermal printer on a cable is a USB Printer Class device (class 7), or
// on cheap Chinese units a vendor-specific interface (class 0xFF) — either
// way it exposes one bulk OUT endpoint that takes raw ESC/POS / Star bytes,
// exactly what we already send over Bluetooth and TCP 9100. No driver, no
// protocol: claim the interface, bulkTransfer the bytes, release.
//
// The receipt is still rendered in the web app; this only moves bytes.
class UsbPrinterModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw CodedException("No React context")

  private val usbManager: UsbManager
    get() = context.getSystemService(Context.USB_SERVICE) as UsbManager

  // One job at a time across every USB printer. Two tickets written at once
  // to the same endpoint interleave on the paper (the 2026-10-04 Jinty's
  // garbage ticket), and the web side's per-printer queue doesn't protect
  // against a second WebView instance.
  private val writeLock = Any()

  override fun definition() = ModuleDefinition {
    Name("UsbPrinter")

    AsyncFunction("listDevices") {
      usbManager.deviceList.values.mapNotNull { device ->
        val out = findBulkOut(device) ?: return@mapNotNull null
        mapOf(
          "deviceName" to device.deviceName,
          "vendorId" to device.vendorId,
          "productId" to device.productId,
          "manufacturer" to safeString { device.manufacturerName },
          "product" to safeString { device.productName },
          "isPrinterClass" to (out.first.interfaceClass == UsbConstants.USB_CLASS_PRINTER),
          "hasPermission" to usbManager.hasPermission(device),
        )
      }
    }

    AsyncFunction("print") { vendorId: Int, productId: Int, base64: String, promise: Promise ->
      val device = usbManager.deviceList.values.firstOrNull {
        it.vendorId == vendorId && it.productId == productId
      }
      if (device == null) {
        promise.reject(
          "ERR_USB_NOT_FOUND",
          "USB printer not found — check the cable is plugged into this tablet and the printer is on.",
          null,
        )
        return@AsyncFunction
      }
      val bytes = try {
        Base64.decode(base64, Base64.DEFAULT)
      } catch (e: IllegalArgumentException) {
        promise.reject("ERR_USB_BYTES", "Receipt data was not valid base64", e)
        return@AsyncFunction
      }
      try {
        if (!ensurePermission(device)) {
          promise.reject(
            "ERR_USB_PERMISSION",
            "USB permission was not granted. Tap Allow on the tablet (tick \"Always\") and print again.",
            null,
          )
          return@AsyncFunction
        }
        synchronized(writeLock) { writeBytes(device, bytes) }
        promise.resolve(mapOf("ok" to true))
      } catch (e: Exception) {
        promise.reject("ERR_USB_PRINT", e.message ?: "USB print failed", e)
      }
    }
  }

  // Ask Android for access and block this (background) thread until the
  // operator answers the dialog. Async functions run off the main thread,
  // so waiting here doesn't freeze the UI.
  private fun ensurePermission(device: UsbDevice): Boolean {
    if (usbManager.hasPermission(device)) return true

    val action = "${context.packageName}.USB_PRINTER_PERMISSION"
    val latch = CountDownLatch(1)
    var granted = false
    val receiver = object : BroadcastReceiver() {
      override fun onReceive(ctx: Context, intent: Intent) {
        if (intent.action != action) return
        granted = intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false)
        latch.countDown()
      }
    }
    val filter = IntentFilter(action)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      context.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
    } else {
      @Suppress("UnspecifiedRegisterReceiverFlag")
      context.registerReceiver(receiver, filter)
    }
    try {
      // The system fills in EXTRA_PERMISSION_GRANTED, so the intent must be
      // MUTABLE on Android 12+; Android 14 then refuses a mutable implicit
      // intent, hence the explicit package.
      val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0
      val pi = PendingIntent.getBroadcast(
        context,
        0,
        Intent(action).setPackage(context.packageName),
        flags,
      )
      usbManager.requestPermission(device, pi)
      latch.await(60, TimeUnit.SECONDS)
    } finally {
      try {
        context.unregisterReceiver(receiver)
      } catch (_: Exception) {
        // already gone
      }
    }
    return granted || usbManager.hasPermission(device)
  }

  private fun writeBytes(device: UsbDevice, bytes: ByteArray) {
    if (bytes.isEmpty()) return
    val (intf, endpoint) = findBulkOut(device)
      ?: throw IllegalStateException("This USB device has no printer output — is it a receipt printer?")

    val conn: UsbDeviceConnection = usbManager.openDevice(device)
      ?: throw IllegalStateException("Could not open the USB printer — unplug it, plug it back in and try again.")
    try {
      if (!conn.claimInterface(intf, true)) {
        throw IllegalStateException("The USB printer is busy (claimed by another app).")
      }
      var offset = 0
      while (offset < bytes.size) {
        val len = minOf(CHUNK_BYTES, bytes.size - offset)
        val sent = conn.bulkTransfer(endpoint, bytes, offset, len, TRANSFER_TIMEOUT_MS)
        if (sent <= 0) {
          throw IllegalStateException(
            "USB printer stopped accepting data after ${offset} of ${bytes.size} bytes — check paper and cover.",
          )
        }
        offset += sent
      }
      conn.releaseInterface(intf)
    } finally {
      conn.close()
    }
  }

  // Prefer a Printer Class interface; fall back to any interface with a bulk
  // OUT endpoint (vendor-class ESC/POS printers). Never the CTI Comet caller-ID
  // box — that's an FTDI serial device the caller-ID reader owns.
  private fun findBulkOut(device: UsbDevice): Pair<UsbInterface, UsbEndpoint>? {
    if (device.vendorId == COMET_VENDOR && device.productId == COMET_PRODUCT) return null
    var fallback: Pair<UsbInterface, UsbEndpoint>? = null
    for (i in 0 until device.interfaceCount) {
      val intf = device.getInterface(i)
      for (e in 0 until intf.endpointCount) {
        val ep = intf.getEndpoint(e)
        if (ep.type == UsbConstants.USB_ENDPOINT_XFER_BULK && ep.direction == UsbConstants.USB_DIR_OUT) {
          if (intf.interfaceClass == UsbConstants.USB_CLASS_PRINTER) return intf to ep
          if (fallback == null && intf.interfaceClass == UsbConstants.USB_CLASS_VENDOR_SPEC) {
            fallback = intf to ep
          }
        }
      }
    }
    return fallback
  }

  private inline fun safeString(block: () -> String?): String? =
    try {
      block()
    } catch (_: SecurityException) {
      null
    }

  companion object {
    private const val CHUNK_BYTES = 16 * 1024
    private const val TRANSFER_TIMEOUT_MS = 5000
    private const val COMET_VENDOR = 0x0403
    private const val COMET_PRODUCT = 0x8e08
  }
}
