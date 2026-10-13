import { promises as fs } from "fs";
import path from "path";
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

// The scheduler used to always wait a flat 60s after boot before sending,
// with no memory of when it last actually sent. Every process restart (a
// crash-restart loop, a watcher reload, a redeploy) re-armed that same 60s
// timer, so instead of one email every 7 days the client got one every
// restart — reported as emails landing every ~10 minutes. Persisting the
// last-sent time means a restart only ever sends early if a real 7-day
// window has actually elapsed.
const STATE_FILE = path.join(process.cwd(), ".smtp-keepalive-state.json");

const readLastSentAt = async (): Promise<number | null> => {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    return typeof parsed?.lastSentAt === "number" ? parsed.lastSentAt : null;
  } catch {
    return null;
  }
};

const writeLastSentAt = async (timestamp: number): Promise<void> => {
  try {
    await fs.writeFile(STATE_FILE, JSON.stringify({ lastSentAt: timestamp }));
  } catch (err: any) {
    logger.error(
      `[SmtpKeepAlive] Failed to persist last-sent timestamp: ${err?.message || err}`
    );
  }
};

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
    await writeLastSentAt(Date.now());
    logger.info("[SmtpKeepAlive] Keep-alive email sent successfully.");
  } else {
    logger.error("[SmtpKeepAlive] Keep-alive email failed to send.");
  }
};

/** Starts the interval loop — called once from server.ts at startup. */
export const startSmtpKeepAliveScheduler = (): void => {
  (async () => {
    const lastSentAt = await readLastSentAt();
    const elapsed = lastSentAt !== null ? Date.now() - lastSentAt : null;
    const initialDelay =
      elapsed !== null && elapsed < KEEPALIVE_INTERVAL_MS
        ? KEEPALIVE_INTERVAL_MS - elapsed
        : INITIAL_DELAY_MS;

    setTimeout(() => {
      sendKeepAliveEmail().catch((err) =>
        logger.error(`[SmtpKeepAlive] Initial send failed: ${err.message}`)
      );

      setInterval(() => {
        sendKeepAliveEmail().catch((err) =>
          logger.error(`[SmtpKeepAlive] Scheduled send failed: ${err.message}`)
        );
      }, KEEPALIVE_INTERVAL_MS);
    }, initialDelay);
  })().catch((err) =>
    logger.error(`[SmtpKeepAlive] Failed to start scheduler: ${err.message}`)
  );

  logger.info(
    `[SmtpKeepAlive] Scheduler started, sending every ${KEEPALIVE_INTERVAL_MS / (24 * 60 * 60 * 1000)} days.`
  );
};
