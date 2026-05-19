import axios from "axios";
import type { IPrinterBridge, PrinterBridgeConfig, PrintResult } from "./printer-bridge.interface";

// Epson ePOS SDK bridge — communicates with Epson TM-series printers
// via their built-in HTTP server (port 80, path /cgi-bin/epos/service.cgi).
// The printer must have ePOS enabled in its admin panel.
export class EpsonEposBridge implements IPrinterBridge {
  readonly connectionType = "EPSON_EPOS";

  async send(rawData: string, config: PrinterBridgeConfig, jobId: string): Promise<PrintResult> {
    const ip = config.ipAddress;
    if (!ip) return { success: false, printerId: "", jobId, error: "No IP address configured" };

    const port = config.port ?? 80;
    const url = `http://${ip}:${port}/cgi-bin/epos/service.cgi`;

    // Build minimal ePOS XML print document
    const xml = this.buildEposXml(rawData, jobId);

    try {
      const response = await axios.post(url, xml, {
        headers: {
          "Content-Type": "text/xml; charset=utf-8",
          SOAPAction: '""',
        },
        timeout: 8_000,
      });

      // ePOS returns success if HTTP 200 and no fault in response
      const responseText = response.data as string;
      if (responseText.includes("SchemaError") || responseText.includes("DeviceNotFound")) {
        return { success: false, printerId: "", jobId, error: `ePOS error: ${responseText.substring(0, 200)}` };
      }

      return { success: true, printerId: "", jobId };
    } catch (err: any) {
      return {
        success: false,
        printerId: "",
        jobId,
        error: `ePOS send failed: ${err?.message ?? String(err)}`,
      };
    }
  }

  async isReachable(config: PrinterBridgeConfig): Promise<boolean> {
    if (!config.ipAddress) return false;
    const port = config.port ?? 80;
    try {
      await axios.get(`http://${config.ipAddress}:${port}/cgi-bin/epos/service.cgi`, {
        timeout: 3_000,
      });
      return true;
    } catch (err: any) {
      // A 405 or 400 means the ePOS endpoint exists (printer is reachable)
      if (err?.response?.status) return true;
      return false;
    }
  }

  private buildEposXml(textContent: string, jobId: string): string {
    const escaped = textContent
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    return `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope
  xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:epos="http://www.epson-pos.com/schemas/2011/03/epos-print">
  <soapenv:Body>
    <epos:epos-print xmlns:epos="http://www.epson-pos.com/schemas/2011/03/epos-print"
                     version="2.00" xmlns="http://www.epson-pos.com/schemas/2011/03/epos-print">
      <text lang="en" smooth="false">${escaped}</text>
      <feed unit="5"/>
      <cut type="feed"/>
    </epos:epos-print>
  </soapenv:Body>
</soapenv:Envelope>`;
  }
}
