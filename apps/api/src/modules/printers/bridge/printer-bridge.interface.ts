// Hardware-agnostic printer bridge interface.
// Concrete adapters: LAN (TCP), USB, Bluetooth, EPSON ePOS, Star CloudPRNT, Cloud relay.
// Flutter bridge and browser fallback implement this same contract.

export interface PrinterBridgeConfig {
  connectionType: string;
  ipAddress?: string;
  port?: number;
  bluetoothAddress?: string;
  usbVendorId?: number;
  usbProductId?: number;
  endpoint?: string; // cloud / ePOS endpoint
  apiKey?: string;
}

export interface PrintResult {
  success: boolean;
  printerId: string;
  jobId: string;
  error?: string;
  sentAt?: Date;
}

export interface IPrinterBridge {
  readonly connectionType: string;
  send(rawData: string, config: PrinterBridgeConfig, jobId: string): Promise<PrintResult>;
  isReachable(config: PrinterBridgeConfig): Promise<boolean>;
}
