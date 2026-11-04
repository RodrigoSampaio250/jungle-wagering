import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { configureHttp } from "./infrastructure/http/configure-http";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  configureHttp(app);
  app.enableShutdownHooks();

  await app.listen(3000, "0.0.0.0");
}

bootstrap().catch((error: unknown) => {
  console.error("Falha ao iniciar a aplicação:", error);
  process.exitCode = 1;
});