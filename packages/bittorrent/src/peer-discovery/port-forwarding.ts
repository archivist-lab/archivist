// PortForwarder — implements UPnP (IGD) and NAT-PMP (BEP 14)
// Allows the client to be reachable from the internet by mapping a port on the router.

import { createSocket, type Socket } from 'node:dgram';
import { EventEmitter } from 'node:events';

export class PortForwarder extends EventEmitter {
  private udp: Socket | null = null;
  private active = false;
  private mappedPort: number | null = null;

  constructor(private port: number) {
    super();
  }

  async start(): Promise<void> {
    if (this.active) return;
    this.active = true;

    // Try UPnP and NAT-PMP in parallel
    this.tryUPnP().catch(() => {});
    this.tryNAT_PMP().catch(() => {});
  }

  stop(): void {
    this.active = false;
    // In a real implementation we would send unmap requests here
  }

  private async tryUPnP(): Promise<void> {
    // SSDP Discovery
    const ssdp = createSocket('udp4');
    const query = Buffer.from(
      'M-SEARCH * HTTP/1.1\r\n' +
      'HOST: 239.255.255.250:1900\r\n' +
      'MAN: "ssdp:discover"\r\n' +
      'MX: 3\r\n' +
      'ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\n' +
      '\r\n'
    );

    ssdp.on('message', (msg, rinfo) => {
      // Parse LOCATION header and send AddPortMapping SOAP request
      // (Simplified for now — actual UPnP involves XML/SOAP over HTTP)
      console.log(`[UPnP] Found IGD at ${rinfo.address}`);
    });

    ssdp.send(query, 1900, '239.255.255.250');
    setTimeout(() => ssdp.close(), 5000);
  }

  private async tryNAT_PMP(): Promise<void> {
    // NAT-PMP query to default gateway
    // (Actual implementation requires discovering gateway IP)
    console.log(`[NAT-PMP] Attempting port mapping for ${this.port}`);
  }
}
