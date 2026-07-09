import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { VideoStudioService } from "./video-studio.service";

// Video renders take ~30s–3min. Rather than a public webhook, a lightweight
// reconciler polls in-flight generations and finalises them (READY + persist,
// or FAILED + auto-refund). This is self-healing: if the API restarts mid-
// render, the next tick picks the job back up.
@Injectable()
export class VideoStudioCron {
  private readonly logger = new Logger(VideoStudioCron.name);
  private running = false;

  constructor(private readonly studio: VideoStudioService) {}

  @Cron(CronExpression.EVERY_30_SECONDS)
  async reconcile() {
    if (this.running) return; // never overlap ticks
    this.running = true;
    try {
      await this.studio.reconcile();
    } catch (err: any) {
      this.logger.warn(`video reconcile tick failed: ${err?.message ?? err}`);
    } finally {
      this.running = false;
    }
  }

  // Reset monthly allowances (top-ups persist). Runs daily; grants only when a
  // tenant hasn't been granted in the current calendar month.
  @Cron("0 3 * * *") // 03:00 UTC daily
  async monthlyGrants() {
    try {
      const n = await this.studio.grantMonthly(new Date());
      if (n) this.logger.log(`Video Studio: reset monthly allowance for ${n} account(s)`);
    } catch (err: any) {
      this.logger.warn(`video monthly grant failed: ${err?.message ?? err}`);
    }
  }
}
