// Auto dispatch heartbeat. Every 20s: schedule newly matching orders and book
// whatever has come due. AUTO_DISPATCH_ENABLED=false stops it without a deploy.

import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { AutoDispatchService } from "./auto-dispatch.service";

@Injectable()
export class AutoDispatchCron {
  private readonly logger = new Logger(AutoDispatchCron.name);
  private running = false;

  constructor(private readonly svc: AutoDispatchService) {}

  @Cron("*/20 * * * * *")
  async tick() {
    if (process.env.AUTO_DISPATCH_ENABLED === "false") return;
    if (this.running) return;
    this.running = true;
    try {
      const { scheduled, ran } = await this.svc.tick();
      if (scheduled || ran) this.logger.log(`Auto dispatch: scheduled=${scheduled} ran=${ran}`);
    } catch (err: any) {
      this.logger.error(`Auto dispatch tick failed: ${err?.message ?? err}`);
    } finally {
      this.running = false;
    }
  }
}
