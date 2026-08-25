import { Injectable, Module, type OnApplicationShutdown } from "@nestjs/common";
import { DatabaseModule } from "../db/database.module";
import { DatabaseService } from "../db/database.service";
import { closeMailTransport } from "./mailer";
import { NotifyService } from "./notify.service";

// Outbound mail (#354).
//
// The transport is a process-wide singleton in ./mailer and stays one: a send is
// configured entirely from SMTP_* env, one SMTP connection per process is the
// correct number, and `auth/auth.config.ts` builds its own mail at import time by
// decision — a per-instance transport would quietly become two. So this module
// owns its SHUTDOWN rather than its construction, which is the part nothing owned
// before: nodemailer keeps the socket open between sends and nobody closed it, so
// every deploy left a server waiting out its own idle timeout.
@Injectable()
class MailTransport implements OnApplicationShutdown {
  onApplicationShutdown(): void {
    closeMailTransport();
  }
}

@Module({
  imports: [DatabaseModule],
  providers: [
    MailTransport,
    {
      provide: NotifyService,
      useFactory: (database: DatabaseService) => new NotifyService(database.db),
      inject: [DatabaseService],
    },
  ],
  exports: [NotifyService],
})
export class MailModule {}
