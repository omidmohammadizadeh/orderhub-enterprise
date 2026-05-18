import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { WorkerModule } from "./worker.module";

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    logger: ["log", "warn", "error"],
  });

  app.enableShutdownHooks();
  console.log("[Worker] Order Hub Solutions worker started — processing queues");
}

bootstrap();
