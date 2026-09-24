import { sendEmail } from "@/configs/brevo.config";
import { env } from "@/utils/env.util";
import { logger } from "@/utils/logger.util";

/**
 * Brevo marks an account's SMTP keys "inactive" after 3 months of no
 * send activity through them. Client asked (via WhatsApp, forwarded a
 * Brevo "SMTP key(s) expiring in 7 days" notice) for a recurring "test"
 * email every 7 days purely to keep the keys registering as active —
 * well inside Brevo's 3-month window, with margin for a missed tick.
 *
 * Sends to ADMIN_EMAIL (already used for internal notifications
 * elsewhere) so the team can see each ping land and confirm it's
 * actually working, not just assume it.
 */
const KEEPALIVE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const INITIAL_DELAY_MS = 60 * 1000; // let the app finish booting first

const sendKeepAliveEmail = async (): Promise<void> => {
  const sent = await sendEmail({
    to: env.ADMIN_EMAIL,
    subject: "eComProtect SMTP keep-alive",
    htmlContent:
      "<p>Automated weekly ping to keep the Brevo SMTP keys active " +
      "(Brevo marks keys inactive after 3 months of no send activity). " +
      "No action needed — this is expected and recurring.</p>",
    textContent:
      "Automated weekly ping to keep the Brevo SMTP keys active. No action needed.",
  });

  if (sent) {
    logger.info("[SmtpKeepAlive] Keep-alive email sent successfully.");
  } else {
    logger.error("[SmtpKeepAlive] Keep-alive email failed to send.");
  }
};

/** Starts the interval loop — called once from server.ts at startup. */
export const startSmtpKeepAliveScheduler = (): void => {
  setTimeout(() => {
    sendKeepAliveEmail().catch((err) =>
      logger.error(`[SmtpKeepAlive] Initial send failed: ${err.message}`)
    );

    setInterval(() => {
      sendKeepAliveEmail().catch((err) =>
        logger.error(`[SmtpKeepAlive] Scheduled send failed: ${err.message}`)
      );
    }, KEEPALIVE_INTERVAL_MS);
  }, INITIAL_DELAY_MS);

  logger.info(
    `[SmtpKeepAlive] Scheduler started, sending every ${KEEPALIVE_INTERVAL_MS / (24 * 60 * 60 * 1000)} days.`
  );
};
